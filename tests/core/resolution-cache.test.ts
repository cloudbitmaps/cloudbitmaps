vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CrbmStorageChunkSource, InProcessKeystore, TransientError } from '@/index';
import type { Clock, IKeystore, SegmentRef } from '@/index';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { GenKey, IRegistryDriver, IStorageDriver, RegistryRecord } from '@/core/ports';
import { NotFoundError } from '@/core/errors';
import type { BoundedLru } from '@/core/lru';
import {
  DEFAULT_MAX_OPEN_INDEX_BYTES,
  DEFAULT_MAX_OPEN_SEGMENTS,
  REFRESH_RETRY_MS,
  RESOLUTION_BYTES_DIVISOR,
  RESOLUTIONS_PER_OPEN_SEGMENT,
} from '@/core/reader-defaults';
import { segmentKey } from '@/core/keys';
import { destroySegment } from '@/core/erasure';
import { SafeBitmap } from '@/roaring-codec';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A segment's resolution, kept apart from its reader: what the `.crbm` source read of the segment's row (its generation,
 * `pointerId`, wrapped keys and summary, nothing else), held in a bounded cache of its own for `cache.genTtlMs` from the
 * instant the registry read was sent, whether or not the segment's reader is still open. Only a source with a timed
 * refresh has one. Letting a reader go then costs only the open a read needs, and moves nothing: the source keeps
 * reading the generation it resolved until the TTL lapses, an invalidation, or a read that finds its generation swept.
 *
 * These cases drive the source itself, with a reader cache of one segment, so reading `b` lets `a`'s reader go.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const B: SegmentRef = { namespace: NS, segment: 'b' };
const C: SegmentRef = { namespace: NS, segment: 'c' };
const HI = 65_536;
const TTL = 1_000;

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

/** What the source keeps, read from outside: its reader cache and its resolution cache. */
interface Inside {
  readonly resolutions:
    | BoundedLru<string, { readonly resolved: Promise<unknown>; readonly sentAtMs: number }>
    | undefined;
  readonly snapshots: BoundedLru<string, unknown>;
}
const inside = (source: CrbmStorageChunkSource): Inside => source as unknown as Inside;

/** What a held read does once it is let go: answer the row it read, answer no row, or fail. */
type Outcome = 'row' | 'null' | Error;

/**
 * A registry whose row reads are counted, and the next of which can be held after it has read the row (it answers what
 * the row was when it was sent, unless told otherwise), or failed.
 */
function scripted(base: IRegistryDriver) {
  const state = {
    reads: 0,
    hold: undefined as
      { reached: () => void; gate: Promise<void>; outcome: () => Outcome } | undefined,
    fail: undefined as Error | undefined,
    /** Fails every row read while set, as a registry in an outage does. */
    down: undefined as Error | undefined,
    tamper: (row: RegistryRecord): RegistryRecord => row,
  };
  const registry = new Proxy(base, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return typeof value === 'function' ? value.bind(t) : value;
      return async (ref: SegmentRef) => {
        state.reads += 1;
        if (state.down !== undefined) throw state.down;
        const fail = state.fail;
        state.fail = undefined;
        if (fail !== undefined) throw fail;
        const hold = state.hold;
        state.hold = undefined;
        const row = await t.get(ref);
        if (hold !== undefined) {
          hold.reached();
          await hold.gate;
          const outcome = hold.outcome();
          if (outcome === 'null') return null;
          if (outcome instanceof Error) throw outcome;
        }
        return row === null ? null : state.tamper(row);
      };
    },
  });
  /**
   * Hold the next row read once it has read the row: `reached` settles then, and `release` lets it answer, as `outcome`
   * says (the row it read, by default).
   */
  const holdNext = (): { reached: Promise<void>; release: (outcome?: Outcome) => void } => {
    let reached!: () => void;
    let open!: () => void;
    let outcome: Outcome = 'row';
    const r = new Promise<void>((resolve) => (reached = resolve));
    state.hold = {
      reached,
      gate: new Promise<void>((resolve) => (open = resolve)),
      outcome: () => outcome,
    };
    return {
      reached: r,
      release: (answer = 'row') => {
        outcome = answer;
        open();
      },
    };
  };
  return { registry, state, holdNext };
}

