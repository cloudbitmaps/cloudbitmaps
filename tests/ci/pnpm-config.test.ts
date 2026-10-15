import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// pnpm 11 and later read settings from `pnpm-workspace.yaml` and no longer read the `pnpm` field of
// `package.json`; a setting left in that field is ignored without an error, so an override or a build allowance
// put there looks active and does nothing. These checks hold the settings where pnpm reads them.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  packageManager?: string;
  pnpm?: unknown;
};
const workspace = parse(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
  allowBuilds?: Record<string, boolean>;
  onlyBuiltDependencies?: unknown;
  provenance?: unknown;
};

describe('pnpm settings live where the pinned pnpm reads them', () => {
  it('pins pnpm 11 or later', () => {
    const major = /^pnpm@(\d+)\./.exec(manifest.packageManager ?? '')?.[1];
    expect(Number(major)).toBeGreaterThanOrEqual(11);
  });

  it('keeps no `pnpm` settings block in package.json, which pnpm ignores', () => {
    expect(manifest.pnpm).toBeUndefined();
  });

  it('lets roaring build its native addon, and uses allowBuilds rather than onlyBuiltDependencies', () => {
    expect(workspace.allowBuilds?.roaring).toBe(true);
    expect(workspace.onlyBuiltDependencies).toBeUndefined();
  });

  it('sets no `provenance` here: it would make the hand-run bootstrap and break-glass publishes fail', () => {
    // pnpm 12 reads `provenance` from this file, so a `true` here asks every laptop publish for an attestation
    // it cannot mint (ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER). The release workflow passes `--provenance`.
    expect(Object.prototype.hasOwnProperty.call(workspace, 'provenance')).toBe(false);
  });
});
