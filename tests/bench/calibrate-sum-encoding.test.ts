import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
  accountIdPaths: (text: string) => string[];
};
const countsLib = require_(lib('multi-counts.cjs')) as {
  countMulti: (i: {
    engine: unknown;
    pools?: string[];
  }) => Promise<{ pools: unknown[]; shapes: { pool: string }[] }>;
};
const batchCounts = require_(lib('batch-counts.cjs')) as {
  countBatch: (i: { shape: string; engine: unknown }) => Promise<unknown>;
};
const evidenceLib = require_(lib('multi-evidence.cjs')) as {
  multiRunProblems: (run: unknown, o?: { rehearsal?: boolean }) => string[];
};
const { planMultiPool, MULTI_POOLS } = require_(lib('calibrate-multi-stages.cjs')) as {
  planMultiPool: (n: string) => { expected: { count: number; sum: number } };
  MULTI_POOLS: Record<string, unknown>;
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
  // Only the pools whose planned checksum is twelve digits are counted. `countMulti` refuses a read whose sum differs from
  // the plan, so the planned sums are every checksum a multi file holds, and the other pools' cannot make the run the scan
  // refuses. Counting every pool (operands of up to 5,000,000 ids) took up to 6.0 s on the pull request's CI runs and 9.7 s
  // on main's; this one pool takes 0.4 s locally, so it runs under vitest's 5 s default, and the budget check names it
  // once it reaches 35 % of that.
  it('for the multi suite’s real workload, whose layouts include a 12-digit sum', async () => {
    const twelve = Object.keys(MULTI_POOLS).filter(
      (n) => String(planMultiPool(n).expected.sum).length === 12,
    );
    expect(twelve.length).toBeGreaterThan(0);
    const { pools, shapes } = await countsLib.countMulti({ engine, pools: twelve });
    expect(pools).toHaveLength(twelve.length);
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.every((s) => twelve.includes(s.pool))).toBe(true);
    const workload = { reads: 1, pools, shapes };
    // The control: the workload does hold a twelve-digit sum, so a bare number would have failed the scan.
    expect(ACCOUNT_ID.test(JSON.stringify(workload))).toBe(true);
    const text = processLib.resultsJson({ suite: 'multi', workload });
    expect(text).not.toMatch(ACCOUNT_ID);
    expect(text).toMatch(/"sum": "\d{1,3}(_\d{3})*"/);
  });

  // Budget 9 s (the default is 5 s): the small batch shape is counted in memory. The slowest time CI has measured is 2.84 s,
  // on node 22. Rule: the slowest measured time x 3, rounded up.
  it('for the batch suite’s real workload', async () => {
    const counts = await batchCounts.countBatch({ shape: 'small', engine });
    expect(processLib.resultsJson({ suite: 'batch', workload: counts })).not.toMatch(ACCOUNT_ID);
  }, 9_000);

  // These two recorded files hold no checksum (the large suite writes none), so they guard the older rounding of ratios.
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

