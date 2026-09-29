import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The runtime floor is declared in three places, and only a test keeps them together.
//
// The policy is "declare the floor and enforce it in `engines`, the version file, and the CI matrix, kept in
// sync". Each of the three is plausible on its own: `.nvmrc` on 22 while the manifests say `>=20` would have
// the PUBLISHED packages advertise support for a Node major that reached end-of-life on 2026-04-30 and that
// nobody develops against. Only the disagreement is wrong, and no single file can see the disagreement.
//
// The floor is a POLICY number, not a fact about the code, so it lives here as a constant with its reasoning
// attached. Raising it is a deliberate edit to this line plus the three files — which is the point.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const { findNodeFloorClaims, findPinnedNodeVersions, satisfiesFloor, compareVersions } =
  createRequire(import.meta.url)('../../scripts/runtime-floor.cjs') as {
    findNodeFloorClaims: (text: string) => { raw: string; version: string }[];
    findPinnedNodeVersions: (yaml: string) => { raw: string; version: string }[];
    satisfiesFloor: (pin: string, floor: string) => boolean;
    compareVersions: (a: string, b: string) => number;
  };

/**
 * Minimum supported Node, as `engines` declares it.
 *
 * `22` because Node 20 reached EOL on 2026-04-30 and shipping an EOL runtime is a security liability as well
 * as a tooling one (dependency-cruiser 18 already declares `^22 || ^24`).
 *
 * `.12` because the packages are ESM-only and a CommonJS consumer therefore reaches them through Node's
 * `require(esm)`, which landed in 22.12. Measured, not assumed: 22.11.0 throws `ERR_REQUIRE_ESM`, 22.12.0
 * loads (with an `ExperimentalWarning`), and 24 loads silently. Below 22.12 a CJS consumer cannot load the
 * library at all, so the floor has to carry the minor — a bare `>=22` would advertise support we do not have.
 */
const FLOOR = '22.12';
/**
 * The MAJOR is a separate number on purpose. `.nvmrc` and every `node-version:` in CI name a major and
 * resolve to its latest release (22.x is well past .12), which is what keeps a contributor's local gate and
 * CI on the same runtime — the reason the version file is checked at all. Pinning either to `22.12` exactly
 * would make local and CI diverge, and would be the only place in the repo running the floor rather than
 * what users actually get.
 */
const FLOOR_MAJOR = Number(FLOOR.split('.')[0]);
/** The CI matrix is the active LTS + the current release — not every major that still runs. */
const EXPECTED_MATRIX = [22, 24];

/**
 * The root manifest plus EVERY package manifest, derived rather than listed.
 *
 * Derived, because a hardcoded list goes stale the day a package is added: a new driver package could then
 * advertise `engines.node: ">=20"` — an EOL major, and one below 22.12 where a CommonJS consumer cannot
 * `require()` these ESM packages at all — with the whole suite green.
 */
const MANIFESTS = [
  'package.json',
  ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'package.json')))
    .map((e) => `packages/${e.name}/package.json`)
    .sort(),
];
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as { engines?: { node?: string } };

