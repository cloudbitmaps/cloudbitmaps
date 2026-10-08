/**
 * `store.materializeMany` with a feed: operands that arrive as records, beside stored ones. A fed output is the same bytes
 * the same operands stored would publish; a bad feed refuses every fed output; an erasure in the store refuses a fed call.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  StaleOperandError,
  ValidationError,
  isStaleOperandError,
} from '@/index';
import type { MaterializeManyFeed, MaterializeResult } from '@/index';
import type { RoaringBitmap32 } from 'roaring';
import { batchWorld, bitmapOf, range } from '../helpers/batch-world';
import type { BatchWorld } from '../helpers/batch-world';
import { feedOf, lcg, recordsOf } from '../helpers/combine-feed';

const DATA = {
  a: [...range(0, 70_000), ...range(200_000, 330_000, 7), ...range(500_000, 500_500)],
  b: [...range(30_000, 140_000), ...range(250_000, 300_000, 3), ...range(500_100, 500_200)],
  c: range(0, 400_000, 5),
  optout: range(0, 400_000, 11),
};
const FED = { a: DATA.a, b: DATA.b, c: DATA.c };

const published = (o: unknown): MaterializeResult => {
  const r = o as MaterializeResult;
  expect(r.published).toBe(true);
  return r;
};
const failure = (o: unknown): Error => {
  const r = o as { published: boolean; error?: Error };
  expect(r.published).toBe(false);
  return r.error!;
};

function feedFor(
  fed: Record<string, number[]>,
  extra: Partial<MaterializeManyFeed> = {},
  seed = 1,
): MaterializeManyFeed {
  return {
    names: Object.keys(fed),
    records: feedOf(recordsOf(fed, lcg(seed))),
    counts: Object.fromEntries(Object.entries(fed).map(([k, v]) => [k, new Set(v).size])),
    ...extra,
  };
}

/** A world with only the stored operand loaded; the fed ones are not segments at all. */
const worldWithOptout = (): Promise<BatchWorld> => batchWorld({ optout: DATA.optout });

