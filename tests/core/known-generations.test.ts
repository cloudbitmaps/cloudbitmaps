import {
  KNOWN_FILL,
  MAX_KNOWN_GENERATIONS,
  capKnown,
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
const row = (currentGen: number | null, knownGens?: KnownGeneration[]): RegistryRecord =>
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

  it('is the entries below the pointer, unless one sits above it', () => {
    expect(windowOf(row(3, ledger(1, 2, 3)))).toEqual([1, 2]);
    expect(windowOf(row(3, ledger(3)))).toEqual([]);
    expect(windowOf(row(1, ledger(2, 3, 1)))).toBeUndefined();
    expect(windowOf(row(3, ledger(2, 1, 3)))).toEqual([2, 1]);
    expect(windowOf(row(3))).toBeUndefined();
    expect(windowOf(null)).toBeUndefined();
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
  it('seeds over a pointed active row with no usable ledger, at any keep', () => {
    for (const keep of [0, 1, 64, 65, 1000])
      expect(wantsSeed(row(3), 4, keep, false), `${keep}`).toBe(true);
    expect(wantsSeed(row(3, ledger(1, 2)), 4, 1, false)).toBe(true);
    expect(wantsSeed({ ...row(3), status: 'destroyed' }, 4, 1, false)).toBe(false);
  });

  it('seeds an incarnation’s first publish above generation 0 at a small keep, and no other', () => {
    expect(wantsSeed(null, 3, 2, false)).toBe(true);
    expect(wantsSeed(row(null), 3, 2, false)).toBe(true);
    expect(wantsSeed(null, 0, 2, false)).toBe(false);
    expect(wantsSeed(null, 3, 65, false)).toBe(false);
  });

  it('seeds over a usable ledger only after a rollback left an entry above the pointer, or the current object is gone', () => {
    const usable = row(3, ledger(1, 2, 3));
    expect(wantsSeed(usable, 4, 2, false)).toBe(false);
    expect(wantsSeed(usable, 4, 2, true)).toBe(true);
    expect(wantsSeed(usable, 4, 65, true)).toBe(false);
    const rolledBack = row(1, ledger(2, 3, 1));
    expect(wantsSeed(rolledBack, 4, 2, false)).toBe(true);
    // With keep at or above the number, today's count was skipped: the ledger is carried.
    expect(wantsSeed(rolledBack, 4, 4, false)).toBe(false);
    expect(wantsSeed(rolledBack, 4, 65, false)).toBe(false);
  });
});
