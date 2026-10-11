/**
 * The edges of a running read that plans its keys again after a move, beside `running-read-sees-new-keys.test.ts`:
 * a range that bounds a combine's new plan, the streams a new plan replaces, a second move, what a move costs the rest
 * of the read, the budget across two new plans, how often a combine looks at an operand its keys no longer read, a chunk
 * that names another version when nothing moved, a look held open while the segment moves, a pinned operand, and a move
 * that lands while a combine is still resolving its operands.
 */
import { setImmediate } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@/index';
import type { SegmentRef } from '@/index';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import { withoutRangedReads } from '../helpers/no-ranged-reads';
import {
  C,
  DROPPED,
  GEN0,
  GEN1,
  GEN2,
  GEN2_ADDED,
  GEN2_DROPPED,
  IN_O,
  LOAD,
  MIRROR,
  MOVES,
  O,
  OPTED_OUT,
  OPTOUT,
  S,
  across,
  acrossMoves,
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
 * The streams `getChunks` opens, by segment name, each with whether it has ended. Installed before the store is built:
 * the store's retrying source takes the method when it is built.
 */
function watchStreams(): {
  streams: Array<{ segment: string; ended: boolean }>;
  restore: () => void;
} {
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
  return { streams, restore: () => void (proto.getChunks = getChunks) };
}

/** A closed stream ends once the ranges it had in flight settle: a few turns of the event loop here. */
async function settle(streams: ReadonlyArray<{ ended: boolean }>): Promise<void> {
  for (let turn = 0; turn < 100 && streams.some((s) => !s.ended); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** How many times the version of `segment` is looked up. Installed before the store is built, as {@link watchStreams}. */
function countVersionLooks(segment: string): { count: () => number; restore: () => void } {
  const proto = CrbmStorageChunkSource.prototype;
  const original = proto.currentVersion;
  let n = 0;
  proto.currentVersion = function (this: CrbmStorageChunkSource, r: SegmentRef) {
    if (r.segment === segment) n += 1;
    return original.call(this, r);
  };
  return { count: () => n, restore: () => void (proto.currentVersion = original) };
}

/** How many times each segment's keys are listed, through the source `proto` names, while `run` runs. */
async function listingsThrough(
  proto: { listChunkKeys(r: SegmentRef): Promise<number[]> },
  run: () => Promise<unknown>,
): Promise<Record<string, number>> {
  const listChunkKeys = proto.listChunkKeys;
  const seen: Record<string, number> = {};
  proto.listChunkKeys = function (this: unknown, r: SegmentRef) {
    seen[r.segment] = (seen[r.segment] ?? 0) + 1;
    return listChunkKeys.call(this, r);
  };
  try {
    await run();
  } finally {
    proto.listChunkKeys = listChunkKeys;
  }
  return seen;
}

describe('a range bounds a combine that plans again', () => {
  for (const mode of MODES) {
    describe(mode, () => {
      beforeEach(() => inMode(mode));
      const through = 100 * C;
      it.each([
        ['union', (w: World) => w.seg(S).union([w.seg(O)], { through }), sorted([...GEN1, IN_O])],
        [
          'andNot',
          (w: World) => w.seg(S).andNot([w.seg(OPTOUT)], { through }),
          GEN1.filter((id) => id !== OPTED_OUT),
        ],
        ['intersect', (w: World) => w.seg(S).intersect([w.seg(MIRROR)], { through }), GEN1],
      ] as const)('%s ends at `through` after the move', async (_n, read, all) => {
        const w = await worldFor(LOAD);
        const got = await across(read(w), () => move(w, LOAD, S, GEN1));
        expect(got).toEqual(all.filter((id) => id <= through));
      });
    });
  }
});

describe('an iterate that plans again stops the stream of the plan it replaced', () => {
  beforeEach(() => inMode('streamed'));
  it.each([
    ['iterate', (w: World) => w.seg(S).iterate()],
    ['iterate().batches()', (w: World) => flatten(w.seg(S).iterate().batches())],
  ] as const)('%s', async (_n, read) => {
    const watch = watchStreams();
    try {
      const w = await world();
      const got = await across(read(w), () => move(w, LOAD, S, GEN1));
      expect(got).toEqual(GEN1);
      expect(watch.streams.filter((s) => s.segment === 's').length, 'the read planned again').toBe(
        2,
      );
      await settle(watch.streams);
      expect(watch.streams.filter((s) => !s.ended)).toEqual([]);
    } finally {
      watch.restore();
    }
  });
});

/**
 * A second move after a first: the read plans again for each, so the keys the second generation added are read and the
 * ones it dropped are not, whichever way each move is met.
 */
describe('a read that meets two moves plans again for each', () => {
  const TWO: ReadonlyArray<
    readonly [string, (w: World) => AsyncIterable<number>, readonly number[]]
  > = [
    ['iterate', (w) => w.seg(S).iterate(), GEN2],
    ['iterate().batches()', (w) => flatten(w.seg(S).iterate().batches()), GEN2],
    ['union', (w) => w.seg(S).union([w.seg(O)]), sorted([...GEN2, IN_O])],
    ['andNot', (w) => w.seg(S).andNot([w.seg(OPTOUT)]), GEN2.filter((id) => id !== OPTED_OUT)],
  ];
  for (const how of MOVES) {
    describe(how, () => {
      beforeEach(() => inMode('streamed'));
      it.each(TWO)('%s', async (_n, read, all) => {
        const w = await worldFor(how);
        const got = await acrossMoves(read(w), {
          1: () => move(w, how, S, GEN1),
          5: () => move(w, how, S, GEN2),
        });
        expect(got, 'dropped by the first move').not.toContain(DROPPED);
        expect(got, 'dropped by the second move').not.toContain(GEN2_DROPPED);
        expect(got).toEqual(all);
      });
    });
  }
});

/** A move costs one more listing of each segment the read lists, and nothing after it: a later invalidation of another segment is a look that plans nothing. */
describe('what a move costs a read after it', () => {
  beforeEach(() => inMode('streamed'));

  const listings = (w: World, read: () => AsyncIterable<number>, then: () => Promise<void>) =>
    listingsThrough(CrbmStorageChunkSource.prototype, () =>
      acrossMoves(read(), { 1: then, 10: async () => w.store.invalidate(ref('unrelated')) }),
    );

  it('iterate: one move is one listing more', async () => {
    const w = await world();
    expect(
      await listings(
        w,
        () => w.seg(S).iterate(),
        () => move(w, LOAD, S, GEN1),
      ),
    ).toEqual({ s: 2 });
  });

  it('union: one move is one listing more of each operand', async () => {
    const w = await world();
    expect(
      await listings(
        w,
        () => w.seg(S).union([w.seg(O)]),
        () => move(w, LOAD, S, GEN1),
      ),
    ).toEqual({ s: 2, o: 2 });
  });
});

/**
 * The budget across two new plans: the keys or reads taken under every earlier plan, beside the new plan's. Generation
 * 0 is 50 chunks, generation 1 50 (one dropped, one added), and the second move adds one more.
 */
describe('the budget of a read that plans again twice', () => {
  beforeEach(() => inMode('streamed'));
  const moves = (w: World) => ({
    1: () => move(w, LOAD, S, GEN1),
    6: () => move(w, LOAD, S, [...GEN1, GEN2_ADDED]),
  });

  it('iterate: refused when the keys taken in all earlier plans and the keys left exceed it', async () => {
    const w = await world({ maxRequests: 50 });
    await expect(acrossMoves(w.seg(S).iterate(), moves(w))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('iterate: read to the end when they fit', async () => {
    const w = await world({ maxRequests: 51 });
    expect(await acrossMoves(w.seg(S).iterate(), moves(w))).toEqual([...GEN1, GEN2_ADDED]);
  });

  it('a combine: refused when the reads taken in all earlier plans and the reads left exceed it', async () => {
    const w = await world();
    const read = acrossMoves(w.seg(S).union([w.seg(O)], { budget: { maxRequests: 51 } }), moves(w));
    await expect(read).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('a combine: read to the end when they fit', async () => {
    const w = await world();
    const got = await acrossMoves(
      w.seg(S).union([w.seg(O)], { budget: { maxRequests: 52 } }),
      moves(w),
    );
    expect(got).toEqual(sorted([...GEN1, GEN2_ADDED, IN_O]));
  });
});

describe('how often a combine looks at an operand its keys no longer read', () => {
  beforeEach(() => inMode('streamed'));

  it('a union looks once per `concurrency` keys, the first after that many', async () => {
    const spy = countVersionLooks('o');
    try {
      const w = await world();
      let before = 0;
      const got = await across(w.seg(S).union([w.seg(O)], { concurrency: 4 }), async () => {
        before = spy.count();
      });
      expect(got).toEqual(sorted([...GEN0, IN_O]));
      // 51 turns for a key (50 keys, then the one that finds the end); a look before the 5th, 9th ... 49th: 12, all
      // after the first key, where this count starts
      expect(spy.count() - before).toBe(12);
    } finally {
      spy.restore();
    }
  });
});

/**
 * A chunk that names another version than the segment's when the segment has not moved (a source of your own whose
 * chunks spell their version otherwise) costs the read one look, which finds the version unchanged, and no new plan:
 * the sign is cleared before the look, so it is not looked at again at every key after it.
 */
describe('a chunk that names another version when the segment has not moved', () => {
  beforeEach(() => inMode('streamed'));

  function oddVersionOnce(segment: string): () => void {
    const proto = CrbmStorageChunkSource.prototype;
    const getChunks = proto.getChunks;
    proto.getChunks = function (this: CrbmStorageChunkSource, r, keys, options) {
      const inner = getChunks.call(this, r, keys, options);
      if (r.segment !== segment) return inner;
      return (async function* () {
        let n = 0;
        for await (const read of inner) yield n++ === 2 ? { ...read, version: 'odd' } : read;
      })();
    };
    return () => void (proto.getChunks = getChunks);
  }

  it.each([
    // the version the plan resolves, and the one look
    ['iterate', (w: World) => w.seg(S).iterate(), GEN0, 2],
    // the plan's, the one look, and the union's look every `concurrency` keys
    ['union', (w: World) => w.seg(S).union([w.seg(O)]), sorted([...GEN0, IN_O]), 3],
  ] as const)('%s: one look, not one per key after it', async (_n, read, all, looks) => {
    const restore = oddVersionOnce('s');
    const spy = countVersionLooks('s');
    try {
      const w = await world();
      expect(await across(read(w), async () => {})).toEqual(all);
      expect(spy.count()).toBe(looks);
    } finally {
      spy.restore();
      restore();
    }
  });
});

/**
 * A look takes the invalidation epoch before it waits for the versions: a move that lands while it waits is met at the
 * next key, though the look itself answered the version from before the move.
 */
describe('a look that is held open while the segment moves', () => {
  beforeEach(() => inMode('chunk by chunk'));

  /** Holds the next look at `s`, once armed, after it has read the version, and answers that version when released. */
  function holdNextLook(): {
    arm: () => void;
    held: () => boolean;
    release: () => void;
    restore: () => void;
  } {
    const proto = CrbmStorageChunkSource.prototype;
    const original = proto.currentVersion;
    const state = { armed: false, held: false };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    proto.currentVersion = async function (this: CrbmStorageChunkSource, r: SegmentRef) {
      const v = await original.call(this, r);
      if (r.segment === 's' && state.armed) {
        state.armed = false;
        state.held = true;
        await gate;
      }
      return v;
    };
    return {
      arm: () => void (state.armed = true),
      held: () => state.held,
      release,
      restore: () => void (proto.currentVersion = original),
    };
  }

  // `head`: the ids of the first chunk the read takes (a union's holds `s`'s id and `o`'s), so the next one is a new key
  const READS: ReadonlyArray<
    readonly [string, (w: World) => AsyncIterable<number>, readonly number[], number]
  > = [
    ['iterate', (w) => w.seg(S).iterate(), GEN1, 1],
    ['union', (w) => w.seg(S).union([w.seg(O)], { concurrency: 100 }), sorted([...GEN1, IN_O]), 2],
    [
      'andNot',
      (w) => w.seg(S).andNot([w.seg(OPTOUT)], { concurrency: 100 }),
      GEN1.filter((id) => id !== OPTED_OUT),
      1,
    ],
  ];

  it.each(READS)(
    '%s: an invalidation while it waits is met at the next key',
    async (_n, read, all, head) => {
      const hold = holdNextLook();
      try {
        const w = await world();
        const it = read(w)[Symbol.asyncIterator]();
        const got: number[] = [];
        for (let i = 0; i < head; i++) got.push((await it.next()).value as number);
        // an invalidation elsewhere makes the next key look; the look answers the version `s` had
        hold.arm();
        w.store.invalidate(ref('unrelated'));
        const pending = it.next();
        while (!hold.held()) await new Promise((resolve) => setImmediate(resolve));
        await w.store.load(S, sorted(GEN1)); // `s` moves while the look waits
        hold.release();
        got.push((await pending).value as number);
        for (let r = await it.next(); r.done !== true; r = await it.next()) got.push(r.value);
        expect(got).not.toContain(DROPPED);
        expect(got).toEqual(all);
      } finally {
        hold.restore();
      }
    },
  );
});

/**
 * What the plan a read replaced still has in flight settles after the move and must not tell the new plan that the
 * segment moved again: that would cost a second look at every operand for nothing.
 */
describe('the plan a read moves to shares nothing with the plan it replaced', () => {
  beforeEach(() => inMode('streamed'));
  it.each(MOVES)('union, %s: the looks at an operand the keys no longer read', async (how) => {
    const spy = countVersionLooks('o');
    try {
      const w = await worldFor(how);
      let before = 0;
      const got = await across(w.seg(S).union([w.seg(O)]), async () => {
        await move(w, how, S, GEN1);
        before = spy.count();
      });
      expect(got).toEqual(sorted([...GEN1, IN_O]));
      // the look that finds the move, the new plan's version of it, and the periodic look: no more
      expect(spy.count() - before).toBeLessThanOrEqual(3);
    } finally {
      spy.restore();
    }
  });
});

describe('a pinned operand is never planned again', () => {
  beforeEach(() => inMode('streamed'));

  const listings = (read: () => AsyncIterable<number>, then: () => Promise<void>) =>
    listingsThrough(PinnedStorageChunkSource.prototype, () => acrossMoves(read(), { 1: then }));

  it('a combine of a pin: one listing of each operand, across its periodic looks and an invalidation elsewhere', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    expect(
      await listings(
        () => pin.union([w.seg(O)]),
        async () => w.store.invalidate(ref('unrelated')),
      ),
    ).toEqual({ s: 1, o: 1 });
  });

  it('an iterate of a pin: one listing, across an invalidation elsewhere', async () => {
    const w = await world();
    const pin = await w.seg(S).pin();
    expect(
      await listings(
        () => pin.iterate(),
        async () => w.store.invalidate(ref('unrelated')),
      ),
    ).toEqual({ s: 1 });
  });
});

/**
 * A move of one operand while a combine is still resolving another: the operand that moved had already been listed and
 * resolved, so its keys and version agree, and the invalidation since the combine began makes it look before its first
 * key and plan again.
 */
describe('a move that lands while a read is still planning', () => {
  beforeEach(() => inMode('chunk by chunk'));

  it('a combine: met at its first key, though one operand was still being resolved', async () => {
    const proto = CrbmStorageChunkSource.prototype;
    const original = proto.currentVersion;
    const state = { armed: true, held: false };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    proto.currentVersion = async function (this: CrbmStorageChunkSource, r: SegmentRef) {
      const v = await original.call(this, r);
      if (r.segment === 'o' && state.armed) {
        state.armed = false;
        state.held = true;
        await gate;
      }
      return v;
    };
    try {
      const w = await world();
      const read = w.seg(S).union([w.seg(O)], { concurrency: 100 });
      const it = read[Symbol.asyncIterator]();
      const first = it.next();
      while (!state.held) await new Promise((resolve) => setImmediate(resolve));
      await w.store.load(S, sorted(GEN1)); // `s` was resolved at generation 0; `o` is still waiting
      release();
      const got = [(await first).value as number];
      for (let r = await it.next(); r.done !== true; r = await it.next()) got.push(r.value);
      expect(got).not.toContain(DROPPED);
      expect(got).toEqual(sorted([...GEN1, IN_O]));
    } finally {
      proto.currentVersion = original;
    }
  });
});
