import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm site:figures` holds the benchmarks page to bench/results.json. Its money anchors have a backstop — a dollar
 * figure no source accounts for fails on its own — but the reference set's cluster and the crossover against it are
 * not money, so only their anchors hold them. This runs the script in-process over the real tree with the page
 * changed, and expects it to fail.
 */
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SCRIPT = join(ROOT, 'scripts', 'site-figures.cjs');
const requireFromScript = createRequire(SCRIPT);
const PAGE = 'site/benchmarks.html';

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function siteFigures(files: Record<string, string> = {}): { code: number; out: string } {
  const realFs = requireFromScript('node:fs') as typeof import('node:fs');
  const rel = (p: unknown): string => relative(ROOT, String(p));
  const fs = {
    ...realFs,
    readFileSync: (p: string, ...rest: unknown[]) =>
      rel(p) in files
        ? files[rel(p)]
        : (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
  const lines: string[] = [];
  const log = (...a: unknown[]): void => {
    lines.push(a.join(' '));
  };
  const proc = {
    argv: ['node', SCRIPT],
    exit: (code: number): never => {
      throw new Exit(code);
    },
  };
  const source = readFileSync(SCRIPT, 'utf8').replace(/^#!.*\n/, '');
  try {
    new Function('require', '__dirname', 'process', 'console', source)(
      (id: string) => (id === 'node:fs' ? fs : requireFromScript(id)),
      dirname(SCRIPT),
      proc,
      { log, error: log, warn: log },
    );
    return { code: 0, out: lines.join('\n') };
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, out: lines.join('\n') };
    throw e;
  }
}

describe("site:figures holds the reference set's Redis to bench/results.json", () => {
  const html = readFileSync(join(ROOT, PAGE), 'utf8');

  it('passes the page as committed', () => {
    const r = siteFigures();
    expect(r.code, r.out).toBe(0);
  });

  it.each([
    ['its cluster', '3 × cache.t4g.medium', '3 × cache.t4g.small'],
    ['the line against it', '<strong>135.42</strong>', '<strong>135.4</strong>'],
  ])('fails the page when it misstates %s', (name, right, wrong) => {
    expect(html).toContain(right);
    const r = siteFigures({ [PAGE]: html.replace(right, wrong) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`never states reference set · ${name}`);
  });

  describe('and leaves exactly the SIZING regions bench/sizing.cjs writes to it', () => {
    const README = 'README.md';
    const readme = readFileSync(join(ROOT, README), 'utf8');
    const before = (text: string): string =>
      readme.replace('## Your data stays yours', () => `${text}\n\n## Your data stays yours`);

    it.each([
      '<!-- SIZING:NOPE:START -->\n<!-- SIZING:NOPE:END -->',
      '<!--SIZING:NOPE:START-->\n<!--SIZING:NOPE:END-->',
      '<!-- SIZING:NOPE2:START -->\n<!-- SIZING:NOPE2:END -->',
    ])('refuses a marker the page is not given, however it is spelled: %s', (marker) => {
      const r = siteFigures({ [README]: before(marker) });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/README\.md(?: holds a SIZING:NOPE2? region|: malformed marker)/);
    });

    it.each(['', 'Between `<!-- SIZING:WHY_SIZES:START -->` and its end. '])(
      'reads the prose around an owned region, however the page quotes its marker: "%s"',
      (quote) => {
        const r = siteFigures({
          [README]: readme.replace(
            'What it costs at three',
            () => `${quote}It saves $99,999 a month.\n\nWhat it costs at three`,
          ),
        });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('README.md states $99,999');
      },
    );
  });
});
