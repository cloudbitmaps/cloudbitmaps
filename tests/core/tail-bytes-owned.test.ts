/**
 * A driver may answer a tail read with a Node `Buffer`, whose `slice` is a view of the driver's memory rather than a
 * copy, or with a `Uint8Array` made in another realm. A reader that keeps a small generation's chunk region must hold
 * bytes of its own all the same: when the driver reuses or overwrites the buffer it answered with, the chunks served
 * from memory stay the ones the object holds. The copy keeps what else the answer says, its `size` and its `version`,
 * however the driver's answer holds them: the version is what a conditional delete is sent with.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import type {
  GenKey,
  IStorageDriver,
  SegmentRef,
  StorageDeleteOptions,
  TailRead,
} from '@/core/ports';
import { ownedTail } from '@/core/crbm-storage-source';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/chunk-stream';

const K = 65_536;
/** Three chunks of 200 ids: a chunk region far under the 64 KiB a reader keeps by default. */
const IDS = Array.from({ length: 600 }, (_, i) => Math.floor(i / 200) * K + (i % 200) * 3);

/**
 * A `Uint8Array` subclass made in another realm, whose `slice` is a view as a `Buffer`'s is. `instanceof Uint8Array` is
 * false for it here.
 */
const OtherRealmPool = runInNewContext(
  'class Pool extends Uint8Array { slice(start, end) { return this.subarray(start, end); } }; Pool',
) as Uint8ArrayConstructor;

type PoolOf = (length: number) => Uint8Array;
const bufferPool: PoolOf = (length) => Buffer.alloc(length);
const otherRealmPool: PoolOf = (length) => new OtherRealmPool(length);

/** `bytes` copied into a pool of `poolOf`'s kind, larger than they are, and a view of them inside it. */
function pooled(bytes: Uint8Array, poolOf: PoolOf): { pool: Uint8Array; view: Uint8Array } {
  const pool = poolOf(bytes.length + 4096);
  pool.set(bytes, 1024);
  return { pool, view: pool.subarray(1024, 1024 + bytes.length) };
}

/** A memory backend whose tail reads answer with a view into a larger pool it keeps, as a pooling driver might. */
async function pooledAnswerWorld(poolOf: PoolOf) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 0 }, IDS, { registry });
  const pools: Uint8Array[] = [];
  const answered: Uint8Array[] = [];
  const calls = { tails: 0, ranges: 0 };
  const getTail = storage.getTail.bind(storage);
  vi.spyOn(storage, 'getTail').mockImplementation(async (key: GenKey, max: number) => {
    calls.tails++;
    const tail: TailRead = await getTail(key, max);
    const { pool, view } = pooled(tail.bytes, poolOf);
    pools.push(pool);
    answered.push(view);
    return { ...tail, bytes: view };
  });
  const getRange = storage.getRange.bind(storage);
  vi.spyOn(storage, 'getRange').mockImplementation((key, offset, length) => {
    calls.ranges++;
    return getRange(key, offset, length);
  });
  const store = new CloudRoaring({ storage: backend });
  return { store, pools, answered, calls };
}

describe('a tail answered as a Node Buffer', () => {
  it('is what the driver hands back: a Buffer whose slice shares its memory', async () => {
    const { store, answered } = await pooledAnswerWorld(bufferPool);
    expect(await store.segment('s').has(K + 3)).toBe(true);
    const [bytes] = answered;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    const view = bytes!.slice(0, 4);
    expect(view.buffer).toBe(bytes!.buffer);
  });

  it('leaves the reader its own chunk bytes: overwriting the driver buffer changes no read', async () => {
    const { store, pools, calls } = await pooledAnswerWorld(bufferPool);
    const seg = store.segment('s');
    // The open: one tail read, the whole object, and the chunk region kept.
    expect(await seg.has(K + 3)).toBe(true);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
    // The driver reuses its memory.
    for (const pool of pools) pool.fill(0xff);
    // Every chunk is still served from memory, whole and checksum-clean.
    expect(await collect(seg.iterate())).toEqual(IDS);
    expect(await seg.has(2 * K + 597)).toBe(true);
    expect(await seg.has(2 * K + 598)).toBe(false);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
  });
});

