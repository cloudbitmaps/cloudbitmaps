import { readFileSync } from 'node:fs';

// Guards that docs/guide/api-reference.md lists EVERY public export. It parses each barrel for exported
// names (values + types) and asserts each appears — backtick-wrapped — somewhere on the reference page. So a new
// export can't merge without being documented. One-way by design: it catches undocumented *additions*, not stale
// entries for a *removed* export (prune those in review).
const BARRELS = [
  // Both package barrels: the roaring facade (what users import) AND the codec-agnostic core barrel it
  // re-exports via `export *`. Checking core explicitly matters because a star-export contributes no names to
  // parse — without it, core's surface would silently escape the doc guard after the family split.
  '../../packages/roaring/src/index.ts',
  '../../packages/core/src/index.ts',
  // The driver subpaths live in core; the roaring package's same-named barrels are one-line re-exports of these.
  '../../packages/core/src/s3/index.ts',
  '../../packages/core/src/dynamodb/index.ts',
  '../../packages/core/src/gcs/index.ts',
  '../../packages/core/src/azure/index.ts',
  '../../packages/core/src/postgres/index.ts',
  '../../packages/core/src/redis/index.ts',
  '../../packages/core/src/mongodb/index.ts',
  '../../packages/core/src/cassandra/index.ts',
  '../../packages/core/src/mysql/index.ts',
  // The flavor's own driver barrels are declared entry points too (`@cloudbitmaps/roaring/s3`, …). They are
  // one-line re-exports of core's equivalents today, but they ARE public surface — parse them so an own export
  // added to one can't become public undocumented.
  '../../packages/roaring/src/s3/index.ts',
  '../../packages/roaring/src/dynamodb/index.ts',
  '../../packages/roaring/src/gcs/index.ts',
  '../../packages/roaring/src/azure/index.ts',
  '../../packages/roaring/src/postgres/index.ts',
  '../../packages/roaring/src/redis/index.ts',
  '../../packages/roaring/src/mongodb/index.ts',
  '../../packages/roaring/src/cassandra/index.ts',
  '../../packages/roaring/src/mysql/index.ts',
] as const;
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
      const missing = exportedNames(src).filter((name) => !doc.includes(`\`${name}\``));
      expect(
        missing,
        `undocumented export(s) — add to docs/guide/api-reference.md: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('extracts a sane number of exports (guards against the parser silently matching nothing)', () => {
    const total = BARRELS.reduce((n, b) => n + exportedNames(read(b)).length, 0);
    expect(total).toBeGreaterThan(100);
  });
});
