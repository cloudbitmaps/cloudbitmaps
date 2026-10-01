import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The spread layout is the baseline a read that merges neighbouring chunks is judged against, so what it claims has
// to be true of the ids it yields: the same overlap as the calibration layout, shared keys spread over the whole
// segment, and the same keys every time.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Spread = {
  segments: number;
  sharedChunks: number;
  privateChunks: number;
  chunksPerSegment: number;
  idsPerChunk: number;
  idsPerSegment: number;
  stride: number;
  seed: number;
  span: number;
  sharedKeys: number[];
  keys: number[][];
  expected: { count: number; sum: number };
};
const { planSpread, spreadIds } = require_(join(ROOT, 'bench', 'lib', 'calibrate-spread.cjs')) as {
  planSpread: (i: {
    segments: number;
    sharedChunks: number;
    privateChunks: number;
    idsPerChunk: number;
    stride: number;
    seed: number;
  }) => Spread;
  spreadIds: (layout: Spread, i: number) => Iterable<number>;
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  planLayout: (i: { segments: number; idsPerSegment: number; overlap: number; stride: number }) => {
    sharedChunks: number;
    chunksPerSegment: number;
  };
};

const params = {
  segments: 4,
  sharedChunks: 50,
  privateChunks: 400,
  idsPerChunk: 40,
  stride: 1_000,
  seed: 7,
};
const L = planSpread(params);
const ids = (layout: Spread, i: number): number[] => [...spreadIds(layout, i)];

describe('the spread layout', () => {
  it('is reproducible: one seed gives the same keys and the same ids, another seed gives other keys', () => {
    const again = planSpread(params);
    expect(again).toEqual(L);
    for (const i of [0, 1, 2, 3]) expect(ids(again, i)).toEqual(ids(L, i));
    const other = planSpread({ ...params, seed: 8 });
    expect(other.sharedKeys).not.toEqual(L.sharedKeys);
    // How many ids overlap does not depend on the seed; which ids they are does.
    expect(other.expected.count).toBe(L.expected.count);
    expect(other.expected.sum).not.toBe(L.expected.sum);
  });

  it('intersects every pair in exactly the expected ids', () => {
    for (let a = 0; a < params.segments; a += 1) {
      for (let b = a + 1; b < params.segments; b += 1) {
        const other = new Set(ids(L, b));
        const both = ids(L, a).filter((id) => other.has(id));
        expect(both.length).toBe(L.expected.count);
        expect(both.reduce((acc, id) => acc + id, 0)).toBe(L.expected.sum);
      }
    }
  });

  // Chunk-skipping fetches by key, so the property that decides what a run measures is chunk overlap: two segments
  // sharing a private key would add reads without adding a shared id.
  it('shares exactly the planned chunks between every pair, and no private chunk between any two', () => {
    const keys = (i: number): Set<number> =>
      new Set(ids(L, i).map((id) => Math.floor(id / 65_536)));
    for (let a = 0; a < params.segments; a += 1) {
      for (let b = a + 1; b < params.segments; b += 1) {
        const kb = keys(b);
        const common = [...keys(a)].filter((k) => kb.has(k));
        expect(common.sort((x, y) => x - y)).toEqual(L.sharedKeys);
      }
    }
    for (let i = 0; i < params.segments; i += 1) {
      expect(keys(i).size).toBe(L.chunksPerSegment);
      expect(ids(L, i).length).toBe(L.idsPerSegment);
    }
  });

  it('spreads the shared keys over the whole span, one to each equal stratum', () => {
    const { sharedKeys, span, sharedChunks } = L;
    expect(sharedKeys).toHaveLength(sharedChunks);
    expect([...sharedKeys].sort((a, b) => a - b)).toEqual(sharedKeys);
    sharedKeys.forEach((key, j) => {
      expect(key).toBeGreaterThanOrEqual(Math.floor((j * span) / sharedChunks));
      expect(key).toBeLessThan(Math.floor(((j + 1) * span) / sharedChunks));
    });
    // No two shared keys are adjacent, which is the calibration layout's shape, and none is further from the next
    // than two strata.
    for (let j = 1; j < sharedKeys.length; j += 1) {
      const gap = (sharedKeys[j] ?? 0) - (sharedKeys[j - 1] ?? 0);
      expect(gap).toBeGreaterThan(1);
      expect(gap).toBeLessThanOrEqual(2 * Math.ceil(span / sharedChunks));
    }
    expect((sharedKeys[sharedKeys.length - 1] ?? 0) - (sharedKeys[0] ?? 0)).toBeGreaterThan(
      0.9 * span * (1 - 2 / sharedChunks),
    );
    // Each segment's own keys are spread over the span too, so a segment's shared chunks have its other chunks
    // between them in the object.
    for (const own of L.keys) {
      expect(own[own.length - 1] ?? 0).toBeGreaterThan(0.95 * span);
      expect(own[0] ?? span).toBeLessThan(0.05 * span);
    }
  });

  it('yields ascending u32 ids with every chunk the same size', () => {
    for (let i = 0; i < params.segments; i += 1) {
      const all = ids(L, i);
      for (let k = 1; k < all.length; k += 1) expect(all[k]).toBeGreaterThan(all[k - 1] ?? -1);
      expect(all[all.length - 1]).toBeLessThanOrEqual(0xffff_ffff);
      const perChunk = new Map<number, number>();
      for (const id of all) perChunk.set(id >>> 16, (perChunk.get(id >>> 16) ?? 0) + 1);
      expect(new Set(perChunk.values())).toEqual(new Set([params.idsPerChunk]));
    }
  });

  // The calibration layout shares 100 of 1,999 chunks; this one has to be the same overlap, or the two stages are not
  // comparable.
  it("has the calibration layout's overlap at the harness defaults", () => {
    const cal = guards.planLayout({
      segments: 10,
      idsPerSegment: 500_000,
      ...guards.DEFAULT_LAYOUT,
    });
    const spread = planSpread({
      segments: 10,
      sharedChunks: cal.sharedChunks,
      privateChunks: cal.chunksPerSegment - cal.sharedChunks,
      idsPerChunk: Math.round(500_000 / cal.chunksPerSegment),
      stride: guards.DEFAULT_LAYOUT.stride,
      seed: 1,
    });
    expect(spread.sharedChunks).toBe(100);
    expect(spread.chunksPerSegment).toBe(cal.chunksPerSegment);
    expect(spread.idsPerSegment).toBeGreaterThan(499_000);
    expect(spread.idsPerSegment).toBeLessThanOrEqual(500_000);
  });

  it('refuses what cannot be what it claims', () => {
    expect(() => planSpread({ ...params, segments: 0 })).toThrow(/positive integer/);
    expect(() => planSpread({ ...params, seed: -1 })).toThrow(/seed/);
    expect(() => planSpread({ ...params, seed: 1.5 })).toThrow(/seed/);
    // 40 ids 2,000 apart leave the chunk: the shared chunks would not be the planned ones.
    expect(() => planSpread({ ...params, stride: 2_000 })).toThrow(/do not fit in one chunk/);
    expect(() => planSpread({ ...params, segments: 100, privateChunks: 1_000 })).toThrow(
      /32-bit id space/,
    );
    expect(() => spreadIds(L, 9)[Symbol.iterator]().next()).toThrow(/not in a layout/);
  });
});