describe('materializeMany with a feed', () => {
  it('publishes each fed output as the same bytes the same operands stored would, stored and fed mixed', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const stored = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), c: s('c'), optout: s('optout') },
      outputs: [
        { dest: s('s-and'), expr: { and: ['a', 'b'] }, exclude: ['optout'] },
        { dest: s('s-or'), expr: { or: ['a', 'c'] } },
        { dest: s('s-nested'), expr: { and: [{ or: ['a', 'b'] }, 'c'] }, exclude: ['optout'] },
        { dest: s('s-only'), expr: { andNot: ['optout', 'c'] } },
      ],
      keep: 2,
    });
    stored.outputs.forEach((o) => published(o));
    const fed = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: feedFor(FED),
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [
        { dest: s('f-and'), expr: { and: ['a', 'b'] }, exclude: ['optout'] },
        { dest: s('f-or'), expr: { or: ['a', 'c'] } },
        { dest: s('f-nested'), expr: { and: [{ or: ['a', 'b'] }, 'c'] }, exclude: ['optout'] },
        { dest: s('f-only'), expr: { andNot: ['optout', 'c'] } },
      ],
      keep: 2,
    });
    fed.outputs.forEach((o) => published(o));
    for (const x of ['and', 'or', 'nested', 'only']) {
      expect(await w.hex(`f-${x}`, 0)).toBe(await w.hex(`s-${x}`, 0));
    }
    expect(fed.stats.groups).toBe(1);
    expect(fed.stats.feed).toMatchObject({
      records: expect.any(Number) as number,
      ids: DATA.a.length + DATA.b.length + DATA.c.length,
    });
    expect(fed.stats.outputs[0]!.operands).toEqual(['optout', 'a', 'b']);
  });

  it('runs every output as one group however small the budget leaves room, and needs maxBufferedBytes', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    await expect(
      w.store.materializeMany({
        operands: { optout: s('optout') },
        feed: feedFor(FED),
        outputs: [{ dest: s('f-1'), expr: 'a' }],
        keep: 1,
      }),
    ).rejects.toThrow(/maxBufferedBytes is required with a feed/);
  });

  it('accepts an empty mayBeEmpty on any call, since it names nothing', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      outputs: [{ dest: s('only-stored'), expr: 'optout' }],
      mayBeEmpty: [],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(await w.ids('only-stored')).toEqual(DATA.optout);
  });

  it('refuses a mayBeEmpty with no feed, or naming what is not fed, before anything is read', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const feed = { ...feedFor(FED), records: feedOf(recordsOf(FED), pulled) };
    const base = {
      operands: { optout: s('optout') },
      outputs: [{ dest: s('f-1'), expr: 'a' }],
      keep: 1,
      maxBufferedBytes: 64 * 1024 * 1024,
    };
    // With no feed, a name in mayBeEmpty is nothing the call can empty, and the message says what it is.
    await expect(w.store.materializeMany({ ...base, mayBeEmpty: ['a'] })).rejects.toThrow(
      'materializeMany: mayBeEmpty names "a", which is not an operand of this call; it names fed operands, and this call has no feed',
    );
    await expect(w.store.materializeMany({ ...base, mayBeEmpty: ['optout'] })).rejects.toThrow(
      /mayBeEmpty names "optout", a stored operand;/,
    );
    await expect(w.store.materializeMany({ ...base, mayBeEmpty: [7] as never })).rejects.toThrow(
      /mayBeEmpty names something that is not a name;/,
    );
    await expect(w.store.materializeMany({ ...base, mayBeEmpty: 'a' as never })).rejects.toThrow(
      'materializeMany: mayBeEmpty must be an array of fed operand names',
    );
    for (const mayBeEmpty of [['optout'], ['nobody']]) {
      await expect(w.store.materializeMany({ ...base, feed, mayBeEmpty })).rejects.toThrow(
        ValidationError,
      );
    }
    await expect(
      w.store.materializeMany({ ...base, feed: { ...feed, names: ['a', 'optout'] } }),
    ).rejects.toThrow(/both a stored operand and a fed one/);
    await expect(w.store.materializeMany({ ...base, feed: 5 as never })).rejects.toThrow(
      /feed must be an object/,
    );
    expect(pulled.taken).toBe(0);
  });

  it('lets a name that may be empty be empty, and refuses a declared name that never appears', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const options = (mayBeEmpty?: string[]) => ({
      operands: { optout: s('optout') },
      feed: feedFor(
        { a: DATA.a },
        { names: ['a', 'quiet'], counts: { a: DATA.a.length, quiet: 0 } },
      ),
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [
        { dest: s('f-and'), expr: { and: ['a', 'quiet'] }, allowEmpty: true },
        { dest: s('f-minus'), expr: 'a', exclude: ['quiet'] },
        { dest: s('f-stored'), expr: 'optout' },
      ],
      keep: 1,
      ...(mayBeEmpty === undefined ? {} : { mayBeEmpty }),
    });
    const refused = await w.store.materializeMany(options());
    expect(failure(refused.outputs[0])).toBeInstanceOf(ValidationError);
    expect(failure(refused.outputs[0]).message).toMatch(/operand "quiet" holds no id anywhere/);
    expect(failure(refused.outputs[1])).toBeInstanceOf(ValidationError);
    published(refused.outputs[2]);
    expect(await w.store.exists({ segment: 'f-minus' })).toBe(false);
    const allowed = await w.store.materializeMany(options(['quiet']));
    expect((allowed.outputs[0] as MaterializeResult).cardinality).toBe(0);
    expect((allowed.outputs[1] as MaterializeResult).cardinality).toBe(DATA.a.length);
  });

  it('publishes no fed output for a bad feed, and still the stored-only ones', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const bad = [...recordsOf(FED), { key: 70, operands: { a: Uint32Array.from([5]) } }];
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: { ...feedFor(FED), records: feedOf(bad) },
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [
        { dest: s('f-1'), expr: { and: ['a', 'b'] } },
        { dest: s('f-2'), expr: { or: ['a', 'optout'] } },
        { dest: s('f-3'), expr: 'optout' },
      ],
      keep: 1,
    });
    expect(failure(run.outputs[0])).toBeInstanceOf(ValidationError);
    expect(failure(run.outputs[0]).message).toMatch(
      /record \d+, operand "a": the id at position 0 is not inside the key/,
    );
    expect(failure(run.outputs[1])).toBeInstanceOf(ValidationError);
    published(run.outputs[2]);
    expect(await w.store.exists({ segment: 'f-1' })).toBe(false);
    expect(await w.store.exists({ segment: 'f-2' })).toBe(false);
    expect(run.stats.requests.publishes).toBe(1);
  });

  it('is refused for every fed output once the ledger passes the budget, as a BudgetExceededError', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: { ...feedFor(FED), records: feedOf(recordsOf(FED), pulled) },
      maxBufferedBytes: 50_000,
      outputs: [
        { dest: s('f-1'), expr: { or: ['a', 'b', 'c'] } },
        { dest: s('f-3'), expr: 'optout' },
      ],
      keep: 1,
    });
    expect(failure(run.outputs[0])).toBeInstanceOf(BudgetExceededError);
    expect(pulled.returnedEarly).toBe(true);
    expect(run.stats.memory.highWaterBytes).toBeLessThanOrEqual(50_000);
  });
});

