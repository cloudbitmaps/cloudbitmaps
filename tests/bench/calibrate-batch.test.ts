import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
};
const batchCounts = require_(join(ROOT, 'bench', 'lib', 'batch-counts.cjs')) as {
  lcg: (seed: number) => () => number;
  batchOperands: (shape: string) => Generator<{ index: number; ids: Uint32Array }>;
  batchSpecs: (shape: string) => { expr: unknown; exclude: string[] }[];
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
const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  DISCARDS_PER_RUN: number;
  DISCARDS_PER_STAGE: number;
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
    // Every destination is new, so each output is one object and one registry create: two PUT-class requests.
    expect(c.put).toBeGreaterThanOrEqual(2 * c.published);
  }, 120_000);

  it('hold the stages to the counts: the loads a first load each, the batch the samples times one call', async () => {
    const counts = await smallCounts;
    const e = stagesLib.expectedBatch(planOf(counts, 'small', 3));
    const first = stages.firstLoadRequests(0);
    const load = {
      put: counts.operandBytes.length * first.put,
      get: counts.operandBytes.length * first.get,
    };
    expect(e.batchLoad).toEqual(load);
    expect(e.batch).toEqual({ put: 3 * counts.batch.put, get: 3 * counts.batch.get });
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
    expect(b.stages.batch).toEqual({
      put: 3 * stagesLib.withHeadroom(counts.batch.put),
      get: 3 * stagesLib.withHeadroom(counts.batch.get),
    });
    expect(b.costliestSample).toBe(stagesLib.withHeadroom(counts.batch.get));
    const none = stagesLib.projectBatch(planOf(counts, 'small', 0));
    expect(none.stages.batch).toEqual({ put: 0, get: 0 });
    expect(none.discards).toEqual({ put: 0, get: 0 });
  }, 120_000);

  it('allows the discards only the batch stage can make: the fewer of a run’s and a stage’s, at the costliest sample', async () => {
    const counts = await smallCounts;
    const plan = planOf(counts, 'small', 3);
    const sample = {
      put: stagesLib.withHeadroom(counts.batch.put),
      get: stagesLib.withHeadroom(counts.batch.get),
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
    batch: { put: 12, get: 30, groups: 2, published: 5, refused: 1, outputs: wantOutputs },
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
    discardFirst = false,
    planOverride = plan,
  }: {
    answer?: (o: Outcome[]) => unknown[];
    extraGets?: number;
    discardFirst?: boolean;
    planOverride?: typeof plan;
  } = {}) => {
    const tally = { get: 0, put: 0 };
    const dests: string[][] = [];
    let calls = 0;
    const store = {
      segment: (name: string) => name,
      materializeMany: async (o: { outputs: { dest: string }[] }) => {
        dests.push(o.outputs.map((x) => x.dest));
        tally.get += 30 + extraGets;
        tally.put += 12;
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
        groups: 2,
        published: 5,
      });
    }
    expect(tally).toEqual({ get: 60, put: 24 });
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

  it('records a request count off by one as a miss in each sample and in the stage’s total, and the run carries on', async () => {
    const exact = await run();
    const over = await run({ extraGets: 1 });
    expect(over.failure).toBeUndefined();
    expect(exact.missed).toEqual([]);
    expect(over.missed).toHaveLength(2);
    expect(over.missed[0]).toMatch(/sample 0: 12 PUT-class and 31 GET-class, expected 12 and 30/);
    const want = { put: 24, get: 60 };
    expect(large.countMisses({ put: exact.tally.put, get: exact.tally.get }, want)).toEqual([]);
    expect(large.countMisses({ put: over.tally.put, get: over.tally.get }, want)).toEqual([
      { class: 'GET-class', kept: 62, expected: 60 },
    ]);
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
    expectedMissed?: string[];
    projectionExceeded?: string[];
    phases?: Record<
      string,
      {
        requests?: Bound;
        discarded?: { requests: Bound }[];
        expectedGets?: number;
        expectedPuts?: number;
      }
    >;
    workload?: { expected?: Record<string, Bound> };
    cost?: unknown;
  }
  // The gate on a finished run: its suite, both stages, and every stage's kept requests (those of its discarded samples
  // left out) equal to what the plan expected, in both classes.
  const problemsWith = (run: Run): string[] => {
    const out: string[] = [];
    if (run.suite !== 'batch') out.push('not a run of the batch suite');
    if (run.partial !== false) out.push('partial');
    if (run.expectedMissed !== undefined) out.push('an expected count was missed');
    if (run.projectionExceeded !== undefined) out.push('the projection was exceeded');
    for (const name of stagesLib.BATCH_STAGES) {
      const phase = run.phases?.[name];
      if (phase === undefined) {
        out.push(`${name} did not run`);
        continue;
      }
      const dropped = (phase.discarded ?? []).reduce(
        (a, d) => ({ put: a.put + d.requests.put, get: a.get + d.requests.get }),
        { put: 0, get: 0 },
      );
      const kept = {
        put: (phase.requests?.put ?? 0) - dropped.put,
        get: (phase.requests?.get ?? 0) - dropped.get,
      };
      const want = run.workload?.expected?.[name];
      if (want === undefined || kept.put !== want.put || kept.get !== want.get) {
        out.push(
          `${name} kept ${kept.put} PUT-class and ${kept.get} GET-class, expected ${JSON.stringify(want)}`,
        );
      }
    }
    if (run.cost === undefined) out.push('no bill');
    return out;
  };

  const complete = async (): Promise<Run> => {
    const counts = await smallCounts;
    const plan = planOf(counts, 'small', 3);
    const expected = stagesLib.expectedBatch(plan);
    return {
      suite: 'batch',
      partial: false,
      phases: Object.fromEntries(
        stagesLib.BATCH_STAGES.map((n) => [
          n,
          {
            requests: { put: expected[n]?.put ?? 0, get: expected[n]?.get ?? 0 },
            discarded: [],
            expectedPuts: expected[n]?.put,
            expectedGets: expected[n]?.get,
          },
        ]),
      ),
      workload: { expected },
      cost: { totalUSD: 0.01 },
    };
  };
  const mutate = async (change: (r: Run) => void): Promise<Run> => {
    const copy = JSON.parse(JSON.stringify(await complete())) as Run;
    change(copy);
    return copy;
  };

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
    expect(problemsWith(await mutate((r) => delete r.suite))).toContain(
      'not a run of the batch suite',
    );
    expect(problemsWith(await mutate((r) => (r.expectedMissed = ['x'])))).toContain(
      'an expected count was missed',
    );
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
  it('has a memory floor of its own, above the large suite’s, which an environment setting can raise and not lower', () => {
    const have = { memoryMB: 1_000, diskMB: 10_000 };
    expect(() => large.checkResources(have)).not.toThrow();
    expect(() => large.checkResources(have, {}, { suite: 'batch', memoryMB: 1_280 })).toThrow(
      /the batch suite needs 1280 MiB/,
    );
    expect(() =>
      large.checkResources(
        { memoryMB: 2_000, diskMB: 10_000 },
        {},
        { suite: 'batch', memoryMB: 1_280 },
      ),
    ).not.toThrow();
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
