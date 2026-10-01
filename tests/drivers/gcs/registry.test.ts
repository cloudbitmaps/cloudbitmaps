import { PassThrough, Writable } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { registryConformance, registryConcurrency } from '@/testing/conformance';
import { GcsRegistryDriver } from '@/gcs/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';

/**
 * A faithful in-memory fake of the slice of GCS the registry uses: a single-GET `createReadStream` that
 * announces its response headers (`x-goog-generation`, `content-length`) before any data, a **conditional** upload through `createWriteStream`, and a paginated `getFiles`.
 *
 * Two modelling decisions carry the weight here, both copied from the backend rather than invented:
 *
 * 1. **A precondition only binds on the simple upload path.** An upload opens a resumable session unless
 *    `resumable: false` is passed, and fake-gcs-server 1.52.2 — the emulator the integration lane runs
 *    against, pinned in `docker-compose.yml` for exactly this property — does not enforce
 *    `ifGenerationMatch` on that path. A driver that omits the flag therefore has no compare-and-swap at
 *    all while every sequential test stays green. Modelling it here makes that one line testable in the
 *    fast lane instead of only in Docker.
 * 2. **A read is one GET**, so the bytes and the `x-goog-generation` header that fences the next write come
 *    from the same observation of the object.
 */
function gcsError(status: number): Error {
  const err = new Error(`gcs ${status}`) as Error & { code: number };
  err.code = status; // GCS ApiError carries the HTTP status on `.code`
  return err;
}

interface FakeObject {
  bytes: Uint8Array;
  generation: number;
}

class FakeGcs {
  readonly objects = new Map<string, FakeObject>();
  private seq = 0;
  /** Counts read requests, to pin the round-trip cost of a read. */
  reads = 0;

  constructor(private readonly pageSize = Infinity) {}

  bucket(): unknown {
    return {
      file: (name: string) => this.file(name),
      getFiles: async (q: {
        prefix?: string;
        maxResults?: number;
        pageToken?: string;
      }): Promise<unknown[]> => {
        const all = [...this.objects.keys()].filter((k) => k.startsWith(q.prefix ?? '')).sort();
        const from = q.pageToken === undefined ? 0 : all.findIndex((k) => k > q.pageToken!);
        const start = from < 0 ? all.length : from;
        const limit = Math.min(q.maxResults ?? Infinity, this.pageSize);
        const page = all.slice(start, start + limit);
        const more = start + page.length < all.length;
        // Real GCS hands back a `nextQuery` carrying the continuation token; the driver reads `.pageToken`.
        return [page.map((name) => ({ name })), more ? { pageToken: page[page.length - 1] } : null];
      },
    };
  }

  /** The status a read answers with; a test sets it to model a backend that does not answer a plain GET with 200. */
  status = 200;

  /** Response headers a plain GET carries; a test overrides this to model a hostile or non-conforming backend. */
  headers = (obj: FakeObject): Record<string, string> => ({
    'x-goog-generation': String(obj.generation),
    'content-length': String(obj.bytes.length),
  });

  private file(name: string): unknown {
    return {
      createReadStream: (): PassThrough => {
        const out = new PassThrough();
        this.reads++;
        const obj = this.objects.get(name);
        queueMicrotask(() => {
          if (obj === undefined) return void out.destroy(gcsError(404));
          out.emit('response', {
            statusCode: this.status,
            headers: this.headers(obj),
          });
          out.end(Buffer.from(obj.bytes));
        });
        return out;
      },
      createWriteStream: (opts?: {
        resumable?: boolean;
        preconditionOpts?: { ifGenerationMatch?: number };
      }): Writable => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk: Uint8Array, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
          // The upload lands when the stream ends, as the SDK's does: check and store in one step, so two
          // concurrent writers race exactly where they do against the service.
          final: (done) => {
            const cur = this.objects.get(name);
            const expect = opts?.preconditionOpts?.ifGenerationMatch;
            // The emulator enforces the precondition ONLY on the simple (non-resumable) path.
            if (opts?.resumable === false && expect !== undefined) {
              if (expect === 0 && cur !== undefined) return done(gcsError(412));
              if (expect !== 0 && (cur === undefined || cur.generation !== expect)) {
                return done(gcsError(412));
              }
            }
            this.objects.set(name, {
              bytes: Uint8Array.from(Buffer.concat(chunks)),
              generation: ++this.seq + 1_000,
            });
            done();
          },
        });
      },
    };
  }
}

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/** The single registry object the fake holds — asserts there is exactly one, rather than assuming it. */
function soleObject(storage: FakeGcs): { key: string; object: FakeObject } {
  const keys = [...storage.objects.keys()];
  expect(keys).toHaveLength(1);
  const key = keys[0] as string;
  return { key, object: storage.objects.get(key) as FakeObject };
}

const driverOver = (storage: FakeGcs, prefix = 'cloudbitmaps'): GcsRegistryDriver =>
  new GcsRegistryDriver({
    storage: storage as unknown as Storage,
    bucket: 'b',
    prefix,
    now: ticking(),
  });

