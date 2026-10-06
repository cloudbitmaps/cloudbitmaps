import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

// The large suite, assembled: `bench/calibrate-aws.cjs --rehearse --suite large` against the MinIO in
// docker-compose.yml, with one read of each kind and one `*Into` of each verb a size so it runs in under a minute. The
// unit tests in `tests/bench/calibrate-large.test.ts` hold the pieces; only a run shows that the harness's own wiring of
// them works: that every stage is held to the requests the engine is expected to make, in both classes, through the
// S3 driver, and that the evidence goes where the large suite's evidence goes. A rehearsal touches no cloud account,
// and is spawned with `--rehearse`, never `--run`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const HARNESS = join(ROOT, 'bench', 'calibrate-aws.cjs');
const RESULTS = join(ROOT, 'bench', 'calibrate-aws-rehearsal-large.json');
const BUILT = ['core', 'roaring', 's3'].map((p) => join(ROOT, 'packages', p, 'dist', 'index.js'));

type Bound = { put: number; get: number };
type Stage = {
  requests: Bound;
  discarded: { requests: Bound }[];
  expectedPuts?: number;
  expectedGets?: number;
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
const large = require_(join(ROOT, 'bench', 'lib', 'calibrate-large-stages.cjs')) as {
  LARGE_STAGES: string[];
};

const OFFLINE_HOME = mkdtempSync(join(tmpdir(), 'calib-large-rehearsal-'));
afterAll(() => rmSync(OFFLINE_HOME, { recursive: true, force: true }));

function rehearse(extraEnv: Record<string, string> = {}) {
  const runId = `${new Date().toISOString().slice(0, 10)}-it-${randomUUID().slice(0, 8)}`;
  const out = spawnSync(process.execPath, [HARNESS, '--rehearse', '--suite', 'large'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: OFFLINE_HOME,
      AWS_CONFIG_FILE: join(OFFLINE_HOME, 'no-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(OFFLINE_HOME, 'no-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      CR_CALIBRATE_RUN_ID: runId,
      CR_CALIBRATE_LARGE_READS: '1',
      CR_CALIBRATE_LARGE_INTOS: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 240_000,
  });
  const results = JSON.parse(readFileSync(RESULTS, 'utf8')) as Results;
  expect(results.runId, `the rehearsal wrote no results:\n${out.stderr}`).toBe(runId);
  return { ...out, results };
}

beforeAll(async () => {
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

describe('the large suite, rehearsed against MinIO', () => {
  it('holds every stage to its exact PUT-class and GET-class counts, and writes its evidence to the large rehearsal file', () => {
    const { status, stderr, stdout, results } = rehearse();
    expect(status, stderr).toBe(0);
    expect(stderr).not.toMatch(/EXPECTED COUNT MISSED|PROJECTION EXCEEDED|FAILED/);
    expect(stdout).toMatch(/suite: large \(named by --suite\)/);
    expect(results.suite).toBe('large');
    expect(results.target).toMatch(/minio/);
    expect(results.partial).toBe(false);
    expect(results.expectedMissed).toBeUndefined();
    expect(results.projectionExceeded).toBeUndefined();
    expect(Object.keys(results.phases)).toEqual(large.LARGE_STAGES);
    for (const name of large.LARGE_STAGES) {
      const stage = results.phases[name] as Stage;
      expect(stage.expectedPuts, name).toBeDefined();
      expect(stage.expectedGets, name).toBeDefined();
      expect(kept(stage), name).toEqual({ put: stage.expectedPuts, get: stage.expectedGets });
    }
    expect(results.phases.largeInto?.requests.put).toBeGreaterThan(0);
  }, 300_000);

  // A transient fault in a timed read discards the sample and runs it again, and the stage is still held to what it kept.
  it('discards a sample that meets a transient fault and still holds the stage to what it kept', () => {
    const { status, stderr, results } = rehearse({ CR_CALIBRATE_FAULT_GETS: '22:reset' });
    expect(status, stderr).toBe(0);
    expect(results.discards.count).toBe(1);
    expect(results.expectedMissed).toBeUndefined();
    for (const name of large.LARGE_STAGES) {
      const stage = results.phases[name] as Stage;
      expect(kept(stage), name).toEqual({ put: stage.expectedPuts, get: stage.expectedGets });
    }
  }, 300_000);
});
