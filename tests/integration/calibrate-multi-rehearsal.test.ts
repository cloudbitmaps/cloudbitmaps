import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

// The multi suite, assembled: `bench/calibrate-aws.cjs --rehearse --suite multi` against the MinIO in docker-compose.yml.
// The unit tests in `tests/bench/calibrate-multi.test.ts` hold the pieces; only a run shows that the harness's own wiring of
// them works: that every stage is held to the requests the engine is expected to make, in both classes, through the S3
// driver, that every read returns exactly the ids the layout holds, that the evidence passes the repo's gate for it, and
// that teardown removes every object and row the suite wrote, so the bucket is gone at the end. A rehearsal touches no cloud
// account, and is spawned with `--rehearse`, never `--run`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const HARNESS = join(ROOT, 'bench', 'calibrate-aws.cjs');
const RESULTS = join(ROOT, 'bench', 'calibrate-aws-rehearsal-multi.json');
const BUILT = ['core', 'roaring', 's3'].map((p) => join(ROOT, 'packages', p, 'dist', 'index.js'));

type Bound = { put: number; get: number };
type Stage = {
  requests: Bound;
  discarded: { requests: Bound }[];
  expectedPuts?: number;
  expectedGets?: number;
  shapes?: { shape: string; runs: number; exact: boolean; offExpected: number }[];
};
type Results = {
  suite?: string;
  runId: string;
  target: string;
  partial: boolean;
  expectedMissed?: string[];
  projectionExceeded?: string[];
  phases: Record<string, Stage>;
};
const multi = require_(join(ROOT, 'bench', 'lib', 'calibrate-multi-stages.cjs')) as {
  MULTI_STAGES: string[];
  MULTI_SHAPES: { name: string }[];
};
const evidence = require_(join(ROOT, 'bench', 'lib', 'multi-evidence.cjs')) as {
  multiRunProblems: (run: unknown, options?: { rehearsal?: boolean }) => string[];
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: readonly string[];
};

const OFFLINE_HOME = mkdtempSync(join(tmpdir(), 'calib-multi-rehearsal-'));
afterAll(() => rmSync(OFFLINE_HOME, { recursive: true, force: true }));

const client = new S3Client({
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});

function spawn(args: string[], extraEnv: Record<string, string>, timeout: number) {
  return spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: OFFLINE_HOME,
      AWS_CONFIG_FILE: join(OFFLINE_HOME, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(OFFLINE_HOME, 'no-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout,
  });
}

function rehearse(extraEnv: Record<string, string> = {}) {
  const runId = `${new Date().toISOString().slice(0, 10)}-it-${randomUUID().slice(0, 8)}`;
  const out = spawn(
    ['--rehearse', '--suite', 'multi'],
    { CR_CALIBRATE_RUN_ID: runId, ...extraEnv },
    540_000,
  );
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

const bucketsNow = async (): Promise<string[]> =>
  ((await client.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name ?? '');

const kept = (s: Stage): Bound => ({
  put: s.requests.put - s.discarded.reduce((n, d) => n + d.requests.put, 0),
  get: s.requests.get - s.discarded.reduce((n, d) => n + d.requests.get, 0),
});

describe('the multi suite, rehearsed against MinIO', () => {
  it('holds every stage to its exact PUT-class and GET-class counts, passes the evidence gate, and tears the bucket down', async () => {
    const { status, stderr, stdout, results, bucket } = rehearse({ CR_CALIBRATE_MULTI_READS: '2' });
    expect(status, stderr).toBe(0);
    expect(stderr).not.toMatch(/EXPECTED COUNT MISSED|PROJECTION EXCEEDED|FAILED|LEFTOVERS/);
    expect(stdout).toMatch(/suite: multi \(named by --suite\)/);
    expect(stdout).toContain(`teardown: removed ${bucket}`);
    expect(results.suite).toBe('multi');
    expect(results.target).toMatch(/minio/);
    expect(results.partial).toBe(false);
    expect(results.expectedMissed).toBeUndefined();
    expect(results.projectionExceeded).toBeUndefined();
    expect(Object.keys(results.phases)).toEqual(multi.MULTI_STAGES);
    for (const name of multi.MULTI_STAGES) {
      const stage = results.phases[name] as Stage;
      expect(stage.expectedPuts, name).toBeDefined();
      expect(stage.expectedGets, name).toBeDefined();
      expect(kept(stage), name).toEqual({ put: stage.expectedPuts, get: stage.expectedGets });
    }
    for (const name of ['multiIntersect', 'multiCount']) {
      const shapes = (results.phases[name] as Stage).shapes ?? [];
      expect(shapes.map((s) => s.shape)).toEqual(multi.MULTI_SHAPES.map((s) => s.name));
      for (const s of shapes) {
        expect(s.runs, `${name} ${s.shape}`).toBe(2);
        expect(s.exact).toBe(true);
        expect(s.offExpected).toBe(0);
      }
    }
    expect(evidence.multiRunProblems(results, { rehearsal: true })).toEqual([]);
    expect(await bucketsNow()).not.toContain(bucket);
  }, 600_000);
});

describe('the multi suite, projected', () => {
  it('projects the multi suite without touching anything: under its $0.02 ceiling, each stage listed', () => {
    const out = spawn(['--suite', 'multi'], {}, 120_000);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/PROJECTION ONLY — nothing created, no credentials read/);
    for (const name of multi.MULTI_STAGES) expect(out.stdout, name).toContain(name);
    for (const name of stages.STAGES)
      expect(out.stdout, name).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    const dollars = /projected \$\s+(\d+\.\d+)/.exec(out.stdout);
    expect(Number(dollars?.[1])).toBeGreaterThan(0);
    expect(Number(dollars?.[1])).toBeLessThan(0.02);
  }, 130_000);
});
