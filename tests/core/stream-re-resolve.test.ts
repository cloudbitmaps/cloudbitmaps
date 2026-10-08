/**
 * A running read of coalesced ranges re-resolves its segment where a read of one chunk would: when the segment is
 * erased from, rolled back, loaded over, crypto-shredded and invalidated, or published to by another store once
 * `cache.genTtlMs` has lapsed. Nothing is served from a generation after one of those has happened, beyond the chunks
 * the read had already taken.
 *
 * Each case runs the same scenario twice, once as the library reads (streams of ranges) and once with the sources made
 * to answer as a source that cannot read a range does (chunk by chunk, the read every earlier release made), and holds
 * the stream's reach to the per-key read's: what the stream yields from the stale state after the trigger is never more
 * than what the per-key read yields.
 *
 * The segments are 120 chunks of 600 ids (about 1.2 KB each): the whole object is one range, so a stream that did not
 * re-resolve would serve every remaining chunk from the range it had already read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { destroySegment } from '@/core/erasure';
import type { Clock, IMetricsSink, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { withoutRangedReads } from '../helpers/no-ranged-reads';

const REF: SegmentRef = { namespace: 'ns', segment: 's' };
const CHUNK = 65_536;
const CHUNKS = 120;
const PER = 600;
const TTL = 10;
const MODES = ['stream', 'per-key'] as const;
type Mode = (typeof MODES)[number];

/** Generation `g` of the segment: in each chunk, 600 ids that no other generation holds. */
const gen = (g: 0 | 1, chunks = CHUNKS): number[] =>
  Array.from(
    { length: chunks * PER },
    (_, i) => Math.floor(i / PER) * CHUNK + (i % PER) * 3 + 1 + g,
  );
/** Which generation holds an id: 0 or 1. */
const genOf = (id: number): number => ((id % CHUNK) - 1) % 3;

const perKey = withoutRangedReads();
beforeEach(perKey.off);
afterEach(perKey.restore);
const inMode = (mode: Mode): void => (mode === 'stream' ? perKey.restore() : perKey.off());

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function world(
  options: {
    keystore?: InProcessKeystore;
    ttl?: number;
    readerMax?: number;
    metrics?: IMetricsSink;
  } = {},
) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, gen(0), {
    registry,
    keystore: options.keystore,
  });
  const clock = manualClock();
  const open = (): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: {
        genTtlMs: options.ttl ?? 0,
        ...(options.readerMax === undefined ? {} : { readerMax: options.readerMax }),
      },
      seams: { clock },
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(options.keystore ? { encryption: { keystore: options.keystore } } : {}),
    });
  return { storage, registry, clock, open, store: open() };
}

interface Reach {
  /** The ids the read yielded after the trigger. */
  after: number[];
  error: string | null;
}

/**
 * Reads `iterate` (or an `intersect` with a copy of itself) of the segment, runs `trigger` once the first id is out,
 * and gathers what the read yields afterwards.
 */
async function reach(
  store: CloudRoaring,
  verb: 'iterate' | 'intersect',
  trigger: () => Promise<void>,
): Promise<Reach> {
  const seg = store.segment('s', { namespace: 'ns' });
  const stream =
    verb === 'iterate'
      ? seg.iterate()
      : seg.intersect([store.segment('mirror', { namespace: 'ns' })]);
  const after: number[] = [];
  let seen = 0;
  try {
    for await (const id of stream) {
      if (seen++ === 0) await trigger();
      else after.push(id);
    }
  } catch (err) {
    return { after, error: (err as Error).name };
  }
  return { after, error: null };
}

async function addMirror(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  // The mirror holds every id of both generations, so the intersect's answer is the segment's own ids.
  await bulkLoadCrbmGeneration(
    w.storage,
    { namespace: 'ns', segment: 'mirror', generation: 0 },
    [...gen(0), ...gen(1)].sort((a, b) => a - b),
    { registry: w.registry },
  );
}

describe('an erasure while a read is open', () => {
  it.each([
    ['cold', 'iterate'],
    ['warm', 'iterate'],
    ['cold', 'intersect'],
    ['warm', 'intersect'],
  ] as const)(
    '%s cache, %s: the erased id is yielded only from what the read had already taken',
    async (temperature, verb) => {
      const leaks: Record<Mode, Record<number, boolean>> = { stream: {}, 'per-key': {} };
      for (const mode of MODES) {
        for (const victimChunk of [2, 60, 110]) {
          inMode(mode);
          const w = await world();
          await addMirror(w);
          if (temperature === 'warm') {
            // Every chunk is in this store's decoded-chunk cache when the read opens.
            for await (const id of w.store.segment('s', { namespace: 'ns' }).iterate()) void id;
          }
          const victim = victimChunk * CHUNK + 1; // the first id of the chunk, which generation 0 holds
          const seg = (store: CloudRoaring) => store.segment('s', { namespace: 'ns' });
          // Controls that must hit: the victim is in the segment before the erasure (asked of another store, so this
          // one's cache is not warmed by it), and is gone after it.
          expect(await seg(w.open()).has(victim)).toBe(true);
          const got = await reach(w.store, verb, async () => {
            const ledger = await w.store.eraseSubject(victim, { namespace: 'ns' });
            expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
          });
          expect(got.error).toBeNull();
          expect(await seg(w.open()).has(victim)).toBe(false);
          leaks[mode][victimChunk] = got.after.includes(victim);
        }
      }
      for (const victimChunk of [2, 60, 110]) {
        // never more than the read of one chunk at a time reaches
        if (leaks.stream[victimChunk]) expect(leaks['per-key'][victimChunk]).toBe(true);
      }
      expect(leaks.stream[60]).toBe(false);
      expect(leaks.stream[110]).toBe(false);
    },
    60_000,
  );
});

