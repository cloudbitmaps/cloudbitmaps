import { randomBytes } from 'node:crypto';
import roaring from 'roaring';
import { loadSegment, loadSegmentChunks } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-open';
import { destroySegment } from '@/core/erasure';
import { IntegrityError, KeyUnavailableError, ValidationError, errorKind } from '@/core/errors';
import { type BlobSink, BufferSink } from '@/core/blob';
import type { Clock } from '@/core/determinism';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counterEntropy } from '../helpers/entropy';

/**
 * `load(…, { sorted: true })`: ids that ascend, written one chunk at a time while the object uploads.
 *
 * What it must keep from an unsorted load: the same refusals, the same result and the same object (the property test
 * holds the bytes). What it adds: an id lower than the one before is refused, by position; the row, the number and the
 * key are settled before the first id is read, so a refusal there reads none; the ids are read once; and the option is
 * refused wherever it would do nothing.
 */

const { RoaringBitmap32 } = roaring;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const CHUNK = 65_536;
const U32_MAX = 2 ** 32 - 1;

function world(storage: IStorageDriver = new MemoryStorageDriver()) {
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, entropy: counterEntropy(), codec: roaringCodec },
  };
}

async function generations(storage: IStorageDriver, ref: SegmentRef = SEG): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(ref)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function idsOf(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray())
      out.push(chunkKey * CHUNK + r);
  }
  return out;
}

/** A source that records whether it was read, and whether it was closed. */
function watched(ids: readonly number[]) {
  const seen = { pulled: false, closed: false };
  function* source(): Generator<number> {
    seen.pulled = true;
    try {
      yield* ids;
    } finally {
      seen.closed = true;
    }
  }
  return { seen, source: source() };
}

async function* async(ids: readonly number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the load to throw').toBeInstanceOf(Error);
  return err as Error;
}

describe('a sorted load writes what an unsorted load of the same ids writes', () => {
  it.each([
    ['a sync source', (ids: number[]) => ids],
    ['an async source', (ids: number[]) => async(ids)],
  ])(
    'from %s: the same result and ids, at the edges of the id space and of chunks',
    async (_, as) => {
      const ids = [
        0,
        1,
        CHUNK - 1,
        CHUNK,
        CHUNK + 1,
        2 * CHUNK - 1,
        5 * CHUNK + 7,
        U32_MAX - CHUNK,
        U32_MAX,
      ];
      const sorted = world();
      const unsorted = world();
      const a = await loadSegment(SEG, as(ids), sorted.deps, { sorted: true });
      const b = await loadSegment(SEG, [...ids].reverse(), unsorted.deps);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ published: true, cardinality: ids.length, chunkCount: 5 });
      expect(await idsOf(sorted.storage, a.generation)).toEqual(ids);
    },
  );

  it('writes an empty generation from an empty source, as an unsorted load does', async () => {
    const sorted = world();
    const unsorted = world();
    const a = await loadSegment(SEG, [], sorted.deps, { sorted: true, allowEmpty: true });
    const b = await loadSegment(SEG, [], unsorted.deps, { allowEmpty: true });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ published: true, cardinality: 0, chunkCount: 0 });
    // And the empty refusal is the same: a sorted empty load over a segment with ids is refused.
    await loadSegment(SEG, [1, 2], sorted.deps, { sorted: true });
    expect(await loadSegment(SEG, [], sorted.deps, { sorted: true })).toMatchObject({
      published: false,
      reason: 'empty',
    });
  });

  it('skips repeats, more than a chunk of them, and keeps every id after them', async () => {
    // 70,000 copies of one id would overflow the 65,536 remainders a chunk holds if they were buffered, and the ids
    // after them in the same chunk would be lost.
    const ids = [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array.from({ length: 70_000 }, () => 10),
      ...Array.from({ length: 10 }, (_, i) => 11 + i),
      CHUNK + 3,
      CHUNK + 3,
    ];
    const w = world();
    const r = await loadSegment(SEG, ids, w.deps, { sorted: true });
    expect(r).toMatchObject({ published: true, cardinality: 22, chunkCount: 2 });
    expect(await idsOf(w.storage, r.generation)).toEqual([
      ...Array.from({ length: 21 }, (_, i) => i),
      CHUNK + 3,
    ]);
  });

  it('writes a whole chunk of 65,536 ids, the most one can hold', async () => {
    const w = world();
    const ids = Array.from({ length: CHUNK }, (_, i) => 3 * CHUNK + i);
    const r = await loadSegment(SEG, ids, w.deps, { sorted: true });
    expect(r).toMatchObject({ published: true, cardinality: CHUNK, chunkCount: 1 });
    expect((await idsOf(w.storage, r.generation)).length).toBe(CHUNK);
  });

  it('replaces a segment that has a generation, and collects what it superseded', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps, { sorted: true });
    const second = await loadSegment(SEG, [4, 5], w.deps, { sorted: true, keep: 0 });
    expect(second).toMatchObject({
      generation: 1,
      published: true,
      cardinality: 2,
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([1]);
  });

  it('loads an encrypted segment, which reads back through the store', async () => {
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const store = new CloudRoaring({ storage: new MemoryStorage(), encryption: { keystore } });
    const ids = Array.from({ length: 5_000 }, (_, i) => i * 997);
    await store.load({ segment: 'e' }, ids, { sorted: true });
    const again = await store.load({ segment: 'e' }, async(ids.slice(0, 10)), { sorted: true });
    expect(again).toMatchObject({ published: true, cardinality: 10 });
    expect(await store.segment('e').count()).toBe(10);
    expect(await store.segment('e').has(997)).toBe(true);
  });

  it('yields to the event loop while it reads the ids, as an unsorted load does', async () => {
    let yields = 0;
    const clock: Clock = {
      now: () => 0,
      sleep: async () => undefined,
      yieldNow: async () => {
        yields++;
      },
    };
    const w = world();
    // One chunk, so the writer's own per-chunk yield never comes: these are the id reader's.
    const ids = Array.from({ length: CHUNK }, (_, i) => i);
    await loadSegment(SEG, ids, { ...w.deps, clock }, { sorted: true, allowEmpty: true });
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});

