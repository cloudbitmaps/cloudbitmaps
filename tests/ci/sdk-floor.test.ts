import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Holds the SDK-floor job in place, and fires the script's checks at planted inputs.
//
// The workflow half: a nightly job that runs each storage driver at the lowest cloud SDK its range allows, and a
// negative control that must see the S3 driver fail one release below its floor. Neither can be seen to be missing
// or loosened: every other check passes without them, since none runs a version other than the lockfile's. A
// control that stops requiring the failure turns the job into one that cannot tell "the old SDK works" from "the job
// cannot see a dropped If-Match", and a cache saved from a job that installs third-party packages fresh could be
// restored by a job that holds a secret.
//
// The script half: what needs no network and no Docker. Reading the lowest version out of a range, refusing a range
// it cannot read, refusing to run inside the checkout, the check that the installed SDK is the version asked for
// (a pin that did not take would run the newest SDK and report green), and the verdict of the negative control.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/sdk-floor.cjs');
const sdkFloor = createRequire(import.meta.url)(SCRIPT) as {
  DRIVERS: Record<string, { dir: string; sdk: string; unit: string; integration: string }>;
  lowestVersion: (range: string) => string;
  floorOf: (root: string, driver: string) => string;
  assertOutside: (root: string, dir: string) => void;
  checkInstalled: (
    copy: string,
    driver: string,
    version: string,
  ) => { at: string; version: string }[];
  classifyFailure: (report: unknown, text: string) => { ok: boolean; reason: string };
  pinSdk: (copy: string, sdk: string, version: string) => void;
};

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean | string;
}
interface Job {
  env?: Record<string, unknown>;
  permissions?: unknown;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean | string;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: { include?: { driver: string; service: string }[] };
  };
  steps: Step[];
}
interface Workflow {
  on: {
    schedule?: { cron: string }[];
    workflow_dispatch?: unknown;
    pull_request?: { paths?: string[] };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const TEXT = readFileSync(join(ROOT, '.github/workflows/sdk-floor.yml'), 'utf8');
const wf = parse(TEXT) as Workflow;
const job = (name: string): Job => {
  const found = wf.jobs[name];
  if (!found) throw new Error(`no "${name}" job`);
  return found;
};
const floor = job('floor');
const control = job('negative-control');
const stepRunning = (j: Job, needle: string): Step | undefined =>
  j.steps.find((s) => (s.run ?? '').includes(needle));

describe('the SDK-floor workflow', () => {
  it('runs nightly at 03:00 UTC, on demand, and on a pull request that touches a driver, the script or itself', () => {
    expect(wf.on.schedule).toEqual([{ cron: '0 3 * * *' }]);
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(wf.on.pull_request?.paths?.slice().sort()).toEqual(
      [
        '.github/workflows/sdk-floor.yml',
        'packages/azure-blob/**',
        'packages/core/src/drivers/**',
        'packages/gcs/**',
        'packages/s3/**',
        'pnpm-lock.yaml',
        'scripts/sdk-floor.cjs',
      ].sort(),
    );
  });

  it('grants a read-only token and holds no secret, environment or container', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [name, j] of Object.entries(wf.jobs)) {
      expect(j.permissions, `${name} sets its own permissions`).toBeUndefined();
      expect(j.env, `${name} sets an environment`).toBeUndefined();
      expect(JSON.stringify(j), `${name} names a secret`).not.toMatch(
        /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|id-token|environment|container|services/,
      );
      expect(j['continue-on-error'], `${name} may fail without failing`).toBeUndefined();
      expect(j['timeout-minutes'], `${name} has no time bound`).toBeGreaterThan(0);
    }
  });

  it('keeps no cache: setup-node has none, nothing is saved, and the images are only restored', () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        const what = `${name}: ${step.name ?? step.uses ?? step.run ?? ''}`;
        expect(step.with?.['cache'], `${what} sets a cache`).toBeUndefined();
        expect(step.with?.['cache-dependency-path'], `${what} sets a cache path`).toBeUndefined();
        expect(step.uses ?? '', `${what} saves a cache`).not.toMatch(
          /(^|\/)cache\/save@|docker-images-save/,
        );
        if ((step.uses ?? '').startsWith('actions/setup-node@')) {
          // setup-node turns its cache on by itself when `packageManager` names npm; keep it off whatever that says.
          expect(step.with?.['package-manager-cache'], `${what} may cache`).toBe(false);
        }
      }
      expect(
        j.steps.filter((s) => (s.uses ?? '') === './.github/actions/docker-images-restore'),
        `${name} restores the images`,
      ).toHaveLength(1);
    }
    expect(TEXT).not.toMatch(/docker-images-save|cache\/save/);
  });

  it('checks out without keeping the token, and pins each action as ci.yml does', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const j of [floor, control]) {
      const checkout = j.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
      expect(checkout?.with?.['persist-credentials']).toBe(false);
      for (const step of j.steps) {
        if (step.uses === undefined || step.uses.startsWith('./')) continue;
        expect(ci, `${step.uses} is not pinned as ci.yml pins it`).toContain(step.uses);
      }
    }
  });

  it('never puts event text in a script: every value a run step reads comes through env', () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        expect(step.run ?? '', `${name} interpolates into a script`).not.toMatch(/\$\{\{/);
      }
    }
    expect(TEXT).not.toMatch(/github\.event\./);
  });

  it('runs one leg per driver, each starting only its own emulator and running its tests at the floor', () => {
    expect(floor.strategy?.['fail-fast']).toBe(false);
    expect(floor.strategy?.matrix?.include).toEqual([
      { driver: 's3', service: 'minio' },
      { driver: 'gcs', service: 'fake-gcs' },
      { driver: 'azure-blob', service: 'azurite' },
    ]);
    const up = stepRunning(floor, 'docker compose');
    expect(up?.env).toEqual({ SERVICE: '${{ matrix.service }}' });
    // The service name is the last word: no other emulator starts.
    expect(up?.run).toMatch(/ up -d --pull never --wait --wait-timeout 300 "\$SERVICE"$/);
    const run = stepRunning(floor, 'scripts/sdk-floor.cjs');
    expect(run?.run).toBe('node scripts/sdk-floor.cjs --driver "$DRIVER" --integration');
    expect(run?.env).toEqual({ DRIVER: '${{ matrix.driver }}' });
    expect(run?.run).not.toContain('--version'); // the floor is read from the range, not written here
    expect(run?.if).toBeUndefined();
    expect(run?.['continue-on-error']).toBeUndefined();
  });

  it('runs the S3 driver one release below its floor and requires it to fail for the refusal of an unfenced write', () => {
    const run = stepRunning(control, 'scripts/sdk-floor.cjs');
    expect(run?.run).toBe(
      'node scripts/sdk-floor.cjs --driver s3 --version 3.699.0 --integration-only --expect-failure "does not send If-Match"',
    );
    expect(run?.if).toBeUndefined();
    expect(run?.['continue-on-error']).toBeUndefined();
    const up = stepRunning(control, 'docker compose');
    expect(up?.run).toMatch(/ up -d --pull never --wait --wait-timeout 300 minio$/);
  });

  it('puts the control below the declared floor, and its refusal text is the one the registry throws', () => {
    // The control's version is below the floor the package declares, so it is a version no install may resolve.
    const run = stepRunning(control, 'scripts/sdk-floor.cjs')?.run ?? '';
    const pinned = /--version (\d+)\.(\d+)\.(\d+)/.exec(run)?.slice(1).map(Number) ?? [];
    const floor = sdkFloor.floorOf(ROOT, 's3').split('.').map(Number);
    expect(pinned).toHaveLength(3);
    expect(pinned[0]).toBe(floor[0]);
    expect(pinned[1]).toBe((floor[1] ?? 0) - 1); // the minor just under the floor's
    const registry = readFileSync(join(ROOT, 'packages/s3/src/registry.ts'), 'utf8');
    // The registry names the header the way the control looks for it.
    expect(registry).toContain('`the S3 client does not send ${header} on a PutObject');
    expect(registry).toContain("expect === 'absent' ? 'If-None-Match' : 'If-Match'");
  });
});

