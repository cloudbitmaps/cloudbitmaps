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
import type { Clock } from '@/index';
import type { SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IStorageDriver } from '@/core/ports';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/chunk-stream';
import { withoutRangedReads } from '../helpers/no-ranged-reads';
import {
  ADDED,
  C,
  DROPPED,
  GEN0,
  GEN1,
  GEN2,
  GEN2_ADDED,
  IN_O,
  LOAD,
  MIRROR,
  MOVES,
  O,
  OPTED_OUT,
  OPTOUT,
  PUBLISH_COLD,
  S,
  TTL,
  across,
  flatten,
  move,
  ref,
  sorted,
  world,
  worldFor,
} from '../helpers/running-read-world';
import type { World } from '../helpers/running-read-world';

const MODES = ['streamed', 'chunk by chunk'] as const;
type Mode = (typeof MODES)[number];
const perKey = withoutRangedReads();
afterEach(perKey.restore);
const inMode = (mode: Mode): void => (mode === 'streamed' ? perKey.restore() : perKey.off());

/**
 * The reads of `s` a move of `s` reaches, each with the answer it gives over generation 1, and whether it looks at its
 * segments every `concurrency` keys (a union, a combine with an exclude), which is all that shows a read of a source
 * that reads chunk by chunk a publish it meets with nothing cached.
 */
const READS_OF_S: ReadonlyArray<
  readonly [string, (w: World) => AsyncIterable<number>, readonly number[], boolean]
> = [
  ['iterate()', (w) => w.seg(S).iterate(), GEN1, false],
  ['iterate({ after })', (w) => w.seg(S).iterate({ after: 0 }), GEN1, false],
  ['iterate().batches()', (w) => flatten(w.seg(S).iterate().batches()), GEN1, false],
  ['union', (w) => w.seg(S).union([w.seg(O)]), sorted([...GEN1, IN_O]), true],
  ['andNot', (w) => w.seg(S).andNot([w.seg(OPTOUT)]), GEN1.filter((id) => id !== OPTED_OUT), true],
  ['intersect', (w) => w.seg(S).intersect([w.seg(MIRROR)]), GEN1, false],
  [
    'intersect().batches()',
    (w) =>
      flatten(
        w
          .seg(S)
          .intersect([w.seg(MIRROR)])
          .batches(),
      ),
    GEN1,
    false,
  ],
];

