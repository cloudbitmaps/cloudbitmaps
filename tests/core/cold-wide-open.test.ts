/**
 * What a read of a wide segment asks of the chunk cache and of the source when its stream opens, held to the scan the
 * engine made when it looked every later key up at open: the same key list reaches the source, each key is counted
 * once as a hit or a miss, and a chunk the cache held at open is looked up again when it is asked for. Every case
 * runs the real engine over a source that records the streams it is asked to open, with a cache that records its
 * lookups, and compares with a copy of that earlier scan.
 */
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SegmentEngine, BoundedLru } from '@cloudbitmaps/core';
import type { CodecBitmap, IMetricsSink, MetricEvent } from '@cloudbitmaps/core';
import { chunkGenKey } from '@/core/keys';
import { roaringCodec } from '@/native-codec';
import { joinId } from '@/core/bit-route';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import type { SegmentRef } from '@/index';
import type { RegistryRecord } from '@cloudbitmaps/core/driver-kit';
import { PREAMBLE_BYTES } from '@/core/crbm/format';
import { sizedTailBytes } from '@/core/crbm-open';
import { ValidationError } from '@/core/errors';
import { summaryAgrees, usableSummary } from '@/core/summary';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
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

/**
 * A cold open of a cleartext generation sizes its tail read from the `tailBytes` its row's summary records, so a
 * segment whose index is longer than the default 256 KiB tail comes in the one tail read and its cold `has()` costs
 * one range read fewer. The hint only sizes a read: it is clamped, held to the object, and never changes an answer.
 */
const DEFAULT_TAIL = 256 * 1024;
const REF: SegmentRef = { segment: 'wide' };

/** `n` distinct pseudo-random 32-bit ids, the same every run. */
function randomIds(n: number, seed = 12345): number[] {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seen = new Set<number>();
  while (seen.size < n) seen.add(Math.floor(next() * 4294967296));
  return [...seen].sort((x, y) => x - y);
}

/** `chunks` chunks of `perChunk` ids each: a wide index over small chunks. */
const spread = (chunks: number, perChunk: number): number[] =>
  Array.from(
    { length: chunks * perChunk },
    (_, i) => Math.floor(i / perChunk) * 65_536 + (i % perChunk) * 7,
  );

const WIDE_IDS = randomIds(300_000);

/**
 * The encrypted wide segment, built once, before the tests of the block that uses it: sealing 300,000 ids chunk by chunk
 * takes over a second, which a loaded runner can stretch past a test's timeout. The tests that use it only read, so each
 * one starts from `reset()` with a store of its own (a cold cache). `reset()` keeps a `hint()`, so a test on this shared
 * segment must not call one.
 */
let encryptedWide: ReturnType<typeof wideWorld> | undefined;
const encryptedWideWorld = async (): ReturnType<typeof wideWorld> => {
  const w = await (encryptedWide ??= wideWorld(WIDE_IDS, { encrypted: true }));
  w.reset();
  return w;
};

interface Seen {
  registry: number;
  tails: number;
  ranges: number;
  /** `maxBytes` of each tail read, in order. */
  tailSizes: number[];
  keystore: number;
}