describe('a crypto-shred, then store.invalidate, while a read is open', () => {
  it.each(['iterate', 'intersect'] as const)(
    '%s: the read stops decrypting',
    async (verb) => {
      const out: Record<Mode, Reach> = {} as Record<Mode, Reach>;
      for (const mode of MODES) {
        inMode(mode);
        const keystore = new InProcessKeystore({
          keys: { k1: new Uint8Array(32).fill(7) },
          activeKeyId: 'k1',
        });
        const w = await world({ keystore });
        await addMirror(w);
        out[mode] = await reach(w.store, verb, async () => {
          const res = await destroySegment(REF, { registry: w.registry }, { confirmSegment: 's' });
          expect(res).toMatchObject({ destroyed: true, cryptoShredded: true });
          w.store.invalidate(REF);
        });
      }
      expect(out.stream.after.length).toBeLessThanOrEqual(out['per-key'].after.length);
      // the segment's 120 chunks are one range: a stream that kept its reader would have served all but the first id
      expect(out.stream.after.length).toBeLessThan(CHUNKS * PER - 1);
      expect(out.stream.error).toBe(out['per-key'].error);
    },
    60_000,
  );
});

describe('a rollback or a load of the store itself while a read is open', () => {
  it.each([
    ['rollback', 'iterate'],
    ['rollback', 'intersect'],
    ['load', 'iterate'],
    ['load', 'intersect'],
  ] as const)(
    '%s, %s: what is yielded afterwards from the superseded generation is no more than a per-key read yields',
    async (how, verb) => {
      const stale: Record<Mode, number> = { stream: 0, 'per-key': 0 };
      for (const mode of MODES) {
        inMode(mode);
        const w = await world();
        await addMirror(w);
        // `rollback` reads generation 1 and goes back to 0; `load` reads 0 and loads 1.
        if (how === 'rollback') await w.store.load(REF, gen(1));
        const got = await reach(w.store, verb, async () => {
          if (how === 'rollback') await w.store.rollback(REF, 0);
          else await w.store.load(REF, gen(1));
        });
        expect(got.error).toBeNull();
        const old = how === 'rollback' ? 1 : 0; // the parity of the generation read before the trigger
        stale[mode] = got.after.filter((id) => genOf(id) === old).length;
        // and the rest is the generation now current
        expect(got.after.some((id) => genOf(id) !== old)).toBe(true);
      }
      expect(stale.stream).toBeLessThanOrEqual(stale['per-key']);
    },
    60_000,
  );
});

describe("another store's publish, once cache.genTtlMs has lapsed, while a read is open", () => {
  it.each(['iterate', 'intersect'] as const)(
    '%s: reaches the running read',
    async (verb) => {
      const stale: Record<Mode, number> = { stream: 0, 'per-key': 0 };
      for (const mode of MODES) {
        inMode(mode);
        const w = await world({ ttl: TTL });
        await addMirror(w);
        const got = await reach(w.store, verb, async () => {
          // Another process: its own store over the same bucket, which this one is not told of.
          await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, gen(1), {
            registry: w.registry,
          });
          w.clock.advance(TTL + 1);
        });
        expect(got.error).toBeNull();
        stale[mode] = got.after.filter((id) => genOf(id) === 0).length;
        expect(got.after.some((id) => genOf(id) === 1)).toBe(true); // the new generation reached the read
      }
      expect(stale.stream).toBeLessThanOrEqual(stale['per-key']);
    },
    60_000,
  );

  it('a lapse that finds the generation unchanged costs the read nothing but the pointer read', async () => {
    inMode('stream');
    const w = await world({ ttl: TTL });
    const got = await reach(w.store, 'iterate', async () => {
      w.clock.advance(TTL + 1);
    });
    expect(got.error).toBeNull();
    expect(got.after).toHaveLength(CHUNKS * PER - 1);
    expect(got.after.every((id) => genOf(id) === 0)).toBe(true);
  }, 60_000);
});

/**
 * The same, from a store whose decoded-chunk cache holds every chunk when the read opens: no chunk of the read needs a
 * request, so nothing but the read's own re-resolve can stop it serving the generation it planned under.
 */