describe('an erasure in the store while a fed call runs', () => {
  const erased = (o: unknown): StaleOperandError => {
    const e = failure(o);
    expect(isStaleOperandError(e)).toBe(true);
    expect((e as StaleOperandError).reason).toBe('erased');
    return e as StaleOperandError;
  };

  it('refuses every fed output when eraseSubject runs between two records, and publishes none', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const records = recordsOf(FED);
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: {
        ...feedFor(FED),
        records: feedOf(records, undefined, async (i) => {
          if (i === 2) await w.store.eraseSubject(4_000_000, { allNamespaces: true });
        }),
      },
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [
        { dest: s('f-1'), expr: 'a' },
        { dest: s('f-2'), expr: { and: ['a', 'b'] } },
        { dest: s('f-3'), expr: 'optout' },
      ],
      keep: 1,
    });
    expect(erased(run.outputs[0]).operand).toBe('a');
    erased(run.outputs[1]);
    published(run.outputs[2]);
    expect(await w.store.exists({ segment: 'f-1' })).toBe(false);
  });

  it('refuses a fed output not yet published when one lands during a publish, and keeps those that began', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    // A destination that holds a generation is published by a compare-and-swap, which the hook can see.
    await w.load('f-1', [1]);
    w.hooks.beforeCas = async (seg) => {
      if (seg === 'f-1') {
        w.hooks.beforeCas = undefined;
        await w.store.eraseSubject(4_000_000, { allNamespaces: true });
      }
    };
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: feedFor(FED),
      maxBufferedBytes: 64 * 1024 * 1024,
      publishConcurrency: 1,
      outputs: [
        { dest: s('f-1'), expr: 'a' },
        { dest: s('f-2'), expr: 'b' },
        { dest: s('f-3'), expr: 'optout' },
      ],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(erased(run.outputs[1]).operand).toBe('b');
    published(run.outputs[2]);
    expect(await w.store.exists({ segment: 'f-2' })).toBe(false);
  });

  /** Holds each erasure at its first registry read, so that it is still running while a call starts and runs. */
  function holdErasures(w: BatchWorld) {
    const waiting: Array<() => void> = [];
    let armed = true;
    w.hooks.beforeRowRead = async () => {
      if (armed) await new Promise<void>((resolve) => waiting.push(resolve));
    };
    return {
      async until(n: number): Promise<void> {
        for (let i = 0; i < 1_000 && waiting.length < n; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(waiting.length).toBe(n);
        armed = false;
      },
      releaseOne: (): void => waiting.shift()!(),
      releaseAll: (): void => {
        while (waiting.length > 0) waiting.shift()!();
      },
    };
  }

  const callOn = (w: BatchWorld) => (prefix: string) =>
    w.store.materializeMany({
      operands: { optout: w.store.segment('optout') },
      feed: feedFor(FED),
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [
        { dest: w.store.segment(`${prefix}-fed`), expr: 'a' },
        { dest: w.store.segment(`${prefix}-stored`), expr: 'optout' },
      ],
      keep: 1,
    });

  it('refuses a call that starts while an erasure is running, and serves one that starts after it', async () => {
    const w = await worldWithOptout();
    const call = callOn(w);
    const hold = holdErasures(w);
    const erasure = w.store.eraseSubject(4_000_000, { allNamespaces: true });
    await hold.until(1);
    const during = await call('during');
    erased(during.outputs[0]);
    published(during.outputs[1]);
    expect(await w.store.exists({ segment: 'during-fed' })).toBe(false);
    hold.releaseAll();
    await erasure;
    const after = await call('after');
    published(after.outputs[0]);
    published(after.outputs[1]);
  });

  it('refuses a call that starts while erasures overlap, until the last of them has ended', async () => {
    const w = await worldWithOptout();
    const call = callOn(w);
    const hold = holdErasures(w);
    const first = w.store.eraseSubject(4_000_000, { allNamespaces: true });
    const second = w.store.eraseSubject(4_000_001, { allNamespaces: true });
    await hold.until(2);
    // Two erasures running: whatever the counter reads, the call is refused.
    erased((await call('both')).outputs[0]);
    hold.releaseOne();
    await Promise.race([first, second]);
    // One has ended and one still runs.
    erased((await call('one')).outputs[0]);
    hold.releaseAll();
    await Promise.all([first, second]);
    const after = await call('after');
    published(after.outputs[0]);
    published(after.outputs[1]);
  });

  it('is not moved by an erasure in another store, which no counter can see', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: {
        ...feedFor(FED),
        records: feedOf(recordsOf(FED), undefined, async (i) => {
          if (i === 1) await w.other.eraseSubject(4_000_000, { allNamespaces: true });
        }),
      },
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [{ dest: s('f-1'), expr: 'a' }],
      keep: 1,
    });
    published(run.outputs[0]);
  });

  it('does not read the counter for a call with no feed, and moves it for eraseSubject alone', async () => {
    const w = await worldWithOptout();
    const s = (n: string) => w.store.segment(n);
    const probe = w.store as unknown as { epochNow(): number; erasureEpoch: number };
    const spy = vi.spyOn(probe, 'epochNow');
    published(
      (
        await w.store.materializeMany({
          operands: { optout: s('optout') },
          outputs: [{ dest: s('d-stored'), expr: 'optout' }],
          keep: 1,
        })
      ).outputs[0],
    );
    expect(spy).not.toHaveBeenCalled();
    await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: feedFor(FED),
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [{ dest: s('d-fed'), expr: 'a' }],
      keep: 1,
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const before = probe.erasureEpoch;
    await w.store.eraseSubject(1, { allNamespaces: true });
    expect(probe.erasureEpoch).toBe(before + 2);
    // An erasure that is refused for its options still counts as having run.
    await expect(w.store.eraseSubject(-1, { allNamespaces: true })).rejects.toThrow();
    expect(probe.erasureEpoch).toBe(before + 4);
    // The verbs that do not remove a subject's ids from caller data leave it where it was.
    const mid = probe.erasureEpoch;
    await w.load('optout', [1, 2, 3]);
    await w.store.rollback({ segment: 'optout' }, 0);
    await w.store.retireExpired({ namespace: 'x' });
    await w.store.dropSegment({ segment: 'optout' }, { confirmSegment: 'optout' });
    expect(probe.erasureEpoch).toBe(mid);
  });
});