describe('a running read of a segment that moves reads the chunk keys of the generation it moved to', () => {
  for (const mode of MODES) {
    for (const how of MOVES) {
      describe(`${mode}, ${how}`, () => {
        beforeEach(() => inMode(mode));

        it.each(READS_OF_S)('%s', async (_name, read, expected, looks) => {
          const w = await worldFor(how);
          const got = await across(read(w), () => move(w, how, S, GEN1));
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
          const got = await across(w.seg(S).iterate({ through }), () => move(w, how, S, GEN1));
          expect(got).toEqual(GEN1.filter((id) => id <= through));
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
      GEN1,
    ],
    ['andNot (read with the include)', (w) => w.seg(S).andNot([w.seg(OPTOUT)]), GEN1],
    [
      'union with an exclude',
      (w) => w.seg(S).union([w.seg(O)], { exclude: [w.seg(OPTOUT)] }),
      sorted([...GEN1, IN_O]),
    ],
  ];

  for (const mode of MODES) {
    for (const how of MOVES) {
      describe(`${mode}, ${how}`, () => {
        beforeEach(() => inMode(mode));

        it.each(COMBINES)('%s', async (_name, read, all) => {
          const w = await worldFor(how, { s: GEN1 });
          const got = await across(read(w), () => move(w, how, OPTOUT, [OPTED_OUT, ADDED]));
          expect(got, 'the id the opt-out list gained is subtracted').not.toContain(ADDED);
          expect(got).toEqual(all.filter((id) => id !== OPTED_OUT && id !== ADDED));
        });
      });
    }
  }
});

/** How often each segment's keys are listed while `run` runs: live, and at a pinned generation. */
async function listingsDuring(
  run: () => Promise<unknown>,
): Promise<{ live: Record<string, number>; pinned: Record<string, number> }> {
  const proto = CrbmStorageChunkSource.prototype;
  const listChunkKeys = proto.listChunkKeys;
  const listChunkKeysAt = proto.listChunkKeysAt;
  const live: Record<string, number> = {};
  const pinned: Record<string, number> = {};
  proto.listChunkKeys = function (this: CrbmStorageChunkSource, r: SegmentRef) {
    live[r.segment] = (live[r.segment] ?? 0) + 1;
    return listChunkKeys.call(this, r);
  };
  proto.listChunkKeysAt = function (
    this: CrbmStorageChunkSource,
    ...args: Parameters<typeof listChunkKeysAt>
  ) {
    pinned[args[0].segment] = (pinned[args[0].segment] ?? 0) + 1;
    return listChunkKeysAt.apply(this, args);
  };
  try {
    await run();
  } finally {
    proto.listChunkKeys = listChunkKeys;
    proto.listChunkKeysAt = listChunkKeysAt;
  }
  return { live, pinned };
}

describe('a pinned read never plans again', () => {
  beforeEach(() => inMode('streamed'));

  it('iterate() of a pin reads the pinned generation, across a load, from the one listing it made', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    let got: number[] = [];
    const seen = await listingsDuring(async () => {
      got = await across(pin.iterate(), () => move(w, LOAD, S, GEN1));
    });
    expect(got).toEqual(GEN0);
    expect(seen).toEqual({ live: {}, pinned: { s: 1 } });
  });

  it('everyNth of a pin places its ranks in the pinned generation, across a load, and lists no keys', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    let got: number[] = [];
    const seen = await listingsDuring(async () => {
      got = await across(pin.everyNth(7), () => move(w, LOAD, S, GEN1));
    });
    expect(got).toEqual(GEN0.filter((_, i) => (i + 1) % 7 === 0));
    expect(seen).toEqual({ live: {}, pinned: {} });
  });

  it('a combine plans its live operand again and lists its pinned one only at the pin', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    const gained = 300 * C + 7;
    let got: number[] = [];
    const seen = await listingsDuring(async () => {
      got = await across(pin.union([w.seg(O)]), async () => {
        await move(w, LOAD, S, GEN1);
        await move(w, LOAD, O, [IN_O, gained]);
      });
    });
    // `s` as pinned: chunk 40 still there, chunk 200 never; `o` as it is now
    expect(got).toEqual(sorted([...GEN0, IN_O, gained]));
    // the move of `o` plans the read again, which lists `s` at its pin again, never live
    expect(seen).toEqual({ live: { o: 2 }, pinned: { s: 2 } });
  });
});

/**
 * A move this store makes while a read is still listing a segment's keys: the listing opens the segment's object, and
 * the load lands before that open returns, so the listing holds the generation it began on while the version the read
 * resolves next is the new one. Nothing later could tell the two apart, since the read's chunks and its looks would all
 * name the new version, so the read lists the keys again before it takes one: on its first listing, and on a listing
 * after a move.
 */
describe('a move that lands while a read lists its keys', () => {
  beforeEach(() => inMode('streamed'));

  /** A world whose first tail read of `segment` at `generation`, once armed, first runs `then`. */
  async function landingIn(
    segment: string,
    generation: number,
    then: (w: World) => Promise<void>,
    s?: readonly number[],
  ) {
    const state = { armed: false, landed: false };
    const w: World = await world({
      ...(s === undefined ? {} : { s }),
      onTail: async (key) => {
        if (!state.armed || key.segment !== segment || key.generation !== generation) return;
        state.armed = false;
        await then(w);
        state.landed = true;
      },
    });
    return { w, arm: () => void (state.armed = true), landed: () => state.landed };
  }

  it('iterate, on its first listing', async () => {
    const at = await landingIn('s', 0, (w) => move(w, LOAD, S, GEN1));
    at.arm();
    const got: number[] = [];
    for await (const id of at.w.seg(S).iterate()) got.push(id);
    expect(at.landed()).toBe(true);
    expect(got, 'a chunk the load added is read').toContain(ADDED);
    expect(got).toEqual(GEN1);
  });

  it('andNot, on its first listing: the id the opt-out list gained is subtracted', async () => {
    const at = await landingIn('optout', 0, (w) => move(w, LOAD, OPTOUT, [OPTED_OUT, ADDED]), GEN1);
    at.arm();
    const got: number[] = [];
    for await (const id of at.w.seg(S).andNot([at.w.seg(OPTOUT)])) got.push(id);
    expect(at.landed()).toBe(true);
    expect(got).not.toContain(ADDED);
    expect(got).toEqual(GEN1.filter((id) => id !== OPTED_OUT && id !== ADDED));
  });

  it('iterate, on the listing after a move', async () => {
    const at = await landingIn('s', 1, (w) => move(w, LOAD, S, GEN2));
    const got = await across(at.w.seg(S).iterate(), async () => {
      await move(at.w, LOAD, S, GEN1);
      at.arm();
    });
    expect(at.landed()).toBe(true);
    expect(got, 'a chunk the second load added is read').toContain(GEN2_ADDED);
    expect(got).toEqual(GEN2);
  });

  it("another segment's invalidation while it lists costs it no second listing", async () => {
    const at = await landingIn('s', 0, async (w) => w.store.invalidate(ref('unrelated')));
    at.arm();
    let got: number[] = [];
    const seen = await listingsDuring(async () => {
      got = [];
      for await (const id of at.w.seg(S).iterate()) got.push(id);
    });
    expect(at.landed()).toBe(true);
    expect(got).toEqual(GEN0);
    expect(seen).toEqual({ live: { s: 1 }, pinned: {} });
  });

  it('andNot, on the listing after a move: both ids the opt-out list gained are subtracted', async () => {
    const both = [...GEN1, GEN2_ADDED];
    const at = await landingIn(
      'optout',
      1,
      (w) => move(w, LOAD, OPTOUT, [OPTED_OUT, ADDED, GEN2_ADDED]),
      both,
    );
    const got = await across(at.w.seg(S).andNot([at.w.seg(OPTOUT)]), async () => {
      await move(at.w, LOAD, OPTOUT, [OPTED_OUT, ADDED]);
      at.arm();
    });
    expect(at.landed()).toBe(true);
    expect(got).not.toContain(ADDED);
    expect(got).not.toContain(GEN2_ADDED);
    expect(got).toEqual(both.filter((id) => ![OPTED_OUT, ADDED, GEN2_ADDED].includes(id)));
  });
});

/**
 * A re-plan is charged to the read's budget: the keys it has already taken and the keys the new plan reads, so a
 * segment that grows during a read cannot take the read past its budget.
 */
describe('the budget of a read that plans again', () => {
  beforeEach(() => inMode('streamed'));
  const GROWN = [...GEN0, 200 * C + 5, 201 * C + 5]; // 52 chunks

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
      expect(got).toEqual(GEN0.slice(1));
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
      expect(got).toEqual(GEN0);
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
      const got = await across(w.seg(S).union([w.seg(MIRROR)]), () => move(w, LOAD, S, GEN1));
      expect(got).toEqual(sorted([...GEN1, ...GEN0, ADDED, GEN2_ADDED, 300 * C + 7]));
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

// A cached chunk of an exclude that is no longer the exclude's version re-plans a running combine as it is read.
function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

describe('an AND of two includes meets a move of its exclude through the exclude chunk it reads', () => {
  const NS = 'ns';
  const KEYS = Array.from({ length: 60 }, (_, k) => k);
  const id = (chunk: number, low: number): number => chunk * 65_536 + low;
  const included = KEYS.map((k) => id(k, 1));

  it('subtracts an id the exclude gained in a chunk it did not hold when the read began, as soon as it meets the move', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const at = (segment: string, generation: number) => ({ namespace: NS, segment, generation });
    await bulkLoadCrbmGeneration(storage, at('a', 0), included, { registry });
    await bulkLoadCrbmGeneration(storage, at('b', 0), included, { registry });
    // The exclude holds chunks 0, 33 and 45 only. The read plans its reads of it at those keys, and it is at key 33,
    // read ahead of the consumer once the window opens past the first keys, that the read finds the exclude's cached
    // chunk is no longer the exclude's version: before the combine's look at its operands, every 32 keys (and before the read reaches chunk 25, which the exclude gains: a batch of exclude reads waits a few turns of the microtask queue for the keys that ask together, so the chunk it gains is one the read has not yet reached).
    await bulkLoadCrbmGeneration(storage, at('c', 0), [id(0, 9), id(33, 9), id(45, 9)], {
      registry,
    });
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: TTL },
      seams: { clock },
    });
    const combine = () =>
      store.segment('a', { namespace: NS }).intersect([store.segment('b', { namespace: NS })], {
        exclude: [store.segment('c', { namespace: NS })],
      });
    await collect(combine()); // every chunk of every operand is cached under the generation the next read plans under

    const out: number[] = [];
    for await (const got of combine()) {
      out.push(got);
      if (out.length === 1) {
        // Another store's publish: the exclude now also holds the id of chunk 25, and its TTL has lapsed here.
        await bulkLoadCrbmGeneration(
          storage,
          at('c', 1),
          [id(0, 9), id(25, 1), id(33, 9), id(45, 9)],
          { registry },
        );
        clock.advance(TTL + 1);
      }
    }
    expect(out).toEqual(included.filter((x) => x !== id(25, 1)));
  });
});
