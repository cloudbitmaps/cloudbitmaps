import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The native-addon checksum table covers every platform CI claims to verify, at the version we ship.
 *
 * WHY THIS EXISTS. `scripts/verify-roaring-prebuilt.cjs` keys its table on `<roaring version>/<platform dir>`
 * and, without `--strict`, prints `RECORD …` and **exits 0** for a key it has never seen. Every key carries
 * the version — so a `roaring` version bump makes all six keys unknown at once, and all six `native addon`
 * jobs pass having verified nothing at all. Dependabot groups minor+patch monthly under `patterns: ['*']`,
 * which is precisely how that bump arrives: inside a routine PR that goes green while shipping an unverified
 * native binary. `--strict` existed for this and had zero callers anywhere in the repo.
 *
 * CI now passes `--strict`, which turns an unknown key into a failure. This test covers the other half, which
 * `--strict` cannot see from inside a single job: that the table has a row for every (OS, node ABI) pair the
 * matrix runs, at the version currently resolved. A row quietly deleted, or a platform added to the matrix
 * with no row recorded, is a gap that only shows up as six green jobs.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const table = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'roaring-prebuilt-checksums.json'), 'utf8'),
) as Record<string, string>;

const roaringVersion = (
  JSON.parse(readFileSync(join(ROOT, 'packages', 'roaring', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  }
).dependencies.roaring as string;

const ci = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
  jobs: Record<
    string,
    { strategy?: { matrix?: { os?: string[]; node?: number[] } }; steps?: { run?: string }[] }
  >;
};

const nativeJob = Object.values(ci.jobs).find((j) =>
  (j.steps ?? []).some((s) => (s.run ?? '').includes('verify-roaring-prebuilt')),
);

describe('the native-addon checksum table matches what CI verifies', () => {
  it('found the job that runs the verifier', () => {
    expect(nativeJob, 'no CI job runs verify-roaring-prebuilt any more').toBeDefined();
    expect(Object.keys(table).length).toBeGreaterThan(0);
  });

  it('CI runs the verifier in --strict mode, so an unknown key is a failure', () => {
    // Without this flag the script RECORDS an unknown key and exits 0. The flag is the whole difference
    // between a gate and a logger, and it is a single word that a future edit could drop silently.
    const step = (nativeJob?.steps ?? []).find((s) =>
      (s.run ?? '').includes('verify-roaring-prebuilt'),
    );
    expect(
      step?.run,
      'verify-roaring-prebuilt must run with --strict in CI: without it, a roaring version bump makes every ' +
        'key unknown and every native job passes having verified nothing',
    ).toContain('--strict');
  });

  it('has a row for every OS x node ABI pair the matrix runs, at the resolved roaring version', () => {
    const matrix = nativeJob?.strategy?.matrix;
    const osCount = (matrix?.os ?? []).length;
    const nodeCount = (matrix?.node ?? []).length;
    expect(osCount, 'the native matrix lists no OSes').toBeGreaterThan(0);
    expect(nodeCount, 'the native matrix lists no node versions').toBeGreaterThan(0);

    // The exact version, because the key carries it: a bump invalidates the whole table at once.
    const version = roaringVersion.replace(/^[\^~]/, '');
    const forVersion = Object.keys(table).filter((k) => k.startsWith(`${version}/`));
    expect(
      forVersion.length,
      `roaring resolves to ${version} but the checksum table has ${forVersion.length} row(s) for it ` +
        `(${Object.keys(table).join(', ')}). Run \`node scripts/verify-roaring-prebuilt.cjs\` on each ` +
        'platform, verify the printed hashes against the upstream artifacts, and record them.',
    ).toBe(osCount * nodeCount);
  });
});
