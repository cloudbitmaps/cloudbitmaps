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
| `pnpm test` | everything below **except** `integration/` — no containers, no network. It does need the git history: `docs/calibration-reports.test.ts` checks that each calibration evidence file was committed once and never edited, so a shallow clone fails it |
| `pnpm lint:arch` | `arch/` only |
| `pnpm test:integration` | `integration/` only, against real backends — start them first with `docker compose up -d` |
| `pnpm vitest run tests/docs` | one directory, while working on it |

## What each directory covers

| directory | covers |
|---|---|
| `arch/` | The architecture rules, proven to fire: the import boundaries that keep `packages/core/src/core/` free of cloud SDKs, drivers and `node:*` builtins (hard invariant 7), an acyclic import graph, and the detector modules in `scripts/` fired at planted inputs. `pnpm lint` running the rules proves nothing about a rule that never matches — these do. |
| `bench/` | `anchors.test.ts` turns the benchmark page's claims into build-breaking assertions — counting is free, chunk-skipping works, the published crossover is the modelled one. `calibrate-guards.test.ts` plants, against each money-spending guard in `bench/lib/`, the bug it exists for, and signals stand-in harnesses the way a terminal would: through the CloudShell script's own exit path, and on a pseudo-terminal that is then closed. |
| `bin/` | The `export-segments` CLI. |
| `ci/` | The workflows and repository configuration themselves: container images pinned, every third-party action pinned to a commit, a Dependabot entry for every lockfile and every composite action, the rate-limit-aware image pull and compose never pulling behind it, the Actions cache every container job keeps its images in, a timeout on every job, the prebuilt-binary checksums, the declared Node floor, and the release workflow's guards. A workflow is code that runs with publish rights; it gets tests like any other. |
| `conformance/` | Runs the shared contract suites — defined in `packages/roaring/src/testing/conformance.ts`, and not yet published, so only this repository's tests reach them — against the in-memory and local-filesystem drivers and the object-store registry: the storage source, the registry, and the registry under concurrent writers. The cloud drivers run the same suites from `drivers/` and `integration/`. A new driver is correct when it passes these, not when its own tests pass. |
| `core/` | The engine: routing, the `.crbm` format, loads and publishes, generation collection, erasure, encryption, budgets, consistency, the cache — unit tests, property tests over loaded generations, and the crash and race tests for the write-then-publish path that the hard invariants in `AGENTS.md` call for. |
| `docs/` | The documentation gates — see [below](#the-documentation-gates). |
| `drivers/` | Each storage driver's own behaviour, beneath the shared conformance suites: a directory each for S3, GCS, Azure Blob and the local filesystem (the in-memory driver is covered by `conformance/`), `retry/` for the retrying wrapper, `_shared/` for helpers they share, and top-level tests for the backend wiring and for encryption. |
| `export/` | Exporting segments to portable formats a reader can use without this library. |
| `golden/` | `v1.0-basic.crbm`, which pins the v1.0 on-disk byte layout — the artifact future language ports decode against. It is checked both ways: the writer must reproduce it byte for byte, and the reader must decode it back to the original segment. If either fails after a code change, the format changed, which is a breaking change needing a new format version — never a reason to regenerate the file. |
| `helpers/` | Shared helpers: building loaded stores in tests, a `StorageChunkSource` a test seeds chunk by chunk (the engine's read path without `.crbm` or a registry), counting the requests the engine makes, which the cost model and the calibration harness are held to, reading the repo's workflows, composite actions and `package.json` scripts for the CI tests, reading prose across wrapped lines and joined strings for the gates that match phrases in it, reading the options code passes to `new CloudRoaring({ … })` for the gates that hold the docs' samples and the harnesses to the keys the store takes, the type-level check that holds a runtime list to the type it mirrors, and writing portable-roaring bytes field by field, for the tests of what the decoders refuse. |
| `integration/` | The S3, GCS and Azure Blob drivers against MinIO, fake-gcs-server and Azurite from `docker-compose.yml`. Excluded from `pnpm test`, and run in CI on every pull request. |
| `roaring/` | What the flavor package adds over core: the codec and the clock its `loadSegment` binds, each filling an absent value and keeping a supplied one. And the pure-JavaScript reader for the portable roaring format, judged against the native library as the oracle: on a dozen hand-picked boundary shapes, on 200 random bitmaps nobody picked, and on hostile bytes it must refuse. And the structural check both decoders run on those bytes: every malformed shape the native deserializer accepts, refused by both, and real payloads with bytes overwritten, on which the two must agree. A second decoder is only worth having if it agrees with the first on inputs nobody chose. |
| `scripts/` | The scripts in `scripts/`, tested like code — the leak scan against planted secrets, the changelog extractor, the bootstrap publish — and two sweeps: no harness in `scripts/` or `bench/` builds a store with an option key the store refuses, and every name `scripts/`, `bench/` and `fuzz/` import from a workspace package is actually exported by it. |

## The files at the top level

| file | covers |
|---|---|
| `engine.property.test.ts` | Property tests against a plain `Set` as the oracle, over generations written through the real load path, so the properties hold over the shape production stores. |
| `engine.localfs.test.ts` | The engine reading a real on-disk `.crbm` generation, with the registry pointer on disk too — the whole persistent stack, end to end. |
| `flows.test.ts` | The documented user journey walked end to end on a real filesystem, twice: once with ordinary segment names and once with names that need encoding. |
| `dr-drill.test.ts` | The disaster-recovery runbook as an executable drill: back up, corrupt real on-disk objects, restore, verify. |
| `key-rotation.test.ts` | Key-encryption-key rotation through the whole stack: old segments stay readable under the old key, new ones adopt the new one. |
| `crypto-vectors.test.ts` | Known-answer tests for the AES-256-GCM encryption, against externally published vectors — so a bug that is merely self-consistent cannot pass. |
| `backoff-liveness.test.ts` | A process whose only pending work is a retry backoff must not exit mid-retry, which would silently drop the awaited operation: the default clock's backoff timer stays ref'd. |
| `index.test.ts` | The public API's shape: the exported verbs, name validation, and every package's manifest at one version. |
| `setup-fast-check.ts` | Not a test: the one property-testing configuration every suite shares, so a red run can be reproduced from its seed. Loaded by `vitest.config.ts`. |

## The documentation gates

Everything in `docs/` exists because a document drifted from the code, the release or the site, and something
published it. Each compares prose with the thing it describes, so the drift fails a build instead of reaching a
reader.

| gate | fails when |
|---|---|
| `agents-md.test.ts` | `CLAUDE.md` stops being a symlink to `AGENTS.md`, in git's index or on disk, or `AGENTS.md` stops being the regular file — so a save that replaces the link with a copy cannot split the agent instructions in two. The on-disk check is skipped on a checkout without symlink support. |
| `api-reference-sync.test.ts` | `docs/guide/api-reference.md` and the exported surface disagree — in **either** direction. |
| `audit-kinds-enumerated.test.ts` | `docs/guide/dashboards.md`, `docs/guide/getting-started.md` or `site/architecture.html`, the three pages that list the audit event kinds, lists fewer than all of them. |
| `calibration-reports.test.ts` | A real-cloud calibration run's report, or the benchmarks page's section on the latest run, leaves out a headline figure its evidence supports, or states a dollar amount, percentage, duration, byte size, bit rate or ratio, or a number written before the request, chunk, id, load or intersect it counts, that the evidence cannot account for at the precision it is written, or beside the words for another claim. Also when the evidence is not a complete, self-consistent real run, or more than one commit has touched it; when a bill's rows disagree with the run's derivation on cost or label; when a report's request ledger disagrees with the evidence on any request or its billing class; and when its table of cost by overlap does not follow from the request shape the run measured. |
| `code-fence-sanity.test.ts` | A TypeScript sample in the docs makes a mistake that stops it running: it declares a name twice at the top level, declares `storage` or `registry` but uses an undeclared `backend`, declares `backend` but uses an undeclared `registry`, passes `new CloudRoaring({ … })` a key it does not take, at the top level or inside a group, or passes `S3Storage`, `GcsStorage` or `AzureBlobStorage` a key it does not take. |
| `dependency-claims.test.ts` | A count of third-party dependencies does not say whose it is — "zero third-party dependencies" is true of core and false of the family. |
| `describes-the-present.test.ts` | A tracked text file — code, docs, config or a workflow — tells the library's past without naming a version. The file's header lists each family of wording it refuses, with examples: a past habit, an adverb of former time, a component the library does not have, the library dropping or deprecating something, an earlier version or draft of the text, the code as it was, a change dated by a fix or a rename, a rename or a removal, and a defect's history (the state before its fix, a defect that shipped, a review credited with finding it). Text is read across wrapped lines and joined strings, `#` comments included. Skipped, each for its reason: the changelog and the changesets that become it, the licence texts, the lockfile, the committed calibration evidence, and the gate's own file, whose fixtures are the phrases it refuses. An exception covers only its own phrase, so a new one on the same line still fails, and every exception must still match. |
| `directory-readmes.test.ts` | Something has no row in its README — a file in `bench/`, `bench/calibration/` or `scripts/`; a directory, top-level file or gate here; a page, top-level file or `assets/` in `site/` — or a row names a path that does not exist, or one it cannot read. Only a row counts, not a mention, and tables in code blocks or comments are not rows. A subdirectory with a README of its own gets one row in its parent's. |
| `earlier-releases.test.ts` | A file anywhere in the repository, code and comments included, names a CloudBitmaps release before `0.10.0`, where the public history starts. |
| `flavor-readme-sync.test.ts` | The **published** README of the flavor package drops a method the guide maps a Redis command onto, claims Redis parity without saying where it stops, or leaves out the warning about the expensive write shape. |
| `internal-citations.test.ts` | A file cites an internal id nobody outside can resolve — a phase number, a numbered gap or finding from a review, a decision-log number, an internal document's number. Code comments count: they ship in the `.d.ts`. (A relative link into private documents is `links.test.ts`'s to catch.) |
| `issue-template-sync.test.ts` | The bug-report form's list of storage drivers differs from the drivers that ship. |
| `links.test.ts` | A relative link in any tracked markdown file or on the site does not resolve — the file, and for a markdown target its heading anchor too (the site's own page anchors are `site-links.py`'s); an absolute link back into this repository is checked the same way; and nothing links into a private documents directory. |
| `name-rules-sync.test.ts` | A doc publishes a name-grammar regex — a name is any non-empty string — or shows an example segment name that the code would refuse. |
| `override-hygiene.test.ts` | A `pnpm.overrides` entry binds to nothing, or `SECURITY.md` describes a different set of overrides from the ones that exist. |
| `owed-work-claims.test.ts` | The loaded-store benchmarks, which the roadmap still lists as **owed**, are described anywhere else as done. It keys on that one roadmap entry: once the entry stops saying owed, the per-file checks stand down and this gate fails until it is deleted or re-anchored, so it cannot linger as a guard that checks nothing. |
| `privacy-note-sync.test.ts` | The **published** privacy note, `packages/roaring/PRIVACY.md`, says something the repository's `PRIVACY.md` does not say, or leaves out something it does. The two differ only in the published copy's header and its absolute links. |
| `public-jsdoc.test.ts` | A public method on the facade has no JSDoc of its own. |
| `retired-names.test.ts` | A package still exports a name the library removed, or a page names one, in prose or in a code sample: markdown, HTML or a plain-text page the site serves, anywhere but the changelog and the changesets, which announce the removal. A name with no use left in any code is refused in the code too, comments included, since a doc-comment ships in the `.d.ts`. |
| `sdk-floor-claims.test.ts` | A driver package's cloud-SDK range differs between its manifest, its README and `site/usage.html` — or the S3 range admits a version below the one its correctness depends on. |
| `specifiers.test.ts` | A user-facing file tells a reader to install or import `cloud-roaring`, an unscoped name that is only an empty placeholder on npm. |
| `superseded-behaviour-claims.test.ts` | A page repeats one of the listed phrases, each a claim about behaviour this library does not have, with what to say instead. |
| `version-claims.test.ts` | A version stated on the site, in the READMEs or in the docs — the badge included — differs from the packages'. |
| `vocabulary-damage.test.ts` | Wording only a mechanical find-and-replace produces appears — phrasing no one would write, such as the GCP permission `storage.objects.*` with its first word doubled. The gate lists each damaged shape, with what it should have said. |

## Conventions

- **A gate is verified in both directions.** Plant the defect it exists for and watch it fail; then check that the
  honest look-alikes pass. A gate that has only ever passed is not known to work.
- **Derive, don't list.** A test that hard-codes the set of things it checks goes stale the day a new one is added.
  Read the set off the filesystem, the exports or the source, the way the lockstep and figure gates do.
- **When an honest collision trips a gate, rename the collision rather than widening the gate.** A pattern loosened
  to let one legitimate case through stops catching the illegitimate ones.
