import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The runtime floor is declared in three places and they had already drifted.
//
// The policy is "declare the floor and enforce it in `engines`, the version file, and the CI matrix, kept in
// sync". In practice `.nvmrc` said 22 while all three manifests still said `>=20` — so the PUBLISHED packages
// advertised support for a Node major that reached end-of-life on 2026-04-30 and that nobody was developing
// against. Nothing caught it, because each of the three is individually plausible; only the disagreement is
// wrong, and no single file can see the disagreement.
//
// It surfaced by accident: an AWS SDK warning in an unrelated in-region latency run mentioned Node 20, which
// prompted a look. That is not a detection strategy, hence this test.
//
// The floor is a POLICY number, not a fact about the code, so it lives here as a constant with its reasoning
// attached. Raising it is a deliberate edit to this line plus the three files — which is the point.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

const MANIFESTS = ['package.json', 'packages/core/package.json', 'packages/roaring/package.json'];
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as { engines?: { node?: string } };

describe('runtime version policy is consistent across all three declarations', () => {
  it.each(MANIFESTS)('%s declares the floor as >=%s', (rel) => {
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
      // The floor must actually be exercised, not merely declared.
      expect(node, `job "${name}" never runs the declared floor`).toContain(FLOOR_MAJOR);
    }
  });

  it('every prose declaration of the floor states the current floor', () => {
    // A FOURTH declaration site, found the same way the first three were — by accident. The README said
    // "Node ≥ 20" long after the floor moved to 22: a major that was already EOL, telling readers the
    // opposite of what the manifests enforce. The three-way check above could not see it, because prose is
    // not a manifest.
    //
    // Matching `Node ≥ x` / `Node >= x` rather than the bare number is what keeps this from firing on the
    // legitimate look-alikes — `node:22-slim` in the Alpine note, a `node-version:` in a quoted workflow,
    // "Node 20 reached EOL" as history. Those name a version without declaring the floor.
    //
    // CHANGELOG.md is deliberately out of scope: its old entries state the floor that was correct when they
    // were written, and rewriting history to match today's number would make it a worse record.
    const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/guide/getting-started.md'];
    const declarations: string[] = [];
    for (const rel of DOCS) {
      const raw = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of raw.matchAll(/Node\s*(?:≥|>=)\s*([0-9]+(?:\.[0-9]+)*)/g)) {
        declarations.push(`${rel}: Node >= ${m[1]}`);
        expect(m[1], `${rel} declares a Node floor that is not the policy floor`).toBe(FLOOR);
      }
    }
    // If the phrasing changes and nothing matches any more, this test must fail rather than assert nothing.
    expect(declarations.length, 'no prose declares the Node floor any more').toBeGreaterThan(0);
  });

  it('no CI job pins a Node below the floor', () => {
    // The matrix is not the only place a version appears — several jobs hardcode `node-version:`, and one of
    // those silently below the floor would test a runtime consumers are told not to use.
    const raw = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const pinned = [...raw.matchAll(/node-version:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    expect(pinned.length).toBeGreaterThan(0);
    for (const v of pinned) expect(v).toBeGreaterThanOrEqual(FLOOR_MAJOR);
  });
});
