import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

// The batch suite (`--suite batch`): one refresh-shaped `materializeMany` call, measured on S3. It is a suite of its own,
// with its own stages, bound, expected counts and evidence directory, so the default and large suites' projections and
// evidence cannot move. Each claim it makes is held here against the real engine or the engine's own history.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Bound = { put: number; get: number };
type Outcome = { published: boolean; cardinality?: number; reason?: string };
type Counts = {
  operandBytes: number[];
  sizes: number[];
  readBack: Bound & { pointer: number; tail: number; range: number };
  batch: Bound & {
    pointer: number;
    tail: number;
    range: number;
    groups: number;
    published: number;
    refused: number;
    outputs: Outcome[];
  };
};
type Plan = {
  shape: string;
  operands: number;
  outputs: number;
  idsPerOperand: number;
  samples: number;
  counts: Counts;
  operandBytes: number[];
  retryBound: number;
  discards: { perRun: number; perStage: number };
  fixedPuts: number;
  fixedGets: number;
};

const stagesLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-batch-stages.cjs')) as {
  BATCH_STAGES: string[];
  BATCH_SHAPES: Record<string, { operands: number; outputs: number; idsPerOperand: number }>;
  DEFAULT_BATCH_SHAPE: string;
  DEFAULT_BATCH_SAMPLES: number;
  MATERIALIZE_MANY_SINCE: string;
  BATCH_MAX_VERSIONS: number;
  versionsOf: (i: Record<string, number>) => number;
  resolveBatchKnobs: (env: Record<string, string | undefined>) => {
    shape: string;
    samples: number;
  };
  refuseBatchKnobs: (env: Record<string, string | undefined>, suite: string) => void;
  refuseOtherSuiteKnobs: (env: Record<string, string | undefined>, knobs: string[]) => void;
  checkBatchWorkload: (i: { shape: string; samples: number }) => void;
  hasMaterializeMany: (v: string) => boolean;
  checkMaterializeMany: (v: string) => void;
  withHeadroom: (n: number) => number;
  projectBatch: (w: Plan) => {
    stages: Record<string, Bound>;
    discards: Bound;
    costliestSample: number;
    total: Bound;
  };
  expectedBatch: (w: Plan) => Record<string, Bound>;
  checkOutputs: (got: unknown[], want: Outcome[]) => void;
  checkReadBack: (got: (number | null)[], sizes: number[], published: boolean[]) => void;
  DISCARDED_SAMPLES: number;
  BATCH_MIN_MEMORY_MB: number;
};
// The repo's gate on a batch run's evidence, loaded when a test asks for it.
const batchEvidence = {
  batchRunProblems: (run: unknown, options?: { rehearsal?: boolean }): string[] =>
    (
      require_(join(ROOT, 'bench', 'lib', 'batch-evidence.cjs')) as {
        batchRunProblems: (run: unknown, options?: { rehearsal?: boolean }) => string[];
      }
    ).batchRunProblems(run, options),
};
const batchCounts = require_(join(ROOT, 'bench', 'lib', 'batch-counts.cjs')) as {
  lcg: (seed: number) => () => number;
  batchOperands: (shape: string) => Generator<{ index: number; ids: Uint32Array }>;
  batchSpecs: (shape: string) => { expr: unknown; exclude: string[] }[];
  expectedSizes: (shape: string) => number[];
  readBackCounts: (
    outcomes: { published: boolean }[],
    segmentOf: (i: number) => { count: () => Promise<number> },
  ) => Promise<(number | null)[]>;
  READ_BACK_CONCURRENCY: number;
  countBatch: (i: { shape: string; engine: unknown }) => Promise<Counts>;
};
const runner = require_(join(ROOT, 'bench', 'lib', 'calibrate-batch.cjs')) as {
  runBatchSuite: (ctx: Record<string, unknown>) => Promise<void>;
  projectionLines: (i: Record<string, unknown>) => string[];
  destSegment: (g: number, attempt: number, i: number) => string;
};
const large = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
  DEFAULT_SUITE_KNOBS: string[];
  suiteFrom: (
    argv: string[],
    env: Record<string, string | undefined>,
  ) => { suite: string; source: string };
  countMisses: (
    kept: Bound,
    expected: Bound,
  ) => { class: string; kept: number; expected: number }[];
  recordCountMisses: (
    results: { expectedMissed?: string[] },
    name: string,
    kept: Bound,
    expected: Bound,
    report: (line: string) => void,
  ) => unknown[];
  checkResources: (
    have: { memoryMB: number | null; diskMB: number | null },
    floors?: object,
    suite?: { suite: string; memoryMB: number },
  ) => { memory: number; disk: number };
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  RETRY_BOUND: number;
  resultsFile: (
    rehearse: boolean,
    runId?: string,
    options?: { partial?: boolean; suite?: string },
  ) => string;
  suiteEvidenceDir: (suite: string) => string;
  TEARDOWN_PASSES: number;
  TEARDOWN_PUTS: number;
  MAX_LISTING_PAGES: number;
  teardownLimits: (v?: number) => { passes: number; pages: number; puts: number };
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  firstLoadRequests: (parts: number) => Bound;
};
type Reqs = {
  put: number;
  get: number;
  bytesUp: number;
  bytesDown: number;
  parts: number;
  reads: Record<'whole' | 'suffix' | 'range', { n: number; bytes: number }>;
};
const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  DISCARDS_PER_RUN: number;
  DISCARDS_PER_STAGE: number;
  keptRequests: (record: { requests: Reqs; discarded?: { requests: Reqs }[] }) => Reqs;
  transientFault: (err: unknown, sdk: unknown) => boolean;
  discardLedger: (i: {
    isTransient: (err: unknown) => boolean;
    snap: () => unknown;
    between: (a: unknown, b: unknown) => Reqs;
    settle: () => Promise<boolean>;
  }) => {
    count: number;
    begin: (stage: string) => unknown;
    end: () => void;
    sample: <T>(of: string, index: number, attempt: () => Promise<T>) => Promise<T>;
  };
};
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  HARNESS_FILES: string[];
  resultsJson: (v: unknown) => string;
};
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  evidenceFiles: (root: string) => string[];
};
const bench = require_(join(ROOT, 'bench', 'materialize-many-counts.cjs')) as {
  SHAPES: Record<string, { operands: number; outputs: number; idsPerOperand: number }>;
  lcg: (seed: number) => () => number;
  makeOperand: (
    R: unknown,
    rnd: () => number,
    kind: number,
    ids: number,
    chunks?: number,
  ) => { toArray: () => number[] };
  makeTree: (rnd: () => number, operands: number, depth: number) => unknown;
};
const native = require_('roaring') as { RoaringBitmap32: unknown };

const src = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const harnessSrc = src('bench', 'calibrate-aws.cjs');

// ---- the engine's counts, once ---------------------------------------------------------------------------------------
const engine = { CloudRoaring, MemoryStorage };
const smallCounts = batchCounts.countBatch({ shape: 'small', engine });
const refreshCounts = batchCounts.countBatch({ shape: 'refresh', engine });

const planOf = (counts: Counts, shape = 'refresh', samplesN = 3): Plan => ({
  shape,
  operands: stagesLib.BATCH_SHAPES[shape]?.operands ?? 0,
  outputs: stagesLib.BATCH_SHAPES[shape]?.outputs ?? 0,
  idsPerOperand: stagesLib.BATCH_SHAPES[shape]?.idsPerOperand ?? 0,
  samples: samplesN,
  counts,
  operandBytes: counts.operandBytes,
  retryBound: guards.RETRY_BOUND,
  discards: { perRun: samples.DISCARDS_PER_RUN, perStage: samples.DISCARDS_PER_STAGE },
  fixedPuts: 115,
  fixedGets: 11,
});

