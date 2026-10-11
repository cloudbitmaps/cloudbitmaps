/**
 * A running `iterate` or combine that meets a move of a segment it reads plans that segment's chunk keys again, above
 * the key it has reached, from the generation current then: it reads a chunk the new generation added, and does not
 * read one the new generation dropped. Before, it kept the key list it opened with, so a chunk a publish added during
 * the read was never read, and an opt-out that landed in a chunk an exclude did not hold when the read began was never
 * subtracted for the rest of the call.
 *
 * Each read takes its first id (or its first batch), then the segment moves, then the rest is gathered. Generation 0 of
 * `s` is 50 chunks of one id each; generation 1 drops chunk 40 and adds chunk 200. Chunk 0 is the same in both, so
 * what a read that follows the move yields is exactly the answer over generation 1.
 *
 * Three moves, each met another way: this store's own load, which invalidates the segment, so the read looks at its
 * segments before the next key it takes; another store's publish once `cache.genTtlMs` has lapsed, with every chunk in
 * the reading store's chunk cache, met by a chunk cached under the version the read planned under that is no longer the
 * segment's; and the same publish with nothing cached, met by a chunk of the read's stream named by the new version.
 * Each runs as the library reads (streams of ranges) and as a source that cannot read a range does (chunk by chunk),
 * which names no version on a chunk it reads: there the last move is met only by a combine's look at an operand the keys
 * it has left may not read, every `concurrency` keys, and an `iterate` or an `intersect` keeps the keys it listed.
 *
 * A pinned read is one instant and never plans again: its cases hold the pin's answer across the same moves.
 */
import { setImmediate } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, CloudRoaring, MemoryStorage } from '@/index';
import type { Clock, Segment, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { withoutRangedReads } from '../helpers/no-ranged-reads';

const C = 65_536;
const NS = 'ns';
const TTL = 10;
const ref = (segment: string): SegmentRef => ({ namespace: NS, segment });
const S = ref('s');
const O = ref('o'); // holds one id, in chunk 0
const MIRROR = ref('mirror'); // holds every id of both generations of `s`
const OPTOUT = ref('optout');

const G0 = Array.from({ length: 50 }, (_, c) => c * C + 1);
const ADDED = 200 * C + 5;
const DROPPED = 40 * C + 1;
const G1 = [...G0.filter((id) => id !== DROPPED), ADDED];
const IN_O = 3;
// In `s` and in the opt-out list from the start, in chunk 0: a combine reads the opt-out list there and at no key after.
const OPTED_OUT = 1;

const sorted = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

const MODES = ['streamed', 'chunk by chunk'] as const;
type Mode = (typeof MODES)[number];
const perKey = withoutRangedReads();
afterEach(perKey.restore);
const inMode = (mode: Mode): void => (mode === 'streamed' ? perKey.restore() : perKey.off());

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

interface World {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly clock: ReturnType<typeof manualClock>;
  readonly store: CloudRoaring;
  readonly seg: (r: SegmentRef) => Segment;
}

async function world(
  options: { s?: readonly number[]; maxRequests?: number } = {},
): Promise<World> {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const put = (r: SegmentRef, ids: readonly number[]) =>
    bulkLoadCrbmGeneration(storage, { ...r, generation: 0 }, sorted(ids), { registry });
  await put(S, options.s ?? G0);
  await put(O, [IN_O]);
  await put(MIRROR, [...G0, ADDED, 300 * C + 7]);
  await put(OPTOUT, [OPTED_OUT]);
  const clock = manualClock();
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage, registry }),
    cache: { genTtlMs: TTL },
    seams: { clock },
    ...(options.maxRequests === undefined ? {} : { budget: { maxRequests: options.maxRequests } }),
  });
  return {
    storage,
    registry,
    clock,
    store,
    seg: (r) => store.segment(r.segment, { namespace: NS }),
  };
}

/** Every chunk of `refs` in the store's chunk cache, so a read of them is served from it. */
async function warm(w: World, refs: readonly SegmentRef[]): Promise<void> {
  for (const r of refs) for await (const id of w.seg(r).iterate()) void id;
}

const LOAD = 'this store loads';
const PUBLISH_CACHED = 'another store publishes, past the TTL, every chunk cached';
const PUBLISH_COLD = 'another store publishes, past the TTL, nothing cached';
type Move = typeof LOAD | typeof PUBLISH_CACHED | typeof PUBLISH_COLD;
const MOVES: readonly Move[] = [LOAD, PUBLISH_CACHED, PUBLISH_COLD];

