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
// A known limit: a harness that put a failed attempt's own time, without the wait, into the kept sample's latency is
// not caught here. That time is about one sample's, inside the spread of the samples themselves, and the results file
// records each stage's quantiles, not each sample's latency, so no line drawn from it separates the two without failing
// honest runs. (A fault that held the failed attempt open far longer than a sample, a delayed reset, would separate
// them; the fault hook has none.) A clock started outside the attempt is caught, because it also carries the wait, at
// least QUIET_MS; and the source test in `tests/bench/calibrate-samples.test.ts` holds every sample's clock inside its
// attempt.
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
  measured: { maxSockets: number | null; maxSocketsSource: string };
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
  layoutIds: (layout: unknown, i: number) => Iterable<number>;
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
  FIRST_LOAD: { put: number; get: number };
  coldIntersectGets: (k: number) => number;
  STEADY_KEEP: number;
  STEADY_LOADS: number;
  STEADY_LOAD_REQUESTS: Record<string, { put: number; get: number; free: number }>;
  steadyKind: (generation: number) => string;
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
 * The workload: four calibration segments of 125,000 ids, which spread over 500 chunks with 25 shared, so each object
 * is still larger than the 256 KiB tail read, as the full workload's are; one multipart segment; four cold intersects;
 * point reads on two segments; two `andNot` calls, each against one other segment; no spread stage and no sweep. An
 * `andNot` call reads every chunk of its include operand, so it is the slowest sample here, and the smallest segment
 * that keeps the tail read whole is what keeps it short.
 */
const W = { segments: 4, ids: 125_000, large: 1, reads: 4, point: 2, andNot: 2, excludes: 1 };
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
 * The range requests the engine makes of the workload's layout, counted by running it over the in-memory backend, as
 * the harness counts them before it loads anything: a cold intersect's of each operand, and one `andNot` call's in all.
 * The tiny chunks of this workload lie within the gap of each other, so a range holds many of them.
 */
const counts = require_(join(ROOT, 'bench', 'lib', 'range-counts.cjs')) as {
  coldIntersectIds: (a: number[], b: number[]) => Promise<{ rangesPerOperand: number }>;
  coldAndNotIds: (a: number[], b: number[][]) => Promise<{ getRange: number }>;
};
const idsOfSegment = (i: number): number[] => [...guards.layoutIds(layout, i)];
const RANGES = (await counts.coldIntersectIds(idsOfSegment(0), idsOfSegment(1))).rangesPerOperand;
const ANDNOT_RANGES = (
  await counts.coldAndNotIds(
    idsOfSegment(0),
    Array.from({ length: W.excludes }, (_, i) => idsOfSegment(i + 1)),
  )
).getRange;

/**
 * Which GetObject request, counted from 1 on the workload's client as the fault hook counts them, falls where. Every
 * GET-class request the workload makes is a GetObject except a load's check of its generation number, a HeadObject,
 * which the hook does not count: a first load reads its pointer three times; a cold intersect makes 4 + 2k; the priming
 * pass reads each segment once, a pointer, a tail and its shared chunks; a first `count()` is a pointer and a tail, a
 * `has()` on an open segment a chunk, and a first `has()` a pointer, a tail and a chunk.
 */
