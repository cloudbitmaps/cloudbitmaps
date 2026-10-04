import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/site_markup.py`'s `css_code` is how `site-links.py` reads a stylesheet for the URLs it loads, so it has to
 * read the sheet as the browser does: a comment that a string or an unquoted `url()` holds is no comment, a CR or a
 * form feed ends a string as a line feed does, and an escape is decoded once, an escaped line break to nothing.
 */
const SCRIPTS = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'scripts');

function cssCode(sheet: string): string {
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import sys; sys.path.insert(0, sys.argv[1]); import site_markup; sys.stdout.write(site_markup.css_code(sys.stdin.read()))',
      SCRIPTS,
    ],
    { input: sheet, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe('site_markup.css_code reads a sheet as the browser does', () => {
  it.each([
    [
      'a comment opener inside a string',
      ".a::after { content: '/*'; } .b { background: url(http://x.test/a.png); } .c::after { content: '*/'; }",
    ],
    [
      'a comment opener inside an unquoted url()',
      '.a:is(url(/*)) {} .b { background: url(http://x.test/a.png); } .c:is(url(*/)) {}',
    ],
    [
      'a string ended by a form feed',
      ".a { x: '\f} .b { background: url(http://x.test/a.png); } .c { y: '}",
    ],
    [
      'a string ended by a carriage return',
      ".a { x: '\r} .b { background: url(http://x.test/a.png); } .c { y: '}",
    ],
    ['an escaped line break inside a URL', '.b { background: url("http://x.te\\\nst/a.png"); }'],
  ])('keeps a load in sight past %s', (_name, sheet) => {
    expect(cssCode(sheet)).toContain('http://x.test/a.png');
  });

  it('still takes out a real comment', () => {
    expect(cssCode('.b { /* background: url(http://x.test/a.png); */ }')).not.toContain('x.test');
  });

  it('decodes each escape once, and ends a hex escape only at a space, tab or line feed', () => {
    expect(cssCode('\\68ttps: \\\\6f \\68\u00a0x')).toBe('https: \\6f h\u00a0x');
  });
});