async function wideWorld(ids: readonly number[], options: { encrypted?: boolean } = {}) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, ids as number[], {
    registry,
    ...(options.encrypted ? { keystore } : {}),
  });
  const seen: Seen = { registry: 0, tails: 0, ranges: 0, tailSizes: [], keystore: 0 };
  const get = registry.get.bind(registry);
  let rewrite: ((row: RegistryRecord) => RegistryRecord) | undefined;
  vi.spyOn(registry, 'get').mockImplementation(async (ref) => {
    seen.registry++;
    const row = await get(ref);
    return row !== null && rewrite !== undefined ? rewrite(row) : row;
  });
  const getTail = storage.getTail.bind(storage);
  vi.spyOn(storage, 'getTail').mockImplementation((key, max) => {
    seen.tails++;
    seen.tailSizes.push(max);
    return getTail(key, max);
  });
  const getRange = storage.getRange.bind(storage);
  vi.spyOn(storage, 'getRange').mockImplementation((key, offset, length) => {
    seen.ranges++;
    return getRange(key, offset, length);
  });
  const openDek = keystore.openDek.bind(keystore);
  vi.spyOn(keystore, 'openDek').mockImplementation((wrapped) => {
    seen.keystore++;
    return openDek(wrapped);
  });
  /** The object's size and the row's `tailBytes` (opened with the key when it is sealed), read with no counting. */
  const facts = async (): Promise<{ size: number; tailBytes: number }> => {
    const row = (await get(REF))!;
    const aead =
      row.wrappedDeks === undefined || row.wrappedDeks.length === 0
        ? undefined
        : await openDek(row.wrappedDeks);
    const described = usableSummary(REF, row, aead)!;
    return { size: Number(described.fingerprint.split(':')[0]), tailBytes: described.tailBytes };
  };
  const reset = (): void => {
    seen.registry = seen.tails = seen.ranges = seen.keystore = 0;
    seen.tailSizes.length = 0;
  };
  return {
    backend,
    storage,
    registry,
    keystore,
    seen,
    facts,
    reset,
    /** Make every row read answer with the summary's `tailBytes` replaced. */
    hint(tailBytes: number): void {
      rewrite = (row) => ({
        ...row,
        summary: { ...(row.summary as object), tailBytes } as RegistryRecord['summary'],
      });
    },
    source(extra: { maxIndexBytes?: number } = {}): CrbmStorageChunkSource {
      return new CrbmStorageChunkSource(storage, {
        registry,
        ...(options.encrypted ? { keystore } : {}),
        clock: { now: () => 0 },
        ...extra,
      });
    },
    store(cache: { readerMax?: number } = {}): CloudRoaring {
      return new CloudRoaring({
        storage: backend,
        cache,
        ...(options.encrypted ? { encryption: { keystore } } : {}),
      });
    },
  };
}

type WideWorld = Awaited<ReturnType<typeof wideWorld>>;

/** Another segment, so that a one-reader cache has to open `wide` again. */
async function crowdOut(w: WideWorld, store: CloudRoaring): Promise<void> {
  await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, [1, 2, 3], {
    registry: w.registry,
  });
  expect(await store.segment('other').has(1)).toBe(true);
}

