import {
  KNOWN_FILL,
  MAX_KNOWN_GENERATIONS,
  KNOWN_SPAN,
  capKnown,
  carriesWindow,
  describingKnown,
  makeCurrent,
  nextKnown,
  rollbackKnown,
  usableKnownGens,
  windowOf,
} from '@/core/known-generations';
import { wantsSeed } from '@/core/ledger-seed';
import type { KnownGeneration, RegistryRecord } from '@/core/ports';

/**
 * The ledger's pure rules: what a usable ledger and its window are, the cap, what a publish and a rollback write, and
 * when a publish seeds.
 */

const entry = (generation: number): KnownGeneration => ({ generation, footerCrc: generation * 10 });
const ledger = (...gens: number[]): KnownGeneration[] => gens.map(entry);
const numbers = (l: readonly KnownGeneration[] | undefined): number[] | undefined =>
  l?.map((e) => e.generation);
const row = (currentGen: number | null, knownGens?: readonly KnownGeneration[]): RegistryRecord =>
  ({
    segment: 's',
    currentGen,
    status: 'active',
    token: 't',
    pointerId: 't',
    createdAt: 1,
    updatedAt: 1,
    ...(knownGens === undefined ? {} : { knownGens }),
  }) as RegistryRecord;

describe('capKnown', () => {
  const many = (n: number): KnownGeneration[] => ledger(...Array.from({ length: n }, (_, i) => i));

  it('keeps everything while the ledger holds fewer than the fill, and the newest by recency past it', () => {
    expect(capKnown(many(KNOWN_FILL), new Set([KNOWN_FILL - 1]))).toHaveLength(KNOWN_FILL);
    const capped = capKnown(many(200), new Set([199]));
    expect(capped).toHaveLength(KNOWN_FILL);
    expect(numbers(capped)![0]).toBe(72);
    expect(numbers(capped)!.at(-1)).toBe(199);
  });

  it('never drops a protected entry for room, even past the fill, and keeps the order', () => {
    const protect = new Set([0, 1, 2]);
    const capped = capKnown(many(200), protect);
    for (const g of protect) expect(numbers(capped)).toContain(g);
    expect(capped).toHaveLength(KNOWN_FILL);
    expect(numbers(capped)).toEqual(
      [...numbers(capped)!].sort(
        (a, b) => numbers(many(200))!.indexOf(a) - numbers(many(200))!.indexOf(b),
      ),
    );
    const all = new Set(Array.from({ length: 150 }, (_, i) => i));
    expect(capKnown(many(150), all)).toHaveLength(150);
  });

  it('keeps leased entries past the fill, up to the writer cap, most recently current first', () => {
    const leased = new Set(Array.from({ length: 150 }, (_, i) => i));
    const capped = capKnown(many(300), new Set([299]), leased);
    expect(numbers(capped)).toEqual(expect.arrayContaining([...leased, 299]));
    expect(capped).toHaveLength(151);
    // Past the writer cap the least recently current leased entries go.
    const over = capKnown(
      many(400),
      new Set([399]),
      new Set(Array.from({ length: 300 }, (_, i) => i)),
    );
    expect(over).toHaveLength(MAX_KNOWN_GENERATIONS);
    expect(numbers(over)).toContain(399);
    expect(numbers(over)).not.toContain(0);
    expect(numbers(over)).toContain(299);
  });
});

describe('makeCurrent', () => {
  it('moves a generation to the end, replacing its entry, and appends one it did not know', () => {
    expect(numbers(makeCurrent(ledger(1, 2, 3), entry(1)))).toEqual([2, 3, 1]);
    expect(numbers(makeCurrent(ledger(1, 2, 3), entry(9)))).toEqual([1, 2, 3, 9]);
    expect(makeCurrent([{ generation: 2, footerCrc: 1 }], { generation: 2, footerCrc: 5 })).toEqual(
      [{ generation: 2, footerCrc: 5 }],
    );
  });
});