describe("the guide's recipe: sets you hold, fed", () => {
  // Copied from docs/guide/loading.md, "A set you hold: feed it".
  function* chunksOf(bm: RoaringBitmap32): Generator<{ key: number; ids: Uint32Array }> {
    let key = -1;
    let ids: number[] = [];
    for (const id of bm) {
      if (id >>> 16 !== key && ids.length > 0) {
        yield { key, ids: Uint32Array.from(ids) };
        ids = [];
      }
      key = id >>> 16;
      ids.push(id);
    }
    if (ids.length > 0) yield { key, ids: Uint32Array.from(ids) };
  }

  async function* feedOf(sets: Record<string, RoaringBitmap32>) {
    const heads = Object.entries(sets).map(([name, bm]) => {
      const it = chunksOf(bm);
      return { name, it, next: it.next() };
    });
    for (;;) {
      const live = heads.filter((h) => !h.next.done);
      if (live.length === 0) return;
      const key = Math.min(...live.map((h) => (h.next.value as { key: number }).key));
      for (const h of live) {
        const chunk = h.next.value as { key: number; ids: Uint32Array };
        if (chunk.key !== key) continue;
        yield { key, operands: { [h.name]: chunk.ids } };
        h.next = h.it.next();
      }
    }
  }

  it('publishes byte for byte what the same sets stored would', async () => {
    const vipIds = [...range(0, 70_000, 3), ...range(200_000, 260_000, 7), 4_000_000];
    const lapsedIds = [...range(1_000, 140_000, 5), ...range(250_000, 330_000, 2)];
    const w = await batchWorld({ engaged: range(0, 400_000, 2), vip: vipIds, lapsed: lapsedIds });
    const s = (n: string) => w.store.segment(n);
    const held = { vip: bitmapOf(vipIds), lapsed: bitmapOf(lapsedIds) };
    const fed = await w.store.materializeMany({
      operands: { engaged: s('engaged') },
      feed: {
        names: Object.keys(held),
        records: feedOf(held),
        counts: Object.fromEntries(Object.entries(held).map(([n, bm]) => [n, bm.size])),
      },
      maxBufferedBytes: 256 * 1024 * 1024,
      outputs: [{ dest: s('send-fed'), expr: { and: ['vip', 'engaged'] }, exclude: ['lapsed'] }],
      keep: 1,
    });
    const stored = await w.store.materializeMany({
      operands: { engaged: s('engaged'), vip: s('vip'), lapsed: s('lapsed') },
      outputs: [{ dest: s('send-stored'), expr: { and: ['vip', 'engaged'] }, exclude: ['lapsed'] }],
      keep: 1,
    });
    expect((fed.outputs[0] as MaterializeResult).published).toBe(true);
    expect((stored.outputs[0] as MaterializeResult).published).toBe(true);
    expect(await w.hex('send-fed', 0)).toBe(await w.hex('send-stored', 0));
  });
});
