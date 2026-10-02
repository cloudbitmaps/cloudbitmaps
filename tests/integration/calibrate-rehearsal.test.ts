import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

// The calibration harness, assembled: `bench/calibrate-aws.cjs --rehearse` against the MinIO in docker-compose.yml, on
// a workload small enough to run in seconds, with faults injected on purpose (`CR_CALIBRATE_FAULT_GETS`). The unit
// tests in `tests/bench/` hold the pieces — the ledger, the classifier, the projection, the figures — and read the
// harness's source; only a run of the harness shows that its own wiring of them works: that a transient fault in a
// timed sample is discarded and run again, that a stage is held to what it kept, that a kept sample's latency leaves
// the failed attempt and the wait for its requests out, that a fault that is not transient, or one in a load, fails the
// run, and that the run's error says what failed.
//
// A rehearsal touches no cloud account: the harness points it at 127.0.0.1:9000 with MinIO's own credentials, and its
// money guards do not run. It is spawned with `--rehearse` alone, never `--run`, where no AWS credential can be found.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const HARNESS = join(ROOT, 'bench', 'calibrate-aws.cjs');
/** Where a rehearsal writes its results; git ignores it. Each run below is told apart by its run id. */
const RESULTS = join(ROOT, 'bench', 'calibrate-aws-rehearsal.json');
/** The harness imports the built packages, so this lane needs a build; CI runs `pnpm build` before it. */
const BUILT = ['core', 'roaring', 's3'].map((p) => join(ROOT, 'packages', p, 'dist', 'index.js'));

type Reads = Record<'whole' | 'suffix' | 'range', { n: number; bytes: number }>;
type Requests = { put: number; get: number; reads: Reads };
type Fault = {
  name: string;
  cause: string | null;
  code: string | null;
  attempts: number | null;
  httpStatus: number | null;
  message: string;
};
type Discard = Fault & { of: string; sample: number; failedAfterMs: number; requests: Requests };
type Stage = {
  requests: Requests;
  discarded: Discard[];
  expectedGets?: number;
  p99ms?: number;
  has?: { firstRead: { p99ms: number } };
};
type Results = {
  runId: string;
  mode: string;
  target: string;
  partial: boolean;
  error?: Fault;
  expectedMissed?: string[];
  projectionExceeded?: string[];
  injectedFaults?: Array<{ getObject: number; as: string }>;
  discards: {
    count: number;
    perRun: number;
    perStage: number;
    unfinished?: { stage: string; discarded: Discard[] };
  };
  phases: Record<string, Stage>;
};

const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  planLayout: (i: { segments: number; idsPerSegment: number; overlap: number; stride: number }) => {
    sharedChunks: number;
    chunksPerSegment: number;
  };
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
  FIRST_LOAD: { put: number; get: number };
  coldIntersectGets: (k: number) => number;
};
const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  QUIET_MS: number;
  keptRequests: (record: { requests: Requests; discarded?: Discard[] }) => Requests;
};
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  readSources: (root: string) => unknown;
  derive: (
    run: unknown,
    src: unknown,
  ) => { discards: { count: number }; anchors: Array<[string, string]> };
};

/**
 * The workload: four calibration segments of 150,000 ids, which spread over 600 chunks with 30 shared, so each object
 * is larger than the 256 KiB tail read, as the full workload's are; one multipart segment; four cold intersects; point
 * reads on two segments; two `andNot` calls against two others; no spread stage and no sweep.
 */
const W = { segments: 4, ids: 150_000, large: 1, reads: 4, point: 2, andNot: 2, excludes: 2 };
const WORKLOAD = {
  CR_CALIBRATE_SEGMENTS: String(W.segments),
  CR_CALIBRATE_IDS: String(W.ids),
  CR_CALIBRATE_LARGE: String(W.large),
  CR_CALIBRATE_READS: String(W.reads),
  CR_CALIBRATE_SPREAD_SEGMENTS: '0',
  CR_CALIBRATE_SPREAD_READS: '0',
  CR_CALIBRATE_SWEEP: 'none',
  CR_CALIBRATE_POINT_SEGMENTS: String(W.point),
  CR_CALIBRATE_ANDNOT_CALLS: String(W.andNot),
  CR_CALIBRATE_ANDNOT_EXCLUDES: String(W.excludes),
};
const layout = guards.planLayout({
  segments: W.segments,
  idsPerSegment: W.ids,
  ...guards.DEFAULT_LAYOUT,
});
const k = layout.sharedChunks;

