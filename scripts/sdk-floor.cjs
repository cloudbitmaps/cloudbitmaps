#!/usr/bin/env node
'use strict';

/*
 * SDK floor: run one storage driver's tests against the oldest cloud SDK its dependency range allows.
 *
 * Each driver depends on its SDK by a range (`@aws-sdk/client-s3` `>=3.700.0 <4`, `@google-cloud/storage`
 * `^8.1.0`, `@azure/storage-blob` `^12.23.0`), and a user's install can resolve any version in it: npm reuses one the
 * application already has. CI's ordinary jobs run only the version in `pnpm-lock.yaml`, the newest, so the lowest
 * version a range admits is never run, and a driver that quietly came to need a newer SDK member passes every check.
 * The S3 floor matters most: an SDK that predates `If-Match` on `PutObject` sends the registry's compare-and-swap as a
 * plain overwrite.
 *
 * What it does, for `--driver s3|gcs|azure-blob`
 *   1. Reads the lowest version the driver package's range admits from its `package.json` (never hard-coded), or takes
 *      `--version <v>`.
 *   2. Exports the committed tree (`git archive HEAD`) into a new directory outside the checkout, adds a
 *      `pnpm.overrides` entry pinning the SDK to that version, and runs `pnpm install --no-frozen-lockfile` there.
 *      The repo's pnpm settings are kept as they are: the only dependency build script that runs is `roaring`'s.
 *   3. Checks that every installed copy of the SDK is exactly that version, and fails if none is found or one differs:
 *      a pin that silently did not take would run the newest SDK and report green.
 *   4. Runs the driver's unit tests (`tests/drivers/<dir>`) and, with `--integration`, its file under
 *      `tests/integration/` against the emulator that is already up.
 *   5. Removes the directory, whatever happened.
 *
 * `--expect-failure <text>` turns the run into a negative control: the tests must fail, and a failure message must
 * contain `<text>`. A run that passes, one that fails for another reason, and an install or version-check failure all
 * fail the control. It proves the job can see the break it exists for.
 *
 * What it does not show: the SDK's own transitive dependencies resolve to their newest in range; the types are not
 * compiled against the floor; npm 12 is untested.
 *
 * `--integration-only` runs the integration file alone.
 *
 * Usage:  node scripts/sdk-floor.cjs --driver <s3|gcs|azure-blob> [--version <v>] [--integration | --integration-only]
 *                                    [--expect-failure <text>] [--max-workers <n>] [--keep]
 *
 * Needs `git`, `pnpm` and network access to the npm registry; `--integration` needs the emulator for the driver up
 * (`docker compose up -d <service>`).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Install and test budgets, in milliseconds. A run past its budget is killed and fails. */
const INSTALL_MS = 5 * 60_000;
const TEST_MS = 15 * 60_000;

/**
 * Per driver: its package directory, the SDK it depends on, its unit tests and its integration file. The name is the
 * one `--driver` takes.
 */
const DRIVERS = {
  s3: {
    dir: 'packages/s3',
    sdk: '@aws-sdk/client-s3',
    unit: 'tests/drivers/s3',
    integration: 'tests/integration/s3.test.ts',
  },
  gcs: {
    dir: 'packages/gcs',
    sdk: '@google-cloud/storage',
    unit: 'tests/drivers/gcs',
    integration: 'tests/integration/gcs.test.ts',
  },
  'azure-blob': {
    dir: 'packages/azure-blob',
    sdk: '@azure/storage-blob',
    unit: 'tests/drivers/azure',
    integration: 'tests/integration/azure.test.ts',
  },
};

/** The environment variables a child process may inherit; everything else, tokens included, is dropped. */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

function fail(message) {
  throw new Error(message);
}