const LOADS = (W.segments + W.large) * (stages.FIRST_LOAD.get - 1);
const COLD = stages.coldIntersectGets(RANGES);
const PRIMING = W.segments * (2 + RANGES);
/** One `andNot` call: a pointer and a tail per operand, every chunk of the include, the exclude's shared chunks. */
const ANDNOT_CALL = 2 * (1 + W.excludes) + ANDNOT_RANGES;
const AT = (() => {
  // The last request of the first cold intersect: the discard made every request a finished intersect makes, more
  // than the stage's bound leaves above its expected count, so a stage held to its total would overspend.
  const intersect = LOADS + COLD;
  // With that sample discarded and run again, the intersects are five samples' worth.
  const pointReads = LOADS + 5 * COLD + PRIMING;
  // The tail read of the first first-read `has()`, after the cold `count()`s and the open-segment `has()`s.
  const firstRead = pointReads + 2 * W.point + W.point * k + 2;
  // With that discarded (a pointer and a tail) and run again, then the rest: nine tenths into the first `andNot` call,
  // so the failed attempt ran about as long as a finished call, which the latency test's line is drawn from.
  const andNot = firstRead + 3 * W.point * k + Math.floor(0.9 * ANDNOT_CALL);
  return { intersect, firstRead, andNot };
})();
/**
 * The other three kinds of sample, in a second run: the priming pass's last request, a first `count()`'s tail read,
 * and the first `has()` on an open segment. The first two re-run on their store, not on a fresh one, and the console
 * says where each runs again.
 */
const AT_ON_ITS_STORE = (() => {
  const priming = LOADS + W.reads * COLD + PRIMING;
  // The priming pass discarded whole at its last request, then run again: then the first `count()`, one pointer read.
  const count = priming + PRIMING + 1;
  // That discarded (its pointer read) and run again, the other segments' `count()`, the tail read that opens each
  // segment, then the first chunk read of the open phase: the first open `has()`.
  const openHas = count + 1 + (W.point - 1) + W.point + 1;
  return { priming, count, openHas };
})();

const OFFLINE_HOME = mkdtempSync(join(tmpdir(), 'calib-rehearsal-'));
afterAll(() => rmSync(OFFLINE_HOME, { recursive: true, force: true }));

