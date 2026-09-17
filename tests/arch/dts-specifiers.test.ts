import { createRequire } from 'node:module';

/**
 * The emitted-`.d.ts` relative-specifier detector, fired at planted inputs in BOTH directions.
 *
 * This repo's rule, from `import-boundaries.test.ts`: a rule that never matched would be a silent gap, and a
 * green gate proves nothing about it. This detector earns the treatment twice over, because TWO files depend
 * on it agreeing with itself — `scripts/build.mjs` rewrites with it and `scripts/smoke.cjs` checks with it,
 * so a form the scanner misses is a form the build does not fix AND the gate does not flag: the silent-`any`
 * failure ships with everything green.
 *
 * An adversarial review of the first draft — a bare regex inlined separately in both files — found one false
 * positive and four false negatives. The false positive is the one worth naming, because the SDK gate hit
 * the identical class first: tsc preserves JSDoc into the `.d.ts`, so a doc-comment showing a relative
 * import both failed the gate with an error asserting something false and was silently rewritten by the
 * build, editing published documentation. The remedy a contributor reaches for is to water the comment
 * down, which is the erosion these gates exist to prevent.
 */
const { findSpecifiers, allSpecifiers, rewriteSpecifiers } = createRequire(import.meta.url)(
  '../../scripts/dts-specifiers.cjs',
) as {
  findSpecifiers: (source: string) => string[];
  allSpecifiers: (source: string) => string[];
  rewriteSpecifiers: (
    source: string,
    fix: (spec: string) => string | null,
  ) => { text: string; count: number };
};

describe('the .d.ts specifier gate flags an extensionless relative import', () => {
  it.each([
    ['import … from', "import { X } from './core/engine';"],
    ['export … from', "export { X } from './core/engine';"],
    ['export * from', "export * from './core/engine';"],
    ['export * as ns from', "export * as ns from './core/engine';"],
    ['minified re-export', "export*from'./core/engine';"],
    ['type-only import', "import type { X } from './core/engine';"],
    ['side-effect import', "import './core/engine';"],
    ['dynamic / type-position import', "type T = import('./core/engine').X;"],
    ['a multi-line statement', "export {\n  X,\n} from\n  './core/engine';"],
    // Legal in a .d.ts, needs the extension exactly like `from`, and appears the moment anyone writes an
    // `export =` interop shim. The first draft missed it in the build AND the gate — a mutual blind spot.
    ['import X = require(…)', "import X = require('./core/engine');"],
    ['export import X = require(…)', "export import X = require('./core/engine');"],
    // Augmenting a relative module: `declare module './x.js'` is the nodenext-correct spelling.
    ['declare module', "declare module './core/engine' {}"],
    ['a parent-relative path', "export * from '../core/engine';"],
    ['a bare-dot directory', "export * from '.';"],
  ])('%s', (_label, source) => {
    expect(findSpecifiers(source)).toHaveLength(1);
  });
});

describe('the .d.ts specifier gate leaves a legitimate look-alike alone', () => {
  it.each([
    ['an extensioned specifier', "export * from './core/engine.js';"],
    ['an .mjs specifier', "export * from './core/engine.mjs';"],
    ['a .cjs specifier', "export * from './core/engine.cjs';"],
    ['a .json specifier — extensioned, so out of scope', "import x from './data.json';"],
    ['a bare package specifier', "export * from '@cloudbitmaps/core';"],
    ['a bare deep specifier', "export * from '@cloudbitmaps/core/s3';"],
    ['a node builtin', "import { readFile } from 'node:fs';"],
    // The false positive that matters: this is prose, and both halves must ignore it.
    [
      'a relative path inside a JSDoc block',
      "/**\n * e.g. import { X } from './my-app/wiring';\n */",
    ],
    ['a relative path inside a line comment', "// see './core/engine' for the seam"],
    ['a string literal type that looks like a path', "export type K = './core/engine';"],
    ['createRequire, not require', 'const r = createRequire(u);'],
  ])('%s', (_label, source) => {
    expect(findSpecifiers(source)).toEqual([]);
  });
});

describe('the rewrite the build applies', () => {
  it('adds the extension the resolver hands back, in every position at once', () => {
    const source = [
      "export * from './a';",
      "import X = require('./b');",
      "declare module './c' {}",
      "export * from './d.js';",
    ].join('\n');
    const { text, count } = rewriteSpecifiers(source, (s) => `${s}.js`);
    expect(count).toBe(3); // './d.js' is already extensioned
    expect(text).toBe(
      [
        "export * from './a.js';",
        "import X = require('./b.js');",
        "declare module './c.js' {}",
        "export * from './d.js';",
      ].join('\n'),
    );
  });

  it('never edits a relative path inside a comment — that is published documentation', () => {
    const source = "/** Wire it up: import { X } from './my-app/wiring'; */\nexport * from './a';";
    const { text, count } = rewriteSpecifiers(source, (s) => `${s}.js`);
    expect(count).toBe(1);
    expect(text).toContain("'./my-app/wiring'"); // untouched
    expect(text).toContain("'./a.js'");
  });

  it('leaves a specifier the resolver cannot place, so the gate reports it by name', () => {
    const { text, count } = rewriteSpecifiers("export * from './missing';", () => null);
    expect(count).toBe(0);
    expect(text).toBe("export * from './missing';");
    expect(findSpecifiers(text)).toEqual(['./missing']);
  });

  it('rewrites back-to-front, so several hits on one line all land correctly', () => {
    const source = "export type T = import('./a').X | import('./bb').Y | import('./ccc').Z;";
    const { text } = rewriteSpecifiers(source, (s) => `${s}.js`);
    expect(text).toBe(
      "export type T = import('./a.js').X | import('./bb.js').Y | import('./ccc.js').Z;",
    );
  });
});

describe('allSpecifiers — what the resolvability half of the gate walks', () => {
  it('returns extensioned and extensionless alike, still skipping comments', () => {
    const source = "export * from './a.js';\nexport * from './b';\n// './c'";
    expect(allSpecifiers(source)).toEqual(['./a.js', './b']);
  });
});
