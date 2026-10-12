/**
 * What a read of a wide segment asks of the chunk cache and of the source when its stream opens, held to the scan the
 * engine made when it looked every later key up at open: the same key list reaches the source, each key is counted
 * once as a hit or a miss, and a chunk the cache held at open is looked up again when it is asked for. Every case
 * runs the real engine over a source that records the streams it is asked to open, with a cache that records its
 * lookups, and compares with a copy of that earlier scan.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SegmentEngine, BoundedLru } from '@cloudbitmaps/core';
import type { CodecBitmap, IMetricsSink, MetricEvent } from '@cloudbitmaps/core';
import { chunkGenKey } from '@/core/keys';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

const clock = { now: () => 0 };
const WIDE = 120;
const keysOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 3 + 1);
const ids = (chunks: readonly number[]): number[] =>
  chunks.flatMap((c) => [joinId(c, 1), joinId(c, 2)]);

/** A cache that records the key of every lookup. */
class SpyLru extends BoundedLru<string, CodecBitmap> {
  readonly gets: string[] = [];
  override get(key: string): CodecBitmap | undefined {
    this.gets.push(key);
    return super.get(key);
  }
}

class Events implements IMetricsSink {
  readonly cache: boolean[] = [];
  onEvent(event: MetricEvent): void {
    if (event.kind === 'cache') this.cache.push(event.hit);
  }
}

function setup(segments: Record<string, readonly number[]>) {
  const storage = new StreamChunkSource();
  for (const [name, chunks] of Object.entries(segments)) seedSegment(storage, name, ids(chunks));
  const cache = new SpyLru({ maxEntries: 10_000, clock });
  const events = new Events();
  const engine = new SegmentEngine({ storage, codec: roaringCodec, cache, metrics: events });
  return { storage, engine, cache, events };
}

/**
 * The scan the engine made at open, copied: from the first chunk the cache did not hold, every later key is looked
 * up and counted, and the stream carries the first miss and the later misses.
 */
function scanAtOpen(keys: readonly number[], held: ReadonlySet<number>) {
  const from = keys.find((k) => !held.has(k));
  if (from === undefined) return undefined;
  const wanted = keys.slice(keys.indexOf(from));
  const misses = [from];
  const counted: boolean[] = [];
  for (let i = 1; i < wanted.length; i++) {
    const hit = held.has(wanted[i]!);
    if (!hit) misses.push(wanted[i]!);
    counted.push(hit);
  }
  return { from, misses, counted };
}

/** Warm every chunk of `name`, then drop all but `kept` from the cache; counters start again. */
async function warmThenKeep(
  env: ReturnType<typeof setup>,
  names: readonly string[],
  kept: ReadonlySet<number>,
  keys: readonly number[],
) {
  for (const name of names) await collect(env.engine.iterate({ segment: name }));
  for (const name of names) {
    for (const k of keys) {
      if (!kept.has(k)) env.cache.delete(chunkGenKey({ segment: name, chunkKey: k }, 'v1'));
    }
  }
  env.cache.gets.length = 0;
  env.events.cache.length = 0;
  env.storage.opened.length = 0;
}

const heldSets = fc
  .array(fc.boolean(), { minLength: WIDE, maxLength: WIDE })
  .map((flags) => new Set(keysOf(WIDE).filter((_, i) => flags[i])));
const sparse = fc
  .array(fc.integer({ min: 0, max: WIDE - 1 }), { maxLength: 6 })
  .map((at) => new Set(at.map((i) => keysOf(WIDE)[i]!)));
const held = fc.oneof({ weight: 3, arbitrary: heldSets }, { weight: 2, arbitrary: sparse });