describe('the SDK-floor script: reading a floor from a range', () => {
  it('reads the three declared ranges from the packages, not from a list of its own', () => {
    expect(sdkFloor.floorOf(ROOT, 's3')).toBe('3.700.0');
    expect(sdkFloor.floorOf(ROOT, 'gcs')).toBe('7.0.0');
    expect(sdkFloor.floorOf(ROOT, 'azure-blob')).toBe('12.0.0');
    const source = readFileSync(SCRIPT, 'utf8');
    for (const v of ['3.700.0', '7.0.0', '12.0.0']) {
      expect(
        source.replace(/\/\*[\s\S]*?\*\//g, ''),
        `${v} is written in the script`,
      ).not.toContain(`'${v}'`);
    }
  });

  it.each([
    ['>=3.700.0 <4', '3.700.0'],
    ['^7 || ^8', '7.0.0'],
    ['^8 || ^7', '7.0.0'],
    ['^12', '12.0.0'],
    ['~1.2', '1.2.0'],
    ['1.2.3', '1.2.3'],
    ['>=2.1 <3', '2.1.0'],
    ['<4 >=3.5.0', '3.5.0'],
  ])('reads %s as %s', (range, want) => {
    expect(sdkFloor.lowestVersion(range)).toBe(want);
  });

  it.each([
    ['<4', 'has no lower bound'],
    ['>3.1.0', 'is not a comparator'],
    ['latest', 'is not a comparator'],
    ['*', 'is not a comparator'],
    ['workspace:*', 'is not a comparator'],
    ['^1 || <2', 'has no lower bound'],
    ['>=1 >=2', 'two lower bounds'],
    ['^7 ||', 'an empty alternative'],
    ['', 'no range to read'],
  ])('refuses %j rather than test a version it guessed', (range, why) => {
    expect(() => sdkFloor.lowestVersion(range)).toThrow(why);
  });

  it('refuses an unknown driver and a package that does not name the SDK', () => {
    expect(() => sdkFloor.floorOf(ROOT, 'redis')).toThrow('unknown driver "redis"');
    const dir = mkdtempSync(join(tmpdir(), 'sdk-floor-test-'));
    try {
      mkdirSync(join(dir, 'packages/s3'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/s3/package.json'),
        JSON.stringify({ dependencies: { '@aws-sdk/client-sts': '^3' } }),
      );
      expect(() => sdkFloor.floorOf(dir, 's3')).toThrow('does not depend on @aws-sdk/client-s3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the SDK-floor script: where it works and what it installed', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-floor-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses to run in the checkout or anywhere inside it, however it is reached', () => {
    const checkout = join(dir, 'checkout');
    mkdirSync(join(checkout, 'nested'), { recursive: true });
    expect(() => sdkFloor.assertOutside(checkout, checkout)).toThrow('inside the checkout');
    expect(() => sdkFloor.assertOutside(checkout, join(checkout, 'nested'))).toThrow(
      'inside the checkout',
    );
    // A link from outside into the checkout is the checkout.
    const link = join(dir, 'link');
    symlinkSync(join(checkout, 'nested'), link);
    expect(() => sdkFloor.assertOutside(checkout, link)).toThrow('inside the checkout');
  });

  it('accepts a directory beside the checkout, one that merely starts with its name, and the real temp dir', () => {
    const checkout = join(dir, 'checkout');
    mkdirSync(checkout);
    mkdirSync(join(dir, 'checkout-copy'));
    mkdirSync(join(dir, 'elsewhere'));
    expect(() => sdkFloor.assertOutside(checkout, join(dir, 'checkout-copy'))).not.toThrow();
    expect(() => sdkFloor.assertOutside(checkout, join(dir, 'elsewhere'))).not.toThrow();
    expect(() => sdkFloor.assertOutside(ROOT, realpathSync(dir))).not.toThrow();
  });

  const install = (at: string, sdk: string, version: string) => {
    const manifest = join(dir, at, 'node_modules', ...sdk.split('/'), 'package.json');
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name: sdk, version }));
  };

  it('passes when every installed copy of the SDK is the version asked for', () => {
    install('.', '@aws-sdk/client-s3', '3.700.0');
    install('packages/s3', '@aws-sdk/client-s3', '3.700.0');
    const found = sdkFloor.checkInstalled(dir, 's3', '3.700.0');
    expect(found.map((f) => f.version)).toEqual(['3.700.0', '3.700.0']);
    // One copy, in the package alone, is enough: the root need not hold it.
    rmSync(join(dir, 'node_modules'), { recursive: true });
    expect(sdkFloor.checkInstalled(dir, 's3', '3.700.0')).toHaveLength(1);
  });

  it('fails when the pin did not take: a copy of another version at the root or in the package', () => {
    install('.', '@aws-sdk/client-s3', '3.1132.0');
    install('packages/s3', '@aws-sdk/client-s3', '3.700.0');
    expect(() => sdkFloor.checkInstalled(dir, 's3', '3.700.0')).toThrow(
      /resolved to 3\.1132\.0 at node_modules[\\/]@aws-sdk[\\/]client-s3[\\/]package\.json, not the 3\.700\.0.*pin did not take/,
    );
    rmSync(join(dir, 'node_modules'), { recursive: true });
    install('packages/s3', '@aws-sdk/client-s3', '3.700.1');
    expect(() => sdkFloor.checkInstalled(dir, 's3', '3.700.0')).toThrow('pin did not take');
  });

  it('fails when the SDK is not installed at all, and reads each driver at its own path', () => {
    expect(() => sdkFloor.checkInstalled(dir, 's3', '3.700.0')).toThrow('is not installed');
    install('packages/gcs', '@google-cloud/storage', '7.0.0');
    expect(sdkFloor.checkInstalled(dir, 'gcs', '7.0.0')).toHaveLength(1);
    expect(() => sdkFloor.checkInstalled(dir, 'azure-blob', '12.0.0')).toThrow('is not installed');
    install('packages/azure-blob', '@azure/storage-blob', '12.0.0');
    expect(sdkFloor.checkInstalled(dir, 'azure-blob', '12.0.0')).toHaveLength(1);
  });

  it('pins the SDK in pnpm.overrides and leaves every other setting, the build-script allowlist included, alone', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        pnpm: { onlyBuiltDependencies: ['roaring'], overrides: { undici: '>=6.28.0 <7' } },
      }),
    );
    sdkFloor.pinSdk(dir, '@aws-sdk/client-s3', '3.700.0');
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      pnpm: { onlyBuiltDependencies: string[]; overrides: Record<string, string> };
    };
    expect(after.pnpm.overrides).toEqual({
      undici: '>=6.28.0 <7',
      '@aws-sdk/client-s3': '3.700.0',
    });
    expect(after.pnpm.onlyBuiltDependencies).toEqual(['roaring']);
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(
      /dangerously-allow-all-builds|--allow-build|ignore-scripts|onlyBuilt/,
    );
  });

  it('installs without the lockfile, only after pinning, and checks the version before it runs a test', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const at = (needle: string) => {
      const i = source.indexOf(needle);
      expect(i, `${needle} is not in the script`).toBeGreaterThan(-1);
      return i;
    };
    expect(source).toContain("['install', '--no-frozen-lockfile']");
    expect(at('pinSdk(copy, spec.sdk')).toBeLessThan(at("['install', '--no-frozen-lockfile']"));
    expect(at("['install', '--no-frozen-lockfile']")).toBeLessThan(
      at('= checkInstalled(copy, driver, version)'),
    );
    expect(at('= checkInstalled(copy, driver, version)')).toBeLessThan(at("'vitest'"));
    // The directory goes whatever happened, unless the caller asked to keep it.
    expect(at('} finally {')).toBeGreaterThan(at("'vitest'"));
    expect(source).toContain('fs.rmSync(parent, { recursive: true, force: true })');
  });
});

