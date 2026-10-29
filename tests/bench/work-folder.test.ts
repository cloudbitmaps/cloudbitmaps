import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The temp folders a bench makes (`bench/lib/work-folder.cjs`) are gone however the process ends: it returns, throws,
 * exits, is stopped by SIGINT or SIGTERM while it sits in a synchronous call, or is killed.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(ROOT, 'bench', 'lib', 'work-folder.cjs');
const SENTINEL = join(ROOT, 'bench', 'lib', 'work-folder-sentinel.cjs');
const PREFIX = 'work-folder-test-';

/** Every child a test starts, killed after the test whatever its outcome (a waiting child holds its sentinel too). */
const children: ChildProcess[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder of the test's own, removed after it. */
function own(prefix = 'work-folder-own-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/**
 * Runs `body` (it has `w`, the helper, and `dir`, the first made folder) in a fresh process that prints each folder it
 * makes on a line. `line(n)` resolves with the n-th printed line and rejects if the child ends first or 20 s pass.
 */
function start(body: string, lib = LIB) {
  const code = `const w = require(${JSON.stringify(lib)}); const dir = w.make(require('node:os').tmpdir(), ${JSON.stringify(PREFIX)}); console.log(dir); ${body}`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  const ended = new Promise<number | null>((ok) => child.on('close', (c) => ok(c)));
  const waiters: (() => void)[] = [];
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    for (const w of waiters) w();
  });
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const line = (n: number) =>
    new Promise<string>((ok, no) => {
      const timer = setTimeout(() => no(new Error('no such line printed in time')), 20_000);
      const check = () => {
        const done = out.split('\n').slice(0, -1);
        if (done.length > n) {
          clearTimeout(timer);
          ok(done[n] ?? '');
        }
      };
      waiters.push(check);
      void ended.then(() => {
        check();
        clearTimeout(timer);
        no(new Error('the child ended before printing that line'));
      });
      check();
    });
  return { child, ready: line(0), line, ended, stderr: () => err };
}

async function gone(dir: string, ms = 15_000) {
  const until = Date.now() + ms;
  while (existsSync(dir) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !existsSync(dir);
}

/** A synchronous wait that ends by itself after a minute, so a child nobody killed does not live on. */
const HOLD = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);';