/** The world a move is met in: every chunk of every segment in the chunk cache before the read, for a cached move. */
async function worldFor(how: Move, options?: Parameters<typeof world>[0]): Promise<World> {
  const w = await world(options);
  if (how === PUBLISH_CACHED) await warm(w, [S, O, MIRROR, OPTOUT]);
  return w;
}

/** Move `r` to `ids`, as `how` says. Another store's publish is a new generation this store is not told of. */
async function move(w: World, how: Move, r: SegmentRef, ids: readonly number[]): Promise<void> {
  if (how === LOAD) {
    await w.store.load(r, sorted(ids));
    return;
  }
  const generation = ((await w.registry.get(r))?.currentGen ?? -1) + 1;
  await bulkLoadCrbmGeneration(w.storage, { ...r, generation }, sorted(ids), {
    registry: w.registry,
  });
  w.clock.advance(TTL + 1);
}

/** Take the first item of `stream`, run `then`, and gather the rest: everything it yielded, in order. */
async function across<T>(stream: AsyncIterable<T>, then: () => Promise<void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) {
    out.push(item);
    if (out.length === 1) await then();
  }
  return out;
}

/**
 * The reads of `s` a move of `s` reaches, each with the answer it gives over generation 1, and whether it looks at its
 * segments every `concurrency` keys (a union, a combine with an exclude), which is all that shows a read of a source
 * that reads chunk by chunk a publish it meets with nothing cached.
 */
const READS_OF_S: ReadonlyArray<
  readonly [string, (w: World) => AsyncIterable<number>, readonly number[], boolean]
> = [
  ['iterate()', (w) => w.seg(S).iterate(), G1, false],
  ['iterate({ after })', (w) => w.seg(S).iterate({ after: 0 }), G1, false],
  ['iterate().batches()', (w) => flatten(w.seg(S).iterate().batches()), G1, false],
  ['union', (w) => w.seg(S).union([w.seg(O)]), sorted([...G1, IN_O]), true],
  ['andNot', (w) => w.seg(S).andNot([w.seg(OPTOUT)]), G1.filter((id) => id !== OPTED_OUT), true],
  ['intersect', (w) => w.seg(S).intersect([w.seg(MIRROR)]), G1, false],
  [
    'intersect().batches()',
    (w) =>
      flatten(
        w
          .seg(S)
          .intersect([w.seg(MIRROR)])
          .batches(),
      ),
    G1,
    false,
  ],
];

/** The ids of a stream of batches, one at a time, so a batch read moves at the same point as an id read. */
async function* flatten(batches: AsyncIterable<Uint32Array>): AsyncGenerator<number> {
  for await (const batch of batches) yield* batch;
}

describe('a running read of a segment that moves reads the chunk keys of the generation it moved to', () => {
  for (const mode of MODES) {
    for (const how of MOVES) {
      describe(`${mode}, ${how}`, () => {
        beforeEach(() => inMode(mode));

        it.each(READS_OF_S)('%s', async (_name, read, expected, looks) => {
          const w = await worldFor(how);
          const got = await across(read(w), () => move(w, how, S, G1));
          expect(got, 'a chunk the new generation dropped is not read').not.toContain(DROPPED);
          if (mode === 'chunk by chunk' && how === PUBLISH_COLD && !looks) {
            // Nothing tells the read of the move: it keeps the keys it listed, read from generation 1.
            expect(got).toEqual(expected.filter((id) => id !== ADDED));
            return;
          }
          expect(got, 'a chunk the new generation added is read').toContain(ADDED);
          expect(got).toEqual(expected);
        });

        it('a range that ends below the added chunk still ends there', async () => {
          const w = await worldFor(how);
          const through = 100 * C;
          const got = await across(w.seg(S).iterate({ through }), () => move(w, how, S, G1));
          expect(got).toEqual(G1.filter((id) => id <= through));
        });
      });
    }
  }
});

/**
 * An opt-out list that gains an id during the read: the id is subtracted from there on, whichever way the exclude is
 * read (with the include, or after an AND of two includes), and even where the exclude held no key the survivors reach
 * when the read began, which it then never reads.
 */
