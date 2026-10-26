import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoaringBitmap } from '@/index';
import { TsBitmap } from '@/ts-roaring/bitmap';
import type { Container } from '@/ts-roaring/containers';

/**
 * Which containers each combine that returns a new bitmap flags shared, and which container objects it hands back.
 * The flag is what makes a kept container safe (a write copies a shared container first) and what an intersection must
 * not pay for, so a combine that flags more than it keeps, or keeps what it does not flag, is a defect that no answer
 * shows. A container is read through `has`, which hands the container it reads to the kernel: the mock below records it.
 */
const seen = vi.hoisted(() => ({ last: undefined as unknown, pairs: [] as unknown[][] }));

vi.mock('@/ts-roaring/containers', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/ts-roaring/containers')>();
  const pair = <F extends (a: Container, b: Container, inPlace?: boolean) => Container | null>(
    f: F,
  ): F =>
    ((a: Container, b: Container, inPlace?: boolean) => {
      const out = f(a, b, inPlace);
      seen.pairs.push([a, b, inPlace, out]);
      return out;
    }) as F;
  return {
    ...real,
    containerHas: (c: Container, low: number) => {
      seen.last = c;
      return real.containerHas(c, low);
    },
    containerAnd: pair(real.containerAnd),
    containerOr: pair(real.containerOr),
    containerAndNot: pair(real.containerAndNot),
  };
});

beforeEach(() => {
  seen.pairs.length = 0;
});

/**
 * Keys 0, 1 and 8 only in `a`; 2 and 3 in both; 4 (met while `a` still has keys left) and 9 (after `a`'s run out) only in `b`.
 */
const KEYS_A = [0, 1, 2, 3, 8];
const KEYS_B = [2, 3, 4, 9];
const A_ONLY = [0, 1, 8];
const BOTH = [2, 3];
const B_ONLY = [4, 9];

/** A container of each kind by key: an array, a bitset, a run (kept by `runOptimize`) and a few ids. */
function idsFor(keys: number[], salt: number): number[] {
  const ids: number[] = [];
  for (const key of keys) {
    const base = key * 65_536;
    const shape = (key + salt) % 4;
    for (let i = 0; i < 6; i++) ids.push(base + 100 + i); // common to every container, so a pair intersects
    if (shape === 0) for (let i = 0; i < 100; i++) ids.push(base + i * 5);
    else if (shape === 1) for (let i = 0; i < 6_000; i++) ids.push(base + i * 7);
    else if (shape === 2) for (let i = 0; i < 3_000; i++) ids.push(base + 100 + i);
    else ids.push(base + 1, base + 9, base + 65_535);
  }
  return ids;
}

/** The container object each key holds, read through `has`. */
function containersOf(has: (id: number) => boolean, keys: number[]): Map<number, Container> {
  const out = new Map<number, Container>();
  for (const key of keys) {
    seen.last = undefined;
    has(key * 65_536);
    expect(seen.last, `key ${key} is held`).toBeDefined();
    out.set(key, seen.last as Container);
  }
  return out;
}

function operands(): {
  a: TsBitmap;
  b: TsBitmap;
  ca: Map<number, Container>;
  cb: Map<number, Container>;
} {
  const a = TsBitmap.fromValues(idsFor(KEYS_A, 0));
  const b = TsBitmap.fromValues(idsFor(KEYS_B, 1));
  a.optimize();
  b.optimize();
  const ca = containersOf((id) => a.has(id), KEYS_A);
  const cb = containersOf((id) => b.has(id), KEYS_B);
  for (const c of [...ca.values(), ...cb.values()])
    expect(c.shared, 'a fresh operand holds no shared container').toBe(false);
  return { a, b, ca, cb };
}

const flags = (m: Map<number, Container>): Record<number, boolean> =>
  Object.fromEntries([...m].map(([k, c]) => [k, c.shared]));
const allFlags = (keys: number[], value: boolean): Record<number, boolean> =>
  Object.fromEntries(keys.map((k) => [k, value]));

