import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

// The multi suite (`--suite multi`): an `intersect` over three to ten operands, measured on S3. It is a suite of its own,
// with its own stages, bound, expected counts and evidence directory, so the default, large and batch suites' projections and
// evidence cannot move. Each claim it makes is held here against the real engine or against plain arithmetic.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const harnessSrc = src('bench', 'calibrate-aws.cjs');

type Bound = { put: number; get: number };
type Content = { count: number; sum: number };
type Pool = {
  name: string;
  kind: string;
  operands: number;
  idsPerOperand: number;
  sharedChunks: number;
  chunksPerOperand: number;
  stride: number;
  expected: Content;
  operandBytes: number[];
  bandChunks?: number;
};
type Counted = {
  pointer: number;
  tail: number;
  range: number;
  rangeBytes: number;
  gets: number;
};
type Shape = {
  name: string;
  group: string;
  pool: string;
  k: number;
  bound: number;
  objectBytes: number;
  counts: {
    intersect: Counted & { ids: number; sum: number };
    count: Counted & { result: number };
  };
};
type Counts = { pools: Pool[]; shapes: Shape[] };
type Layout = {
  shared: number;
  stride: number;
  sharedChunks: number;
  bandChunks: number;
  bandIds: number;
  bandBases: number[];
  idsPerOperand: number;
  chunksPerOperand: number;
  expected: Content;
  idsOf: (i: number) => Iterable<number>;
};
type Engine = { CloudRoaring: typeof CloudRoaring; MemoryStorage: typeof MemoryStorage };
const engine: Engine = { CloudRoaring, MemoryStorage };

const stagesLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-multi-stages.cjs')) as {
  MULTI_STAGES: string[];
  DEFAULT_MULTI_READS: number;
  MULTI_POOLS: Record<string, { operands: number; ids: number; overlap: number }>;
  MULTI_SHAPES: { name: string; group: string; pool: string; k: number }[];
  operandSegment: (pool: string, i: number) => string;
  planNearMissLayout: (i: {
    operands: number;
    shared: number;
    bandChunks: number;
    stride: number;
  }) => Layout;
  planMultiPool: (name: string) => Layout & { name: string; operands: number };
  multiReadBound: (
    shape: { k: number },
    pool: { sharedChunks: number },
    operandBytes: number[],
  ) => number;
  projectMulti: (w: unknown) => {
    stages: Record<string, Bound>;
    discards: Bound;
    costliestSample: number;
    total: Bound;
  };
  expectedMulti: (w: unknown) => Record<string, Bound>;
  MULTI_SUITE_KNOBS: string[];
  resolveMultiKnobs: (env: Record<string, string | undefined>) => { reads: number };
  refuseMultiKnobs: (env: Record<string, string | undefined>, suite: string) => void;
  refuseOtherKnobsUnderMulti: (env: Record<string, string | undefined>, others: string[]) => void;
};
const countsLib = require_(join(ROOT, 'bench', 'lib', 'multi-counts.cjs')) as {
  countMulti: (i: { engine: unknown }) => Promise<Counts>;
};
const runner = require_(join(ROOT, 'bench', 'lib', 'calibrate-multi.cjs')) as {
  runMultiSuite: (ctx: Record<string, unknown>) => Promise<void>;
  projectionLines: (i: Record<string, unknown>) => string[];
};
const largeStages = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
  suiteFrom: (
    argv: string[],
    env: Record<string, string | undefined>,
  ) => { suite: string; source: string };
  DEFAULT_SUITE_KNOBS: string[];
  checkCountVerbs: (version: string, stage?: string) => void;
  checkEngineConstants: (found: Record<string, number | null>, suite?: string) => void;
  operandBound: (chunks: number, cap: number) => number;
  rangeCap: (bytes: number) => number;
  countMisses: (
    kept: Bound,
    expected: Bound,
  ) => { class: string; kept: number; expected: number }[];
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  suiteEvidenceDir: (s: string) => string;
  resultsFile: (rehearse: boolean, runId?: string, o?: Record<string, unknown>) => string;
  layoutFromCounts: (i: { segments: number; shared: number; priv: number; stride: number }) => {
    sharedChunks: number;
    chunksPerSegment: number;
    bases: number[];
    expected: Content;
  };
  layoutIds: (layout: unknown, i: number) => Iterable<number>;
  CHUNK_SPAN: number;
};
const countedLib = require_(join(ROOT, 'bench', 'lib', 'large-counts.cjs')) as {
  countedBackend: (e: unknown) => Promise<{
    loader: CloudRoaring;
    cold: () => CloudRoaring;
    calls: Record<string, number>;
    zero: () => void;
  }>;
};
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  HARNESS_FILES: string[];
};
const evidenceLib = require_(join(ROOT, 'bench', 'lib', 'multi-evidence.cjs')) as {
  multiRunProblems: (run: unknown, options?: { rehearsal?: boolean }) => string[];
};
const meter = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  priceTally: (t: Bound, p: object) => { totalUSD: number };
};
const PRICING = { storage: { putPerMillion: 5, getPerMillion: 0.4 } };

