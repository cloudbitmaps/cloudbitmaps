import { GcsRegistryDriver } from '@/gcs/registry';
import { isPreconditionFailed, isThrottle, isTransient } from '@/gcs/gcs-errors';
import { saveOnce } from '@/gcs/send-once';
import { GcsStorageDriver } from '@/gcs/storage';
import { loadSegment } from '@/core/load';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { STUB_GCS_BUCKET, StubGcsService } from '../../helpers/gcs-stub';

/**
 * A throttled write, through a real `@google-cloud/storage` client over a stub of the JSON API on the loopback
 * interface.
 *
 * A write-once generation object up to the simple-upload threshold is one request, sent once by the driver. When GCS
 * answers it `429` or `503`, the driver sends it again, a bounded number of times, with backoff: the object carries a
 * random write id in its custom metadata, as a resumable upload's always has, so a `412` on a re-send reads the
 * metadata back, and an object carrying this write's id is this write's own. The driver sends a registry row once
 * whatever the answer. The publish, not the driver, settles an unanswered one by reading the row, and sends a fresh
 * compare-and-swap from the version it read when the row is as it was.
 */

const GEN: GenKey = { segment: 's', generation: 0 };
const OBJECT = '_default/segments/s.0.crbm';
const isObject = (n: string): boolean => n.includes('/segments/');
const isRow = (n: string): boolean => n.startsWith('registry/');

