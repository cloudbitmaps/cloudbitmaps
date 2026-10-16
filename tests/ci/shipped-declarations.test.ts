import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A published package ships only the declaration files a consumer can reach from its `exports` map.
 *
 * tsc writes one `.d.ts` per source file while esbuild bundles the JavaScript, so without a prune every internal
 * module (the conformance suite, the fuzz harnesses, the decoder internals) would ship a declaration that no
 * public declaration imports and no `exports` entry names. `scripts/smoke.cjs` checks each built package's
 * `dist/` against the TypeScript compiler, after the build. This file needs no build: it fires the walk at planted trees, in
 * both directions: what it must keep (nested conditions, `.js` and directory specifiers, `import()` type
 * queries, cycles) and what it must not follow (a bare specifier to another package).
 */
const { unreachableDeclarations, pruneUnreachable } = createRequire(import.meta.url)(
  '../../scripts/lib/reachable-declarations.cjs',
) as {
  unreachableDeclarations: (pkgDir: string) => string[];
  pruneUnreachable: (pkgDir: string) => number;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package directory with `package.json` and the given files under it. */
function plant(manifest: object, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'reachable-dts-'));
  temps.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe('the declaration reachability walk', () => {
  const manifest = {
    name: 'planted',
    exports: {
      '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
      './kit': { types: './dist/kit.d.ts', default: './dist/kit.js' },
    },
  };

  it('keeps what an entry reaches and names the rest', () => {
    const dir = plant(manifest, {
      'dist/index.d.ts': [
        "export * from './a.js';",
        "export type { B } from './sub';",
        "export type C = import('./c.js').C;",
        "// import { X } from './only-in-a-comment.js';",
      ].join('\n'),
      'dist/kit.d.ts': "export * from './kit-part.js';",
      'dist/kit-part.d.ts': "export * from './kit.js';",
      'dist/a.d.ts': "export * from './cycle-b.js'; export type { Dep } from '@cloudbitmaps/core';",
      'dist/cycle-b.d.ts': "export * from './a.js';",
      'dist/sub/index.d.ts': 'export type B = 1;',
      'dist/c.d.ts': 'export type C = 1;',
      'dist/stray.d.ts': "export * from './stray-dep.js';",
      'dist/stray-dep.d.ts': 'export {};',
      'dist/only-in-a-comment.d.ts': 'export {};',
      'dist/deep/dir/stray.d.ts': 'export {};',
      'dist/index.js': '',
    });
    expect(unreachableDeclarations(dir)).toEqual([
      'dist/deep/dir/stray.d.ts',
      'dist/only-in-a-comment.d.ts',
      'dist/stray-dep.d.ts',
      'dist/stray.d.ts',
    ]);
  });

  it('does not follow a bare specifier into the package of the same name', () => {
    const dir = plant(manifest, {
      'dist/index.d.ts': "export * from 'kit-part';",
      'dist/kit.d.ts': 'export {};',
      'dist/kit-part.d.ts': 'export {};',
    });
    expect(unreachableDeclarations(dir)).toEqual(['dist/kit-part.d.ts']);
  });

  it('honours a top-level types field', () => {
    const dir = plant(
      { name: 'planted', types: './dist/main.d.ts' },
      { 'dist/main.d.ts': "export * from './x.js';", 'dist/x.d.ts': '', 'dist/y.d.ts': '' },
    );
    expect(unreachableDeclarations(dir)).toEqual(['dist/y.d.ts']);
  });

  it('prunes the strays and the directories they leave empty', () => {
    const dir = plant(manifest, {
      'dist/index.d.ts': 'export {};',
      'dist/kit.d.ts': 'export {};',
      'dist/deep/dir/stray.d.ts': 'export {};',
      'dist/keep/a.d.ts': 'export {};',
    });
    writeFileSync(join(dir, 'dist/index.d.ts'), "export * from './keep/a.js';");
    expect(pruneUnreachable(dir)).toBe(1);
    expect(readdirSync(join(dir, 'dist')).sort()).toEqual(['index.d.ts', 'keep', 'kit.d.ts']);
  });
});

