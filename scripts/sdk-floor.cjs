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
 *   1. Reads the lowest version of each alternative of the driver package's range from its `package.json` (never
 *      hard-coded) and takes the one `--floor <n>` names (0 is the lowest; a range with one alternative needs no
 *      `--floor`, and one with several refuses to run without it), or takes `--version <v>`. A job runs every
 *      alternative, one `--floor` each, so a break at the lowest version of a later alternative cannot hide behind a
 *      pass at an earlier one.
 *   2. Exports the committed tree (`git archive HEAD`) into a new directory outside the checkout, adds a
 *      `pnpm.overrides` entry pinning the SDK to that version, and runs `pnpm install --no-frozen-lockfile` there.
 *      The repo's pnpm settings are kept as they are: the only dependency build script that runs is `roaring`'s.
 *   3. Checks that every installed copy of the SDK is exactly that version (the root's, the driver package's, and any
 *      under `node_modules/.pnpm`), and fails if none is found or one differs:
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
 * Usage:  node scripts/sdk-floor.cjs --driver <s3|gcs|azure-blob> [--version <v> | --floor <n>] [--integration | --integration-only]
 *                                    [--expect-failure <text>] [--max-workers <n>] [--keep]
 *
 * Needs `git`, `pnpm` and network access to the npm registry; `--integration` needs the emulator for the driver up
 * (`docker compose up -d <service>`).
 */

const { spawn } = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Install and test budgets, in milliseconds. A run past its budget is killed, with every process it started, and fails.
 * One install and two test runs (the unit tests, then the integration file) must fit inside the job's `timeout-minutes`
 * with the export and the emulator's start to spare; a test checks that sum against the workflow.
 */
const INSTALL_MS = 4 * 60_000;
const TEST_MS = 7 * 60_000;

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
 * The lowest version of each alternative a dependency range admits, as `major.minor.patch`, ascending, with duplicates
 * removed. `^7.4.0 || ^8` gives `7.4.0` and `8.0.0`: a break at `8.0.0` must not hide behind a pass at `7.4.0`, so every
 * alternative is run at its own lowest version. A range with no `||` gives one version.
 *
 * Reads the shapes this repo's drivers use: alternatives joined by `||`, each a space-separated set of comparators
 * among `^x`, `~x`, `>=x`, `<x`, `<=x` and a bare version. An alternative's lower bound is its `^`, `~`, `>=` or bare
 * version; one with none (`<4` alone), a `>` (the version after it is not a version), a tag, a wildcard or anything
 * else is refused, so a range this cannot read fails the job instead of testing the wrong version.
 */
function floorsOfRange(range) {
  if (typeof range !== 'string' || range.trim() === '') fail(`no range to read: ${String(range)}`);
  const floors = [];
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
    if (!floors.some((f) => compareParsed(f, lower) === 0)) floors.push(lower);
  }
  return floors.sort(compareParsed).map((f) => f.join('.'));
}

/** The lowest version the range admits: the first of {@link floorsOfRange}. */
function lowestVersion(range) {
  return floorsOfRange(range)[0];
}

