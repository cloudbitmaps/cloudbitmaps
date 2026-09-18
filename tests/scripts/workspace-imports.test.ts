import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every name our own `scripts/`, `bench/` and `fuzz/` code imports from a workspace package must actually be
 * exported by it.
 *
 * WHY THIS FILE EXISTS. Curating core's public surface removed `drainRegistry`, `DEFAULT_MAX_SCAN_SEGMENTS`,
 * `CrbmWriter` and `BufferSink`. `packages/roaring` re-exports core with `export *`, so they vanished from the
 * flavor too — and two committed scripts destructure them from exactly there:
 *
 *   bench/scale.cjs   → TypeError: drainRegistry is not a function
 *   fuzz/seed-corpus.cjs → TypeError: BufferSink is not a constructor
 *
 * Both shipped on `main` through a full green gate and fourteen CI checks, because nothing in this repo
 * compares these three directories against the published surface. They are plain `.cjs`/`.mjs`, so
 * `tsc` never sees them; they are not imported by any test, so `vitest` never loads them; and the workflows
 * that run them are nightly or manual, so no PR check executes them. The failure is a *runtime* one in files
 * the type system has no opinion about.
 *
 * What made it worth a gate rather than more care is that this is the THIRD time. `harness-options.test.ts`
 * exists because `bench/scale.cjs` shipped broken once before — but it compares *store-option keys*, has no
 * notion of imported symbol names, and does not glob `fuzz/` at all. So the sibling gate was in place and
 * still could not see this.
 *
 * Resolution is against the SOURCE barrels, not `dist/`, so this runs in a clean checkout without a build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `@cloudbitmaps/<pkg>` (and its subpaths) → the barrel that defines its surface. Derived, not listed. */
function barrelFor(spec: string): string | null {
  const m = /^@cloudbitmaps\/([a-z0-9-]+)(?:\/(.+))?$/.exec(spec);
  if (m === null) return null;
  const [, pkg, subpath] = m;
  const base = join(ROOT, 'packages', pkg ?? '');
  if (!existsSync(base)) return null;
  const file = subpath === undefined ? 'index.ts' : `${subpath}.ts`;
  const abs = join(base, 'src', file);
  return existsSync(abs) ? abs : null;
}

/** Names a barrel exports, following the one `export *` form the repo permits (the flavor re-exporting core). */
function exportedNames(barrel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(barrel)) return new Set();
  seen.add(barrel);
  const code = readFileSync(barrel, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const names = new Set<string>();
  for (const block of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const entry of (block[1] ?? '').split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  for (const decl of code.matchAll(
    /export\s+(?:abstract\s+)?(?:interface|class|type|function|const)\s+([A-Za-z0-9_$]+)/g,
  ))
    if (decl[1]) names.add(decl[1]);
  // `export * from '@cloudbitmaps/core'` — the flavor's wholesale re-export. Follow it, or every name a
  // script legitimately reaches through the flavor would look unexported.
  for (const star of code.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
    const target = barrelFor(star[1] ?? '');
    if (target !== null) for (const n of exportedNames(target, seen)) names.add(n);
  }
  return names;
}

/** `const { a, b } = require('@cloudbitmaps/x')` and `import { a, b } from '@cloudbitmaps/x'`. */
function destructuredImports(src: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  const push = (raw: string, spec: string): void => {
    const names = raw
      .split(',')
      .map(
        (e) =>
          e
            .split(':')[0]
            ?.trim()
            .split(/\s+as\s+/)[0]
            ?.trim() ?? '',
      )
      .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
    if (names.length > 0) out.push({ spec, names });
  };
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*'([^']+)'\s*\)/g))
    push(m[1] ?? '', m[2] ?? '');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g))
    push(m[1] ?? '', m[2] ?? '');
  return out;
}

const files = execFileSync('git', ['ls-files', 'scripts/*', 'bench/*', 'fuzz/*'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => /\.(cjs|mjs|js)$/.test(f));

describe('scripts/, bench/ and fuzz/ import only names the workspace actually exports', () => {
  it('is reaching all three directories, and the two files that broke', () => {
    // A guard that stopped globbing one of these would pass silently, which is how this got through twice.
    expect(files).toContain('bench/scale.cjs');
    expect(files).toContain('fuzz/seed-corpus.cjs');
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const bad: string[] = [];
    for (const { spec, names } of destructuredImports(src)) {
      const barrel = barrelFor(spec);
      if (barrel === null) continue; // not a workspace package — node_modules' problem, not ours
      const exported = exportedNames(barrel);
      for (const name of names)
        if (!exported.has(name))
          bad.push(`${rel}: ${spec} does not export \`${name}\` — this file throws at runtime`);
    }
    expect(bad).toEqual([]);
  });
});