/**
 * A complete results file as the harness writes one for a finished run of the small shape: both stages with the requests
 * the plan expected, each sample's own counts and its read-backs', and a bill.
 */
const completeRun = async () => {
  const counts = await smallCounts;
  const plan = planOf(counts, 'small', 3);
  const expected = stagesLib.expectedBatch(plan);
  const perSample = Array.from({ length: plan.samples }, (_, g) => ({
    sample: g,
    put: counts.batch.put,
    get: counts.batch.get,
    expectedPut: counts.batch.put,
    expectedGet: counts.batch.get,
    readBackPut: counts.readBack.put,
    readBackGet: counts.readBack.get,
    expectedReadBackPut: counts.readBack.put,
    expectedReadBackGet: counts.readBack.get,
  }));
  return {
    suite: 'batch',
    partial: false,
    expectedMissed: undefined as string[] | undefined,
    phases: Object.fromEntries(
      stagesLib.BATCH_STAGES.map((n) => [
        n,
        {
          requests: { put: expected[n]?.put ?? 0, get: expected[n]?.get ?? 0 },
          discarded: [],
          expectedPuts: expected[n]?.put,
          expectedGets: expected[n]?.get,
          ...(n === 'batch' ? { perSample } : {}),
        },
      ]),
    ),
    workload: { expected },
    cost: { totalUSD: 0.01 },
  };
};

describe('the batch suite is a suite of its own', () => {
  it('is named by --suite or CR_CALIBRATE_SUITE, and refused when it does not exist', () => {
    expect(large.suiteFrom(['--suite', 'batch'], {})).toEqual({
      suite: 'batch',
      source: '--suite',
    });
    expect(large.suiteFrom([], { CR_CALIBRATE_SUITE: 'batch' })).toEqual({
      suite: 'batch',
      source: 'CR_CALIBRATE_SUITE',
    });
    expect(() => large.suiteFrom(['--suite', 'bulk'], {})).toThrow(
      /the suites are default, large, batch/,
    );
    expect(() => large.suiteFrom(['--suite', 'batch'], { CR_CALIBRATE_SUITE: 'large' })).toThrow(
      /name different suites/,
    );
  });

  it('has its own two stages, in the order the runner runs them', () => {
    expect(stagesLib.BATCH_STAGES).toEqual(['batchLoad', 'batch']);
    const defaults = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
      STAGES: string[];
    };
    const largeStages = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
      LARGE_STAGES: string[];
    };
    for (const name of stagesLib.BATCH_STAGES) {
      expect(defaults.STAGES).not.toContain(name);
      expect(largeStages.LARGE_STAGES).not.toContain(name);
    }
  });

  it('reads its two knobs at the published shape and three samples, and refuses what it cannot read', () => {
    expect(stagesLib.resolveBatchKnobs({})).toEqual({ shape: 'refresh', samples: 3 });
    expect(stagesLib.resolveBatchKnobs({ CR_CALIBRATE_BATCH_SHAPE: ' ' })).toEqual({
      shape: 'refresh',
      samples: 3,
    });
    expect(
      stagesLib.resolveBatchKnobs({
        CR_CALIBRATE_BATCH_SHAPE: 'small',
        CR_CALIBRATE_BATCH_SAMPLES: '0',
      }),
    ).toEqual({ shape: 'small', samples: 0 });
    expect(() => stagesLib.resolveBatchKnobs({ CR_CALIBRATE_BATCH_SHAPE: 'target' })).toThrow(
      /the shapes are refresh and small/,
    );
    for (const bad of ['-1', '1.5', 'many']) {
      expect(() => stagesLib.resolveBatchKnobs({ CR_CALIBRATE_BATCH_SAMPLES: bad }), bad).toThrow(
        /CR_CALIBRATE_BATCH_SAMPLES/,
      );
    }
  });

  it('refuses another suite’s workload setting under --suite batch, and its own under any other suite, each by name', () => {
    expect(() =>
      stagesLib.refuseOtherSuiteKnobs(
        { CR_CALIBRATE_SEGMENTS: '5', CR_CALIBRATE_LARGE_READS: '2' },
        large.DEFAULT_SUITE_KNOBS,
      ),
    ).toThrow(/CR_CALIBRATE_SEGMENTS, CR_CALIBRATE_LARGE_READS size another suite/);
    expect(() => stagesLib.refuseOtherSuiteKnobs({}, large.DEFAULT_SUITE_KNOBS)).not.toThrow();
    for (const suite of ['default', 'large']) {
      expect(() => stagesLib.refuseBatchKnobs({ CR_CALIBRATE_BATCH_SAMPLES: '1' }, suite)).toThrow(
        /CR_CALIBRATE_BATCH_SAMPLES size the batch suite/,
      );
      expect(() =>
        stagesLib.refuseBatchKnobs({ CR_CALIBRATE_BATCH_SAMPLES: '' }, suite),
      ).not.toThrow();
    }
  });

  it('refuses a workload teardown is not sized for, and none the knobs can lower it to', () => {
    expect(() => stagesLib.checkBatchWorkload({ shape: 'refresh', samples: 3 })).not.toThrow();
    expect(() => stagesLib.checkBatchWorkload({ shape: 'small', samples: 3 })).not.toThrow();
    expect(() => stagesLib.checkBatchWorkload({ shape: 'refresh', samples: 0 })).not.toThrow();
    expect(() => stagesLib.checkBatchWorkload({ shape: 'refresh', samples: 4 })).toThrow(
      /would leave about \d+ object versions/,
    );
  });
});

describe('the shape', () => {
  it('is the refresh shape of the in-memory count, and the small one CI recounts', () => {
    for (const name of ['refresh', 'small']) {
      expect(stagesLib.BATCH_SHAPES[name]).toEqual(bench.SHAPES[name]);
    }
    expect(stagesLib.DEFAULT_BATCH_SHAPE).toBe('refresh');
  });

  it('builds the operands that file builds with the native binding: the same sorted distinct ids, kind by kind', () => {
    const rnd = bench.lcg(777);
    const s = stagesLib.BATCH_SHAPES.small as { operands: number; idsPerOperand: number };
    let seen = 0;
    for (const { index, ids } of batchCounts.batchOperands('small')) {
      const oracle = bench.makeOperand(native.RoaringBitmap32, rnd, index % 4, s.idsPerOperand);
      expect(Array.from(ids), `operand ${index} (kind ${index % 4})`).toEqual(oracle.toArray());
      seen += 1;
    }
    expect(seen).toBe(s.operands);
  });

  it('builds the outputs that file builds: the same trees from the same draws, op0 excluded from each', () => {
    const s = stagesLib.BATCH_SHAPES.small as { operands: number; outputs: number };
    const rnd = bench.lcg(99);
    const want = Array.from({ length: s.outputs }, () =>
      bench.makeTree(rnd, s.operands, 1 + Math.floor(rnd() * 2)),
    );
    const got = batchCounts.batchSpecs('small');
    expect(got.map((x) => x.expr)).toEqual(want);
    for (const spec of got) expect(spec.exclude).toEqual(['op0']);
  });
});

