import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `pnpm test:no-dist` runs the suite with every `packages/*\/dist` hidden, as CI's test step has it (the tests run
 * before the build), and puts each back afterwards.
 *
 * Each test works on a temporary tree: one package with a built entry and a planted test that imports that entry, run by
 * the repository's own vitest. The plant is a file this test writes and removes, so it is never in the suite. Needs no
 * build and no `dist/` of the repository.
 *
 * Not covered: the script's refusal when vitest is not installed (it reads the repository's own `node_modules`), and
 * a second signal during a run.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/test-no-dist.cjs', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

const BUILT = 'export const answer = 42;\n';
const PLANT = `
test('the built entry is reachable', async () => {
  const built = await import('./packages/p/dist/index.js');
  expect(built.answer).toBe(42);
});
`;
// Writes a marker once the run has started, then waits to be stopped.
const HANG = `
import { writeFileSync } from 'node:fs';
test('runs until it is stopped', async () => {
  writeFileSync('started', 'yes');
  await new Promise((resolve) => setTimeout(resolve, 60000));
}, 120000);
`;

// Takes long enough that two runs started together overlap.
const SLOW = `
test('runs for a while', async () => {
  await new Promise((resolve) => setTimeout(resolve, 4000));
});
`;

let root: string;
const dist = (pkg = 'p') => join(root, 'packages', pkg, 'dist', 'index.js');
const aside = () => join(root, '.no-dist-aside');
const hiddenDist = (pkg = 'p') => join(aside(), 'hidden', pkg, 'dist');

const plant = (source: string) => writeFileSync(join(root, 'plant.test.ts'), source);
const env = () => ({ PATH: process.env.PATH ?? '', CB_NO_DIST_ROOT: root });
const sync = (file: string, args: string[]) =>
  spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: env(),
    timeout: 120000,
  });
const plain = (...args: string[]) => sync(VITEST, ['run', '--globals', ...args]);
const noDist = (...args: string[]) => sync(SCRIPT, ['--globals', ...args]);
const restoreOnly = () => sync(SCRIPT, ['--restore']);
const text = (run: { stdout: string; stderr: string }) => run.stdout + run.stderr;

const addPackage = (pkg: string) => {
  mkdirSync(join(root, 'packages', pkg, 'dist'), { recursive: true });
  writeFileSync(join(root, 'packages', pkg, 'package.json'), `{"name":"${pkg}","type":"module"}`);
  writeFileSync(dist(pkg), BUILT);
};
// The state a SIGKILL leaves: a package's dist under the aside folder, and a lock naming a process that is gone.
const leaveHidden = (pkg = 'p') => {
  mkdirSync(join(aside(), 'hidden', pkg), { recursive: true });
  renameSync(join(root, 'packages', pkg, 'dist'), hiddenDist(pkg));
  writeFileSync(join(aside(), 'lock'), '2147483646');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'no-dist-'));
  addPackage('p');
  plant(PLANT);
});
afterEach(() => {
  try {
    chmodSync(join(root, 'packages', 'p'), 0o755);
  } catch {
    // already gone
  }
  rmSync(root, { recursive: true, force: true });
});

