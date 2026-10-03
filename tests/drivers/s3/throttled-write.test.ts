import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3RegistryDriver } from '@/s3/registry';
import { isConditionalConflict, isThrottle, isTransient } from '@/s3/s3-errors';
import { sendOnce } from '@/s3/send-once';
import { S3StorageDriver } from '@/s3/storage';
import { loadSegment } from '@/core/load';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { STUB_BUCKET, StubS3Bucket, type FaultKind } from '../../helpers/s3-bucket-stub';

/**
 * A throttled write, through a real `S3Client` over a stub transport (the SDK's signing, error parsing and retry all
 * run; only the HTTP layer is a stub).
 *
 * A write-once generation object whose commit is answered `503 SlowDown` is sent again, a bounded number of times,
 * with backoff: it is tagged with a random write id in user metadata (`x-amz-meta-cbwid`), so a precondition failure
 * on a re-send reads the object's metadata back, and an object carrying this write's id is this write's own. The
 * driver sends a registry row once whatever the answer. The publish, not the driver, settles an unanswered one by
 * reading the row, and sends a fresh compare-and-swap from the version it read when the row is as it was.
 */

const FIVE_MIB = 5 * 1024 * 1024;
const GEN: GenKey = { segment: 's', generation: 0 };
const OBJECT_KEY = '_default/segments/s.0.crbm';
const isObject = (k: string): boolean => k.includes('/segments/');
const isRow = (k: string): boolean => k.startsWith('registry/');

/** A clock that records each backoff it is asked for and waits for none of it. */
function recordingClock(onSleep?: (ms: number) => Promise<void> | void) {
  const waits: number[] = [];
  return {
    waits,
    clock: {
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
        await onSleep?.(ms);
      },
    },
  };
}

function driverOver(bucket: StubS3Bucket, extra: Record<string, unknown> = {}) {
  const recorded = recordingClock(extra.onSleep as ((ms: number) => Promise<void>) | undefined);
  const driver = new S3StorageDriver({
    client: bucket.client(),
    bucket: STUB_BUCKET,
    clock: recorded.clock,
    ...(extra.partBytes === undefined ? {} : { partBytes: extra.partBytes as number }),
  });
  return { driver, waits: recorded.waits };
}

const put = (driver: S3StorageDriver, bytes: Uint8Array) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });

/** The error the real SDK raises for `kind` on a conditional write sent once. */
async function capture(kind: FaultKind): Promise<unknown> {
  const bucket = new StubS3Bucket();
  bucket.arm('PutObject', kind);
  return sendOnce(
    bucket.client(),
    new PutObjectCommand({
      Bucket: STUB_BUCKET,
      Key: 'k',
      Body: new Uint8Array([1]),
      IfNoneMatch: '*',
    }),
  ).catch((e: unknown) => e);
}

describe('S3: which answers are a throttle, on the error the real SDK raises', () => {
  it('503 SlowDown is a throttle, and transient', async () => {
    const err = (await capture('throttle')) as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    // The shape the classification keys on: pinned, so an SDK that changes it fails here.
    expect(err.name).toBe('SlowDown');
    expect(err.$metadata?.httpStatusCode).toBe(503);
    expect(isThrottle(err)).toBe(true);
    expect(isTransient(err)).toBe(true);
    expect(isConditionalConflict(err)).toBe(false);
  });

  it('503 ServiceUnavailable is a throttle too', async () => {
    const err = await capture({ status: 503, code: 'ServiceUnavailable' });
    expect((err as { name?: string }).name).toBe('ServiceUnavailable');
    expect(isThrottle(err)).toBe(true);
  });

  it.each<[string, FaultKind]>([
    ['500 InternalError', { status: 500, code: 'InternalError' }],
    ['a lost response', 'lose-response'],
    ['412 PreconditionFailed', { status: 412, code: 'PreconditionFailed' }],
    ['403 AccessDenied', { status: 403, code: 'AccessDenied' }],
  ])('%s is not a throttle', async (_, kind) => {
    expect(isThrottle(await capture(kind))).toBe(false);
  });
});

