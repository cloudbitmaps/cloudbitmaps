import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

// The workspace is pinned to pnpm 10 on purpose. pnpm 11 and later refuse to run against the pin unless told to ignore
// it; run that way, they stop reading the `pnpm` block of `package.json`, where the overrides, the audit triage and the
// install-script allowance live, and when they manage their own version they write `pnpm-lock.yaml` as two YAML
// documents (an environment document first, then the dependency graph), of which GitHub's dependency graph and
// Dependabot read only the first, so they would see no dependencies. A change to the pin, or a lockfile of that
// shape, is caught here, before Dependabot is.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Manifest {
  packageManager?: string;
  pnpm?: { onlyBuiltDependencies?: string[]; overrides?: unknown; auditConfig?: unknown };
}

/** Why the lockfile text is not the one-document, pnpm-10-shaped file Dependabot reads, or `null` when it is. */
function lockfileProblem(text: string): string | null {
  const docs = parseAllDocuments(text);
  if (docs.length !== 1) return `${docs.length} YAML documents, not one`;
  const root = docs[0]!.toJS() as {
    lockfileVersion?: unknown;
    packageManagerDependencies?: unknown;
  } | null;
  if (root === null || typeof root !== 'object') return 'not a YAML mapping';
  if ('packageManagerDependencies' in root) return 'has a packageManagerDependencies block';
  if (root.lockfileVersion !== '9.0')
    return `lockfileVersion is ${String(root.lockfileVersion)}, not '9.0'`;
  return null;
}

/** The pinned pnpm major, or `null` when `packageManager` does not pin one. */
function pinnedMajor(manifest: Manifest): number | null {
  const major = /^pnpm@(\d+)\.\d+\.\d+$/.exec(manifest.packageManager ?? '')?.[1];
  return major === undefined ? null : Number(major);
}

/** Whether the manifest lets `roaring` run its install script, the way pnpm 10 reads it. */
function allowsRoaring(manifest: Manifest): boolean {
  return manifest.pnpm?.onlyBuiltDependencies?.includes('roaring') === true;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');

describe('the workspace stays on pnpm 10, whose lockfile Dependabot can read', () => {
  it('pins pnpm 10', () => {
    expect(pinnedMajor(manifest)).toBe(10);
  });

  it('has a lockfile of one YAML document, version 9.0, with no packageManagerDependencies block', () => {
    expect(lockfileProblem(lockfile)).toBeNull();
  });

  it('lets roaring run its install script, or `require("roaring")` throws after a clean install', () => {
    expect(allowsRoaring(manifest)).toBe(true);
  });

  it('keeps the overrides and the audit triage in the `pnpm` block pnpm 10 and Dependabot read', () => {
    expect(manifest.pnpm?.overrides).toBeDefined();
    expect(manifest.pnpm?.auditConfig).toBeDefined();
  });
});

describe('each check fails on a planted copy and passes on the legitimate look-alike', () => {
  const body = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n";

  it('a second YAML document in the lockfile', () => {
    expect(lockfileProblem(`${body}---\n${body}`)).toMatch(/2 YAML documents/);
    expect(lockfileProblem(`---\n${body}---\n${body}`)).toMatch(/2 YAML documents/);
  });

  it('a packageManagerDependencies block', () => {
    expect(
      lockfileProblem(`${body}packageManagerDependencies:\n  pnpm:\n    version: 11.0.0\n`),
    ).toMatch(/packageManagerDependencies/);
  });

  it('a lockfile version other than 9.0', () => {
    expect(lockfileProblem("lockfileVersion: '6.0'\n")).toMatch(/lockfileVersion/);
  });

  it('a lockfile that merely mentions the words, and a lone document marker, pass', () => {
    expect(
      lockfileProblem(`${body}importers:\n  .:\n    note: "--- packageManagerDependencies"\n`),
    ).toBeNull();
    expect(lockfileProblem(`---\n${body}`)).toBeNull();
  });

  it('a pinned major other than 10', () => {
    expect(pinnedMajor({ packageManager: 'pnpm@9.0.0' })).toBe(9);
    expect(pinnedMajor({ packageManager: 'pnpm@11.28.2' })).toBe(11);
    expect(pinnedMajor({ packageManager: 'pnpm@12.11.2' })).toBe(12);
    expect(pinnedMajor({})).toBeNull();
    expect(pinnedMajor({ packageManager: 'pnpm@10.34.6' })).toBe(10);
  });

  it('a manifest that does not allow roaring', () => {
    expect(allowsRoaring({})).toBe(false);
    expect(allowsRoaring({ pnpm: { onlyBuiltDependencies: [] } })).toBe(false);
    expect(allowsRoaring({ pnpm: { onlyBuiltDependencies: ['esbuild'] } })).toBe(false);
    expect(allowsRoaring({ pnpm: { onlyBuiltDependencies: ['roaring'] } })).toBe(true);
  });
});
