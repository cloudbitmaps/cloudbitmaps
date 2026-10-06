import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

// The large suite (`--suite large`): combines on operands of about 10^6, 5 x 10^6 and 10^7 ids. It is a suite of its
// own, with its own stages, bound, expected counts and evidence directory, so the default suite's figures and gates
// cannot move. Each claim the suite makes is held here against the real engine or the engine's source.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Bound = { put: number; get: number };
type Layout = {
  shared: number;
  priv: number;
  stride: number;
  sharedChunks: number;
  privateChunks: number;
  chunksPerSegment: number;
  bases: number[];
  ownSums: number[];
  expected: { count: number; sum: number };
};
type Call = { ids: number; objectBytes: number; parts: number; put: number; get: number };
type ReadCount = { pointer: number; tail: number; range: number; gets: number; ids: number };
type Counts = {
  operandBytes: number[];
  reads: Record<'intersect' | 'union' | 'andNot', ReadCount>;
  into: Record<'intersectInto' | 'unionInto' | 'andNotInto', Call[]>;
};
type Size = {
  n: number;
  chunksPerSegment: number;
  sharedChunks: number;
  operandBytes: number[];
  counts: Counts;
};
type Plan = {
  sizes: Size[];
  reads: number;
  intos: number;
  retryBound: number;
  discards: { perRun: number; perStage: number };
  fixedPuts: number;
  fixedGets: number;
};

const large = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
  LARGE_STAGES: string[];
  LARGE_SIZES: number[];
  LARGE_CHUNKS: number;
  LARGE_OVERLAP: number;
  DEFAULT_LARGE_READS: number;
  DEFAULT_LARGE_INTOS: number;
  largeStride: (n: number) => number;
  planLargeLayout: (n: number) => Layout;
  largeExpectedContent: (
    l: Layout,
  ) => Record<'intersect' | 'union' | 'andNot', { count: number; sum: number }>;
  PART_BYTES: number;
  MAX_COALESCE_GAP_BYTES: number;
  MAX_COALESCED_READ_BYTES: number;
  MAX_CHUNK_BYTES: number;
  partsOf: (bytes: number) => number;
  rangeCap: (bytes: number) => number;
  INTO_READS: Record<string, string>;
  readBounds: (s: Size) => Record<'intersect' | 'union' | 'andNot', number>;
  outputBounds: (s: Size) => Record<string, number>;
  loadBound: (bytes: number, retry: number) => Bound;
  projectLarge: (w: Plan) => {
    stages: Record<string, Bound>;
    discards: Bound;
    costliestSample: number;
    total: Bound;
  };
  sampleBoundsLarge: (w: Plan) => Record<string, number>;
  expectedLarge: (w: Plan) => Record<string, Bound>;
  resolveLargeKnobs: (env: Record<string, string | undefined>) => { reads: number; intos: number };
  resolveSuite: (argv: string[], env: Record<string, string | undefined>) => string;
  DEFAULT_SUITE_KNOBS: string[];
  refuseDefaultKnobs: (env: Record<string, string | undefined>) => void;
  checkLargeWorkload: (i: { sizes: number; intos: number }) => void;
  LARGE_MIN_MEMORY_MB: number;
  LARGE_MIN_DISK_MB: number;
  checkResources: (
    have: { memoryMB: number | null; diskMB: number | null },
    floors?: { memoryMB?: number; diskMB?: number },
  ) => { memory: number; disk: number };
  resolveFloors: (env: Record<string, string | undefined>) => {
    memoryMB?: number;
    diskMB?: number;
  };
};
const counter = require_(join(ROOT, 'bench', 'lib', 'large-counts.cjs')) as {
  countSize: (i: {
    layout: Layout;
    layoutIds: (l: Layout, i: number) => Iterable<number>;
    intos: number;
    engine: unknown;
  }) => Promise<Counts>;
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  RETRY_BOUND: number;
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  planLayout: (i: {
    segments: number;
    idsPerSegment: number;
    overlap: number;
    stride: number;
  }) => Layout;
  layoutIds: (l: Layout, i: number) => Iterable<number>;
  resultsFile: (
    rehearse: boolean,
    runId?: string,
    options?: { partial?: boolean; stamp?: string; suite?: string },
  ) => string;
  suiteEvidenceDir: (suite: string) => string;
  EVIDENCE_DIR: string;
  projectOps: (i: Record<string, number>) => Bound;
  evidenceConflict: (i: {
    rehearse: boolean;
    file: string;
    exists: (f: string) => boolean;
  }) => string | null;
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
  firstLoadRequests: (parts: number) => Bound;
};
const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  DISCARDS_PER_RUN: number;
  DISCARDS_PER_STAGE: number;
};
const meterLib = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  priceTally: (
    t: Bound,
    p: { storage: { putPerMillion: number; getPerMillion: number } },
  ) => { totalUSD: number };
};
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  evidenceFiles: (root: string) => string[];
};
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  HARNESS_FILES: string[];
  resultsJson: (v: unknown) => string;
};
const resources = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-resources.cjs')) as {
  availableMemoryMB: (read?: (f: string) => string) => { mb: number | null; kind: string };
  freeDiskMB: (
    dir?: string,
    statfs?: (d: string) => { bavail: number; bsize: number },
  ) => number | null;
};

const src = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const harnessSrc = src('bench', 'calibrate-aws.cjs');
const pricing = { storage: { putPerMillion: 5, getPerMillion: 0.4 } };
const usd = (t: Bound): number => meterLib.priceTally(t, pricing).totalUSD;

// ---- the engine's counts, once, at the suite's real sizes -----------------------------------------------------------
// About thirteen seconds of CPU: the operands are loaded and every verb run on the in-memory backend, so each count below
// is the real engine's on the layout the suite loads. Run once and shared by the tests that read it.
const INTOS = 5;
const counted: Promise<Size[]> = (async () => {
  const out: Size[] = [];
  for (const n of large.LARGE_SIZES) {
    const layout = large.planLargeLayout(n);
    const counts = await counter.countSize({
      layout,
      layoutIds: guards.layoutIds,
      intos: INTOS,
      engine: { CloudRoaring, MemoryStorage },
    });
    out.push({
      n,
      chunksPerSegment: layout.chunksPerSegment,
      sharedChunks: layout.sharedChunks,
      operandBytes: counts.operandBytes,
      counts,
    });
  }
  return out;
})();

const planOf = (sizes: Size[], reads = 40, intos = INTOS): Plan => ({
  sizes,
  reads,
  intos,
  retryBound: guards.RETRY_BOUND,
  discards: { perRun: samples.DISCARDS_PER_RUN, perStage: samples.DISCARDS_PER_STAGE },
  fixedPuts: 16,
  fixedGets: 11,
});

