import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

// An id-range checksum is a sum of ids and can be any number of digits. Written as a bare JSON number it can be exactly
// twelve, the run the leak scan refuses as a possible account id, and evidence is committed unedited, so the file could not
// land. Every checksum a results file holds is therefore written grouped by `_`, through one helper, and read back through
// one. This is the detector: it serializes what each suite writes and holds it to the leak scan's own rule.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const lib = (name: string) => join(ROOT, 'bench', 'lib', name);

// The leak scan's account-id rule, held to a copy by the test below it (the scan is a script, not a module).
const ACCOUNT_ID = /\b\d{12}\b/;
// A twelve-digit checksum, written with separators so this file holds no standalone twelve-digit run itself.
const TWELVE = 122_497_550_000;

const guards = require_(lib('calibrate-guards.cjs')) as {
  groupSum: (n: number) => string;
  parseSum: (text: unknown, what?: string) => number;
};
const processLib = require_(lib('calibrate-process.cjs')) as {
  resultsJson: (results: unknown) => string;
};
const countsLib = require_(lib('multi-counts.cjs')) as {
  countMulti: (i: { engine: unknown }) => Promise<{ pools: unknown[]; shapes: unknown[] }>;
};
const batchCounts = require_(lib('batch-counts.cjs')) as {
  countBatch: (i: { shape: string; engine: unknown }) => Promise<unknown>;
};
const evidenceLib = require_(lib('multi-evidence.cjs')) as {
  multiRunProblems: (run: unknown) => string[];
};
const engine = { CloudRoaring, MemoryStorage };

describe('the detector', () => {
  it('is the leak scan’s own account-id rule', () => {
    const scan = readFileSync(join(ROOT, 'scripts', 'leak-scan.cjs'), 'utf8');
    expect(scan).toContain(
      `{ name: 'AWS account id (a standalone 12-digit run)', re: ${String(ACCOUNT_ID)} }`,
    );
  });

  it('fires on a bare twelve-digit number and not on the grouped form', () => {
    expect(ACCOUNT_ID.test(JSON.stringify({ sum: TWELVE }))).toBe(true);
    expect(ACCOUNT_ID.test(JSON.stringify({ sum: '122_497_550_000' }))).toBe(false);
    expect(ACCOUNT_ID.test(JSON.stringify({ sum: 12249755000 }))).toBe(false);
  });
});

describe('a results file never holds a standalone 12-digit run', () => {
  it('for the multi suite’s real workload, whose layouts include a 12-digit sum', async () => {
    const { pools, shapes } = await countsLib.countMulti({ engine });
    const workload = { reads: 1, pools, shapes };
    // The control: the workload does hold a twelve-digit sum, so a bare number would have failed the scan.
    expect(ACCOUNT_ID.test(JSON.stringify(workload))).toBe(true);
    const text = processLib.resultsJson({ suite: 'multi', workload });
    expect(text).not.toMatch(ACCOUNT_ID);
    expect(text).toMatch(/"sum": "\d{1,3}(_\d{3})*"/);
  }, 60_000);

  it('for the batch suite’s real workload', async () => {
    for (const shape of ['small', 'refresh']) {
      const counts = await batchCounts.countBatch({ shape, engine });
      expect(processLib.resultsJson({ suite: 'batch', workload: counts })).not.toMatch(ACCOUNT_ID);
    }
  }, 60_000);

  it('for the default and large suites’ recorded rehearsal files', () => {
    for (const name of ['calibration-rehearsal.json', 'calibration-large-rehearsal.json']) {
      const text = readFileSync(join(ROOT, 'tests', 'bench', 'fixtures', name), 'utf8');
      expect(processLib.resultsJson(JSON.parse(text)), name).not.toMatch(ACCOUNT_ID);
    }
  });

  it('wherever a sum sits in the file, and for a partial or rehearsal file alike', () => {
    const run = {
      partial: true,
      workload: { pools: [{ expected: { count: 3, sum: TWELVE } }] },
    };
    const text = processLib.resultsJson(run);
    expect(text).not.toMatch(ACCOUNT_ID);
    expect(JSON.parse(text).workload.pools[0].expected.sum).toBe('122_497_550_000');
  });
});

describe('the one helper that writes a checksum', () => {
  it.each([
    [0, '0'],
    [9, '9'],
    [999, '999'],
    [1000, '1_000'],
    [9000, '9_000'],
    [TWELVE, '122_497_550_000'],
    [Number.MAX_SAFE_INTEGER, '9_007_199_254_740_991'],
  ])('writes %d as %s', (n, grouped) => {
    expect(guards.groupSum(n)).toBe(grouped);
    expect(guards.parseSum(grouped)).toBe(n);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '5' as unknown as number])(
    'refuses to write %s',
    (n) => {
      expect(() => guards.groupSum(n)).toThrow(/non-negative safe integer/);
    },
  );

  it('leaves a sum that is already a string as it is, so a parsed file writes back the same', () => {
    const text = processLib.resultsJson({ sum: '9_000' });
    expect(JSON.parse(text).sum).toBe('9_000');
  });
});

describe('the one helper that reads a checksum', () => {
  it.each([
    TWELVE,
    9000,
    String(TWELVE),
    '1_00',
    '1__000',
    '_1_000',
    '1_000_',
    '01_000',
    '00',
    '1,000',
    ' 9_000',
    '9_000 ',
    '',
    null,
    '9_007_199_254_740_992',
  ])('refuses %j', (bad) => {
    expect(() => guards.parseSum(bad, 'the sum')).toThrow(/the sum/);
  });
});

describe('the multi evidence gate reads checksums through it', () => {
  const run = (sum: unknown, poolSum: unknown = '9_000') => ({
    suite: 'multi',
    partial: false,
    workload: {
      reads: 1,
      pools: [{ name: 'a', expected: { count: 3, sum: poolSum } }],
      shapes: [{ name: 'k3', pool: 'a', counts: { intersect: { sum } } }],
    },
  });
  const sumProblems = (r: unknown) => evidenceLib.multiRunProblems(r).filter((p) => /sum/.test(p));

  it('accepts matching grouped sums', () => {
    expect(sumProblems(run('9_000'))).toEqual([]);
  });

  it('refuses a JSON number, a malformed string, a missing sum and a shape that disagrees with its pool', () => {
    expect(sumProblems(run(TWELVE, TWELVE)).join('\n')).toMatch(/grouped by "_"/);
    expect(sumProblems(run('9000')).join('\n')).toMatch(/shape k3 intersect sum is "9000"/);
    expect(sumProblems(run(undefined)).join('\n')).toMatch(/shape k3 intersect sum/);
    expect(sumProblems(run('9_001')).join('\n')).toMatch(/is not its pool's 9000/);
  });

  it('refuses a shape whose pool is not among the recorded pools', () => {
    const r = run('9_000');
    r.workload.shapes[0]!.pool = 'elsewhere';
    expect(evidenceLib.multiRunProblems(r).join('\n')).toMatch(
      /shape k3 names pool elsewhere, which the workload does not record/,
    );
  });
});
