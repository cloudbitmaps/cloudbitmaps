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
import { setImmediate } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { destroySegment } from '@/core/erasure';
import type { Clock, IMetricsSink, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { DEFAULT_INTERSECT_CONCURRENCY } from '@/core/engine';
import { withoutRangedReads } from '../helpers/no-ranged-reads';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';

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
        // within the written bound (up to 32 chunks for `iterate`, and `concurrency` + 1 keys for a combine): this early
        // in the read, before its window has widened, it has requested fewer
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

/**
 * With `readerMax: 1` and two operands, the reader cache lets each segment go between two of its chunks. A segment's
 * resolution is kept apart from its reader, for `cache.genTtlMs` from the registry read that made it, so letting the
 * reader go moves nothing: a chunk checked against its segment, cached or streamed, finds the resolution the read
 * started on until the TTL lapses.
 */
describe('a partly warm read under reader-cache pressure, and another store publishes while it runs', () => {
  /** A store under reader pressure, every other chunk of `s` and the whole mirror in its chunk cache. */
  async function partlyWarm(ttl: number) {
    let counting = false;
    let lookups = 0;
    const metrics: IMetricsSink = {
      onEvent: (e) => void (counting && e.kind === 'cache' && lookups++),
    };
    const w = await world({ ttl, readerMax: 1, metrics });
    await addMirror(w);
    const seg = w.store.segment('s', { namespace: 'ns' });
    for await (const id of w.store.segment('mirror', { namespace: 'ns' }).iterate()) void id;
    for (let c = 0; c < CHUNKS; c += 2) expect(await seg.has(c * CHUNK + 1)).toBe(true);
    counting = true;
    return { w, seg, lookups: () => lookups };
  }

  /** Another process's publish of generation 1, which this store is not told of. */
  const publish = (w: Awaited<ReturnType<typeof world>>) =>
    bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, gen(1), { registry: w.registry });

  it.each(MODES)(
    'intersect (%s): inside the TTL the read stays on the generation it started on, to the end',
    async (mode) => {
      inMode(mode);
      const { w, lookups } = await partlyWarm(1_000_000);
      const got = await reach(w.store, 'intersect', async () => {
        await publish(w);
      });
      expect(got.error).toBeNull();
      expect(got.after).toHaveLength(CHUNKS * PER - 1);
      expect(got.after.filter((id) => genOf(id) === 1)).toEqual([]);
      // each chunk of each operand is looked up in the cache once, however often its stream opens
      expect(lookups()).toBe(2 * CHUNKS);
    },
    60_000,
  );

  it.each(MODES)(
    'intersect (%s): the read moves once the TTL lapses, within the window, once, and never goes back',
    async (mode) => {
      inMode(mode);
      const TTL_LONG = 1_000;
      const { w, seg, lookups } = await partlyWarm(TTL_LONG);
      const ids: number[] = [];
      let lapsedAt = -1;
      for await (const id of seg.intersect([w.store.segment('mirror', { namespace: 'ns' })])) {
        if (ids.length === 0) await publish(w);
        // Chunk 40 of 120: every resolution of the read was made at time 0, so each lapses here.
        if (ids.length === 40 * PER) {
          w.clock.advance(TTL_LONG);
          lapsedAt = ids.length;
        }
        ids.push(id);
      }
      expect(lapsedAt).toBe(40 * PER);
      const before = ids.slice(0, lapsedAt);
      expect(
        before.filter((id) => genOf(id) === 1),
        'moved before the TTL',
      ).toEqual([]);
      const first = ids.findIndex((id) => genOf(id) === 1);
      expect(first, 'the read reached the new generation').toBeGreaterThanOrEqual(lapsedAt);
      // the written bound: the chunk it was handing out when the TTL lapsed (chunk 40), and what it had already
      // requested, up to `concurrency` (32) keys for a combine
      expect(first - (lapsedAt + PER)).toBeLessThanOrEqual(32 * PER);
      const back = ids.slice(first).filter((id) => genOf(id) === 0);
      expect(back.length, 'ids of the earlier generation after the move').toBe(0);
      expect(lookups()).toBe(2 * CHUNKS);
    },
    60_000,
  );
});

/**
 * The written bounds on what a read already in progress can yield after an erasure, under reader-cache pressure: the
 * store that erased stops at once, within the read's window, whatever its TTL; another store stops within
 * `cache.genTtlMs`. Letting a reader go is not part of either bound, and no longer re-resolves the segment before its TTL.
 */