describe('S3: a throttled write-once object is sent again, and its write id tells its own', () => {
  it('tags the object with a write id, and a write that is not throttled is sent once with no read-back', async () => {
    const bucket = new StubS3Bucket();
    const { driver, waits } = driverOver(bucket);
    await put(driver, new Uint8Array([1, 2, 3]));
    expect(bucket.count('PutObject')).toBe(1);
    expect(bucket.count('HeadObject')).toBe(0);
    expect(waits).toEqual([]);
    expect(bucket.objects.get(OBJECT_KEY)?.metadata.cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives each write its own id', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    await put(driver, new Uint8Array([1]));
    const first = bucket.objects.get(OBJECT_KEY)?.metadata.cbwid;
    await driver.putImmutable({ ...GEN, generation: 1 }, async (sink) => {
      await sink.write(new Uint8Array([2]));
    });
    expect(bucket.objects.get('_default/segments/s.1.crbm')?.metadata.cbwid).not.toBe(first);
  });

  it('a commit throttled and not applied is sent again and lands once', async () => {
    const bucket = new StubS3Bucket();
    const { driver, waits } = driverOver(bucket);
    bucket.arm('PutObject', 'throttle');
    await put(driver, new Uint8Array([1, 2, 3]));
    expect(bucket.count('PutObject')).toBe(2);
    expect(bucket.count('HeadObject')).toBe(0); // the re-send landed: nothing to read back
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThanOrEqual(500);
    expect([...bucket.objects.get(OBJECT_KEY)!.body]).toEqual([1, 2, 3]);
  });

  it('a commit throttled after it was applied is sent again, meets itself, and is its own: one object', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    bucket.arm('PutObject', 'throttle-after-applying');
    const res = await put(driver, new Uint8Array([4, 5]));
    expect(res.size).toBe(2);
    expect(bucket.count('PutObject')).toBe(2);
    expect(bucket.count('HeadObject')).toBe(1);
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.get(OBJECT_KEY)!.body]).toEqual([4, 5]);
  });

  it('an object another writer stored before the re-send is a WriteConflictError', async () => {
    const bucket = new StubS3Bucket();
    const other = new S3StorageDriver({ client: bucket.client(), bucket: STUB_BUCKET });
    const { driver } = driverOver(bucket, {
      // During the backoff another writer takes the number, with its own write id.
      onSleep: async () => put(other, new Uint8Array([9])),
    });
    bucket.arm('PutObject', 'throttle');
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('HeadObject')).toBe(1);
    expect([...bucket.objects.get(OBJECT_KEY)!.body]).toEqual([9]);
  });

  it('an object with no write id met on a re-send is a WriteConflictError', async () => {
    const bucket = new StubS3Bucket();
    const client = bucket.client();
    const { driver } = driverOver(bucket, {
      onSleep: async () => {
        await client.send(
          new PutObjectCommand({ Bucket: STUB_BUCKET, Key: OBJECT_KEY, Body: new Uint8Array([7]) }),
        );
      },
    });
    bucket.arm('PutObject', 'throttle');
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('a 409 on a re-send, with the object not stored yet, is an unknown outcome: TransientError, never "nothing was written"', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    // The first send is throttled; the re-send meets S3's refusal of concurrent conditional writes to the key.
    bucket.arm('PutObject', 'throttle');
    bucket.arm('PutObject', { status: 409, code: 'ConditionalRequestConflict' });
    const err = await put(driver, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('HeadObject')).toBe(1);
    expect(bucket.count('DeleteObject')).toBe(0);
  });

  it("a 409 on a re-send, with this write's own object stored, is a success", async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    bucket.arm('PutObject', 'throttle-after-applying');
    bucket.arm('PutObject', { status: 409, code: 'ConditionalRequestConflict' });
    const res = await put(driver, new Uint8Array([4, 5]));
    expect(res.size).toBe(2);
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.get(OBJECT_KEY)!.body]).toEqual([4, 5]);
  });

  it("a 409 on a re-send, with another writer's object stored, is a WriteConflictError", async () => {
    const bucket = new StubS3Bucket();
    const other = new S3StorageDriver({ client: bucket.client(), bucket: STUB_BUCKET });
    const { driver } = driverOver(bucket, {
      onSleep: async () => {
        await put(other, new Uint8Array([9]));
        // The re-send, not the other writer's put, meets S3's refusal.
        bucket.arm('PutObject', { status: 409, code: 'ConditionalRequestConflict' });
      },
    });
    bucket.arm('PutObject', 'throttle');
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
    expect([...bucket.objects.get(OBJECT_KEY)!.body]).toEqual([9]);
  });

  it('a 409 on the first send is a WriteConflictError with no read-back', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    bucket.arm('PutObject', { status: 409, code: 'ConditionalRequestConflict' });
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('HeadObject')).toBe(0);
  });

  it('a precondition that fails on the first send is a WriteConflictError, with no read-back', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    await put(driver, new Uint8Array([1]));
    await expect(put(driver, new Uint8Array([2]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('HeadObject')).toBe(0);
  });

  it.each<[string, number, number[]]>([
    ['halfway', 0.5, [250, 500, 1000]],
    ['at its lowest', 0, [0, 0, 0]],
    ['just under each bound', 0.999, [499, 999, 1998]],
  ])('waits a random time under 500 ms, then 1 s, then 2 s: %s', async (_, draw, expected) => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(draw);
    try {
      const bucket = new StubS3Bucket();
      const { driver, waits } = driverOver(bucket);
      for (let i = 0; i < 3; i++) bucket.arm('PutObject', 'throttle');
      await put(driver, new Uint8Array([1]));
      expect(bucket.count('PutObject')).toBe(4);
      expect(waits).toEqual(expected);
    } finally {
      random.mockRestore();
    }
  });

  it('a throttle on every send ends in TransientError after three re-sends, deleting nothing', async () => {
    const bucket = new StubS3Bucket();
    const { driver, waits } = driverOver(bucket);
    for (let i = 0; i < 4; i++) bucket.arm('PutObject', 'throttle');
    const err = await put(driver, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(String((err as Error).message)).toMatch(/throttled/);
    expect(bucket.count('PutObject')).toBe(4);
    expect(bucket.count('DeleteObject')).toBe(0);
    expect(bucket.objects.size).toBe(0);
    // Full-jitter backoff under a ceiling that doubles: 500 ms, 1 s, 2 s.
    expect(waits).toHaveLength(3);
    waits.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(500 * 2 ** i));
  });

  it.each<[string, FaultKind]>([
    ['a lost response', 'lose-response'],
    ['a 500', { status: 500, code: 'InternalError' }],
  ])('%s is not a throttle: sent once, TransientError', async (_, kind) => {
    const bucket = new StubS3Bucket();
    const { driver, waits } = driverOver(bucket);
    bucket.arm('PutObject', kind);
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(waits).toEqual([]);
  });

  it('a read-back that fails throws, and is neither a success nor a conflict', async () => {
    const bucket = new StubS3Bucket();
    const { driver } = driverOver(bucket);
    bucket.arm('PutObject', 'throttle-after-applying');
    bucket.arm('HeadObject', { status: 403, code: 'AccessDenied' });
    const err = await put(driver, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WriteConflictError);
    // The read-back's own failure, as the SDK raised it (a HEAD answer has no body, so only its status says what).
    expect((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode).toBe(
      403,
    );
    expect(bucket.count('HeadObject')).toBe(1);
  });

  describe('a multipart upload', () => {
    const big = (): Uint8Array => new Uint8Array(FIVE_MIB + 3).fill(7);

    it('tags the object at the upload start, and a throttled completion not applied is sent again', async () => {
      const bucket = new StubS3Bucket();
      const { driver } = driverOver(bucket, { partBytes: FIVE_MIB });
      bucket.arm('CompleteMultipartUpload', 'throttle');
      await put(driver, big());
      expect(bucket.count('CompleteMultipartUpload')).toBe(2);
      expect(bucket.objects.get(OBJECT_KEY)?.metadata.cbwid).toMatch(/^[0-9a-f]{32}$/);
      expect(bucket.objects.get(OBJECT_KEY)?.body.length).toBe(FIVE_MIB + 3);
    });

    it.each(['precondition', 'no-such-upload'] as const)(
      'a completion applied and then throttled is its own on the re-send (answered by its %s)',
      async (answer) => {
        const bucket = new StubS3Bucket();
        bucket.completedUploadAnswer = answer;
        const { driver } = driverOver(bucket, { partBytes: FIVE_MIB });
        bucket.arm('CompleteMultipartUpload', 'throttle-after-applying');
        await put(driver, big());
        expect(bucket.count('CompleteMultipartUpload')).toBe(2);
        expect(bucket.count('HeadObject')).toBe(1);
        expect(bucket.objects.size).toBe(1);
      },
    );

    it('NoSuchUpload on a re-sent completion with a legacy object (no write id) stored is a WriteConflictError', async () => {
      const bucket = new StubS3Bucket();
      const client = bucket.client();
      const { driver } = driverOver(bucket, {
        partBytes: FIVE_MIB,
        onSleep: async () => {
          // During the backoff an object with no user metadata at all takes the key, as an older release's did.
          await client.send(
            new PutObjectCommand({
              Bucket: STUB_BUCKET,
              Key: OBJECT_KEY,
              Body: new Uint8Array([7]),
            }),
          );
        },
      });
      bucket.arm('CompleteMultipartUpload', 'throttle');
      bucket.arm('CompleteMultipartUpload', { status: 404, code: 'NoSuchUpload' });
      await expect(put(driver, big())).rejects.toBeInstanceOf(WriteConflictError);
      expect(bucket.count('HeadObject')).toBe(1);
      expect(bucket.count('DeleteObject')).toBe(0);
    });

    it('NoSuchUpload on a re-sent completion with nothing stored is an unknown outcome: TransientError', async () => {
      const bucket = new StubS3Bucket();
      const { driver } = driverOver(bucket, { partBytes: FIVE_MIB });
      bucket.arm('CompleteMultipartUpload', 'throttle');
      bucket.arm('CompleteMultipartUpload', { status: 404, code: 'NoSuchUpload' });
      const err = await put(driver, big()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransientError);
      expect(err).not.toBeInstanceOf(WriteConflictError);
      expect(bucket.count('DeleteObject')).toBe(0);
    });

    it('a throttle on every completion ends in TransientError and aborts the upload, deleting nothing', async () => {
      const bucket = new StubS3Bucket();
      const { driver } = driverOver(bucket, { partBytes: FIVE_MIB });
      for (let i = 0; i < 4; i++) bucket.arm('CompleteMultipartUpload', 'throttle');
      await expect(put(driver, big())).rejects.toBeInstanceOf(TransientError);
      expect(bucket.count('CompleteMultipartUpload')).toBe(4);
      expect(bucket.count('AbortMultipartUpload')).toBe(1);
      expect(bucket.count('DeleteObject')).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });
  });
});

