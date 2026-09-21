import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `pnpm.overrides` entry binds to something, and SECURITY.md describes exactly the entries that exist.
 *
 * WHY THIS EXISTS. An override is a security claim: *this forced version still works, and it is protecting
 * something*. Both halves rot silently, and both did.
 *
 * `adm-zip` reached the project through `cassandra-driver`, a dependency of a tier removed two releases
 * earlier. The dependency left; the override stayed. SECURITY.md labelled it honestly — "*nothing, now*" —
 * and it still sat in the manifest for two releases, because nothing failed. When a human finally removed it,
 * the same test that condemned it turned out to condemn **four more rows** that were not labelled honestly:
 * `fast-uri` attributed to `ajv` (which is on v6 and uses `uri-js`), `js-yaml` to "the eslint / stryker
 * toolchains" (eslint 10 dropped eslintrc, and stryker is `pnpm dlx`-only so its graph never enters this
 * lockfile at all), `qs` to `@stryker-mutator/core` for the same reason, and a `brace-expansion@1` pin for a
 * major that is no longer in the tree.
 *
 * A security document that attributes four dead pins to live toolchains is worse than one that omits them: it
 * reads as a maintained inventory. So the check runs in both directions — no override without a package, and
 * no table row without an override.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not judge whether a *version range* is still the right one; only
 * a human reading an advisory can. It answers the cheaper question that had gone unasked for two releases:
 * is this entry protecting anything at all?
 */

const ROOT = join(__dirname, '..', '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  pnpm?: { overrides?: Record<string, string> };
};
const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');

const OVERRIDES = Object.keys(manifest.pnpm?.overrides ?? {});

/** `nanoid@3` is an override KEY carrying a major selector; the package it binds to is `nanoid`. */
const packageOf = (override: string): string => override.replace(/@\d+$/, '');

/**
 * Resolved package entries in the lockfile, as a set of bare names.
 *
 * Parsed from `  name@version:` keys in the packages/snapshots sections — NOT a substring search. The
 * `overrides:` block at the top of the lockfile echoes every override back verbatim, so a naive
 * `lockfile.includes(name)` would find every entry protecting nothing and call it live. That is precisely the
 * failure this gate exists to catch, and it would have caught none of them.
 */
const RESOLVED = new Set(
  [...lockfile.matchAll(/^ {2}((?:@[^/\s]+\/)?[^@\s/][^@\s]*)@\d[^:\s]*:/gm)].map(
    (m) => m[1] as string,
  ),
);

/** The package each override table row is ABOUT: the first backticked token of its first cell. */
const TABLE_ROWS = new Set(
  security
    .split('\n')
    .filter((line) => /^\| `[a-z@]/.test(line))
    .map((line) => /^\| `([^\s`]+)/.exec(line)?.[1])
    .filter((name): name is string => !!name),
);

describe('pnpm overrides are live, and SECURITY.md matches them', () => {
  it('the lockfile parsed into real package names (a zero-row sweep would prove nothing)', () => {
    expect(RESOLVED.size).toBeGreaterThan(100);
    expect(OVERRIDES.length).toBeGreaterThan(0);
    // The parser must not have picked up the `overrides:` echo block, which is indented the same way but
    // carries a range rather than a resolved version.
    expect(RESOLVED.has('adm-zip')).toBe(false);
  });

  it.each(OVERRIDES)('%s overrides a package that is actually installed', (override) => {
    expect(
      RESOLVED.has(packageOf(override)),
      `pnpm.overrides pins "${override}", but no package by that name resolves in pnpm-lock.yaml. ` +
        'An override that binds to nothing protects nothing and cannot be tested — remove it, or, if it is ' +
        'deliberately preventive, say so in SECURITY.md and add it to the exemption here with a reason.',
    ).toBe(true);
  });

  it.each(OVERRIDES)('%s has a row in the SECURITY.md table', (override) => {
    // The package must head a TABLE ROW, not merely appear somewhere in the file. A substring search over the
    // whole document passed a pin for `vitest` because another row's prose says "`vitest` -> `vite`" — the
    // document mentions most of these names in passing, so "is it written down?" and "is it documented?" are
    // different questions and only the second one is worth asking.
    expect(
      TABLE_ROWS.has(packageOf(override)),
      `pnpm.overrides pins "${override}" but no SECURITY.md table row starts with it. The table is the only ` +
        'place the reason for an override is written down; an unlisted pin is one nobody can review.',
    ).toBe(true);
  });

  it('SECURITY.md lists no override the manifest has dropped', () => {
    const pinned = new Set(OVERRIDES.map(packageOf));
    const orphans = [...TABLE_ROWS].filter((name) => !pinned.has(name));
    expect(
      orphans,
      'SECURITY.md describes overrides that package.json no longer has. A removed pin must leave the table ' +
        'in the same change, or the document becomes an inventory of protections that are not in force.',
    ).toEqual([]);
  });
});