let stub: StubGcsService;
beforeEach(async () => {
  stub = new StubGcsService();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

function driverOver(onSleep?: () => Promise<void>) {
  const waits: number[] = [];
  const driver = new GcsStorageDriver({
    storage: stub.client(),
    bucket: STUB_GCS_BUCKET,
    clock: {
      sleep: async (ms: number) => {
        waits.push(ms);
        await onSleep?.();
      },
    },
  });
  return { driver, waits };
}

const put = (driver: GcsStorageDriver, bytes: Uint8Array, key: GenKey = GEN) =>
  driver.putImmutable(key, async (sink) => {
    await sink.write(bytes);
  });

/** The error the real SDK raises for an upload answered `status`, sent once. */
async function capture(status: number): Promise<unknown> {
  stub.arm({ status });
  const file = stub.client().bucket(STUB_GCS_BUCKET).file('k');
  return saveOnce(file, new Uint8Array([1]), { preconditionOpts: { ifGenerationMatch: 0 } }).catch(
    (e: unknown) => e,
  );
}

describe('GCS: which answers are a throttle, on the error the real SDK raises', () => {
  it.each([429, 503])('%i is a throttle, and transient', async (status) => {
    const err = (await capture(status)) as { code?: unknown };
    // The shape the classification keys on: pinned, so an SDK that changes it fails here.
    expect(err.code).toBe(status);
    expect(isThrottle(err)).toBe(true);
    expect(isTransient(err)).toBe(true);
    expect(isPreconditionFailed(err)).toBe(false);
  });

  it.each([500, 412, 403])('%i is not a throttle', async (status) => {
    expect(isThrottle(await capture(status))).toBe(false);
  });
});

describe('GCS: a throttled single-request upload is sent again, and its write id tells its own', () => {
  it('tags the object with a write id, and an upload that is not throttled is sent once with no read-back', async () => {
    const { driver, waits } = driverOver();
    await put(driver, new Uint8Array([1, 2, 3]));
    expect(stub.count('upload')).toBe(1);
    expect(stub.count('metadata')).toBe(0);
    expect(waits).toEqual([]);
    expect(stub.objects.get(OBJECT)?.metadata?.cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([429, 503])(
    'an upload answered %i and not applied is sent again and lands once',
    async (status) => {
      const { driver, waits } = driverOver();
      stub.arm({ status });
      await put(driver, new Uint8Array([1, 2, 3]));
      expect(stub.count('upload')).toBe(2);
      expect(stub.count('metadata')).toBe(0);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeLessThanOrEqual(500);
      expect([...stub.objects.get(OBJECT)!.body]).toEqual([1, 2, 3]);
    },
  );

  it('an upload answered 503 after it was applied is sent again, meets itself, and is its own: one object', async () => {
    const { driver } = driverOver();
    stub.arm({ status: 503, afterApplying: true });
    await put(driver, new Uint8Array([4, 5]));
    expect(stub.count('upload')).toBe(2);
    expect(stub.count('metadata')).toBe(1);
    expect(stub.objects.size).toBe(1);
    expect([...stub.objects.get(OBJECT)!.body]).toEqual([4, 5]);
  });

  it('an object another writer stored before the re-send is a WriteConflictError', async () => {
    const other = new GcsStorageDriver({ storage: stub.client(), bucket: STUB_GCS_BUCKET });
    const { driver } = driverOver(async () => {
      await put(other, new Uint8Array([9]));
    });
    stub.arm({ status: 429 });
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(stub.count('metadata')).toBe(1);
    expect([...stub.objects.get(OBJECT)!.body]).toEqual([9]);
  });

  it('an object with no write id met on a re-send is a WriteConflictError', async () => {
    const { driver } = driverOver(async () => {
      // During the backoff another writer takes the number, with no custom metadata at all.
      stub.objects.set(OBJECT, { body: Buffer.from([7]), generation: 5 });
    });
    stub.arm({ status: 503 });
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(stub.count('metadata')).toBe(1);
    expect([...stub.objects.get(OBJECT)!.body]).toEqual([7]);
  });

  it('a precondition that fails on the first send is a WriteConflictError, with no read-back', async () => {
    const { driver } = driverOver();
    await put(driver, new Uint8Array([1]));
    await expect(put(driver, new Uint8Array([2]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(stub.count('metadata')).toBe(0);
  });

  it('a throttle on every send ends in TransientError after three re-sends, deleting nothing', async () => {
    const { driver, waits } = driverOver();
    for (let i = 0; i < 4; i++) stub.arm({ status: 429 });
    const err = await put(driver, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(String((err as Error).message)).toMatch(/throttled/);
    expect(stub.count('upload')).toBe(4);
    expect(stub.count('delete')).toBe(0);
    expect(stub.objects.size).toBe(0);
    expect(waits).toHaveLength(3);
    waits.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(500 * 2 ** i));
  });

  it('a 500 is not a throttle: sent once, TransientError', async () => {
    const { driver, waits } = driverOver();
    stub.arm({ status: 500 });
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload')).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe('GCS: a registry row is sent once, whatever the answer', () => {
  it('a throttled compare-and-swap is not sent again', async () => {
    const registry = new GcsRegistryDriver({ storage: stub.client(), bucket: STUB_GCS_BUCKET });
    const { token } = await registry.create({ segment: 's' }, { currentGen: 0 });
    stub.arm({ status: 429, name: isRow });
    await expect(
      registry.compareAndSwap({ segment: 's' }, token, { currentGen: 1 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload', isRow)).toBe(2); // the create, then the swap once
  });
});

describe('GCS: a load whose writes are throttled, through the real SDK', () => {
  const SEG = { segment: 's' };
  const waits: number[] = [];
  function deps() {
    const client = stub.client();
    waits.length = 0;
    return {
      storage: new GcsStorageDriver({
        storage: client,
        bucket: STUB_GCS_BUCKET,
        clock: { sleep: async () => {} },
      }),
      registry: new GcsRegistryDriver({ storage: client, bucket: STUB_GCS_BUCKET }),
      codec: roaringCodec,
      // What a store wires: the publish waits on it before a fresh write, as the driver does before a re-send.
      clock: {
        now: () => 0,
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      },
    };
  }

  it('an object throttled once is sent again, and the load publishes', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    stub.arm({ status: 429, name: isObject });
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(stub.count('upload', isObject)).toBe(3);
  });

  it('a row answered 503 after it was applied is found by reading the row: published, the row sent once', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const before = stub.count('upload', isRow);
    stub.arm({ status: 503, afterApplying: true, name: isRow });
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(stub.count('upload', isRow) - before).toBe(1);
  });

  it('a row throttled once and not applied is sent again by the publish from the row it read back, and the load publishes', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const before = stub.count('upload', isRow);
    waits.length = 0;
    stub.arm({ status: 429, name: isRow });
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    // The driver sent the throttled write once; the second is a fresh compare-and-swap the publish made.
    expect(stub.count('upload', isRow) - before).toBe(2);
    expect(waits).toEqual([500]);
    expect(stub.count('delete')).toBe(0);
    expect((await d.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row throttled on every send is four writes, then the registry TransientError, and nothing deleted', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const before = stub.count('upload', isRow);
    waits.length = 0;
    for (let i = 0; i < 5; i++) stub.arm({ status: 429, name: isRow });
    await expect(loadSegment(SEG, [1, 2], d)).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload', isRow) - before).toBe(4); // bounded: the first send and three fresh ones
    expect(waits).toHaveLength(3);
    expect(stub.count('delete')).toBe(0);
    expect(stub.objects.has('_default/segments/s.1.crbm')).toBe(true);
    expect((await d.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('a row throttled once whose original request reaches GCS after the fresh write is refused by its generation: one write lands', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    stub.arm({ status: 429, hold: true, name: isRow });
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    const rowName = [...stub.objects.keys()].find((n) => isRow(n) && n.includes('/s.'))!;
    const landed = stub.objects.get(rowName)!.generation;
    stub.landHeld(); // the request answered 429 is applied now, against a generation that has moved on
    expect(stub.objects.get(rowName)!.generation).toBe(landed);
    expect((await d.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row throttled that lands after the load threw points at an object that is there', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    for (let i = 0; i < 4; i++) stub.arm({ status: 429, hold: true, name: isRow });
    await expect(loadSegment(SEG, [1, 2], d)).rejects.toBeInstanceOf(TransientError);
    stub.landHeld(); // the compare-and-swaps the service answered 429 are applied after all: one lands
    expect((await d.registry.get(SEG))!.currentGen).toBe(1);
    expect(stub.objects.has('_default/segments/s.1.crbm')).toBe(true);
    expect(stub.count('delete')).toBe(0);
  });

  it('an object throttled on every send throws TransientError, deletes nothing, and leaves the row where it was', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const rowsBefore = stub.count('upload', isRow);
    for (let i = 0; i < 4; i++) stub.arm({ status: 503, name: isObject });
    await expect(loadSegment(SEG, [1, 2], d)).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload', isObject)).toBe(1 + 4);
    expect(stub.count('upload', isRow)).toBe(rowsBefore); // no row write was attempted
    expect(stub.count('delete')).toBe(0);
    expect((await d.registry.get(SEG))!.currentGen).toBe(0);
  });
});
