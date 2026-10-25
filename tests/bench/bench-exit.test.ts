import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A bench process ends when its work is done. Each harness is run with a stray handle planted in the process that holds
 * the event loop open, as a helper that was never stopped would: the count bench through `--check` (every cell once at a
 * tiny scale, timing nothing) and the paired harness through `--gate` (it reads the committed record; its `--check` needs
 * the built package, which the unit tests run before). The run must still end by itself within a bound, with the status
 * the harness chose.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOLD = join(ROOT, 'tests', 'bench', 'fixtures', 'hold-event-loop.cjs');
const BOUND_MS = 150_000;

/** Runs `node --expose-gc <script> --check` with the stray handle; resolves with how it ended, killing it at the bound. */
function run(
  script: string,
  flag: string,
): Promise<{ code: number | null; hung: boolean; out: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--expose-gc', '--require', HOLD, join(ROOT, 'bench', script), flag],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, BOUND_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, hung, out });
    });
  });
}

describe('a bench process outlives neither its work nor a stray handle', () => {
  it.each([
    ['count-kernels.cjs', '--check', 'count-kernels --check: ok'],
    ['ts-codec-paired.cjs', '--gate', 'every pass is clear'],
  ])(
    '%s ends by itself after %s',
    async (script, flag, ok) => {
      const result = await run(script, flag);
      expect(result.hung, `${script} was still running after ${BOUND_MS} ms`).toBe(false);
      expect(result.out).toContain(ok);
      expect(result.code).toBe(0);
    },
    BOUND_MS + 10_000,
  );
});
