import { existsSync, readdirSync, readFileSync } from 'node:fs';

// Guards that docs/guide/api-reference.md lists EVERY public export. It parses each barrel for exported
// names (values + types) and asserts each appears — backtick-wrapped — somewhere on the reference page. So a new
// export can't merge without being documented. One-way by design: it catches undocumented *additions*, not stale
// entries for a *removed* export (prune those in review).
// DERIVED from the workspace, not written down. Every package's `exports` map names its public entries, and
// each entry maps to `src/<name>/index.ts` or `src/<name>.ts` — the same rule `scripts/build.mjs` uses to pick
// its esbuild entries. Hardcoding the list meant the driver topology was spelled out in four places (here, the
// build, each manifest, and `scripts/smoke.cjs`); splitting the drivers into their own packages would have
// required editing all four, and forgetting this one would have silently stopped guarding three surfaces.
//
// `./driver-kit` is included deliberately. It is the contract a storage-driver package builds against, so it
// is public API with the same documentation obligation as anything else — and being a surface nobody imports
// by accident, it is exactly the kind that rots undocumented.
const BARRELS: readonly string[] = (() => {
  const root = new URL('../../', import.meta.url);
  const workspace = readdirSync(new URL('packages/', root), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: string[] = [];
  for (const pkg of workspace) {
    const manifest = JSON.parse(
      readFileSync(new URL(`packages/${pkg}/package.json`, root), 'utf8'),
    ) as {
      exports?: Record<string, unknown>;
    };
    for (const key of Object.keys(manifest.exports ?? { '.': null })) {
      const name = key === '.' ? 'index' : key.replace(/^\.\//, '');
      for (const candidate of [`${name}/index.ts`, `${name}.ts`]) {
        const rel = `../../packages/${pkg}/src/${candidate}`;
        if (existsSync(new URL(rel, import.meta.url))) {
          out.push(rel);
          break;
        }
      }
    }
  }
  return out;
})();
const DOC_PATH = '../../docs/guide/api-reference.md';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Every identifier a barrel exports — from `export {…}` / `export type {…}` re-exports and inline `export`s. */
function exportedNames(src: string): string[] {
  // Strip comments first so a `export {` inside a JSDoc example can't produce a phantom name.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const names = new Set<string>();
  // `export { A, B as C } from '…'` and `export type { A, B } from '…'` (multi-line; no braces inside a list).
  for (const block of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of (block[1] ?? '').split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  // Inline declarations: export (interface|class|type|function|const) Name
  for (const decl of code.matchAll(
    /export\s+(?:abstract\s+)?(?:interface|class|type|function|const)\s+([A-Za-z0-9_]+)/g,
  )) {
    const name = decl[1];
    if (name) names.add(name);
  }
  return [...names];
}

describe('API reference (docs/guide/api-reference.md) is in sync with the exported surface', () => {
  const doc = read(DOC_PATH);
  // The check is scoped to the "Complete export index" section, which the page itself calls the completeness
  // anchor. Matching the whole page instead let five new exports (`MemoryStorage`, `LocalFsStorage`,
  // `StorageBackend` and their option types) count as documented purely because they were named in a table or
  // in prose elsewhere — so the one section whose job is to be exhaustive was the only one not checked.
  const INDEX_HEADING = '## Complete export index';
  const indexStart = doc.indexOf(INDEX_HEADING);
  if (indexStart === -1) throw new Error(`api-reference.md is missing "${INDEX_HEADING}"`);
  const exportIndex = doc.slice(indexStart);

  for (const barrel of BARRELS) {
    const label = barrel.replace('../../', '');
    it(`documents every export from ${label}`, () => {
      const src = read(barrel);
      // `export *` would let names slip past this guard, so it is only allowed when it re-exports a barrel that
      // this test ALSO parses. The roaring facade legitimately does `export * from '@cloudbitmaps/core'` (the
      // family split makes the flavor package the one name to know), and core's own barrel is in BARRELS above —
      // so every name is still checked. Any OTHER star-export is rejected.
      // Allowed star forms: the flavor re-exporting core's barrel, and a flavor driver barrel re-exporting
      // core's same-named driver barrel. Both targets are parsed by this test, so no name escapes.
      const ALLOWED_STAR = /^export \* from '@cloudbitmaps\/core(\/[a-z0-9]+)?';$/;
      // Scan COMMENT-STRIPPED source (as `exportedNames` does) so prose mentioning `export *` isn't a hit.
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const stars = codeOnly.match(/export\s+\*[^\n]*/g) ?? [];
      expect(
        stars.filter((line) => !ALLOWED_STAR.test(line.trim())),
        `${label}: use explicit named exports (no \`export *\`) so the sync guard sees every name — ` +
          `the only exception is re-exporting a barrel this test also parses`,
      ).toEqual([]);
      const missing = exportedNames(src).filter((name) => !exportIndex.includes(`\`${name}\``));
      expect(
        missing,
        `export(s) missing from the "Complete export index" section of docs/guide/api-reference.md: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('extracts a sane number of exports (guards against the parser silently matching nothing)', () => {
    const total = BARRELS.reduce((n, b) => n + exportedNames(read(b)).length, 0);
    expect(total).toBeGreaterThan(100);
  });
});