describe('the combines that return a new bitmap: which containers they flag and keep', () => {
  it('and flags nothing and keeps no container of either operand', () => {
    const { a, b, ca, cb } = operands();
    const out = TsBitmap.and(a, b);
    const cr = containersOf((id) => out.has(id), BOTH);
    expect(flags(ca)).toEqual(allFlags(KEYS_A, false));
    expect(flags(cb)).toEqual(allFlags(KEYS_B, false));
    expect(flags(cr)).toEqual(allFlags(BOTH, false));
    for (const c of cr.values()) expect([...ca.values(), ...cb.values()]).not.toContain(c);
    for (const key of [...A_ONLY, ...B_ONLY]) expect(out.has(key * 65_536 + 1)).toBe(false);
  });

  it.each([
    ['or', (a: TsBitmap, b: TsBitmap) => TsBitmap.or(a, b), [...KEYS_A, ...B_ONLY]],
    ['xor', (a: TsBitmap, b: TsBitmap) => TsBitmap.xor(a, b), [...KEYS_A, ...B_ONLY]],
    ['andNot', (a: TsBitmap, b: TsBitmap) => TsBitmap.andNot(a, b), KEYS_A],
  ] as const)(
    '%s flags exactly the containers only the first operand holds, and keeps those objects',
    (_name, run, resultKeys) => {
      const { a, b, ca, cb } = operands();
      const out = run(a, b);
      const cr = containersOf((id) => out.has(id), [...resultKeys]);
      expect(flags(ca)).toEqual({ ...allFlags(A_ONLY, true), ...allFlags(BOTH, false) });
      expect(flags(cb)).toEqual(allFlags(KEYS_B, false));
      // The a-only containers are the operand's own objects (kept, flagged); nothing else of either operand is.
      for (const key of A_ONLY) expect(cr.get(key)).toBe(ca.get(key));
      for (const key of BOTH) {
        expect(cr.get(key)).not.toBe(ca.get(key));
        expect(cr.get(key)).not.toBe(cb.get(key));
        expect(cr.get(key)?.shared, `the result's own container at ${key}`).toBe(false);
      }
      for (const key of B_ONLY.filter((k) => (resultKeys as readonly number[]).includes(k))) {
        expect(cr.get(key)).not.toBe(cb.get(key));
        expect(cr.get(key)?.shared, `the copy of b's container at ${key}`).toBe(false);
      }
    },
  );

  it('the pair kernels never run in place and never return an operand object', () => {
    for (const run of [TsBitmap.and, TsBitmap.or, TsBitmap.xor, TsBitmap.andNot]) {
      seen.pairs.length = 0;
      const { a, b } = operands();
      seen.pairs.length = 0;
      run.call(TsBitmap, a, b);
      expect(seen.pairs.length).toBeGreaterThan(0);
      for (const [x, y, inPlace, out] of seen.pairs) {
        if (inPlace === true) continue; // xor's last step, on the union's own fresh container
        expect(out).not.toBe(x);
        expect(out).not.toBe(y);
      }
      // xor's trailing in-place step takes its first argument from the union it just built, never an operand's.
      const operandsHeld = new Set<unknown>([
        ...containersOf((id) => a.has(id), KEYS_A).values(),
        ...containersOf((id) => b.has(id), KEYS_B).values(),
      ]);
      for (const [x, , inPlace] of seen.pairs)
        if (inPlace === true) expect(operandsHeld.has(x)).toBe(false);
    }
  });

  it('orMany flags no container of its parts and keeps none', () => {
    const parts = [KEYS_A, KEYS_B, [1, 4, 6]].map((keys, i) => new RoaringBitmap(idsFor(keys, i)));
    const held = parts.map((p, i) =>
      containersOf((id) => p.has(id), [KEYS_A, KEYS_B, [1, 4, 6]][i] as number[]),
    );
    const out = RoaringBitmap.orMany(parts);
    const kept = containersOf((id) => out.has(id), [0, 1, 2, 3, 4, 6, 8, 9]);
    for (const m of held) {
      for (const c of m.values()) expect(c.shared).toBe(false);
      for (const c of m.values()) expect([...kept.values()]).not.toContain(c);
    }
    for (const c of kept.values()) expect(c.shared).toBe(false);
  });
});
