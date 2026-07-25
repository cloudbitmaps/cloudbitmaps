import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards on `bench/calibrate-aws.cjs` — the one script in this repo that creates real cloud resources and spends
// real money. Every case here exercises the PURE PROJECTION path: no AWS call is made, no credentials are needed,
// nothing is created. That's what makes these cheap enough to be a normal test rather than a manual ritual.
//
// This file exists because a review found that a non-numeric `CR_CALIBRATE_MAX_USD` silently DELETED the spend
// ceiling (`Number('abc')` is `NaN`, and `total > NaN` is `false`), on a script whose own docs called the ceiling
// "a real bound". A four-line test would have caught it, so now there is one.
//
// The run path itself cannot be tested here — it needs a cloud endpoint. It is rehearsed against LocalStack, and
// the properties that rehearsal proves are recorded with the calibration method.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'bench', 'calibrate-aws.cjs');

/** Run the script with a clean env slice and return `{ status, out }`. Never passes `--run` without an endpoint. */
function run(
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * The refusal paths need no build — the script loads the library lazily, precisely so a bad flag is rejected by
 * a script that hasn't touched `dist`. The *projection* does need it, for the pricing profile. CI runs `pnpm
 * test` BEFORE `pnpm build`, so build once here if `dist` is absent rather than skipping (a guard that quietly
 * skips in CI is the failure mode this repo keeps hitting).
 */
function ensureBuilt(): void {
  if (existsSync(join(ROOT, 'packages', 'roaring', 'dist', 'index.cjs'))) return;
  execFileSync('pnpm', ['-r', '--filter', './packages/**', 'run', 'build'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

describe('calibrate-aws guards (projection path only — no AWS, no cost)', () => {
  beforeAll(() => {
    ensureBuilt();
  }, 300_000);

  it('dry run projects and exits 0 without touching AWS', () => {
    const { status, out } = run([]);
    expect(status).toBe(0);
    expect(out).toContain('DRY RUN');
    expect(out).toMatch(/nothing was created and no AWS call was made/);
    expect(out).toMatch(/projected cost @ aws-us-east-1-ondemand/);
  });

  it('the projection counts S3 PUTs — the op the metrics sink cannot see', () => {
    // Priced at 12.5x a GET, so a projection without them would understate an ingest-heavy run.
    const { out } = run([]);
    expect(out).toMatch(/cold\.put=\d+/);
    expect(out).toMatch(/S3 PUT\/LIST \$/);
  });

  it('--run refuses without an explicit region', () => {
    const { status, out } = run(['--run'], { CR_CALIBRATE_REGION: '' });
    expect(status).toBe(2);
    expect(out).toMatch(/CR_CALIBRATE_REGION is required/);
  });

  it('--run refuses without the typed confirmation', () => {
    const { status, out } = run(['--run'], {
      CR_CALIBRATE_REGION: 'us-east-1',
      CR_CALIBRATE_CONFIRM: '',
    });
    expect(status).toBe(2);
    expect(out).toMatch(/CR_CALIBRATE_CONFIRM=spend-real-money/);
  });

  it('--run refuses a confirmation that is close but wrong', () => {
    const { status } = run(['--run'], {
      CR_CALIBRATE_REGION: 'us-east-1',
      CR_CALIBRATE_CONFIRM: 'yes',
    });
    expect(status).toBe(2);
  });

  it('refuses when the projection exceeds the spend ceiling', () => {
    const { status, out } = run([], { CR_CALIBRATE_MAX_USD: '0.000001' });
    expect(status).toBe(2);
    expect(out).toMatch(/exceeds the \$0\.00 ceiling/);
  });

  // The regression this file was written for.
  it.each(['abc', '1,00', '$1.00', '', 'NaN', '0', '-1'])(
    'rejects a ceiling of %j instead of silently removing it',
    (value) => {
      const { status, out } = run([], { CR_CALIBRATE_MAX_USD: value });
      expect(status).toBe(2);
      expect(out).toMatch(/CR_CALIBRATE_MAX_USD must be a positive number/);
    },
  );

  it('treats a workload size of 0 as zero, not as the default', () => {
    // `measure.cjs`'s `int()` maps 0 to the default, which would hand someone shrinking a run the full 2000.
    const { status, out } = run([], {
      CR_CALIBRATE_SEGMENTS: '0',
      CR_CALIBRATE_WRITES: '0',
      CR_CALIBRATE_READS: '0',
    });
    expect(status).toBe(0);
    expect(out).toMatch(/projection for 0 segments \/ 0 writes \/ 0 reads/);
  });

  it.each(['abc', '-5', '1.5'])('rejects a malformed workload size (%j)', (value) => {
    const { status, out } = run([], { CR_CALIBRATE_WRITES: value });
    expect(status).toBe(2);
    expect(out).toMatch(/must be a non-negative integer/);
  });

  it('--cleanup refuses without a run id', () => {
    const { status, out } = run(['--cleanup'], {
      CR_CALIBRATE_REGION: 'us-east-1',
      CR_CALIBRATE_RUN_ID: '',
    });
    expect(status).toBe(2);
    expect(out).toMatch(/--cleanup needs a run id/);
  });

  // A present-but-EMPTY endpoint used to read as "real AWS", so a rehearsal command line whose
  // `CR_CALIBRATE_ENDPOINT=$LOCALSTACK` failed to expand became a billed run — and for `--cleanup`, a deletion
  // aimed at a real account.
  it('refuses a present-but-empty CR_CALIBRATE_ENDPOINT', () => {
    const { status, out } = run([], { CR_CALIBRATE_ENDPOINT: '' });
    expect(status).toBe(2);
    expect(out).toMatch(/set but EMPTY/);
  });

  it('projects warm ops from the engine OCC retry bound, so the ceiling is a real bound', () => {
    // Two earlier versions were not bounds: ×2 left writes within one request of the projection, and a smaller
    // read multiplier than write meant the read slot breached first (measured 237 vs projected 186). Reads must
    // now be projected at least as high as writes, since each OCC round issues one of each.
    const { out } = run([], {
      CR_CALIBRATE_SEGMENTS: '2',
      CR_CALIBRATE_WRITES: '60',
      CR_CALIBRATE_READS: '2',
    });
    const reads = Number(/warm\.read=(\d+)/.exec(out)?.[1]);
    const writes = Number(/warm\.write=(\d+)/.exec(out)?.[1]);
    expect(writes).toBeGreaterThanOrEqual(60 * 17); // 1 attempt + 16 retries
    expect(reads).toBeGreaterThanOrEqual(writes);
  });

  it('--cleanup refuses without a region', () => {
    const { status, out } = run(['--cleanup', 'some-id'], { CR_CALIBRATE_REGION: '' });
    expect(status).toBe(2);
    expect(out).toMatch(/--cleanup needs CR_CALIBRATE_REGION/);
  });
});
