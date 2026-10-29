import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The temp folders a bench makes (`bench/lib/work-folder.cjs`) are gone however the process ends: it returns, throws,
 * exits, is stopped by SIGINT or SIGTERM while it sits in a synchronous call, or is killed.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(ROOT, 'bench', 'lib', 'work-folder.cjs');
const PREFIX = 'work-folder-test-';

/** Runs `body` (it has `dir`, the made folder) in a fresh process; resolves with the folder and the child once `dir` is printed. */
function start(body: string) {
  const code = `const w = require(${JSON.stringify(LIB)}); const dir = w.make(require('node:os').tmpdir(), ${JSON.stringify(PREFIX)}); console.log(dir); ${body}`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  const ready = new Promise<string>((ok) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('\n')) ok(out.split('\n')[0] ?? '');
    });
  });
  const ended = new Promise<void>((ok) => child.on('close', () => ok()));
  return { child, ready, ended };
}

async function gone(dir: string, ms = 15_000) {
  const until = Date.now() + ms;
  while (existsSync(dir) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !existsSync(dir);
}

const HOLD = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';

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
    const first = await run.ready;
    const text = await new Promise<string>((ok) => {
      const poll = setInterval(() => {
        const found = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
        if (found.length >= 2) {
          clearInterval(poll);
          ok(found.join('\n'));
        }
      }, 25);
    });
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2);
    run.child.kill('SIGKILL');
    await run.ended;
    expect(await gone(first)).toBe(true);
  });
});

describe('every bench that makes a temp folder makes it through the helper', () => {
  const files = [
    ...readdirSync(join(ROOT, 'bench'))
      .filter((n) => n.endsWith('.cjs'))
      .map((n) => join('bench', n)),
    ...readdirSync(join(ROOT, 'bench', 'lib'))
      .filter((n) => n.endsWith('.cjs'))
      .map((n) => join('bench', 'lib', n)),
  ];

  it('has no direct mkdtemp call outside the helper', () => {
    const direct = files.filter(
      (f) =>
        !f.endsWith('work-folder.cjs') &&
        /\bmkdtemp(Sync)?\b/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(direct).toEqual([]);
  });

  it('is found to fire on a direct call and quiet on the helper', () => {
    const fires = (s: string) => /\bmkdtemp(Sync)?\b/.test(s);
    expect(fires("fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))")).toBe(true);
    expect(fires("workFolder.make(os.tmpdir(), 'x-')")).toBe(false);
  });
});