describe('a cold open sizes its tail read from the row summary', () => {
  beforeAll(async () => {
    await encryptedWideWorld();
  }, 60_000);

  it('a cold has() of 300,000 random ids on a cleartext segment is a row, one tail and one range read', async () => {
    const w = await wideWorld(WIDE_IDS);
    const { tailBytes } = await w.facts();
    expect(tailBytes).toBeGreaterThan(DEFAULT_TAIL); // wide: the index runs past the default tail
    expect(await w.store().segment('wide').has(WIDE_IDS[1234]!)).toBe(true);
    // Measured on main: { registry: 1, tails: 1, ranges: 2 }, four requests: the row, the 256 KiB tail, the index
    // range read and the chunk.
    expect({ registry: w.seen.registry, tails: w.seen.tails, ranges: w.seen.ranges }).toEqual({
      registry: 1,
      tails: 1,
      ranges: 1,
    });
    expect(w.seen.tailSizes).toEqual([tailBytes]);
  });

  it('an encrypted segment is opened as before: the default tail beside the key, then the index range read', async () => {
    const w = await encryptedWideWorld();
    expect(await w.store().segment('wide').has(WIDE_IDS[1234]!)).toBe(true);
    // The same on main, measured: the encrypted open is not sized, so it keeps its overlap and its range read.
    expect({
      registry: w.seen.registry,
      tails: w.seen.tails,
      ranges: w.seen.ranges,
      keystore: w.seen.keystore,
    }).toEqual({ registry: 1, tails: 1, ranges: 2, keystore: 1 });
    expect(w.seen.tailSizes).toEqual([DEFAULT_TAIL]);
  });

  it('answers the same whatever the summary says', async () => {
    // One segment serves every hint: `hint` only rewrites what the row read answers, and each store starts cold.
    const w = await wideWorld(WIDE_IDS);
    const real = (await w.facts()).tailBytes;
    for (const hint of [PREAMBLE_BYTES + 100, 1000, real - 1, real + 1, real * 2]) {
      w.hint(hint);
      const store = w.store();
      expect(await store.segment('wide').has(WIDE_IDS[777]!), `hint ${hint}`).toBe(true);
      expect(await store.segment('wide').has(WIDE_IDS[777]! + 1), `hint ${hint}`).toBe(false);
    }
  });

  it('a hint too small costs two range reads and answers right', async () => {
    for (const small of [1000, 300 * 1024]) {
      const w = await wideWorld(WIDE_IDS);
      expect(small).toBeLessThan((await w.facts()).tailBytes);
      w.hint(small);
      expect(await w.store().segment('wide').has(WIDE_IDS[99]!)).toBe(true);
      expect(w.seen.ranges, `hint ${small}`).toBe(2);
      // Never below the default tail.
      expect(w.seen.tailSizes).toEqual([Math.max(DEFAULT_TAIL, small)]);
    }
  });

  it('a hint too large asks for no more than the object holds, and answers right', async () => {
    const w = await wideWorld(WIDE_IDS);
    const { size, tailBytes } = await w.facts();
    const largest = size - PREAMBLE_BYTES;
    expect(largest).toBeGreaterThan(tailBytes);
    w.hint(largest);
    expect(await w.store().segment('wide').has(WIDE_IDS[5]!)).toBe(true);
    expect(w.seen.tailSizes).toEqual([largest]);
  });

  it('a hostile hint is clamped to the object and to the source index bound, and nonsense is ignored', () => {
    const fp = (size: number) => `${size}:12345`;
    const size = 2_000_000;
    // 2^31: no more than the object less its preamble.
    expect(sizedTailBytes({ fingerprint: fp(size), tailBytes: 2 ** 31 }, {})).toBe(
      size - PREAMBLE_BYTES,
    );
    // And never more than the index bound plus the extension block, its trailer and the footer.
    expect(sizedTailBytes({ fingerprint: fp(2 ** 40), tailBytes: 2 ** 31 }, {})).toBe(8_392_820);
    expect(
      sizedTailBytes({ fingerprint: fp(2 ** 40), tailBytes: 2 ** 31 }, { maxIndexBytes: 1 << 20 }),
    ).toBe(1_052_788);
    // Nonsense is the source's own tail, never a sized read.
    for (const tailBytes of [-5, 0, Number.NaN, Infinity, 1000.5, 2 ** 53]) {
      expect(sizedTailBytes({ fingerprint: fp(size), tailBytes }, {}), String(tailBytes)).toBe(
        DEFAULT_TAIL,
      );
    }
    // Never below the source's own tail, whatever the hint.
    expect(sizedTailBytes({ fingerprint: fp(size), tailBytes: 500 }, {})).toBe(DEFAULT_TAIL);
    expect(sizedTailBytes({ fingerprint: fp(size), tailBytes: 500 }, { tailBytes: 4096 })).toBe(
      4096,
    );
    expect(sizedTailBytes({ fingerprint: fp(size), tailBytes: 9_000 }, { tailBytes: 4096 })).toBe(
      9_000,
    );
    expect(sizedTailBytes(undefined, { tailBytes: 4096 })).toBe(4096);
    expect(sizedTailBytes(undefined, {})).toBe(DEFAULT_TAIL);
    expect(sizedTailBytes({ fingerprint: 'not a fingerprint', tailBytes: 9_000_000 }, {})).toBe(
      DEFAULT_TAIL,
    );
  });

  it('a registry of your own that hands over 2^31 costs the default tail, and the answer is right', async () => {
    const w = await wideWorld(WIDE_IDS);
    w.hint(2 ** 31);
    expect(await w.store().segment('wide').has(WIDE_IDS[42]!)).toBe(true);
    expect(w.seen.tailSizes).toEqual([DEFAULT_TAIL]);
  });

  it('a source with maxIndexBytes of 1 MiB clamps a large hint to 1 MiB + 4,212 B', async () => {
    const w = await wideWorld(spread(40_000, 60));
    const { size, tailBytes } = await w.facts();
    expect(tailBytes).toBeLessThan(1024 * 1024);
    expect(size - PREAMBLE_BYTES).toBeGreaterThan(1024 * 1024 + 4212);
    w.hint(size - PREAMBLE_BYTES);
    const source = w.source({ maxIndexBytes: 1024 * 1024 });
    expect(await source.getChunk({ ...REF, chunkKey: 3 })).not.toBeNull();
    expect(w.seen.tailSizes).toEqual([1024 * 1024 + 4212]);
  });

  it("a distrusted summary's hint is not used: the next open of the generation reads the default tail", async () => {
    const w = await wideWorld(WIDE_IDS);
    const { tailBytes } = await w.facts();
    w.hint(tailBytes + 4096); // a wrong tailBytes: the object disagrees
    const store = w.store({ readerMax: 1 });
    expect(await store.segment('wide').has(WIDE_IDS[10]!)).toBe(true);
    expect(w.seen.tailSizes).toEqual([tailBytes + 4096]); // believed once
    await crowdOut(w, store);
    w.reset();
    expect(await store.segment('wide').has(WIDE_IDS[11]!)).toBe(true);
    expect(w.seen.tailSizes).toEqual([DEFAULT_TAIL]);
  });

  it('a summary that agrees is believed at every open', async () => {
    const w = await wideWorld(WIDE_IDS);
    const { tailBytes } = await w.facts();
    const store = w.store({ readerMax: 1 });
    await store.segment('wide').has(WIDE_IDS[10]!);
    await crowdOut(w, store);
    w.reset();
    await store.segment('wide').has(WIDE_IDS[11]!);
    expect(w.seen.tailSizes).toEqual([tailBytes]);
  });

  it('a cleartext row with no usable summary opens a cold has() with the default tail and two range reads', async () => {
    const w = await wideWorld(WIDE_IDS);
    const row = (await w.registry.get(REF))!;
    await w.registry.compareAndSwap(REF, row.token, { summary: undefined });
    expect((await w.registry.get(REF))!.summary).toBeUndefined();
    w.reset();
    expect(await w.store().segment('wide').has(WIDE_IDS[3]!)).toBe(true);
    expect(w.seen.tailSizes).toEqual([DEFAULT_TAIL]);
    expect(w.seen.ranges).toBe(2);
  });

  it.each([Number.NaN, 400_000.5, 0, -1, Infinity])(
    'a source refuses a maxIndexBytes of %s, and a sized read never takes it from sizedTailBytes',
    async (maxIndexBytes) => {
      const w = await wideWorld(spread(10, 3));
      expect(() => w.source({ maxIndexBytes })).toThrow(ValidationError);
      expect(() => w.source({ maxIndexBytes })).toThrow(/maxIndexBytes must be an integer/);
      // Handed straight to the sizing, a bad bound is the source's own tail, never an invalid read.
      expect(
        sizedTailBytes({ fingerprint: '3000000:12345', tailBytes: 500_000 }, { maxIndexBytes }),
      ).toBe(maxIndexBytes === Infinity ? 500_000 : DEFAULT_TAIL);
    },
  );

  it('a store tail size that is not a whole number is left as it is, so its read fails on every segment, as unsized', () => {
    for (const tailBytes of [1000.5, Number.NaN]) {
      expect(
        sizedTailBytes({ fingerprint: '3000000:12345', tailBytes: 500_000 }, { tailBytes }),
      ).toBe(tailBytes);
    }
  });

  it('summaryAgrees holds tailBytes to the object when both say one', () => {
    const base = { cardinality: 3 };
    expect(summaryAgrees({ ...base, tailBytes: 900 }, { ...base, tailBytes: 900 })).toBe(true);
    expect(summaryAgrees({ ...base, tailBytes: 900 }, { ...base, tailBytes: 901 })).toBe(false);
    expect(summaryAgrees({ ...base, tailBytes: 900 }, base)).toBe(true);
    expect(summaryAgrees(base, { ...base, tailBytes: 900 })).toBe(true);
  });

  it('checkConsistency({ summaries: true }) sizes its open the same way, and reports a wrong tailBytes', async () => {
    const w = await wideWorld(WIDE_IDS);
    const { tailBytes } = await w.facts();
    const report = await w.store().checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([]);
    expect(w.seen.tailSizes.filter((n) => n > 0)).toEqual([tailBytes]);
    expect(w.seen.ranges).toBe(0);
    w.hint(tailBytes + 8);
    const wrong = await w.store().checkConsistency({ summaries: true });
    expect(wrong.inconsistent).toEqual([
      { segment: 'wide', currentGen: 0, issue: 'summary-mismatch' },
    ]);
  });

  it("an encrypted segment's consistency open waits for the key before its tail read, and is sized", async () => {
    const w = await encryptedWideWorld();
    const { tailBytes } = await w.facts();
    const report = await w.store().checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([]);
    expect(w.seen.ranges).toBe(0);
    expect(w.seen.keystore).toBe(1);
    expect(w.seen.tailSizes.filter((n) => n > 0)).toEqual([tailBytes]);
  });
});