describe('the expected counts, counted against the real engine', () => {
  it('count one cold call: its requests by kind, its groups, and each output as published with its size', async () => {
    const c = (await smallCounts).batch;
    expect(c.get).toBe(c.pointer + c.tail + c.range);
    expect(c.groups).toBeGreaterThanOrEqual(1);
    expect(c.outputs).toHaveLength(100);
    expect(c.published + c.refused).toBe(100);
    for (const o of c.outputs) {
      expect(o.published ? typeof o.cardinality : typeof o.reason).toBe(
        o.published ? 'number' : 'string',
      );
    }
    expect((await smallCounts).operandBytes).toHaveLength(20);
    // The read-backs: one cold store reads each published output's count, which is reads and writes nothing.
    const rb = (await smallCounts).readBack;
    expect(rb.get).toBe(rb.pointer + rb.tail + rb.range);
    expect(rb.get).toBeGreaterThanOrEqual(c.published);
    expect(rb.put).toBe(0);
    // Every destination is new, so each output is one object and one registry create: two PUT-class requests.
    expect(c.put).toBeGreaterThanOrEqual(2 * c.published);
  }, 120_000);

  it('hold the stages to the counts: the loads a first load each, the batch the samples times one call and its read-backs', async () => {
    const counts = await smallCounts;
    const e = stagesLib.expectedBatch(planOf(counts, 'small', 3));
    const first = stages.firstLoadRequests(0);
    const load = {
      put: counts.operandBytes.length * first.put,
      get: counts.operandBytes.length * first.get,
    };
    expect(e.batchLoad).toEqual(load);
    expect(e.batch).toEqual({
      put: 3 * (counts.batch.put + counts.readBack.put),
      get: 3 * (counts.batch.get + counts.readBack.get),
    });
    expect(stagesLib.expectedBatch(planOf(counts, 'small', 0)).batch).toEqual({ put: 0, get: 0 });
  }, 120_000);
});

describe('the bound', () => {
  it('holds every stage at or above what the engine is expected to make, and prices the default plan under its ceiling', async () => {
    const counts = await refreshCounts;
    const plan = planOf(counts);
    const bound = stagesLib.projectBatch(plan);
    const expected = stagesLib.expectedBatch(plan);
    for (const name of stagesLib.BATCH_STAGES) {
      expect(bound.stages[name]?.put, name).toBeGreaterThanOrEqual(expected[name]?.put ?? NaN);
      expect(bound.stages[name]?.get, name).toBeGreaterThanOrEqual(expected[name]?.get ?? NaN);
    }
    const meter = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
      priceTally: (t: Bound, p: object) => { totalUSD: number };
    };
    const pricing = { storage: { putPerMillion: 5, getPerMillion: 0.4 } };
    const dollars = meter.priceTally(bound.total, pricing).totalUSD;
    expect(dollars).toBeGreaterThan(
      meter.priceTally(
        {
          put: expected.batch!.put + expected.batchLoad!.put,
          get: expected.batch!.get + expected.batchLoad!.get,
        },
        pricing,
      ).totalUSD,
    );
    // The ceiling the README states.
    expect(dollars).toBeLessThan(0.1);
    expect(dollars).toBeGreaterThan(0.05);
  }, 120_000);

  it('is the counted sample with headroom, and a stage the plan does not run is nothing', async () => {
    const counts = await smallCounts;
    expect(stagesLib.withHeadroom(1)).toBe(2);
    expect(stagesLib.withHeadroom(100)).toBe(150);
    const plan = planOf(counts, 'small', 3);
    const b = stagesLib.projectBatch(plan);
    // A sample is the call and the read-backs of its outputs, each with its headroom.
    const sample = {
      put: stagesLib.withHeadroom(counts.batch.put) + stagesLib.withHeadroom(counts.readBack.put),
      get: stagesLib.withHeadroom(counts.batch.get) + stagesLib.withHeadroom(counts.readBack.get),
    };
    expect(b.stages.batch).toEqual({ put: 3 * sample.put, get: 3 * sample.get });
    expect(b.costliestSample).toBe(sample.get);
    const none = stagesLib.projectBatch(planOf(counts, 'small', 0));
    expect(none.stages.batch).toEqual({ put: 0, get: 0 });
    expect(none.discards).toEqual({ put: 0, get: 0 });
  }, 120_000);

  it('allows the discards only the batch stage can make: the fewer of a run’s and a stage’s, at the costliest sample', async () => {
    const counts = await smallCounts;
    const plan = planOf(counts, 'small', 3);
    const sample = {
      put: stagesLib.withHeadroom(counts.batch.put) + stagesLib.withHeadroom(counts.readBack.put),
      get: stagesLib.withHeadroom(counts.batch.get) + stagesLib.withHeadroom(counts.readBack.get),
    };
    expect(stagesLib.projectBatch(plan).discards).toEqual({
      put: samples.DISCARDS_PER_STAGE * sample.put,
      get: samples.DISCARDS_PER_STAGE * sample.get,
    });
    expect(() =>
      stagesLib.projectBatch({ ...plan, discards: { perRun: -1, perStage: 2 } }),
    ).toThrow(/discards.perRun/);
  }, 120_000);
});

describe('the version guard', () => {
  it('names the first release that shipped materializeMany, as the changelog does', () => {
    const log = src('CHANGELOG.md');
    const at = log.indexOf('**`store.materializeMany` writes many `*Into` outputs');
    expect(at).toBeGreaterThan(0);
    const heading = [...log.slice(0, at).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].pop()?.[1];
    expect(stagesLib.MATERIALIZE_MANY_SINCE).toBe(heading);
    expect(stagesLib.MATERIALIZE_MANY_SINCE).toBe('0.18.0');
  });

  it('refuses a release below it before anything is created, in the shape of the other refusals', () => {
    for (const v of ['0.17.9', '0.17.0', '0.10.0']) {
      expect(() => stagesLib.checkMaterializeMany(v), v).toThrow(
        new RegExp(
          `is ${v.replace(/\./g, '\\.')}, and a release below 0\\.18\\.0 has no materializeMany`,
        ),
      );
    }
    expect(() => stagesLib.checkMaterializeMany('0.17.9')).toThrow(
      /0\.18\.0 is the first release that does\. Nothing was created\. Install it, or run from the 0\.18\.0 release\./,
    );
    for (const v of ['0.18.0', '0.18.1', '0.27.0', '0.100.0', '1.0.0', '0.18.0-rc.1']) {
      expect(() => stagesLib.checkMaterializeMany(v), v).not.toThrow();
    }
    for (const v of ['', 'latest', '0.18', 'v0.18.0']) {
      expect(() => stagesLib.checkMaterializeMany(v), v).toThrow(/which is not a version/);
    }
  });

  it('is asked by the harness for the batch suite, before the engine counts and before anything is created', () => {
    const main = harnessSrc.indexOf('async function main');
    const check = harnessSrc.indexOf('checkMaterializeMany(packageVersion)', main);
    expect(check).toBeGreaterThan(main);
    expect(
      harnessSrc.slice(harnessSrc.lastIndexOf("if (SUITE === 'batch')", check), check),
    ).toContain("if (SUITE === 'batch') {");
    expect(check).toBeLessThan(harnessSrc.indexOf('await countBatch(', main));
    expect(check).toBeLessThan(harnessSrc.indexOf('new s3.CreateBucketCommand', main));
    expect(harnessSrc.lastIndexOf("if (MODE !== 'cleanup') {", check)).toBeGreaterThan(main);
    expect(harnessSrc.slice(check, check + 120)).toContain('refuse(err.message)');
  });
});

