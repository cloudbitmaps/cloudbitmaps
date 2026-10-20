import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The six packages release at one version, so every manifest names the others at an exact version and exports
 * its own `package.json`. The rules live in `scripts/lib/family-manifest.cjs`; smoke applies them to the source
 * manifests and the tarball scan to each packed one. Here they are fired both ways: a range or a missing export
 * must be reported, and the legitimate spellings must not be.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { manifestProblems } = createRequire(import.meta.url)(
  join(ROOT, 'scripts', 'lib', 'family-manifest.cjs'),
) as {
  manifestProblems: (
    manifest: Record<string, unknown>,
    family: string[],
    options?: { source?: boolean },
  ) => string[];
};

const FAMILY = ['@cloudbitmaps/core', '@cloudbitmaps/roaring'];
const base = {
  name: '@cloudbitmaps/roaring',
  exports: { '.': { default: './dist/index.js' }, './package.json': './package.json' },
};

describe('family manifest rules', () => {
  it.each(['^0.23.0', '~0.23.0', '>=0.23.0', '*', 'latest', '0.23.x', 'workspace:^'])(
    'reports a published dependency on the family ranged as %s',
    (range) => {
      const out = manifestProblems(
        { ...base, dependencies: { '@cloudbitmaps/core': range } },
        FAMILY,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('dependencies.@cloudbitmaps/core');
    },
  );

  it('reports a range in every dependency field', () => {
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const out = manifestProblems(
        { ...base, [field]: { '@cloudbitmaps/core': '^1.0.0' } },
        FAMILY,
      );
      expect(out, field).toHaveLength(1);
    }
  });

  it('accepts an exact version, a prerelease, and an unrelated range', () => {
    for (const range of ['0.23.0', '1.2.3-rc.0']) {
      expect(
        manifestProblems({ ...base, dependencies: { '@cloudbitmaps/core': range } }, FAMILY),
      ).toEqual([]);
    }
    expect(manifestProblems({ ...base, dependencies: { roaring: '^2.7.0' } }, FAMILY)).toEqual([]);
  });

  it('accepts `workspace:*` only in a source manifest', () => {
    const manifest = { ...base, dependencies: { '@cloudbitmaps/core': 'workspace:*' } };
    expect(manifestProblems(manifest, FAMILY, { source: true })).toEqual([]);
    expect(manifestProblems(manifest, FAMILY)).toHaveLength(1);
  });

  it('reports a manifest that does not export its own package.json', () => {
    expect(manifestProblems({ name: base.name, exports: { '.': './x.js' } }, FAMILY)).toHaveLength(
      1,
    );
    expect(
      manifestProblems({ name: base.name, exports: { './package.json': './other.json' } }, FAMILY),
    ).toHaveLength(1);
    expect(manifestProblems({ name: base.name }, FAMILY)).toHaveLength(1);
  });
});

describe('the workspace manifests', () => {
  const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dir: e.name,
      manifest: JSON.parse(readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8')),
    }));
  const names = packages.map((p) => p.manifest.name as string);

  it('finds all six packages', () => {
    expect(names).toHaveLength(6);
  });

  it.each(packages.map((p) => [p.dir, p.manifest] as const))(
    '%s pins the family exactly and exports its package.json',
    (_dir, manifest) => {
      expect(manifestProblems(manifest, names, { source: true })).toEqual([]);
    },
  );

  it('versions the family together', () => {
    const config = JSON.parse(readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8')) as {
      fixed: string[][];
    };
    expect(config.fixed).toEqual([['@cloudbitmaps/*']]);
    expect(new Set(packages.map((p) => p.manifest.version)).size).toBe(1);
  });
});