describe('a full iterate of a wide segment', () => {
  it('opens its stream over the first miss and the later misses, counts each key once, and looks held keys up again', async () => {
    await fc.assert(
      fc.asyncProperty(held, async (kept) => {
        const keys = keysOf(WIDE);
        const env = setup({ a: keys });
        await warmThenKeep(env, ['a'], kept, keys);
        expect(await collect(env.engine.iterate({ segment: 'a' }))).toEqual(ids(keys));

        const scan = scanAtOpen(keys, kept);
        expect(env.storage.opened.map((o) => [...o.keys])).toEqual(scan ? [scan.misses] : []);
        // One event per key, as the keys before the first miss are asked for, then the first miss, then the
        // later ones as the scan counts them.
        const before = scan ? keys.indexOf(scan.from) : keys.length;
        expect(env.events.cache).toEqual([
          ...Array.from({ length: before }, () => true),
          ...(scan ? [false, ...scan.counted] : []),
        ]);
        // A key the cache held when the stream opened is looked up when asked for: twice if it came after the
        // first miss (the scan, then its turn), once if before it. A cache holding nothing is not asked.
        const asked = new Map<string, number>();
        for (const key of env.cache.gets) asked.set(key, (asked.get(key) ?? 0) + 1);
        const expected = new Map<string, number>();
        for (const [i, k] of keys.entries()) {
          const name = chunkGenKey({ segment: 'a', chunkKey: k }, 'v1');
          const laterThanMiss = scan !== undefined && i > keys.indexOf(scan.from);
          const lookups = !laterThanMiss ? 1 : kept.size === 0 ? 0 : kept.has(k) ? 2 : 1;
          if (lookups > 0) expected.set(name, lookups);
        }
        expect(asked).toEqual(expected);
      }),
      { numRuns: 60 },
    );
  });

  it('reads a warm segment without opening a stream, one hit a key', async () => {
    const keys = keysOf(WIDE);
    const env = setup({ a: keys });
    await warmThenKeep(env, ['a'], new Set(keys), keys);
    await collect(env.engine.iterate({ segment: 'a' }));
    expect(env.storage.opened).toEqual([]);
    expect(env.events.cache).toEqual(keys.map(() => true));
    expect(env.cache.gets).toHaveLength(WIDE);
  });

  it('on a cold cache looks up the chunk asked for, counts every key a miss once, and carries every key', async () => {
    const keys = keysOf(WIDE);
    const env = setup({ a: keys });
    expect(await collect(env.engine.iterate({ segment: 'a' }))).toEqual(ids(keys));
    expect(env.storage.opened.map((o) => [...o.keys])).toEqual([keys]);
    expect(env.events.cache).toEqual(keys.map(() => false));
  });
});

describe('an iterate that stops', () => {
  it('opens the same stream over the same keys, or none if it stops before the first miss', async () => {
    await fc.assert(
      fc.asyncProperty(held, fc.integer({ min: 1, max: 2 * WIDE }), async (kept, n) => {
        const keys = keysOf(WIDE);
        const env = setup({ a: keys });
        await warmThenKeep(env, ['a'], kept, keys);
        const seen: number[] = [];
        for await (const id of env.engine.iterate({ segment: 'a' })) {
          seen.push(id);
          if (seen.length === n) break;
        }
        expect(seen).toEqual(ids(keys).slice(0, n));

        const scan = scanAtOpen(keys, kept);
        const opened = env.storage.opened.map((o) => [...o.keys]);
        const reached = scan !== undefined && Math.floor((n - 1) / 2) >= keys.indexOf(scan.from);
        if (reached) expect(opened).toEqual([scan.misses]);
        else
          expect(
            opened.length === 0 || (scan !== undefined && opened[0]!.join() === scan.misses.join()),
          ).toBe(true);
        if (opened.length > 0) {
          // From the first miss on, the events are the miss and the scan's own, every key counted once.
          const at = env.events.cache.indexOf(false);
          expect(env.events.cache.slice(at)).toEqual([false, ...scan!.counted]);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('an intersect of two wide segments', () => {
  it('opens each operand over its own misses and counts each key of each once', async () => {
    await fc.assert(
      fc.asyncProperty(held, held, async (keptA, keptB) => {
        const keys = keysOf(WIDE);
        const env = setup({ a: keys, b: keys });
        await warmThenKeep(env, ['a', 'b'], new Set(), keys);
        // `warmThenKeep` leaves the cache with nothing; put each operand's own held chunks back by reading them.
        for (const [name, kept] of [
          ['a', keptA],
          ['b', keptB],
        ] as const) {
          for (const k of kept) {
            await collect(
              env.engine.iterate(
                { segment: name },
                { after: joinId(k, 0), through: joinId(k, 0xffff) },
              ),
            );
          }
        }
        env.cache.gets.length = 0;
        env.events.cache.length = 0;
        env.storage.opened.length = 0;
        expect(await collect(env.engine.intersect([{ segment: 'a' }, { segment: 'b' }]))).toEqual(
          ids(keys),
        );
        for (const [name, kept] of [
          ['a', keptA],
          ['b', keptB],
        ] as const) {
          const scan = scanAtOpen(keys, kept);
          const mine = env.storage.opened.filter((o) => o.segment === name).map((o) => [...o.keys]);
          expect(mine).toEqual(scan ? [scan.misses] : []);
        }
        expect(env.events.cache).toHaveLength(2 * WIDE);
        expect(env.events.cache.filter(Boolean)).toHaveLength(keptA.size + keptB.size);
      }),
      { numRuns: 30 },
    );
  });
});
