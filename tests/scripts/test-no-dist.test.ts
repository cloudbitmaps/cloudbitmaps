import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/test-no-dist.cjs', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

const PLANT = `
test('the built entry is reachable', async () => {
  const built = await import('./packages/p/dist/index.js');
  expect(built.answer).toBe(42);
});
`;
const HANG = `
test('runs until it is stopped', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60000));
}, 120000);
`;

let root: string;
const dist = () => join(root, 'packages', 'p', 'dist', 'index.js');

const plant = (source: string) => writeFileSync(join(root, 'plant.test.ts'), source);
const env = () => ({ PATH: process.env.PATH ?? '', CB_NO_DIST_ROOT: root });
const plain = (...args: string[]) =>
  spawnSync(process.execPath, [VITEST, 'run', '--globals', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: env(),
  });
const noDist = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, '--globals', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: env(),
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'no-dist-'));
  mkdirSync(join(root, 'packages', 'p', 'dist'), { recursive: true });
  writeFileSync(join(root, 'packages', 'p', 'package.json'), '{"name":"p","type":"module"}');
  writeFileSync(dist(), 'export const answer = 42;\n');
  plant(PLANT);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pnpm test:no-dist', () => {
  it('passes a test that imports a built entry on a plain run and fails it with the dist hidden', () => {
    expect(plain('plant.test.ts').status).toBe(0);
    const hidden = noDist('plant.test.ts');
    expect(hidden.status).toBe(1);
    expect(hidden.stdout + hidden.stderr).toMatch(/dist\/index\.js/);
  });

  it('restores every dist after a failing run and after a passing one', () => {
    expect(noDist('plant.test.ts').status).toBe(1);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(join(root, 'node_modules', '.no-dist-aside'))).toBe(false);

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

  it('puts back a dist a killed run left hidden, before the next run', () => {
    // The state a SIGKILL leaves: the dist is under the aside folder and the lock names a process that is gone.
    const aside = join(root, 'node_modules', '.no-dist-aside');
    mkdirSync(aside, { recursive: true });
    spawnSync('mv', [join(root, 'packages', 'p', 'dist'), join(aside, 'p')]);
    writeFileSync(join(aside, 'lock'), '2147483646');
    expect(existsSync(dist())).toBe(false);

    expect(noDist('--help').status).toBe(0);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(aside)).toBe(false);
  });

  it('puts back a hidden dist on --restore alone, and keeps a newer build over an older hidden copy', () => {
    const aside = join(root, 'node_modules', '.no-dist-aside');
    mkdirSync(join(aside, 'p'), { recursive: true });
    writeFileSync(join(aside, 'p', 'index.js'), 'export const answer = 0;\n');
    const run = spawnSync(process.execPath, [SCRIPT, '--restore'], {
      encoding: 'utf8',
      env: env(),
    });
    expect(run.status).toBe(0);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(aside)).toBe(false);
  });

  it('refuses to start while another run holds the dist folders', () => {
    const aside = join(root, 'node_modules', '.no-dist-aside');
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, 'lock'), String(process.ppid));
    const run = noDist('plant.test.ts');
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/another no-dist run/);
    expect(existsSync(dist())).toBe(true);
  });

  it('restores the dist when it is interrupted mid-run', async () => {
    plant(HANG);
    const child = spawn(process.execPath, [SCRIPT, '--globals', 'plant.test.ts'], {
      cwd: root,
      env: env(),
      stdio: 'ignore',
    });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    const aside = join(root, 'node_modules', '.no-dist-aside', 'p');
    const deadline = Date.now() + 20000;
    while (!existsSync(aside) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(aside)).toBe(true);
    expect(existsSync(dist())).toBe(false);
    child.kill('SIGINT');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 20000))]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(readFileSync(dist(), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(join(root, 'node_modules', '.no-dist-aside'))).toBe(false);
  }, 60000);
});