// The GCS registry must pass the SAME contract as memory / LocalFs / S3 / Azure, in the fast lane.
registryConformance('GcsRegistryDriver (fake GCS)', () => driverOver(new FakeGcs()));

// …and the cross-process fence, against a fake that enforces preconditions exactly where GCS does.
registryConcurrency('GcsRegistryDriver (fake GCS)', () => {
  const storage = new FakeGcs();
  return [driverOver(storage), driverOver(storage)];
});

describe('GcsRegistryDriver — construction + GCS specifics', () => {
  const ref = { segment: 's:v1' };

  it('rejects a prefix with `.`/`..` segments or control chars (containment)', () => {
    const storage = new FakeGcs() as unknown as Storage;
    for (const prefix of ['..', 'a/../b', './x', 'a\tb']) {
      expect(() => new GcsRegistryDriver({ storage, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  // The cost model prices a GCS pointer read as one request (`requestsPerSizedRead: 1`): the single GET's headers
  // carry the generation fence and the length. Held here, so the model moves if the driver does.
  it('reads a row in one request', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    const before = storage.reads;
    await d.get(ref);
    expect(storage.reads - before).toBe(1);
  });

  it('advertises strongRead', () => {
    const storage = new FakeGcs() as unknown as Storage;
    expect(new GcsRegistryDriver({ storage, bucket: 'b' }).capabilities()).toEqual({
      strongRead: true,
    });
  });

  // Without `resumable: false` the fake (like the emulator) ignores `ifGenerationMatch` entirely, so both
  // writers "win" and one silently overwrites the other.
  it('writes on the simple upload path, so the precondition actually fences', async () => {
    const storage = new FakeGcs();
    const [a, b] = [driverOver(storage), driverOver(storage)];
    const results = await Promise.allSettled([
      a.create(ref, { currentGen: 0 }),
      b.create(ref, { currentGen: 0 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('fences a compare-and-swap against the object generation, not the ETag', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    const { token } = await d.create(ref, { currentGen: 0 });
    await d.compareAndSwap(ref, token, { currentGen: 1 });
    // The stale token must be refused by the in-process check AND, were it to get past, by the generation.
    await expect(d.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(soleObject(storage).object.generation).toBeGreaterThan(1_000);
  });

  // A write that lands while a read is in flight must not tear the pair: the bytes and the fence come from one
  // response, so the read observes the older row with its own generation, and the next read the newer one.
  it('returns a row with the generation of the same response', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    const { token } = await d.create(ref, { currentGen: 7 });
    const { key } = soleObject(storage);
    storage.headers = (obj) => {
      // Overwrite right as the response is announced: this response is still the older object.
      const stale = { ...obj };
      storage.objects.set(key, { ...obj, generation: obj.generation + 1 });
      return {
        'x-goog-generation': String(stale.generation),
        'content-length': String(obj.bytes.length),
      };
    };
    const got = await d.get(ref);
    expect(got!.currentGen).toBe(7);
    expect(got!.token).toBe(token);
  });

  it('threads the getFiles page token across pages', async () => {
    const storage = new FakeGcs(2); // two objects per page
    const d = driverOver(storage);
    for (let i = 0; i < 7; i++) await d.create({ segment: `s${i}` }, { currentGen: i });
    const seen: string[] = [];
    for await (const rec of d.list()) seen.push(rec.segment);
    expect(seen.sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('rejects an oversized object on its advertised length, before buffering it', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    storage.objects.set(soleObject(storage).key, {
      bytes: new Uint8Array(MAX_ROW_BYTES + 1),
      generation: 2_000,
    });
    const before = storage.reads;
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    expect(storage.reads - before).toBe(1);
  });

  it('rejects an oversized body even when the response understates its length', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    storage.objects.set(soleObject(storage).key, {
      bytes: new Uint8Array(MAX_ROW_BYTES + 1),
      generation: 2_000,
    });
    storage.headers = (obj) => ({
      'x-goog-generation': String(obj.generation),
      'content-length': '10',
    });
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    storage.headers = (obj) => ({ 'x-goog-generation': String(obj.generation) }); // no length at all
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses a response with a missing or malformed x-goog-generation', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    for (const generation of [
      undefined,
      '',
      '0',
      '-5',
      '1.5',
      '"etag-1"',
      '99999999999999999999',
    ]) {
      storage.headers = (obj) => ({
        ...(generation === undefined ? {} : { 'x-goog-generation': generation }),
        'content-length': String(obj.bytes.length),
      });
      await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    }
  });

  it('refuses a pointer read that is not a 200', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    for (const status of [204, 206]) {
      storage.status = status;
      await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    }
  });

  it('reports a missing object as absent', async () => {
    expect(await driverOver(new FakeGcs()).get(ref)).toBeNull();
  });

  it('refuses a version fence that is not a GCS generation on write', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    // A token that is not a generation would silently disable the precondition (`ifGenerationMatch: NaN`).
    await expect(d.compareAndSwap(ref, '"etag-1"', { currentGen: 1 })).rejects.toBeInstanceOf(
      Error,
    );
  });
});