/** Key of the chunk that holds an id: the top 16 bits. */
const keyOf = (id: number) => Math.floor(id / 65_536);

describe('the multi suite is a suite of its own', () => {
  it('is named by --suite or CR_CALIBRATE_SUITE, and two different suites are refused', () => {
    expect(largeStages.suiteFrom(['--suite', 'multi'], {})).toEqual({
      suite: 'multi',
      source: '--suite',
    });
    expect(largeStages.suiteFrom([], { CR_CALIBRATE_SUITE: 'multi' })).toEqual({
      suite: 'multi',
      source: 'CR_CALIBRATE_SUITE',
    });
    expect(() =>
      largeStages.suiteFrom(['--suite', 'multi'], { CR_CALIBRATE_SUITE: 'batch' }),
    ).toThrow(/name different suites/);
    expect(() => largeStages.suiteFrom(['--suite', 'many'], {})).toThrow(
      /the suites are default, large, batch, multi/,
    );
  });

  it('keeps its evidence in a directory of its own, beside no other suite’s', () => {
    expect(guards.suiteEvidenceDir('multi')).toBe('bench/calibration/multi');
    expect(guards.resultsFile(false, '2026-11-10-abcde', { suite: 'multi' })).toBe(
      'bench/calibration/multi/2026-11-10-abcde.json',
    );
    expect(guards.resultsFile(false, '2026-11-10-abcde', { suite: 'multi', partial: true })).toBe(
      'bench/calibration/multi/2026-11-10-abcde.partial.json',
    );
    expect(guards.resultsFile(true, undefined, { suite: 'multi' })).toBe(
      'bench/calibrate-aws-rehearsal-multi.json',
    );
  });

  it('has its own stages, which the harness’s own table, and the stage helper, read', () => {
    expect(stagesLib.MULTI_STAGES).toEqual(['multiLoad', 'multiIntersect', 'multiCount']);
    expect(harnessSrc).toContain("SUITE === 'multi'\n        ? MULTI_STAGES");
    expect(harnessSrc).toContain(
      "if (SUITE === 'multi') Object.assign(expectedLargeByStage, expectedMulti(plan));",
    );
    expect(harnessSrc).toContain('await runMultiSuite(');
    expect(harnessSrc.indexOf('await runMultiSuite(')).toBeLessThan(
      harnessSrc.indexOf("await stage('load'"),
    );
  });

  it('runs exactly the stages its table names, in order, and no other', async () => {
    const seen: string[] = [];
    const shapesPerStage: Record<string, number> = {};
    const plan = {
      reads: 1,
      pools: [],
      shapes: [] as unknown[],
    };
    await runner.runMultiSuite({
      stage: async (name: string, { run }: { run: () => Promise<{ shapes?: unknown[] }> }) => {
        seen.push(name);
        const r = await run();
        shapesPerStage[name] = r.shapes?.length ?? -1;
      },
      load: async () => undefined,
      perLoad: () => [],
      summarise: () => ({}),
      checkCeiling: () => undefined,
      median: () => 0,
      log: () => undefined,
      sample: async () => undefined,
      timedStore: () => undefined,
      snap: () => ({}),
      startDepth: () => undefined,
      msSince: () => 0,
      depthOf: () => ({}),
      spreadOf: () => ({}),
      plan,
    });
    expect(seen).toEqual(stagesLib.MULTI_STAGES);
    expect(shapesPerStage).toEqual({ multiLoad: -1, multiIntersect: 0, multiCount: 0 });
    // A stage name the table lacks is not run: the runner reads its loops from the table.
    const text = src('bench', 'lib', 'calibrate-multi.cjs');
    expect([...text.matchAll(/await stage\('(\w+)'/g)].map((m) => m[1])).toEqual(['multiLoad']);
    expect(text).toContain("MULTI_STAGES.filter((n) => n !== 'multiLoad')");
  });

  it('refuses a setting of another suite under --suite multi, and a multi setting under another', () => {
    expect(() =>
      stagesLib.refuseOtherKnobsUnderMulti(
        { CR_CALIBRATE_IDS: '5' },
        largeStages.DEFAULT_SUITE_KNOBS,
      ),
    ).toThrow(/CR_CALIBRATE_IDS size another suite/);
    expect(() =>
      stagesLib.refuseOtherKnobsUnderMulti(
        { CR_CALIBRATE_IDS: ' ' },
        largeStages.DEFAULT_SUITE_KNOBS,
      ),
    ).not.toThrow();
    for (const suite of ['default', 'large', 'batch']) {
      expect(() => stagesLib.refuseMultiKnobs({ CR_CALIBRATE_MULTI_READS: '5' }, suite)).toThrow(
        /CR_CALIBRATE_MULTI_READS sizes the multi suite/,
      );
    }
    expect(() => stagesLib.refuseMultiKnobs({}, 'large')).not.toThrow();
    expect(stagesLib.resolveMultiKnobs({})).toEqual({ reads: stagesLib.DEFAULT_MULTI_READS });
    expect(stagesLib.resolveMultiKnobs({ CR_CALIBRATE_MULTI_READS: '0' })).toEqual({ reads: 0 });
    for (const bad of ['-1', '1.5', 'x']) {
      expect(() => stagesLib.resolveMultiKnobs({ CR_CALIBRATE_MULTI_READS: bad })).toThrow(
        /non-negative integer/,
      );
    }
  });

  it('is named among the files whose edits mark a run dirty and the files the CloudShell script copies', () => {
    const sh = src('bench', 'calibrate-cloudshell.sh');
    const cp = /^cp (bench\/lib\/[^"]+) "\$WORK\/bench\/lib\/"$/m.exec(sh)?.[1] ?? '';
    for (const m of [
      'bench/lib/calibrate-multi-stages.cjs',
      'bench/lib/calibrate-multi.cjs',
      'bench/lib/calibrate-reads.cjs',
      'bench/lib/multi-counts.cjs',
    ]) {
      expect(processLib.HARNESS_FILES, m).toContain(m);
      expect(cp, m).toContain(m);
      expect(sh.slice(sh.indexOf('harness_ref() {')), m).toContain(m);
    }
    expect(sh).toContain('    multi) ;;');
    expect(sh).toContain('"$WORK"/bench/calibration/multi/*.json');
    expect(sh).toContain('"$WORK/bench/calibrate-aws-rehearsal-multi.json"');
    expect(sh).toContain('dir="bench/calibration/multi"');
  });
});

describe('the harness, run', () => {
  // The refusals are made from the inputs alone, before the library is imported, so they cost nothing. No run is ever
  // authorised here.
  const home = mkdtempSync(join(tmpdir(), 'calib-multi-no-aws-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const harness = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(ROOT, 'bench', 'calibrate-aws.cjs'), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        AWS_CONFIG_FILE: join(home, 'no-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(home, 'no-credentials'),
        AWS_EC2_METADATA_DISABLED: 'true',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('refuses the default, large and batch knobs under --suite multi, and the multi knob elsewhere, with exit code 2', () => {
    for (const [knob, value] of [
      ['CR_CALIBRATE_SEGMENTS', '5'],
      ['CR_CALIBRATE_LARGE_READS', '5'],
      ['CR_CALIBRATE_BATCH_SAMPLES', '1'],
    ] as const) {
      const out = harness(['--suite', 'multi'], { [knob]: value });
      expect(out.status, knob).toBe(2);
      expect(out.stderr, knob).toContain(knob);
    }
    for (const args of [[], ['--suite', 'large'], ['--suite', 'batch']]) {
      const out = harness(args, { CR_CALIBRATE_MULTI_READS: '1' });
      expect(out.status, args.join(' ')).toBe(2);
      expect(out.stderr).toMatch(/CR_CALIBRATE_MULTI_READS sizes the multi suite/);
    }
    const bad = harness(['--suite', 'multi'], { CR_CALIBRATE_MULTI_READS: 'many' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/expected a non-negative integer/);
  });

  it('says which suite runs first, and refuses a rehearsal below the floor before it creates anything', () => {
    const out = harness(['--rehearse', '--suite', 'multi'], {
      CR_CALIBRATE_LARGE_MIN_MEMORY_MB: '999999999',
    });
    expect(out.status).toBe(2);
    expect(out.stdout).toMatch(/calibrate: suite: multi \(named by --suite\)/);
    expect(out.stderr).toMatch(/the multi suite needs 999999999 MiB/);
    expect(out.stderr).toMatch(/Nothing was created/);
  });

  it('refuses a run that names no region, for the multi suite as for the others', () => {
    const out = harness(['--run', '--suite', 'multi']);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/CR_CALIBRATE_REGION must be set/);
  });
});

/** The ids of an operand, ascending, as an array. */
const arrayOf = (ids: Iterable<number>): Float64Array => Float64Array.from(ids);

/** The sorted ids in every one of the sorted arrays, by plain merging: no engine, no set library. */
function intersectAll(arrays: Float64Array[]): Float64Array {
  let acc = arrays[0] as Float64Array;
  for (const next of arrays.slice(1)) {
    const out = new Float64Array(Math.min(acc.length, next.length));
    let i = 0;
    let j = 0;
    let n = 0;
    while (i < acc.length && j < next.length) {
      const a = acc[i] as number;
      const b = next[j] as number;
      if (a < b) i += 1;
      else if (a > b) j += 1;
      else {
        out[n++] = a;
        i += 1;
        j += 1;
      }
    }
    acc = out.subarray(0, n);
  }
  return acc;
}

const contentOf = (ids: Float64Array): Content => ({
  count: ids.length,
  sum: ids.reduce((a, b) => a + b, 0),
});

describe('the layouts hold exactly the intersection they claim', () => {
  it('has seven shapes in four groups, every one reading operands its pool has', () => {
    expect(stagesLib.MULTI_SHAPES.map((s) => [s.name, s.group, s.k])).toEqual([
      ['k3', 'A', 3],
      ['k5', 'A', 5],
      ['k10', 'A', 10],
      ['k5-5M', 'B', 5],
      ['k5-core5', 'C', 5],
      ['k5-core50', 'C', 5],
      ['k5-nearmiss', 'D', 5],
    ]);
    for (const s of stagesLib.MULTI_SHAPES) {
      const pool = stagesLib.MULTI_POOLS[s.pool];
      expect(pool, s.name).toBeDefined();
      expect(s.k, s.name).toBeLessThanOrEqual(pool?.operands ?? 0);
      expect(s.k).toBeGreaterThanOrEqual(3);
      expect(s.k).toBeLessThanOrEqual(10);
    }
  });

  it.each(stagesLib.MULTI_SHAPES.map((s) => [s.name, s] as const))(
    '%s: a brute-force k-way intersection of the generated ids is the layout’s (count, sum)',
    (_name, s) => {
      const pool = stagesLib.planMultiPool(s.pool);
      const arrays = Array.from({ length: s.k }, (_, i) => arrayOf(pool.idsOf(i)));
      for (const a of arrays) {
        for (let i = 1; i < a.length; i += 1) {
          if ((a[i] as number) <= (a[i - 1] as number)) throw new Error('ids are not ascending');
        }
        expect(a.length).toBe(pool.idsPerOperand);
      }
      expect(contentOf(intersectAll(arrays))).toEqual(pool.expected);
      // Any subset has the same intersection, except in the near miss, where a subset holds a band the whole set does not.
      const subset = contentOf(intersectAll(arrays.slice(1)));
      if (s.group === 'D') expect(subset.count).toBeGreaterThan(pool.expected.count);
      else expect(subset).toEqual(pool.expected);
      // The sum is a safe integer, so the exact check is sound.
      expect(Number.isSafeInteger(pool.expected.sum)).toBe(true);
    },
    120_000,
  );

  it('near miss: no key outside the core is in all k key sets, and every band key is in exactly k-1', () => {
    // The last is the suite's own group D, as `planMultiPool` lays it out (5 operands, a 200,000-id core, bands of 50 chunks).
    const real = stagesLib.planMultiPool('d');
    for (const params of [
      { operands: 5, shared: 20_000, bandChunks: 6, stride: 98 },
      { operands: 4, shared: 1_000, bandChunks: 3, stride: 400 },
      { operands: 7, shared: 700, bandChunks: 2, stride: 1000 },
      {
        operands: real.operands,
        shared: real.shared,
        bandChunks: real.bandChunks,
        stride: real.stride,
      },
    ]) {
      const layout = stagesLib.planNearMissLayout(params);
      if (params.shared === real.shared) {
        expect(layout.idsPerOperand).toBe(real.idsPerOperand);
        expect(params).toEqual({ operands: 5, shared: 200_000, bandChunks: 50, stride: 98 });
      }
      const keySets = Array.from({ length: params.operands }, (_, i) => {
        const keys = new Set<number>();
        for (const id of layout.idsOf(i)) keys.add(keyOf(id));
        return keys;
      });
      const coreKeys = new Set<number>();
      for (let k = 0; k < params.shared; k += 1) coreKeys.add(keyOf(k * params.stride));
      expect(coreKeys.size).toBe(layout.sharedChunks);
      const all = new Set(keySets.flatMap((s) => [...s]));
      for (const key of all) {
        const holders = keySets.filter((s) => s.has(key)).length;
        if (coreKeys.has(key)) expect(holders).toBe(params.operands);
        else expect(holders, `key ${key}`).toBe(params.operands - 1);
      }
      // Each band is `bandChunks` chunks, and band j is missing from operand j alone.
      for (let j = 0; j < params.operands; j += 1) {
        const first = keyOf(layout.bandBases[j] as number);
        for (let c = 0; c < params.bandChunks; c += 1) {
          const holders = keySets.map((s) => s.has(first + c));
          expect(holders.filter((h) => !h)).toHaveLength(1);
          expect(holders[j]).toBe(false);
        }
      }
      // The intersection of all is the core: its count and its sum.
      const arrays = keySets.map((_, i) => arrayOf(layout.idsOf(i)));
      expect(contentOf(intersectAll(arrays))).toEqual(layout.expected);
      // A pairwise intersection of two operands holds more than the core, which is what a k-way plan must not read.
      expect(intersectAll(arrays.slice(0, 2)).length).toBeGreaterThan(layout.expected.count);
    }
  }, 120_000);

  it('refuses a near-miss layout that cannot be what it claims', () => {
    const ok = { operands: 5, shared: 1000, bandChunks: 4, stride: 98 };
    expect(() => stagesLib.planNearMissLayout({ ...ok, operands: 2 })).toThrow(/at least 3/);
    expect(() => stagesLib.planNearMissLayout({ ...ok, stride: 65_536 })).toThrow(/own chunk/);
    expect(() => stagesLib.planNearMissLayout({ ...ok, bandChunks: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => stagesLib.planNearMissLayout({ ...ok, bandChunks: 20_000 })).toThrow(/32-bit/);
  });
});

describe('the counts, taken from the real engine in memory', () => {
  // Counted once, by the first test that needs it: slow work belongs in a test, which has a budget of its own.
  let pending: Promise<Counts> | undefined;
  const getCounts = () => (pending ??= countsLib.countMulti({ engine }));

  it('count every shape, each read at 2k pointer and tail requests and its ranges, content exact', async () => {
    const counts = await getCounts();
    expect(counts.shapes.map((s) => s.name)).toEqual(stagesLib.MULTI_SHAPES.map((s) => s.name));
    for (const s of counts.shapes) {
      for (const c of [s.counts.intersect, s.counts.count]) {
        expect(c.pointer, s.name).toBe(s.k);
        expect(c.tail, s.name).toBeGreaterThanOrEqual(s.k);
        expect(c.tail, s.name).toBeLessThanOrEqual(2 * s.k);
        expect(c.gets, s.name).toBe(c.pointer + c.tail + c.range);
        expect(c.range, s.name).toBeGreaterThan(0);
        expect(c.gets, s.name).toBeLessThanOrEqual(s.bound);
      }
      const pool = counts.pools.find((p) => p.name === s.pool) as Pool;
      expect(s.counts.intersect.ids).toBe(pool.expected.count);
      expect(s.counts.intersect.sum).toBe(pool.expected.sum);
      expect(s.counts.count.result).toBe(pool.expected.count);
      // The count verb reads exactly what its stream reads.
      expect(s.counts.count.gets, s.name).toBe(s.counts.intersect.gets);
      expect(s.counts.count.rangeBytes, s.name).toBe(s.counts.intersect.rangeBytes);
      // Chunk-skipping: far fewer bytes than the k objects hold.
      expect(s.counts.intersect.rangeBytes, s.name).toBeLessThan(s.objectBytes);
    }
  }, 120_000);

  it('keep the objects of a pool the same for every shape that reads it', async () => {
    const counts = await getCounts();
    const k = (n: string) => counts.shapes.find((s) => s.name === n) as Shape;
    const a = counts.pools.find((p) => p.name === 'a') as Pool;
    expect(a.operandBytes).toHaveLength(10);
    expect(k('k3').objectBytes).toBe(a.operandBytes.slice(0, 3).reduce((x, y) => x + y, 0));
    expect(k('k10').objectBytes).toBe(a.operandBytes.reduce((x, y) => x + y, 0));
    expect(counts.pools.map((p) => p.operandBytes.length)).toEqual(
      Object.values(stagesLib.MULTI_POOLS).map((p) => p.operands),
    );
    // The 5,000,000-id operands are multipart objects (8 MiB or more), and no other is.
    const parts = (p: Pool) => p.operandBytes.map((b) => b >= 8 * 1024 * 1024);
    expect(parts(counts.pools.find((p) => p.name === 'b') as Pool).every(Boolean)).toBe(true);
    for (const p of counts.pools.filter((q) => q.name !== 'b')) {
      expect(parts(p).some(Boolean), p.name).toBe(false);
    }
  }, 120_000);

  it('fail a planted engine whose answer is wrong by one, or that drops an id', async () => {
    const wrongCount = {
      MemoryStorage,
      CloudRoaring: class extends CloudRoaring {
        override segment(name: string) {
          const seg = super.segment(name);
          const original = seg.intersectCount.bind(seg);
          seg.intersectCount = async (...a: Parameters<typeof original>) =>
            (await original(...a)) + 1;
          return seg;
        }
      },
    };
    await expect(countsLib.countMulti({ engine: wrongCount })).rejects.toThrow(
      /intersectCount returned \d+ in memory; the layout holds/,
    );
    const dropsOne = {
      MemoryStorage,
      CloudRoaring: class extends CloudRoaring {
        override segment(name: string) {
          const seg = super.segment(name);
          const original = seg.intersect.bind(seg);
          seg.intersect = (...a: Parameters<typeof original>) => {
            const stream = original(...a);
            return new Proxy(stream, {
              get(target, prop, receiver) {
                if (prop !== 'batches') return Reflect.get(target, prop, receiver) as unknown;
                return async function* () {
                  let first = true;
                  for await (const ids of target.batches()) {
                    yield first ? ids.subarray(1) : ids;
                    first = false;
                  }
                };
              },
            });
          };
          return seg;
        }
      },
    };
    await expect(countsLib.countMulti({ engine: dropsOne })).rejects.toThrow(
      /the engine's intersect returned/,
    );
  }, 300_000);

  it('feed a projection whose bound the ceiling covers, whose count is the exact expected', async () => {
    const counts = await getCounts();
    const plan = {
      reads: stagesLib.DEFAULT_MULTI_READS,
      pools: counts.pools,
      shapes: counts.shapes,
      retryBound: 5,
      discards: { perRun: 3, perStage: 2 },
      fixedGets: 1 + 5,
      fixedPuts: 1 + 18,
    };
    const bound = stagesLib.projectMulti(plan);
    const expected = stagesLib.expectedMulti(plan);
    for (const name of stagesLib.MULTI_STAGES) {
      const b = bound.stages[name] as Bound;
      const e = expected[name] as Bound;
      expect(e.put, name).toBeLessThanOrEqual(b.put);
      expect(e.get, name).toBeLessThanOrEqual(b.get);
    }
    // The exact reads: R of each verb of each shape.
    const reads = counts.shapes.reduce(
      (n, s) => n + plan.reads * (s.counts.intersect.gets + s.counts.count.gets),
      0,
    );
    expect(expected.multiIntersect?.get).toBe(
      counts.shapes.reduce((n, s) => n + plan.reads * s.counts.intersect.gets, 0),
    );
    expect((expected.multiIntersect?.get ?? 0) + (expected.multiCount?.get ?? 0)).toBe(reads);
    expect(expected.multiLoad?.put).toBeGreaterThan(0);
    expect(bound.discards).toEqual({
      put: 0,
      get: 3 * Math.max(...counts.shapes.map((s) => s.bound)),
    });
    // $0.02 covers the bound; a ceiling at the bound is refused by the harness's own comparison.
    const dollars = meter.priceTally(bound.total, PRICING).totalUSD;
    expect(dollars).toBeLessThan(0.02);
    const guardsBreached = (
      require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
        breached: (spent: number, ceiling: number) => boolean;
      }
    ).breached;
    expect(guardsBreached(dollars, 0.02)).toBe(false);
    expect(guardsBreached(dollars, dollars)).toBe(true);
    expect(guardsBreached(dollars, dollars / 2)).toBe(true);
    // The harness refuses it before creating anything.
    expect(harnessSrc).toMatch(
      /if \(breached\(priced\.totalUSD, ceiling\)\) \{\s+refuse\(\s+`projected/,
    );
  }, 120_000);

  it('are printed in the projection with each shape’s counted requests, bytes and bound', async () => {
    const counts = await getCounts();
    const plan = {
      reads: 20,
      pools: counts.pools,
      shapes: counts.shapes,
      discards: { perRun: 3, perStage: 2 },
      fixedGets: 6,
      fixedPuts: 19,
      retryBound: 5,
    };
    const bound = stagesLib.projectMulti(plan);
    const lines = runner.projectionLines({
      plan,
      bounds: bound.stages,
      expected: stagesLib.expectedMulti(plan),
      discardBound: bound.discards,
      costliestSample: bound.costliestSample,
      ops: bound.total,
      price: (t: Bound) => meter.priceTally(t, PRICING).totalUSD,
    });
    const text = lines.join('\n');
    for (const s of counts.shapes) expect(text).toContain(s.name);
    for (const name of stagesLib.MULTI_STAGES)
      expect(text).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    expect(text).toMatch(/projected \$/);
  }, 120_000);
});

describe('the bound holds the engine, over random layouts', () => {
  // Random operand sets (seeded): k of 3 to 6 operands with a core and private bands, loaded and intersected on the real
  // engine, each read at or under `k x (3 + min(core chunks, range cap))`, and a tightened bound failing on one of them.
  const lcg = (seed: number) => {
    let x = seed >>> 0;
    return () => (x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
  };
  it('is never exceeded by a read, and a bound one range tighter is exceeded by one', async () => {
    const rnd = lcg(2024);
    let exceededTightened = 0;
    for (let trial = 0; trial < 12; trial += 1) {
      const k = 3 + Math.floor(rnd() * 4);
      const stride = [7, 40, 98, 400, 2_000][Math.floor(rnd() * 5)] as number;
      const total = 5_000 + Math.floor(rnd() * 60_000);
      const shared = Math.max(1, Math.floor(total * (0.05 + rnd() * 0.6)));
      const layout = guards.layoutFromCounts({
        segments: k,
        shared,
        priv: total - shared,
        stride,
      });
      const { loader, cold, calls, zero } = await countedLib.countedBackend(engine);
      const bytes: number[] = [];
      for (let i = 0; i < k; i += 1) {
        zero();
        await loader.load({ segment: `o${i}` }, guards.layoutIds(layout, i));
        bytes.push(calls.putBytes as number);
      }
      const store = cold();
      const [first, ...rest] = Array.from({ length: k }, (_, i) => store.segment(`o${i}`));
      let n = 0;
      for await (const ids of (first as ReturnType<typeof store.segment>)
        .intersect(rest as ReturnType<typeof store.segment>[])
        .batches()) {
        n += ids.length;
      }
      expect(n).toBe(layout.expected.count);
      const gets = (calls.pointer as number) + (calls.tail as number) + (calls.range as number);
      const bound = stagesLib.multiReadBound({ k }, { sharedChunks: layout.sharedChunks }, bytes);
      expect(gets, `trial ${trial}`).toBeLessThanOrEqual(bound);
      const tightened =
        k *
        largeStages.operandBound(layout.sharedChunks, largeStages.rangeCap(Math.max(...bytes)) - 6);
      if (gets > tightened) exceededTightened += 1;
    }
    expect(exceededTightened).toBeGreaterThan(0);
  }, 240_000);

  it('is the same function the projection uses for every shape', async () => {
    const pool = { sharedChunks: 299 };
    expect(
      stagesLib.multiReadBound(
        { k: 5 },
        pool,
        [2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000],
      ),
    ).toBe(5 * (3 + Math.min(299, largeStages.rangeCap(2_000_000))));
    // Only the k operands it reads set the cap: a larger object further along the pool does not.
    expect(stagesLib.multiReadBound({ k: 2 }, pool, [1_000_000, 1_000_000, 90_000_000])).toBe(
      2 * (3 + Math.min(299, largeStages.rangeCap(1_000_000))),
    );
  });
});

type Run = {
  runId: string;
  suite: string;
  partial: boolean;
  interrupted?: boolean;
  error?: unknown;
  expectedMissed?: string[];
  projectionExceeded?: string[];
  cost?: { totalUSD: number };
  workload: {
    reads: number;
    shapes: unknown[];
    expected: Record<string, Bound>;
  };
  phases: Record<
    string,
    {
      requests: Bound;
      discarded: { requests: Bound }[];
      shapes?: Record<string, unknown>[];
    }
  >;
};

describe('the evidence gate over a rehearsal’s file', () => {
  // A synthetic run: what a harness that made exactly the expected requests would write.
  const reads = 2;
  const shape = (name: string, gets: number, bound: number, verb: 'intersect' | 'count') => ({
    name,
    bound,
    counts: { [verb]: { gets } },
  });
  const build = (): Run => {
    const defs = stagesLib.MULTI_SHAPES.map((m, i) =>
      i === 0 ? { name: m.name, gets: 20, bound: 36 } : { name: m.name, gets: 30, bound: 60 },
    );
    const entry = (name: string, gets: number, bound: number) => ({
      shape: name,
      runs: reads,
      exact: true,
      offExpected: 0,
      expectedGets: gets,
      medianGets: gets,
      bound,
      perSample: Array.from({ length: reads }, (_, i) => ({
        sample: i,
        get: gets,
        rangeReads: gets - 7,
        tailReads: 4,
        pointerReads: 2,
        noObjectReads: 1,
        peakInFlight: 6,
        meanInFlight: 3.5,
      })),
    });
    const intersectGets = defs.reduce((n, d) => n + reads * d.gets, 0);
    return {
      runId: '2026-12-01-abcde',
      suite: 'multi',
      partial: false,
      cost: { totalUSD: 0.01 },
      workload: {
        reads,
        shapes: defs.flatMap((d) => [
          {
            ...shape(d.name, d.gets, d.bound, 'intersect'),
            counts: { intersect: { gets: d.gets }, count: { gets: d.gets } },
          },
        ]),
        expected: {
          multiLoad: { put: 4, get: 6 },
          multiIntersect: { put: 0, get: intersectGets },
          multiCount: { put: 0, get: intersectGets },
        },
      },
      phases: {
        multiLoad: { requests: { put: 4, get: 6 }, discarded: [] },
        multiIntersect: {
          requests: { put: 0, get: intersectGets },
          discarded: [],
          shapes: defs.map((d) => entry(d.name, d.gets, d.bound)),
        },
        multiCount: {
          requests: { put: 0, get: intersectGets },
          discarded: [],
          shapes: defs.map((d) => entry(d.name, d.gets, d.bound)),
        },
      },
    };
  };
  const mutate = (change: (r: Run) => void): Run => {
    const copy = JSON.parse(JSON.stringify(build())) as Run;
    change(copy);
    return copy;
  };
  const problems = (r: Run) => evidenceLib.multiRunProblems(r);

  it('accepts a complete synthetic run, and every committed run in its directory', () => {
    expect(problems(build())).toEqual([]);
    const dir = join(ROOT, 'bench', 'calibration', 'multi');
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.partial.json'),
    );
    for (const f of files) {
      expect(problems(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Run), f).toEqual([]);
    }
  });

  it('accepts a rehearsal’s file, which carries no bill, and refuses a real run with none', () => {
    const r = mutate((x) => delete x.cost);
    expect(evidenceLib.multiRunProblems(r, { rehearsal: true })).toEqual([]);
    expect(problems(r)).toContain('no bill');
  });

  it.each([
    ['partial', (r: Run) => (r.partial = true), 'partial'],
    ['interrupted', (r: Run) => (r.interrupted = true), 'interrupted'],
    ['failed', (r: Run) => (r.error = { message: 'x' }), 'the run failed'],
    ['a missed count', (r: Run) => (r.expectedMissed = ['m']), 'an expected count was missed'],
    [
      'an exceeded projection',
      (r: Run) => (r.projectionExceeded = ['p']),
      'the projection was exceeded',
    ],
    ['another suite', (r: Run) => (r.suite = 'batch'), 'not a run of the multi suite'],
    ['a stage that did not run', (r: Run) => delete r.phases.multiCount, 'multiCount did not run'],
  ])('refuses a run that is %s', (_n, change, message) => {
    expect(problems(mutate(change))).toContain(message);
  });

  it('refuses a stage whose kept requests are off by one, in either class, and counts discards out', () => {
    for (const stage of stagesLib.MULTI_STAGES) {
      for (const [key, delta] of [
        ['put', 1],
        ['put', -1],
        ['get', 1],
        ['get', -1],
      ] as const) {
        const r = mutate((x) => {
          (x.phases[stage] as { requests: Bound }).requests[key] += delta;
        });
        expect(
          problems(r).some((p) => p.startsWith(`${stage} kept`)),
          `${stage} ${key} ${delta}`,
        ).toBe(true);
      }
    }
    // A discarded sample's requests are billed and in the stage, and out of what it is held to.
    const withDiscard = mutate((x) => {
      const s = x.phases.multiIntersect as { requests: Bound; discarded: { requests: Bound }[] };
      s.requests.get += 17;
      s.discarded.push({ requests: { put: 0, get: 17 } });
    });
    expect(problems(withDiscard)).toEqual([]);
  });

  it('refuses a shape with a read that made other than the expected requests, a short one, or one over its bound', () => {
    const edit = (change: (e: Record<string, unknown>) => void) =>
      mutate((x) =>
        change(
          (x.phases.multiIntersect?.shapes as Record<string, unknown>[])[0] as Record<
            string,
            unknown
          >,
        ),
      );
    expect(problems(edit((e) => (e.offExpected = 1))).join('\n')).toMatch(
      /other than the expected/,
    );
    expect(problems(edit((e) => (e.runs = 1))).join('\n')).toMatch(
      /ran 1 reads, the workload asked for 2/,
    );
    expect(problems(edit((e) => (e.expectedGets = 21))).join('\n')).toMatch(/expects 21 GET-class/);
    expect(problems(edit((e) => (e.medianGets = 37))).join('\n')).toMatch(/over its bound 36/);
    expect(
      problems(
        edit(
          (e) =>
            ((
              (e.perSample as Record<string, number>[])[0] as Record<string, number>
            ).noObjectReads = 0),
        ),
      ).join('\n'),
    ).toMatch(/which make 19/);
    expect(
      problems(
        edit(
          (e) =>
            (((e.perSample as Record<string, number>[])[1] as Record<string, number>).peakInFlight =
              0),
        ),
      ).join('\n'),
    ).toMatch(/no usable peakInFlight/);
    expect(problems(mutate((x) => (x.phases.multiCount?.shapes as unknown[]).pop()))).toContain(
      'multiCount has no k5-nearmiss',
    );
  });

  it('refuses a run that made no reads, and a file whose shapes are not the suite’s own', () => {
    // Zero reads is a legal knob, but a run of it measured nothing and is not a finished, exact run.
    const none = mutate((x) => {
      x.workload.reads = 0;
      x.workload.expected = {
        multiLoad: { put: 4, get: 6 },
        multiIntersect: { put: 0, get: 0 },
        multiCount: { put: 0, get: 0 },
      };
      for (const name of ['multiIntersect', 'multiCount']) {
        const p = x.phases[name] as { requests: Bound; shapes?: Record<string, unknown>[] };
        p.requests = { put: 0, get: 0 };
        p.shapes = stagesLib.MULTI_SHAPES.map((m) => ({ shape: m.name, runs: 0 }));
      }
    });
    expect(problems(none)).toContain(
      'the workload records no reads: a run that read nothing measured nothing',
    );
    // A file with fewer shapes than the suite has, or another shape, is refused even if it is self-consistent.
    const fewer = mutate((x) => {
      x.workload.shapes = x.workload.shapes.slice(0, 2);
      for (const name of ['multiIntersect', 'multiCount']) {
        const p = x.phases[name] as { shapes: unknown[] };
        p.shapes = p.shapes.slice(0, 2);
      }
    });
    expect(problems(fewer).join('\n')).toMatch(/workload's shapes are not the suite's/);
    const other = mutate((x) => {
      (x.workload.shapes[2] as { name: string }).name = 'k7';
    });
    expect(problems(other).join('\n')).toMatch(/workload's shapes are not the suite's/);
    expect(countMissesAreNone()).toBe(true);
  });
});

const countMissesAreNone = () =>
  largeStages.countMisses({ put: 1, get: 2 }, { put: 1, get: 2 }).length === 0;

describe('the refusals name the suite that is running', () => {
  it('names the multi suite’s own stage and suite, and the large suite’s by default', () => {
    expect(() => largeStages.checkCountVerbs('0.25.0', 'multiCount')).toThrow(
      /which the multiCount stage measures/,
    );
    expect(() => largeStages.checkCountVerbs('0.25.0')).toThrow(
      /which the largeCount stage measures/,
    );
    expect(() => largeStages.checkEngineConstants({}, 'multi')).toThrow(
      /where the multi suite's bound was derived/,
    );
    expect(() => largeStages.checkEngineConstants({})).toThrow(
      /where the large suite's bound was derived/,
    );
  });
});