/**
 * Which GetObject request, counted from 1 on the workload's client as the fault hook counts them, falls where. Every
 * GET-class request the workload makes is a GetObject: a first load reads its pointer seven times; a cold intersect
 * makes 4 + 2k; the priming pass reads each segment once, a pointer, a tail and its shared chunks; a first `count()` is
 * a pointer and a tail, a `has()` on an open segment a chunk, and a first `has()` a pointer, a tail and a chunk.
 */
const AT = (() => {
  const loads = (W.segments + W.large) * stages.FIRST_LOAD.get;
  const cold = stages.coldIntersectGets(k);
  // The last request of the first cold intersect: the discard made every request a finished intersect makes, more
  // than the stage's bound leaves above its expected count, so a stage held to its total would overspend.
  const intersect = loads + cold;
  // With that sample discarded and run again, the intersects are five samples' worth.
  const warm = loads + 5 * cold;
  const pointReads = warm + W.segments * (2 + k);
  // The tail read of the first first-read `has()`, after the cold `count()`s and the open-segment `has()`s.
  const firstRead = pointReads + 2 * W.point + W.point * k + 2;
  // With that discarded (a pointer and a tail) and run again, then the rest: part-way into the first `andNot` call.
  const andNot = firstRead + 3 * W.point * k + 300;
  return { loads, intersect, firstRead, andNot };
})();

const OFFLINE_HOME = mkdtempSync(join(tmpdir(), 'calib-rehearsal-'));
afterAll(() => rmSync(OFFLINE_HOME, { recursive: true, force: true }));

/** A rehearsal of the workload with `faults` injected, and the results file it wrote. */
function rehearse(faults: string): { status: number | null; stderr: string; results: Results } {
  const runId = `${new Date().toISOString().slice(0, 10)}-it-${randomUUID().slice(0, 8)}`;
  const out = spawnSync(process.execPath, [HARNESS, '--rehearse'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: OFFLINE_HOME,
      AWS_CONFIG_FILE: join(OFFLINE_HOME, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(OFFLINE_HOME, 'no-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      CR_CALIBRATE_RUN_ID: runId,
      CR_CALIBRATE_FAULT_GETS: faults,
      ...WORKLOAD,
    },
    encoding: 'utf8',
    timeout: 150_000,
  });
  const results = JSON.parse(readFileSync(RESULTS, 'utf8')) as Results;
  // A file another run wrote would test nothing.
  expect(results.runId, `the rehearsal wrote no results:\n${out.stderr}`).toBe(runId);
  return { status: out.status, stderr: out.stderr, results };
}

beforeAll(async () => {
  // Fail, not skip: a lane that cannot run the harness must not pass as if it had.
  for (const file of BUILT) {
    if (!existsSync(file)) {
      throw new Error(
        `${file} is missing: the harness imports the built packages, so run \`pnpm build\` first`,
      );
    }
  }
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
  });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new ListBucketsCommand({}));
        break;
      } catch (err) {
        if (attempt >= 30) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    client.destroy();
  }
});

