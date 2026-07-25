import type { S3Client } from '@aws-sdk/client-s3';
import { registryConformance } from '@/testing/conformance';
import { S3RegistryDriver } from '@/drivers/s3/registry';
import { ValidationError, WriteConflictError } from '@/core/errors';

/**
 * A faithful in-memory fake of the slice of S3 the registry uses: `GetObject`, a **conditional** `PutObject`
 * (`If-None-Match: *` write-once + `If-Match: <etag>` compare-and-swap), and `ListObjectsV2`. ETags change on
 * every write (a monotonic sequence — a realistic model of "the ETag moves per PUT", which is all the driver's
 * If-Match fence relies on). Lets the full shared registry contract run in the fast unit lane; the MinIO lane
 * proves it against real S3 semantics.
 */
function s3Error(name: string, status: number): Error {
  const err = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

class FakeS3 {
  private readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private seq = 0;
  /** If set, the next `PutObjectCommand` throws this instead of writing (models a mid-flight S3 rejection). */
  putErrorOnce: Error | undefined;
  /** Small page size to exercise the driver's ListObjectsV2 continuation loop (default: single page). */
  constructor(private readonly pageSize = Infinity) {}
  private nextEtag(): string {
    return `"etag-${++this.seq}"`; // S3 ETags are quoted
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const name = command.constructor.name;
    const input = command.input as {
      Key?: string;
      Body?: Uint8Array;
      IfNoneMatch?: string;
      IfMatch?: string;
      Prefix?: string;
    };
    if (name === 'GetObjectCommand') {
      const obj = this.objects.get(input.Key!);
      if (obj === undefined) throw s3Error('NoSuchKey', 404);
      const bytes = obj.bytes;
      return {
        Body: { transformToByteArray: async (): Promise<Uint8Array> => bytes },
        ETag: obj.etag,
        ContentLength: bytes.length,
      };
    }
    if (name === 'PutObjectCommand') {
      if (this.putErrorOnce !== undefined) {
        const err = this.putErrorOnce;
        this.putErrorOnce = undefined;
        throw err;
      }
      const cur = this.objects.get(input.Key!);
      if (input.IfNoneMatch === '*' && cur !== undefined) throw s3Error('PreconditionFailed', 412);
      if (input.IfMatch !== undefined && (cur === undefined || cur.etag !== input.IfMatch)) {
        throw s3Error('PreconditionFailed', 412);
      }
      const etag = this.nextEtag();
      this.objects.set(input.Key!, { bytes: Uint8Array.from(input.Body!), etag });
      return { ETag: etag };
    }
    if (name === 'ListObjectsV2Command') {
      const prefix = input.Prefix ?? '';
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      // Model ListObjectsV2 pagination: start after the continuation token, return one page, and hand back a
      // NextContinuationToken (the last key of the page) when more remain — exercising the driver's loop.
      const after = (input as { ContinuationToken?: string }).ContinuationToken;
      const start = after === undefined ? 0 : all.findIndex((k) => k > after);
      const from = start < 0 ? all.length : start;
      const page = all.slice(from, from + this.pageSize);
      const IsTruncated = from + page.length < all.length;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated,
        NextContinuationToken: IsTruncated ? page[page.length - 1] : undefined,
      };
    }
    throw new Error(`FakeS3: unhandled command ${name}`);
  }
}

// A monotonic fake clock so createdAt/updatedAt are deterministic and updatedAt advances on each mutation.
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

// The S3 registry must pass the SAME contract as memory / LocalFs / DynamoDB (finding V8) — including the
// ABA-safe token across delete→recreate, which its tombstone-object + monotonic counter provide.
registryConformance('S3RegistryDriver (fake S3)', () => {
  const client = new FakeS3() as unknown as S3Client;
  return new S3RegistryDriver({ client, bucket: 'b', prefix: 'cloudroaring', now: ticking() });
});

