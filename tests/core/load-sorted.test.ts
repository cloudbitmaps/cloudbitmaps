import { randomBytes } from 'node:crypto';
import roaring from 'roaring';
import { loadSegment, loadSegmentChunks } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-open';
import { destroySegment } from '@/core/erasure';
import {
  IntegrityError,
  KeyUnavailableError,
  TransientError,
  ValidationError,
  WriteConflictError,
  errorKind,
} from '@/core/errors';
import { type BlobSink, BufferSink } from '@/core/blob';
import type { Clock } from '@/core/determinism';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage, RecordingAuditSink } from '@/index';
import { storeCodec } from '../helpers/store-codec';
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
    deps: { storage, registry, entropy: counterEntropy(), codec: storeCodec },
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
    for (const r of storeCodec.safeDeserialize(bytes, 1 << 20).toArray())
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

/** {@link watched}, as an async source. */
function watchedAsync(ids: readonly number[]) {
  const seen = { pulled: false, closed: false };
  async function* source(): AsyncGenerator<number> {
    seen.pulled = true;
    try {
      for (const id of ids) yield id;
    } finally {
      seen.closed = true;
    }
  }
  return { seen, source: source() };
}

/** An async source that never awaits anything itself: each id is ready on a microtask, never on a turn of the loop. */
async function* async(ids: readonly number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

/** A clock that counts the turns of the event loop a load yields. */
function countingClock(): Clock & { yields: number } {
  const clock = {
    yields: 0,
    now: () => 0,
    sleep: async () => undefined,
    yieldNow: async () => {
      clock.yields++;
    },
  };
  return clock;
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

  it('yields to the event loop while it reads the ids, sync or async, as an unsorted load does', async () => {
    // One chunk, so the writer's own per-chunk yield never comes: these are the id reader's.
    const ids = Array.from({ length: CHUNK }, (_, i) => i);
    for (const source of [ids, async(ids)]) {
      const clock = countingClock();
      await loadSegment(SEG, source, { ...world().deps, clock }, { sorted: true });
      expect(clock.yields).toBeGreaterThanOrEqual(3);
    }
  });

  it('yields to the event loop while it writes the chunks, as an unsorted load does', async () => {
    // One id a chunk, too few for the id reader to yield: these are the writer's, one every 1,024 chunks.
    const clock = countingClock();
    const ids = Array.from({ length: 8_192 }, (_, i) => i * CHUNK);
    await loadSegment(SEG, ids, { ...world().deps, clock }, { sorted: true });
    expect(clock.yields).toBeGreaterThanOrEqual(8);
  });

  it('reads a sync source in one synchronous run, not a microtask an id', async () => {
    // One chunk and no clock, so nothing in the read awaits: a microtask queued at the first id runs after the last.
    let pulled = 0;
    let pulledByTheFirstMicrotask: number | undefined;
    const source: Iterable<number> = {
      [Symbol.iterator]: () => ({
        next: () => {
          if (pulled === 0) queueMicrotask(() => (pulledByTheFirstMicrotask = pulled));
          return pulled < 10_000
            ? { value: pulled++, done: false }
            : { value: undefined, done: true };
        },
      }),
    };
    await loadSegment(SEG, source, world().deps, { sorted: true });
    expect(pulledByTheFirstMicrotask).toBe(10_000);
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
    expect(err.message).toMatch(
      /ran the write of s\.0 again: its chunks are streamed and can be read once/,
    );
    expect(await generations(w.storage)).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it("throws IntegrityError, with the first run's error as its cause, whatever the driver makes of it", async () => {
    const fault = new TransientError('the first part upload timed out');
    /** A driver that runs `write` again after a fault, and wraps the second run's error in one of its own. */
    class RetriesAndWraps extends MemoryStorageDriver {
      override async putImmutable(
        key: GenKey,
        write: (sink: BlobSink) => Promise<void>,
      ): Promise<{ size: number; sha256: string }> {
        const failing: BlobSink = {
          write: async () => {
            throw fault;
          },
        };
        await write(failing).catch(() => undefined);
        return super.putImmutable(key, write).catch((err: unknown) => {
          throw new TransientError('the upload failed', { cause: err });
        });
      }
    }
    const w = world(new RetriesAndWraps());
    const err = await rejection(loadSegment(SEG, [1, 2, CHUNK], w.deps, { sorted: true }));
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.message).toMatch(/ran the write of s\.0 again/);
    expect(err.cause).toBe(fault);
    expect(await generations(w.storage)).toEqual([]);
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

  it('closes an async source too, when the upload fails and when an id is out of order', async () => {
    const failure = new Error('disk full');
    const ids = Array.from({ length: 50 }, (_, i) => i * CHUNK);
    const failed = watchedAsync(ids);
    expect(
      await rejection(
        loadSegment(SEG, failed.source, world(failingAfter(100, failure)).deps, { sorted: true }),
      ),
    ).toBe(failure);
    expect(failed.seen.closed).toBe(true);
    const refused = watchedAsync([...ids.slice(0, 10), 1, ...ids.slice(10)]);
    const err = await rejection(loadSegment(SEG, refused.source, world().deps, { sorted: true }));
    expect(err.message).toMatch(/^ids\[10\]: lower than the id before it/);
    expect(refused.seen.closed).toBe(true);
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
    for (const [value, kind] of [
      ['yes', 'a string'],
      [1, 'a number'],
      [null, 'null'],
      [{}, 'an object'],
      [[true], 'an array'],
    ] as const) {
      const { w, calls } = untouched();
      const err = await rejection(
        loadSegment(SEG, [1], w.deps, { sorted: value as unknown as boolean }),
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(`sorted must be a boolean; got ${kind}`);
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
      yield { chunkKey: 0, bitmap: storeCodec.fromValues([1]) };
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

describe("a load hands on a WriteConflictError its source raised, sorted or not, as its source's error", () => {
  // A source that reads another segment through a pin can raise this library's own lost race; the load did not lose one.
  const raisedBy = (kind: string): WriteConflictError =>
    new WriteConflictError(`the pin of another segment lost its race (${kind})`);

  it.each<[string, (raised: Error) => Parameters<typeof loadSegment>[1], boolean]>([
    [
      'unsorted, sync',
      (raised) =>
        (function* () {
          yield 1;
          throw raised;
        })(),
      false,
    ],
    [
      'unsorted, async',
      (raised) =>
        (async function* () {
          yield 1;
          throw raised;
        })(),
      false,
    ],
    [
      'sorted, async',
      (raised) =>
        (async function* () {
          yield 1;
          throw raised;
        })(),
      true,
    ],
  ])('%s: throws it, and reports no refusal', async (kind, source, sorted) => {
    const w = world();
    const audit = new RecordingAuditSink();
    const raised = raisedBy(kind);
    const err = await loadSegment(SEG, source(raised), w.deps, { sorted, audit }).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(raised);
    expect(audit.snapshot().filter((e) => e.kind === 'segment.load-refused')).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it("from a combine's chunks: throws it", async () => {
    const w = world();
    const raised = raisedBy('chunks');
    async function* chunks() {
      yield { chunkKey: 0, bitmap: storeCodec.fromValues([1]) };
      throw raised;
    }
    expect(await loadSegmentChunks(SEG, chunks(), w.deps).catch((e: unknown) => e)).toBe(raised);
  });

  it("still reports a lost race the write raised as 'superseded'", async () => {
    const w = world();
    w.storage.putImmutable = async () => {
      throw new WriteConflictError('generation already exists (write-once): s.0');
    };
    for (const sorted of [false, true]) {
      expect(await loadSegment(SEG, [1, 2], w.deps, { sorted })).toMatchObject({
        published: false,
        reason: 'superseded',
      });
    }
  });
});