describe('the large suite is a suite of its own', () => {
  it('names the suite from --suite or CR_CALIBRATE_SUITE, and the default one when neither is given', () => {
    expect(large.resolveSuite([], {})).toBe('default');
    expect(large.resolveSuite(['--rehearse'], { CR_CALIBRATE_SUITE: '  ' })).toBe('default');
    expect(large.resolveSuite(['--suite', 'large'], {})).toBe('large');
    expect(large.resolveSuite([], { CR_CALIBRATE_SUITE: 'large' })).toBe('large');
    expect(large.resolveSuite(['--suite', 'large'], { CR_CALIBRATE_SUITE: 'large' })).toBe('large');
    expect(large.resolveSuite(['--suite', 'default'], {})).toBe('default');
  });

  // A run that measured another suite than the one asked for would write its evidence under the wrong name.
  it('refuses a suite that does not exist, two that disagree, and a --suite with no name', () => {
    expect(() => large.resolveSuite(['--suite', 'huge'], {})).toThrow(/--suite is "huge"/);
    expect(() => large.resolveSuite([], { CR_CALIBRATE_SUITE: 'Large' })).toThrow(
      /CR_CALIBRATE_SUITE is "Large"/,
    );
    expect(() =>
      large.resolveSuite(['--suite', 'large'], { CR_CALIBRATE_SUITE: 'default' }),
    ).toThrow(/different suites/);
    expect(() => large.resolveSuite(['--suite'], {})).toThrow(/needs a name/);
    expect(() => large.resolveSuite(['--suite', '--rehearse'], {})).toThrow(/needs a name/);
  });

  it('has its own stages, none of them the default suite’s, in the order the runner runs them', () => {
    expect(large.LARGE_STAGES).toEqual([
      'largeLoad',
      'largeIntersect',
      'largeUnion',
      'largeAndNot',
      'largeInto',
    ]);
    for (const name of large.LARGE_STAGES) expect(stages.STAGES).not.toContain(name);
    // The runner opens each stage once, by a name in the table, and the table names no stage the runner skips.
    const runner = src('bench', 'lib', 'calibrate-large.cjs');
    const literal = [...runner.matchAll(/await stage\('(\w+)'/g)].map((m) => m[1]);
    const looped = [...runner.matchAll(/^\s+(large\w+): \{$/gm)].map((m) => m[1]);
    const opened = new Set([...literal, ...looped]);
    expect([...opened].sort()).toEqual([...large.LARGE_STAGES].sort());
    expect(literal[0]).toBe('largeLoad');
    expect(literal.at(-1)).toBe('largeInto');
    expect(runner.indexOf("await stage('largeLoad'")).toBeLessThan(
      runner.indexOf('largeIntersect'),
    );
    expect(runner.indexOf('largeAndNot: {')).toBeLessThan(
      runner.indexOf("await stage('largeInto'"),
    );
  });

  it('is the harness’s own table when asked for: the projection, the end-of-run check and the refusal read it', () => {
    expect(harnessSrc).toContain(
      "const STAGES = SUITE === 'large' ? LARGE_STAGES : DEFAULT_STAGES;",
    );
    expect(harnessSrc).toContain('if (!STAGES.includes(name))');
    expect(harnessSrc).toContain('for (const name of STAGES) {');
    // The default suite's stages sit below the large suite's call, and the helper skips them for a large run.
    expect(harnessSrc).toContain(
      "if (SUITE === 'large' && DEFAULT_STAGES.includes(name)) return undefined;",
    );
    expect(harnessSrc.indexOf('await runLargeSuite(')).toBeLessThan(
      harnessSrc.indexOf("await stage('load'"),
    );
    // Every backstop the default suite has holds for the large one: the ceiling per sample, and the projection after.
    expect(harnessSrc).toContain('PROJECTION EXCEEDED');
    expect(harnessSrc).toContain('checkCeiling,');
    const runner = src('bench', 'lib', 'calibrate-large.cjs');
    expect(runner.match(/checkCeiling\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('reads two knobs, the reads of each kind and each *Into per size, at the published run’s 40 and 5', () => {
    expect(large.resolveLargeKnobs({})).toEqual({ reads: 40, intos: 5 });
    expect(large.DEFAULT_LARGE_READS).toBe(40);
    expect(large.DEFAULT_LARGE_INTOS).toBe(5);
    expect(
      large.resolveLargeKnobs({ CR_CALIBRATE_LARGE_READS: '3', CR_CALIBRATE_LARGE_INTOS: '0' }),
    ).toEqual({ reads: 3, intos: 0 });
    for (const bad of ['-1', '1.5', 'many']) {
      expect(() => large.resolveLargeKnobs({ CR_CALIBRATE_LARGE_READS: bad }), bad).toThrow(
        /CR_CALIBRATE_LARGE_READS/,
      );
      expect(() => large.resolveLargeKnobs({ CR_CALIBRATE_LARGE_INTOS: bad }), bad).toThrow(
        /CR_CALIBRATE_LARGE_INTOS/,
      );
    }
  });

  // A run that ignored a default-suite setting would measure something other than the setting says.
  it('refuses a default-suite workload setting under --suite large, each one by name', () => {
    expect(() => large.refuseDefaultKnobs({})).not.toThrow();
    expect(() => large.refuseDefaultKnobs({ CR_CALIBRATE_READS: '  ' })).not.toThrow();
    for (const knob of large.DEFAULT_SUITE_KNOBS) {
      expect(() => large.refuseDefaultKnobs({ [knob]: '5' }), knob).toThrow(knob);
    }
    // Every knob the default suite reads is on the list.
    const read = new Set(
      [...harnessSrc.matchAll(/process\.env\.(CR_CALIBRATE_\w+)/g)].map((m) => m[1] ?? ''),
    );
    for (const k of [
      'CR_CALIBRATE_SEGMENTS',
      'CR_CALIBRATE_IDS',
      'CR_CALIBRATE_READS',
      'CR_CALIBRATE_SWEEP_SEGMENTS',
      'CR_CALIBRATE_ANDNOT_CALLS',
      'CR_CALIBRATE_LARGE',
    ]) {
      expect(read.has(k), k).toBe(true);
      expect(large.DEFAULT_SUITE_KNOBS, k).toContain(k);
    }
  });

  it('refuses a workload whose object versions teardown’s first listing could not reach', () => {
    expect(() => large.checkLargeWorkload({ sizes: 3, intos: 5 })).not.toThrow();
    expect(() => large.checkLargeWorkload({ sizes: 3, intos: 60 })).toThrow(/object versions/);
  });
});

describe('the shapes', () => {
  it('spread about 1,500 chunks a segment at the stride that gives them: 98, 19 and 9', () => {
    expect(large.LARGE_SIZES).toEqual([1_000_000, 5_000_000, 10_000_000]);
    expect(large.LARGE_CHUNKS).toBe(1_500);
    expect(large.LARGE_SIZES.map(large.largeStride)).toEqual([98, 19, 9]);
    for (const n of large.LARGE_SIZES) {
      expect(large.largeStride(n)).toBe(Math.floor((1_500 * 65_536) / n));
    }
  });

  it('are planLayout’s own layout of two operands sharing 20 %, with no change to planLayout', () => {
    for (const n of large.LARGE_SIZES) {
      const layout = large.planLargeLayout(n);
      expect(layout).toEqual(
        guards.planLayout({
          segments: 2,
          idsPerSegment: n,
          overlap: 0.2,
          stride: large.largeStride(n),
        }),
      );
      expect(layout.shared).toBe(n * 0.2);
      expect(layout.chunksPerSegment).toBeGreaterThanOrEqual(1_350);
      expect(layout.chunksPerSegment).toBeLessThanOrEqual(1_500);
      // Every id fits a 32-bit id space, and each operand's own band sits past the shared core.
      const top = (layout.bases[1] ?? 0) + layout.priv * layout.stride;
      expect(top).toBeLessThan(2 ** 32);
    }
    expect(large.LARGE_OVERLAP).toBe(0.2);
    // The default layout refuses these sizes at its own stride, which is why the suite has a layout of its own.
    expect(() =>
      guards.planLayout({ segments: 20, idsPerSegment: 1_000_000, ...guards.DEFAULT_LAYOUT }),
    ).toThrow(/32-bit id space/);
  });

  it('read exactly the ids the layout says, held by a sum that stays exact', () => {
    for (const n of large.LARGE_SIZES) {
      const layout = large.planLargeLayout(n);
      const c = large.largeExpectedContent(layout);
      expect(c.intersect).toEqual(layout.expected);
      expect(c.union.count).toBe(layout.shared + 2 * layout.priv);
      expect(c.andNot.count).toBe(layout.priv);
      for (const v of Object.values(c)) expect(Number.isSafeInteger(v.sum)).toBe(true);
    }
  });
});

describe('the expected counts, counted against the real engine', () => {
  it('give each operand’s object size and so its parts: none, two and two at 8 MiB', async () => {
    const sizes = await counted;
    expect(sizes.map((s) => s.operandBytes.map(large.partsOf))).toEqual([
      [0, 0],
      [2, 2],
      [2, 2],
    ]);
    // About 2.0, 10.0 and 11.3 MB.
    expect(sizes.map((s) => Math.round((s.operandBytes[0] ?? 0) / 1e5) / 10)).toEqual([
      2, 10, 11.3,
    ]);
    expect(large.partsOf(large.PART_BYTES)).toBe(0);
    expect(large.partsOf(large.PART_BYTES + 1)).toBe(2);
  }, 120_000);

  it('are the engine’s: each cold read in a pointer and a tail an operand and its ranges', async () => {
    const sizes = await counted;
    const gets = (s: Size, v: 'intersect' | 'union' | 'andNot'): number => s.counts.reads[v].gets;
    expect(sizes.map((s) => gets(s, 'intersect'))).toEqual([6, 8, 10]);
    expect(sizes.map((s) => gets(s, 'union'))).toEqual([8, 24, 26]);
    expect(sizes.map((s) => gets(s, 'andNot'))).toEqual([7, 16, 18]);
    for (const s of sizes) {
      const c = large.largeExpectedContent(large.planLargeLayout(s.n));
      for (const v of ['intersect', 'union', 'andNot'] as const) {
        const r = s.counts.reads[v];
        expect(r.pointer, `${s.n} ${v}`).toBe(2);
        expect(r.tail, `${s.n} ${v}`).toBe(2);
        expect(r.gets).toBe(r.pointer + r.tail + r.range);
        expect(r.ids, `${s.n} ${v}`).toBe(c[v].count);
      }
    }
  }, 120_000);

  it('make a repeated *Into onto one destination a non-first load, and take its parts from the output’s size', async () => {
    const sizes = await counted;
    for (const s of sizes) {
      for (const [verb, calls] of Object.entries(s.counts.into)) {
        expect(calls, `${s.n} ${verb}`).toHaveLength(INTOS);
        const [first, ...rest] = calls as [Call, ...Call[]];
        for (const call of rest) {
          // The repeats make what the first does, less the request that finds the destination absent.
          expect(call.put, `${s.n} ${verb}`).toBe(first.put);
          expect(call.get, `${s.n} ${verb}`).toBe(first.get - 1);
          expect(call.objectBytes).toBe(first.objectBytes);
        }
        // An object is one PUT, or a create, its parts and a complete; its pointer is one more request.
        const parts = large.partsOf(first.objectBytes);
        expect(first.parts).toBe(parts);
        expect(first.put).toBe((parts === 0 ? 1 : parts + 2) + 1);
      }
    }
    // The output parts, by size: an intersect's and a union's, an andNot's.
    const parts = (verb: 'intersectInto' | 'unionInto' | 'andNotInto'): number[] =>
      sizes.map((s) => s.counts.into[verb][0]?.parts ?? -1);
    expect(parts('intersectInto')).toEqual([0, 0, 0]);
    expect(parts('unionInto')).toEqual([0, 3, 3]);
    expect(parts('andNotInto')).toEqual([0, 0, 2]);
  }, 120_000);

  it('total, at 40 reads and 5 of each *Into, the figures the rehearsal is held to', async () => {
    const sizes = await counted;
    const e = large.expectedLarge(planOf(sizes));
    expect(e).toEqual({
      // Six loads: two single PUTs of 2 + 3, and four multipart objects of 2 parts, 5 PUT-class + 3 GET each.
      largeLoad: { put: 2 * 2 + 4 * 5, get: 6 * 3 },
      largeIntersect: { put: 0, get: 40 * (6 + 8 + 10) },
      largeUnion: { put: 0, get: 40 * (8 + 24 + 26) },
      largeAndNot: { put: 0, get: 40 * (7 + 16 + 18) },
      largeInto: { put: 145, get: 714 },
    });
    const put = Object.values(e).reduce((n, s) => n + s.put, 0);
    const get = Object.values(e).reduce((n, s) => n + s.get, 0);
    expect({ put, get }).toEqual({ put: 169, get: 5_652 });
    // And they follow the knobs: no reads, no *Intos, leaves the loads.
    const bare = large.expectedLarge(planOf(sizes, 0, 0));
    expect(bare.largeLoad).toEqual(e.largeLoad);
    expect(
      (bare.largeIntersect?.get ?? 0) + (bare.largeUnion?.get ?? 0) + (bare.largeAndNot?.get ?? 0),
    ).toBe(0);
    expect(bare.largeInto).toEqual({ put: 0, get: 0 });
    const half = large.expectedLarge(planOf(sizes, 20, 5));
    expect(half.largeUnion?.get).toBe((e.largeUnion?.get ?? 0) / 2);
  }, 120_000);

  // The operands go through `store.load()`, which checks that the generation's number is free, and a verb's publish does
  // not: the loads are counted by `firstLoadRequests` and the verbs' by the engine.
  it('count the operands’ loads as a first load on S3 does', async () => {
    const sizes = await counted;
    const e = large.expectedLarge(planOf(sizes));
    const loads = sizes.flatMap((s) =>
      s.operandBytes.map((b) => stages.firstLoadRequests(large.partsOf(b))),
    );
    expect(e.largeLoad).toEqual({
      put: loads.reduce((n, l) => n + l.put, 0),
      get: loads.reduce((n, l) => n + l.get, 0),
    });
  }, 120_000);

  it('are held by the harness in both classes, per stage, so a wrong table fails the first rehearsal', () => {
    expect(harnessSrc).toContain('kept.put !== expectedPut');
    expect(harnessSrc).toContain('kept.get !== expected');
    expect(harnessSrc).toContain('EXPECTED COUNT MISSED');
    const runner = src('bench', 'lib', 'calibrate-large.cjs');
    // And each *Into call against its own expected requests.
    expect(runner).toContain('const want1 = expected[g];');
    expect(runner).toContain('recordMissed(');
  });
});

describe('the bound', () => {
  it('holds every stage, and every sample, at or above what the engine makes', async () => {
    const sizes = await counted;
    const w = planOf(sizes);
    const { stages: bounds } = large.projectLarge(w);
    const e = large.expectedLarge(w);
    expect(Object.keys(bounds)).toEqual(large.LARGE_STAGES);
    for (const name of large.LARGE_STAGES) {
      expect(bounds[name]?.get ?? 0, name).toBeGreaterThanOrEqual(e[name]?.get ?? 0);
      expect(bounds[name]?.put ?? 0, name).toBeGreaterThanOrEqual(e[name]?.put ?? 0);
    }
    for (const s of sizes) {
      const reads = large.readBounds(s);
      for (const v of ['intersect', 'union', 'andNot'] as const) {
        expect(reads[v], `${s.n} ${v}`).toBeGreaterThanOrEqual(s.counts.reads[v].gets);
      }
      const out = large.outputBounds(s);
      for (const [verb, calls] of Object.entries(s.counts.into)) {
        const load = large.loadBound(out[verb] ?? 0, guards.RETRY_BOUND);
        for (const call of calls) {
          expect(call.objectBytes).toBeLessThanOrEqual(out[verb] ?? 0);
          expect(call.put).toBeLessThanOrEqual(load.put);
          expect(call.get).toBeLessThanOrEqual(
            load.get + (reads[large.INTO_READS[verb] as 'intersect'] ?? 0),
          );
        }
      }
    }
    // A sample's bound covers what a call of its stage makes, so a discarded one is inside the allowance.
    const per = large.sampleBoundsLarge(w);
    expect(per.largeLoad).toBe(0);
    expect(per.largeUnion).toBeGreaterThanOrEqual(
      Math.max(...sizes.map((s) => s.counts.reads.union.gets)),
    );
    expect(per.largeInto ?? 0).toBeGreaterThan(per.largeUnion ?? 0);
  }, 120_000);

  it('prices the default plan, 40 reads and 5 of each *Into, under the five-cent ceiling with room', async () => {
    const sizes = await counted;
    const { total } = large.projectLarge(planOf(sizes));
    expect(usd(total)).toBeLessThan(0.05);
    // About a third of the ceiling at the most: bounding a range by bytes is what makes it fit.
    expect(usd(total)).toBeLessThan(0.02);
    const expected = large.expectedLarge(planOf(sizes));
    const spent = {
      put: Object.values(expected).reduce((n, s) => n + s.put, 0),
      get: Object.values(expected).reduce((n, s) => n + s.get, 0),
    };
    expect(usd(spent)).toBeLessThan(0.004);
    // Reads are projected at least as high as writes, as the default suite's are.
    expect(total.get).toBeGreaterThanOrEqual(total.put);
  }, 120_000);

  // Bounding by chunks, a request for every chunk of an operand, is what the default suite does. Here it would put the
  // same plan far over the ceiling, which is why a range is bounded by bytes.
  it('is far below the chunk-granular bound, which would not fit the ceiling', async () => {
    const sizes = await counted;
    const chunkBound = (s: Size): Record<'intersect' | 'union' | 'andNot', number> => ({
      intersect: 2 * (3 + s.sharedChunks),
      union: 2 * (3 + s.chunksPerSegment),
      andNot: 6 + s.chunksPerSegment + s.sharedChunks,
    });
    let chunkGets = 0;
    let byteGets = 0;
    for (const s of sizes) {
      for (const v of ['intersect', 'union', 'andNot'] as const) {
        chunkGets += 40 * chunkBound(s)[v];
        byteGets += 40 * large.readBounds(s)[v];
        expect(large.readBounds(s)[v]).toBeLessThanOrEqual(chunkBound(s)[v]);
      }
    }
    expect(usd({ put: 0, get: chunkGets })).toBeGreaterThan(0.05);
    expect(chunkGets).toBeGreaterThan(20 * byteGets);
  }, 120_000);

  it('is checked against the ceiling by the same path as the default suite, before anything is created', () => {
    const main = harnessSrc.indexOf('async function main');
    const refuse = harnessSrc.indexOf('breached(priced.totalUSD, ceiling)', main);
    expect(refuse).toBeGreaterThan(main);
    expect(refuse).toBeLessThan(harnessSrc.indexOf('new s3.CreateBucketCommand', main));
    // `priced` is the large suite's bound, priced, where the suite is large.
    expect(harnessSrc).toContain('priced = priceTally({ put: ops.put, get: ops.get }, pricing);');
  });
});

describe('the range cap', () => {
  const planSrc = src('packages', 'core', 'src', 'core', 'crbm', 'plan-reads.ts');
  const formatSrc = src('packages', 'core', 'src', 'core', 'crbm', 'format.ts');
  const s3Src = src('packages', 's3', 'src', 'storage.ts');
  const evaluate = (expr: string): number =>
    Function(`"use strict"; return (${expr});`)() as number;

  // The harness runs where the library's source is not, and neither constant is exported, so it keeps a copy of each and
  // this holds the copy to the source.
  it('keeps copies of the engine’s two constants and the driver’s part size, held to their source', () => {
    const gap = /export const MAX_COALESCE_GAP_BYTES = ([^;]+);/.exec(planSrc);
    expect(gap, 'the engine no longer names its gap this way').not.toBeNull();
    expect(large.MAX_COALESCE_GAP_BYTES).toBe(evaluate(gap?.[1] ?? ''));
    const read = /export const MAX_COALESCED_READ_BYTES: number = (\w+);/.exec(planSrc);
    expect(read, 'the engine no longer names its read cap this way').not.toBeNull();
    const cap = new RegExp(`export const ${read?.[1]} = ([^;]+);`).exec(formatSrc);
    expect(cap, 'the decode cap is no longer named this way').not.toBeNull();
    expect(large.MAX_COALESCED_READ_BYTES).toBe(evaluate(cap?.[1] ?? ''));
    const part = /const S3_PART_BYTES = ([^;]+);/.exec(s3Src);
    expect(part, 'the S3 driver no longer names its part size this way').not.toBeNull();
    expect(large.PART_BYTES).toBe(evaluate(part?.[1] ?? ''));
    // The coalescing rule is the one the cap is derived from: a gap of at most the one, a span of at most the other.
    expect(planSrc).toContain('extent.offset - end <= MAX_COALESCE_GAP_BYTES');
    expect(planSrc).toContain('extentEnd - start <= MAX_COALESCED_READ_BYTES');
  });

  // The rule is the owner's: nothing in the library changes for a bench. A constant exported from a package would be a
  // public surface the harness had asked for.
  it('adds no export to a package for the harness\u2019s sake', () => {
    for (const entry of ['packages/core/src/index.ts', 'packages/core/src/driver-kit.ts']) {
      expect(src(...entry.split('/')), entry).not.toMatch(/MAX_COALESCE|MAX_COALESCED/);
    }
  });

  // A chunk is small beside the gap and the cap, so two neighbouring reads start more than a gap apart: the premise of the
  // cap's derivation.
  it('rests on a chunk far smaller than the difference between the read cap and the gap', () => {
    expect(large.MAX_CHUNK_BYTES).toBeGreaterThanOrEqual(8 * 1024);
    expect(large.MAX_COALESCED_READ_BYTES - large.MAX_CHUNK_BYTES).toBeGreaterThanOrEqual(
      large.MAX_COALESCE_GAP_BYTES,
    );
    expect(large.rangeCap(0)).toBe(1);
    expect(large.rangeCap(256 * 1024)).toBe(2);
    expect(large.rangeCap(256 * 1024 + 1)).toBe(3);
  });

  type Verb = 'intersect' | 'union' | 'andNot';
  type Layout2 = { a: number[]; b: number[]; why: string };
  const seeded = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  };
  const chunkIds = (key: number, per: number, offset: number): number[] =>
    Array.from({ length: per }, (_, i) => key * 65_536 + ((i * 11 + offset) % 65_536));

  /** The ranges each operand of a cold read of `layout` makes, and the object each is. */
  async function ranges(layout: Layout2, verb: Verb): Promise<{ range: number; bytes: number }[]> {
    const backend = new MemoryStorage();
    const calls: Record<string, number> = { a: 0, b: 0 };
    const sizes: Record<string, number> = {};
    const getRange = backend.storage.getRange.bind(backend.storage);
    backend.storage.getRange = (k: { segment: string }, ...rest: [number, number]) => {
      calls[k.segment] = (calls[k.segment] ?? 0) + 1;
      return getRange(k as never, ...rest);
    };
    const put = backend.storage.putImmutable.bind(backend.storage);
    backend.storage.putImmutable = (async (k: { segment: string }, ...rest: unknown[]) => {
      const written = await (put as (...a: unknown[]) => Promise<{ size: number }>)(k, ...rest);
      sizes[k.segment] = written.size;
      return written;
    }) as never;
    const loader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await loader.load({ segment: 'a' }, layout.a);
    await loader.load({ segment: 'b' }, layout.b);
    calls.a = 0;
    calls.b = 0;
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const other = [store.segment('b')];
    const stream =
      verb === 'intersect'
        ? store.segment('a').intersect(other)
        : verb === 'union'
          ? store.segment('a').union(other)
          : store.segment('a').andNot(other);
    for await (const ids of stream.batches()) void ids;
    return [
      { range: calls.a ?? 0, bytes: sizes.a ?? 0 },
      { range: calls.b ?? 0, bytes: sizes.b ?? 0 },
    ];
  }

  /** A random selective layout: A holds many chunks of a random weight, B a share of A's keys. */
  function randomLayout(rnd: () => number): Layout2 {
    const per = [1, 5, 60, 900, 4_200, 5_000, 9_000][Math.floor(rnd() * 7)] ?? 1;
    const chunks = Math.max(
      20,
      Math.min(400, Math.floor(900_000 / per), 20 + Math.floor(rnd() * 380)),
    );
    const keys = new Set<number>();
    while (keys.size < chunks) keys.add(Math.floor(rnd() * 20_000));
    const ordered = [...keys].sort((x, y) => x - y);
    const share = [0.02, 0.05, 0.1, 0.5][Math.floor(rnd() * 4)] ?? 0.1;
    const picked = ordered.filter(() => rnd() < share);
    if (picked.length === 0) picked.push(ordered[0] ?? 0);
    return {
      a: ordered.flatMap((k) => chunkIds(k, per, 1)),
      b: picked.flatMap((k) => chunkIds(k, 3, 1)),
      why: `${chunks} chunks of ${per} ids, ${picked.length} wanted`,
    };
  }

  /**
   * A layout built to come close to the cap: every chunk a full bitset, and the wanted chunks `gap` chunks apart, so
   * each is a read of its own with a little over a gap of unwanted bytes between them.
   */
  function nearCap(gapChunks: number, chunks: number): Layout2 {
    const keys = Array.from({ length: chunks }, (_, i) => i);
    const wanted = keys.filter((k) => k % (gapChunks + 1) === 0);
    return {
      a: keys.flatMap((k) => chunkIds(k, 5_000, 1)),
      b: wanted.flatMap((k) => chunkIds(k, 3, 1)),
      why: `${chunks} bitset chunks, one wanted every ${gapChunks + 1}`,
    };
  }

  it('is never exceeded by the engine over random selective layouts and ones built to approach it, for any verb and either operand', async () => {
    const rnd = seeded(7);
    const layouts: Layout2[] = Array.from({ length: 40 }, () => randomLayout(rnd));
    // Random layouts use at most half the cap; these come near it: every wanted chunk a read of its own.
    for (const gap of [32, 33, 36, 40, 48]) layouts.push(nearCap(gap, 400));
    let worst = 0;
    for (const layout of layouts) {
      for (const verb of ['intersect', 'union', 'andNot'] as const) {
        for (const [i, r] of (await ranges(layout, verb)).entries()) {
          const cap = large.rangeCap(r.bytes);
          expect(r.range, `${verb} operand ${i}: ${layout.why}`).toBeLessThanOrEqual(cap);
          worst = Math.max(worst, r.range / cap);
        }
      }
    }
    expect(worst).toBeGreaterThan(0.8);
  }, 300_000);

  // The other direction, kept as a test: layouts built to defeat a tighter cap do, so the property above is able to
  // fail. A cap of half this one is exceeded by them, and this one is not.
  it('is able to fail: layouts built to approach it exceed half of it, and none exceeds it', async () => {
    let beyondHalf = 0;
    for (const gap of [31, 32, 33, 34, 40, 64]) {
      const layout = nearCap(gap, 600);
      const [a] = await ranges(layout, 'intersect');
      const cap = large.rangeCap(a?.bytes ?? 0);
      expect(a?.range, layout.why).toBeLessThanOrEqual(cap);
      if ((a?.range ?? 0) > Math.floor(cap / 2)) beyondHalf += 1;
    }
    expect(beyondHalf).toBeGreaterThanOrEqual(2);
    // 31 unwanted chunks of 8 KiB between two wanted ones is under the 256 KiB gap, so the reads merge; 33 is over it, so
    // each wanted chunk is a read of its own.
    const merged = (await ranges(nearCap(31, 600), 'intersect'))[0]?.range ?? 0;
    const apart = (await ranges(nearCap(33, 600), 'intersect'))[0]?.range ?? 0;
    expect(apart).toBeGreaterThan(3 * merged);
  }, 120_000);

  it('holds for the suite’s own shapes: every read at or under its bound, every range count under the cap', async () => {
    const sizes = await counted;
    for (const s of sizes) {
      const cap = large.rangeCap(Math.max(...s.operandBytes));
      for (const v of ['intersect', 'union', 'andNot'] as const) {
        const r = s.counts.reads[v];
        // `range` counts both operands' (an andNot's include, and the exclude where it overlaps).
        expect(r.range, `${s.n} ${v}`).toBeLessThanOrEqual(2 * cap);
        expect(r.gets, `${s.n} ${v}`).toBeLessThanOrEqual(large.readBounds(s)[v]);
      }
    }
  }, 120_000);
});

describe('the evidence of a large run', () => {
  const LARGE_DIR = join(ROOT, 'bench', 'calibration', 'large');

  it('goes under bench/calibration/large/, its partial runs and its rehearsal beside it and apart from the default suite’s', () => {
    expect(guards.suiteEvidenceDir('default')).toBe('bench/calibration');
    expect(guards.suiteEvidenceDir('large')).toBe('bench/calibration/large');
    expect(() => guards.suiteEvidenceDir('huge')).toThrow(/not a suite/);
    const id = '2026-10-07-a1b2c';
    expect(guards.resultsFile(false, id, { suite: 'large' })).toBe(
      `bench/calibration/large/${id}.json`,
    );
    expect(guards.resultsFile(false, id, { suite: 'large', partial: true })).toBe(
      `bench/calibration/large/${id}.partial.json`,
    );
    expect(guards.resultsFile(false, id, { suite: 'large', stamp: '20261007T010203004Z' })).toBe(
      `bench/calibration/large/${id}.20261007T010203004Z.partial.json`,
    );
    expect(guards.resultsFile(true, id, { suite: 'large' })).toBe(
      'bench/calibrate-aws-rehearsal-large.json',
    );
    // The default suite's paths are what they were, with and without the option.
    expect(guards.resultsFile(false, id)).toBe(`bench/calibration/${id}.json`);
    expect(guards.resultsFile(false, id, { suite: 'default', partial: true })).toBe(
      `bench/calibration/${id}.partial.json`,
    );
    expect(guards.resultsFile(true, id)).toBe('bench/calibrate-aws-rehearsal.json');
    expect(() => guards.resultsFile(false, id, { suite: 'huge' })).toThrow(/not a suite/);
    expect(() => guards.resultsFile(false, '../x', { suite: 'large' })).toThrow(/run id/);
  });

  it('takes its output paths from resultsFile, for the suite the run is, and names no file itself', () => {
    expect(harnessSrc).toContain('suiteResultsFile(rehearse, runId, { ...options, suite: SUITE })');
    expect(harnessSrc).toContain('resolve(ROOT, resultsFile(REHEARSE, runId))');
    expect(harnessSrc).not.toMatch(/bench\/calibration|calibrate-aws-rehearsal/);
    // A real run's evidence is write-once in the large directory as in the default one.
    const file = guards.resultsFile(false, '2026-10-07-a1b2c', { suite: 'large' });
    expect(guards.evidenceConflict({ rehearse: false, file, exists: (f) => f === file })).toMatch(
      /already exists/,
    );
  });

  it('is ignored by git when it is a partial run or a rehearsal, and not when it is evidence', () => {
    const ignored = (rel: string): boolean => {
      const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
      return r.status === 0;
    };
    const id = '2026-10-07-a1b2c';
    expect(ignored(guards.resultsFile(true, id, { suite: 'large' }))).toBe(true);
    expect(ignored(guards.resultsFile(false, id, { suite: 'large', partial: true }))).toBe(true);
    expect(
      ignored(guards.resultsFile(false, id, { suite: 'large', stamp: '20261007T010203004Z' })),
    ).toBe(true);
    expect(ignored(guards.resultsFile(false, id, { suite: 'large' }))).toBe(false);
  });

  // The default run's figures and its gates read `bench/calibration` without descending into it, so a file in the large
  // directory is not a run of theirs: not the latest evidence, not a report, whatever it holds and whenever it started.
  describe('is invisible to the default suite’s figures and report gates', () => {
    const tree = mkdtempSync(join(tmpdir(), 'large-evidence-'));
    afterAll(() => rmSync(tree, { recursive: true, force: true }));
    const dir = join(tree, 'bench', 'calibration');
    mkdirSync(join(dir, 'large'), { recursive: true });
    writeFileSync(
      join(dir, '2026-10-06-aaaaa.json'),
      JSON.stringify({ startedAt: '2026-10-06T10:00:00.000Z' }),
    );
    writeFileSync(join(dir, '2026-10-06-aaaaa.md'), '# report');
    writeFileSync(join(dir, 'README.md'), '# readme');
    // Newer than every default run, and the same kind of file.
    writeFileSync(
      join(dir, 'large', '2027-01-01-bbbbb.json'),
      JSON.stringify({ startedAt: '2027-01-01T00:00:00.000Z' }),
    );
    writeFileSync(join(dir, 'large', '2027-01-01-bbbbb.md'), '# a large report');
    writeFileSync(join(dir, 'large', '2027-01-01-ccccc.partial.json'), '{}');

    it('is not among the evidence files, and not the latest one', () => {
      const files = figures.evidenceFiles(tree);
      expect(files).toEqual([join('bench', 'calibration', '2026-10-06-aaaaa.json')]);
      expect(files.at(-1)).not.toContain('large');
    });

    it('is not among the reports the report gate reads, which it lists by name in the one directory', () => {
      const reports = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
      expect(reports).toEqual(['2026-10-06-aaaaa.md']);
    });

    it('leaves the real tree’s evidence the default suite’s alone', () => {
      const real = figures.evidenceFiles(ROOT);
      expect(real.length).toBeGreaterThanOrEqual(1);
      for (const f of real) expect(f.split(/[\\/]/)).not.toContain('large');
      for (const f of readdirSync(join(ROOT, 'bench', 'calibration')).filter((x) =>
        x.endsWith('.md'),
      )) {
        expect(f).not.toMatch(/large/);
      }
    });
  });

  // The gate on the large suite's own evidence: each committed run is a finished run of the large suite whose every stage
  // made the requests it was expected to. With no run committed it checks nothing and passes; it is proven below on a
  // fixture, a rehearsal's file, in both directions.
  interface LargeRun {
    suite?: string;
    partial?: boolean;
    interrupted?: boolean;
    expectedMissed?: string[];
    projectionExceeded?: string[];
    phases?: Record<
      string,
      {
        requests?: { put: number; get: number };
        discarded?: { requests: { put: number; get: number } }[];
        expectedGets?: number;
        expectedPuts?: number;
      }
    >;
    workload?: { expected?: Record<string, Bound> };
    cost?: { totalUSD: number };
    projected?: Bound;
  }
  const problemsWith = (run: LargeRun, { rehearsal = false } = {}): string[] => {
    const out: string[] = [];
    if (run.suite !== 'large') out.push('not a run of the large suite');
    if (run.partial !== false) out.push('partial');
    if (run.interrupted === true) out.push('interrupted');
    if (run.expectedMissed !== undefined) out.push('an expected count was missed');
    if (run.projectionExceeded !== undefined) out.push('the projection was exceeded');
    const phases = run.phases ?? {};
    for (const name of large.LARGE_STAGES) {
      const phase = phases[name];
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
    if (!rehearsal && run.cost === undefined) out.push('no bill');
    return out;
  };

  it('has committed runs, if any, that are finished, exact runs of the large suite', () => {
    const files = existsSync(LARGE_DIR)
      ? readdirSync(LARGE_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json'))
      : [];
    for (const f of files) {
      const run = JSON.parse(readFileSync(join(LARGE_DIR, f), 'utf8')) as LargeRun;
      expect(problemsWith(run), f).toEqual([]);
    }
    // Zero files is the state before the first run, and passes.
    expect(files.length).toBeGreaterThanOrEqual(0);
  });

  describe('the gate, proven on a rehearsal’s file', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(ROOT, 'tests', 'bench', 'fixtures', 'calibration-large-rehearsal.json'),
        'utf8',
      ),
    ) as LargeRun;
    const mutate = (change: (r: LargeRun) => void): LargeRun => {
      const copy = JSON.parse(JSON.stringify(fixture)) as LargeRun;
      change(copy);
      return copy;
    };

    it('passes a finished rehearsal whose every stage made the expected requests', () => {
      expect(fixture.suite).toBe('large');
      expect(problemsWith(fixture, { rehearsal: true })).toEqual([]);
      // The fixture is the harness's own text.
      expect(processLib.resultsJson(fixture)).toBe(
        readFileSync(
          join(ROOT, 'tests', 'bench', 'fixtures', 'calibration-large-rehearsal.json'),
          'utf8',
        ),
      );
      expect(Object.keys(fixture.phases ?? {})).toEqual(large.LARGE_STAGES);
    });

    it('fails a run of another suite, a partial one, one that missed a count, and one that overspent', () => {
      expect(
        problemsWith(
          mutate((r) => delete r.suite),
          { rehearsal: true },
        ),
      ).toContain('not a run of the large suite');
      expect(
        problemsWith(
          mutate((r) => (r.partial = true)),
          { rehearsal: true },
        ),
      ).toContain('partial');
      expect(
        problemsWith(
          mutate((r) => (r.expectedMissed = ['x'])),
          { rehearsal: true },
        ),
      ).toContain('an expected count was missed');
      expect(
        problemsWith(
          mutate((r) => (r.projectionExceeded = ['x'])),
          { rehearsal: true },
        ),
      ).toContain('the projection was exceeded');
    });

    it('fails a stage that did not run, one that made a request more or fewer, and a run with no bill', () => {
      expect(
        problemsWith(
          mutate((r) => delete r.phases?.largeInto),
          { rehearsal: true },
        ),
      ).toContain('largeInto did not run');
      for (const stage of large.LARGE_STAGES) {
        const more = mutate((r) => {
          const p = r.phases?.[stage];
          if (p?.requests) p.requests.get += 1;
        });
        expect(problemsWith(more, { rehearsal: true }).join('\n'), stage).toContain(
          `${stage} kept`,
        );
        const fewer = mutate((r) => {
          const p = r.phases?.[stage];
          if (p?.requests) p.requests.put = Math.max(0, p.requests.put - 1);
        });
        const got = problemsWith(fewer, { rehearsal: true }).join('\n');
        // A stage that makes no PUT-class request cannot make one fewer.
        if (stage === 'largeLoad' || stage === 'largeInto')
          expect(got, stage).toContain(`${stage} kept`);
      }
      expect(problemsWith(mutate((r) => delete r.cost))).toContain('no bill');
    });

    it('counts the requests of a discarded sample out of what a stage is held to', () => {
      const run = mutate((r) => {
        const p = r.phases?.largeUnion;
        if (!p?.requests) return;
        p.requests.get += 8;
        p.discarded = [{ requests: { put: 0, get: 8 } }];
      });
      expect(problemsWith(run, { rehearsal: true })).toEqual([]);
    });
  });
});

describe('the machine it runs on', () => {
  it('has floors it names, and refuses to start below them, naming each shortfall', () => {
    expect(large.LARGE_MIN_MEMORY_MB).toBeGreaterThanOrEqual(512);
    expect(large.LARGE_MIN_DISK_MB).toBeGreaterThan(0);
    const ok = { memoryMB: large.LARGE_MIN_MEMORY_MB, diskMB: large.LARGE_MIN_DISK_MB };
    expect(() => large.checkResources(ok)).not.toThrow();
    expect(() => large.checkResources({ ...ok, memoryMB: ok.memoryMB - 1 })).toThrow(
      new RegExp(`needs ${large.LARGE_MIN_MEMORY_MB} MiB`),
    );
    expect(() => large.checkResources({ ...ok, diskMB: ok.diskMB - 1 })).toThrow(/disk/);
    expect(() => large.checkResources({ memoryMB: 1, diskMB: 1 })).toThrow(/memory.*disk/);
    // A figure the machine could not give is a floor not met.
    expect(() => large.checkResources({ ...ok, memoryMB: null })).toThrow(/unknown/);
    expect(() => large.checkResources({ ...ok, diskMB: null })).toThrow(/unknown/);
    expect(() => large.checkResources({ ...ok, memoryMB: Number.NaN })).toThrow();
  });

  it('lets an environment setting raise a floor and never lower one', () => {
    expect(large.resolveFloors({})).toEqual({ memoryMB: undefined, diskMB: undefined });
    const up = large.resolveFloors({ CR_CALIBRATE_LARGE_MIN_MEMORY_MB: '4096' });
    expect(up.memoryMB).toBe(4096);
    expect(() => large.checkResources({ memoryMB: 2048, diskMB: 10_000 }, up)).toThrow(
      /needs 4096 MiB/,
    );
    expect(() => large.resolveFloors({ CR_CALIBRATE_LARGE_MIN_MEMORY_MB: '1' })).toThrow(
      /only raise/,
    );
    expect(() => large.resolveFloors({ CR_CALIBRATE_LARGE_MIN_DISK_MB: 'lots' })).toThrow(
      /only raise/,
    );
  });

  it('reads the memory available from the kernel where it says, and the disk free from the filesystem', () => {
    const meminfo = 'MemTotal:  8000000 kB\nMemFree: 100 kB\nMemAvailable:   2097152 kB\n';
    expect(resources.availableMemoryMB(() => meminfo)).toEqual({ mb: 2048, kind: 'available' });
    const none = resources.availableMemoryMB(() => {
      throw new Error('no /proc');
    });
    expect(none.kind).toBe('total');
    expect(none.mb).toBeGreaterThan(0);
    expect(resources.freeDiskMB('/x', () => ({ bavail: 1024, bsize: 1024 * 1024 }))).toBe(1024);
    expect(
      resources.freeDiskMB('/x', () => {
        throw new Error('no such directory');
      }),
    ).toBeNull();
  });

  it('prints what the machine has once, and refuses before the library is imported or anything is created', () => {
    const main = harnessSrc.indexOf('async function main');
    const print = harnessSrc.indexOf('resourcesNow()', main);
    const check = harnessSrc.indexOf('checkResources(', main);
    expect(print).toBeGreaterThan(main);
    expect(harnessSrc.match(/resourcesNow\(\)/g)).toHaveLength(1);
    expect(print).toBeLessThan(check);
    expect(check).toBeLessThan(harnessSrc.indexOf("await import('@cloudbitmaps/roaring')", main));
    expect(check).toBeLessThan(harnessSrc.indexOf('new s3.CreateBucketCommand', main));
    expect(harnessSrc).toContain(
      "if (SUITE === 'large' && (MODE === 'rehearse' || MODE === 'run')) {",
    );
  });
});

describe('the harness, run', () => {
  // The refusals are made from the inputs alone, before the library is imported, so they hold on a checkout that has
  // not been built, and cost nothing. No run is ever authorised here, and a child that runs on is killed.
  const home = mkdtempSync(join(tmpdir(), 'calib-large-no-aws-'));
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

  it('refuses a suite that does not exist, in any mode, with the exit code of every other bad input', () => {
    for (const args of [
      ['--suite', 'huge'],
      ['--rehearse', '--suite', 'huge'],
    ]) {
      const out = harness(args);
      expect(out.status, args.join(' ')).toBe(2);
      expect(out.stderr).toMatch(/--suite is "huge"/);
    }
    const env = harness([], { CR_CALIBRATE_SUITE: 'huge' });
    expect(env.status).toBe(2);
    expect(env.stderr).toMatch(/CR_CALIBRATE_SUITE is "huge"/);
    expect(harness(['--suite', 'large'], { CR_CALIBRATE_SUITE: 'default' }).stderr).toMatch(
      /different suites/,
    );
  });

  it('refuses a default-suite workload setting, and a knob it cannot read, before anything is created', () => {
    const set = harness(['--suite', 'large'], { CR_CALIBRATE_SEGMENTS: '5' });
    expect(set.status).toBe(2);
    expect(set.stderr).toMatch(/CR_CALIBRATE_SEGMENTS set the default suite's workload/);
    const bad = harness(['--suite', 'large'], { CR_CALIBRATE_LARGE_READS: 'many' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/CR_CALIBRATE_LARGE_READS/);
    // The same settings are the default suite's own, and are not refused there.
    const plain = harness([], { CR_CALIBRATE_SEGMENTS: '5', CR_CALIBRATE_READS: '2' });
    expect(plain.stderr).not.toMatch(/default suite's workload/);
  });

  it('refuses to start a rehearsal below a raised floor, after saying what the machine has', () => {
    const out = harness(['--rehearse', '--suite', 'large'], {
      CR_CALIBRATE_LARGE_MIN_MEMORY_MB: '999999999',
    });
    expect(out.status).toBe(2);
    expect(out.stdout).toMatch(
      /calibrate: resources: .* memory .* free in the home directory, \d+ CPUs/,
    );
    expect(out.stderr).toMatch(/needs 999999999 MiB of memory|needs 999999999 MiB/);
    expect(out.stderr).toMatch(/Nothing was created/);
    expect(out.stdout).not.toMatch(/creating cloudbitmaps-calib/);
  });

  it('refuses a run that names no region, for the large suite as for the default one', () => {
    const out = harness(['--run', '--suite', 'large']);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/CR_CALIBRATE_REGION must be set/);
  });

  it('refuses a committed large run id, and a default run id is another suite’s evidence, not a conflict', () => {
    const dir = join(ROOT, 'bench', 'calibration', 'large');
    mkdirSync(dir, { recursive: true });
    const id = '2026-10-07-zzzzz';
    const file = join(dir, `${id}.json`);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '{}');
    try {
      const large_ = harness(['--suite', 'large'], { CR_CALIBRATE_RUN_ID: id });
      expect(large_.status).toBe(2);
      expect(large_.stderr).toMatch(
        /bench\/calibration\/large\/2026-10-07-zzzzz\.json already exists/,
      );
      // The same id under the default suite is not taken: its evidence directory holds no such run.
      const other = harness([], { CR_CALIBRATE_RUN_ID: id });
      expect(other.stderr).not.toMatch(/already exists/);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('projects the large suite without touching anything: its bound under the ceiling, each stage listed', () => {
    const out = harness(['--suite', 'large']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/PROJECTION ONLY — nothing created, no credentials read/);
    for (const name of large.LARGE_STAGES) expect(out.stdout, name).toContain(name);
    for (const name of stages.STAGES)
      expect(out.stdout, name).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    const dollars = /projected \$\s+(\d+\.\d+)/.exec(out.stdout);
    expect(Number(dollars?.[1])).toBeGreaterThan(0);
    expect(Number(dollars?.[1])).toBeLessThan(0.05);
    expect(out.stdout).toMatch(/size\s+1000000 ids/);
    expect(out.stdout).toMatch(/at most \d+ range requests an operand/);
  }, 90_000);

  it('leaves the default suite’s projection as it is: its stages, none of the large suite’s', () => {
    const out = harness([]);
    expect(out.status).toBe(0);
    for (const name of stages.STAGES) expect(out.stdout, name).toContain(name);
    for (const name of large.LARGE_STAGES) expect(out.stdout, name).not.toContain(name);
    expect(out.stdout).toMatch(/projected\s+\d+ PUT-class, \d+ GET-class/);
  });
});

describe('the files the harness runs from', () => {
  const sh = src('bench', 'calibrate-cloudshell.sh');
  const modules = [
    'bench/lib/calibrate-large-resources.cjs',
    'bench/lib/calibrate-large-stages.cjs',
    'bench/lib/calibrate-large.cjs',
    'bench/lib/large-counts.cjs',
  ];

  it('are copied by the CloudShell script and named among the files whose edits mark a run dirty', () => {
    const cp = /^cp (bench\/lib\/[^"]+) "\$WORK\/bench\/lib\/"$/m.exec(sh)?.[1] ?? '';
    for (const m of modules) {
      expect(cp, m).toContain(m);
      expect(processLib.HARNESS_FILES, m).toContain(m);
      expect(sh.slice(sh.indexOf('harness_ref() {')), m).toContain(m);
    }
  });

  it('are required by the harness, and only by it and each other', () => {
    for (const m of modules) {
      expect(existsSync(join(ROOT, m)), m).toBe(true);
    }
    expect(harnessSrc).toContain("require('./lib/calibrate-large.cjs')");
    expect(harnessSrc).toContain("require('./lib/calibrate-large-stages.cjs')");
  });

  it('passes the suite to the harness, validates it first, and copies the large evidence out', () => {
    expect(sh).toContain('refuse_bad_suite');
    expect(sh.indexOf('\nrefuse_bad_suite\n')).toBeLessThan(sh.indexOf('nvm install'));
    expect(sh.indexOf('\nrefuse_bad_suite\n')).toBeLessThan(sh.indexOf('npm i '));
    expect(sh).toContain('"$WORK"/bench/calibration/large/*.json');
    expect(sh).toContain('"$WORK/bench/calibrate-aws-rehearsal-large.json"');
    // The suite reaches the harness through the environment the script is run with: nothing in the script unsets it.
    expect(sh).not.toMatch(/^[^#\n]*(unset CR_CALIBRATE_SUITE|CR_CALIBRATE_SUITE=)/m);
    const run = /^run_harness\(\) \{[\s\S]*?^\}/m.exec(sh)?.[0] ?? '';
    expect(run).toContain('exec "$@"');
    const bad = spawnSync('bash', [join(ROOT, 'bench', 'calibrate-cloudshell.sh')], {
      env: { PATH: process.env.PATH ?? '', CR_CALIBRATE_SUITE: 'huge', CR_CALIBRATE_REHEARSE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/CR_CALIBRATE_SUITE must be default or large/);
  });

  it('keep the CloudShell script’s run id check on the suite’s own evidence directory', () => {
    const fn = /^refuse_committed_run_id\(\) \{[\s\S]*?^\}/m.exec(sh)?.[0] ?? '';
    expect(fn).toContain('bench/calibration/large');
    const dir = mkdtempSync(join(tmpdir(), 'calib-run-id-'));
    try {
      mkdirSync(join(dir, 'bench', 'calibration', 'large'), { recursive: true });
      writeFileSync(join(dir, 'bench', 'calibration', 'large', '2026-10-07-a.json'), '{}');
      const run = (env: Record<string, string>) =>
        spawnSync('bash', ['-c', `${fn}\nrefuse_committed_run_id`], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', ...env },
          encoding: 'utf8',
        });
      const large_ = run({ CR_CALIBRATE_SUITE: 'large', CR_CALIBRATE_RUN_ID: '2026-10-07-a' });
      expect(large_.status).toBe(2);
      expect(large_.stderr).toMatch(
        /bench\/calibration\/large\/2026-10-07-a\.json is committed evidence/,
      );
      expect(run({ CR_CALIBRATE_RUN_ID: '2026-10-07-a' }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A rehearsal of every other stage's ceiling check cannot run here (a rehearsal's ceiling is infinite), so each loop of the
// large suite that sends is read: it must check the ceiling after the send it awaits.
describe('the ceiling is checked inside every loop of the large suite that sends', () => {
  const runner = src('bench', 'lib', 'calibrate-large.cjs');
  it.each([
    ['the cold reads', 'coldRead(', 'checkCeiling();'],
    ['the *Into calls', 'const call = await sample(', 'checkCeiling();'],
  ])('%s send, then check', (_name, send, check) => {
    const at = runner.indexOf(send);
    expect(at).toBeGreaterThan(-1);
    expect(runner.indexOf(check, at)).toBeGreaterThan(at);
  });

  it('loads through the harness’s own load helper, which claims each first load and checks the ceiling', () => {
    expect(runner).toMatch(/await load\(\s*operandName\(s\.n, i\)/);
    expect(runner).not.toMatch(/loader\.load\(/);
    expect(harnessSrc.match(/loader\.load\(/g)).toHaveLength(1);
  });
});
