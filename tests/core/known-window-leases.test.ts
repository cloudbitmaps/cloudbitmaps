import { LEASE_SKEW_MS, MAX_LEASE_MS, takeLease } from '@/core/leases';
import { MAX_KNOWN_GENERATIONS } from '@/core/known-generations';
import { loadSegment } from '@/core/load';
import type { IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A generation a live lease holds stays in the ledger, so it stays a rollback target while its lease lives, whatever
 * `keep` says; the first publish after the lease ends evicts it. The leased generations ride beside the window and take
 * no slot of `keep`, and they do not make a ledger "too wide to be a window": a ledger that names more than 64
 * generations below the pointer counts only the ones no lease holds.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const HOUR = 3_600_000;
const H = (n: number): string => n.toString(16).padStart(16, '0');

function world(start = T0) {
  let t = start;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => t });
  return {
    storage,
    registry,
    clock,
    deps: { storage, registry, codec: roaringCodec, clock },
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}
type World = ReturnType<typeof world>;

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

const names = (row: RegistryRecord | null): number[] =>
  (row?.knownGens ?? []).map((e) => e.generation);

let holders = 0;
/** One load of a growing list of ids; leases the generation it landed on for `lease` ms when asked. */
async function load(w: World, keep: number, lease?: number): Promise<number> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  const ids = Array.from({ length: Math.max(have, 0) + 2 }, (_, i) => i);
  const r = await loadSegment(SEG, ids, w.deps, { keep });
  expect(r.published).toBe(true);
  if (lease !== undefined) await leaseOn(w, r.generation, lease);
  return r.generation;
}
async function leaseOn(w: World, generation: number, ms: number): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  const taken = await takeLease(SEG, w.deps, {
    holder: H(++holders),
    generation,
    until: w.now() + ms,
    row,
    current: row.currentGen === generation,
  });
  expect(taken).not.toBe('moved');
}

describe('the lease recipe: hourly loads at keep 1, each generation leased for 72 hours as it lands', () => {
  it('holds every leased generation in the ledger and the bucket, and evicts one at the first publish after its lease ends', async () => {
    const w = world();
    for (let i = 0; i < 30; i++) {
      w.advance(HOUR);
      await load(w, 1, 72 * HOUR);
    }
    // Thirty loads on: every generation is leased, in the ledger, and in the bucket, and a rollback onto one lands.
    const all = Array.from({ length: 30 }, (_, i) => i);
    expect(names(await w.registry.get(SEG))).toEqual(all);
    expect(await generations(w.storage)).toEqual(all);
    await rollbackSegment(SEG, 10, w.deps);
    expect((await w.registry.get(SEG))!.currentGen).toBe(10);
    await rollbackSegment(SEG, 29, w.deps, { allowForward: true });
    // The rollbacks moved 10 and then 29 to the end of the ledger, which is in the order they were made current.
    expect(names(await w.registry.get(SEG))).toEqual([
      ...all.filter((g) => g !== 10 && g !== 29),
      10,
      29,
    ]);

    // 50 hours later the leases of the first generations have ended (generation g landed at hour g + 1 and ran 72 hours,
    // so, with the collector's margin, 0 to 6 have ended and 7 has not). The next publish evicts the ended ones.
    w.advance(50 * HOUR);
    const next = await load(w, 1, 72 * HOUR);
    expect(next).toBe(30);
    const kept = [...Array.from({ length: 23 }, (_, i) => i + 7), 30];
    expect(names(await w.registry.get(SEG)).sort((a, b) => a - b)).toEqual(kept);
    expect(await generations(w.storage)).toEqual(kept);
    expect(LEASE_SKEW_MS).toBe(60_000);

    // Once every lease has ended, the next publish leaves the window and itself.
    w.advance(100 * HOUR);
    expect(await load(w, 1)).toBe(31);
    expect(names(await w.registry.get(SEG))).toEqual([30, 31]);
    expect(await generations(w.storage)).toEqual([30, 31]);
  });

  it('takes no slot of keep for a leased generation, and a lease on an old generation holds it past the window', async () => {
    const w = world();
    await load(w, 2, MAX_LEASE_MS);
    for (let i = 0; i < 5; i++) await load(w, 2);
    expect(names(await w.registry.get(SEG))).toEqual([0, 3, 4, 5]);
    expect(await generations(w.storage)).toEqual([0, 3, 4, 5]);
  });
});

describe('the cap, at its boundary: keep 127 and 64 live leases', () => {
  it('300 loads land, the ledger reaches exactly 192 and never more, and the vouched span, the current generation and every leased generation stay', async () => {
    const w = world();
    const leased = Array.from({ length: 64 }, (_, i) => i);
    for (let g = 0; g < 64; g++) await load(w, 127, MAX_LEASE_MS);
    let longest = 0;
    for (let n = 64; n < 300; n++) {
      const g = await load(w, 127);
      const row = (await w.registry.get(SEG))!;
      longest = Math.max(longest, row.knownGens!.length);
      expect(row.knownGens!.length, `after ${g}`).toBeLessThanOrEqual(MAX_KNOWN_GENERATIONS);
    }
    expect(longest).toBe(MAX_KNOWN_GENERATIONS);
    const row = (await w.registry.get(SEG))!;
    expect(row.knownGens).toHaveLength(192);
    const held = names(row);
    // The leased generations, then the 127 most recently current below the new one, then the new one.
    expect(held).toEqual([...leased, ...Array.from({ length: 128 }, (_, i) => 172 + i)]);
    const present = await generations(w.storage);
    for (const g of held) expect(present, `generation ${g}`).toContain(g);
  }, 120_000);
});

