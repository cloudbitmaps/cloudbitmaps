import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A published package ships only the declaration files a consumer can reach from its `exports` map.
 *
 * tsc writes one `.d.ts` per source file while esbuild bundles the JavaScript, so without a prune every internal
 * module (the conformance suite, the fuzz harnesses, the decoder internals) would ship a declaration that no
 * public declaration imports and no `exports` entry names. This test reads each package's built `dist/` and
 * names every such file. It needs `pnpm build` to have run first, like `scripts/smoke.cjs`.
 *
 * The first block fires the walk itself at a planted tree, in both directions: what it must keep (nested
 * conditions, `.js` and directory specifiers, `import()` type queries, cycles) and what it must not follow
 * (a bare specifier to another package).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { unreachableDeclarations, pruneUnreachable } = createRequire(import.meta.url)(
  '../../scripts/lib/reachable-declarations.cjs',
) as {
  unreachableDeclarations: (pkgDir: string) => string[];
  pruneUnreachable: (pkgDir: string) => number;
};

const PACKAGES = readdirSync(join(ROOT, 'packages'));

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

describe('the shipped declarations of each package', () => {
  it.each(PACKAGES)('%s ships no declaration its exports cannot reach', (pkg) => {
    const dir = join(ROOT, 'packages', pkg);
    expect(readdirSync(dir), `packages/${pkg}/dist is missing: run pnpm build first`).toContain(
      'dist',
    );
    expect(unreachableDeclarations(dir)).toEqual([]);
  });
});