describe('runtime version policy is consistent across every declaration', () => {
  it.each(MANIFESTS)(`%s declares the floor as >=${FLOOR}`, (rel) => {
    const engines = readJson(rel).engines;
    expect(engines?.node, `${rel} declares no engines.node`).toBeDefined();
    expect(engines?.node).toBe(`>=${FLOOR}`);
  });

  it('the version file matches the floor', () => {
    // A contributor running the version file's Node must be running something `engines` permits, or the gate
    // they run locally is not the gate CI runs.
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe(String(FLOOR_MAJOR));
  });

  it('every CI matrix is exactly the active LTS + current release', () => {
    const wf = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { node?: number[] } } }>;
    };
    const matrices = Object.entries(wf.jobs)
      .map(([name, j]) => [name, j.strategy?.matrix?.node] as const)
      .filter(([, node]) => node !== undefined);
    // If the matrices vanish or get renamed, this test must fail rather than quietly assert nothing.
    expect(matrices.length).toBeGreaterThan(0);
    for (const [name, node] of matrices) {
      expect(node, `job "${name}" matrix`).toEqual(EXPECTED_MATRIX);
    }
  });

  it('every prose declaration of the floor states the current floor', () => {
    // A FOURTH declaration site: prose. A README saying "Node ≥ 20" under this floor names a major that is
    // already EOL, telling readers the opposite of what the manifests enforce, and the three-way check above
    // cannot see it, because prose is not a manifest.
    //
    // Every PACKAGE readme is in scope, and is the reason this list is not just the repo root: each is
    // published in its package's `files`, so it is the npm page a consumer reads to decide whether they can
    // install at all.
    //
    // CHANGELOG.md is deliberately out of scope: its old entries state the floor that was correct when they
    // were written, and rewriting history to match today's number would make it a worse record.
    const DOCS = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/guide/getting-started.md',
      // Every package README, derived: these are npm landing pages, and the one a new package adds is where a
      // wrong floor is cheapest to write and least likely to be noticed.
      ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'README.md')))
        .map((e) => `packages/${e.name}/README.md`)
        .sort(),
    ];
    // These two must state the floor. If a rewording drops it from EITHER, that is the silent regression this
    // test exists for — a global "something matched somewhere" count would let the README lose its statement
    // entirely and still read 1.
    const MUST_DECLARE = ['README.md', 'CONTRIBUTING.md'];

    const perFile = new Map<string, number>();
    for (const rel of DOCS) {
      const claims = findNodeFloorClaims(readFileSync(join(ROOT, rel), 'utf8'));
      perFile.set(rel, claims.length);
      for (const c of claims) {
        // Numeric, not string: `Node ≥ 22.12.0` states the same floor as `22.12` and must pass.
        expect(
          compareVersions(c.version, FLOOR),
          `${rel} declares a Node floor that is not the policy floor — "${c.raw}"`,
        ).toBe(0);
      }
    }
    for (const rel of MUST_DECLARE) {
      expect(perFile.get(rel), `${rel} no longer declares the Node floor anywhere`).toBeGreaterThan(
        0,
      );
    }
  });

  it('no CI job pins a Node below the floor', () => {
    // The matrix is not the only place a version appears — several jobs hardcode `node-version:`, and one of
    // those silently below the floor would test a runtime consumers are told not to use.
    //
    // A SUB-MAJOR pin is the case that matters: under a floor on a bare major, "below the floor" could only
    // mean a smaller major, and a plain integer match would be enough. `>=22.12` makes `node-version: 22.11`
    // a below-floor pin that looks identical to a good one, so the comparison has to be version-aware — and
    // prefix-aware, since a bare `22` resolves to the latest 22.x and is therefore fine.
    // EVERY workflow, not just ci.yml. `release.yml` and `fuzz-nightly.yml` carry their own pins, and a
    // below-floor pin in the release workflow is the worst place for one — that is the job that builds the
    // tarballs consumers install.
    const workflows = readdirSync(join(ROOT, '.github/workflows')).filter((f) =>
      /\.ya?ml$/.test(f),
    );
    expect(workflows.length, 'no workflows found — has the directory moved?').toBeGreaterThan(0);
    const pinned = workflows.flatMap((f) =>
      findPinnedNodeVersions(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')).map(
        (hit) => ({
          ...hit,
          file: f,
        }),
      ),
    );
    expect(
      pinned.length,
      'no literal node-version pins found — has the syntax changed?',
    ).toBeGreaterThan(0);
    for (const hit of pinned) {
      expect(
        satisfiesFloor(hit.version, FLOOR),
        `${hit.file}: "${hit.raw}" pins a Node below the ${FLOOR} floor`,
      ).toBe(true);
    }
  });
});