/** A rehearsal of the workload with `faults` injected, and the results file it wrote. */
function rehearse(
  faults: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; results: Results } {
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
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 150_000,
  });
  const results = JSON.parse(readFileSync(RESULTS, 'utf8')) as Results;
  // A file another run wrote would test nothing.
  expect(results.runId, `the rehearsal wrote no results:\n${out.stderr}`).toBe(runId);
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, results };
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

  it("records the socket limit the workload's client held, read back: the library's 128", () => {
    expect(run.results.measured.maxSockets).toBe(128);
    expect(run.results.measured.maxSocketsSource).toMatch(/library's own client.*read back/);
    // The log line prints the limit read back from the agents, before anything is created.
    expect(run.stdout).toMatch(
      /^calibrate: workload client: 128 sockets \(read back from its agents\)$/m,
    );
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
    expect(phases.intersect?.discarded[0]?.requests.get).toBe(COLD);
    expect(phases.pointReads?.discarded[0]?.requests.get).toBe(2);
    expect(phases.andNot?.discarded[0]?.requests.get).toBeGreaterThanOrEqual(
      Math.floor(0.9 * ANDNOT_CALL),
    );
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

  // One segment loaded 18 times at keep 12, over MinIO's S3 request shape: each load makes the requests of its kind, so
  // a harness that loaded at another keep, or an engine that does not collect by name, fills `expectedMissed` above.
  it('runs the steady stage: 18 loads in the kinds their generations make, each with the counted requests', () => {
    const steady = run.results.phases.steadyLoad as unknown as {
      keep: number;
      perLoad: Array<{
        generation: number;
        kind: string;
        put: number;
        get: number;
        free: number;
        commands: Record<string, number>;
      }>;
    };
    expect(steady.keep).toBe(stages.STEADY_KEEP);
    expect(steady.perLoad).toHaveLength(stages.STEADY_LOADS);
    for (const l of steady.perLoad) {
      expect(l.kind, `generation ${l.generation}`).toBe(stages.steadyKind(l.generation));
      expect({ put: l.put, get: l.get, free: l.free }, `generation ${l.generation}`).toEqual(
        stages.STEADY_LOAD_REQUESTS[l.kind],
      );
    }
    // By class: a by-name load deletes one object and lists nothing, and the one listing load lists once.
    expect(steady.perLoad.filter((l) => l.kind === 'listing')).toHaveLength(1);
    expect(
      steady.perLoad.map((l) => l.commands.DeleteObjectCommand ?? 0).reduce((a, b) => a + b),
    ).toBe(5);
    expect(
      steady.perLoad.map((l) => l.commands.ListObjectsV2Command ?? 0).reduce((a, b) => a + b),
    ).toBe(1);
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

describe('a calibration rehearsal that meets transient faults in the samples that run again on their own store', () => {
  let run: ReturnType<typeof rehearse>;
  beforeAll(() => {
    run = rehearse(
      `${AT_ON_ITS_STORE.priming},${AT_ON_ITS_STORE.count},${AT_ON_ITS_STORE.openHas}`,
    );
  }, 180_000);

  it('discards each, says where it runs again, and keeps every stage exact', () => {
    expect(run.status, run.stderr).toBe(0);
    expect(run.results.discards).toEqual({ count: 3, perRun: 3, perStage: 2 });
    const lines = run.stderr.match(/^calibrate: DISCARDED — .*$/gm) ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^calibrate: DISCARDED — warm: priming pass 0, .* running it again on a fresh store \(/,
    );
    expect(lines[1]).toMatch(
      /^calibrate: DISCARDED — pointReads: count\(\) first read 0, .* running it again on its store, once the store has forgotten the segment \(/,
    );
    expect(lines[2]).toMatch(
      /^calibrate: DISCARDED — pointReads: has\(\) on an open segment 0, .* running it again on the same store, which still holds the segment open \(/,
    );
    const { phases } = run.results;
    expect(phases.warm?.discarded.map((d) => [d.of, d.requests.get])).toEqual([
      ['priming pass', PRIMING],
    ]);
    expect(phases.pointReads?.discarded.map((d) => [d.of, d.requests.get])).toEqual([
      ['count() first read', 1],
      ['has() on an open segment', 1],
    ]);
    expect(run.results.expectedMissed).toBeUndefined();
    expect(run.results.projectionExceeded).toBeUndefined();
    for (const name of stages.STAGES) {
      const stage = run.results.phases[name];
      if (stage !== undefined)
        expect(samples.keptRequests(stage).get, name).toBe(stage.expectedGets);
    }
  });
});

describe('a calibration rehearsal given a socket limit', () => {
  it('runs with it, and records the value read back from the client, not the one asked for', () => {
    const { status, stdout, stderr, results } = rehearse(`${AT.intersect}`, {
      CR_CALIBRATE_MAX_SOCKETS: '7',
    });
    expect(status, stderr).toBe(0);
    expect(stdout).toMatch(
      /^calibrate: workload client: 7 sockets \(read back from its agents\)$/m,
    );
    expect(results.measured.maxSockets).toBe(7);
    expect(results.measured.maxSocketsSource).toMatch(/CR_CALIBRATE_MAX_SOCKETS.*read back/);
  }, 180_000);
});

describe('a calibration rehearsal that meets a fault it must not discard', () => {
  it('fails the run on a fault that is not transient, discarding nothing, and records the error by name and status', () => {
    const { status, stderr, results } = rehearse(`${LOADS + 10}:denied`);
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
    // GET 2 of the run is the load's read of its row before it writes its object: nothing in the load settles it.
    const { status, stderr, results } = rehearse('2');
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

  it("fails the run on a transient fault in the next load's first read: a first load's row write makes no read of its own to absorb one", () => {
    // GET 2 of the run is the first load's second read of its row, and a first load's create is sent without reading
    // the row, so GET 3 is the next load's read of its row before it writes its object. Nothing in a load settles a
    // fault on either, so the run fails and no sample passes as clean.
    const { status, stderr, results } = rehearse('3');
    expect(status, stderr).toBe(1);
    expect(stderr).not.toMatch(/DISCARDED/);
    expect(results.error).toMatchObject({ name: 'TransientError', cause: 'TimeoutError' });
    expect(results.expectedMissed).toBeUndefined();
  }, 180_000);
});