describe('S3: a registry row is sent once, whatever the answer', () => {
  it('a throttled compare-and-swap is not sent again', async () => {
    const bucket = new StubS3Bucket();
    const registry = new S3RegistryDriver({ client: bucket.client(), bucket: STUB_BUCKET });
    const { token } = await registry.create({ segment: 's' }, { currentGen: 0 });
    bucket.arm('PutObject', 'throttle', isRow);
    await expect(
      registry.compareAndSwap({ segment: 's' }, token, { currentGen: 1 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject', isRow)).toBe(2); // the create, then the swap once
  });
});

describe('S3: a load whose writes are throttled, through the real SDK', () => {
  function store() {
    const bucket = new StubS3Bucket();
    const client = bucket.client();
    const { clock, waits } = recordingClock();
    const deps = {
      storage: new S3StorageDriver({ client, bucket: STUB_BUCKET, clock }),
      registry: new S3RegistryDriver({ client, bucket: STUB_BUCKET }),
      codec: roaringCodec,
      // What a store wires: the publish waits on it before a fresh write, as the driver does before a re-send.
      clock: { now: () => 0, sleep: clock.sleep, yieldNow: async (): Promise<void> => {} },
    };
    return { bucket, deps, waits };
  }
  const SEG = { segment: 's' };
  const rowWrites = (b: StubS3Bucket): number => b.count('PutObject', isRow);

  it('an object throttled once is sent again, and the load publishes', async () => {
    const { bucket, deps } = store();
    await loadSegment(SEG, [1], deps);
    bucket.arm('PutObject', 'throttle', isObject);
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(bucket.count('PutObject', isObject)).toBe(3); // the first load's, then this one's twice
  });

  it('an object throttled on every send throws TransientError, deletes nothing, and leaves the row where it was', async () => {
    const { bucket, deps } = store();
    await loadSegment(SEG, [1], deps);
    const rowsBefore = rowWrites(bucket);
    for (let i = 0; i < 4; i++) bucket.arm('PutObject', 'throttle', isObject);
    await expect(loadSegment(SEG, [1, 2], deps)).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject', isObject)).toBe(1 + 4);
    expect(rowWrites(bucket)).toBe(rowsBefore); // no row write was attempted
    expect(bucket.count('DeleteObject')).toBe(0);
    expect((await deps.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('a row throttled once and not applied is sent again by the publish from the row it read back, and the load publishes', async () => {
    const { bucket, deps, waits } = store();
    await loadSegment(SEG, [1], deps);
    const before = rowWrites(bucket);
    waits.length = 0;
    bucket.arm('PutObject', 'throttle', isRow);
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 1, published: true });
    // The driver sent the throttled write once; the second is a fresh compare-and-swap the publish made.
    expect(rowWrites(bucket) - before).toBe(2);
    expect(waits).toEqual([500]);
    expect(bucket.count('DeleteObject')).toBe(0);
    expect((await deps.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row throttled on every send is four writes, then the registry TransientError with the SDK error as its cause', async () => {
    const { bucket, deps, waits } = store();
    await loadSegment(SEG, [1], deps);
    const before = rowWrites(bucket);
    waits.length = 0;
    for (let i = 0; i < 5; i++) bucket.arm('PutObject', 'throttle', isRow);
    const err = await loadSegment(SEG, [1, 2], deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    // The registry's own error, whose cause is the SDK's: what a caller reads there does not move.
    expect((err as { cause?: { name?: string } }).cause?.name).toBe('SlowDown');
    expect(rowWrites(bucket) - before).toBe(4); // bounded: the first send and three fresh ones
    expect(waits).toHaveLength(3);
    expect(bucket.count('DeleteObject')).toBe(0);
    expect(bucket.objects.has('_default/segments/s.1.crbm')).toBe(true);
    expect((await deps.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('a row throttled once whose original request reaches S3 after the fresh write is refused by If-Match: one write lands', async () => {
    const { bucket, deps } = store();
    await loadSegment(SEG, [1], deps);
    bucket.arm('PutObject', 'throttle-and-hold', isRow);
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 1, published: true });
    const rowKey = [...bucket.objects.keys()].find((k) => isRow(k) && k.includes('/s.'))!;
    const landed = bucket.objects.get(rowKey)!.etag;
    await bucket.landHeld(); // the request answered 503 is applied now, against a version that has moved on
    expect(bucket.objects.get(rowKey)!.etag).toBe(landed);
    expect((await deps.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row throttled after it was applied is found by reading the row: published, the row sent once', async () => {
    const { bucket, deps } = store();
    await loadSegment(SEG, [1], deps);
    const before = rowWrites(bucket);
    bucket.arm('PutObject', 'throttle-after-applying', isRow);
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(rowWrites(bucket) - before).toBe(1);
    expect((await deps.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row throttled that lands after the load threw points at an object that is there', async () => {
    const { bucket, deps } = store();
    await loadSegment(SEG, [1], deps);
    for (let i = 0; i < 4; i++) bucket.arm('PutObject', 'throttle-and-hold', isRow);
    await expect(loadSegment(SEG, [1, 2], deps)).rejects.toBeInstanceOf(TransientError);
    await bucket.landHeld(); // the compare-and-swaps the service answered 503 are applied after all: one lands
    expect((await deps.registry.get(SEG))!.currentGen).toBe(1);
    expect(bucket.objects.has('_default/segments/s.1.crbm')).toBe(true);
    expect(bucket.count('DeleteObject')).toBe(0);
  });
});