describe('each output is held to the engine’s own count', () => {
  const want: Outcome[] = [
    { published: true, cardinality: 10 },
    { published: true, cardinality: 20 },
    { published: false, reason: 'empty' },
  ];
  const exact = [
    { published: true, cardinality: 10 },
    { published: true, cardinality: 20 },
    { published: false, reason: 'empty' },
  ];

  it('accepts exactly the engine’s outputs', () => {
    expect(() => stagesLib.checkOutputs(exact, want)).not.toThrow();
  });

  it('fails a count that is one too high or one too low, naming the output', () => {
    for (const off of [1, -1]) {
      const got = exact.map((o, i) => (i === 1 ? { ...o, cardinality: 20 + off } : o));
      expect(() => stagesLib.checkOutputs(got, want), `${off}`).toThrow(
        /output 1 holds \d+ ids; expected exactly 20/,
      );
    }
  });

  it('fails an output published that the engine refuses, one refused that it publishes, and another reason', () => {
    expect(() =>
      stagesLib.checkOutputs([exact[0], exact[1], { published: true, cardinality: 1 }], want),
    ).toThrow(/output 2 published/);
    expect(() =>
      stagesLib.checkOutputs([{ published: false, reason: 'empty' }, exact[1], exact[2]], want),
    ).toThrow(/output 0 was refused \(empty\)/);
    expect(() =>
      stagesLib.checkOutputs(
        [exact[0], exact[1], { published: false, reason: 'max-growth' }],
        want,
      ),
    ).toThrow(/refused for max-growth; expected empty/);
    expect(() => stagesLib.checkOutputs(exact.slice(1), want)).toThrow(
      /returned 2 outputs; expected 3/,
    );
  });

  it('throws an output’s own error, with it as the cause, so a transient fault is discarded as it is anywhere', () => {
    const fault = new Error('socket hang up');
    let caught: Error | undefined;
    try {
      stagesLib.checkOutputs([exact[0], { published: false, error: fault }, exact[2]], want);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/output 1 failed: socket hang up/);
    expect(caught?.cause).toBe(fault);
  });
});

describe('the stages, run over a store that answers as we choose', () => {
  const OUT = 6;
  const wantOutputs: Outcome[] = Array.from({ length: OUT }, (_, i) =>
    i === 5 ? { published: false, reason: 'empty' } : { published: true, cardinality: 100 + i },
  );
  const counts = {
    operandBytes: [1_000, 1_000],
    sizes: [100, 101, 102, 103, 104, 0],
    readBack: { put: 0, get: 5, pointer: 5, tail: 0, range: 0 },
    batch: {
      put: 12,
      get: 30,
      pointer: 10,
      tail: 10,
      range: 10,
      groups: 2,
      published: 5,
      refused: 1,
      outputs: wantOutputs,
    },
  };
  const plan = {
    shape: 'small',
    operands: 2,
    outputs: OUT,
    idsPerOperand: 100,
    samples: 2,
    counts,
  };

  const run = async ({
    answer = (o: Outcome[]) => o as unknown[],
    extraGets = 0,
    extraPuts = 0,
    extraReadBackGets = 0,
    readBackAnswer = (_i: number, size: number) => size as number | null,
    discardFirst = false,
    planOverride = plan,
  }: {
    answer?: (o: Outcome[]) => unknown[];
    extraGets?: number;
    extraPuts?: number;
    extraReadBackGets?: number;
    readBackAnswer?: (i: number, size: number) => number | null;
    discardFirst?: boolean;
    planOverride?: typeof plan;
  } = {}) => {
    const tally = { get: 0, put: 0 };
    const dests: string[][] = [];
    let calls = 0;
    const store = {
      // A segment answers its `count()` as the stored output would: the size it was given, a request each.
      segment: (name: string) => ({
        name,
        count: async () => {
          tally.get += 1 + extraReadBackGets;
          const i = Number(/-o(\d+)$/.exec(name)?.[1]);
          return readBackAnswer(i, counts.sizes[i] ?? 0);
        },
      }),
      materializeMany: async (o: { outputs: { dest: { name: string } }[] }) => {
        dests.push(o.outputs.map((x) => x.dest.name));
        tally.get += 30 + extraGets;
        tally.put += 12 + extraPuts;
        return { outputs: answer(wantOutputs), stats: { groups: 2 } };
      },
    };
    const snap = () => ({
      put: tally.put,
      get: tally.get,
      up: 0,
      down: 0,
      rangeN: 0,
      rangeBytes: 0,
      suffixN: 0,
      suffixBytes: 0,
      wholeN: 0,
      wholeBytes: 0,
    });
    const phases: Record<string, Record<string, unknown>> = {};
    const missed: string[] = [];
    const loads: string[] = [];
    const failure = await runner
      .runBatchSuite({
        stage: async (
          name: string,
          { run: body }: { run: () => Promise<Record<string, unknown>> },
        ) => {
          phases[name] = await body();
        },
        // A discarded sample runs again, as the ledger does it.
        sample: async (_of: string, _i: number, attempt: () => Promise<unknown>) => {
          calls += 1;
          if (discardFirst && calls === 1) await attempt();
          return attempt();
        },
        load: async (segment: string) => {
          loads.push(segment);
        },
        perLoad: () => [],
        summarise: () => ({}),
        snap,
        startDepth: () => undefined,
        depthOf: () => ({ peakInFlight: 1, requestMs: 1, meanInFlight: 1, rounds: 1 }),
        checkCeiling: () => undefined,
        msSince: () => 10,
        median: (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)],
        spreadOf: (xs: number[]) => ({ p50ms: xs[0], p99ms: xs[0] }),
        timedStore: () => store,
        log: () => undefined,
        plan: planOverride,
        recordMissed: (m: string) => missed.push(m),
      })
      .then(
        () => undefined,
        (err: Error) => err,
      );
    return { failure, phases, tally, dests, missed, loads };
  };

  it('loads each operand once, then runs the plan’s samples, each recording its requests, groups and time', async () => {
    const { failure, phases, tally, loads } = await run();
    expect(failure).toBeUndefined();
    // The loads are the shape's own operands, in order.
    expect(loads).toHaveLength(20);
    expect(loads[0]).toBe('batch-op0');
    const batch = phases.batch as { runs: number; perSample: Record<string, number>[] };
    expect(batch.runs).toBe(2);
    expect(batch.perSample).toHaveLength(2);
    for (const s of batch.perSample) {
      expect(s).toMatchObject({
        put: 12,
        get: 30,
        expectedPut: 12,
        expectedGet: 30,
        readBackPut: 0,
        readBackGet: 5,
        expectedReadBackPut: 0,
        expectedReadBackGet: 5,
        groups: 2,
        published: 5,
      });
    }
    expect(tally).toEqual({ get: 70, put: 24 });
    const none = await run({ planOverride: { ...plan, samples: 0 } });
    expect((none.phases.batch as { runs: number }).runs).toBe(0);
    expect(none.tally.get).toBe(0);
  });

  it('runs every sample on destinations no other sample, and no discarded attempt, wrote', async () => {
    const { dests } = await run({ discardFirst: true });
    expect(dests).toHaveLength(3);
    const all = dests.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(dests[0]?.[0]).toBe(runner.destSegment(0, 0, 0));
    expect(dests[1]?.[0]).toBe(runner.destSegment(0, 1, 0));
  });

  it('fails the stage on a count one too high or one too low, and on an output that came back with an error', async () => {
    for (const off of [1, -1]) {
      const { failure } = await run({
        answer: (o) =>
          o.map((x, i) => (i === 2 ? { ...x, cardinality: (x.cardinality ?? 0) + off } : x)),
      });
      expect(failure?.message, `${off}`).toMatch(/output 2 holds \d+ ids; expected exactly 102/);
    }
    const { failure } = await run({
      answer: (o) =>
        o.map((x, i) => (i === 0 ? { published: false, error: new Error('boom') } : x)),
    });
    expect(failure?.message).toMatch(/output 0 failed: boom/);
  });

  it('records a request count off by one in a PUT-class or a GET-class, either way, as a miss in each sample, and the run carries on', async () => {
    const exact = await run();
    expect(exact.failure).toBeUndefined();
    expect(exact.missed).toEqual([]);
    // The call's own counts, and its read-backs', in each class and each direction, through the suite's own sample code.
    // The stub cannot make fewer requests than its fixed ones, so the "one fewer" is a plan that expects one more.
    const cases: [string, Parameters<typeof run>[0], RegExp][] = [
      ['GET +1', { extraGets: 1 }, /sample 0: 12 PUT-class and 31 GET-class, expected 12 and 30/],
      ['PUT +1', { extraPuts: 1 }, /sample 0: 13 PUT-class and 30 GET-class, expected 12 and 30/],
      [
        'GET -1',
        {
          planOverride: {
            ...plan,
            counts: { ...plan.counts, batch: { ...plan.counts.batch, get: 31 } },
          },
        },
        /sample 0: 12 PUT-class and 30 GET-class, expected 12 and 31/,
      ],
      [
        'PUT -1',
        {
          planOverride: {
            ...plan,
            counts: { ...plan.counts, batch: { ...plan.counts.batch, put: 13 } },
          },
        },
        /sample 0: 12 PUT-class and 30 GET-class, expected 13 and 30/,
      ],
      [
        'read-back GET +1',
        { extraReadBackGets: 1 },
        /read-back of sample 0: 0 PUT-class and 10 GET-class, expected 0 and 5/,
      ],
      [
        'read-back GET -1',
        {
          planOverride: {
            ...plan,
            counts: { ...plan.counts, readBack: { ...plan.counts.readBack, get: 6 } },
          },
        },
        /read-back of sample 0: 0 PUT-class and 5 GET-class, expected 0 and 6/,
      ],
    ];
    for (const [name, options, message] of cases) {
      const out = await run(options);
      expect(out.failure, name).toBeUndefined();
      expect(out.missed[0], name).toMatch(message);
      // Both samples of the plan miss, each recorded once under its own number.
      expect(out.missed, name).toHaveLength(2);
    }
  });

  it('holds the stage’s total in each class and direction to the plan’s expected requests, as the harness records a miss, and a gate refuses the run', async () => {
    const counts = await smallCounts;
    const p = planOf(counts, 'small', 3);
    const expected = stagesLib.expectedBatch(p);
    const zero: Reqs = {
      put: 0,
      get: 0,
      bytesUp: 0,
      bytesDown: 0,
      parts: 0,
      reads: {
        whole: { n: 0, bytes: 0 },
        suffix: { n: 0, bytes: 0 },
        range: { n: 0, bytes: 0 },
      },
    };
    for (const stage of stagesLib.BATCH_STAGES) {
      const want = expected[stage] as Bound;
      for (const [cls, delta] of [
        ['get', 1],
        ['get', -1],
        ['put', 1],
        ['put', -1],
      ] as const) {
        const requests = {
          ...zero,
          put: want.put + (cls === 'put' ? delta : 0),
          get: want.get + (cls === 'get' ? delta : 0),
        };
        // A discarded sample's requests are billed and stay in the stage, and are out of what it is held to.
        const discarded = { requests: { ...zero, put: 7, get: 9 } };
        const record = {
          requests: { ...requests, put: requests.put + 7, get: requests.get + 9 },
          discarded: [discarded],
        };
        const results: { expectedMissed?: string[] } = {};
        const reported: string[] = [];
        large.recordCountMisses(
          results,
          stage,
          samples.keptRequests(record),
          want,
          (line: string) => reported.push(line),
        );
        const klass = cls === 'put' ? 'PUT-class' : 'GET-class';
        const kept = cls === 'put' ? requests.put : requests.get;
        const exp = cls === 'put' ? want.put : want.get;
        expect(results.expectedMissed, `${stage} ${cls} ${delta}`).toEqual([
          `${stage}: ${kept} ${klass} kept, expected ${exp}`,
        ]);
        expect(reported.join('\n')).toContain('EXPECTED COUNT MISSED');
        // And the gate over a run that carries it: refused.
        const run = await completeRun();
        run.expectedMissed = results.expectedMissed;
        expect(batchEvidence.batchRunProblems(run)).toContain('an expected count was missed');
      }
      // Exactly the expected requests, with a discarded sample's on top: no miss.
      const clean: { expectedMissed?: string[] } = {};
      large.recordCountMisses(
        clean,
        stage,
        samples.keptRequests({
          requests: { ...zero, put: want.put + 7, get: want.get + 9 },
          discarded: [{ requests: { ...zero, put: 7, get: 9 } }],
        }),
        want,
        () => undefined,
      );
      expect(clean.expectedMissed).toBeUndefined();
    }
  }, 120_000);

  it('is held by the harness for the batch suite through that function, whatever the suite, with the batch table of expected requests', () => {
    expect(harnessSrc).toContain(
      'recordCountMisses(results, name, kept, expectedLargeByStage[name], console.error);',
    );
    expect(harnessSrc).toContain("SUITE === 'batch' ? expectedBatch(plan)");
    expect(harnessSrc).toContain("if (SUITE !== 'default') {");
  });

  it('fails the stage when a published output reads back from the store one too high or one too low, and the call’s answer was right', async () => {
    for (const off of [1, -1]) {
      const { failure } = await run({
        readBackAnswer: (i, size) => (i === 3 ? size + off : size),
      });
      expect(failure?.message, `${off}`).toMatch(
        /output 3 reads back \d+ ids from the store; expected exactly 103/,
      );
    }
  });

  it('reads each published output back once, on a store of its own, and none the call refused', async () => {
    const { tally, failure } = await run({ planOverride: { ...plan, samples: 1 } });
    expect(failure).toBeUndefined();
    // The call's 30 GET-class requests, and the five published outputs' count()s; the refused sixth is not read.
    expect(tally.get).toBe(35);
  });

  it('prints the projection: the shape, each stage’s bound and expected requests, the discards and the total', async () => {
    const c = await smallCounts;
    const p = planOf(c, 'small', 3);
    const b = stagesLib.projectBatch(p);
    const lines = runner.projectionLines({
      plan: p,
      bounds: b.stages,
      expected: stagesLib.expectedBatch(p),
      discardBound: b.discards,
      costliestSample: b.costliestSample,
      ops: b.total,
      price: () => 0.01,
    });
    const text = lines.join('\n');
    for (const name of stagesLib.BATCH_STAGES) expect(text).toContain(name);
    expect(text).toMatch(/shape\s+small: 20 operands of 100000 ids, 100 outputs/);
    expect(text).toMatch(/projected\s+\d+ PUT-class, \d+ GET-class/);
    expect(text).toMatch(/projected \$\s+0\.010000/);
  }, 120_000);
});

