import { createRequire } from 'node:module';

/**
 * The specifier detectors read the parser's tree, not quote pairs and not a guess at what a `/` means. Each row is a
 * form a quote-pairing or token-guessing reader got wrong or could: a division or a regular expression literal that
 * holds a quote, placed before the string a detector must find. Every row is run through both detectors, once with
 * `node:fs` and once with a cloud SDK name, and each must find the specifier.
 */
const require_ = createRequire(import.meta.url);
const { findBuiltinSpecifiers } = require_('../../scripts/builtin-free.cjs') as {
  findBuiltinSpecifiers: (source: string) => string[];
};
const { findSdkSpecifiers } = require_('../../scripts/sdk-specifiers.cjs') as {
  findSdkSpecifiers: (source: string) => string[];
};
const { blankComments } = require_('../../scripts/js-tokens.cjs') as {
  blankComments: (source: string) => string;
};

// Each row is [label, a chunk ending in `require('node:fs')`].
const ROWS: [string, string][] = [
  [
    'division after a call, then a quote',
    `const avg = sum(xs) / count(xs); const q = "'"; require('node:fs');`,
  ],
  ['division after a call, regex-looking rhs', `const r = f(a) / 2 / g("'"); require('node:fs');`],
  [
    'division after member call, quote on the rhs',
    `const h = Math.max(a, b) / parseInt("'1"); require('node:fs');`,
  ],
  ['division after an index', `const x = arr[i] / 2; const q = "'"; require('node:fs');`],
  ['division after a template', "const x = `${a}` / 2; const q = \"'\"; require('node:fs');"],
  ['regex after } of a block', `if (x) { y(); } /'/.test(s); require('node:fs');`],
  ['regex after } of a function decl', `function f() {}\n/'/g.test(s); require('node:fs');`],
  ['regex after } of an object literal in an arg list', `f({ a: 1 }, /'/g); require('node:fs');`],
  ['regex after } of an arrow body (ASI)', `const f = () => {}\n/'/g.test(s); require('node:fs');`],
  [
    'object literal then division (rare, real JS divides)',
    `const n = ({}).x; const m = {}.valueOf / 2; const q = "'"; require('node:fs');`,
  ],
  ['regex after if (x) header (stated limit)', `if (x) /'/.test(s); require('node:fs');`],
  ['regex after while (x) header', `while (m = /'/g.exec(s)) n++; require('node:fs');`],
  ['regex after for (...) header', `for (;;) /'/.test(s); require('node:fs');`],
  [
    'division after an identifier named number',
    `const half = number / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named type',
    `const t = opts.type / 2; const q = "'"; require('node:fs');`,
  ],
  ['division after an identifier named of', `const r = of / 2; const q = "'"; require('node:fs');`],
  [
    'division after an identifier named get',
    `const r = get / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after an identifier named string',
    `const r = string.length / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named size (control)',
    `const r = s.size / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named set',
    `const r = m.set / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named module',
    `const r = m.module / 2; const q = "'"; require('node:fs');`,
  ],
  ['division after undefined', `const r = undefined / 2; const q = "'"; require('node:fs');`],
  [
    'division after a property named any',
    `const r = stats.any / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named from',
    `const span = range.to - range.from / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named object',
    `const r = sizes.object / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named global',
    `const r = c.global / 2; const q = "'"; require('node:fs');`,
  ],
  ['division after a property named is', `const r = c.is / 2; const q = "'"; require('node:fs');`],
  [
    'division after a property named out',
    `const r = c.out / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named keyof',
    `const r = c.keyof / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named await (esm module)',
    `const r = c.await / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named delete',
    `const r = c.delete / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named default',
    `const r = c.default / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named new',
    `const r = c.new / 2; const q = "'"; require('node:fs');`,
  ],
  ['division after a property named in', `const r = c.in / 2; const q = "'"; require('node:fs');`],
  [
    'division after a property named return',
    `const r = c.return / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named typeof',
    `const r = c.typeof / 2; const q = "'"; require('node:fs');`,
  ],
  [
    'division after a property named class',
    `const r = c.class / 2; const q = "'"; require('node:fs');`,
  ],
  ['template holding an escaped backtick', "const t = `a\\`b'`; require('node:fs');"],
  [
    'template holding ${ inside a string in a substitution',
    "const t = `a${'${'}b'`; require('node:fs');",
  ],
  ['string holding ${ and a backtick', "const s = '${`'; require('node:fs');"],
  ['nested template', "const t = `a${`b${c}'`}d`; require('node:fs');"],
  ['object literal inside a substitution', "const t = `${ { a: 1 }.a }'`; require('node:fs');"],
  [
    'arrow with block body inside a substitution',
    "const t = `${(() => { return '}'; })()}`; require('node:fs');",
  ],
  ['regex inside a substitution', "const t = `${/'}/.source}`; require('node:fs');"],
  ['division inside a substitution after }', "const t = `${a}${b / 2}'`; require('node:fs');"],
  ['tagged template, raw escapes', "const t = String.raw`\\u{'`; require('node:fs');"],
  ['quote in a line comment', `// don't\nrequire('node:fs');`],
  ['quote in a block comment', `/* it's */ require('node:fs');`],
  ['comment between ) and a /', `const a = f(x) /* ' */ / 2; const q = "'"; require('node:fs');`],
  [
    'comment before a regex after return',
    `function f(s) { return /* x */ /'/.test(s); } require('node:fs');`,
  ],
  ['hashbang', `#!/usr/bin/env node\nrequire('node:fs');`],
  ['escaped specifier', `require('node\\x3afs');`],
  ['regex with a / in a class', `const r = /[/']/g; require('node:fs');`],
  ['regex v flag', `const r = /[\\p{L}--['"]]/v; require('node:fs');`],
  [
    'private field divide',
    `class A { #n = 4; f() { return this.#n / 2; } } const q = "'"; require('node:fs');`,
  ],
  ['postfix ++ divide', `let i = 0; const r = i++ / 2; const q = "'"; require('node:fs');`],
  ['division after a bigint', `const r = 10n / 2n; const q = "'"; require('node:fs');`],
  ['optional chain call divide', `const r = a?.b() / 2; const q = "'"; require('node:fs');`],
  ['yield regex', `function* g() { yield /'/; } require('node:fs');`],
  ['await regex', `async function g() { await /'/; } require('node:fs');`],
  ['typeof regex', `const t = typeof /'/; require('node:fs');`],
  ['label then regex', `L: /'/.test(s); require('node:fs');`],
  ['case then regex', `switch (x) { case /'/.source: } require('node:fs');`],
];