describe('a warm cache, and another store writes while a read is open, once cache.genTtlMs has lapsed', () => {
  async function warmed(w: Awaited<ReturnType<typeof world>>, verb: 'iterate' | 'intersect') {
    for await (const id of w.store.segment('s', { namespace: 'ns' }).iterate()) void id;
    if (verb === 'intersect') {
      for await (const id of w.store.segment('mirror', { namespace: 'ns' }).iterate()) void id;
    }
  }

  it.each(['iterate', 'intersect'] as const)(
    '%s: a publish reaches the running read, and the old generation is served no further than the window',
    async (verb) => {
      for (const mode of MODES) {
        inMode(mode);
        const w = await world({ ttl: TTL });
        await addMirror(w);
        await warmed(w, verb);
        const got = await reach(w.store, verb, async () => {
          await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, gen(1), {
            registry: w.registry,
          });
          w.clock.advance(TTL + 1);
        });
        expect(got.error).toBeNull();
        expect(
          got.after.some((id) => genOf(id) === 1),
          mode,
        ).toBe(true);
        // the written bound: up to 32 chunks for `iterate`, and up to `concurrency` (32) keys for a combine
        expect(got.after.filter((id) => genOf(id) === 0).length, mode).toBeLessThanOrEqual(
          32 * PER,
        );
      }
    },
    60_000,
  );

  it.each(['iterate', 'intersect'] as const)(
    '%s: an erasure by another store stops the read serving the erased id',
    async (verb) => {
      for (const mode of MODES) {
        inMode(mode);
        const w = await world({ ttl: TTL });
        await addMirror(w);
        await warmed(w, verb);
        const victim = 60 * CHUNK + 1; // past the window: chunk 60 of 120
        const got = await reach(w.store, verb, async () => {
          const ledger = await w.open().eraseSubject(victim, { namespace: 'ns' });
          expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
          w.clock.advance(TTL + 1);
        });
        expect(got.error).toBeNull();
        expect(got.after.includes(victim), mode).toBe(false);
        // control: the read went on past the victim's chunk
        expect(
          got.after.some((id) => id > victim),
          mode,
        ).toBe(true);
      }
    },
    60_000,
  );
});

describe('a partly warm read under reader-cache pressure, and another store publishes while it runs', () => {
  it.each(MODES)(
    'intersect (%s): the read moves to the new generation once, and never goes back',
    async (mode) => {
      inMode(mode);
      // A long TTL, so nothing but the reader cache letting a segment go can show the read the publish: a cached chunk
      // checked against its segment resolves an evicted segment afresh, and the stream must follow it there.
      let counting = false;
      let lookups = 0;
      const metrics: IMetricsSink = {
        onEvent: (e) => void (counting && e.kind === 'cache' && lookups++),
      };
      const w = await world({ ttl: 1_000_000, readerMax: 1, metrics });
      await addMirror(w);
      const seg = w.store.segment('s', { namespace: 'ns' });
      for await (const id of w.store.segment('mirror', { namespace: 'ns' }).iterate()) void id;
      for (let c = 0; c < CHUNKS; c += 2) expect(await seg.has(c * CHUNK + 1)).toBe(true);
      counting = true;
      const got = await reach(w.store, 'intersect', async () => {
        await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, gen(1), {
          registry: w.registry,
        });
      });
      expect(got.error).toBeNull();
      const first = got.after.findIndex((id) => genOf(id) === 1);
      expect(first, 'the read reached the new generation').toBeGreaterThanOrEqual(0);
      const back = got.after.slice(first).filter((id) => genOf(id) === 0);
      expect(back.length, 'ids of the earlier generation after the move').toBe(0);
      // each chunk of each operand is looked up in the cache once, however often its stream opens
      expect(lookups).toBe(2 * CHUNKS);
    },
    60_000,
  );
});

describe('a warm read that crosses a move reads the rest as one stream, not a chunk at a time', () => {
  it('iterate: after the lapse, the remaining chunks cost a range or two, not one request each', async () => {
    inMode('stream');
    const w = await world({ ttl: TTL });
    for await (const id of w.store.segment('s', { namespace: 'ns' }).iterate()) void id;
    let ranges = 0;
    const getRange = w.storage.getRange.bind(w.storage);
    w.storage.getRange = (key, offset, length) => {
      ranges++;
      return getRange(key, offset, length);
    };
    const got = await reach(w.store, 'iterate', async () => {
      await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, gen(1), {
        registry: w.registry,
      });
      w.clock.advance(TTL + 1);
      ranges = 0;
    });
    expect(got.error).toBeNull();
    expect(got.after.some((id) => genOf(id) === 1)).toBe(true);
    // Generation 1's 120 chunks are one object of about 150 KB: one range covers them, plus the chunk the read was
    // checking when it saw the move.
    expect(ranges).toBeLessThanOrEqual(3);
  }, 60_000);
});