interface WorldOptions {
  clock?: boolean;
  registry?: boolean;
  ttl?: number;
  readerMax?: number;
  readerMaxBytes?: number;
  encrypted?: boolean;
}

/** `a` and `b` loaded at generation 0, and a source over them that has read nothing. */
async function world(options: WorldOptions = {}) {
  const storage = new MemoryStorageDriver();
  const base = new MemoryRegistryDriver();
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  await bulkLoadCrbmGeneration(storage, { ...A, generation: 0 }, [1, HI + 1], {
    registry: base,
    keystore,
  });
  await bulkLoadCrbmGeneration(storage, { ...B, generation: 0 }, [2, HI + 2], {
    registry: base,
    keystore,
  });
  const calls: Record<string, number> = {};
  const keyCalls: Record<string, number> = {};
  const rows = scripted(base);
  const clock = manualClock();
  /** The next tail read of `a` held until let go, which then fails with the error given, or reads. */
  let heldTail: { reached: () => void; gate: Promise<Error | undefined> } | undefined;
  const holding = new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'getTail') return typeof value === 'function' ? value.bind(t) : value;
      return async (key: GenKey, maxBytes: number) => {
        const hold = key.segment === 'a' ? heldTail : undefined;
        if (hold !== undefined) {
          heldTail = undefined;
          hold.reached();
          const err = await hold.gate;
          if (err !== undefined) throw err;
        }
        return t.getTail(key, maxBytes);
      };
    },
  });
  const holdNextTail = (): { reached: Promise<void>; release: (err?: Error) => void } => {
    let reached!: () => void;
    let release!: (err?: Error) => void;
    const r = new Promise<void>((resolve) => (reached = resolve));
    heldTail = { reached, gate: new Promise<Error | undefined>((resolve) => (release = resolve)) };
    return { reached: r, release };
  };
  const source = new CrbmStorageChunkSource(counting<IStorageDriver>(holding, calls), {
    ...(options.registry === false ? {} : { registry: rows.registry }),
    ...(options.clock === false ? {} : { clock }),
    currentGenTtlMs: options.ttl ?? TTL,
    maxOpenSegments: options.readerMax ?? 1,
    ...(options.readerMaxBytes === undefined ? {} : { maxOpenIndexBytes: options.readerMaxBytes }),
    ...(keystore === undefined ? {} : { keystore: counting<IKeystore>(keystore, keyCalls) }),
  });
  /** What the source sent since the last reset: row reads, tail reads (an open) and range reads (a chunk). */
  const sent = () => ({
    rows: rows.state.reads,
    tails: calls.getTail ?? 0,
    ranges: calls.getRange ?? 0,
  });
  const reset = (): void => {
    rows.state.reads = 0;
    for (const c of [calls, keyCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  /** Another process's load of `ids` as `ref`'s generation `g`, which this source is not told of. */
  const publish = (ref: SegmentRef, g: number, ids: number[]) =>
    bulkLoadCrbmGeneration(storage, { ...ref, generation: g }, ids, { registry: base, keystore });
  const key = (ref: SegmentRef): string => segmentKey(ref);
  return {
    storage,
    base,
    rows,
    source,
    clock,
    sent,
    reset,
    publish,
    key,
    holdNextTail,
    keystore,
    unwraps: () => keyCalls.openDek ?? 0,
    /** Open `ref`'s reader, as a read of its shape does. */
    open: (ref: SegmentRef) => source.listChunkKeys(ref),
    /** Let `a`'s reader go: the reader cache holds one segment, and this reads another. */
    letAGo: () => source.listChunkKeys(B),
    resolution: (ref: SegmentRef) => inside(source).resolutions?.peek(segmentKey(ref)),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Which generation of `a` a chunk is from: `a`'s generation g holds `1 + 2g` in chunk 0. */
const remainder0 = (bytes: Uint8Array | null): number =>
  SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()[0]!;

describe('the resolution cache exists only with a timed refresh', () => {
  it.each([
    ['a registry, a clock and genTtlMs above 0', {}, true],
    ['no clock', { clock: false }, false],
    ['genTtlMs 0', { ttl: 0 }, false],
    ['no registry', { registry: false }, false],
  ] as const)('%s', async (_, options, exists) => {
    const x = await world(options);
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(inside(x.source).resolutions !== undefined).toBe(exists);
  });

  it.each([
    ['no clock', { clock: false }],
    ['genTtlMs 0', { ttl: 0 }],
  ] as const)(
    'with %s, a reader the cache let go is resolved again from the registry, as it always was',
    async (_, options) => {
      const x = await world(options);
      await x.open(A);
      await x.letAGo();
      x.reset();
      await x.open(A);
      expect(x.sent()).toEqual({ rows: 1, tails: 1, ranges: 0 });
    },
  );

  it('with one, a reader the cache let go reopens from the kept resolution: a tail read, and no row read', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo();
    expect(inside(x.source).snapshots.peek(x.key(A))).toBeUndefined(); // control: the reader went
    x.reset();
    await x.open(A);
    expect(x.sent()).toEqual({ rows: 0, tails: 1, ranges: 0 });
  });
});

describe('what a resolution holds', () => {
  it('the fields of the row a read resolves through, and nothing else: no token, no lease, no key', async () => {
    const x = await world({ encrypted: true });
    await x.open(A);
    const row = (await x.base.get(A))!;
    const resolved = await x.resolution(A)!.resolved;
    expect(resolved).toStrictEqual({
      generation: 0,
      lineage: row.pointerId,
      wrappedDeks: row.wrappedDeks,
      summary: row.summary,
    });
    expect(JSON.parse(JSON.stringify(resolved))).toStrictEqual(resolved);
  });

  it('a reopen after the reader was let go asks the keystore again; a refresh that finds the same keys does not', async () => {
    const x = await world({ encrypted: true });
    await x.open(A);
    await x.letAGo();
    x.reset();
    await x.open(A);
    expect(x.unwraps()).toBe(1);
    expect(x.sent()).toEqual({ rows: 0, tails: 1, ranges: 0 });
    // The TTL lapses on an open reader: the refresh finds the same row, keeps the reader and the key it unwrapped.
    x.clock.advance(TTL);
    x.reset();
    await x.open(A);
    expect(x.unwraps()).toBe(0);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it.each(['no row', 'a pointerless row', 'a destroyed row'] as const)(
    '%s: no resolution is kept, so the next read asks the registry again',
    async (shape) => {
      const x = await world();
      if (shape === 'a pointerless row') await x.base.create(C, { currentGen: null });
      if (shape === 'a destroyed row') {
        await x.publish(C, 0, [5]);
        const res = await destroySegment(
          C,
          { registry: x.base },
          { confirmSegment: 'c', allowCleartext: true },
        );
        expect(res).toMatchObject({ destroyed: true });
      }
      expect(await x.source.currentGeneration(C)).toBeNull();
      expect(x.resolution(C)).toBeUndefined();
      x.reset();
      expect(await x.source.currentGeneration(C)).toBeNull();
      expect(x.sent().rows).toBe(1);
      if (shape !== 'a destroyed row') {
        // A first load by another process is seen at once, inside the TTL.
        await x.publish(C, 0, [5]);
        expect(await x.source.currentGeneration(C)).toBe(0);
      }
    },
  );
});

describe("a running stream keeps its segment's place in the reader cache", () => {
  it('each chunk it hands out touches the snapshot, so a read of the segment beside it opens nothing', async () => {
    const x = await world({ readerMax: 2 });
    await x.publish(C, 0, [5]);
    const it = x.source.getChunks!(A, [0, 1], { concurrency: 1 })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await x.open(B); // the reader cache: a, then b
    expect((await it.next()).done).toBe(false); // the stream's check of `a` touches it: b, then a
    await x.open(C); // lets the least recently used go: b
    x.reset();
    await x.open(A);
    expect(x.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
    await it.return!(undefined);
  });
});

describe('what forgets a resolution', () => {
  it('invalidate: the next read reads the row, and finds a publish', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo();
    await x.publish(A, 1, [3, HI + 3]);
    x.source.invalidate(A);
    expect(x.resolution(A)).toBeUndefined();
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(x.sent().rows).toBe(1);
  });

  it('an invalidate while the registry read is in flight is not undone by its answer', async () => {
    const x = await world();
    const held = x.rows.holdNext();
    const first = x.source.currentGeneration(A);
    await held.reached; // the read has the row as it was: generation 0
    await x.publish(A, 1, [3, HI + 3]);
    x.source.invalidate(A);
    held.release();
    expect(await first).toBe(0); // the read that was in flight answers what it read
    expect(x.resolution(A)).toBeUndefined();
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(x.sent().rows).toBe(1);
  });

  it.each([
    ['answers no row', 'null'],
    ['fails', new TransientError('throttled')],
  ] as const)(
    "a held read that %s after an invalidate and a newer read does not forget the newer read's resolution",
    async (_, outcome) => {
      const x = await world();
      const held = x.rows.holdNext();
      const first = x.source.currentGeneration(A); // R1, held at the registry
      first.catch(() => undefined);
      await held.reached;
      x.source.invalidate(A);
      expect(await x.source.currentGeneration(A)).toBe(0); // R2, kept
      held.release(outcome);
      await first.catch(() => undefined); // R1 lands, as no generation or a fault: it forgets only itself
      await x.letAGo();
      x.reset();
      expect(await x.source.currentGeneration(A)).toBe(0);
      expect(x.sent().rows).toBe(0); // R2's resolution is still kept
    },
  );

  it("an older snapshot's open that fails after a newer resolution is kept does not forget the newer one", async () => {
    const x = await world();
    const tail = x.holdNextTail();
    const first = x.source.listChunkKeys(A); // R1, then its open, held at the tail read
    await tail.reached;
    x.source.invalidate(A);
    expect(await x.source.currentGeneration(A)).toBe(0); // R2, kept: it opens nothing
    tail.release(new NotFoundError('no such generation: a.0'));
    expect(await first).toEqual([0, 1]); // R1's open failed: the read moves to R2's snapshot, and reads once more
    await x.letAGo();
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(0); // R2's resolution is still kept
  });

  it('a purge and a re-create under new wrapped keys: the refresh unwraps the new key, and keeps nothing of the old', async () => {
    const x = await world({ encrypted: true });
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]); // the old key, unwrapped once
    await x.base.delete(A);
    await x.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(x.storage, { ...A, generation: 0 }, [7, HI + 7, 2 * HI + 7], {
      registry: x.base,
      keystore: x.keystore,
    });
    x.clock.advance(TTL);
    x.reset();
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1, 2]);
    expect(remainder0(await x.source.getChunk({ ...A, chunkKey: 0 }))).toBe(7);
    expect(x.unwraps()).toBe(1);
    expect(x.sent()).toMatchObject({ rows: 1, tails: 1 });
  });

  it('a registry that answers NotFoundError fails the generation lookup at once: one row read, no retry', async () => {
    const x = await world();
    x.rows.state.fail = new NotFoundError('the row read was refused as not found');
    x.reset();
    await expect(x.source.currentGeneration(A)).rejects.toBeInstanceOf(NotFoundError);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it.each([
    ['listChunkKeys', (x: World) => x.source.listChunkKeys(A)],
    ['summary', (x: World) => x.source.summary(A)],
    ['currentVersion', (x: World) => x.source.currentVersion(A)],
  ] as const)(
    'a read that can open the object, %s, resolves once more on a NotFoundError from the registry, as on a swept generation',
    async (_, read) => {
      const x = await world();
      x.rows.state.down = new NotFoundError('the row read was refused as not found');
      x.reset();
      await expect(read(x)).rejects.toBeInstanceOf(NotFoundError);
      expect(x.sent()).toEqual({ rows: 2, tails: 0, ranges: 0 });
    },
  );

  it('a read that finds its generation swept drops the snapshot and the resolution, resolves afresh, and reads once more', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo();
    // Another process loads and sweeps the generation the kept resolution names.
    await x.publish(A, 1, [3, HI + 3]);
    await x.storage.delete({ ...A, generation: 0 });
    x.reset();
    const before = x.resolution(A);
    expect(remainder0(await x.source.getChunk({ ...A, chunkKey: 0 }))).toBe(3);
    expect(x.sent().rows).toBe(1);
    expect(x.resolution(A)).not.toBe(before);
    expect(await x.source.currentGeneration(A)).toBe(1);
  });

  it('a read that finds its generation swept drops every snapshot on the resolution it read through: another read built a second one meanwhile', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo(); // `a`'s resolution is kept
    // Another process loads and sweeps the generation the kept resolution names.
    await x.publish(A, 1, [3, HI + 3]);
    await x.storage.delete({ ...A, generation: 0 });
    const tail = x.holdNextTail();
    const first = x.source.listChunkKeys(A); // a snapshot on the kept resolution, its open held at the tail read
    await tail.reached;
    await x.letAGo(); // the reader cache lets that snapshot go
    expect(await x.source.currentGeneration(A)).toBe(0); // a second snapshot on the same resolution, which opens nothing
    tail.release(); // the open meets the swept generation
    expect(await first).toEqual([0, 1]); // the heal resolves afresh rather than opening the second snapshot's
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(remainder0(await x.source.getChunk({ ...A, chunkKey: 0 }))).toBe(3);
  });

  it('a refresh that fails transiently, with the reader still open, keeps serving it and asks again after the retry interval', async () => {
    const x = await world();
    await x.open(A); // the reader cache holds `a`'s reader
    x.clock.advance(TTL);
    await x.publish(A, 1, [3, HI + 3]);
    x.rows.state.fail = new TransientError('throttled');
    x.reset();
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]);
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    x.clock.advance(REFRESH_RETRY_MS - 1);
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(1);
    x.clock.advance(1);
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(x.sent().rows).toBe(2);
  });

  it('a refresh that fails transiently, with the reader let go and the resolution lapsed, fails as a cold resolve does', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo(); // the reader is gone; the resolution is kept, and lapses below
    x.clock.advance(TTL);
    x.rows.state.fail = new TransientError('throttled');
    x.reset();
    await expect(x.source.listChunkKeys(A)).rejects.toBeInstanceOf(TransientError);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    // The registry answers again: the next read reads the row.
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(2);
  });

  it("another store's crypto-shred, then a registry that fails transiently: a store whose reader was let go serves nothing of the segment", async () => {
    const x = await world({ encrypted: true });
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]);
    await x.letAGo();
    const shred = await destroySegment(A, { registry: x.base }, { confirmSegment: 'a' });
    expect(shred).toMatchObject({ destroyed: true, cryptoShredded: true });
    x.clock.advance(TTL);
    x.rows.state.fail = new TransientError('throttled');
    x.reset();
    // The kept resolution still holds the wrapped keys the row no longer has: it must not be read from.
    await expect(x.source.getChunk({ ...A, chunkKey: 0 })).rejects.toBeInstanceOf(TransientError);
    expect(x.unwraps()).toBe(0);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    // Once the registry answers, the segment reads empty.
    expect(await x.source.getChunk({ ...A, chunkKey: 0 })).toBeNull();
    expect(x.unwraps()).toBe(0);
  });

  it("another store's crypto-shred, then a registry outage: the reader still open rides it out, and once the reader cache lets it go the segment serves nothing more", async () => {
    const x = await world({ encrypted: true });
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]); // `a`'s reader is open, and holds its key
    await destroySegment(A, { registry: x.base }, { confirmSegment: 'a' });
    x.clock.advance(TTL);
    x.rows.state.down = new TransientError('throttled');
    x.reset();
    // A read every 250 ms for 10 s, and the reader cache made to let `a` go every 500 ms (a read of `b`, which fails).
    const outcomes: string[] = [];
    for (let step = 0; step < 40; step++) {
      if (step > 0) x.clock.advance(250);
      if (step % 2 === 1) await x.letAGo().catch(() => undefined);
      try {
        expect(remainder0(await x.source.getChunk({ ...A, chunkKey: 0 }))).toBe(1);
        outcomes.push('served');
      } catch (err) {
        outcomes.push(err instanceof TransientError ? 'transient' : String(err));
      }
    }
    // The first read is served by the reader the cache still holds, and every read after it let that reader go fails,
    // as a cold resolve does: no key is unwrapped again from the wrapped keys the row no longer has.
    expect(outcomes).toEqual(['served', ...Array<string>(39).fill('transient')]);
    expect(x.unwraps()).toBe(0);
    x.rows.state.down = undefined;
    expect(await x.source.getChunk({ ...A, chunkKey: 0 })).toBeNull();
  });

  it("a crypto-shred, then a refresh in flight when the reader cache lets the segment go: the read that comes after it does not join the refresh's ride-out", async () => {
    const x = await world({ encrypted: true });
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]);
    await destroySegment(A, { registry: x.base }, { confirmSegment: 'a' });
    x.clock.advance(TTL);
    const held = x.rows.holdNext();
    const first = x.source.getChunk({ ...A, chunkKey: 0 }); // the refresh, held at the registry
    await held.reached;
    x.rows.state.down = new TransientError('throttled');
    await x.letAGo().catch(() => undefined); // the reader cache lets `a` go while the refresh is in flight
    x.reset();
    const second = x.source.getChunk({ ...A, chunkKey: 0 });
    second.catch(() => undefined);
    held.release(new TransientError('throttled'));
    // The read that began on the open reader is served from it; the one that began after it was let go is not.
    expect(remainder0(await first)).toBe(1);
    await expect(second).rejects.toBeInstanceOf(TransientError);
    expect(x.unwraps()).toBe(0);
    expect(
      await x.source.getChunk({ ...A, chunkKey: 0 }).catch((err: unknown) => err),
    ).toBeInstanceOf(TransientError);
  });

  it('a stream on the reader that rides out an outage re-checks once the reader cache lets it go, and fails as a cold resolve does', async () => {
    const x = await world({ encrypted: true });
    expect(await x.source.listChunkKeys(A)).toEqual([0, 1]);
    await destroySegment(A, { registry: x.base }, { confirmSegment: 'a' });
    x.clock.advance(TTL);
    x.rows.state.down = new TransientError('throttled');
    x.reset();
    const it = x.source.getChunks!(A, [0, 1], { concurrency: 1 })[Symbol.asyncIterator]();
    const head = await it.next();
    expect(remainder0(head.done ? null : head.value.bytes)).toBe(1); // the reader still open rides the outage out
    await x.letAGo().catch(() => undefined);
    await expect(it.next()).rejects.toBeInstanceOf(TransientError);
    expect(x.unwraps()).toBe(0);
  });

  it('a refresh that fails otherwise fails the read, and forgets the snapshot and the resolution', async () => {
    const x = await world();
    await x.open(A);
    x.clock.advance(TTL);
    x.rows.state.fail = new Error('access denied');
    await expect(x.source.currentGeneration(A)).rejects.toThrow('access denied');
    expect(x.resolution(A)).toBeUndefined();
    expect(inside(x.source).snapshots.peek(x.key(A))).toBeUndefined();
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(1);
  });
});