describe('the walk fails closed on what it cannot classify', () => {
  const entry = { '.': { types: './dist/index.d.ts' } };
  const base = { 'dist/index.d.ts': 'export {};' };
  const cases: [string, object, Record<string, string>, RegExp][] = [
    [
      'a missing types root',
      { name: 'p', types: './dist/none.d.ts' },
      base,
      /types root does not exist/,
    ],
    ['no types root at all', { name: 'p' }, base, /names no `types` root/],
    [
      'an unresolvable relative specifier',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from './gone.js';" },
      /resolves to no \.d\.ts/,
    ],
    [
      'a reference path directive',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': '/// <reference path="./x.d.ts" />' },
      /reference path\|types/,
    ],
    [
      'a reference types directive',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': '/// <reference types="./x" />' },
      /reference path\|types/,
    ],
    [
      'an .mjs specifier',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from './x.mjs';" },
      /\.mjs\/\.cjs/,
    ],
    [
      'a .cjs specifier',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from './x.cjs';" },
      /\.mjs\/\.cjs/,
    ],
    [
      'a .d.mts output',
      { name: 'p', exports: entry },
      { ...base, 'dist/x.d.mts': '' },
      /\.d\.mts\/\.d\.cts output/,
    ],
    [
      'a .d.cts output',
      { name: 'p', exports: entry },
      { ...base, 'dist/x.d.cts': '' },
      /\.d\.mts\/\.d\.cts output/,
    ],
    [
      'an array target',
      { name: 'p', exports: { '.': [{ types: './dist/index.d.ts' }] } },
      base,
      /target must be an object/,
    ],
    [
      'a string target',
      { name: 'p', exports: { '.': './dist/index.js' } },
      base,
      /target must be an object/,
    ],
    [
      'a target without types',
      { name: 'p', exports: { '.': { import: './dist/index.js' } } },
      base,
      /no "types" condition/,
    ],
    [
      'a types array',
      { name: 'p', exports: { '.': { types: ['./dist/index.d.ts'] } } },
      base,
      /"types" must be a string/,
    ],
    [
      'a versioned types condition',
      { name: 'p', exports: { '.': { 'types@<5': './dist/index.d.ts' } } },
      base,
      /versioned condition/,
    ],
    [
      'a wildcard subpath',
      { name: 'p', exports: { './*': { types: './dist/*.d.ts' } } },
      base,
      /wildcard subpaths/,
    ],
    [
      'a manifest imports field',
      { name: 'p', exports: entry, imports: { '#x': './x.js' } },
      base,
      /"imports" is not supported/,
    ],
    [
      'a # specifier',
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from '#internal';" },
      /'#…' import specifier/,
    ],
    [
      'a declaration map',
      { name: 'p', exports: entry },
      { ...base, 'dist/index.d.ts.map': '{}' },
      /declaration maps/,
    ],
  ];

  it.each(cases)('throws on %s', (_name, manifest, files, message) => {
    const dir = plant(manifest, files);
    expect(() => unreachableDeclarations(dir)).toThrow(message);
    expect(() => pruneUnreachable(dir)).toThrow(message);
  });

  it('leaves every file in place when it throws', () => {
    const dir = plant(
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from './gone.js';", 'dist/other.d.ts': 'export {};' },
    );
    expect(() => pruneUnreachable(dir)).toThrow();
    expect(readdirSync(join(dir, 'dist')).sort()).toEqual(['index.d.ts', 'other.d.ts']);
  });

  it('accepts a lib reference, a blocked null subpath and a bare import', () => {
    const dir = plant(
      { name: 'p', exports: { ...entry, './internal': null } },
      {
        'dist/index.d.ts': '/// <reference lib="es2022" />\nexport * from "node:fs";',
        'dist/stray.d.ts': '',
      },
    );
    expect(unreachableDeclarations(dir)).toEqual(['dist/stray.d.ts']);
  });

  it('resolves a relative package directory instead of wiping every declaration', () => {
    const dir = plant(
      { name: 'p', exports: entry },
      { 'dist/index.d.ts': "export * from './a.js';", 'dist/a.d.ts': '', 'dist/stray.d.ts': '' },
    );
    const rel = relative(process.cwd(), dir);
    expect(unreachableDeclarations(rel)).toEqual(['dist/stray.d.ts']);
    expect(pruneUnreachable(rel)).toBe(1);
    expect(readdirSync(join(dir, 'dist')).sort()).toEqual(['a.d.ts', 'index.d.ts']);
  });
});