describe('pnpm test:no-dist', () => {
  it('passes a test that imports a built entry on a plain run and fails it with the dist hidden', () => {
    expect(plain('plant.test.ts').status).toBe(0);
    const hidden = noDist('plant.test.ts');
    expect(hidden.status).toBe(1);
    expect(text(hidden)).toMatch(/Cannot find module|Failed to load/);
  });

  it('restores every dist after a failing run and after a passing one', () => {
    expect(noDist('plant.test.ts').status).toBe(1);
    expect(readFileSync(dist(), 'utf8')).toBe(BUILT);
    expect(existsSync(aside())).toBe(false);

    plant("test('does not need the build', () => {});");
    expect(noDist('plant.test.ts').status).toBe(0);
    expect(existsSync(dist())).toBe(true);
  });

  it('hands vitest its arguments: a file filter, -t and a worker cap', () => {
    plant(PLANT + "\ntest('second', () => {});\n");
    const run = noDist('plant.test.ts', '-t', 'second', '--maxWorkers=1');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/1 passed/);
    expect(run.stdout).toMatch(/1 skipped/);
  });

  it('leaves a package with no dist alone', () => {
    mkdirSync(join(root, 'packages', 'bare'), { recursive: true });
    plant("test('runs', () => {});");
    expect(noDist('plant.test.ts').status).toBe(0);
    expect(existsSync(join(root, 'packages', 'bare', 'dist'))).toBe(false);
  });

  it('puts back a dist a killed run left hidden before the next run starts', () => {
    // A build ran after the kill, so the leftover and the new dist both want the same place under the aside folder:
    // a run that hid first and restored afterwards would fail while hiding (status 2); one that restores first runs.
    leaveHidden();
    mkdirSync(join(root, 'packages', 'p', 'dist'));
    writeFileSync(dist(), 'export const answer = 0;\n');
    const run = noDist('plant.test.ts');
    expect(run.status).toBe(1);
    expect(text(run)).toMatch(/Cannot find module|Failed to load/);
    // The build that could not go back is named, not moved aside in silence.
    expect(text(run)).toMatch(/kept a hidden dist for p /);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 0;\n');
    expect(readdirSync(join(aside(), 'kept'))).toHaveLength(1);

    // A package folder that is gone is named too, by a run and not only by --restore.
    rmSync(aside(), { recursive: true });
    mkdirSync(join(aside(), 'hidden', 'gone', 'dist'), { recursive: true });
    writeFileSync(join(aside(), 'hidden', 'gone', 'dist', 'index.js'), BUILT);
    writeFileSync(join(aside(), 'lock'), '2147483646');
    plant("test('runs', () => {});");
    const gone = noDist('plant.test.ts');
    expect(gone.status).toBe(0);
    expect(text(gone)).toMatch(/kept a hidden dist for gone /);
    plant(PLANT);

    // With no build in between the leftover itself goes back, and the plant that needs it passes on a plain run.
    rmSync(aside(), { recursive: true });
    rmSync(join(root, 'packages', 'p', 'dist'), { recursive: true });
    mkdirSync(join(root, 'packages', 'p', 'dist'));
    writeFileSync(dist(), BUILT);
    leaveHidden();
    expect(restoreOnly().status).toBe(0);
    expect(plain('plant.test.ts').status).toBe(0);
    expect(existsSync(aside())).toBe(false);
  });

  it('never deletes a hidden build: it keeps it when its package has a dist again or is gone', () => {
    // A build ran after the kill.
    leaveHidden();
    mkdirSync(join(root, 'packages', 'p', 'dist'));
    writeFileSync(dist(), 'export const answer = 0;\n');
    // A package that no longer exists.
    mkdirSync(join(aside(), 'hidden', 'gone', 'dist'), { recursive: true });
    writeFileSync(join(aside(), 'hidden', 'gone', 'dist', 'index.js'), BUILT);

    const run = restoreOnly();
    expect(run.status).toBe(0);
    expect(text(run)).toMatch(/kept a hidden dist for p/);
    expect(text(run)).toMatch(/kept a hidden dist for gone/);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 0;\n');
    const kept = readdirSync(join(aside(), 'kept')).sort();
    expect(kept).toHaveLength(2);
    expect(kept.some((k) => k.endsWith('-p'))).toBe(true);
    for (const k of kept) {
      expect(readFileSync(join(aside(), 'kept', k, 'dist', 'index.js'), 'utf8')).toBe(BUILT);
    }
    expect(existsSync(join(aside(), 'hidden'))).toBe(false);
    // The leftover does not make later runs fail.
    plant("test('runs', () => {});");
    expect(noDist('plant.test.ts').status).toBe(0);
  });

  it('refuses to start, and refuses --restore, while a live run holds the lock', () => {
    mkdirSync(aside(), { recursive: true });
    writeFileSync(join(aside(), 'lock'), String(process.ppid));
    const run = noDist('plant.test.ts');
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/another no-dist run/);
    expect(run.stderr).toMatch(/--restore/);
    expect(existsSync(dist())).toBe(true);

    leaveHidden();
    writeFileSync(join(aside(), 'lock'), String(process.ppid));
    const restore = restoreOnly();
    expect(restore.status).toBe(2);
    expect(restore.stderr).toMatch(/another no-dist run/);
    expect(existsSync(hiddenDist())).toBe(true);
  });

  it('replaces a lock that holds no process id once it is old, and waits for a fresh one', () => {
    mkdirSync(aside(), { recursive: true });
    const lock = join(aside(), 'lock');
    writeFileSync(lock, '');
    const fresh = noDist('plant.test.ts');
    expect(fresh.status).toBe(2);

    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    plant("test('runs', () => {});");
    expect(noDist('plant.test.ts').status).toBe(0);
    expect(existsSync(aside())).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'restores what it already moved when a later rename fails, and says so',
    () => {
      addPackage('q');
      // `a` sorts before `p`: it is hidden first, then the rename of p's dist fails.
      addPackage('a');
      chmodSync(join(root, 'packages', 'p'), 0o555);
      const run = noDist('plant.test.ts');
      chmodSync(join(root, 'packages', 'p'), 0o755);
      expect(run.status).toBe(2);
      expect(text(run)).toMatch(/EACCES|EPERM/);
      for (const pkg of ['a', 'p', 'q']) expect(existsSync(dist(pkg))).toBe(true);
      expect(existsSync(aside())).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names a build it could not put back when hiding failed and the put-back failed too',
    () => {
      addPackage('a');
      // p's dist cannot be renamed (its folder is read-only), and the put-back of a's is made to fail as well.
      chmodSync(join(root, 'packages', 'p'), 0o555);
      const hook = join(root, 'fail-restore.cjs');
      writeFileSync(
        hook,
        `const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('packages/a/dist')) throw Object.assign(new Error('injected'), { code: 'EIO' });
  return rename(from, to);
};
`,
      );
      const run = spawnSync(process.execPath, [SCRIPT, '--globals', 'plant.test.ts'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...env(), NODE_OPTIONS: `--require ${hook}` },
      });
      chmodSync(join(root, 'packages', 'p'), 0o755);
      expect(run.status).toBe(2);
      expect(text(run)).toMatch(/EACCES|EPERM/);
      expect(text(run)).toMatch(/could not restore dist for a \(EIO/);
      expect(existsSync(hiddenDist('a'))).toBe(true);
      // The next run, with nothing failing, puts it back.
      expect(restoreOnly().status).toBe(0);
      expect(existsSync(dist('a'))).toBe(true);
    },
  );

  it('ignores litter in a hidden package folder and never removes a build there', () => {
    // A Finder file beside a build that goes back, and beside nothing at all.
    leaveHidden();
    writeFileSync(join(aside(), 'hidden', 'p', '.DS_Store'), 'x');
    mkdirSync(join(aside(), 'hidden', 'q'), { recursive: true });
    writeFileSync(join(aside(), 'hidden', 'q', '.DS_Store'), 'x');
    const run = restoreOnly();
    expect(text(run)).not.toMatch(/could not restore/);
    expect(run.status).toBe(0);
    expect(readFileSync(dist(), 'utf8')).toBe(BUILT);
    expect(existsSync(aside())).toBe(false);
  });

  it('refuses --restore with another argument', () => {
    const run = sync(SCRIPT, ['--restore', '--globals']);
    expect(run.status).toBe(2);
    expect(existsSync(aside())).toBe(false);
  });

  // The holder must have started more than ten minutes after the lock was written, which needs a machine up for a while
  // (a fresh CI runner is not).
  it.skipIf(os.uptime() < 7200)(
    'takes a lock whose process id was reused after it was written',
    () => {
      mkdirSync(aside(), { recursive: true });
      const lock = join(aside(), 'lock');
      plant("test('runs', () => {});");
      writeFileSync(lock, String(process.ppid));
      const afterBoot = new Date(Date.now() - os.uptime() * 1000 + 500);
      utimesSync(lock, afterBoot, afterBoot);
      expect(noDist('plant.test.ts').status).toBe(0);
    },
  );

  it('takes a lock of a live process id that is older than the last boot', () => {
    mkdirSync(aside(), { recursive: true });
    const lock = join(aside(), 'lock');
    writeFileSync(lock, String(process.ppid));
    const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 60000);
    utimesSync(lock, beforeBoot, beforeBoot);
    expect(restoreOnly().status).toBe(0);
    expect(existsSync(aside())).toBe(false);
  });

  it('lets only one of two runs started together take a stale lock', async () => {
    plant(SLOW);
    mkdirSync(aside(), { recursive: true });
    writeFileSync(join(aside(), 'lock'), '2147483646');
    const start = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, '--globals', 'plant.test.ts'], {
          cwd: root,
          env: env(),
          stdio: 'ignore',
        });
        child.on('close', (code) => resolve(code));
      });
    const codes = (await Promise.all([start(), start()])).sort();
    expect(codes).toEqual([0, 2]);
    expect(existsSync(dist())).toBe(true);
  }, 90000);

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'restores the dist when a %s stops it mid-run',
    async (signal) => {
      plant(HANG);
      const child = spawn(process.execPath, [SCRIPT, '--globals', 'plant.test.ts'], {
        cwd: root,
        env: env(),
        stdio: 'ignore',
      });
      try {
        const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
        const deadline = Date.now() + 30000;
        // The marker is written by the test inside vitest, so the signal lands while the run is going.
        while (!existsSync(join(root, 'started')) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(existsSync(join(root, 'started'))).toBe(true);
        expect(existsSync(dist())).toBe(false);
        child.kill(signal);
        await Promise.race([closed, new Promise((r) => setTimeout(r, 30000))]);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        expect(readFileSync(dist(), 'utf8')).toBe(BUILT);
        expect(existsSync(aside())).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    },
    90000,
  );
});
