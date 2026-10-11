import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { BoundedLru, SegmentEngine, ValidationError } from '@cloudbitmaps/core';
import type { ChunkRead, CodecBitmap, ReadChunksOptions, SegmentRef } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';
import { REMEMBERED_INVALIDATIONS } from '@/core/invalidation-scope';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

/**
 * A read the caller stops pulling without closing holds nothing in the engine.
 *
 * `await seg.iterate().next()` takes a first id and drops the iterator, and a `Promise.race` timeout around a pull does
 * the same: the generator's `finally` never runs. Whatever the engine kept for an open stream until then (its key list,
 * and through its chunk stream the source's suspended generator with the ranges it had landed) would be kept for the
 * engine's life, one per abandoned read, with no bound (invariant 6). So an invalidation reaches open streams through
 * a record the streams consult, not a registry of the streams, and that record is bounded too.
 */
const clock = { now: () => 0 };
const C = 65_536;
const CHUNKS = 200;
const ABANDONED = 50;
const s: SegmentRef = { segment: 's' };

/** A streaming source that remembers, weakly, every stream it hands out. */
class RecordingSource extends StreamChunkSource {
  readonly handed = new WeakSet<object>();
  readonly refs: Array<WeakRef<object>> = [];

  override getChunks(
    ref: SegmentRef,
    keys: readonly number[],
    options?: ReadChunksOptions,
  ): AsyncGenerator<ChunkRead> {
    const stream = super.getChunks(ref, keys, options);
    this.handed.add(stream);
    this.refs.push(new WeakRef(stream));
    return stream;
  }
}

function setup() {
  const source = new RecordingSource();
  seedSegment(
    source,
    's',
    Array.from({ length: CHUNKS }, (_, c) => joinId(c, 1)),
  );
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 10_000, clock });
  const engine = new SegmentEngine({ storage: source, codec: roaringCodec, cache });
  return { source, cache, engine };
}

/**
 * Start `n` reads, each at a chunk of its own so each opens a stream, pull one id from each, and drop them. In a
 * function of its own, so no iterator is left in the caller's frame.
 */
async function abandon(engine: SegmentEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const it = engine.iterate(s, { after: (i + 1) * C - 1 })[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(joinId(i + 1, 1));
  }
}

/**
 * How many objects reachable from `root` through its properties and the entries of its maps, sets and arrays satisfy
 * `match`. A closure's captures cannot be walked, but an engine keeps no closure over a stream.
 */
function countReachable(root: object, match: (value: object) => boolean): number {
  const seen = new Set<object>();
  const queue: unknown[] = [root];
  let found = 0;
  while (queue.length > 0) {
    const value = queue.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (match(value)) found += 1;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    if (value instanceof Map) for (const [k, v] of value) queue.push(k, v);
    else if (value instanceof Set) for (const v of value) queue.push(v);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) queue.push(descriptor.value);
    }
  }
  return found;
}

describe('an abandoned read holds nothing in the engine', () => {
  it('no stream of a read pulled once and dropped is reachable from the engine', async () => {
    const { source, engine } = setup();
    await abandon(engine, ABANDONED);
    expect(source.refs).toHaveLength(ABANDONED); // each read opened a stream of its own
    expect(countReachable(engine, (v) => source.handed.has(v))).toBe(0);
  });

  it('and so a collection frees every one of them', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as (options?: { type: 'major'; execution: 'sync' }) => void;
    const { source, engine } = setup();
    await abandon(engine, ABANDONED);
    // A WeakRef's target is kept to the end of the job that made or read it, so collect across turns, until stable.
    let alive = source.refs.length;
    for (let round = 0; round < 10 && alive > 0; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc({ type: 'major', execution: 'sync' });
      alive = source.refs.filter((r) => r.deref() !== undefined).length;
    }
    expect(alive).toBe(0);
    expect(engine).toBeDefined(); // the engine itself stays alive throughout
  });
});

describe('an invalidation still reaches a stream that is open', () => {
  it('the chunks a stream delivers after its segment is invalidated are not cached', async () => {
    const { source, engine } = setup();
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(joinId(0, 1));
    engine.invalidate(s);
    for (let r = await it.next(); r.done !== true; r = await it.next());

    const before = source.singles.length;
    expect(await engine.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
    expect(source.singles.length).toBe(before + 1); // read again: the stream did not cache it
  });

  it('control: with no invalidation, the stream caches what it delivers', async () => {
    const { source, engine } = setup();
    expect(await collect(engine.iterate(s))).toHaveLength(CHUNKS);
    const before = source.singles.length;
    expect(await engine.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
    expect(source.singles.length).toBe(before);
  });

  it('an invalidation of another segment leaves an open stream caching', async () => {
    const { source, engine } = setup();
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate({ segment: 'other' });
    for (let r = await it.next(); r.done !== true; r = await it.next());

    const before = source.singles.length;
    expect(await engine.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
    expect(source.singles.length).toBe(before);
  });

  it('a segment whose invalidation the record has since let go still counts as invalidated', async () => {
    const { source, engine } = setup();
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate(s);
    for (let i = 0; i < REMEMBERED_INVALIDATIONS; i++) engine.invalidate({ segment: `o${i}` });
    for (let r = await it.next(); r.done !== true; r = await it.next());

    const before = source.singles.length;
    expect(await engine.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
    expect(source.singles.length).toBe(before + 1);
  });
});

describe('engines that share invalidations', () => {
  function shared() {
    const { source, cache, engine } = setup();
    const other = new SegmentEngine({
      storage: source,
      codec: roaringCodec,
      cache,
      sharesInvalidationsWith: engine,
    });
    return { source, cache, engine, other };
  }

  it("one engine's invalidation reaches the other's open stream", async () => {
    const { source, engine, other } = shared();
    const it = other.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate(s);
    for (let r = await it.next(); r.done !== true; r = await it.next());

    const before = source.singles.length;
    expect(await other.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
    expect(source.singles.length).toBe(before + 1);
  });

  it("one engine's invalidation reaches the other's point read in flight", async () => {
    const { source, engine, other } = shared();
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    source.beforeYield = () => {
      reached();
      return gate;
    };
    const inflight = other.has(s, joinId(7, 1));
    await arrived;
    engine.invalidate(s);
    source.beforeYield = undefined;
    release();
    expect(await inflight).toBe(true);

    const before = source.singles.length;
    expect(await other.has(s, joinId(7, 1))).toBe(true);
    expect(source.singles.length).toBe(before + 1);
  });

  it('refuses an engine over another chunk cache', () => {
    const { source, engine } = setup();
    const elsewhere = new BoundedLru<string, CodecBitmap>({ maxEntries: 10, clock });
    expect(
      () =>
        new SegmentEngine({
          storage: source,
          codec: roaringCodec,
          cache: elsewhere,
          sharesInvalidationsWith: engine,
        }),
    ).toThrow(ValidationError);
  });
});

describe('the record of invalidations is bounded', () => {
  it(`remembers at most ${REMEMBERED_INVALIDATIONS} segments, however many are invalidated`, () => {
    const { engine } = setup();
    const { latest } = (engine as unknown as { scope: { latest: Map<string, number> } }).scope;
    for (let i = 0; i < 5_000; i++) engine.invalidate({ segment: `seg${i}` });
    expect(latest.size).toBe(REMEMBERED_INVALIDATIONS);
  });
});