/** The range the named driver's package declares for its SDK, read from that package's `package.json` in `root`. */
function rangeOf(root, driver) {
  const spec = DRIVERS[driver];
  if (!spec) fail(`unknown driver "${driver}": one of ${Object.keys(DRIVERS).join(', ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, spec.dir, 'package.json'), 'utf8'));
  const range =
    manifest.dependencies?.[spec.sdk] ??
    manifest.peerDependencies?.[spec.sdk] ??
    manifest.optionalDependencies?.[spec.sdk];
  if (range === undefined) fail(`${spec.dir}/package.json does not depend on ${spec.sdk}`);
  return range;
}

/** The lowest version of each alternative of the named driver's range: the versions a complete floor run covers. */
function floorsOf(root, driver) {
  return floorsOfRange(rangeOf(root, driver));
}

/** The lowest version the named driver's range admits. */
function floorOf(root, driver) {
  return floorsOf(root, driver)[0];
}

/** Refuse a working directory that is the checkout or inside it: the install and the tests must never touch it. */
function assertOutside(root, dir) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    fail(`refusing to run inside the checkout: ${dir} is within ${root}`);
  }
}

/**
 * Every installed copy of `sdk` in the tree: the root's, the driver package's, and each one pnpm keeps in its virtual
 * store (`node_modules/.pnpm/<scope>+<name>@<version>...`), where a second version that something else depends on lives.
 */
function installedVersions(copy, driver) {
  const spec = DRIVERS[driver];
  const manifests = [copy, path.join(copy, spec.dir)].map((base) =>
    path.join(base, 'node_modules', ...spec.sdk.split('/'), 'package.json'),
  );
  const store = path.join(copy, 'node_modules', '.pnpm');
  if (fs.existsSync(store)) {
    const prefix = `${spec.sdk.replace('/', '+')}@`;
    for (const entry of fs.readdirSync(store)) {
      if (entry.startsWith(prefix)) {
        manifests.push(
          path.join(store, entry, 'node_modules', ...spec.sdk.split('/'), 'package.json'),
        );
      }
    }
  }
  const found = [];
  for (const manifest of manifests) {
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
    for (const t of failedTests.slice(0, 6)) {
      lines.push(
        `    - ${String(t.fullName).slice(0, 160)}: ${String(t.failureMessages?.[0] ?? '')
          .split('\n')[0]
          .slice(0, 160)}`,
      );
    }
  }
  return lines.join('\n');
}

/** The most output kept from one command, in characters; the rest is dropped, oldest first. */
const MAX_OUT = 64 * 1024 * 1024;

/**
 * Run a command; resolve `{ status, out }`. The command leads a process group of its own, and a run past `timeout` has
 * the whole group killed (SIGKILL), so a test runner's workers and anything a test started do not outlive the job step;
 * a timeout or a spawn error rejects.
 */
function run(cmd, args, { cwd, timeout, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv(env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (chunk) => {
      out = (out + chunk).slice(-MAX_OUT);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} ${args.join(' ')}: ${err.message}\n${out}`));
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} ${args.join(' ')}: killed after ${timeout} ms\n${out}`));
      } else {
        resolve({ status, out });
      }
    });
  });
}

async function mustRun(cmd, args, options) {
  const { status, out } = await run(cmd, args, options);
  if (status !== 0) fail(`${cmd} ${args.join(' ')} exited ${status}\n${out}`);
  return out;
}

/** Export the committed tree of `root` into `dest`. */
async function exportTree(root, dest) {
  const archive = path.join(dest, '..', `${path.basename(dest)}.tar`);
  await mustRun('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'], {
    cwd: root,
    timeout: 120_000,
  });
  fs.mkdirSync(dest);
  await mustRun('tar', ['-xf', archive, '-C', dest], { cwd: dest, timeout: 120_000 });
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
  if (value.trim() === '') fail(`${name} needs a non-empty value`);
  return value;
}

/**
 * The version one run tests: `--version` as given, or the lowest version of the range's alternative `--floor <n>` (0 is
 * the lowest alternative). A range with several alternatives needs `--floor`: a run that quietly took the first would
 * leave the others untested, so it is refused.
 */
function chooseVersion(root, driver, explicit, floorIndex) {
  if (explicit !== undefined) {
    if (floorIndex !== undefined)
      fail('--version and --floor are two ways to name one version: pass one');
    return explicit;
  }
  const floors = floorsOf(root, driver);
  if (floorIndex === undefined) {
    if (floors.length > 1) {
      fail(
        `the range has ${floors.length} alternatives (lowest versions ${floors.join(', ')}): pass --floor <0-${floors.length - 1}>, one run for each`,
      );
    }
    return floors[0];
  }
  if (!/^\d+$/.test(floorIndex) || Number(floorIndex) >= floors.length) {
    fail(
      `--floor must be a number from 0 to ${floors.length - 1} (${floors.join(', ')}), not "${floorIndex}"`,
    );
  }
  return floors[Number(floorIndex)];
}

/** Everything one run does; returns normally on a pass and throws on anything else. */
async function main(argv) {
  const driver = option(argv, '--driver');
  if (driver === undefined) fail('--driver <s3|gcs|azure-blob> is required');
  const spec = DRIVERS[driver];
  if (!spec) fail(`unknown driver "${driver}": one of ${Object.keys(DRIVERS).join(', ')}`);
  const version = chooseVersion(ROOT, driver, option(argv, '--version'), option(argv, '--floor'));
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
    await exportTree(ROOT, copy);
    pinSdk(copy, spec.sdk, version);
    console.log('  pnpm install (no frozen lockfile, SDK pinned)');
    await mustRun('pnpm', ['install', '--no-frozen-lockfile'], { cwd: copy, timeout: INSTALL_MS });
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
      const { status, out: text } = await run('pnpm', args, { cwd: copy, timeout: TEST_MS });
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
  INSTALL_MS,
  TEST_MS,
  run,
  floorsOfRange,
  lowestVersion,
  floorsOf,
  floorOf,
  chooseVersion,
  assertOutside,
  checkInstalled,
  classifyFailure,
  summarize,
  pinSdk,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`sdk-floor: ${err.message}`);
    process.exitCode = 1;
  });
}