describe('a sorted load refuses ids that do not ascend, by position', () => {
  it('refuses an id lower than the one before: a ValidationError naming the position, never an id', async () => {
    const w = world();
    const { seen, source } = watched([123_456_789, 123_456_790, 123_456_788]);
    const err = await rejection(loadSegment(SEG, source, w.deps, { sorted: true }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(errorKind(err)).toBe('ValidationError');
    expect(err.message).toBe(
      'ids[2]: lower than the id before it; { sorted: true } takes ids in ascending order (repeats are fine): ' +
        'sort at the source, or leave sorted off',
    );
    expect(err.message).not.toMatch(/12345678/);
    expect(Object.keys(err)).not.toContain('reason');
    // The caller's source is closed, nothing is in the bucket, and the registry has no row.
    expect(seen.closed).toBe(true);
    expect(await generations(w.storage)).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('refuses one inside a chunk, across chunks, and from an async source, and leaves the row as it was', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    const before = await w.registry.get(SEG);
    for (const ids of [
      [5, 3],
      [7, 9, 9, 8],
      [2 * CHUNK, CHUNK + 1],
    ]) {
      const err = await rejection(loadSegment(SEG, ids, w.deps, { sorted: true }));
      expect(err.message).toMatch(/^ids\[\d+\]: lower than the id before it/);
      const fromAsync = await rejection(loadSegment(SEG, async(ids), w.deps, { sorted: true }));
      expect(fromAsync.message).toBe(err.message);
    }
    expect(await w.registry.get(SEG)).toEqual(before);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('refuses a bad id as an unsorted load does, at its position', async () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 32, '7' as unknown as number]) {
      const sorted = await rejection(loadSegment(SEG, [1, 2, bad], world().deps, { sorted: true }));
      const unsorted = await rejection(loadSegment(SEG, [1, 2, bad], world().deps));
      expect(sorted).toBeInstanceOf(ValidationError);
      expect(sorted.message).toBe(unsorted.message);
      expect(sorted.message).toMatch(/^ids\[2\]: an id must be an integer/);
      expect((sorted.cause as Error).message).toBe((unsorted.cause as Error).message);
    }
  });

  it('names the position of a refused id past repeats, counting every id the caller passed', async () => {
    const err = await rejection(loadSegment(SEG, [4, 4, 4, 4, 3], world().deps, { sorted: true }));
    expect(err.message).toMatch(/^ids\[4\]: /);
  });
});

describe('a sorted load settles the segment before it reads an id', () => {
  it('refuses a destroyed segment without reading the ids', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await destroySegment(SEG, w.deps, { confirmSegment: SEG.segment, allowCleartext: true });
    const { seen, source } = watched([1, 2]);
    const err = await rejection(
      loadSegment(SEG, source, w.deps, { sorted: true, allowEmpty: true }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/destroyed/);
    expect(seen.pulled).toBe(false);
  });

  it('refuses an encrypted segment it has no keystore for without reading the ids', async () => {
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const w = world();
    await loadSegment(SEG, [1], { ...w.deps, keystore });
    // With no bound to read the current size for, the write's own check is the one that refuses.
    for (const options of [{ allowEmpty: true }, {}]) {
      const { seen, source } = watched([1, 2]);
      const err = await rejection(loadSegment(SEG, source, w.deps, { sorted: true, ...options }));
      expect(err).toBeInstanceOf(KeyUnavailableError);
      expect(seen.pulled).toBe(false);
    }
  });

  it('refuses a cleartext segment when encryption is required, without reading the ids', async () => {
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    const { seen, source } = watched([1, 2]);
    const err = await rejection(
      loadSegment(SEG, source, { ...w.deps, keystore, requireEncryption: true }, { sorted: true }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/requireEncryption/);
    expect(seen.pulled).toBe(false);
  });

  it('reads the ids only once the row, the number and the key are settled, inside the write', async () => {
    const w = world();
    const order: string[] = [];
    const get = w.registry.get.bind(w.registry);
    w.registry.get = async (ref) => {
      order.push('row');
      return get(ref);
    };
    const list = w.storage.list.bind(w.storage);
    w.storage.list = (ref) => {
      order.push('list');
      return list(ref);
    };
    const put = w.storage.putImmutable.bind(w.storage);
    w.storage.putImmutable = (key, write) => {
      order.push('put');
      return put(key, write);
    };
    function* ids(): Generator<number> {
      order.push('ids');
      yield 1;
    }
    await loadSegment(SEG, ids(), w.deps, { sorted: true, allowEmpty: true });
    expect(order.indexOf('ids')).toBeGreaterThan(order.indexOf('put'));
    expect(order.slice(0, order.indexOf('ids'))).toContain('row');
  });

  it('is caught at the publish when the segment is shredded while the ids stream, and deletes its object', async () => {
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const w = world();
    const deps = { ...w.deps, keystore };
    await loadSegment(SEG, [1], deps);
    async function* ids(): AsyncGenerator<number> {
      yield 1;
      await destroySegment(SEG, deps, { confirmSegment: SEG.segment });
      yield 2;
    }
    const r = await loadSegment(SEG, ids(), deps, { sorted: true, allowEmpty: true });
    expect(r).toMatchObject({ published: false, reason: 'superseded', generation: 1 });
    expect((await w.registry.get(SEG))?.status).toBe('destroyed');
    expect(await generations(w.storage)).not.toContain(1);
  });
});

describe('a sorted load reads its ids once', () => {
  /** A driver that runs `write` twice: once into a sink it discards, then for real. */
  class TwiceRunning extends MemoryStorageDriver {
    override async putImmutable(
      key: GenKey,
      write: (sink: BlobSink) => Promise<void>,
    ): Promise<{ size: number; sha256: string }> {
      await write(new BufferSink()).catch(() => undefined);
      return super.putImmutable(key, write);
    }
  }

  it('throws IntegrityError for a driver that runs its write again, and writes nothing', async () => {
    const w = world(new TwiceRunning());
    const err = await rejection(loadSegment(SEG, [1, 2, 3], w.deps, { sorted: true }));
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.message).toMatch(/read a second time/);
    expect(await generations(w.storage)).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('throws the error the ids raised on the first run, when the driver runs its write again after it', async () => {
    const w = world(new TwiceRunning());
    const raised = new Error('the warehouse cursor expired');
    async function* ids(): AsyncGenerator<number> {
      yield 1;
      throw raised;
    }
    const err = await rejection(loadSegment(SEG, ids(), w.deps, { sorted: true }));
    expect(err).toBe(raised);
  });
});

describe('a sorted load that fails mid-upload', () => {
  /** A driver whose sink fails once `after` bytes are written. */
  function failingAfter(after: number, failure: Error): MemoryStorageDriver {
    return new (class extends MemoryStorageDriver {
      override async putImmutable(
        key: GenKey,
        write: (sink: BlobSink) => Promise<void>,
      ): Promise<{ size: number; sha256: string }> {
        let written = 0;
        return super.putImmutable(key, (sink) =>
          write({
            write: async (bytes: Uint8Array) => {
              written += bytes.length;
              if (written > after) throw failure;
              return sink.write(bytes);
            },
          }),
        );
      }
    })();
  }

  it("closes the caller's source and throws the upload's error", async () => {
    const failure = new Error('disk full');
    const w = world(failingAfter(100, failure));
    const ids = Array.from({ length: 50 }, (_, i) => i * CHUNK);
    const { seen, source } = watched(ids);
    const err = await rejection(loadSegment(SEG, source, w.deps, { sorted: true }));
    expect(err).toBe(failure);
    expect(seen.closed).toBe(true);
    expect(await generations(w.storage)).toEqual([]);
  });

  it("throws the upload's error, not one the caller's source throws as it is closed", async () => {
    const failure = new Error('disk full');
    const onClose = new Error('the cursor could not be released');
    const w = world(failingAfter(100, failure));
    let next = 0;
    const source: Iterable<number> = {
      [Symbol.iterator]: () => ({
        next: () => ({ value: next++ * CHUNK, done: next > 50 }),
        return: () => {
          throw onClose;
        },
      }),
    };
    const err = await rejection(loadSegment(SEG, source, w.deps, { sorted: true }));
    expect(err).toBe(failure);
  });
});

describe('sorted is refused wherever it would do nothing, before any request', () => {
  function untouched() {
    const w = world();
    const calls: string[] = [];
    w.registry.get = async () => {
      calls.push('get');
      return null;
    };
    return { w, calls };
  }

  it('refuses a value that is not a boolean, in core and in the store', async () => {
    for (const value of ['yes', 1, null, {}]) {
      const { w, calls } = untouched();
      const err = await rejection(
        loadSegment(SEG, [1], w.deps, { sorted: value as unknown as boolean }),
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(
        /^sorted must be a boolean; got (a string|a number|null|a object)$/,
      );
      expect(calls).toEqual([]);
    }
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(
      store.load({ segment: 's' }, [1], { sorted: 'true' as unknown as boolean }),
    ).rejects.toThrow(/^load: `sorted` must be a boolean; got a string$/);
  });

  it('takes sorted: false as the default', async () => {
    const w = world();
    expect(await loadSegment(SEG, [3, 1], w.deps, { sorted: false })).toMatchObject({
      published: true,
      cardinality: 2,
    });
  });

  it('refuses it with { serialized }, { bitmap } and a bare bitmap, which are written from their own chunks', async () => {
    const bitmap = new RoaringBitmap32([1, 2, 3]);
    for (const input of [{ serialized: bitmap.serialize('portable') }, { bitmap }]) {
      const { w, calls } = untouched();
      const err = await rejection(loadSegment(SEG, input, w.deps, { sorted: true }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(/^sorted: true applies to ids/);
      expect(calls).toEqual([]);
    }
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(store.load({ segment: 's' }, bitmap, { sorted: true })).rejects.toThrow(
      /^sorted: true applies to ids/,
    );
  });

  it('refuses a byte array as ids first, as without it', async () => {
    const { w } = untouched();
    const err = await rejection(loadSegment(SEG, new Uint8Array([1, 2]), w.deps, { sorted: true }));
    expect(err.message).toMatch(/cannot be a Uint8Array or Buffer/);
  });

  it("refuses it on loadSegmentChunks, whose chunks ascend already, and the *Into verbs don't take it", async () => {
    const { w, calls } = untouched();
    async function* chunks() {
      yield { chunkKey: 0, bitmap: roaringCodec.fromValues([1]) };
    }
    const err = await rejection(loadSegmentChunks(SEG, chunks(), w.deps, { sorted: true }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^loadSegmentChunks takes no sorted: true/);
    expect(calls).toEqual([]);
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2]);
    const a = store.segment('a');
    await expect(
      a.intersectInto(store.segment('d'), [a], { sorted: true } as never),
    ).rejects.toThrow(/unknown option "sorted"/);
  });
});