describe('a ledger that names more than 64 generations below the pointer counts only the ones no lease holds', () => {
  /** 100 loads at the keep an `*Into` call uses: the ledger names all of 0 to 99, and the bucket holds them. */
  async function wide(w: World, leasedOf: (g: number) => boolean): Promise<void> {
    for (let g = 0; g < 100; g++)
      await load(w, Number.MAX_SAFE_INTEGER, leasedOf(g) ? HOUR * 24 : undefined);
    expect(names(await w.registry.get(SEG))).toHaveLength(100);
  }

  it('with 40 of them leased, a keep-1 load extends the ledger by name: no listing, no seed; it holds the leased ones and evicts the rest', async () => {
    const w = world();
    await wide(w, (g) => g < 40);
    const calls: Record<string, number> = {};
    const storage = counting(w.storage, calls);
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, storage }, { keep: 1 });
    expect(r.generation).toBe(100);
    expect(calls.list).toBeUndefined();
    const expected = [...Array.from({ length: 40 }, (_, i) => i), 99, 100];
    expect(names(await w.registry.get(SEG))).toEqual(expected);
    expect(await generations(w.storage)).toEqual(expected);
  });

  it('with 30 of them leased, 70 are not and the ledger is too wide to extend by name: the load lists once to collect, over the ledger it has, with no seed', async () => {
    const w = world();
    await wide(w, (g) => g < 30);
    const calls: Record<string, number> = {};
    const storage = counting(w.storage, calls);
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, storage }, { keep: 1 });
    expect(r.generation).toBe(100);
    // One listing, the collection's. Main started the ledger again from the bucket: a second listing, and the order lost.
    expect(calls.list).toBe(1);
    const expected = [...Array.from({ length: 30 }, (_, i) => i), 99, 100];
    expect(names(await w.registry.get(SEG))).toEqual(expected);
    expect(await generations(w.storage)).toEqual(expected);
  });
});

describe('a ledger seeded at its birth holds the listed generations a live lease holds', () => {
  it('a row with no usable ledger over generations 0 to 5, a lease on 1: the seed names 1, then the window 5, then the new generation', async () => {
    const w = world();
    for (let g = 0; g < 6; g++) await load(w, 9);
    await leaseOn(w, 1, HOUR * 24);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    const r = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 1 });
    expect(r.generation).toBe(6);
    expect(names(await w.registry.get(SEG))).toEqual([1, 5, 6]);
    expect(await generations(w.storage)).toEqual([1, 5, 6]);
  });
});

describe('the keep a pass counts by, with a ledger to go on', () => {
  /** `count` loads at `keep`, then the bucket is rolled to `target` and, when given, orphans are written above it. */
  it('keep 72 after a rollback keeps the ledger’s 72 below the pointer and nothing more by number', async () => {
    const w = world();
    for (let g = 0; g < 80; g++) await load(w, 72);
    await rollbackSegment(SEG, 40, w.deps);
    // Two loads that died after writing their objects: unknown to the ledger, numbered above the pointer and everything.
    for (const g of [90, 91])
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [7]);
    const r = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 72 });
    // 41 is taken, so the load lists and numbers above everything.
    expect(r.generation).toBe(92);
    // The ledger's 72 names below 92 fill the window; a count by number on top of them would keep the orphans too.
    const expected = [...Array.from({ length: 72 }, (_, i) => 8 + i), 92];
    expect(await generations(w.storage)).toEqual(expected);
    expect(names(await w.registry.get(SEG))).toEqual([
      ...Array.from({ length: 32 }, (_, i) => 8 + i),
      ...Array.from({ length: 39 }, (_, i) => 41 + i),
      40,
      92,
    ]);
  }, 60_000);

  it('keep 200 keeps the ledger’s 127 and then the newest 73 others by number, and the leased generations the ledger holds beyond its span besides', async () => {
    const w = world();
    // Ten generations leased as they land, then 290 more at keep 127: each publish holds the ten beside its 127.
    for (let g = 0; g < 10; g++) await load(w, 127, MAX_LEASE_MS);
    for (let g = 10; g < 300; g++) await load(w, 127);
    const row = (await w.registry.get(SEG))!;
    expect(names(row)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array.from({ length: 128 }, (_, i) => 172 + i),
    ]);
    // A hundred strays numbered under the span, unknown to the ledger: the bucket the span does not cover.
    for (let g = 20; g < 120; g++)
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [7]);
    const r = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 200 });
    expect(r.generation).toBe(300);
    // 127 of the ledger and 73 others (172 and 72 strays), the ten leased generations beside them, and the new one.
    // The newest others by number are 172, which fell out of the ledger's span at this publish, and the strays 119 down to 48.
    const expected = [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array.from({ length: 72 }, (_, i) => 48 + i),
      ...Array.from({ length: 128 }, (_, i) => 172 + i),
      300,
    ];
    expect(await generations(w.storage)).toEqual(expected);
  }, 120_000);
});