describe('a usable ledger and its window', () => {
  it('ends with the pointer, on an active row, and agrees with a clear summary', () => {
    expect(usableKnownGens(row(3, ledger(1, 2, 3)))).toEqual(ledger(1, 2, 3));
    expect(usableKnownGens(row(3, ledger(1, 2)))).toBeUndefined();
    expect(usableKnownGens(row(3, []))).toBeUndefined();
    expect(usableKnownGens(row(null, ledger(3)))).toBeUndefined();
    expect(usableKnownGens({ ...row(3, ledger(3)), status: 'destroyed' })).toBeUndefined();
    const summary = { generation: 3, cardinality: 1, fingerprint: '4096:30', tailBytes: 200 };
    expect(usableKnownGens({ ...row(3, ledger(3)), summary })).toBeDefined();
    expect(
      usableKnownGens({ ...row(3, ledger(3)), summary: { ...summary, fingerprint: '4096:31' } }),
    ).toBeUndefined();
  });

  it('is the entries below the pointer, in the order they were made current; entries above it are no part of it', () => {
    expect(windowOf(row(3, ledger(1, 2, 3)))).toEqual([1, 2]);
    expect(windowOf(row(3, ledger(3)))).toEqual([]);
    expect(windowOf(row(1, ledger(2, 3, 1)))).toEqual([]);
    expect(windowOf(row(1, ledger(0, 2, 3, 1)))).toEqual([0]);
    expect(windowOf(row(3, ledger(2, 1, 3)))).toEqual([2, 1]);
    expect(windowOf(row(3))).toBeUndefined();
    expect(windowOf(null)).toBeUndefined();
  });

  it('is a window a small keep extends when it names no more than 64 generations below the pointer that no lease holds', () => {
    const below = (n: number): RegistryRecord =>
      row(n, ledger(...Array.from({ length: n + 1 }, (_, g) => g)));
    expect(carriesWindow(below(64), new Set())).toBe(true);
    expect(carriesWindow(below(65), new Set())).toBe(false);
    // A name held only for a lease is no part of the window and does not count toward the limit.
    expect(carriesWindow(below(100), new Set(Array.from({ length: 36 }, (_, g) => g)))).toBe(true);
    expect(carriesWindow(below(100), new Set(Array.from({ length: 35 }, (_, g) => g)))).toBe(false);
    // A ledger that is not usable carries none; entries above the pointer do not count.
    expect(carriesWindow(row(3), new Set())).toBe(false);
    expect(carriesWindow(row(1, ledger(2, 3, 1)), new Set())).toBe(true);
  });
});

describe('nextKnown', () => {
  it('draws the window from the row and collects by name over a usable window', () => {
    const after = nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 2);
    expect(numbers(after.known)).toEqual([2, 3, 4]);
    expect(after.list).toEqual([2, 3]);
    expect(after.evict).toEqual([1]);
  });

  it('writes the generation alone for generation 0 and for keep 0, and carries the ledger for a keep above 64', () => {
    expect(numbers(nextKnown(null, 0, 0, 1).known)).toEqual([0]);
    expect(nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 0)).toMatchObject({
      list: [],
      evict: [1, 2, 3],
    });
    expect(numbers(nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 0).known)).toEqual([4]);
    const wide = nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 100);
    expect(numbers(wide.known)).toEqual([1, 2, 3, 4]);
    expect(wide.list).toBeUndefined();
  });

  it('replaces a stale entry for the new generation’s number, and drops an erasure rewrite’s carried ledger', () => {
    expect(numbers(nextKnown(row(1, ledger(4, 1)), 4, 40, 100).known)).toEqual([1, 4]);
    expect(
      numbers(nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 9, { clearsLeases: true }).known),
    ).toEqual([4]);
  });

  it('writes a seed in place of what the row carried, below the new generation only', () => {
    const seed = ledger(5, 3, 9);
    const after = nextKnown(row(3, ledger(1, 2, 3)), 4, 40, 2, { seed });
    expect(numbers(after.known)).toEqual([3, 4]);
    expect(after.list).toBeUndefined();
    expect(after.evict).toEqual([]);
    expect(numbers(nextKnown(null, 7, 70, 2, { seed: ledger(2, 5) }).known)).toEqual([2, 5, 7]);
  });
});