describe('a detector finds a specifier after a form that confuses a guess', () => {
  it.each(ROWS)('%s (builtin)', (_label, source) => {
    expect(findBuiltinSpecifiers(source)).toEqual(['node:fs']);
  });
  // An escaped specifier (`'node\\x3afs'`) has no `node:fs` text to swap for an SDK name.
  it.each(ROWS.filter(([label]) => !label.includes('escaped')))('%s (sdk)', (_label, source) => {
    expect(findSdkSpecifiers(source.replaceAll('node:fs', '@aws-sdk/client-s3'))).toEqual([
      '@aws-sdk/client-s3',
    ]);
  });
});

describe('a keyword-shaped name before a division is not read as a regular expression', () => {
  const KEYWORD_NAMES = [
    'number',
    'of',
    'get',
    'undefined',
    'string.length',
    'opts.type',
    'm.set',
    'm.module',
    'stats.any',
    'range.from',
    'sizes.object',
    'c.global',
    'c.is',
    'c.out',
    'c.keyof',
    'c.await',
    'c.delete',
    'm.default',
    'c.new',
    'c.in',
    'c.return',
    'c.typeof',
    'c.class',
  ];
  it.each(KEYWORD_NAMES)('%s / 2', (name) => {
    const source = `const r = ${name} / 2; const q = "'"; require('node:fs');`;
    expect(findBuiltinSpecifiers(source)).toEqual(['node:fs']);
    expect(findSdkSpecifiers(source.replace('node:fs', '@aws-sdk/client-s3'))).toEqual([
      '@aws-sdk/client-s3',
    ]);
  });
  it('a regular expression after the header of a for loop', () => {
    expect(findBuiltinSpecifiers(`for (;;) /'/.test(s); require('node:fs');`)).toEqual(['node:fs']);
  });
});

describe('a template with a substitution is read by its literal head', () => {
  it.each([
    ['a dynamic import', 'import(`@aws-sdk/client-${svc}`)'],
    ['a require', 'require(`@google-cloud/${name}`)'],
  ])('%s', (_label, source) => {
    expect(findSdkSpecifiers(source).length).toBe(1);
  });
  it.each([
    ['prose naming the SDK', 'throw new Error(`install @aws-sdk/client-s3 for ${svc}`);'],
    ['an unrelated head', 'f(`hello ${name}`)'],
  ])('%s does not fire', (_label, source) => {
    expect(findSdkSpecifiers(source)).toEqual([]);
  });
});

describe('a specifier named only in a comment is not found', () => {
  it('in a line comment, a block comment and a JSDoc', () => {
    const source =
      "// require('node:fs')\n/* require('@aws-sdk/client-s3') */\n/** import('node:path') */\nconst x = 1;";
    expect(findBuiltinSpecifiers(source)).toEqual([]);
    expect(findSdkSpecifiers(source)).toEqual([]);
  });
});

describe('blankComments', () => {
  it('blanks each comment to spaces of the same length, newlines kept, and nothing else', () => {
    const source = `const a = 1; // tail "q\nconst r = /["']/g; /* a\n b */ const s = '// not a comment';`;
    const out = blankComments(source);
    expect(out).toHaveLength(source.length);
    expect(out.split('\n').map((l) => l.length)).toEqual(source.split('\n').map((l) => l.length));
    expect(out).toContain(`/["']/g`);
    expect(out).toContain(`'// not a comment'`);
    expect(out).not.toContain('tail');
    expect(out).not.toContain('b */');
  });
  it('still finds the comment after a regular expression literal that holds a quote', () => {
    const out = blankComments(`const r = /["']/g; // it's "x"\nconst z = 1;`);
    expect(out).not.toContain('it');
    expect(out).toContain('const z = 1;');
  });
});