describe('S3RegistryDriver — construction + S3 specifics', () => {
  const client = new FakeS3() as unknown as S3Client;

  it('rejects a prefix with `.`/`..` segments or control chars (containment)', () => {
    for (const prefix of ['..', 'a/../b', './x', 'a\tb']) {
      expect(() => new S3RegistryDriver({ client, bucket: 'b', prefix })).toThrow(ValidationError);
    }
  });

  it('advertises strongRead', () => {
    expect(new S3RegistryDriver({ client, bucket: 'b' }).capabilities()).toEqual({
      strongRead: true,
    });
  });

  it('two concurrent creates race via If-None-Match — exactly one wins', async () => {
    const shared = new FakeS3() as unknown as S3Client;
    const a = new S3RegistryDriver({ client: shared, bucket: 'b', now: ticking() });
    const b = new S3RegistryDriver({ client: shared, bucket: 'b', now: ticking() });
    const ref = { segment: 'race' };
    const results = await Promise.allSettled([
      a.create(ref, { currentGen: 0 }),
      b.create(ref, { currentGen: 0 }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof WriteConflictError,
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it('a stale-token compareAndSwap loses via If-Match (WriteConflictError)', async () => {
    const driver = new S3RegistryDriver({
      client: new FakeS3() as unknown as S3Client,
      bucket: 'b',
      now: ticking(),
    });
    const ref = { segment: 's' };
    const { token } = await driver.create(ref, { currentGen: 0 });
    const { token: token2 } = await driver.compareAndSwap(ref, token, { currentGen: 1 });
    expect(token2).not.toBe(token);
    // Reusing the now-stale first token must conflict.
    await expect(driver.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect((await driver.get(ref))!.currentGen).toBe(1);
  });

  it('maps a 409 ConditionalRequestConflict (concurrent conditional write) to WriteConflictError', async () => {
    // S3 fails one of two racing conditional writes with 409, not 412 — the driver must treat it as an OCC
    // conflict (not a raw error), so CAS/create callers re-read and the delete loop retries.
    const fake = new FakeS3();
    const driver = new S3RegistryDriver({
      client: fake as unknown as S3Client,
      bucket: 'b',
      now: ticking(),
    });
    const ref = { segment: 's' };
    const err409 = new Error('ConditionalRequestConflict') as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    err409.name = 'ConditionalRequestConflict';
    err409.$metadata = { httpStatusCode: 409 };
    fake.putErrorOnce = err409;
    await expect(driver.create(ref, { currentGen: 0 })).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('list() threads the ListObjectsV2 continuation token across pages', async () => {
    const fake = new FakeS3(2); // page size 2 → 5 segments span 3 pages
    const driver = new S3RegistryDriver({
      client: fake as unknown as S3Client,
      bucket: 'b',
      now: ticking(),
    });
    for (const seg of ['a', 'b', 'c', 'd', 'e'])
      await driver.create({ segment: seg }, { currentGen: 0 });
    const segs: string[] = [];
    for await (const rec of driver.list()) segs.push(rec.segment);
    expect(segs.sort()).toEqual(['a', 'b', 'c', 'd', 'e']); // every page collected, none dropped/duplicated
  });

  it('list() skips a stray/foreign object planted under the registry prefix', async () => {
    const fake = new FakeS3();
    const driver = new S3RegistryDriver({
      client: fake as unknown as S3Client,
      bucket: 'b',
      prefix: 'cr',
      now: ticking(),
    });
    await driver.create({ segment: 'real' }, { currentGen: 0 });
    // A foreign object under registry/ that isn't a valid <ns>/<segment>.reg key must be ignored, not parsed.
    await fake.send({
      constructor: { name: 'PutObjectCommand' },
      input: { Key: 'cr/registry/not-a-registry-object.txt', Body: Buffer.from('junk') },
    });
    const segs: string[] = [];
    for await (const rec of driver.list()) segs.push(rec.segment);
    expect(segs).toEqual(['real']);
  });
});