describe('a calibration rehearsal that meets transient faults', () => {
  const faults = `${AT.intersect},${AT.firstRead},${AT.andNot}`;
  let run: ReturnType<typeof rehearse>;
  beforeAll(() => {
    run = rehearse(faults);
  }, 180_000);

  it('discards each faulted sample, runs it again, and finishes', () => {
    expect(run.status, run.stderr).toBe(0);
    expect(run.results.partial).toBe(false);
    expect(run.results.error).toBeUndefined();
    expect(run.stderr.match(/^calibrate: DISCARDED — /gm)).toHaveLength(3);
    expect(run.results.injectedFaults).toEqual([
      { getObject: AT.intersect, as: 'reset' },
      { getObject: AT.firstRead, as: 'reset' },
      { getObject: AT.andNot, as: 'reset' },
    ]);
    expect(run.results.discards).toEqual({ count: 3, perRun: 3, perStage: 2 });
  });

  it('records each discard beside its stage: the sample, the fault and the code beneath it, and its requests', () => {
    const fault = {
      name: 'TransientError',
      cause: 'TimeoutError',
      code: 'ECONNRESET',
      attempts: 1,
    };
    const { phases } = run.results;
    expect(phases.intersect?.discarded).toEqual([
      expect.objectContaining({ of: 'calibration-layout cold intersect', sample: 0, ...fault }),
    ]);
    expect(phases.pointReads?.discarded).toEqual([
      expect.objectContaining({ of: 'has() first read', sample: 0, ...fault }),
    ]);
    expect(phases.andNot?.discarded).toEqual([
      expect.objectContaining({ of: 'andNot call', sample: 0, ...fault }),
    ]);
    // The intersect failed at its last request, so it had made all of them; the first read at its tail, after its pointer.
    expect(phases.intersect?.discarded[0]?.requests.get).toBe(stages.coldIntersectGets(k));
    expect(phases.pointReads?.discarded[0]?.requests.get).toBe(2);
    expect(phases.andNot?.discarded[0]?.requests.get).toBeGreaterThanOrEqual(300);
    for (const name of ['intersect', 'pointReads', 'andNot']) {
      expect(phases[name]?.discarded[0]?.failedAfterMs, name).toBeGreaterThan(0);
    }
  });

  it('holds every stage to what its kept samples made, and stays inside every bound', () => {
    expect(run.results.expectedMissed).toBeUndefined();
    expect(run.results.projectionExceeded).toBeUndefined();
    for (const name of stages.STAGES) {
      const stage = run.results.phases[name];
      expect(stage, name).toBeDefined();
      if (stage === undefined) continue;
      expect(samples.keptRequests(stage).get, name).toBe(stage.expectedGets);
      const discarded = stage.discarded.reduce((n, d) => n + d.requests.get, 0);
      expect(stage.requests.get, name).toBe((stage.expectedGets ?? 0) + discarded);
    }
  });

  // A kept sample's clock starts in the attempt that finished. A clock started before it would time the failed attempt
  // and the wait for its requests, which is at least QUIET_MS, into the sample run again: so that sample, and so the
  // stage's slowest, would take longer than both together. A sample of this workload takes far less than the wait.
  it("leaves the failed attempt and the wait for its requests out of the kept sample's latency", () => {
    const { phases } = run.results;
    const slowest: Array<[string, number | undefined]> = [
      ['intersect', phases.intersect?.p99ms],
      ['pointReads', phases.pointReads?.has?.firstRead.p99ms],
      ['andNot', phases.andNot?.p99ms],
    ];
    for (const [name, ms] of slowest) {
      const failed = phases[name]?.discarded[0]?.failedAfterMs ?? 0;
      expect(ms, name).toBeLessThan(failed + samples.QUIET_MS);
    }
  });

  it('writes a file the figures accept as evidence, once it is dressed as a real run, stating its discards', () => {
    const f = figures.derive(
      { ...structuredClone(run.results), mode: 'run', target: 'aws' },
      figures.readSources(ROOT),
    );
    expect(f.discards.count).toBe(3);
    expect(f.anchors).toContainEqual([
      'samples discarded after a transient fault',
      '3 discarded samples',
    ]);
  });
});

describe('a calibration rehearsal that meets a fault it must not discard', () => {
  it('fails the run on a fault that is not transient, discarding nothing, and records the error by name and status', () => {
    const { status, stderr, results } = rehearse(`${AT.loads + 10}:denied`);
    expect(status, stderr).toBe(1);
    expect(stderr).not.toMatch(/DISCARDED/);
    expect(results.partial).toBe(true);
    expect(results.discards).toEqual({
      count: 0,
      perRun: 3,
      perStage: 2,
      unfinished: { stage: 'intersect', discarded: [] },
    });
    expect(results.error).toEqual({
      name: 'AccessDenied',
      cause: null,
      code: null,
      attempts: 1,
      httpStatus: 403,
      message: 'Access Denied (injected by the rehearsal)',
    });
    expect(Object.keys(results.phases)).toEqual(['load']);
  }, 180_000);

  it('fails the run on a transient fault in a load, which is never run again, and records the code beneath it', () => {
    const { status, stderr, results } = rehearse('3');
    expect(status, stderr).toBe(1);
    expect(stderr).not.toMatch(/DISCARDED/);
    expect(results.discards).toMatchObject({
      count: 0,
      unfinished: { stage: 'load', discarded: [] },
    });
    expect(results.error).toEqual({
      name: 'TransientError',
      cause: 'TimeoutError',
      code: 'ECONNRESET',
      attempts: 1,
      httpStatus: null,
      message: 'transient S3 fault: TimeoutError',
    });
    expect(results.phases).toEqual({});
  }, 180_000);
});