describe('nextKnown ranks the window by recency and splits it by number', () => {
  const next = (
    prev: RegistryRecord | null,
    generation: number,
    keep: number | undefined,
    leased: number[] = [],
  ) => nextKnown(prev, generation, generation * 10, keep, { leased: new Set(leased) });

  it('keeps the generation a rollback restored first, from the first load on: 0 to 3, rollback(1), load 4 at keep 1 and 2', () => {
    const rolledBack = row(1, ledger(0, 2, 3, 1));
    const one = next(rolledBack, 4, 1);
    expect(numbers(one.known)).toEqual([1, 4]);
    expect(one.list).toEqual([1]);
    expect(one.evict).toEqual([0, 2, 3]);
    const two = next(rolledBack, 4, 2);
    expect(numbers(two.known)).toEqual([3, 1, 4]);
    expect(two.list).toEqual([1, 3]);
    expect(two.evict).toEqual([0, 2]);
  });

  it('goes on holding it at the second load: [3, 1, 4] at keep 2 keeps 1 and 4 and evicts 3, where newest-by-number would evict 1', () => {
    const second = next(row(4, ledger(3, 1, 4)), 5, 2);
    expect(numbers(second.known)).toEqual([1, 4, 5]);
    expect(second.evict).toEqual([3]);
  });

  it('carries what a rollback left above the new generation, takes no slot of keep for it, and never evicts it', () => {
    // [1, 4, 5], rollback(1) -> [4, 5, 1], and a load numbers 2, under the entries above it.
    const rolledBack = row(1, ledger(4, 5, 1));
    const table = [
      { keep: 0, known: [4, 5, 2], evict: [1] },
      { keep: 1, known: [4, 5, 1, 2], evict: [] },
      { keep: 2, known: [4, 5, 1, 2], evict: [] },
    ];
    for (const { keep, known, evict } of table) {
      const after = next(rolledBack, 2, keep);
      expect(numbers(after.known), `keep ${keep}`).toEqual(known);
      expect(after.evict, `keep ${keep}`).toEqual(evict);
      expect(after.evict.every((g) => g < 2)).toBe(true);
    }
    // The next load at keep 1 takes 3: below is [1, 2], the window [2], the eviction [1].
    const three = next(row(2, ledger(4, 5, 1, 2)), 3, 1);
    expect(numbers(three.known)).toEqual([4, 5, 2, 3]);
    expect(three.evict).toEqual([1]);
    // A load that numbers 6, above everything: 4 and 5 are then ordinary entries below it and leave with the window.
    const six = next(row(3, ledger(4, 5, 2, 3)), 6, 1);
    expect(numbers(six.known)).toEqual([3, 6]);
    expect(six.evict).toEqual([2, 4, 5]);
  });

  it('holds a leased generation in the ledger whatever keep says, and evicts it at the first publish after its lease ends', () => {
    const held = next(row(3, ledger(0, 1, 2, 3)), 4, 1, [0]);
    expect(numbers(held.known)).toEqual([0, 3, 4]);
    expect(held.list).toEqual([0, 3]);
    expect(held.evict).toEqual([1, 2]);
    const after = next(row(4, held.known), 5, 1, []);
    expect(numbers(after.known)).toEqual([4, 5]);
    expect(after.evict).toEqual([0, 3]);
  });

  it('takes a lease on a generation numbered above the new one as one more carried entry, and ignores a lease on a name it does not know', () => {
    const above = next(row(1, ledger(4, 5, 1)), 2, 0, [4, 77]);
    expect(numbers(above.known)).toEqual([4, 5, 2]);
  });

  it('stops vouching at 127 below the new generation, so a ledger at keep 127 or more holds 128, and 192 with 64 leases', () => {
    const full = row(127, ledger(...Array.from({ length: 128 }, (_, g) => g)));
    const into = next(full, 128, Number.MAX_SAFE_INTEGER);
    expect(into.known).toHaveLength(KNOWN_SPAN + 1);
    expect(numbers(into.known)![0]).toBe(1);
    expect(into.list).toBeUndefined();
    expect(into.evict).toEqual([]);
    // 127 vouched below the new generation, 64 leased generations older than those, and the new generation.
    const old = Array.from({ length: 64 }, (_, g) => g);
    const wide = row(190, ledger(...Array.from({ length: 191 }, (_, g) => g)));
    const boundary = next(wide, 191, 127, old);
    expect(boundary.known).toHaveLength(MAX_KNOWN_GENERATIONS);
    expect(numbers(boundary.known)).toEqual(expect.arrayContaining([...old, 191]));
    expect(numbers(boundary.known)).toContain(190 - 126);
  });

  it('writes the generation alone for an erasure’s rewrite, whatever the row carried above or below it', () => {
    const after = nextKnown(row(1, ledger(4, 5, 1)), 6, 60, 0, { clearsLeases: true });
    expect(numbers(after.known)).toEqual([6]);
    expect(after.evict).toEqual([1, 4, 5]);
  });

  it('writes the generation alone and lists over a pointed row with no usable ledger, unless it is given a seed', () => {
    const after = next(row(3), 4, 2);
    expect(numbers(after.known)).toEqual([4]);
    expect(after.list).toBeUndefined();
    expect(after.evict).toEqual([]);
  });

  it('replaces a stale entry for the new generation’s number: it is neither below nor above it', () => {
    const after = next(row(1, ledger(2, 1)), 2, 1);
    expect(numbers(after.known)).toEqual([1, 2]);
    expect(after.known.at(-1)).toEqual({ generation: 2, footerCrc: 20 });
  });
});

