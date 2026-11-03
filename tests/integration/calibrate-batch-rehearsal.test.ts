import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

// The batch suite, assembled: `bench/calibrate-aws.cjs --rehearse --suite batch` against the MinIO in docker-compose.yml.
// The unit tests in `tests/bench/calibrate-batch.test.ts` hold the pieces; only a run shows that the harness's own wiring
// of them works: that both stages are held to the requests the engine is expected to make, in both classes, through the
// S3 driver, that a sample a transient fault discards runs again on destinations of its own, and that teardown removes
// every object and row the suite wrote, so the bucket is gone at the end. A rehearsal touches no cloud account, and is
// spawned with `--rehearse`, never `--run`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const HARNESS = join(ROOT, 'bench', 'calibrate-aws.cjs');
const RESULTS = join(ROOT, 'bench', 'calibrate-aws-rehearsal-batch.json');
const BUILT = ['core', 'roaring', 's3'].map((p) => join(ROOT, 'packages', p, 'dist', 'index.js'));

type Bound = { put: number; get: number };
type Stage = {
  requests: Bound;
  discarded: { requests: Bound }[];
  expectedPuts?: number;
  expectedGets?: number;
  runs?: number;
  perSample?: {
    put: number;
    get: number;
    expectedPut: number;
    expectedGet: number;
    groups: number;
  }[];
};
type Results = {
  suite?: string;
  runId: string;
  target: string;
  partial: boolean;
  expectedMissed?: string[];
  projectionExceeded?: string[];
  discards: { count: number };
  phases: Record<string, Stage>;
};
const batch = require_(join(ROOT, 'bench', 'lib', 'calibrate-batch-stages.cjs')) as {
  BATCH_STAGES: string[];
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: readonly string[];
};
const largeStages = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
  LARGE_STAGES: string[];
};

const OFFLINE_HOME = mkdtempSync(join(tmpdir(), 'calib-batch-rehearsal-'));
afterAll(() => rmSync(OFFLINE_HOME, { recursive: true, force: true }));

const client = new S3Client({
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});

