import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, onTestFinished } from 'vitest';
import { seedLine, seedWriter } from '../helpers/fast-check-run';
import { FULL_STRENGTH_ASSIGNMENT } from '../helpers/strength';

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

describe('a property that overruns a time limit', () => {
  // The limit is passed here, in place of the setup's 0.8 of the test's timeout: a test that runs until that limit uses
  // 80 % of its budget whatever the budget is, so it would sit above the half a test may use. So these two prove that
  // fast-check's own time limit cuts a runaway property and, with the setup's `markInterruptAsFailure` and seed, fails
  // it naming the seed (or, with that option off, passes it silently). That the setup sets the limit to 0.8 of the
  // test's timeout is held by the three config reads below, and the run under 'the setup's own limit' proves that limit
  // cuts a property inside a real test; the child-process run under 'a run that never returns' holds the seed line.
  const LIMIT = 1000;

  it('fails naming its seed when its time limit cuts it', async () => {
    const started = Date.now();
    const seed = fc.readConfigureGlobal().seed;
    await expect(
      fc.assert(slowProperty(), { numRuns: 1000, interruptAfterTimeLimit: LIMIT }),
    ).rejects.toThrow(new RegExp(`Property interrupted after \\d+ tests[\\s\\S]*seed: ${seed}`));
    // Cut near the limit, not run to its 1000 runs (50 s) or to the test timeout.
    expect(Date.now() - started).toBeLessThan(3 * LIMIT);
  });

  it('passes silently without markInterruptAsFailure, which is why the setup sets it', async () => {
    await expect(
      fc.assert(slowProperty(), {
        numRuns: 1000,
        markInterruptAsFailure: false,
        interruptAfterTimeLimit: LIMIT,
      }),
    ).resolves.toBeUndefined();
  });
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

describe("the setup's own limit", () => {
  it.skipIf(process.platform === 'win32')(
    'cuts a property that never fails before the test timeout, naming its seed',
    // Budget: the child run takes about 1.5 s (vitest start-up plus the fixture's 0.8 s), measured on a laptop; 30 s is
    // about twenty times that, for a slow runner.
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cbm-cut-'));
      const note = join(dir, 'note.json');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('VITEST') && k !== 'FC_SEED') env[k] = v;
      }
      delete env.FORCE_COLOR;
      env.NO_COLOR = '1';
      env.CUT_FIXTURE_OUT = note;
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'tests/fixtures/cut/vitest.cut.config.ts',
          '--maxWorkers=1',
        ],
        { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      // A hard kill timer, so a child that never ends cannot outlive this test.
      const killer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 25_000);
      const code = await new Promise<number | null>((done) => child.on('close', done));
      clearTimeout(killer);
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      expect(code, output).toBe(1);
      // fast-check's interrupt with the seed, not vitest's own timeout.
      expect(output).toMatch(/Property interrupted after \d+ tests[\s\S]*seed: -?\d+/);
      expect(output).not.toMatch(/timed out/i);
      // Read last: a child cut by vitest's timeout leaves no note, and the checks above name why.
      const { elapsed } = JSON.parse(readFileSync(note, 'utf8')) as { elapsed: number };
      // Ended inside the fixture's 1 s test timeout, near the 0.8 s limit.
      expect(elapsed).toBeLessThan(1_000);
      expect(elapsed).toBeGreaterThanOrEqual(700);
    },
  );
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
  it.skipIf(process.platform === 'win32')(
    'still leaves its seed in the output',
    { timeout: 60_000 },
    async () => {
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
    },
  );
});

describe('the replay line', () => {
  it('carries the strength, the project and the test name it came from', () => {
    const task = {
      name: "a (b) 'c'",
      fullName: "f > a (b) 'c'",
      file: 'tests/x.test.ts',
      project: 'sorted',
    };
    expect(seedLine(task, 7, true)).toContain(
      `replay: ${FULL_STRENGTH_ASSIGNMENT} FC_SEED=7 pnpm vitest run --project sorted tests/x.test.ts -t 'a \\(b\\) '\\''c'\\'''`,
    );
    expect(seedLine(task, 7, false)).not.toContain(FULL_STRENGTH_ASSIGNMENT);
  });

  /** Runs vitest on a file the way the line says, or as given, and returns what it printed. */
  const run = (command: string): Promise<string> =>
    new Promise((resolveOutput) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('VITEST') && k !== 'FC_SEED') env[k] = v;
      }
      delete env.FORCE_COLOR;
      env.NO_COLOR = '1';
      const child = spawn('sh', ['-c', command], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      child.on('close', () => resolveOutput(output));
    });

  it.skipIf(process.platform === 'win32')(
    'run as written, draws the seed it names',
    { timeout: 120_000 },
    async () => {
      const first = await run(
        'pnpm vitest run --project ids --maxWorkers=1 tests/core/kept-window.test.ts',
      );
      const line =
        /^fast-check seed (-?\d+): .*\(unless a call pins its own; replay: (.*)\)$/m.exec(first);
      expect(line, first).not.toBeNull();
      const [, seed, command] = line as RegExpExecArray;
      expect(command).toContain('--project ids ');
      expect(command).toContain(`FC_SEED=${seed} `);
      expect(command).toContain("-t 'splits what it is given in two");

      const replayed = await run(command as string);
      expect(replayed).toContain(`fast-check seed ${seed}: `);
      expect(replayed).toMatch(/Tests\s+1 passed/);
    },
  );
});