describe('a running combine whose exclude moves subtracts what the exclude holds now', () => {
  const COMBINES: ReadonlyArray<
    readonly [string, (w: World) => AsyncIterable<number>, readonly number[]]
  > = [
    [
      'intersect with an exclude (read after the AND)',
      (w) => w.seg(S).intersect([w.seg(MIRROR)], { exclude: [w.seg(OPTOUT)] }),
      G1,
    ],
    ['andNot (read with the include)', (w) => w.seg(S).andNot([w.seg(OPTOUT)]), G1],
    [
      'union with an exclude',
      (w) => w.seg(S).union([w.seg(O)], { exclude: [w.seg(OPTOUT)] }),
      sorted([...G1, IN_O]),
    ],
  ];

  for (const mode of MODES) {
    for (const how of MOVES) {
      describe(`${mode}, ${how}`, () => {
        beforeEach(() => inMode(mode));

        it.each(COMBINES)('%s', async (_name, read, all) => {
          const w = await worldFor(how, { s: G1 });
          const got = await across(read(w), () => move(w, how, OPTOUT, [OPTED_OUT, ADDED]));
          expect(got, 'the id the opt-out list gained is subtracted').not.toContain(ADDED);
          expect(got).toEqual(all.filter((id) => id !== OPTED_OUT && id !== ADDED));
        });
      });
    }
  }
});

describe('a pinned read never plans again', () => {
  beforeEach(() => inMode('streamed'));

  it('iterate() of a pin reads the pinned generation, across a load', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    const got = await across(pin.iterate(), () => move(w, LOAD, S, G1));
    expect(got).toEqual(G0);
  });

  it('everyNth of a pin places its ranks in the pinned generation, across a load', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    const got = await across(pin.everyNth(7), () => move(w, LOAD, S, G1));
    expect(got).toEqual(G0.filter((_, i) => (i + 1) % 7 === 0));
  });

  it('a combine plans its live operand again and keeps its pinned one', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    const gained = 300 * C + 7;
    const got = await across(pin.union([w.seg(O)]), async () => {
      await move(w, LOAD, S, G1);
      await move(w, LOAD, O, [IN_O, gained]);
    });
    // `s` as pinned: chunk 40 still there, chunk 200 never; `o` as it is now
    expect(got).toEqual(sorted([...G0, IN_O, gained]));
  });
});

/**
 * A re-plan is charged to the read's budget: the keys it has already taken and the keys the new plan reads, so a
 * segment that grows during a read cannot take the read past its budget.
 */