describe('rollbackKnown and describingKnown', () => {
  it('moves a known target to the end, and inserts an unknown one through the cap', () => {
    const prev = row(3, ledger(1, 2, 3));
    expect(numbers(rollbackKnown(prev, entry(1)))).toEqual([2, 3, 1]);
    expect(numbers(rollbackKnown(prev, entry(9)))).toEqual([1, 2, 3, 9]);
    const full = row(127, ledger(...Array.from({ length: 128 }, (_, i) => i)));
    const inserted = rollbackKnown(full, entry(500))!;
    expect(inserted).toHaveLength(KNOWN_FILL);
    expect(numbers(inserted)).toContain(127);
    expect(numbers(inserted)!.at(-1)).toBe(500);
  });

  it('starts no ledger over a row that has none', () => {
    expect(rollbackKnown(row(3), entry(1))).toBeUndefined();
    expect(rollbackKnown(row(3, ledger(1, 2)), entry(1))).toBeUndefined();
  });

  it('writes a known target as read, past 128 but at most 192, and caps one that is past 192', () => {
    const big = (n: number) => row(n - 1, ledger(...Array.from({ length: n }, (_, i) => i)));
    expect(rollbackKnown(big(150), entry(10))).toHaveLength(150);
    const capped = rollbackKnown(big(300), entry(10))!;
    expect(capped.length).toBeLessThanOrEqual(KNOWN_FILL);
    expect(numbers(capped)).toContain(299);
    expect(numbers(capped)!.at(-1)).toBe(10);
  });

  it('puts a row back as it was: its own ledger, capped when another build wrote more than 192, none when it had none', () => {
    const prev = row(3, ledger(1, 2, 3));
    expect(describingKnown(prev, 1)).toEqual(ledger(1, 2, 3));
    expect(describingKnown(row(3), 1)).toBeUndefined();
    const big = row(299, ledger(...Array.from({ length: 300 }, (_, i) => i)));
    const capped = describingKnown(big, 5)!;
    expect(capped.length).toBeLessThanOrEqual(KNOWN_FILL);
    expect(numbers(capped)).toContain(299);
  });
});

describe('when a publish seeds', () => {
  const none = new Set<number>();

  it('seeds over a pointed active row with no usable ledger, at any keep', () => {
    for (const keep of [0, 1, 64, 65, 1000])
      expect(wantsSeed(row(3), 4, keep, none), `${keep}`).toBe(true);
    expect(wantsSeed(row(3, ledger(1, 2)), 4, 1, none)).toBe(true);
    expect(wantsSeed({ ...row(3), status: 'destroyed' }, 4, 1, none)).toBe(false);
  });

  it('seeds an incarnation’s first publish above generation 0 at a small keep, and no other', () => {
    expect(wantsSeed(null, 3, 2, none)).toBe(true);
    expect(wantsSeed(row(null), 3, 2, none)).toBe(true);
    expect(wantsSeed(null, 0, 2, none)).toBe(false);
    expect(wantsSeed(null, 3, 65, none)).toBe(false);
  });

  it('does not seed over a usable ledger after a rollback left an entry above the pointer, or when the current object is gone: the ledger gives the window', () => {
    const usable = row(3, ledger(1, 2, 3));
    expect(wantsSeed(usable, 4, 2, none)).toBe(false);
    expect(wantsSeed(row(1, ledger(2, 3, 1)), 4, 2, none)).toBe(false);
    expect(wantsSeed(row(1, ledger(2, 3, 1)), 4, 4, none)).toBe(false);
    expect(wantsSeed(row(1, ledger(2, 3, 1)), 4, 65, none)).toBe(false);
  });

  it('seeds over a ledger that names more than 64 generations below the pointer that no lease holds, at a small keep only', () => {
    const wide = row(100, ledger(...Array.from({ length: 101 }, (_, g) => g)));
    expect(wantsSeed(wide, 101, 2, none)).toBe(true);
    expect(wantsSeed(wide, 101, 100, none)).toBe(false);
    expect(wantsSeed(wide, 101, 2, new Set(Array.from({ length: 36 }, (_, g) => g)))).toBe(false);
  });
});
