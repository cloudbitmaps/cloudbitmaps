# `tests/` — every package, tested from one place

The tests for all five packages live here, at the repository root, rather than inside each package — because many
of them drive the `CloudRoaring` facade and core's internals together, and a test that crosses package boundaries
has no single package to belong to.

Imports use the `@/…` alias (`import { … } from '@/core/crbm-storage-source'`), which `vitest.config.ts` and the
root `tsconfig.json` map onto the packages' sources. So a test reads the source directly, while the published
entry points are exercised separately by `scripts/smoke.cjs` — through the `exports` map a consumer actually
resolves.

## Running them

| command | runs |
|---|---|
| `pnpm test` | everything below **except** `integration/` — no containers, no network. It does need the git history: two tests read the previous release's tag, so a shallow clone fails them |
| `pnpm lint:arch` | `arch/` only |
| `pnpm test:integration` | `integration/` only, against real backends — start them first with `docker compose up -d` |
| `pnpm vitest run tests/docs` | one directory, while working on it |

## What each directory covers

| directory | covers |
|---|---|
| `arch/` | The architecture rules, proven to fire: the import boundaries that keep `packages/core/src/core/` free of cloud SDKs, drivers and `node:*` builtins (hard invariant 7), an acyclic import graph, and the detector modules in `scripts/` fired at planted inputs. `pnpm lint` running the rules proves nothing about a rule that never matches — these do. |
| `bench/` | `anchors.test.ts` turns the benchmark page's claims into build-breaking assertions — counting is free, chunk-skipping works, the published crossover is the modelled one. `calibrate-guards.test.ts` plants, against each money-spending guard in `bench/lib/`, the bug it exists for, and signals stand-in harnesses the way a terminal would: through the CloudShell script's own exit path, and on a pseudo-terminal that is then closed. |
| `bin/` | The `export-segments` CLI. |
| `ci/` | The workflows and repository configuration themselves: container images pinned, a Dependabot entry for every lockfile in the repo, the rate-limit-aware image pull, a timeout on every job, the prebuilt-binary checksums, the declared Node floor, and the release workflow's guards. A workflow is code that runs with publish rights; it gets tests like any other. |
| `conformance/` | Runs the shared contract suites — defined in `packages/roaring/src/testing/conformance.ts`, and not yet published, so only this repository's tests reach them — against the in-memory and local-filesystem drivers and the object-store registry: the storage source, the registry, and the registry under concurrent writers. The cloud drivers run the same suites from `drivers/` and `integration/`. A new driver is correct when it passes these, not when its own tests pass. |
| `core/` | The engine: routing, the `.crbm` format, loads and publishes, generation collection, erasure, encryption, budgets, consistency, the cache — unit tests, property tests over loaded generations, and the crash and race tests for the write-then-publish path that the hard invariants in `AGENTS.md` call for. |
| `docs/` | The documentation gates — see [below](#the-documentation-gates). |
| `drivers/` | Each storage driver's own behaviour, beneath the shared conformance suites: a directory each for S3, GCS, Azure Blob and the local filesystem (the in-memory driver is covered by `conformance/`), `retry/` for the retrying wrapper, `_shared/` for helpers they share, and top-level tests for the backend wiring and for encryption. |
| `export/` | Exporting segments to portable formats a reader can use without this library. |
| `golden/` | `v1.0-basic.crbm`, which pins the v1.0 on-disk byte layout — the artifact future language ports decode against. It is checked both ways: the writer must reproduce it byte for byte, and the reader must decode it back to the original segment. If either fails after a code change, the format changed, which is a breaking change needing a new format version — never a reason to regenerate the file. |
| `helpers/` | Shared helpers: building loaded stores in tests, and counting the requests the engine makes, which the cost model and the calibration harness are held to. |
| `integration/` | The S3, GCS and Azure Blob drivers against MinIO, fake-gcs-server and Azurite from `docker-compose.yml`. Excluded from `pnpm test`, and run in CI on every pull request. |
| `roaring/` | The pure-JavaScript reader for the portable roaring format, judged against the native library as the oracle: on a dozen hand-picked boundary shapes, on 200 random bitmaps nobody picked, and on hostile bytes it must refuse. A second decoder is only worth having if it agrees with the first on inputs nobody chose. |
| `scripts/` | The scripts in `scripts/`, tested like code — the leak scan against planted secrets, the changelog extractor, the bootstrap publish, the version sync — and two sweeps: no harness in `scripts/` or `bench/` builds a store with an option that has moved, and every name `scripts/`, `bench/` and `fuzz/` import from a workspace package is actually exported by it. |

## The files at the top level

| file | covers |
|---|---|
| `engine.property.test.ts` | Property tests against a plain `Set` as the oracle, over generations written through the real load path, so the properties hold over the shape production stores. |
| `engine.localfs.test.ts` | The engine reading a real on-disk `.crbm` generation, with the registry pointer on disk too — the whole persistent stack, end to end. |
| `flows.test.ts` | The documented user journey walked end to end on a real filesystem, twice: once with ordinary segment names and once with names that only became legal when the name grammar was removed. |
| `dr-drill.test.ts` | The disaster-recovery runbook as an executable drill: back up, corrupt real on-disk objects, restore, verify. |
| `key-rotation.test.ts` | Key-encryption-key rotation through the whole stack: old segments stay readable under the old key, new ones adopt the new one. |
| `crypto-vectors.test.ts` | Known-answer tests for the AES-256-GCM encryption, against externally published vectors — so a bug that is merely self-consistent cannot pass. |
| `backoff-liveness.test.ts` | A process whose only pending work is a retry backoff must not exit mid-retry. The default clock's timer once let it, silently dropping the awaited operation. |
| `index.test.ts` | The public API's shape: the exported verbs, name validation, and a `VERSION` that matches every package's manifest. |
| `setup-fast-check.ts` | Not a test: the one property-testing configuration every suite shares, so a red run can be reproduced from its seed. Loaded by `vitest.config.ts`. |

## The documentation gates

Everything in `docs/` exists because a document drifted from the code, the release or the site, and something
published it. Each compares prose with the thing it describes, so the drift fails a build instead of reaching a
reader.

| gate | fails when |
|---|---|
| `agents-md.test.ts` | `CLAUDE.md` stops being a symlink to `AGENTS.md`, in git's index or on disk, or `AGENTS.md` stops being the regular file — so a save that replaces the link with a copy cannot split the agent instructions in two. The on-disk check is skipped on a checkout without symlink support. |
| `api-reference-sync.test.ts` | `docs/guide/api-reference.md` and the exported surface disagree — in **either** direction. |
| `audit-kinds-enumerated.test.ts` | `docs/guide/dashboards.md` or `site/architecture.html`, the two pages that list the audit event kinds, lists fewer than all of them. |
| `calibration-reports.test.ts` | A real-cloud calibration run's report, or the benchmarks page's section on the latest run, leaves out a headline figure its evidence supports, or states a dollar amount, percentage, duration, byte size, bit rate or ratio, or a number written before the request, chunk, id, load or intersect it counts, that the evidence cannot account for at the precision it is written, or beside the words for another claim. Also when the evidence is not a complete, self-consistent real run, or more than one commit has touched it; when a bill's rows disagree with the run's derivation on cost or label; when a report's request ledger disagrees with the evidence on any request or its billing class; and when its table of cost by overlap does not follow from the request shape the run measured. |
| `code-fence-sanity.test.ts` | A TypeScript sample in the docs repeats a mistake that has shipped in one: declares a name twice at the top level, mixes the old `storage`/`registry` wiring with the new `backend` in one sample, passes a moved key at the top level of the store's options, or names a removed option key without marking the sample `// before`. |
| `dependency-claims.test.ts` | A count of third-party dependencies does not say whose it is — "zero third-party dependencies" is true of core and false of the family. |
| `directory-readmes.test.ts` | Something has no row in its README — a file in `bench/`, `bench/calibration/` or `scripts/`; a directory, top-level file or gate here; a page, top-level file or `assets/` in `site/` — or a row names a path that does not exist, or one it cannot read. Only a row counts, not a mention, and tables in code blocks or comments are not rows. A subdirectory with a README of its own gets one row in its parent's. |
| `flavor-readme-sync.test.ts` | The **published** README of the flavor package drops a method the guide maps a Redis command onto, claims Redis parity without saying where it stops, or leaves out the warning about the expensive write shape. |
| `internal-citations.test.ts` | A file cites an internal id nobody outside can resolve — a phase number, a numbered gap or finding from a review, a decision-log number, an internal document's number. Code comments count: they ship in the `.d.ts`. (A relative link into private documents is `links.test.ts`'s to catch.) |
| `issue-template-sync.test.ts` | The bug-report form's list of storage drivers differs from the drivers that ship. |
| `links.test.ts` | A relative link in any tracked markdown file or on the site does not resolve — the file, and for a markdown target its heading anchor too (the site's own page anchors are `site-links.py`'s); an absolute link back into this repository is checked the same way; and nothing links into a private documents directory. |
| `name-rules-sync.test.ts` | A doc publishes a name-grammar regex — there is no grammar any more; a name is any non-empty string — or shows an example segment name that the code would refuse. |
| `override-hygiene.test.ts` | A `pnpm.overrides` entry binds to nothing, or `SECURITY.md` describes a different set of overrides from the ones that exist. |
| `owed-work-claims.test.ts` | The loaded-store benchmarks, which the roadmap still lists as **owed**, are described anywhere else as done. It keys on that one roadmap entry: once the entry stops saying owed, the per-file checks stand down and this gate fails until it is deleted or re-anchored, so it cannot linger as a guard that checks nothing. |
| `previous-release-claims.test.ts` | A page presents an identifier as the old form that did not actually exist in the old release. |
| `public-jsdoc.test.ts` | A public method on the facade has no JSDoc of its own. |
| `sdk-floor-claims.test.ts` | A driver package's cloud-SDK range differs between its manifest, its README and `site/usage.html` — or the S3 range admits a version below the one its correctness depends on. |
| `specifiers.test.ts` | A user-facing file still tells a reader to install or import the retired unscoped package name. |
| `superseded-behaviour-claims.test.ts` | A page repeats one of the listed phrases that were true once and describe behaviour this library no longer has. |
| `unreleased-install-caveat.test.ts` | Before the driver packages were published, a page that told a reader to install them without saying so; now that they are, a page that still says they are not. |
| `version-claims.test.ts` | A version stated on the site, in the READMEs or in the docs — the badge included — differs from the packages'. |
| `vocabulary-damage.test.ts` | Wording only a mechanical rename produces reappears. The tier renames — `cold` to `storage`, `hot` to `cache` — left phrasing no one would write; this lists each damaged shape, with what it should have said — the GCP permission `storage.objects.*` came out with its first word doubled, for one. |

## Conventions

- **A gate is verified in both directions.** Plant the defect it exists for and watch it fail; then check that the
  honest look-alikes pass. A gate that has only ever passed is not known to work.
- **Derive, don't list.** A test that hard-codes the set of things it checks goes stale the day a new one is added.
  Read the set off the filesystem, the exports or the source, the way the lockstep and figure gates do.
- **When an honest collision trips a gate, rename the collision rather than widening the gate.** A pattern loosened
  to let one legitimate case through stops catching the illegitimate ones.