describe('the budget of a read that plans again', () => {
  beforeEach(() => inMode('streamed'));
  const GROWN = [...G0, 200 * C + 5, 201 * C + 5]; // 52 chunks

  it('iterate: refused once the keys taken and the keys left exceed it', async () => {
    const w = await world({ maxRequests: 51 });
    const read = across(w.seg(S).iterate(), () => move(w, LOAD, S, GROWN));
    await expect(read).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('iterate: read to the end when they fit', async () => {
    const w = await world({ maxRequests: 52 });
    expect(await across(w.seg(S).iterate(), () => move(w, LOAD, S, GROWN))).toEqual(GROWN);
  });

  it('a combine: refused once the reads taken and the reads left exceed it', async () => {
    // Whatever key the read has reached when it meets the move, what it has taken and what it has left come to 53
    // reads: `s` and `o` at chunk 0, and `s` alone at each of its 51 other chunks.
    const w = await world();
    const union = (maxRequests: number) =>
      across(w.seg(S).union([w.seg(O)], { budget: { maxRequests } }), () =>
        move(w, LOAD, S, GROWN),
      );
    await expect(union(52)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('a combine: read to the end when they fit', async () => {
    const w = await world();
    const got = await across(w.seg(S).union([w.seg(O)], { budget: { maxRequests: 53 } }), () =>
      move(w, LOAD, S, GROWN),
    );
    expect(got).toEqual(sorted([...GROWN, IN_O]));
  });
});

/**
 * What noticing a move costs a read during which nothing moves: no second plan (each segment's keys listed once), and
 * no request beyond what the read made before. The one look that can make a request is a combine's look at an operand
 * the keys it has left do not read (an exclude, an include of a union), once `cache.genTtlMs` has lapsed: the pointer
 * read a refresh makes, and no read of the object.
 */
describe('a read during which nothing moves', () => {
  beforeEach(() => inMode('streamed'));

  /** How many times each segment's keys are listed while `read` runs. */
  async function listings(read: () => AsyncIterable<number>): Promise<Record<string, number>> {
    const proto = CrbmStorageChunkSource.prototype;
    const listChunkKeys = proto.listChunkKeys;
    const seen: Record<string, number> = {};
    proto.listChunkKeys = function (this: CrbmStorageChunkSource, r: SegmentRef) {
      seen[r.segment] = (seen[r.segment] ?? 0) + 1;
      return listChunkKeys.call(this, r);
    };
    try {
      for await (const id of read()) void id;
    } finally {
      proto.listChunkKeys = listChunkKeys;
    }
    return seen;
  }

  it.each([
    ['iterate', (w: World) => w.seg(S).iterate(), { s: 1 }],
    [
      'intersect with an exclude',
      (w: World) => w.seg(S).intersect([w.seg(MIRROR)], { exclude: [w.seg(OPTOUT)] }),
      { s: 1, mirror: 1, optout: 1 },
    ],
    ['union', (w: World) => w.seg(S).union([w.seg(O)]), { s: 1, o: 1 }],
  ] as const)('%s plans once, cold and warm', async (_name, read, once) => {
    const w = await world();
    expect(await listings(() => read(w))).toEqual(once);
    expect(await listings(() => read(w))).toEqual(once);
  });

  it('a combine looks at an exclude it no longer reads with no request inside the TTL, and one pointer read past it', async () => {
    const w = await world();
    const pointerReads: string[] = [];
    const get = w.registry.get.bind(w.registry);
    w.registry.get = (r: SegmentRef) => {
      pointerReads.push(r.segment);
      return get(r);
    };
    const range = { count: 0 };
    const getRange = w.storage.getRange.bind(w.storage);
    w.storage.getRange = (...args: Parameters<IStorageDriver['getRange']>) => {
      range.count += 1;
      return getRange(...args);
    };
    // The opt-out list holds one id, in chunk 0: the read takes it with chunk 0 and never reads it again.
    const read = async (lapse: boolean) => {
      const got = await across(w.seg(S).andNot([w.seg(OPTOUT)]), async () => {
        pointerReads.length = 0;
        range.count = 0;
        if (lapse) w.clock.advance(TTL + 1);
      });
      expect(got).toEqual(G0.slice(1));
      return { pointerReads: [...pointerReads].sort(), ranges: range.count };
    };
    await read(false); // every chunk in the cache: the reads below read no range
    expect(await read(false)).toEqual({ pointerReads: [], ranges: 0 });
    // `s` is refreshed by its own chunks, as before; the opt-out list by the look
    expect(await read(true)).toEqual({ pointerReads: ['optout', 's'], ranges: 0 });
  });

  it("another segment's invalidation costs a running read one look, and no second plan", async () => {
    const proto = CrbmStorageChunkSource.prototype;
    const currentVersion = proto.currentVersion;
    let looks = 0;
    proto.currentVersion = function (this: CrbmStorageChunkSource, r: SegmentRef) {
      if (r.segment === 's') looks += 1;
      return currentVersion.call(this, r);
    };
    try {
      // built after the spy: the store's retrying source takes the method when it is built
      const w = await world();
      const got = await across(w.seg(S).iterate(), async () => {
        w.store.invalidate(ref('unrelated'));
      });
      expect(got).toEqual(G0);
    } finally {
      proto.currentVersion = currentVersion;
    }
    // the plan's version, and the one look before the key after the invalidation: not one at every key after it
    expect(looks).toBe(2);
  });
});

/**
 * A read that plans again stops the streams of the plan it replaced: what they still had in flight finishes and is
 * dropped, and they request nothing more.
 */
describe('a read that plans again', () => {
  beforeEach(() => inMode('streamed'));

  it('closes every stream of the plan it replaced', async () => {
    const proto = CrbmStorageChunkSource.prototype;
    const getChunks = proto.getChunks;
    const streams: Array<{ segment: string; ended: boolean }> = [];
    proto.getChunks = function (this: CrbmStorageChunkSource, r, keys, options) {
      const inner = getChunks.call(this, r, keys, options);
      const seen = { segment: r.segment, ended: false };
      streams.push(seen);
      return (async function* () {
        try {
          yield* inner;
        } finally {
          seen.ended = true;
        }
      })();
    };
    try {
      const w = await world();
      const got = await across(w.seg(S).union([w.seg(MIRROR)]), () => move(w, LOAD, S, G1));
      expect(got).toEqual(sorted([...G1, ...G0, ADDED, 300 * C + 7]));
    } finally {
      proto.getChunks = getChunks;
    }
    expect(streams.filter((s) => s.segment === 's').length, 'the read planned again').toBe(2);
    // A closed stream ends once the ranges it had in flight settle: a few turns of the event loop here.
    for (let turn = 0; turn < 100 && streams.some((s) => !s.ended); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(streams.filter((s) => !s.ended)).toEqual([]);
  });
});
