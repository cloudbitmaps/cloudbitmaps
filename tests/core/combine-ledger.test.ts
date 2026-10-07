import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  RESIDENT_BITMAP_OVERHEAD,
  ResidentLedger,
  residentBound,
  residentBytes,
  serializedBound,
} from '@/core/combine-ledger';
import { GroupCost } from '@/core/combine-many';

describe('the resident-bytes ledger', () => {
  it('charges, refuses what does not fit, releases, and keeps a high-water mark', () => {
    const ledger = new ResidentLedger(100);
    expect(ledger.tryCharge(60)).toBe(true);
    expect(ledger.tryCharge(41)).toBe(false);
    expect(ledger.used).toBe(60);
    ledger.release(30);
    expect(ledger.room).toBe(70);
    expect(ledger.tryCharge(70)).toBe(true);
    expect(ledger.highWater).toBe(100);
    ledger.release(100);
    expect(ledger.used).toBe(0);
    expect(ledger.highWater).toBe(100);
  });

  it('asks for room while a charge does not fit, and refuses when none can be made', () => {
    const ledger = new ResidentLedger(100);
    ledger.tryCharge(90);
    let freed = 0;
    expect(
      ledger.reserve(50, () => {
        if (freed >= 2) return false;
        freed++;
        ledger.release(20);
        return true;
      }),
    ).toBe(true);
    expect(ledger.used).toBe(100);
    expect(ledger.reserve(1, () => false)).toBe(false);
  });

  it('bounds a chunk by its array container, capped at a bitset', () => {
    expect(serializedBound(1)).toBe(18);
    expect(serializedBound(100)).toBe(216);
    expect(serializedBound(4_096)).toBe(8_208);
    expect(serializedBound(65_536)).toBe(8_208);
  });
});

/**
 * Resident bytes of one bitmap per chunk, measured in a fresh process each, against the model: the model must stay at or
 * above what the process holds, since a ledger under it is not a bound.
 */
describe('resident bytes of a native bitmap', () => {
  const roaringPath = createRequire(import.meta.url).resolve('roaring');
  const measure = (
    cardinality: number,
    count: number,
  ): { residentPer: number; serializedPer: number } => {
    const script = `
      const { RoaringBitmap32 } = require(${JSON.stringify(roaringPath)});
      const c = ${cardinality}, N = ${count};
      global.gc(); const base = process.memoryUsage().rss;
      const keep = []; let ser = 0;
      for (let i = 0; i < N; i++) {
        const b = new RoaringBitmap32();
        const step = Math.max(1, Math.floor(60000 / Math.max(c, 1)));
        for (let v = 0; v < c; v++) b.add(v * step + (i % 5));
        b.runOptimize();
        ser += b.getSerializationSizeInBytes('portable');
        keep.push(b);
      }
      global.gc();
      console.log(JSON.stringify({ residentPer: (process.memoryUsage().rss - base) / N, serializedPer: ser / N }));
      process.exit(keep.length === N ? 0 : 1);
    `;
    return JSON.parse(
      execFileSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' }),
    ) as {
      residentPer: number;
      serializedPer: number;
    };
  };

  it.each([1, 20, 200, 1_000, 3_000, 20_000])(
    'is bounded by the model at %i ids a chunk',
    (c) => {
      const { residentPer, serializedPer } = measure(c, 8_000);
      // A 5% allowance for the allocator's rounding at this sample size; the model carries far more than that.
      expect(residentBytes(serializedPer)).toBeGreaterThanOrEqual(residentPer * 0.95);
      expect(residentBound(c)).toBeGreaterThanOrEqual(residentBytes(serializedPer) * 0.9);
      expect(RESIDENT_BITMAP_OVERHEAD).toBeGreaterThanOrEqual(400);
    },
    60_000,
  );
});

describe('what a group is priced at', () => {
  const item = (bound: number, serializedBound: number, operands: number[], depth = 1) => ({
    bound,
    serializedBound,
    rootKeys: new Uint16Array(10),
    compiled: { operands, depth },
  });
  const stream = (i: number): number => 1_000 * (i + 1);

  it('prices the objects written beside the buffers as the largest few outputs, not as the largest every time', () => {
    const cost = new GroupCost(stream, 2);
    for (const o of [item(1_000, 100, [0]), item(1_000, 5_000, [0]), item(1_000, 90, [0])])
      cost.add(o);
    const priced = cost.with(item(1_000, 4_000, [0]));
    const others = 4 * 1_000 + stream(0) + (1 + 1 + 2) * residentBytes(8_208) + 4 * 60;
    // two are written at once: the 5,000 and the 4,000, not two of 5,000
    expect(priced).toBe(others + 5_000 + 4_000);
  });

  it("prices an output's plan keys as an upper bound for outputs with disjoint keys", () => {
    const cost = new GroupCost(stream, 1);
    const before = cost.with(item(0, 0, [0, 1]));
    cost.add(item(0, 0, [0, 1]));
    // root keys, a demand list and a fetch share for each of two operands: 10 keys of 2 bytes, (1 + 2 x 2) times
    expect(cost.with(item(0, 0, [0, 1])) - before).toBeGreaterThanOrEqual(20 * 5);
  });

  it('prices a new operand once, and an output in work that does not depend on the group', () => {
    const cost = new GroupCost(stream, 8);
    cost.add(item(100, 10, [0, 1]));
    const a = cost.with(item(100, 10, [1]));
    const b = cost.with(item(100, 10, [1]));
    expect(a).toBe(b);
    cost.add(item(100, 10, [1]));
    expect(cost.size).toBe(2);
    expect(cost.with(item(100, 10, [2])) - cost.with(item(100, 10, [1]))).toBe(stream(2) + 9_312);
  });

  it('caps what one chunk holds resident at a bitset and its overhead', () => {
    expect(residentBytes(8_208)).toBe(9_312);
    expect(residentBytes(6_016)).toBe(8_528);
    expect(residentBytes(18)).toBe(Math.ceil(512 + 28.8));
    expect(residentBound(65_536)).toBe(9_312);
  });
});
