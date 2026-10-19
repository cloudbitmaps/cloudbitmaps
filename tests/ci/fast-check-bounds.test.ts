import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach } from 'vitest';
import { seedWriter } from '../helpers/fast-check-run';

/**
 * Every property is bounded in time and names its seed before it runs (`tests/setup-fast-check.ts`).
 *
 * WHY THIS EXISTS. A property whose awaits all resolve as microtasks starves the event loop. Vitest's test timeout
 * is a `setTimeout`, so it never fires, and fast-check prints a seed only on a failure: a full-strength CI job hung
 * for 22 minutes with no seed in its log until the job limit cancelled it. The setup gives each test's properties a
 * time limit of 0.8 of the test's own timeout, which fails with the seed, and writes the seed line before the first
 * run through a path a starved worker still has.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** A property whose runs each hold the event loop for 50 ms and resolve as microtasks only. */
const slowProperty = () =>
  fc.asyncProperty(fc.integer(), async () => {
    const until = Date.now() + 50;
    while (Date.now() < until) {
      /* hold the loop */
    }
    await Promise.resolve();
  });

describe('a property that overruns its limit', () => {
  it('fails naming its seed before the test timeout', { timeout: 1500 }, async () => {
    const started = Date.now();
    const seed = fc.readConfigureGlobal().seed;
    await expect(fc.assert(slowProperty(), { numRuns: 1000 })).rejects.toThrow(
      new RegExp(`Property interrupted after \\d+ tests[\\s\\S]*seed: ${seed}`),
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it(
    'passes silently without markInterruptAsFailure, which is why the setup sets it',
    { timeout: 1500 },
    async () => {
      await expect(
        fc.assert(slowProperty(), { numRuns: 1000, markInterruptAsFailure: false }),
      ).resolves.toBeUndefined();
    },
  );
});

describe('the limit is 0.8 of the test timeout', () => {
  it('is 4000 for a 5 s timeout', { timeout: 5_000 }, () => {
    expect(fc.readConfigureGlobal().interruptAfterTimeLimit).toBe(4_000);
    expect(fc.readConfigureGlobal().markInterruptAsFailure).toBe(true);
  });

  it('is 240000 for a 300 s timeout', { timeout: 300_000 }, () => {
    expect(fc.readConfigureGlobal().interruptAfterTimeLimit).toBe(240_000);
  });

  it('is absent for a timeout of 0', { timeout: 0 }, () => {
    expect(fc.readConfigureGlobal().interruptAfterTimeLimit).toBeUndefined();
    expect(fc.readConfigureGlobal().markInterruptAsFailure).toBeUndefined();
  });
});

describe('the seed line', () => {
  const lines: string[] = [];
  const original = seedWriter.write;
  beforeEach(() => {
    lines.length = 0;
    seedWriter.write = (line) => {
      lines.push(line);
    };
  });
  afterEach(() => {
    seedWriter.write = original;
  });

  it("is written before the first run, with that run's seed, once per test", async (ctx) => {
    let atFirstRun: { count: number; seed: number | undefined } | undefined;
    await fc.assert(
      fc.property(fc.integer(), () => {
        atFirstRun ??= { count: lines.length, seed: fc.readConfigureGlobal().seed };
      }),
      { numRuns: 3 },
    );
    expect(atFirstRun?.count).toBe(1);
    expect(lines[0]).toContain(`fast-check seed ${atFirstRun?.seed}: `);
    expect(lines[0]).toContain(ctx.task.fullName);
    expect(lines[0]).toContain(`FC_SEED=${atFirstRun?.seed} `);

    fc.assert(
      fc.property(fc.integer(), () => true),
      { numRuns: 3 },
    );
    expect(lines).toHaveLength(1);
  });

  it('is not written by a test with no property', () => {
    expect(lines).toEqual([]);
  });
});

describe('a run that never returns', () => {
  it('still leaves its seed in the output', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-hang-'));
    const note = join(dir, 'note.json');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('VITEST') && k !== 'FC_SEED') env[k] = v;
    }
    env.HANG_FIXTURE_OUT = note;
    const child = spawn(
      process.execPath,
      [
        resolve(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'tests/fixtures/hang/vitest.hang.config.ts',
        '--maxWorkers=1',
      ],
      { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const spinning = (): boolean =>
      existsSync(note) &&
      (JSON.parse(readFileSync(note, 'utf8')) as { state: string }).state === 'spinning';
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !(spinning() && /fast-check seed -?\d+/.test(output))) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(spinning(), 'the fixture never reached its hanging run').toBe(true);
      // Let the hung worker go on spinning for a moment, as CI's did, then end its whole process group.
      await new Promise((r) => setTimeout(r, 2_000));
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    const seed = (JSON.parse(readFileSync(note, 'utf8')) as { seed: number }).seed;
    rmSync(dir, { recursive: true, force: true });
    expect(output).toMatch(/fast-check seed -?\d+/);
    expect(output).toContain(`fast-check seed ${seed}: `);
  });
});
