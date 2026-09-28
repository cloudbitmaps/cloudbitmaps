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
/** Both trees: `site/`, which Pages publishes, and `site-next/`, the display-tier rebuild beside it until it replaces it. */
const SITE_DIRS = ['site', 'site-next'] as const;

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function siteFigures(
  dir: (typeof SITE_DIRS)[number],
  files: Record<string, string> = {},
): { code: number; out: string } {
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
    env: { SITE_DIR: dir },
    exit: (code: number): never => {
      throw new Exit(code);
    },
  };
  const source = readFileSync(SCRIPT, 'utf8').replace(/^#!.*\n/, '');
  // The homepage's checks live in a module beside the script and read the tree themselves, so they are loaded
  // with the same planted files rather than from the module cache.
  const HOME = join(dirname(SCRIPT), 'lib', 'home-figures.cjs');
  const home = { exports: {} };
  new Function('require', 'module', '__dirname', readFileSync(HOME, 'utf8'))(
    (id: string) => (id === 'node:fs' ? fs : createRequire(HOME)(id)),
    home,
    dirname(HOME),
  );
  try {
    new Function('require', '__dirname', 'process', 'console', source)(
      (id: string) =>
        id === 'node:fs'
          ? fs
          : id === './lib/home-figures.cjs'
            ? home.exports
            : requireFromScript(id),
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

describe.each(SITE_DIRS)(
  "site:figures on %s/ holds the reference set's Redis to bench/results.json",
  (dir) => {
    const PAGE = `${dir}/benchmarks.html`;
    const html = readFileSync(join(ROOT, PAGE), 'utf8');

    it('passes the page as committed', () => {
      const r = siteFigures(dir);
      expect(r.code, r.out).toBe(0);
    });

    it.each([
      ['its cluster', '3 × cache.t4g.medium', '3 × cache.t4g.small'],
      ['the line against it', '<strong>135.42</strong>', '<strong>135.4</strong>'],
    ])('fails the page when it misstates %s', (name, right, wrong) => {
      expect(html).toContain(right);
      const r = siteFigures(dir, { [PAGE]: html.replace(right, wrong) });
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
        const r = siteFigures(dir, { [README]: before(marker) });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toMatch(/README\.md(?: holds a SIZING:NOPE2? region|: malformed marker)/);
      });

      it.each(['', 'Between `<!-- SIZING:WHY_SIZES:START -->` and its end. '])(
        'reads the prose around an owned region, however the page quotes its marker: "%s"',
        (quote) => {
          const r = siteFigures(dir, {
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
  },
);

/**
 * On `site-next/`, the homepage is held figure by figure: each check marks the span it read, and any number left
 * unmarked fails, since the footer says every figure on this page is gated in CI. Each case plants one wrong page and
 * expects the check that owns it to say so; the last few plant a legitimate edit and expect a pass.
 */
describe("site:figures holds site-next/'s homepage to its sources", () => {
  const PAGE = 'site-next/index.html';
  const CSS = 'site-next/cloudbitmaps.css';
  const html = readFileSync(join(ROOT, PAGE), 'utf8');
  const css = readFileSync(join(ROOT, CSS), 'utf8');
  const withPage = (right: string, wrong: string): { code: number; out: string } => {
    expect(html).toContain(right);
    return siteFigures('site-next', { [PAGE]: html.replace(right, () => wrong) });
  };
  const HEAD = '<h2>What this does not prove.</h2>';

  it.each([
    [
      'a derived figure its arithmetic does not give',
      '<td>$11.20</td>',
      '<td>$11.60</td>',
      'table of what comes out, row 3, reads',
    ],
    [
      'an operand the figure beside it does not follow from',
      '206 GETs × $0.40',
      '205 GETs × $0.40',
      'table of what comes out, row 2, reads',
    ],
    [
      'a chunk band figure',
      '<p class="cb-figure-l">1,900</p>',
      '<p class="cb-figure-l">1,800</p>',
      'chunk band figure 2 reads',
    ],
    [
      'a condition whose figure moved',
      'crosses at 135.42 GETs a second',
      'crosses at 142.35 GETs a second',
      'condition 2 reads',
    ],
    [
      'an id width the source does not have',
      'Ids are 32-bit unsigned',
      'Ids are 64-bit unsigned',
      'id width reads "Ids are 64-bit',
    ],
    [
      'a band out of sequence',
      '06 · The conditions',
      '07 · The conditions',
      'band 6 is numbered 07',
    ],
    [
      'a licence package.json does not have',
      'CloudBitmaps · v0.10.0 · Apache-2.0',
      'CloudBitmaps · v0.10.0 · MIT',
      'states the licence MIT',
    ],
    [
      'a figure no check holds',
      'Pass the Redis you would run to',
      'It is 3× cheaper. Pass the Redis you would run to',
      'figure(s) no check holds',
    ],
    [
      'a figure in a label read aloud',
      'aria-label="The write model, scrollable"',
      'aria-label="The write model, 9 panels, scrollable"',
      'figure(s) no check holds',
    ],
    [
      'an element hidden from readers',
      HEAD,
      `${HEAD}<p hidden>It saves you 90%.</p>`,
      'hides an element with the hidden attribute',
    ],
    [
      'an inline style other than a custom property',
      HEAD,
      HEAD.replace('<h2>', '<h2 style="display:none">'),
      'sets an inline style other than a custom property',
    ],
    [
      'an inline style however it is written',
      HEAD,
      HEAD.replace('<h2>', "<h2 STYLE='--x: 1&#59 display: none'>"),
      'sets an inline style other than a custom property',
    ],
    ['the hidden attribute on a self-closed tag', HEAD, `${HEAD}<p hidden/>`, 'hides an element'],
    [
      'the checked copy of a figure moved into a comment',
      '<p class="cb-figure-xl">$346<span class="cb-unit">/mo</span></p>',
      '<!-- <p class="cb-figure-xl">$346<span class="cb-unit">/mo</span></p> --><p class="cb-figure-xl">$999</p>',
      'hero figure 2 reads "$999"',
    ],
    [
      'content held in a template',
      HEAD,
      `${HEAD}<template><p>$999</p></template>`,
      'holds a template',
    ],
    [
      'a style element',
      '<link rel="stylesheet" href="cloudbitmaps.css" />',
      '<link rel="stylesheet" href="cloudbitmaps.css" /><style>h1::after { content: " 10x"; }</style>',
      'holds a style element',
    ],
    [
      'a script that writes text',
      '      // Plays each animation once',
      "      document.querySelector('h1').textContent += ' 10× cheaper';\n      // Plays each animation once",
      'runs a script that writes text',
    ],
    [
      'a list that numbers itself',
      HEAD,
      `${HEAD}<ol start="12"><li>regions</li></ol>`,
      'a numbered list',
    ],
    [
      'a figure in a field',
      HEAD,
      `${HEAD}<input readonly value="$999/mo">`,
      'figure(s) no check holds',
    ],
    [
      'a figure in a single-quoted label',
      HEAD,
      `${HEAD}<span role="img" aria-label='9 storage drivers'>★</span>`,
      'figure(s) no check holds',
    ],
    [
      'a figure in an attribute of a span a check read',
      '<p class="cb-figure-xl">$0.03<span class="cb-unit">/mo</span></p>',
      '<p class="cb-figure-xl">$0.03<span class="cb-unit">/mo</span></p>'.replace(
        '$0.03<',
        '<span role="img" aria-label="$9.99 a month">$0.03</span><',
      ),
      'in an attribute of an element a check read',
    ],
    [
      'a second description, placed first with its attributes turned round',
      '<meta property="og:type" content="website" />',
      '<meta content="$9 a year" property="og:description" /><meta property="og:type" content="website" />',
      'link-preview description is found 2 times',
    ],
    [
      'structured data',
      '<link rel="stylesheet" href="cloudbitmaps.css" />',
      '<link rel="stylesheet" href="cloudbitmaps.css" /><script type="application/ld+json">{"ratingValue":"4.9"}</script>',
      'carries structured data',
    ],
    [
      'a headline turned round its figure',
      "Cheaper until 329.15 GETs a second. Then it isn't.",
      'Cheaper past 329.15 GETs a second. Below it, Redis wins.',
      'cost headline reads',
    ],
    [
      "the previous release's version in the footer",
      'CloudBitmaps · v0.10.0 · Apache-2.0',
      'CloudBitmaps · v0.9.0 · Apache-2.0',
      'footer reads',
    ],
    [
      'digits from another script',
      HEAD,
      `${HEAD}<p>$𝟿𝟿𝟿 a month, ３× cheaper</p>`,
      'figure(s) no check holds',
    ],
    ['a leading-dot decimal', HEAD, `${HEAD}<p>For $.50 a month.</p>`, 'figure(s) no check holds'],
    ['a fraction', HEAD, `${HEAD}<p>At ½ the cost.</p>`, 'figure(s) no check holds'],
    [
      'a licence named at the end of a sentence',
      HEAD,
      `${HEAD}<p>Licensed MIT.</p>`,
      'states the licence MIT',
    ],
  ])('fails the page on %s', (_name, right, wrong, says) => {
    const r = withPage(right, wrong);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['a number', '.cb-caveats::after { content: "3x cheaper"; }'],
    ['a second string', ".cb-caveats::after { content: '' ' From $1 a month.'; }"],
    ['an attribute', '.cb-caveats::after { content: attr(data-note); }'],
    [
      'a counter',
      '.cb-caveats { counter-reset: n 9; } .cb-caveats::after { content: counter(n); }',
    ],
    ['a variable', '.cb-caveats::after { content: var(--note); }'],
  ])('fails a stylesheet that inserts text through content: %s', (_name, rule) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('inserts text no check reads');
  });

  it('keeps the whole ledger when the footer drops its claim', () => {
    const r = withPage('every figure on this page is gated in CI', 'the figures are ours');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("footer's claim reads");
  });

  it.each([
    ['a class added', HEAD, HEAD.replace('<h2>', '<h2 class="is-x">')],
    ['a custom property set inline', HEAD, HEAD.replace('<h2>', '<h2 style="--x: 3">')],
    [
      'the word "hidden" in a label',
      HEAD,
      `${HEAD}<span aria-label="Nothing is hidden here">·</span>`,
    ],
    [
      "a description's attributes turned round",
      '<meta property="og:type" content="website" />',
      '<meta content="website" property="og:type" />',
    ],
    ['a comment that names a figure', HEAD, `${HEAD}<!-- $999, never shown -->`],
  ])('passes a legitimate edit: %s', (_name, right, edit) => {
    const r = withPage(right, edit);
    expect(r.code, r.out).toBe(0);
  });
});

/**
 * `site-next/` describes the current release only, so the July run's figures, run id and date are refused in every
 * file of the tree, including those the money scan does not read, while `site/` and the docs keep the receipt.
 */
describe('site:figures keeps the July run off every file in site-next/', () => {
  it.each([
    [
      'site-next/demo.html',
      '</main>',
      '<p>Recorded as run 2026-07-25-60291.</p></main>',
      'calibration run id',
    ],
    [
      'site-next/flavors/roaring.html',
      '</main>',
      '<p>Measured on 2026-07-25.</p></main>',
      'calibration date',
    ],
    ['site-next/llms.txt', '\n', '\nA count() is $0.14 per million.\n', 'July · 1M count() calls'],
    ['site-next/demo.js', '\n', '\n// run 2026-07-25-60291\n', 'calibration run id'],
    [
      'site-next/usage.html',
      '</main>',
      '<p>A count() is &#36;0.14 per million.</p></main>',
      'July · 1M count() calls',
    ],
  ])('fails %s when it states the July run', (file, at, planted, says) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toContain(at);
    const r = siteFigures('site-next', { [file]: text.replace(at, () => planted) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${file} states ${says}`);
  });

  it('refuses an unaccounted dollar figure on /demo too', () => {
    const file = 'site-next/demo.html';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const r = siteFigures('site-next', {
      [file]: text.replace('</main>', () => '<p>A read costs $999 a month.</p></main>'),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${file} states $999, which no source accounts for`);
  });

  it('leaves the receipt where the docs keep it', () => {
    const file = 'docs/benchmarks.md';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const r = siteFigures('site-next', {
      [file]: text.replace(
        '\n## ',
        () => '\nThe July count() figure, $0.14 per million, left the pointer out.\n\n## ',
      ),
    });
    expect(r.code, r.out).toBe(0);
  });
});