describe('resultsJson on a file that cannot be made clean', () => {
  it('writes a sum that is not a checksum like any number, and never throws', () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const text = processLib.resultsJson({ sum: bad });
      expect(JSON.parse(text).sum).toBe(bad);
    }
    expect(JSON.parse(processLib.resultsJson({ sum: 0.1 + 0.2 })).sum).toBe(0.3);
  });

  it('still writes a file that holds a standalone 12-digit run, and warns where, naming the scan', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const text = processLib.resultsJson({
        workload: { pools: [{ id: TWELVE }], note: 'x' },
        clean: 'a_122_497_550_000',
      });
      expect(JSON.parse(text).workload.pools[0].id).toBe(TWELVE);
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0]![0]);
      expect(said).toContain('workload.pools[0].id');
      expect(said).not.toContain('clean');
      expect(said).toMatch(/pnpm leak-scan/);
      expect(said).toMatch(/still written/);
    } finally {
      warn.mockRestore();
    }
  });

  it('is silent for a clean file', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      processLib.resultsJson({ sum: TWELVE });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('every results-file writer goes through resultsJson', () => {
  const harness = [
    join(ROOT, 'bench', 'calibrate-aws.cjs'),
    ...readdirSync(join(ROOT, 'bench', 'lib'))
      .filter((f) => f.startsWith('calibrate-') && f.endsWith('.cjs'))
      .map((f) => join(ROOT, 'bench', 'lib', f)),
  ];
  // A results object serialized anywhere but resultsJson, or a results file written with other text.
  const strayWriters = (name: string, source: string): string[] => {
    const out: string[] = [];
    if (!name.endsWith('calibrate-process.cjs')) {
      for (const m of source.matchAll(/JSON\.stringify\(\s*(results|run|partial|summary)\b/g)) {
        out.push(`${name}: ${m[0]}`);
      }
    }
    for (const m of source.matchAll(/writeResultsFile\(\{[^}]*?\btext:\s*([^,\n]+)/g)) {
      if (!/^resultsJson\(/.test(m[1]!.trim()))
        out.push(`${name}: writeResultsFile text is ${m[1]!.trim()}`);
    }
    return out;
  };

  it('holds on the real harness, which has a writer', () => {
    const calls = readFileSync(harness[0]!, 'utf8').match(/writeResultsFile\(\{/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const f of harness) expect(strayWriters(f, readFileSync(f, 'utf8')), f).toEqual([]);
  });

  it('fails on a second writer that serializes a results object itself', () => {
    const real = readFileSync(harness[0]!, 'utf8');
    const planted = `${real}\nwriteFileSync(other, JSON.stringify(results, null, 2));\n`;
    expect(strayWriters('planted', planted)).toHaveLength(1);
    const plantedText = real.replace('text: resultsJson(results)', 'text: String(results)');
    expect(strayWriters('planted', plantedText)).toHaveLength(1);
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
  const PLAN = planMultiPool('a').expected;
  const PLAN_SUM = guards.groupSum(PLAN.sum);
  const run = (sum: unknown, poolSum: unknown = PLAN_SUM) => ({
    suite: 'multi',
    partial: false,
    workload: {
      reads: 1,
      pools: [{ name: 'a', expected: { count: PLAN.count, sum: poolSum } }],
      shapes: [{ name: 'k3', pool: 'a', counts: { intersect: { sum } } }],
    },
  });
  const sumProblems = (r: unknown) => evidenceLib.multiRunProblems(r).filter((p) => /sum/.test(p));

  it('accepts matching grouped sums', () => {
    expect(sumProblems(run(PLAN_SUM))).toEqual([]);
  });

  it('refuses a JSON number, a malformed string, a missing sum and a shape that disagrees with its pool', () => {
    expect(sumProblems(run(TWELVE, TWELVE)).join('\n')).toMatch(/grouped by "_"/);
    expect(sumProblems(run(String(PLAN.sum))).join('\n')).toMatch(
      new RegExp(`shape k3 intersect sum is "${PLAN.sum}"`),
    );
    expect(sumProblems(run(undefined)).join('\n')).toMatch(/shape k3 intersect sum/);
    expect(sumProblems(run(guards.groupSum(PLAN.sum + 1))).join('\n')).toMatch(
      new RegExp(`is not its pool's ${PLAN.sum}`),
    );
  });

  it('refuses a shape whose pool is not among the recorded pools', () => {
    const r = run(PLAN_SUM);
    r.workload.shapes[0]!.pool = 'elsewhere';
    expect(evidenceLib.multiRunProblems(r).join('\n')).toMatch(
      /shape k3 names pool elsewhere, which the workload does not record/,
    );
  });
});

describe('the multi evidence gate reports a malformed workload and holds each pool to the plan', () => {
  const planned = (name: string) => planMultiPool(name).expected;
  const problems = (workload: unknown) =>
    evidenceLib.multiRunProblems({ suite: 'multi', partial: false, workload }).join('\n');

  it('does not throw for pools or shapes that are not lists, or that hold a null', () => {
    for (const w of [
      { reads: 1, pools: 'x', shapes: [] },
      { reads: 1, pools: [null], shapes: [null] },
      { reads: 1, pools: {}, shapes: 5 },
    ]) {
      expect(() => problems(w)).not.toThrow();
    }
    expect(problems({ reads: 1, pools: 'x' })).toMatch(/pools is "x", not a list/);
    expect(problems({ reads: 1, shapes: 5 })).toMatch(/shapes is 5, not a list/);
    expect(problems({ reads: 1, pools: [null] })).toMatch(/pool 0 is null/);
    expect(problems({ reads: 1, shapes: [null] })).toMatch(/shape 0 is null/);
  });

  it('reports an unnamed pool and a pool recorded twice', () => {
    const a = planned('a');
    const pool = { name: 'a', expected: { count: a.count, sum: guards.groupSum(a.sum) } };
    expect(problems({ reads: 1, pools: [{ expected: pool.expected }] })).toMatch(
      /pool 0 has no name/,
    );
    expect(problems({ reads: 1, pools: [pool, pool] })).toMatch(
      /pool a is recorded more than once/,
    );
    expect(problems({ reads: 1, pools: [pool] })).not.toMatch(/pool a/);
  });

  it('refuses a pool whose count or sum is not the plan’s, and one the suite does not have', () => {
    const a = planned('a');
    const wrong = (count: number, sum: number) => ({
      reads: 1,
      pools: [{ name: 'a', expected: { count, sum: guards.groupSum(sum) } }],
    });
    expect(problems(wrong(a.count + 1, a.sum))).toMatch(/pool a records count/);
    expect(problems(wrong(a.count, a.sum + 1))).toMatch(/where the suite's plan is/);
    expect(
      problems({ reads: 1, pools: [{ name: 'zz', expected: { count: 1, sum: '1' } }] }),
    ).toMatch(/pool zz is not a pool of the multi suite/);
  });
});
