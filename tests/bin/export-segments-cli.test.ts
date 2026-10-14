import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { answerArgs, parseConfig, USAGE } from '@/bin/export-segments';

const BIN = fileURLToPath(
  new URL('../../packages/roaring/dist/bin/export-segments.js', import.meta.url),
);

// The spawned tests run the built bin. CI runs the tests before the build, so there the file is absent and they are
// skipped; the step that follows the build sets CB_REQUIRE_BUILT_BIN=1, which makes a missing bin a failure.
const required = process.env.CB_REQUIRE_BUILT_BIN === '1';

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });

describe('export-segments command line', () => {
  describe('answerArgs', () => {
    it('lets a run with no arguments proceed', () => {
      expect(answerArgs([])).toBeUndefined();
    });
    it.each([['--help'], ['-h']])('answers %s with the usage on stdout and code 0', (flag) => {
      expect(answerArgs([flag])).toEqual({ stream: 'stdout', text: USAGE, code: 0 });
    });
    it.each([[['./dump']], [['--help', 'extra']], [['--version']]])(
      'refuses %j on stderr with code 2',
      (args) => {
        const answer = answerArgs(args);
        expect(answer?.stream).toBe('stderr');
        expect(answer?.code).toBe(2);
        expect(answer?.text).toContain(
          'takes no arguments; it reads its settings from the environment',
        );
        expect(answer?.text).toContain(USAGE);
      },
    );
    it('names every setting, marks the required ones and shows an example', () => {
      for (const name of [
        'CR_EXPORT_ROOT',
        'CR_EXPORT_OUT',
        'CR_EXPORT_FORMAT',
        'CR_EXPORT_NAMESPACE',
      ]) {
        expect(USAGE).toContain(name);
      }
      expect(USAGE).toMatch(/CR_EXPORT_ROOT\s+\(required\)/);
      expect(USAGE).toMatch(/CR_EXPORT_OUT\s+\(required\)/);
      expect(USAGE).toMatch(/CR_EXPORT_NAMESPACE\s+\(optional\)/);
    });
  });

  describe('a missing required variable', () => {
    it.each([[{}], [{ CR_EXPORT_ROOT: '/x' }]])(
      'names both required variables and the help for %j',
      (env) => {
        let message = '';
        try {
          parseConfig(env);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toContain('CR_EXPORT_ROOT');
        expect(message).toContain('CR_EXPORT_OUT');
        expect(message.endsWith('run export-segments --help')).toBe(true);
      },
    );
  });

  describe.skipIf(!required && !existsSync(BIN))('the built bin', () => {
    it('is present', () => {
      expect(existsSync(BIN)).toBe(true);
    });
    it.each([['--help'], ['-h']])('prints the usage and exits 0 for %s', (flag) => {
      const r = run([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(USAGE);
      expect(r.stderr).toBe('');
    });
    it('exits 2 with the usage on stderr for a stray argument', () => {
      const r = run(['./dump'], { CR_EXPORT_ROOT: '/x', CR_EXPORT_OUT: '/o' });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('takes no arguments; it reads its settings from the environment');
      expect(r.stderr).toContain('CR_EXPORT_NAMESPACE');
    });
    it('exits 1 naming both required variables with an empty environment', () => {
      const r = run([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('CR_EXPORT_ROOT');
      expect(r.stderr).toContain('CR_EXPORT_OUT');
      expect(r.stderr.trimEnd().endsWith('run export-segments --help')).toBe(true);
    });
  });
});
