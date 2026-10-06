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