describe('the SDK-floor script: the verdict of the negative control', () => {
  const REFUSAL = 'ValidationError: the S3 client does not send If-Match on a PutObject';
  const report = (over: Record<string, unknown> = {}) => ({
    numTotalTests: 10,
    numFailedTests: 2,
    testResults: [
      {
        message: '',
        assertionResults: [
          { status: 'passed', failureMessages: [] },
          { status: 'failed', failureMessages: [REFUSAL] },
        ],
      },
    ],
    ...over,
  });
  const TEXT_ = 'does not send If-Match';

  it('passes a run that failed with the refusal', () => {
    expect(sdkFloor.classifyFailure(report(), TEXT_)).toMatchObject({ ok: true });
  });

  it('passes when the refusal is in a file-level failure, not a test', () => {
    const r = report({
      testResults: [{ message: REFUSAL, assertionResults: [] }],
    });
    expect(sdkFloor.classifyFailure(r, TEXT_)).toMatchObject({ ok: true });
  });

  it.each([
    ['a run that passed', report({ numFailedTests: 0 }), 'the tests passed'],
    ['no test run at all', report({ numTotalTests: 0, numFailedTests: 0 }), 'no test ran'],
    ['no report', undefined, 'no test report was written'],
    ['a report that is not an object', 'oops', 'no test report was written'],
    [
      'a failure for another reason',
      report({
        testResults: [
          {
            message: '',
            assertionResults: [
              { status: 'failed', failureMessages: ['ECONNREFUSED 127.0.0.1:9000'] },
            ],
          },
        ],
      }),
      'none with',
    ],
    [
      'the text in a test that passed',
      report({
        testResults: [
          { message: '', assertionResults: [{ status: 'passed', failureMessages: [REFUSAL] }] },
        ],
      }),
      'none with',
    ],
  ])('fails %s', (_what, r, reason) => {
    const verdict = sdkFloor.classifyFailure(r, TEXT_);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(reason);
  });
});

describe('the SDK-floor script: arguments it refuses before it touches anything', () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });

  it.each([
    [[], '--driver <s3|gcs|azure-blob> is required'],
    [['--driver', 'redis'], 'unknown driver "redis"'],
    [['--driver', 's3', '--version', '3.700'], 'must be an exact version'],
    [['--driver', 's3', '--version', 'latest'], 'must be an exact version'],
    [['--driver', 's3', '--version'], '--version needs a value'],
    [['--driver', 's3', '--expect-failure', '--keep'], '--expect-failure needs a value'],
  ])('%j exits 1 saying %j', (args, message) => {
    const r = cli(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});
