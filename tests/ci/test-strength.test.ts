import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_SCAN_SEGMENTS } from '@/core/registry-scan';
import { HEAVY_SIZES } from '../helpers/strength';
import type { HeavyName } from '../helpers/strength';
import { readYaml } from '../helpers/workflows';

// The switch that lets a pull request run smaller heavy tests must never let the full-strength run shrink. These
// are the sizes the tests carried as literals before they were reduced; changing a full size is a deliberate edit
// to this list as well as to the helper, so it cannot happen by accident. Adding a heavy test means a row here.
const SIZES_BEFORE_THE_REDUCTION: Record<HeavyName, number> = {
  calibrateLargeRandomLayouts: 40,
  combineManyOneGroupRuns: 30,
  combineManyRangeRuns: 20,
  combineManyFeedRuns: 60,
  combineManyFeedRangeRuns: 30,
  retentionPurgeSegments: 10_000,
  eraseNamespaceScanRows: 250_000,
  combineLedgerSamples: 8_000,
  // Added with the switch already in place: the size it was written at.
  sortedLoadHeapIds: 10_000_000,
};

const TESTS = fileURLToPath(new URL('..', import.meta.url));
const VARIABLE = ['CB_TEST', 'STRENGTH'].join('_');
const names = Object.keys(HEAVY_SIZES) as HeavyName[];

/** Every heavy size as the switch hands it out when the variable is `value`: the helper imported afresh. */
async function sizesWhen(value: string | undefined): Promise<Record<string, number>> {
  const saved = process.env[VARIABLE];
  if (value === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = value;
  try {
    vi.resetModules();
    const fresh = await import('../helpers/strength');
    return Object.fromEntries(names.map((n) => [n, fresh.heavy(n)]));
  } finally {
    if (saved === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = saved;
    vi.resetModules();
  }
}

describe('the test-strength switch', () => {
  it('names exactly the heavy tests it was written for', () => {
    expect(names.sort()).toEqual(Object.keys(SIZES_BEFORE_THE_REDUCTION).sort());
  });

  it('keeps each full size at the size it had before the reduction', () => {
    for (const name of names)
      expect(HEAVY_SIZES[name].full, name).toBe(SIZES_BEFORE_THE_REDUCTION[name]);
  });

  it('keeps every reduced size smaller than its full size, and above zero', () => {
    for (const name of names) {
      expect(HEAVY_SIZES[name].reduced, name).toBeGreaterThan(0);
      expect(HEAVY_SIZES[name].reduced, name).toBeLessThan(HEAVY_SIZES[name].full);
    }
  });

  it('hands out the full sizes when the variable is full and the reduced ones when it is unset, whatever this run is', async () => {
    const full = await sizesWhen('full');
    const reduced = await sizesWhen(undefined);
    for (const name of names) {
      expect(full[name], name).toBe(SIZES_BEFORE_THE_REDUCTION[name]);
      expect(reduced[name], name).toBe(HEAVY_SIZES[name].reduced);
    }
  });

  it('throws on any other value: a misspelling, and the empty string a variable expands to when unset', async () => {
    await expect(sizesWhen('Full')).rejects.toThrow(/must be unset or "full"/);
    await expect(sizesWhen('')).rejects.toThrow(/must be unset or "full"/);
  });

  it('is asked for by the test it sizes: each name, through heavy(), in its own file', () => {
    for (const name of names) {
      const file = HEAVY_SIZES[name].file;
      // Whitespace allowed inside the call: the formatter splits a long one across lines.
      expect(
        readFileSync(join(TESTS, file), 'utf8'),
        `${file} no longer asks heavy('${name}'), so its size is no longer the switch's`,
      ).toMatch(new RegExp(String.raw`\bheavy\(\s*'${name}'\s*,?\s*\)`));
    }
  });

  it('holds the scan rows to the shared default ceiling they stand for', () => {
    expect(HEAVY_SIZES.eraseNamespaceScanRows.full).toBe(DEFAULT_MAX_SCAN_SEGMENTS);
  });

  it('is read in one place: no other test file names the variable', () => {
    const files = (readdirSync(TESTS, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.ts'),
    );
    const readers = files.filter((f) => readFileSync(join(TESTS, f), 'utf8').includes(VARIABLE));
    expect(readers).toEqual([join('helpers', 'strength.ts')]);
  });

  it('is on for the nightly lane: every step that runs the unit suite has the variable set to full', () => {
    type Wf = {
      jobs: Record<
        string,
        { env?: Record<string, string>; steps: { run?: string; env?: Record<string, string> }[] }
      >;
    };
    const wf = readYaml<Wf>('.github/workflows/full-nightly.yml');
    const steps = Object.values(wf.jobs).flatMap((job) =>
      job.steps.filter((s) => s.run === 'pnpm test').map((step) => ({ job, step })),
    );
    expect(steps.length, 'the nightly workflow no longer runs pnpm test').toBeGreaterThan(0);
    for (const { job, step } of steps) {
      expect(step.env?.[VARIABLE] ?? job.env?.[VARIABLE]).toBe('full');
    }
  });
});
