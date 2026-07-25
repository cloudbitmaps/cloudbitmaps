import { SeededRng } from '@/testing/simulator';

describe('SeededRng (mulberry32)', () => {
  it('is a pure function of the seed: same seed → identical stream', () => {
    const a = new SeededRng(12345);
    const b = new SeededRng(12345);
    const sa = Array.from({ length: 1000 }, () => a.next());
    const sb = Array.from({ length: 1000 }, () => b.next());
    expect(sa).toEqual(sb);
  });

  it('different seeds produce different streams', () => {
    const a = Array.from({ length: 50 }, () => new SeededRng(1).next());
    const b = Array.from({ length: 50 }, () => new SeededRng(2).next());
    expect(a).not.toEqual(b);
  });

  it('next() stays in [0, 1)', () => {
    const r = new SeededRng(7);
    for (let i = 0; i < 100_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('normalizes negative and large seeds into u32 deterministically', () => {
    // -1 >>> 0 === 0xffffffff, and 0xffffffff is already in range → identical streams.
    const neg = new SeededRng(-1);
    const big = new SeededRng(0xffff_ffff);
    expect(Array.from({ length: 20 }, () => neg.next())).toEqual(
      Array.from({ length: 20 }, () => big.next()),
    );
  });

  it('rejects a non-integer seed', () => {
    expect(() => new SeededRng(1.5)).toThrow(TypeError);
  });

  describe('nextInt', () => {
    it('stays in [0, bound) and covers the whole range', () => {
      const r = new SeededRng(99);
      const seen = new Set<number>();
      for (let i = 0; i < 10_000; i++) {
        const v = r.nextInt(6);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(6);
        seen.add(v);
      }
      expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('rejects a non-positive or non-integer bound', () => {
      const r = new SeededRng(1);
      expect(() => r.nextInt(0)).toThrow(RangeError);
      expect(() => r.nextInt(-3)).toThrow(RangeError);
      expect(() => r.nextInt(2.5)).toThrow(RangeError);
    });
  });

  describe('helpers', () => {
    it('bool(p) roughly honors the probability', () => {
      const r = new SeededRng(2024);
      let hits = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) if (r.bool(0.25)) hits++;
      expect(hits / n).toBeGreaterThan(0.2);
      expect(hits / n).toBeLessThan(0.3);
    });

    it('bool(0) is never true and bool(1) is always true', () => {
      const r = new SeededRng(3);
      for (let i = 0; i < 1000; i++) {
        expect(r.bool(0)).toBe(false);
        expect(r.bool(1)).toBe(true);
      }
    });

    it('pick returns an element and throws on empty', () => {
      const r = new SeededRng(5);
      const items = ['a', 'b', 'c'] as const;
      for (let i = 0; i < 100; i++) expect(items).toContain(r.pick(items));
      expect(() => r.pick([])).toThrow(RangeError);
    });
  });
});