describe('the evidence of a batch run', () => {
  interface Run {
    suite?: string;
    partial?: boolean;
    interrupted?: boolean;
    error?: unknown;
    expectedMissed?: string[];
    projectionExceeded?: string[];
    phases?: Record<
      string,
      {
        requests?: Bound;
        discarded?: { requests: Bound }[];
        expectedGets?: number;
        expectedPuts?: number;
        perSample?: Record<string, number>[];
      }
    >;
    workload?: { expected?: Record<string, Bound> };
    cost?: unknown;
  }
  // The gate on a finished run is the repo's own (`bench/lib/batch-evidence.cjs`): its suite, both stages, every stage's kept
  // requests (those of its discarded samples left out) equal to what the plan expected in both classes, and each sample's.
  const problemsWith = (run: Run): string[] => batchEvidence.batchRunProblems(run);
  const complete = completeRun as () => Promise<Run>;
  const mutate = async (change: (r: Run) => void): Promise<Run> => {
    const copy = JSON.parse(JSON.stringify(await complete())) as Run;
    change(copy);
    return copy;
  };

  it('has committed runs, if any, that the gate accepts', () => {
    const dir = join(ROOT, 'bench', 'calibration', 'batch');
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.partial.json'),
    );
    for (const f of files) {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Run;
      expect(problemsWith(run), f).toEqual([]);
    }
  });

  it('accepts a complete synthetic run, and writes it as the harness writes a results file', async () => {
    const run = await complete();
    expect(problemsWith(run)).toEqual([]);
    expect(JSON.parse(processLib.resultsJson(run))).toEqual(run);
  }, 120_000);

  it('refuses a request count off by one, either way, in either class and either stage', async () => {
    for (const stage of stagesLib.BATCH_STAGES) {
      for (const [cls, delta] of [
        ['get', 1],
        ['get', -1],
        ['put', 1],
        ['put', -1],
      ] as const) {
        const run = await mutate((r) => {
          const req = r.phases?.[stage]?.requests;
          if (req) req[cls] += delta;
        });
        expect(problemsWith(run).join('\n'), `${stage} ${cls} ${delta}`).toContain(`${stage} kept`);
      }
    }
  }, 120_000);

  it('refuses a sample whose own count, or whose read-back’s, is off by one, even where the stage’s total is edited to match', async () => {
    for (const field of ['put', 'get', 'readBackPut', 'readBackGet'] as const) {
      for (const delta of [1, -1]) {
        const run = await mutate((r) => {
          const s0 = r.phases?.batch?.perSample?.[0];
          if (s0) s0[field] = (s0[field] ?? 0) + delta;
        });
        expect(problemsWith(run).join('\n'), `${field} ${delta}`).toMatch(/batch sample 0/);
      }
    }
  }, 120_000);

  it('counts a discarded sample’s requests out of what a stage is held to, and fails a stage, a bill or a suite that is missing', async () => {
    const dropped = await mutate((r) => {
      const p = r.phases?.batch;
      if (!p?.requests) return;
      p.requests.get += 5;
      p.requests.put += 3;
      p.discarded = [{ requests: { put: 3, get: 5 } }];
    });
    expect(problemsWith(dropped)).toEqual([]);
    expect(problemsWith(await mutate((r) => delete r.phases?.batch))).toContain(
      'batch did not run',
    );
    expect(problemsWith(await mutate((r) => delete r.cost))).toContain('no bill');
    expect(
      batchEvidence.batchRunProblems(await mutate((r) => delete r.cost), { rehearsal: true }),
    ).toEqual([]);
    expect(problemsWith(await mutate((r) => delete r.suite))).toContain(
      'not a run of the batch suite',
    );
    expect(problemsWith(await mutate((r) => (r.expectedMissed = ['x'])))).toContain(
      'an expected count was missed',
    );
    expect(problemsWith(await mutate((r) => (r.projectionExceeded = ['x'])))).toContain(
      'the projection was exceeded',
    );
    expect(problemsWith(await mutate((r) => (r.interrupted = true)))).toContain('interrupted');
    expect(problemsWith(await mutate((r) => (r.partial = true)))).toContain('partial');
  }, 120_000);

  it('goes under bench/calibration/batch/, its rehearsal and partials beside it and apart from the default suite’s', () => {
    expect(guards.suiteEvidenceDir('batch')).toBe('bench/calibration/batch');
    expect(guards.resultsFile(false, '2026-11-03-abcde', { suite: 'batch' })).toBe(
      'bench/calibration/batch/2026-11-03-abcde.json',
    );
    expect(guards.resultsFile(false, '2026-11-03-abcde', { suite: 'batch', partial: true })).toBe(
      'bench/calibration/batch/2026-11-03-abcde.partial.json',
    );
    expect(guards.resultsFile(true, undefined, { suite: 'batch' })).toBe(
      'bench/calibrate-aws-rehearsal-batch.json',
    );
    for (const f of [
      'bench/calibrate-aws-rehearsal-batch.json',
      'bench/calibration/batch/2026-11-03-abcde.partial.json',
    ]) {
      const ignored = spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
      expect(ignored.status, f).toBe(0);
    }
    const kept = spawnSync(
      'git',
      ['check-ignore', '-q', 'bench/calibration/batch/2026-11-03-abcde.json'],
      {
        cwd: ROOT,
      },
    );
    expect(kept.status).toBe(1);
  });

  it('is invisible to the default suite’s figures: not among the evidence files, whatever it holds', () => {
    const tree = mkdtempSync(join(tmpdir(), 'batch-evidence-'));
    try {
      mkdirSync(join(tree, 'bench', 'calibration', 'batch'), { recursive: true });
      writeFileSync(join(tree, 'bench', 'calibration', '2026-10-01-aaaaa.json'), '{}');
      writeFileSync(join(tree, 'bench', 'calibration', 'batch', '2026-12-01-bbbbb.json'), '{}');
      const files = figures.evidenceFiles(tree);
      expect(files.map((f) => f.split('/').pop())).toEqual(['2026-10-01-aaaaa.json']);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('teardown reaches every destination the suite writes', () => {
  it('has the default and large suites’ limits unchanged for a bucket of a thousand versions or fewer', () => {
    expect(guards.teardownLimits()).toEqual({
      passes: guards.TEARDOWN_PASSES,
      pages: guards.MAX_LISTING_PAGES,
      puts: guards.TEARDOWN_PUTS,
    });
    expect(guards.teardownLimits(1_000)).toEqual(guards.teardownLimits());
  });

  it('lets the batch suite list and delete every version its largest workload leaves, a thousand a pass', () => {
    const v = stagesLib.BATCH_MAX_VERSIONS;
    const limits = guards.teardownLimits(v);
    expect(limits.passes * 1_000).toBeGreaterThanOrEqual(v);
    expect(limits.pages * 1_000).toBeGreaterThanOrEqual(v);
    expect(limits.puts).toBeGreaterThan(guards.TEARDOWN_PUTS);
    // Three samples and two discarded ones, a thousand outputs each at an object, a pointer and a delete marker.
    expect(
      stagesLib.versionsOf({ operands: 100, outputs: 1_000, samples: 3, discardedSamples: 2 }),
    ).toBe(v);
  });

  it('is what the harness’s teardown reads, not a constant that would stop it at three passes', () => {
    expect(harnessSrc).toContain('if (pass === TEARDOWN.passes) {');
    expect(harnessSrc).toContain('if (pages.length === TEARDOWN.pages) {');
    expect(harnessSrc).toContain("teardownLimits(SUITE === 'batch' ? BATCH_MAX_VERSIONS : 0)");
  });
});

describe('the machine and the files', () => {
  it('has a memory floor of its own that the large suite’s is below, which an environment setting can raise and not lower', () => {
    const batch = { suite: 'batch', memoryMB: stagesLib.BATCH_MIN_MEMORY_MB };
    expect(stagesLib.BATCH_MIN_MEMORY_MB).toBe(1_280);
    // The large suite's own floor is lower than the batch suite's.
    expect(() => large.checkResources({ memoryMB: 1_000, diskMB: 10_000 })).not.toThrow();
    expect(() => large.checkResources({ memoryMB: 1_000, diskMB: 10_000 }, {}, batch)).toThrow(
      /the batch suite needs 1280 MiB/,
    );
    // At the floor it starts.
    expect(() =>
      large.checkResources({ memoryMB: 1_280, diskMB: 10_000 }, {}, batch),
    ).not.toThrow();
    // A setting above the floor raises it.
    expect(() =>
      large.checkResources({ memoryMB: 1_500, diskMB: 10_000 }, { memoryMB: 2_000 }, batch),
    ).toThrow(/needs 2000 MiB/);
    // A setting below it does not lower it.
    expect(() =>
      large.checkResources({ memoryMB: 1_000, diskMB: 10_000 }, { memoryMB: 500 }, batch),
    ).toThrow(/needs 1280 MiB/);
  });

  const modules = [
    'bench/lib/batch-counts.cjs',
    'bench/lib/calibrate-batch-stages.cjs',
    'bench/lib/calibrate-batch.cjs',
  ];
  it('are copied by the CloudShell script, named among the files whose edits mark a run dirty, and required by the harness', () => {
    const sh = src('bench', 'calibrate-cloudshell.sh');
    const cp = /^cp (bench\/lib\/[^"]+) "\$WORK\/bench\/lib\/"$/m.exec(sh)?.[1] ?? '';
    for (const m of modules) {
      expect(cp, m).toContain(m);
      expect(processLib.HARNESS_FILES, m).toContain(m);
      expect(sh.slice(sh.indexOf('harness_ref() {')), m).toContain(m);
    }
    expect(harnessSrc).toContain("require('./lib/calibrate-batch.cjs')");
    expect(harnessSrc).toContain("require('./lib/calibrate-batch-stages.cjs')");
    expect(harnessSrc).toContain("require('./lib/batch-counts.cjs')");
    // The script names the suite, and copies its evidence out beside the other suites'.
    expect(sh).toMatch(/'' \| default \| large \| batch\) ;;/);
    expect(sh).toContain('"$WORK"/bench/calibration/batch/*.json');
    expect(sh).toContain('"$WORK/bench/calibrate-aws-rehearsal-batch.json"');
    expect(sh).toContain('dir="bench/calibration/batch"');
  });

  it('are the harness’s own: a copy of the batch suite’s count reads nothing but the published packages', () => {
    for (const m of modules) {
      const text = src(...m.split('/'));
      expect(text, m).not.toMatch(/require\(['"]roaring['"]\)/);
    }
  });
});

describe('the harness, run', () => {
  // The refusals are made from the inputs alone, before the library is imported, so they cost nothing. No run is ever
  // authorised here.
  const home = mkdtempSync(join(tmpdir(), 'calib-batch-no-aws-'));
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

  it('refuses a setting of another suite under --suite batch, and a batch setting under another suite, with the exit code of every bad input', () => {
    const other = harness(['--suite', 'batch'], { CR_CALIBRATE_SEGMENTS: '5' });
    expect(other.status).toBe(2);
    expect(other.stderr).toMatch(/CR_CALIBRATE_SEGMENTS size another suite/);
    const large_ = harness(['--suite', 'batch'], { CR_CALIBRATE_LARGE_READS: '5' });
    expect(large_.status).toBe(2);
    for (const args of [[], ['--suite', 'large']]) {
      const out = harness(args, { CR_CALIBRATE_BATCH_SAMPLES: '1' });
      expect(out.status, args.join(' ')).toBe(2);
      expect(out.stderr).toMatch(/CR_CALIBRATE_BATCH_SAMPLES size the batch suite/);
    }
    const bad = harness(['--suite', 'batch'], { CR_CALIBRATE_BATCH_SHAPE: 'target' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/the shapes are refresh and small/);
    const many = harness(['--suite', 'batch'], { CR_CALIBRATE_BATCH_SAMPLES: '9' });
    expect(many.status).toBe(2);
    expect(many.stderr).toMatch(/object versions/);
  });

  it('says which suite runs first, and refuses a rehearsal below the batch floor before it creates anything', () => {
    const out = harness(['--rehearse', '--suite', 'batch'], {
      CR_CALIBRATE_LARGE_MIN_MEMORY_MB: '999999999',
    });
    expect(out.status).toBe(2);
    expect(out.stdout).toMatch(/calibrate: suite: batch \(named by --suite\)/);
    expect(out.stderr).toMatch(/the batch suite needs 999999999 MiB/);
    expect(out.stderr).toMatch(/Nothing was created/);
    expect(out.stdout).not.toMatch(/creating cloudbitmaps-calib/);
  });

  it('refuses a run that names no region, for the batch suite as for the others', () => {
    const out = harness(['--run', '--suite', 'batch']);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/CR_CALIBRATE_REGION must be set/);
  });
});

describe('each output is held to arithmetic that is not the engine', () => {
  // Plain sets, written here and nowhere else: the size of each output of the small shape, from the generator's ids alone.
  const bySets = (): number[] => {
    const byName = new Map<string, Set<number>>();
    for (const { index, ids } of batchCounts.batchOperands('small')) {
      byName.set(`op${index}`, new Set(ids));
    }
    type Expr = string | { and: Expr[] } | { or: Expr[] } | { andNot: Expr[] };
    const ev = (e: Expr): Set<number> => {
      if (typeof e === 'string') return byName.get(e) as Set<number>;
      if ('and' in e) {
        const [h, ...t] = e.and.map(ev);
        return new Set([...(h as Set<number>)].filter((x) => t.every((o) => o.has(x))));
      }
      if ('or' in e) return new Set(e.or.flatMap((k) => [...ev(k)]));
      const [h, ...t] = e.andNot.map(ev);
      return new Set([...(h as Set<number>)].filter((x) => t.every((o) => !o.has(x))));
    };
    return batchCounts.batchSpecs('small').map((spec) => {
      const out = ev(spec.expr as Expr);
      const gone = spec.exclude.map((n) => byName.get(n) as Set<number>);
      return [...out].filter((x) => gone.every((o) => !o.has(x))).length;
    });
  };

  it('is the size plain sets give, and the engine’s own in-memory count agrees with it', async () => {
    const sizes = batchCounts.expectedSizes('small');
    expect(sizes).toEqual(bySets());
    expect(sizes.some((n) => n > 0)).toBe(true);
    const c = await smallCounts;
    expect(c.sizes).toEqual(sizes);
    c.batch.outputs.forEach((o, i) => {
      if (o.published) expect(o.cardinality, `output ${i}`).toBe(sizes[i]);
    });
  }, 120_000);

  it('uses no library code to work them out', () => {
    const text = src('bench', 'lib', 'batch-counts.cjs');
    const code = text
      .slice(text.indexOf('function intersectSorted'), text.indexOf('function outcomeOf('))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain('function expectedSizes(');
    expect(code).not.toMatch(/require\(|engine|CloudRoaring|MemoryStorage|roaring/i);
  });

  it('refuses a count that is not the arithmetic’s, when the engine and the sets disagree', async () => {
    // An engine that counts every output one too high: its in-memory count is refused before any run rests on it.
    type Many = { outputs: { published: boolean; cardinality?: number }[] };
    class Off {
      private readonly inner: CloudRoaring;
      constructor(options: ConstructorParameters<typeof CloudRoaring>[0]) {
        this.inner = new CloudRoaring(options);
      }
      segment(name: string) {
        return this.inner.segment(name);
      }
      load(ref: { segment: string }, ids: Uint32Array) {
        return (
          this.inner as unknown as { load: (r: unknown, i: Uint32Array) => Promise<unknown> }
        ).load(ref, ids);
      }
      async materializeMany(options: unknown): Promise<Many> {
        const run = (await (
          this.inner as unknown as { materializeMany: (o: unknown) => Promise<Many> }
        ).materializeMany(options)) as Many & Record<string, unknown>;
        return {
          ...run,
          outputs: run.outputs.map((o, i) =>
            i === 1 && o.published ? { ...o, cardinality: (o.cardinality ?? 0) + 1 } : o,
          ),
        };
      }
    }
    const wrapped = { MemoryStorage, CloudRoaring: Off };
    await expect(batchCounts.countBatch({ shape: 'small', engine: wrapped })).rejects.toThrow(
      /output 1: the engine's in-memory count is \d+, and set arithmetic over the generator's ids gives \d+/,
    );
  }, 120_000);

  it('refuses a count whose output would be a multipart upload on S3, which the counts do not model', async () => {
    class Big extends MemoryStorage {
      constructor() {
        super();
        const put = this.storage.putImmutable.bind(this.storage);
        this.storage.putImmutable = async (...a: Parameters<typeof put>) => ({
          ...(await put(...a)),
          size: 9 * 1024 * 1024,
        });
      }
    }
    await expect(
      batchCounts.countBatch({ shape: 'small', engine: { CloudRoaring, MemoryStorage: Big } }),
    ).rejects.toThrow(/would be a multipart upload on S3/);
  }, 120_000);

  it('reads each published output back through a bounded pool, and passes nothing for one not published', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const outcomes = Array.from({ length: 100 }, (_, i) => ({ published: i % 10 !== 0 }));
    const got = await batchCounts.readBackCounts(outcomes, (i) => ({
      count: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        seen.push(i);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return i * 2;
      },
    }));
    expect(got.map((x, i) => (outcomes[i]?.published ? x === i * 2 : x === null))).not.toContain(
      false,
    );
    expect(seen).toHaveLength(90);
    expect(peak).toBeLessThanOrEqual(batchCounts.READ_BACK_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('is what the stage checks after the call: a read-back that is not the size fails, a size that is accepted', () => {
    const sizes = [5, 0, 7];
    expect(() => stagesLib.checkReadBack([5, 0, 7], sizes, [true, true, true])).not.toThrow();
    expect(() => stagesLib.checkReadBack([5, null, 7], sizes, [true, false, true])).not.toThrow();
    for (const bad of [
      [6, 0, 7],
      [4, 0, 7],
      [5, 1, 7],
      [5, 0, 8],
    ]) {
      expect(() => stagesLib.checkReadBack(bad, sizes, [true, true, true]), `${bad}`).toThrow(
        /reads back \d+ ids from the store; expected exactly/,
      );
    }
    expect(() => stagesLib.checkReadBack([5, 0], sizes, [true, true, true])).toThrow(
      /2 outputs read back; expected 3/,
    );
  });
});

describe('a sample that meets a fault is run again, and one that counts wrongly is not', () => {
  // Through the harness's own ledger: an output that came back with a transient error is discarded and run again from the
  // start, and a call whose count is wrong fails the stage at once, with nothing run again.
  const sdk = processLibFor().sdkFaultClasses(ROOT);
  const reqs = () => ({
    put: 0,
    get: 0,
    bytesUp: 0,
    bytesDown: 0,
    parts: 0,
    reads: {
      whole: { n: 0, bytes: 0 },
      suffix: { n: 0, bytes: 0 },
      range: { n: 0, bytes: 0 },
    },
  });
  const ledger = () =>
    samples.discardLedger({
      isTransient: (err: unknown) => samples.transientFault(err, sdk),
      snap: () => 0,
      between: () => reqs(),
      settle: async () => true,
    });
  const want: Outcome[] = [
    { published: true, cardinality: 10 },
    { published: true, cardinality: 20 },
  ];

  it('runs the attempt again for an output that failed with a transient fault', async () => {
    const l = ledger();
    l.begin('batch');
    let attempts = 0;
    const transient = Object.assign(new Error('slow down'), {
      name: 'SlowDown',
      $retryable: { throttling: true },
    });
    const out = await l.sample('materializeMany', 0, async () => {
      attempts += 1;
      const got =
        attempts === 1
          ? [
              { published: true, cardinality: 10 },
              { published: false, error: transient },
            ]
          : want;
      stagesLib.checkOutputs(got, want);
      return 'done';
    });
    l.end();
    expect(out).toBe('done');
    expect(attempts).toBe(2);
    expect(l.count).toBe(1);
  });

  it('fails the stage, with no second attempt, for a count that is one off', async () => {
    const l = ledger();
    l.begin('batch');
    let attempts = 0;
    await expect(
      l.sample('materializeMany', 0, async () => {
        attempts += 1;
        stagesLib.checkOutputs(
          [
            { published: true, cardinality: 10 },
            { published: true, cardinality: 21 },
          ],
          want,
        );
        return 'done';
      }),
    ).rejects.toThrow(/output 1 holds 21 ids; expected exactly 20/);
    expect(attempts).toBe(1);
    expect(l.count).toBe(0);
  });

  it('fails the stage, with no second attempt, for a read-back that is one off', async () => {
    const l = ledger();
    l.begin('batch');
    let attempts = 0;
    await expect(
      l.sample('materializeMany', 0, async () => {
        attempts += 1;
        stagesLib.checkReadBack([10, 21], [10, 20], [true, true]);
        return 'done';
      }),
    ).rejects.toThrow(/output 1 reads back 21 ids/);
    expect(attempts).toBe(1);
  });
});

function processLibFor() {
  return require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
    sdkFaultClasses: (
      root: string,
    ) => Record<
      'isThrottlingError' | 'isTransientError' | 'isServerError',
      (e: unknown) => boolean
    >;
  };
}

describe('the memory it needs is read from the container as well as from the host', () => {
  const resources = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-resources.cjs')) as {
    cgroupLimitMB: (read?: (f: string) => string) => number | null;
    availableMemoryMB: (read?: (f: string) => string) => { mb: number | null; kind: string };
  };
  const files =
    (map: Record<string, string>) =>
    (f: string): string => {
      if (f in map) return map[f] as string;
      throw new Error(`ENOENT ${f}`);
    };
  const MEMINFO = 'MemTotal: 16000000 kB\nMemAvailable: 8388608 kB\n';

  it('reads cgroup v2’s memory.max and v1’s memory.limit_in_bytes, and no limit as none', () => {
    expect(resources.cgroupLimitMB(files({ '/sys/fs/cgroup/memory.max': '1073741824\n' }))).toBe(
      1_024,
    );
    expect(
      resources.cgroupLimitMB(
        files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '2147483648\n' }),
      ),
    ).toBe(2_048);
    expect(resources.cgroupLimitMB(files({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull();
    expect(
      resources.cgroupLimitMB(
        files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n' }),
      ),
    ).toBeNull();
    expect(resources.cgroupLimitMB(files({}))).toBeNull();
    expect(resources.cgroupLimitMB(files({ '/sys/fs/cgroup/memory.max': 'lots' }))).toBeNull();
  });

  it('takes the lower of MemAvailable and the container’s limit, and says which it was', () => {
    // 8,192 MiB available on the host, and a container limited to 1,024 MiB: the limit is what a process can take.
    expect(
      resources.availableMemoryMB(
        files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': '1073741824' }),
      ),
    ).toEqual({ mb: 1_024, kind: 'limit' });
    // A limit above what is available changes nothing.
    expect(
      resources.availableMemoryMB(
        files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': '17179869184' }),
      ),
    ).toEqual({ mb: 8_192, kind: 'available' });
    // No limit: as before.
    expect(resources.availableMemoryMB(files({ '/proc/meminfo': MEMINFO }))).toEqual({
      mb: 8_192,
      kind: 'available',
    });
    // The limit alone, where /proc/meminfo is not readable.
    expect(
      resources.availableMemoryMB(files({ '/sys/fs/cgroup/memory.max': '1073741824' })),
    ).toEqual({ mb: 1_024, kind: 'limit' });
  });

  it('refuses a container whose limit is under the batch suite’s floor, though the host has room', () => {
    const have = resources.availableMemoryMB(
      files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': '1073741824' }),
    );
    expect(() =>
      large.checkResources(
        { memoryMB: have.mb, diskMB: 10_000 },
        {},
        {
          suite: 'batch',
          memoryMB: stagesLib.BATCH_MIN_MEMORY_MB,
        },
      ),
    ).toThrow(/1024 MiB of memory available, the batch suite needs 1280 MiB/);
  });

  it('derives the discards the batch stage may make from the run’s and the stage’s limits, not a number of its own', () => {
    expect(stagesLib.DISCARDED_SAMPLES).toBe(
      Math.min(samples.DISCARDS_PER_RUN, samples.DISCARDS_PER_STAGE),
    );
  });
});