describe('a bench’s temp folder is removed on every way out', () => {
  it('after a run that returns', async () => {
    const run = start('');
    const dir = await run.ready;
    expect(dir.startsWith(join(tmpdir(), PREFIX))).toBe(true);
    await run.ended;
    expect(await gone(dir)).toBe(true);
  });

  it('after a run that throws', async () => {
    const run = start(
      "require('node:fs').writeFileSync(require('node:path').join(dir, 'f'), 'x'); throw new Error('boom');",
    );
    const dir = await run.ready;
    await run.ended;
    expect(await gone(dir)).toBe(true);
  });

  it('after process.exit', async () => {
    const run = start('process.exit(3);');
    const dir = await run.ready;
    await run.ended;
    expect(await gone(dir)).toBe(true);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGKILL'] as const)(
    'after %s while the run is inside a synchronous call',
    async (signal) => {
      const run = start(HOLD);
      const dir = await run.ready;
      expect(existsSync(dir)).toBe(true);
      run.child.kill(signal);
      await run.ended;
      expect(await gone(dir)).toBe(true);
    },
  );

  it('removes every folder a process made, and only those', async () => {
    const run = start(
      `const second = w.make(require('node:os').tmpdir(), ${JSON.stringify(PREFIX)}); console.log(second); ${HOLD}`,
    );
    const first = await run.line(0);
    const second = await run.line(1);
    expect(second).not.toBe(first);
    // A folder of the same prefix that this process did not make.
    const stranger = own(PREFIX);
    run.child.kill('SIGKILL');
    await run.ended;
    expect(await gone(first)).toBe(true);
    expect(await gone(second)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
  });

  it('says on stderr which folder is left behind when the sentinel is not there, and carries on', async () => {
    // The helper copied alone, as a stage that did not copy the rest of `bench/` would have it.
    const lone = own('work-folder-lone-');
    const copy = join(lone, 'work-folder.cjs');
    copyFileSync(LIB, copy);
    const run = start('setTimeout(() => process.exit(0), 1500);', copy);
    const dir = await run.ready;
    const code = await run.ended;
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    const lines = run
      .stderr()
      .split('\n')
      .filter((l) => l.includes(dir));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^work folder cleanup is not running \(.+\); left behind if this process stops: /,
    );
  });

  it('names a folder made after the failure is known, too', async () => {
    const lone = own('work-folder-lone-');
    const copy = join(lone, 'work-folder.cjs');
    copyFileSync(LIB, copy);
    const run = start(
      `setTimeout(() => { console.log(w.make(require('node:os').tmpdir(), ${JSON.stringify(PREFIX)})); setTimeout(() => process.exit(0), 300); }, 1500);`,
      copy,
    );
    const first = await run.line(0);
    const second = await run.line(1);
    await run.ended;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    const err = run.stderr();
    expect(err.split('\n').filter((l) => l.includes(first))).toHaveLength(1);
    expect(err.split('\n').filter((l) => l.includes(second))).toHaveLength(1);
  });

  it('stays quiet on stderr when the sentinel works', async () => {
    const run = start('setTimeout(() => process.exit(0), 700);');
    await run.ready;
    await run.ended;
    expect(run.stderr()).toBe('');
  });
});

describe('the sentinel removes only what it may', () => {
  it('refuses a relative path and a name without a six-character suffix, removes a good one, and ends with its input', async () => {
    const base = own('sentinel-test-');
    const names = {
      good: join(base, 'x-AbCdE1'),
      noSuffix: join(base, 'plain'),
      short: join(base, 'x-abc12'),
      long: join(base, 'x-abcdefg'),
      symbol: join(base, 'x-ab_def'),
    };
    for (const d of Object.values(names)) mkdirSync(d);
    mkdirSync(join(base, 'rel-AbCdE1'));
    const child = spawn(process.execPath, [SENTINEL], {
      cwd: base,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.push(child);
    const closed = new Promise<void>((ok) => child.on('close', () => ok()));
    child.stdin.end([...Object.values(names), 'rel-AbCdE1', '/x-AbCdE1', ''].join('\n'));
    await Promise.race([
      closed,
      new Promise((_, no) => setTimeout(() => no(new Error('the sentinel did not end')), 15_000)),
    ]);
    expect(existsSync(names.good)).toBe(false);
    for (const [name, d] of Object.entries(names)) {
      if (name !== 'good') expect(existsSync(d), name).toBe(true);
    }
    expect(statSync(join(base, 'rel-AbCdE1')).isDirectory()).toBe(true);
  });
});

/** The pattern a direct temp-folder call is found by: the call itself, in code (comments and strings blanked first). */
const DIRECT_CALL = /\bmkdtemp(?:Sync)?\s*\(/;
const NOT_CODE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
const HELPER = 'bench/lib/work-folder.cjs';
const callsDirectly = (source: string) => DIRECT_CALL.test(source.replace(NOT_CODE, ''));

function benchSources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : benchSources(rel);
    return /\.(cjs|mjs|js)$/.test(e.name) ? [rel] : [];
  });
}

describe('every bench that makes a temp folder makes it through the helper', () => {
  it('has no direct mkdtemp call outside the helper, in any script under bench/', () => {
    const files = benchSources('bench');
    expect(files).toContain(HELPER);
    expect(
      files.filter((f) => f !== HELPER && callsDirectly(readFileSync(join(ROOT, f), 'utf8'))),
    ).toEqual([]);
  });

  it('fires on a direct call in each form, and is quiet on the look-alikes', () => {
    expect(callsDirectly("fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))")).toBe(true);
    expect(callsDirectly("fs.promises.mkdtemp(path.join(os.tmpdir(), 'x-'))")).toBe(true);
    expect(callsDirectly("const { mkdtempSync } = require('node:fs'); mkdtempSync (p)")).toBe(true);
    expect(callsDirectly("workFolder.make(os.tmpdir(), 'x-')")).toBe(false);
    expect(callsDirectly('// a note that mkdtempSync(x) is not called here\nconst a = 1;')).toBe(
      false,
    );
    expect(callsDirectly('/* mkdtemp(\n) */ const a = 1;')).toBe(false);
    expect(callsDirectly('const s = \'mkdtempSync(x)\'; const t = "mkdtemp(y)";')).toBe(false);
    // The helper itself holds the one real call, which is why it alone is exempt.
    expect(callsDirectly(readFileSync(LIB, 'utf8'))).toBe(true);
    expect(relative(ROOT, LIB).split('\\').join('/')).toBe(HELPER);
  });
});