/** A resolution as these cases follow it: what it rode out from, when a refresh failed transiently. */
interface Followed {
  readonly rodeOut?: { readonly from: Followed };
}
/** A snapshot as these cases follow it: its resolution, and its reader once it has opened. */
interface Held {
  readonly resolution: Followed;
  readonly settled?: { readonly reader: object | null };
}
const held = (x: World): Held => inside(x.source).snapshots.peek(x.key(A)) as Held;

/** How many of `refs` still reach an object after a full collection. */
async function alive(refs: readonly WeakRef<object>[]): Promise<number> {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  // A WeakRef keeps its target until the job that made it ends: collect on a later turn, twice.
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

describe('a refresh keeps nothing of what it replaced alive', () => {
  it('2,000 refreshes that find the same generation leave one snapshot alive, the one the reader cache holds', async () => {
    const x = await world();
    await x.open(A);
    const snapshots: WeakRef<object>[] = [];
    for (let i = 0; i < 2_000; i++) {
      x.clock.advance(TTL);
      await x.open(A);
      snapshots.push(new WeakRef(held(x)));
    }
    expect(await alive(snapshots)).toBe(1);
    expect(snapshots.at(-1)!.deref()).toBe(held(x)); // control: the one alive is the one the reader cache holds
  });

  it('200 refreshes, each finding a new load, leave one snapshot and one reader alive', async () => {
    const x = await world();
    await x.open(A);
    const snapshots: WeakRef<object>[] = [];
    const readers: WeakRef<object>[] = [];
    for (let g = 1; g <= 200; g++) {
      await x.publish(A, g, [g, HI + g]);
      x.clock.advance(TTL);
      expect(await x.source.currentGeneration(A)).toBe(g);
      await x.open(A);
      const snap = held(x);
      snapshots.push(new WeakRef(snap));
      readers.push(new WeakRef(snap.settled!.reader!));
    }
    expect(await alive(snapshots)).toBe(1);
    expect(await alive(readers)).toBe(1);
    expect(readers.at(-1)!.deref()).toBe(held(x).settled!.reader); // control: the reader the cache holds
  });
});

describe('the TTL counts from the instant the registry read is sent', () => {
  it('a slow registry read that answers late does not extend the life of what it found', async () => {
    const x = await world();
    const held = x.rows.holdNext();
    const first = x.source.currentGeneration(A); // sent at 0
    await held.reached;
    x.clock.advance(TTL - 10); // the answer arrives at TTL - 10
    held.release();
    expect(await first).toBe(0);
    await x.publish(A, 1, [3, HI + 3]);
    x.clock.advance(9);
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(0); // TTL - 1 after the send
    expect(x.sent().rows).toBe(0);
    x.clock.advance(1);
    expect(await x.source.currentGeneration(A)).toBe(1); // TTL after the send, 10 ms after the answer
    expect(x.sent().rows).toBe(1);
  });

  it('a reopen, and a read that finds the resolution, leave its age as it was', async () => {
    const x = await world();
    await x.open(A); // the row read is sent at 0
    x.clock.advance(TTL / 2);
    await x.letAGo();
    await x.open(A);
    expect(await x.source.currentGeneration(A)).toBe(0);
    await x.publish(A, 1, [3, HI + 3]);
    x.clock.advance(TTL / 2);
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(x.sent().rows).toBe(1);
  });
});

describe('the bound: 8 x readerMax entries and readerMaxBytes / 16 bytes', () => {
  /**
   * A source over a registry that answers every name with one row, so a fleet resolves with no object written for it;
   * `bounds` sizes the reader cache from that row.
   */
  async function fleet(
    bounds: (row: RegistryRecord) => { readerMax: number; readerMaxBytes?: number },
  ) {
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(new MemoryStorageDriver(), { ...A, generation: 0 }, [1, HI + 1], {
      registry,
    });
    const row = (await registry.get(A))!;
    const every = new Proxy(registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return typeof value === 'function' ? value.bind(t) : value;
        return async () => row;
      },
    });
    const { readerMax, readerMaxBytes } = bounds(row);
    const source = new CrbmStorageChunkSource(new MemoryStorageDriver(), {
      registry: every,
      clock: manualClock(),
      currentGenTtlMs: TTL,
      maxOpenSegments: readerMax,
      ...(readerMaxBytes === undefined ? {} : { maxOpenIndexBytes: readerMaxBytes }),
    });
    return { source, cache: inside(source).resolutions! };
  }
  const weightOf = (row: RegistryRecord): number =>
    256 +
    JSON.stringify(row.summary).length +
    (row.wrappedDeks === undefined ? 0 : JSON.stringify(row.wrappedDeks).length);

  it('a fleet read once each never holds more than 8 x readerMax resolutions', async () => {
    const { source, cache } = await fleet(() => ({ readerMax: 4 }));
    for (let i = 0; i < 2_000; i++) {
      // A count is answered from the row: no object is read.
      expect((await source.summary({ namespace: NS, segment: `s${i}` }))?.cardinality).toBe(2);
      expect(cache.size).toBeLessThanOrEqual(32);
    }
    expect(cache.size).toBe(32);
  });

  it('nor more than readerMaxBytes / 16 bytes', async () => {
    let ceiling = 0;
    const { source, cache } = await fleet((row) => {
      ceiling = 5 * weightOf(row);
      return { readerMax: 1_000, readerMaxBytes: 16 * ceiling };
    });
    for (let i = 0; i < 200; i++) {
      await source.summary({ namespace: NS, segment: `s${i}` });
      expect(cache.weightBytes).toBeLessThanOrEqual(ceiling);
    }
    expect(cache.size).toBe(5);
    expect(cache.weightBytes).toBe(ceiling);
  });

  it('an entry weighs 256 bytes and its summary and wrapped keys as JSON', async () => {
    const x = await world({ encrypted: true });
    await x.source.summary(A);
    const row = (await x.base.get(A))!;
    expect(row.wrappedDeks?.length).toBeGreaterThan(0);
    expect(inside(x.source).resolutions!.weightBytes).toBe(weightOf(row));
  });

  it('at the default settings the count binds first for segments without metadata, the bytes with metadata', async () => {
    // What the sizing guide says of the defaults: the average entry at which the count stops binding first.
    const share =
      DEFAULT_MAX_OPEN_INDEX_BYTES /
      RESOLUTION_BYTES_DIVISOR /
      (RESOLUTIONS_PER_OPEN_SEGMENT * DEFAULT_MAX_OPEN_SEGMENTS);
    expect(share).toBe(512);
    // A wide segment at a high generation number, so its summary's numbers are long ones.
    const ids = Array.from({ length: 2_000 }, (_, c) => c * HI + 1);
    for (const [encrypted, metadata, over] of [
      [false, undefined, false],
      [true, undefined, false],
      [false, { def: 'x'.repeat(300) }, true],
      [true, { def: 'x'.repeat(300) }, true],
    ] as const) {
      const registry = new MemoryRegistryDriver();
      const storage = new MemoryStorageDriver();
      const keystore = encrypted
        ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
        : undefined;
      await bulkLoadCrbmGeneration(storage, { ...A, generation: 123_456 }, ids, {
        registry,
        keystore,
        ...(metadata === undefined ? {} : { metadata }),
      });
      const source = new CrbmStorageChunkSource(storage, {
        registry,
        clock: manualClock(),
        ...(keystore === undefined ? {} : { keystore }),
      });
      expect((await source.summary(A))?.cardinality).toBe(ids.length);
      const weight = inside(source).resolutions!.weightBytes;
      expect(
        weight > share,
        `encrypted ${encrypted}, metadata ${metadata !== undefined}: ${weight}`,
      ).toBe(over);
    }
  });

  it('an entry heavier than the byte ceiling is kept alone, as the reader cache keeps one', async () => {
    // A ceiling of 100 bytes, which no entry fits.
    const x = await world({ readerMax: 10, readerMaxBytes: 1_600 });
    await x.source.currentGeneration(A);
    expect(inside(x.source).resolutions!.size).toBe(1);
    await x.source.currentGeneration(B);
    expect(inside(x.source).resolutions!.size).toBe(1);
    expect(x.resolution(B)).toBeDefined();
    expect(x.resolution(A)).toBeUndefined();
  });
});

describe('the version and the generation answer from the resolution', () => {
  it('without opening the object, and the version is the one the opened reader names', async () => {
    const x = await world();
    x.reset();
    const version = await x.source.currentVersion(A);
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    await x.open(A);
    expect(x.sent().tails).toBe(1);
    expect(await x.source.currentVersion(A)).toBe(version);
    // and after the reader is let go, from the kept resolution again
    await x.letAGo();
    x.reset();
    expect(await x.source.currentVersion(A)).toBe(version);
    expect(x.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
  });

  it('a row with no summary it can use names no object: the version opens it, as before', async () => {
    const x = await world();
    x.rows.state.tamper = (row) => ({ ...row, summary: undefined });
    x.reset();
    const version = await x.source.currentVersion(A);
    expect(x.sent()).toEqual({ rows: 1, tails: 1, ranges: 0 });
    await x.letAGo();
    x.reset();
    expect(await x.source.currentVersion(A)).toBe(version);
    expect(x.sent()).toEqual({ rows: 0, tails: 1, ranges: 0 });
  });
});
