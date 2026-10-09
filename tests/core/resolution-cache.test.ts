vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
import { randomBytes } from 'node:crypto';
import { CrbmStorageChunkSource, InProcessKeystore, TransientError } from '@/index';
import type { Clock, IKeystore, SegmentRef } from '@/index';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IRegistryDriver, IStorageDriver, RegistryRecord } from '@/core/ports';
import type { BoundedLru } from '@/core/lru';
import { REFRESH_RETRY_MS } from '@/core/reader-defaults';
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

/**
 * A registry whose row reads are counted, and the next of which can be held after it has read the row (it answers what
 * the row was when it was sent), or failed.
 */
function scripted(base: IRegistryDriver) {
  const state = {
    reads: 0,
    hold: undefined as { reached: () => void; gate: Promise<void> } | undefined,
    fail: undefined as Error | undefined,
    tamper: (row: RegistryRecord): RegistryRecord => row,
  };
  const registry = new Proxy(base, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return typeof value === 'function' ? value.bind(t) : value;
      return async (ref: SegmentRef) => {
        state.reads += 1;
        const fail = state.fail;
        state.fail = undefined;
        if (fail !== undefined) throw fail;
        const hold = state.hold;
        state.hold = undefined;
        const row = await t.get(ref);
        if (hold !== undefined) {
          hold.reached();
          await hold.gate;
        }
        return row === null ? null : state.tamper(row);
      };
    },
  });
  /** Hold the next row read once it has read the row: `reached` settles then, and `release` lets it answer. */
  const holdNext = (): { reached: Promise<void>; release: () => void } => {
    let reached!: () => void;
    let release!: () => void;
    const r = new Promise<void>((resolve) => (reached = resolve));
    state.hold = { reached, gate: new Promise<void>((resolve) => (release = resolve)) };
    return { reached: r, release };
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
  const source = new CrbmStorageChunkSource(counting<IStorageDriver>(storage, calls), {
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
    unwraps: () => keyCalls.openDek ?? 0,
    /** Open `ref`'s reader, as a read of its shape does. */
    open: (ref: SegmentRef) => source.listChunkKeys(ref),
    /** Let `a`'s reader go: the reader cache holds one segment, and this reads another. */
    letAGo: () => source.listChunkKeys(B),
    resolution: (ref: SegmentRef) => inside(source).resolutions?.peek(segmentKey(ref)),
  };
}
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

  it('a refresh that fails transiently keeps the prior resolution, and asks again after the retry interval', async () => {
    const x = await world();
    await x.open(A);
    await x.letAGo(); // the reader is gone: the kept resolution is the prior one
    x.clock.advance(TTL);
    await x.publish(A, 1, [3, HI + 3]);
    x.rows.state.fail = new TransientError('throttled');
    x.reset();
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(1);
    x.clock.advance(REFRESH_RETRY_MS - 1);
    expect(await x.source.currentGeneration(A)).toBe(0);
    expect(x.sent().rows).toBe(1);
    x.clock.advance(1);
    expect(await x.source.currentGeneration(A)).toBe(1);
    expect(x.sent().rows).toBe(2);
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