describe('a tail answered as a Uint8Array of another realm', () => {
  it('is what the driver hands back: not an instance of this realm, and its slice a view', async () => {
    const { store, answered } = await pooledAnswerWorld(otherRealmPool);
    expect(await store.segment('s').has(K + 3)).toBe(true);
    const [bytes] = answered;
    expect(bytes instanceof Uint8Array).toBe(false);
    expect(Object.prototype.toString.call(bytes)).toBe('[object Uint8Array]');
    expect(bytes!.slice(0, 4).buffer).toBe(bytes!.buffer);
  });

  it('leaves the reader its own chunk bytes: overwriting the driver buffer changes no read', async () => {
    const { store, pools, calls } = await pooledAnswerWorld(otherRealmPool);
    const seg = store.segment('s');
    expect(await seg.has(K + 3)).toBe(true);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
    for (const pool of pools) pool.fill(0xff);
    expect(await collect(seg.iterate())).toEqual(IDS);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
  });
});

/**
 * A driver's answer as an instance of its own class: `bytes` and `size` its own fields, `version` a getter on the
 * class, which a spread of the answer would not carry.
 */
class ClassTail {
  readonly bytes: Uint8Array;
  readonly size: number;
  private readonly etag: string;

  constructor(bytes: Uint8Array, size: number, etag: string) {
    this.bytes = bytes;
    this.size = size;
    this.etag = etag;
  }

  get version(): string {
    return this.etag;
  }
}

describe('ownedTail', () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);

  it('hands a plain Uint8Array of this realm through as it is, with no copy', () => {
    const tail: TailRead = { bytes: bytes.subarray(1, 3), size: 4, version: 'v' };
    expect(ownedTail(tail)).toBe(tail);
  });

  it('copies a Buffer, a subclass of another realm and a Uint8Array of another realm into a plain Uint8Array', () => {
    const otherPlain = runInNewContext('new Uint8Array([1, 2, 3, 4])') as Uint8Array;
    for (const answer of [
      pooled(bytes, bufferPool).view,
      pooled(bytes, otherRealmPool).view,
      otherPlain,
    ]) {
      const tail: TailRead = { bytes: answer, size: 4, version: 'v' };
      const owned = ownedTail(tail);
      expect(owned).not.toBe(tail);
      expect(Object.getPrototypeOf(owned.bytes)).toBe(Uint8Array.prototype);
      expect(owned.bytes.buffer).not.toBe(answer.buffer);
      expect([...owned.bytes]).toEqual([1, 2, 3, 4]);
      expect(owned).toEqual({ bytes: Uint8Array.of(1, 2, 3, 4), size: 4, version: 'v' });
    }
  });

  it("keeps the size and the version of a class instance's answer, a getter's included", () => {
    const answer = new ClassTail(pooled(bytes, bufferPool).view, 9, '"etag-1"');
    expect(Object.keys(answer)).not.toContain('version');
    const owned = ownedTail(answer);
    expect(owned.size).toBe(9);
    expect(owned.version).toBe('"etag-1"');
  });

  it('adds no version to an answer that has none', () => {
    const owned = ownedTail({ bytes: pooled(bytes, bufferPool).view, size: 4 });
    expect('version' in owned).toBe(false);
  });
});

describe("a refused load's reclaim over a driver that answers with a class instance", () => {
  const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

  it('sends its delete conditioned on the version the getter reports', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(SEG, [1, 2, 3], deps);

    const sent: { generation: number; ifVersion: string | undefined }[] = [];
    let seen: string | undefined;
    let wrote = false;
    // The row is deleted once this load's object is written, so the refusal proves the object its own by a footer read
    // and deletes it only while it is the object that read saw.
    const driver = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'putImmutable') {
          return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
            const out = await storage.putImmutable(...args);
            if (!wrote) {
              wrote = true;
              await registry.delete(SEG);
            }
            return out;
          };
        }
        if (prop === 'getTail') {
          return async (key: GenKey, maxBytes: number) => {
            const tail = await storage.getTail(key, maxBytes);
            return new ClassTail(pooled(tail.bytes, bufferPool).view, tail.size, tail.version!);
          };
        }
        if (prop === 'delete') {
          return async (key: GenKey, options?: StorageDeleteOptions) => {
            sent.push({ generation: key.generation, ifVersion: options?.ifVersion });
            seen = (await storage.getTail(key, 0)).version;
            return storage.delete(key, options);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as IStorageDriver;

    const r = await loadSegment(SEG, [2], { ...deps, storage: driver });
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(seen).toEqual(expect.any(String));
    expect(sent).toEqual([{ generation: 1, ifVersion: seen }]);
  });
});