describe('under reader-cache pressure, an erasure while a read is open', () => {
  it.each([
    ['cold', 'stream'],
    ['warm', 'stream'],
    ['cold', 'per-key'],
    ['warm', 'per-key'],
  ] as const)(
    '%s cache (%s): the store that erased yields the erased id only from what the read had already taken',
    async (temperature, mode) => {
      for (const victimChunk of [60, 110]) {
        inMode(mode);
        // A TTL that never lapses here: only the store's own invalidation can move the read.
        const w = await world({ ttl: 1_000_000, readerMax: 1 });
        await addMirror(w);
        if (temperature === 'warm') {
          for await (const id of w.store.segment('s', { namespace: 'ns' }).iterate()) void id;
          for await (const id of w.store.segment('mirror', { namespace: 'ns' }).iterate()) void id;
        }
        const victim = victimChunk * CHUNK + 1;
        expect(await w.open().segment('s', { namespace: 'ns' }).has(victim)).toBe(true);
        const got = await reach(w.store, 'intersect', async () => {
          const ledger = await w.store.eraseSubject(victim, { namespace: 'ns' });
          expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
        });
        expect(got.error).toBeNull();
        expect(got.after.includes(victim), `chunk ${victimChunk}`).toBe(false);
        expect(
          got.after.some((id) => id > victim),
          'control: the read went on past the victim',
        ).toBe(true);
      }
    },
    60_000,
  );

  it.each(MODES)(
    "warm (%s): another store's erasure stops the read serving the erased id once cache.genTtlMs lapses, and only then",
    async (mode) => {
      const served: Record<'lapse' | 'no lapse', boolean> = { lapse: true, 'no lapse': false };
      for (const lapse of [true, false]) {
        inMode(mode);
        const w = await world({ ttl: TTL, readerMax: 1 });
        await addMirror(w);
        for await (const id of w.store.segment('s', { namespace: 'ns' }).iterate()) void id;
        for await (const id of w.store.segment('mirror', { namespace: 'ns' }).iterate()) void id;
        const victim = 60 * CHUNK + 1; // past the window: chunk 60 of 120
        const got = await reach(w.store, 'intersect', async () => {
          const ledger = await w.open().eraseSubject(victim, { namespace: 'ns' });
          expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
          if (lapse) w.clock.advance(TTL + 1);
        });
        expect(got.error).toBeNull();
        served[lapse ? 'lapse' : 'no lapse'] = got.after.includes(victim);
        expect(
          got.after.some((id) => id > victim),
          'control: the read went on past the victim',
        ).toBe(true);
      }
      // Within the bound: inside the TTL the warm read still serves the chunk it cached, readers let go or not, and
      // the lapse is what stops it.
      expect(served).toEqual({ lapse: false, 'no lapse': true });
    },
    60_000,
  );
});

/**
 * The written bound on what a read already in progress can still yield after the store it runs on erases an id, counted
 * once the read's window is full: the erasure returns while the read is handing out chunk 40 of 120. A combine can yield
 * the id from the key it is handing out and the `concurrency` keys it had already requested, so `concurrency` + 1 chunks
 * (33 by default); an `iterate` read chunk by chunk from the chunk in hand and the 31 it had requested, 32, and so
 * does a `count` that reads chunks; a streamed `iterate` from the chunk in hand alone. Each case erases the id at the last chunk the bound reaches, which the read
 * yields, and at the next, which it never does. The erasure is the store's own, so it holds whatever the TTL.
 */