function childEnv(extra) {
  const env = {};
  for (const name of INHERITED_ENV)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** `1.2.3` as `[1, 2, 3]`; `1` and `1.2` are padded with zeros. `undefined` when it is not a plain version. */
function parseVersion(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareParsed(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * The lowest version a dependency range admits, as `major.minor.patch`.
 *
 * Reads the shapes this repo's drivers use: alternatives joined by `||`, each a space-separated set of comparators
 * among `^x`, `~x`, `>=x`, `<x`, `<=x` and a bare version. An alternative's lower bound is its `^`, `~`, `>=` or bare
 * version; one with none (`<4` alone), a `>` (the version after it is not a version), a tag, a wildcard or anything
 * else is refused, so a range this cannot read fails the job instead of testing the wrong version.
 */
function lowestVersion(range) {
  if (typeof range !== 'string' || range.trim() === '') fail(`no range to read: ${String(range)}`);
  let lowest;
  for (const alternative of range.split('||')) {
    const words = alternative.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) fail(`cannot read the range "${range}": an empty alternative`);
    let lower;
    for (const word of words) {
      const m = /^(\^|~|>=|<=|<)?(\d+(?:\.\d+){0,2})$/.exec(word);
      if (!m) fail(`cannot read the range "${range}": "${word}" is not a comparator this reads`);
      if (m[1] === '<' || m[1] === '<=') continue;
      if (lower !== undefined)
        fail(`cannot read the range "${range}": two lower bounds in "${alternative.trim()}"`);
      lower = parseVersion(m[2]);
    }
    if (lower === undefined)
      fail(`cannot read the range "${range}": "${alternative.trim()}" has no lower bound`);
    if (lowest === undefined || compareParsed(lower, lowest) < 0) lowest = lower;
  }
  return lowest.join('.');
}

/** The lowest version the named driver's package range admits, read from that package's `package.json` in `root`. */
function floorOf(root, driver) {
  const spec = DRIVERS[driver];
  if (!spec) fail(`unknown driver "${driver}": one of ${Object.keys(DRIVERS).join(', ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, spec.dir, 'package.json'), 'utf8'));
  const range =
    manifest.dependencies?.[spec.sdk] ??
    manifest.peerDependencies?.[spec.sdk] ??
    manifest.optionalDependencies?.[spec.sdk];
  if (range === undefined) fail(`${spec.dir}/package.json does not depend on ${spec.sdk}`);
  return lowestVersion(range);
}

/** Refuse a working directory that is the checkout or inside it: the install and the tests must never touch it. */
function assertOutside(root, dir) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    fail(`refusing to run inside the checkout: ${dir} is within ${root}`);
  }
}

/** Every installed copy of `sdk` that a test in the tree can resolve: the root's and the driver package's. */
function installedVersions(copy, driver) {
  const spec = DRIVERS[driver];
  const found = [];
  for (const base of [copy, path.join(copy, spec.dir)]) {
    const manifest = path.join(base, 'node_modules', ...spec.sdk.split('/'), 'package.json');
    if (fs.existsSync(manifest)) {
      found.push({
        at: path.relative(copy, manifest),
        version: JSON.parse(fs.readFileSync(manifest, 'utf8')).version,
      });
    }
  }
  return found;
}

/** Fail unless the SDK is installed, at least once, and every copy is exactly `version`. */
function checkInstalled(copy, driver, version) {
  const spec = DRIVERS[driver];
  const found = installedVersions(copy, driver);
  if (found.length === 0) fail(`${spec.sdk} is not installed anywhere under ${copy}`);
  for (const { at, version: v } of found) {
    if (v !== version) {
      fail(
        `${spec.sdk} resolved to ${v} at ${at}, not the ${version} that was asked for: the pin did not take`,
      );
    }
  }
  return found;
}

/**
 * Read a vitest JSON report for the negative control: it passes only when tests ran and failed and a failure message
 * holds `text`. Returns `{ ok, reason }`.
 */
function classifyFailure(report, text) {
  if (report === undefined || report === null || typeof report !== 'object') {
    return { ok: false, reason: 'no test report was written' };
  }
  if (!Number.isInteger(report.numTotalTests) || report.numTotalTests === 0) {
    return { ok: false, reason: 'no test ran' };
  }
  if (!(report.numFailedTests > 0)) return { ok: false, reason: 'the tests passed' };
  const messages = [];
  for (const file of report.testResults ?? []) {
    if (typeof file.message === 'string' && file.message !== '') messages.push(file.message);
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'failed') messages.push(...(t.failureMessages ?? []).map(String));
    }
  }
  if (messages.some((m) => m.includes(text)))
    return { ok: true, reason: `a test failed with "${text}"` };
  return { ok: false, reason: `tests failed, but none with "${text}"` };
}

/** A short account of a failed run: the failing files with their counts and first message, else the output's tail. */
function summarize({ out, text }) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    return text.slice(-6000);
  }
  const lines = [`${report.numFailedTests} of ${report.numTotalTests} tests failed`];
  for (const file of report.testResults ?? []) {
    const failedTests = (file.assertionResults ?? []).filter((t) => t.status === 'failed');
    if (failedTests.length === 0 && file.status === 'passed') continue;
    const first = failedTests[0]?.failureMessages?.[0] ?? file.message ?? '';
    lines.push(
      `  ${path.relative(path.dirname(out), file.name).split('/repo/').pop()}: ${failedTests.length} failed: ${String(first).split('\n')[0].slice(0, 160)}`,
    );
  }
  return lines.join('\n');
}

/** Run a command; return `{ status, out }`. A spawn error or a timeout throws. */
function run(cmd, args, { cwd, timeout, env }) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: childEnv(env),
    encoding: 'utf8',
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) fail(`${cmd} ${args.join(' ')}: ${result.error.message}\n${out}`);
  return { status: result.status, out };
}

function mustRun(cmd, args, options) {
  const { status, out } = run(cmd, args, options);
  if (status !== 0) fail(`${cmd} ${args.join(' ')} exited ${status}\n${out}`);
  return out;
}

/** Export the committed tree of `root` into `dest`. */
function exportTree(root, dest) {
  const archive = path.join(dest, '..', `${path.basename(dest)}.tar`);
  mustRun('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'], {
    cwd: root,
    timeout: 120_000,
  });
  fs.mkdirSync(dest);
  mustRun('tar', ['-xf', archive, '-C', dest], { cwd: dest, timeout: 120_000 });
  fs.rmSync(archive, { force: true });
}

/** Add `sdk: version` to the copy's `pnpm.overrides`; every other setting stays as committed. */
function pinSdk(copy, sdk, version) {
  const file = path.join(copy, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.pnpm = manifest.pnpm ?? {};
  manifest.pnpm.overrides = { ...(manifest.pnpm.overrides ?? {}), [sdk]: version };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function option(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

/** Everything one run does; returns normally on a pass and throws on anything else. */
function main(argv) {
  const driver = option(argv, '--driver');
  if (driver === undefined) fail('--driver <s3|gcs|azure-blob> is required');
  const spec = DRIVERS[driver];
  if (!spec) fail(`unknown driver "${driver}": one of ${Object.keys(DRIVERS).join(', ')}`);
  const version = option(argv, '--version') ?? floorOf(ROOT, driver);
  if (parseVersion(version) === undefined || version.split('.').length !== 3) {
    fail(`--version must be an exact version such as 3.700.0, not "${version}"`);
  }
  const expectFailure = option(argv, '--expect-failure');
  const maxWorkers = option(argv, '--max-workers');
  const integrationOnly = argv.includes('--integration-only');
  const integration = integrationOnly || argv.includes('--integration');
  const keep = argv.includes('--keep');

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudbitmaps-sdk-floor-'));
  const copy = path.join(parent, 'repo');
  try {
    assertOutside(ROOT, parent);
    console.log(`sdk-floor: ${driver} at ${spec.sdk}@${version}`);
    console.log('  export the committed tree');
    exportTree(ROOT, copy);
    pinSdk(copy, spec.sdk, version);
    console.log('  pnpm install (no frozen lockfile, SDK pinned)');
    mustRun('pnpm', ['install', '--no-frozen-lockfile'], { cwd: copy, timeout: INSTALL_MS });
    const found = checkInstalled(copy, driver, version);
    console.log(`  installed: ${found.map((f) => `${f.at} ${f.version}`).join(', ')}`);

    const targets = integrationOnly
      ? [spec.integration]
      : integration
        ? [spec.unit, spec.integration]
        : [spec.unit];
    // The unit tests and the integration file use two configs, so they are two runs.
    const reports = [];
    let failed = false;
    for (const [i, target] of targets.entries()) {
      const isIntegration = target === spec.integration;
      const out = path.join(parent, `report-${i}.json`);
      const args = ['vitest', 'run', '--reporter=json', `--outputFile=${out}`];
      if (maxWorkers !== undefined) args.push(`--maxWorkers=${maxWorkers}`);
      if (isIntegration) args.push('-c', 'vitest.integration.config.ts');
      args.push(target);
      console.log(`  ${isIntegration ? 'integration' : 'unit'} tests: ${target}`);
      const { status, out: text } = run('pnpm', args, { cwd: copy, timeout: TEST_MS });
      if (status !== 0) failed = true;
      reports.push({ out, status, text });
    }

    if (expectFailure !== undefined) {
      const verdicts = reports.map((r) => {
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(r.out, 'utf8'));
        } catch {
          parsed = undefined;
        }
        return classifyFailure(parsed, expectFailure);
      });
      if (!failed || !verdicts.some((v) => v.ok)) {
        const why = verdicts.map((v) => v.reason).join('; ');
        fail(`the negative control did not fail as expected: ${why}`);
      }
      console.log(
        `sdk-floor: ${driver} at ${version} failed as expected: ${verdicts.find((v) => v.ok).reason}`,
      );
      return;
    }
    if (failed) {
      const last = reports.find((r) => r.status !== 0);
      fail(`${driver} tests failed at ${spec.sdk}@${version}\n${summarize(last)}`);
    }
    console.log(`sdk-floor: ${driver} passes at ${spec.sdk}@${version}`);
  } finally {
    if (keep) console.log(`  kept: ${parent}`);
    else fs.rmSync(parent, { recursive: true, force: true });
  }
}

module.exports = {
  DRIVERS,
  lowestVersion,
  floorOf,
  assertOutside,
  checkInstalled,
  classifyFailure,
  pinSdk,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`sdk-floor: ${err.message}`);
    process.exitCode = 1;
  }
}
