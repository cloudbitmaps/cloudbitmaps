import { existsSync, readdirSync, readFileSync } from 'node:fs';

// Guards that docs/guide/api-reference.md and the exported surface describe the same thing, in BOTH
// directions. Forward: every name a barrel exports appears — backtick-wrapped — in the "Complete export
// index", so a new export cannot merge undocumented. Reverse: every identifier-shaped name in that index is
// really exported, so a *removed* export cannot leave a stale entry behind.
//
// A one-way guard leaves the doc's accuracy resting on someone noticing a removed export, and a change that
// curates an entry point can remove many at once: exactly the change where there is the most to notice. A
// reader cannot tell a stale entry from a real one; it reads as API that exists.
// DERIVED from the workspace, not written down. Every package's `exports` map names its public entries, and
// each entry maps to `src/<name>/index.ts` or `src/<name>.ts` — the same rule `scripts/build.mjs` uses to pick
// its esbuild entries. A hardcoded list here would repeat each manifest's `exports`, so a new package or subpath
// would mean editing both, and forgetting this one would silently leave that surface unguarded.
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
  // Inline declarations: `export <modifiers> <kind> Name`.
  //
  // The modifier list is `(declare|abstract|async)*` and the kinds include `enum`, `let` and `var` because a
  // pattern that sees only `export function` extracts nothing from `export async function`, `export enum`,
  // `export declare const`, `export let` or `export var`, so an undocumented public export in any of those
  // spellings keeps this gate green. In an async-first library `export async function` is the likely
  // spelling, which makes that gap the common case rather than an exotic one.
  for (const decl of code.matchAll(
    /export\s+(?:(?:declare|abstract|async)\s+)*(?:interface|class|type|function|const|let|var|enum)\s+([A-Za-z0-9_$]+)/g,
  )) {
    const name = decl[1];
    if (name) names.add(name);
  }
  return [...names];
}

/** The entry a barrel file is, as the index's headings name it: `@cloudbitmaps/roaring`, `@cloudbitmaps/core/driver-kit`. */
function entryOf(barrel: string): string {
  const [, pkg, file] = /packages\/([^/]+)\/src\/(.+)\.ts$/.exec(barrel) ?? [];
  if (pkg === undefined || file === undefined) throw new Error(`not a package barrel: ${barrel}`);
  return file === 'index' ? `@cloudbitmaps/${pkg}` : `@cloudbitmaps/${pkg}/${file}`;
}

describe('API reference (docs/guide/api-reference.md) is in sync with the exported surface', () => {
  const doc = read(DOC_PATH);
  // The check is scoped to the "Complete export index" section, which the page itself calls the completeness
  // anchor. Matching the whole page instead lets an export count as documented purely because a table or a
  // sentence elsewhere names it, so the one section whose job is to be exhaustive would be the only one not
  // checked.
  const INDEX_HEADING = '## Complete export index';
  const indexStart = doc.indexOf(INDEX_HEADING);
  if (indexStart === -1) throw new Error(`api-reference.md is missing "${INDEX_HEADING}"`);
  const exportIndex = doc.slice(indexStart);

  /** The index's text under every `### \`<entry>\`` heading, so a name is held to the entry it is exported from. */
  const sectionsOf = (entry: string): string => {
    const heading = new RegExp(
      `^### \`${entry.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')}\`(?: .*)?$`,
      'm',
    );
    const chunks: string[] = [];
    let rest = exportIndex;
    for (let m = heading.exec(rest); m !== null; m = heading.exec(rest)) {
      const after = rest.slice(m.index + m[0].length);
      const next = after.search(/^##/m);
      chunks.push(next === -1 ? after : after.slice(0, next));
      rest = next === -1 ? '' : after.slice(next);
    }
    return chunks.join('\n');
  };

  /**
   * What each entry's section must list. The flavor lists everything it exports; core's main entry lists only
   * what the flavor does not re-export, so a name sits under the one heading an application would look under.
   */
  const exportedBy = (() => {
    const byEntry = new Map(BARRELS.map((b) => [entryOf(b), new Set(exportedNames(read(b)))]));
    const flavor = byEntry.get('@cloudbitmaps/roaring');
    const coreMain = byEntry.get('@cloudbitmaps/core');
    if (flavor === undefined || coreMain === undefined) throw new Error('missing a barrel');
    byEntry.set('@cloudbitmaps/core', new Set([...coreMain].filter((n) => !flavor.has(n))));
    return byEntry;
  })();

  for (const barrel of BARRELS) {
    const label = barrel.replace('../../', '');
    const entry = entryOf(barrel);
    it(`documents every export from ${label}`, () => {
      const src = read(barrel);
      // `export *` would let names slip past this guard, and it would make an entry's surface whatever another
      // package exports. Every entry names what it exports, so adding a name is a change to this file's barrel
      // and to the index, on purpose.
      // Scan COMMENT-STRIPPED source (as `exportedNames` does) so prose mentioning `export *` isn't a hit.
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const stars = codeOnly.match(/export\s+\*[^\n]*/g) ?? [];
      expect(
        stars,
        `${label}: use explicit named exports (no \`export *\`) so the sync guard sees every name`,
      ).toEqual([]);
      const section = sectionsOf(entry);
      expect(section, `the index has no "### \`${entry}\`" section`).not.toBe('');
      const missing = [...(exportedBy.get(entry) ?? [])].filter(
        (name) => !section.includes(`\`${name}\``),
      );
      expect(
        missing,
        `export(s) missing from the \`${entry}\` section of the "Complete export index" in docs/guide/api-reference.md: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('lists no export that no longer exists, or under an entry that does not export it (the reverse direction)', () => {
    // Only names in a `·`-joined RUN count as index entries. That is how every list on this page is written,
    // and it is what separates an entry from a prose mention: the driver sections describe options in
    // sentences (`containerClient`, `connectionString`, a GCS client called `storage`) that are backticked
    // identifiers but name nothing this workspace exports. A shape test alone flags those; requiring the
    // separator reads the page's own structure instead. Under-coverage is the safe direction here — a lone
    // entry outside a run would go unchecked, whereas over-firing would teach people to route around this.
    const RUN = /`[A-Za-z_$][A-Za-z0-9_$]*`(?:\s*·\s*`[A-Za-z_$][A-Za-z0-9_$]*`)+/g;
    for (const [entry, names] of exportedBy) {
      const cited = (sectionsOf(entry).match(RUN) ?? []).flatMap((run) =>
        [...run.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''),
      );
      const stale = [...new Set(cited)].filter((name) => !names.has(name));
      expect(
        stale,
        `the \`${entry}\` section of the "Complete export index" lists name(s) that entry does not export (or, for core, that the flavor re-exports too) — prune them: ${stale.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('extracts a sane number of exports (guards against the parser silently matching nothing)', () => {
    const total = BARRELS.reduce((n, b) => n + exportedNames(read(b)).length, 0);
    expect(total).toBeGreaterThan(100);
  });
});