describe("the bound after an erasure by the read's own store, counted past the ramp-up", () => {
  const AT = 40;
  type Verb = 'iterate' | 'intersect' | 'union' | 'andNot';

  /** Whether `verb` yields, after the store's erasure returns at chunk AT, the id erased from chunk `victimChunk`. */
  async function yieldedAfterErasure(
    verb: Verb,
    mode: Mode,
    victimChunk: number,
    concurrency?: number,
  ): Promise<boolean> {
    inMode(mode);
    const w = await world({ ttl: 1_000_000 });
    const ns = { namespace: 'ns' };
    const others: Record<Exclude<Verb, 'iterate'>, { name: string; ids: number[] }> = {
      // every id of both generations: the intersect is the segment's own ids
      intersect: { name: 'mirror', ids: [...gen(0), ...gen(1)].sort((a, b) => a - b) },
      // ids past the segment's chunks: the union is the segment's ids, then these
      union: { name: 'far', ids: [300 * CHUNK + 1] },
      // ids the segment never holds: the difference is the segment's own ids
      andNot: { name: 'odd', ids: gen(1) },
    };
    if (verb !== 'iterate') {
      const { name, ids } = others[verb];
      await bulkLoadCrbmGeneration(w.storage, { ...ns, segment: name, generation: 0 }, ids, {
        registry: w.registry,
      });
    }
    const seg = w.store.segment('s', ns);
    const options = concurrency === undefined ? {} : { concurrency };
    const stream =
      verb === 'iterate'
        ? seg.iterate()
        : seg[verb]([w.store.segment(others[verb].name, ns)], options);
    // The second id of the chunk, so even the chunk in hand yields it only after the erasure has returned.
    const victim = victimChunk * CHUNK + 4;
    let seen = 0;
    let after = false;
    for await (const id of stream) {
      if (seen++ === AT * PER) {
        const ledger = await w.store.eraseSubject(victim, ns);
        expect(ledger.erasedFrom).toContainEqual(
          expect.objectContaining({ segment: 's', erased: true }),
        );
      } else if (seen > AT * PER && id === victim) {
        after = true;
      }
    }
    return after;
  }

  const C = DEFAULT_INTERSECT_CONCURRENCY;
  it.each([
    ['intersect', 'stream', undefined, C + 1],
    ['union', 'stream', undefined, C + 1],
    ['andNot', 'stream', undefined, C + 1],
    ['intersect', 'per-key', undefined, C + 1],
    ['intersect', 'stream', 4, 5],
    ['union', 'stream', 4, 5],
    ['andNot', 'stream', 4, 5],
    ['iterate', 'per-key', undefined, 32],
    ['iterate', 'stream', undefined, 1],
  ] as const)(
    '%s (%s, concurrency %s): an id erased from the chunks the bound counts (%s) is yielded, from the next one never',
    async (verb, mode, concurrency, chunks) => {
      expect(await yieldedAfterErasure(verb, mode, AT + chunks - 1, concurrency)).toBe(true);
      expect(await yieldedAfterErasure(verb, mode, AT + chunks, concurrency)).toBe(false);
    },
    60_000,
  );

  /**
   * Whether a `count`, read chunk by chunk, counts the id the store erases from chunk `victimChunk` once the count has
   * taken chunk AT. The `.crbm` source answers a count from the row's summary or the object's index and reads no chunk,
   * so it is made to answer as a source with neither does. With no consumer to wait on, the erasure starts as the count
   * requests the last chunk its window holds past chunk AT, and chunk AT is handed to it only once the erasure returns.
   * The victim's chunk holds 600 ids in the generation the count began on and 599 after the erasure.
   */
  async function countedAfterErasure(victimChunk: number): Promise<boolean> {
    const proto = CrbmStorageChunkSource.prototype;
    const kept = (['summary', 'cardinalities', 'getChunk'] as const).map(
      (name) => [name, Object.getOwnPropertyDescriptor(proto, name)!] as const,
    );
    const ns = { namespace: 'ns' };
    const victim = victimChunk * CHUNK + 4;
    let erasure: Promise<Awaited<ReturnType<CloudRoaring['eraseSubject']>>> | undefined;
    /** Whether the erasure started while chunk AT was held: whether the window reached AT + 31 with AT not yet taken. */
    let startedWhileHeld = false;
    let store: CloudRoaring | undefined;
    const getChunk = proto.getChunk;
    try {
      for (const name of ['summary', 'cardinalities'] as const) {
        Object.defineProperty(proto, name, {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(proto, 'getChunk', {
        configurable: true,
        writable: true,
        value(this: CrbmStorageChunkSource, ref: Parameters<typeof getChunk>[0]) {
          const read = getChunk.call(this, ref);
          if (ref.segment !== 's') return read;
          if (ref.chunkKey === AT) {
            return read.then(async (bytes) => {
              // Held until the erasure starts, for a bounded number of turns: a window narrower than the bound never
              // requests AT + 31 while AT is held, and the count then goes on, to fail the check below, not hang.
              for (let turn = 0; turn < 1_000 && erasure === undefined; turn++) {
                await new Promise((resolve) => setImmediate(resolve));
              }
              startedWhileHeld = erasure !== undefined;
              await erasure;
              return bytes;
            });
          }
          if (ref.chunkKey === AT + DEFAULT_INTERSECT_CONCURRENCY - 1 && erasure === undefined) {
            erasure = store!.eraseSubject(victim, ns);
          }
          return read;
        },
      });
      const w = await world({ ttl: 1_000_000 });
      store = w.store;
      const total = await w.store.segment('s', ns).count();
      expect(
        startedWhileHeld,
        `the count requested chunk ${AT + 31} while chunk ${AT} was held: its window is ${DEFAULT_INTERSECT_CONCURRENCY} wide`,
      ).toBe(true);
      expect((await erasure!).erasedFrom).toContainEqual(
        expect.objectContaining({ segment: 's', erased: true }),
      );
      expect(total, 'every other chunk is counted whole').toBeGreaterThanOrEqual(CHUNKS * PER - 1);
      return total === CHUNKS * PER;
    } finally {
      for (const [name, descriptor] of kept) Object.defineProperty(proto, name, descriptor);
    }
  }

  it('count (chunk by chunk): an id erased from the chunks the bound counts (32) is counted, from the next one never', async () => {
    expect(await countedAfterErasure(AT + 31)).toBe(true);
    expect(await countedAfterErasure(AT + 32)).toBe(false);
  }, 60_000);
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