function rehearse(extraEnv: Record<string, string> = {}) {
  const runId = `${new Date().toISOString().slice(0, 10)}-it-${randomUUID().slice(0, 8)}`;
  const out = spawnSync(process.execPath, [HARNESS, '--rehearse', '--suite', 'batch'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: OFFLINE_HOME,
      AWS_CONFIG_FILE: join(OFFLINE_HOME, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(OFFLINE_HOME, 'no-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      CR_CALIBRATE_RUN_ID: runId,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 540_000,
  });
  const results = JSON.parse(readFileSync(RESULTS, 'utf8')) as Results;
  expect(results.runId, `the rehearsal wrote no results:\n${out.stderr}`).toBe(runId);
  return { ...out, results, bucket: `cloudbitmaps-calib-${runId}` };
}

beforeAll(async () => {
  for (const file of BUILT) {
    if (!existsSync(file)) {
      throw new Error(
        `${file} is missing: the harness imports the built packages, so run \`pnpm build\` first`,
      );
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListBucketsCommand({}));
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}, 60_000);

const kept = (s: Stage): Bound => ({
  put: s.requests.put - s.discarded.reduce((n, d) => n + d.requests.put, 0),
  get: s.requests.get - s.discarded.reduce((n, d) => n + d.requests.get, 0),
});

const bucketsNow = async (): Promise<string[]> =>
  ((await client.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name ?? '');

function expectExact(results: Results) {
  expect(results.suite).toBe('batch');
  expect(results.target).toMatch(/minio/);
  expect(results.partial).toBe(false);
  expect(results.expectedMissed).toBeUndefined();
  expect(results.projectionExceeded).toBeUndefined();
  expect(Object.keys(results.phases)).toEqual(batch.BATCH_STAGES);
  for (const name of batch.BATCH_STAGES) {
    const stage = results.phases[name] as Stage;
    expect(stage.expectedPuts, name).toBeDefined();
    expect(stage.expectedGets, name).toBeDefined();
    expect(kept(stage), name).toEqual({ put: stage.expectedPuts, get: stage.expectedGets });
  }
}

describe('the batch suite, rehearsed against MinIO', () => {
  // The suite as a run makes it: the refresh shape, a thousand outputs, one sample so it runs in a few minutes.
  it('holds both stages to their exact PUT-class and GET-class counts at the refresh shape, and tears every destination down', async () => {
    const { status, stderr, stdout, results, bucket } = rehearse({
      CR_CALIBRATE_BATCH_SAMPLES: '1',
    });
    expect(status, stderr).toBe(0);
    expect(stderr).not.toMatch(/EXPECTED COUNT MISSED|PROJECTION EXCEEDED|FAILED|LEFTOVERS/);
    expect(stdout).toMatch(/suite: batch \(named by --suite\)/);
    expect(stdout).toContain(`teardown: removed ${bucket}`);
    expectExact(results);
    const run = results.phases.batch as Stage;
    expect(run.runs).toBe(1);
    expect(run.perSample?.[0]?.groups).toBeGreaterThanOrEqual(1);
    expect(run.requests.put).toBeGreaterThan(1_000);
    // The bucket ends empty: it is gone, with every destination and row the call wrote.
    expect(await bucketsNow()).not.toContain(bucket);
  }, 600_000);

  it('runs a sample again on destinations of its own after a transient fault, and still holds the stage to what it kept', async () => {
    // The fault is a GetObject inside the batch call: the loads' and the fixed requests' GetObjects come first.
    const clean = rehearse({ CR_CALIBRATE_BATCH_SHAPE: 'small', CR_CALIBRATE_BATCH_SAMPLES: '1' });
    expect(clean.status, clean.stderr).toBe(0);
    const cost = (
      JSON.parse(readFileSync(RESULTS, 'utf8')) as {
        cost: { ops: { byCommand: Record<string, number> } };
      }
    ).cost;
    const getObjects = cost.ops.byCommand.GetObjectCommand ?? 0;
    const batchGets = (clean.results.phases.batch as Stage).requests.get;
    const before = getObjects - batchGets;
    expect(before).toBeGreaterThan(0);
    const { status, stderr, results, bucket } = rehearse({
      CR_CALIBRATE_BATCH_SHAPE: 'small',
      CR_CALIBRATE_BATCH_SAMPLES: '1',
      CR_CALIBRATE_FAULT_GETS: `${before + 10}:reset`,
    });
    expect(status, stderr).toBe(0);
    expect(results.discards.count).toBe(1);
    expectExact(results);
    expect((results.phases.batch as Stage).discarded).toHaveLength(1);
    expect(await bucketsNow()).not.toContain(bucket);
  }, 600_000);
});

// A projection prices the plan and creates nothing, but it imports the built library to count the shape and to read the
// pricing profile, so it is held here, where the packages are built.
function project(args: string[]) {
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: OFFLINE_HOME,
      AWS_CONFIG_FILE: join(OFFLINE_HOME, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(OFFLINE_HOME, 'no-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    encoding: 'utf8',
    timeout: 90_000,
  });
}

describe('the batch suite, projected', () => {
  it('projects the batch suite without touching anything: its bound under the ceiling, each stage listed', () => {
    const out = project(['--suite', 'batch']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/PROJECTION ONLY — nothing created, no credentials read/);
    for (const name of batch.BATCH_STAGES) expect(out.stdout, name).toContain(name);
    for (const name of [...stages.STAGES, ...largeStages.LARGE_STAGES])
      expect(out.stdout, name).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    const dollars = /projected \$\s+(\d+\.\d+)/.exec(out.stdout);
    expect(Number(dollars?.[1])).toBeGreaterThan(0);
    expect(Number(dollars?.[1])).toBeLessThan(0.1);
    expect(out.stdout).toMatch(/shape\s+refresh: 100 operands of 200000 ids, 1000 outputs/);
  }, 90_000);

  it('leaves the default and large suites’ projections as they are', () => {
    const plain = project([]);
    expect(plain.status).toBe(0);
    for (const name of batch.BATCH_STAGES)
      expect(plain.stdout, name).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    const large = project(['--suite', 'large']);
    expect(large.status).toBe(0);
    for (const name of batch.BATCH_STAGES)
      expect(large.stdout, name).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
  }, 120_000);
});
