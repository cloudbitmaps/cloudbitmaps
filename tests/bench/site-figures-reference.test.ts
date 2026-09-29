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
      'runs a script no one has pinned (inline',
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

  it.each([
    ['template', '<template><p>x</p></template>', 'holds a template'],
    ['noscript', '<noscript><p>x</p></noscript>', 'holds a noscript element'],
    ['details', '<details><summary>x</summary>y</details>', 'holds a details element'],
    ['dialog', '<dialog>x</dialog>', 'holds a dialog'],
    ['iframe', '<iframe src="demo.html"></iframe>', 'holds an embedded document'],
    ['object', '<object data="x.svg"></object>', 'holds an embedded object'],
    ['embed', '<embed src="x.svg" />', 'holds an embedded object'],
    ['popover', '<div popover>x</div>', 'holds a popover'],
    ['an image', '<img src="assets/price.svg" alt="" />', 'holds an image'],
    [
      'an image set with no src',
      '<img srcset="data:image/png;base64,AAAA 1x" alt="" />',
      'holds an image',
    ],
    ['a picture', '<picture><source srcset="assets/a.png" /></picture>', 'holds an image'],
    ['a canvas', '<canvas width="9" height="9"></canvas>', 'holds a canvas'],
    ['a video', '<video poster="assets/a.png"></video>', 'holds a video'],
    ['an audio player', '<audio controls></audio>', 'holds an audio player'],
    ['an SVG image', '<svg><image href="assets/a.png" /></svg>', 'holds an SVG image'],
    [
      'an SVG filter image',
      '<svg><filter><feImage href="assets/a.png" /></filter></svg>',
      'filter image',
    ],
    [
      'another file drawn in',
      '<svg><use href="assets/a.svg#price" /></svg>',
      "draws another file's SVG",
    ],
    ['a data: link', '<a href="data:text/html,x">x</a>', 'loads a data: URL'],
    ['HTML inside SVG', '<svg><foreignObject><p>x</p></foreignObject></svg>', 'HTML inside SVG'],
    ['MathML', '<math><mn>9</mn></math>', 'MathML'],
    ['an xmp', '<xmp><!-- x --></xmp>', 'an xmp element'],
    ['a text field', '<textarea><!-- x --></textarea>', 'a text field'],
    ['plaintext', '<plaintext>', 'a plaintext element'],
    ['a noembed', '<noembed>x</noembed>', 'a noembed element'],
    ['a marquee', '<marquee>x</marquee>', 'a marquee'],
    ['a bidirectional override', '<bdo dir="rtl">x</bdo>', 'a bidirectional override'],
    ['a bidirectional isolate', '<bdi>x</bdi>', 'a bidirectional isolate'],
    ['a text direction', '<p dir="rtl">x</p>', 'sets a text direction'],
    ['a right-to-left mark', '<p>12 &rlm; 34</p>', 'shows U+200F'],
    ['a right-to-left letter', '<p>12 &#x5d0; 34</p>', 'shows U+05D0'],
    ['a handler', '<span onmouseover="go()">x</span>', 'runs a handler'],
    ['a script link', '<a href=" javascript:go()">x</a>', 'runs code from a link'],
    ['a module script', '<script type="module" src="theme.js"></script>', 'of type "module"'],
    [
      'a script from elsewhere',
      '<script src="https://example.invalid/x.js"></script>',
      'from outside the tree',
    ],
    ['a script inside SVG', '<svg><script>go()</script></svg>', 'a script inside SVG'],
    [
      'a comment opened inside a script',
      '<script><!--<script>x</script>--></script>',
      'writes <!-- inside a script',
    ],
    ['a second title', '<title>x</title>', 'titles, or one in its body'],
    ['a reference without its semicolon', '<p>Ten&sup2 ids.</p>', 'writes &sup2, a reference'],
    [
      'a reference glued to a digit',
      '<p>It is &times3 cheaper.</p>',
      'writes &times3, a reference',
    ],
    ['base URL', '<base href="https://example.invalid/" />', 'sets a base URL'],
    [
      'refresh',
      '<meta http-equiv="refresh" content="0; url=demo.html" />',
      'sends its readers to another page',
    ],
    [
      'second stylesheet',
      '<link rel="stylesheet" href="assets/extra.css" />',
      'loads a stylesheet other than',
    ],
    ['unread entity', '<p>At &frac12; the cost.</p>', 'a reference this check does not read'],
  ])('refuses %s on the homepage', (_name, planted, says) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['title', `<span title="9 drivers">·</span>`],
    ['placeholder', `<input placeholder="9 drivers" />`],
    ['aria-description', `<span aria-description="9 drivers">·</span>`],
    ['aria-valuetext', `<span aria-valuetext="9 drivers">·</span>`],
    ['label', `<option label="9 drivers"></option>`],
    ['an unquoted value', `<span aria-label=9-drivers>·</span>`],
    ['a meta the page does not name', `<meta property="og:image:alt" content="$1 a month" />`],
    ['a meta by itemprop', `<meta itemprop="description" content="9 drivers" />`],
    ['a reference without its semicolon', `<p>It costs &#x39&#x39 cents.</p>`],
    ['a role description', `<span aria-roledescription="9 drivers">·</span>`],
    ['an abbreviation for a header', `<table><tr><th abbr="9 drivers">x</th></tr></table>`],
    ['a value read aloud', `<span role="meter" aria-valuenow="90">·</span>`],
    ['a comment ended the way the browser ends it', `<!--><p>It saves $999.</p><!-- -->`],
    ['a comment ended by --!>', `<!-- x --!><p>It saves $999.</p><!-- -->`],
    [
      'text between two quoted comment openers',
      `<span title="<!--">·</span><p>$999</p><span title="-->">·</span>`,
    ],
    ['a < that opens no tag', `<p>For <$999 a month></p>`],
    ['CDATA in a drawing', `<svg><text><![CDATA[$999 a month]]></text></svg>`],
    ['an unquoted value with = in it', `<span aria-label=Costs=$999/mo>·</span>`],
  ])('reads a figure in %s', (_name, planted) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('figure(s) no check holds');
  });

  it.each([
    [
      'a quote inside an unquoted value',
      `<span title=a'b>·</span><p hidden>$999</p>`,
      'hides an element',
    ],
    ['a > inside a quoted value', `<p title="a>b" hidden>$999</p>`, 'hides an element'],
    [
      'an unquoted style with = in it',
      `<span style=--x:a=b;visibility:hidden>·</span>`,
      'sets an inline style other than a custom property',
    ],
  ])('reads a tag as the browser does: %s', (_name, planted, says) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it("does not read a check's element copied into the title, which no reader sees as markup", () => {
    const eyebrow =
      '<p class="label">Distributed, cloud-native bitmaps · roaring shipped · <span class="u">v0.10.0</span></p>';
    const r = siteFigures('site-next', {
      [PAGE]: html
        .replace(eyebrow, () => '<p class="label is-x">Distributed, cloud-native bitmaps</p>')
        .replace('<title>', () => `<title>${eyebrow}`),
    });
    expect(html).toContain(eyebrow);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('eyebrow is found 0 times');
  });

  it('refuses a script that has changed since it was pinned', () => {
    const file = 'site-next/theme.js';
    const js = readFileSync(join(ROOT, file), 'utf8');
    const r = siteFigures('site-next', { [file]: `${js}\n// read again\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('runs a script no one has pinned (theme.js');
  });

  it.each(['ISC', 'BSD-3-Clause', 'MPL-2.0', 'GPL-3.0-only', 'LGPL-2.1', 'AGPL-3.0', 'BUSL-1.1'])(
    'refuses the licence %s beside ours',
    (licence) => {
      const r = withPage(HEAD, `${HEAD}<p>Licensed ${licence}.</p>`);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`states the licence ${licence}`);
    },
  );

  it.each([
    ['quotation marks', '.cb-body q { quotes: "$1 " ""; }', 'puts text in quotation marks'],
    ['a list marker string', ".cb-op-rows li { list-style: '9 ' inside; }", 'draws list markers'],
    ['a numbered list style', '.cb-op-rows { list-style-type: decimal; }', 'draws list markers'],
    ['a list item', '.cb-op-rows li { display: list-item; }', 'draws list markers'],
    ['a counter', '.cb-op-rows { counter-reset: list-item 11; }', 'counts, for markers'],
    ['an import', "@import url('assets/extra.css');", 'pulls in a sheet'],
    [
      'an escaped property name',
      ".cb-caveats::after { c\\6f ntent: '9x'; }",
      'inserts text no check reads',
    ],
    [
      'a unit after every figure',
      ".cb-figure-l::after { content: 'k'; }",
      'inserts text no check reads',
    ],
    [
      'a minus before every figure',
      ".cb-figure-xl::before { content: '−'; }",
      'inserts text no check reads',
    ],
    [
      'an allowed string in another rule',
      ".cb-figure-xl::after { content: ' ← smallest'; }",
      'inserts text no check reads',
    ],
    [
      'a rule hidden between two strings that look like a comment',
      ".a::after { content: '/*'; } .b::after { content: '9x'; } .c::after { content: '*/'; }",
      'inserts text no check reads',
    ],
    [
      'a picture drawn by the sheet',
      '.cb-caveats { background: url(data:image/svg+xml,x); }',
      'draws an image',
    ],
    [
      'a bidirectional override',
      '.cb-figure-xl { unicode-bidi: bidi-override; }',
      'sets a text direction',
    ],
    ['a direction', '.cb-figure-xl { direction: rtl; }', 'sets a text direction'],
    ['a font', "@font-face { font-family: x; src: local('x'); }", 'or a font'],
    [
      'a rule for a reader no pass is',
      '@media (min-height: 1000px) { .cb-caveats { display: none; } }',
      'a rule no pass probes',
    ],
    [
      'a rule for forced colours',
      '@media (forced-colors: active) { .cb-caveats { display: none; } }',
      'a rule no pass probes',
    ],
    [
      'a rule for other browsers',
      '@supports not (display: grid) { .cb-caveats { display: none; } }',
      'other browsers a page',
    ],
    [
      'a scroll-driven fade',
      '.cb-caveats { animation: x linear both; animation-timeline: view(); }',
      'ties an animation to scrolling',
    ],
  ])('fails a stylesheet that adds text through %s', (_name, rule, says) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['a class named content in a selector', '.cb-body .content:hover { color: inherit; }'],
    ['an escaped arrow', ".cb-caveats::after { content: '\\2192'; }"],
    ['alternative text for generated content', ".cb-caveats::after { content: '→' / ''; }"],
    [
      'quotation marks for a quote',
      'q::before { content: open-quote; } q::after { content: close-quote; }',
    ],
    ['a comment inside a declaration', '.cb-caveats { color: /* the ink */ inherit; }'],
    [
      'a rule for a band of widths, which the pass loads a width inside',
      '@media (min-width: 1441px) and (max-width: 1600px) { .cb-caveats { gap: 2px; } }',
    ],
  ])('passes a stylesheet with %s', (_name, rule) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(0);
  });

  it('refuses the claim on a page the ledger does not hold', () => {
    const file = 'site-next/demo.html';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const r = siteFigures('site-next', {
      [file]: text.replace(
        '</main>',
        () => '<p>Every figure on this page is gated in C&shy;I.</p></main>',
      ),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${file} says every figure on this page is gated in CI`);
  });

  it('runs the ledger on the homepage that makes the claim, whatever its hero is called', () => {
    const r = withPage('<section class="cb-stack is-hero">', '<section class="cb-stack is-top">');
    const planted = siteFigures('site-next', {
      [PAGE]: html
        .replace('<section class="cb-stack is-hero">', () => '<section class="cb-stack is-top">')
        .replace(HEAD, () => `${HEAD}<p>It saves 90%.</p>`),
    });
    expect(r.code, r.out).toBe(0);
    expect(planted.code, planted.out).toBe(1);
    expect(planted.out).toContain('figure(s) no check holds');
  });

  it('refuses a second generated region of the same name', () => {
    const r = withPage(
      '<!-- BENCH:HOMEMEMORY:END -->',
      '<!-- BENCH:HOMEMEMORY:END --><!-- BENCH:HOMEMEMORY:START --><!-- BENCH:HOMEMEMORY:END -->',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('BENCH:HOMEMEMORY regions; it needs exactly one');
  });

  it.each([
    [
      'a row without the pair class',
      '<p class="panel-row is-pair"><span>Reserved RAM, standing</span>',
      '<p class="panel-row"><span>1.2 GiB at rest, no traffic</span><span>$346 /mo</span></p><p class="panel-row is-pair"><span>Reserved RAM, standing</span>',
      'comparison panel holds 8 rows',
    ],
    [
      'a second panel',
      '<aside class="panel">',
      '<aside class="panel"><p class="panel-row is-pair"><span>x</span><span>$346 /mo</span></p></aside><aside class="panel">',
      'holds 2 comparison panels',
    ],
    [
      'two rows trading values',
      '<span>Reserved RAM, standing</span><span>$346 /mo</span>',
      '<span>Reserved RAM, standing</span><span>$0.03 /mo</span>',
      'comparison panel, row 1, reads',
    ],
  ])('holds the benchmarks comparison panel against %s', (_name, right, wrong, says) => {
    const file = 'site-next/benchmarks.html';
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toContain(right);
    const r = siteFigures('site-next', { [file]: text.replace(right, () => wrong) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['a comment ended by <!--->', `<!---><p>It saves $999.</p><!-- -->`],
    ["a figure in a drawing's title", `<svg><title>9 drivers</title></svg>`],
    ['a figure glued to a letter', `<p>From USD1200 a month.</p>`],
    [
      'CDATA after a tag whose unquoted value ends in /',
      `<svg viewBox="0 0 200 20" x=/><text><![CDATA[It saves $999 a month]]></text></svg>`,
    ],
    ...[
      'aria-valuemin',
      'aria-valuemax',
      'aria-placeholder',
      'aria-setsize',
      'aria-posinset',
      'aria-rowcount',
      'aria-colcount',
      'aria-rowindex',
      'aria-colindex',
      'aria-rowindextext',
      'aria-colindextext',
      'aria-braillelabel',
      'aria-brailleroledescription',
    ].map((a) => [`the ${a} attribute`, `<span ${a}="9 drivers">·</span>`]),
  ])('reads a figure in %s', (_name, planted) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('figure(s) no check holds');
  });

  it('reads a figure in the title', () => {
    const r = withPage(
      '<title>CloudBitmaps — big bitmaps on object storage</title>',
      '<title>CloudBitmaps — big bitmaps on object storage, 9 drivers</title>',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('figure(s) no check holds');
  });

  it.each([
    ['a / between attributes', `<p/hidden>$999</p>`, 'hides an element'],
    ['spaces around =', `<span title = "x" hidden>$999</span>`, 'hides an element'],
    [
      'the first of two styles, which the browser keeps',
      `<p style="display: none" style="--x: 1">x</p>`,
      'sets an inline style other than a custom property',
    ],
    ['an image button', `<input type="image" src="assets/a.png" alt="" />`, 'an image button'],
    [
      'a script link by xlink:href',
      `<svg><a xlink:href="javascript:go()"><text>x</text></a></svg>`,
      'runs code from a link',
    ],
    [
      'a script link as a form action',
      `<form action="javascript:go()"></form>`,
      'runs code from a link',
    ],
    [
      'a script link as a button action',
      `<button formaction="javascript:go()">x</button>`,
      'runs code from a link',
    ],
    ['a script link in capitals', `<a href="JavaScript:go()">x</a>`, 'runs code from a link'],
    [
      'a script link with a tab in it',
      `<a href="java&#9;script:go()">x</a>`,
      'runs code from a link',
    ],
    [
      'a background attribute',
      `<table><tr><td background="assets/a.svg">x</td></tr></table>`,
      'a background attribute',
    ],
    ['an HTML tag inside SVG', `<svg><p>x</p></svg>`, 'inside SVG'],
    [
      'a reference in an attribute',
      `<span title="&frac12; off">·</span>`,
      'writes &frac12, a reference',
    ],
    ['a right-to-left override', `<p>12 &#x202e; 34</p>`, 'shows U+202E'],
    ['a right-to-left embedding', `<p>12 &#x202b; 34</p>`, 'shows U+202B'],
    ['a right-to-left isolate', `<p>12 &#x2067; 34</p>`, 'shows U+2067'],
    [
      'a bidirectional control in an attribute',
      `<span title="12 &#x2066; 34">·</span>`,
      'shows U+2066',
    ],
    [
      'a Cyrillic letter that passes for a digit',
      `<p>1,9&#x41e;&#x41e; ids</p>`,
      'can pass for a Latin letter or a digit',
    ],
    [
      'the class of a rule that inserts a word',
      `<span class="cmeasure"><span class="is-win"><code class="cm-name">$346/mo</code></span></span>`,
      'carries the class cmeasure',
    ],
  ])('refuses %s', (_name, planted, says) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    [
      'a text direction on the page',
      '<html lang="en">',
      '<html lang="en" dir="rtl">',
      'sets a text direction',
    ],
    [
      'a bidirectional control in the title',
      '<title>CloudBitmaps',
      '<title>&#x202e;CloudBitmaps',
      'shows U+202E',
    ],
    [
      'a reference in the title',
      '<title>CloudBitmaps',
      '<title>&frac12; CloudBitmaps',
      'writes &frac12, a reference',
    ],
    [
      "a copy of a check's element kept in an attribute",
      'Ids are 32-bit unsigned',
      'Ids are sixty-four-bit unsigned',
      'id width',
    ],
  ])('refuses %s', (_name, right, wrong, says) => {
    const r = withPage(right, wrong);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it("does not read a check's copy kept in an attribute", () => {
    const at = html.indexOf('Ids are 32-bit unsigned');
    const open = html.lastIndexOf('<p class="cb-note">', at);
    expect(open).toBeGreaterThan(-1);
    const decoy = `<p class="cb-note" data-copy='<p class="cb-note">${html.slice(open + 19, html.indexOf('</p>', at))}</p>'>`;
    const planted =
      html.slice(0, open) +
      decoy +
      html
        .slice(open + 19)
        .replace('Ids are 32-bit unsigned', () => 'Ids are sixty-four-bit unsigned');
    const r = siteFigures('site-next', { [PAGE]: planted });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('id width');
  });

  it.each([
    [
      'a string ended by a form feed',
      '.cb-caveats { x: \'\f} .cb-caveats::after { content: "9x"; } .cb-caveats { y: \'}',
      'inserts text no check reads',
    ],
    [
      'a string ended by a carriage return',
      '.cb-caveats { x: \'\r} .cb-caveats::after { content: "9x"; } .cb-caveats { y: \'}',
      'inserts text no check reads',
    ],
    [
      'a string ended by a line feed',
      '.cb-caveats { x: \'\n} .cb-caveats::after { content: "9x"; } .cb-caveats { y: \'}',
      'inserts text no check reads',
    ],
    [
      'an escape inside a string',
      ".cb-caveats::after { content: '\\39 x'; }",
      'inserts text no check reads',
    ],
    [
      'a comment inside the value',
      ".cb-caveats::after { content: /* none */ '9x'; }",
      'inserts text no check reads',
    ],
    [
      'a property name in capitals',
      ".cb-caveats::after { CONTENT: '9x'; }",
      'inserts text no check reads',
    ],
    [
      'an escaped at-rule name',
      '@\\73upports not (display: grid) { .cb-caveats { display: none; } }',
      'other browsers a page',
    ],
    ['an escaped import', "@\\69mport 'assets/extra.css';", 'pulls in a sheet'],
    [
      'an allowed rule with another word',
      ".cmeasure .is-win .cm-name::after { content: ' ← largest'; }",
      'inserts text no check reads',
    ],
    [
      'an image set',
      ".cb-caveats { background-image: image-set('assets/a.png' 1x); }",
      'draws an image',
    ],
    [
      'a vertical writing mode',
      '.cb-caveats { writing-mode: vertical-rl; }',
      'sets a text direction',
    ],
    ['text drawn as discs', '.cb-caveats { -webkit-text-security: disc; }', 'as discs'],
    [
      'a marker string beside none',
      ".cb-op-rows li { list-style: none '9 '; }",
      'draws list markers',
    ],
    ['a display from a variable', '.cb-op-rows li { display: var(--d); }', 'draws list markers'],
    [
      'a url() that hides a rule from a comment reader',
      '.nope:is(url(/*)) {} .cb-caveats::after { content: "9x"; } .nope:is(url(*/)) {}',
      'names url(',
    ],
    ['a size that follows the height', '.cb-caveats { font-size: 2vh; }', "the viewport's height"],
    ['arithmetic on the width', '.cb-caveats { font-size: calc(100vw - 1366px); }', 'arithmetic'],
    [
      'a container query',
      '@container (min-width: 1px) { .cb-caveats { display: none; } }',
      'to a container',
    ],
    [
      'a first letter styled apart',
      '.cb-caveats p::first-letter { font-size: 0; }',
      'first letter or line',
    ],
    ['emphasis marks', ".cb-caveats { text-emphasis: '0'; }", 'draws marks over its text'],
    [
      'the claim, which only a page may make',
      ".cb-caveats::after { content: 'every figure on this page is gated in CI'; }",
      'writes the claim that every figure is gated',
    ],
  ])('fails a stylesheet with %s', (_name, rule, says) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['an orientation', '@media (orientation: landscape) { .cb-caveats { display: none; } }'],
    ['more contrast', '@media (prefers-contrast: more) { .cb-caveats { display: none; } }'],
    ['a colour scheme', '@media (prefers-color-scheme: dark) { .cb-caveats { display: none; } }'],
    ['a screen without hover', '@media (hover: none) { .cb-caveats { display: none; } }'],
    [
      'print with another condition',
      '@media print and (max-width: 700px) { .cb-caveats { display: none; } }',
    ],
  ])('fails a rule for a reader no pass becomes: %s', (_name, rule) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('a rule no pass probes');
  });

  it.each([
    ['a shadow', '.cb-caveat h3 { box-shadow: 0 0 0 140px var(--cb-cell); }', 'does not measure'],
    [
      'a wide outline',
      '.cb-caveat h3 { outline: 140px solid var(--cb-cell); }',
      'an outline wide enough',
    ],
    [
      'a gradient',
      '.cb-caveat p { background: linear-gradient(var(--cb-cell), var(--cb-cell)); }',
      'paints a gradient',
    ],
    [
      'a text stroke',
      '.cb-caveat p { -webkit-text-stroke: 5px var(--cb-cell); }',
      'does not measure',
    ],
    [
      'a stroke over the letters',
      'svg .t { paint-order: fill stroke; }',
      'paints a stroke over its text',
    ],
    ['a reflection', '.cb-figure-l { -webkit-box-reflect: right 4px; }', 'does not measure'],
    ['a font size adjustment', '.cb-caveat p { font-size-adjust: 0.03; }', 'does not measure'],
    [
      'a hyphenation character',
      ".cb-caveat p { hyphens: auto; hyphenate-character: '0'; }",
      'does not measure',
    ],
    ['a scale', '.cb-caveat p { scale: 0.06; }', 'does not measure'],
    ['a rotation', '.cb-figure-l { rotate: 180deg; }', 'does not measure'],
    ['a translation', '.cb-caveats { translate: 0 -4000px; }', 'does not measure'],
    ['a perspective', '.cb-caveats { perspective: 100px; }', 'does not measure'],
    [
      'a turned transform',
      '.cb-figure-l { transform: rotate(180deg); }',
      'turns, mirrors or tilts',
    ],
    ['a mirrored transform', '.cb-figure-xl { transform: scaleX(-1); }', 'turns, mirrors or tilts'],
    [
      'a 3D transform',
      '.cb-caveat p { transform: perspective(100px) translateZ(-1500px); }',
      'turns, mirrors or tilts',
    ],
    ['containment', '.cb-caveat p { contain: paint; max-height: 1lh; }', 'does not measure'],
    ['a skipped rendering', '.cb-caveat p { content-visibility: hidden; }', 'does not measure'],
    ['a blend', '.cb-caveat p { mix-blend-mode: multiply; }', 'does not measure'],
    [
      'a thick decoration',
      '.cb-caveat p { text-decoration: line-through 1.7em var(--cb-cell); }',
      'a decoration wide',
    ],
    [
      'a decoration thickness',
      '.cb-caveat p { text-decoration-thickness: 2em; }',
      'a decoration wide',
    ],
    [
      'lines laid over each other',
      '.cb-caveat p { line-height: 0.02; }',
      'lays its lines over each other',
    ],
    [
      'pointer events that out-rank the pass',
      '.cb-caveat::after { pointer-events: none !important; }',
      'out-rank the sheets the browser pass adds',
    ],
    [
      'letters painted past the clear sheet the pixel comparison adds',
      '#a#b#c#d#e#f#g#h#i p { -webkit-text-fill-color: currentcolor !important; }',
      'out-rank the sheets the browser pass adds',
    ],
    [
      'an important flag written with a space',
      '.cb-caveat::after { pointer-events: none ! important; }',
      'out-rank the sheets the browser pass adds',
    ],
    [
      'an important flag written with a comment',
      '.cb-caveat::after { pointer-events: none !/**/important; }',
      'out-rank the sheets the browser pass adds',
    ],
    [
      'an important flag written with an escape',
      '.cb-caveat::after { pointer-events: none !\\69mportant; }',
      'out-rank the sheets the browser pass adds',
    ],
    ['a rule that styles a highlight', '::highlight(x) { color: red; }', 'styles a highlight'],
    [
      'a text shadow',
      '.cb-caveat p { text-shadow: 0.2em 0 currentColor; }',
      'paints, moves or hides text',
    ],
    [
      'a matrix that turns text',
      '.cb-caveat p { transform: matrix(-1, 0, 0, -1, 0, 0); }',
      'turns, mirrors or tilts text',
    ],
    [
      'a font the sheet does not name',
      '.cb-figure-xl { font-family: Webdings; }',
      'a font the sheet does not name',
    ],
    [
      'a font shorthand',
      '.cb-figure-xl { font: 20px Webdings; }',
      'a font the sheet does not name',
    ],
    [
      'a new font in a stack',
      ':root { --cb-sans: Webdings, sans-serif; }',
      'names a font the sheet does not',
    ],
    ['an animation that never ends', '.cb-caveat p { animation: x 120s infinite; }', 'never ends'],
    [
      'forced colours turned off',
      '.cb-caveat p { forced-color-adjust: none; }',
      "the system's colours",
    ],
    [
      'a system colour',
      "[data-theme='dark'] .cb-caveat p { -webkit-text-fill-color: Canvas; }",
      "the system's colours",
    ],
    [
      'a hover rule that hides',
      'html:hover .cb-caveat p { opacity: 0; }',
      'hovering, focusing or following a link',
    ],
    [
      'a rule for the link to a section',
      '#conditions:target .cb-caveat p { display: none; }',
      'hovering, focusing or following a link',
    ],
    [
      'a focus rule that hides',
      'body:focus-within .cb-caveat p { visibility: hidden; }',
      'hovering, focusing or following a link',
    ],
    [
      'a hover colour that is clear',
      '.cb-caveats:hover p { color: transparent; }',
      'hovering, focusing or following a link',
    ],
  ])('fails a stylesheet that hides text by %s', (_name, rule, says) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    [
      'the words around the invariant count',
      'each with named tests that run on every commit.',
      'of which only one has a test so far.',
      'invariant line reads',
    ],
    [
      'the words around the driver count',
      '4 storage drivers ·',
      '4 storage drivers planned, none shipped yet ·',
      'meta line reads',
    ],
    [
      'the stage said anywhere but the footer',
      '<h2>Where it fits, and where Redis is better.</h2>',
      '<h2>Where it fits, and where Redis is better.</h2><p class="cb-body">We left pre-1.0 behind last spring.</p>',
      'figure(s) no check holds',
    ],
  ])('fails the page on %s', (_name, right, wrong, says) => {
    const r = withPage(right, wrong);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(says);
  });

  it.each([
    ['a width in range syntax', '@media (width >= 768px) { .cb-caveats { gap: 2px; } }'],
    ['a width in em', '@media (min-width: 48em) { .cb-caveats { gap: 2px; } }'],
    [
      'less motion asked for, as a bare feature',
      '@media (prefers-reduced-motion) { .cb-caveats { gap: 2px; } }',
    ],
    ['a halo painted under the letters', 'svg .t { paint-order: stroke; }'],
    ['a hover colour', '.cb-caveats a:hover { color: var(--cb-ink); }'],
    ['a custom property named like a system colour', '.cb-caveats { --cb-mark: 1px; }'],
    ['print', '@media print { .cb-caveats { gap: 2px; } }'],
  ])('passes a stylesheet with %s', (_name, rule) => {
    const r = siteFigures('site-next', { [CSS]: `${css}\n${rule}\n` });
    expect(r.code, r.out).toBe(0);
  });

  it.each([
    ['references the checks decode', `<p>&copy; &bull; &le; &ge;</p>`],
    ['a zero-width space inside a name', `<p>estimate&zwsp;Cost()</p>`],
    ['an empty style', `<span style="">·</span>`],
    ['a left-to-right direction', `<p dir="ltr">x</p>`],
  ])('passes a legitimate edit: %s', (_name, planted) => {
    const r = withPage(HEAD, `${HEAD}${planted}`);
    expect(r.code, r.out).toBe(0);
  });

  it('passes a list of steps whose markers the sheet removes', () => {
    const r = siteFigures('site-next', {
      [PAGE]: html.replace(HEAD, () => `${HEAD}<ol class="cb-steps"><li>install</li></ol>`),
      [CSS]: `${css}\n.cb-steps { list-style: none; padding: 0; }\n`,
    });
    expect(r.code, r.out).toBe(0);
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
    [
      'a comment inside a held sentence',
      'keeps large id-sets as immutable objects',
      'keeps large id<!-- a hyphen, not a break -->-sets as immutable objects',
    ],
    [
      'an old copy of the invariant line, commented out',
      '<p class="ba-foot">',
      '<!-- <p class="ba-foot">Under it, <strong>6 hard correctness invariants</strong>.</p> --><p class="ba-foot">',
    ],
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

  it.each([
    ['site', 'site/demo.html', '</title>', ' · $999 a month</title>'],
    [
      'site-next',
      'site-next/demo.html',
      '</main>',
      '<textarea readonly>A read costs $999 a month.</textarea></main>',
    ],
    [
      'site-next',
      'site-next/demo.html',
      '</main>',
      '<noscript><p>A read costs $999 a month.</p></noscript></main>',
    ],
    ['site-next', 'site-next/demo.html', '</main>', '<xmp>A read costs $999 a month.</xmp></main>'],
    [
      'site-next',
      'site-next/demo.html',
      '</main>',
      '<!--><p>A read costs $999 a month.</p><!-- --></main>',
    ],
    ['site', 'site/demo.html', '</main>', '<p>A read costs <$999 a month.</p></main>'],
  ])('reads a figure on %s where a reader gets it: %s', (dir, file, at, planted) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toContain(at);
    const r = siteFigures(dir as (typeof SITE_DIRS)[number], {
      [file]: text.replace(at, () => planted),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${file} states $999`);
  });

  it('reads a count a comment states, since view-source is public', () => {
    const file = 'site/demo.html';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const r = siteFigures('site', {
      [file]: text.replace('</main>', () => '<!-- a > b: It has 9 storage drivers. --></main>'),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('"9 storage drivers"');
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

/** The reader's own pieces, called directly: what the ledger keeps apart, and what the browser pass is given. */
describe('home-figures, piece by piece', () => {
  const home = requireFromScript('./lib/home-figures.cjs') as {
    ledger: (page: string) => { mark: (a: number, b: number) => void; strays: [number, number][] };
    readerFigures: (html: string) => Map<string, number>;
    widthsToProbe: (sheet: string, standard: number[]) => number[];
    rendered: (html: string) => string;
  };

  it('keeps apart a span a check read inside an attribute', () => {
    const page = '<p class="Ids are 32 bit">x</p>';
    const L = home.ledger(page);
    L.mark(page.indexOf('Ids'), page.indexOf('bit') + 3);
    L.mark(0, page.length);
    expect(L.strays).toEqual([[page.indexOf('Ids'), page.indexOf('bit') + 3]]);
  });

  it('blanks every attribute a check does not match on, and keeps word characters of the ones it does', () => {
    expect(home.rendered('<p class="a b" data-x="</p><p>9">t</p>')).toBe(
      '<p class="a b" data-x="        ">t</p>',
    );
  });

  it('counts each figure where a reader can be given it', () => {
    const counts = home.readerFigures(
      '<title>v 9</title><p title="8 x">7 and USD6 in @x/s3</p><script>5</script><svg><text><![CDATA[4]]></text></svg>',
    );
    expect(Object.fromEntries(counts)).toEqual({ '9': 1, '8': 1, '7': 1, USD6: 1, '4': 1 });
  });

  it('loads the narrowest band at its widest, so a rule below 320px is seen', () => {
    expect(
      home.widthsToProbe('@media (max-width: 319px) {}', [320, 390, 768, 1024, 1280, 1440, 1920]),
    ).toEqual([319]);
  });

  it('loads a width inside every band a media query marks out that no standard width falls in', () => {
    const sheet =
      '@media (max-width: 620px) {} @media (min-width: 1921px) {} @media (700px <= width < 48em) {}';
    expect(home.widthsToProbe(sheet, [320, 390, 768, 1024, 1280, 1440, 1920])).toEqual([
      660, 734, 1921,
    ]);
  });
});
