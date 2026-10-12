import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FULL_STRENGTH, HEAVY_SIZES, heavy } from '../helpers/strength';
import type { HeavyName } from '../helpers/strength';

// The switch that lets a pull request run smaller heavy tests must never let the full-strength run shrink. These
// are the sizes the tests carried as literals before the switch existed; changing a full size is a deliberate edit
// to this list as well as to the helper, so it cannot happen by accident.
const SIZES_BEFORE_THE_SWITCH: Record<HeavyName, number> = {
  calibrateLargeRandomLayouts: 40,
  combineManyOneGroupRuns: 30,
  combineManyRangeRuns: 20,
  combineManyFeedRuns: 60,
  combineManyFeedRangeRuns: 30,
  retentionPurgeSegments: 10_000,
  eraseNamespaceScanRows: 250_000,
  combineLedgerSamples: 8_000,
};

describe('the test-strength switch', () => {
  it('names exactly the heavy tests it was written for', () => {
    expect(Object.keys(HEAVY_SIZES).sort()).toEqual(Object.keys(SIZES_BEFORE_THE_SWITCH).sort());
  });

  it('gives each one, at full strength, exactly the size it had before the switch', () => {
    for (const [name, size] of Object.entries(HEAVY_SIZES)) {
      expect(size.full, name).toBe(SIZES_BEFORE_THE_SWITCH[name as HeavyName]);
    }
  });

  it('keeps every reduced size smaller than its full size, and above zero', () => {
    for (const [name, size] of Object.entries(HEAVY_SIZES)) {
      expect(size.reduced, name).toBeGreaterThan(0);
      expect(size.reduced, name).toBeLessThan(size.full);
    }
  });

  it('hands a test the size that matches the strength this run was started at', () => {
    for (const name of Object.keys(HEAVY_SIZES) as HeavyName[]) {
      expect(heavy(name), name).toBe(
        FULL_STRENGTH ? SIZES_BEFORE_THE_SWITCH[name] : HEAVY_SIZES[name].reduced,
      );
    }
  });

  it('is read in one place: no other test file names the variable', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.ts'),
    );
    const readers = files.filter((f) =>
      readFileSync(join(root, f), 'utf8').includes(['CB_TEST', 'STRENGTH'].join('_')),
    );
    expect(readers).toEqual([join('helpers', 'strength.ts')]);
  });
});
