import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '@/index';
import { answerArgs, parseConfig, USAGE } from '@/bin/export-segments';

const BIN = fileURLToPath(
  new URL('../../packages/roaring/dist/bin/export-segments.js', import.meta.url),
);

// The spawned tests run the built bin, so they run only when CB_REQUIRE_BUILT_BIN=1: a dist left over from an older
// build can never turn `pnpm test` red. CI sets it in the step that follows the build, where a missing bin fails.
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
    it.each([
      ['--', '--help'],
      ['--', '-h'],
    ])('drops a leading -- that pnpm forwards: %j', (...args) => {
      expect(answerArgs(args)).toEqual({ stream: 'stdout', text: USAGE, code: 0 });
    });
    it('lets a lone -- proceed, and refuses an argument after it', () => {
      expect(answerArgs(['--'])).toBeUndefined();
      expect(answerArgs(['--', './dump'])?.code).toBe(2);
      expect(answerArgs(['--', '--', '--help'])?.code).toBe(2);
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

  describe('a CR_EXPORT_ variable it does not read', () => {
    it('is refused by name, with the ones it takes, so a misspelt namespace does not export every namespace', () => {
      const env = { CR_EXPORT_ROOT: '/r', CR_EXPORT_OUT: '/o', CR_EXPORT_NAMSPACE: 'tenant-a' };
      expect(() => parseConfig(env)).toThrow(ValidationError);
      expect(() => parseConfig(env)).toThrow(
        'CR_EXPORT_NAMSPACE is not a setting export-segments takes. It takes CR_EXPORT_ROOT, CR_EXPORT_OUT, CR_EXPORT_FORMAT, CR_EXPORT_NAMESPACE; run export-segments --help',
      );
    });
    it('names each when there are several, and ignores other variables', () => {
      expect(() =>
        parseConfig({
          CR_EXPORT_ROOT: '/r',
          CR_EXPORT_OUT: '/o',
          CR_EXPORT_A: '1',
          CR_EXPORT_B: '2',
        }),
      ).toThrow('CR_EXPORT_A, CR_EXPORT_B are not settings export-segments takes.');
      expect(
        parseConfig({ CR_EXPORT_ROOT: '/r', CR_EXPORT_OUT: '/o', CR_OTHER: 'x', HOME: '/h' }),
      ).toMatchObject({
        root: '/r',
        out: '/o',
      });
    });
  });

  describe('a missing required variable', () => {
    const messageOf = (env: Record<string, string>): string => {
      try {
        parseConfig(env);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    };
    it('says what CR_EXPORT_ROOT is, names the other variable and points at --help', () => {
      for (const env of [{}, { CR_EXPORT_OUT: '/o' }] as Array<Record<string, string>>) {
        expect(messageOf(env)).toBe(
          "CR_EXPORT_ROOT is not set: the directory that holds the store's storage/ and registry/. " +
            'export-segments also needs CR_EXPORT_OUT; run export-segments --help',
        );
      }
    });
    it('says what CR_EXPORT_OUT is, names the other variable and points at --help', () => {
      expect(messageOf({ CR_EXPORT_ROOT: '/x' })).toBe(
        'CR_EXPORT_OUT is not set: the directory to write the dump to. ' +
          'export-segments also needs CR_EXPORT_ROOT; run export-segments --help',
      );
    });
  });

  describe.runIf(required)('the built bin', () => {
    it('is present', () => {
      expect(existsSync(BIN)).toBe(true);
    });
    it.each([['--help'], ['-h']])('prints the usage and exits 0 for %s', (flag) => {
      const r = run([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(USAGE);
      expect(r.stderr).toBe('');
    });
    it('prints the usage and exits 0 for the -- that pnpm forwards before --help', () => {
      const r = run(['--', '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(USAGE);
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
