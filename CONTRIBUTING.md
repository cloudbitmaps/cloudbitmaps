# Contributing to CloudBitmaps

How this project is built — the **canonical** record of our conventions and working process, for humans
*and* for any AI tooling. (The agent operating manual, [`AGENTS.md`](AGENTS.md), embeds the engineering
**principles** and the project's **hard correctness invariants**, and points here for the process below.
`CLAUDE.md` is a symlink to `AGENTS.md`.)

> CloudBitmaps is pre-release and built in phases — see the roadmap (the
> living source of project state).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Issues and pull requests use the
forms and template in [`.github/`](.github/); security reports go **privately** via
[`SECURITY.md`](SECURITY.md), never a public issue.

## Commands (the gate)

CI runs exactly these, and all must pass (TypeScript, pnpm):

- `pnpm lint` · `pnpm lint:arch` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` · `pnpm build` ·
  `pnpm smoke`
- `pnpm test:integration` — against the docker-compose backends (MinIO, fake-gcs-server,
  Azurite) — no real cloud account needed
- `pnpm lint:arch` runs `tests/arch`: the import graph is acyclic, and every import-boundary rule in `eslint.config.js` (the storage-agnostic-core rule and its siblings) is proven to fire on a planted violation — and, since
  `core-no-node-builtins`, the **runtime**-agnostic one too.
- `pnpm smoke` loads **every** built package through its own `exports` map under both ESM and `require()` —
  the entry list is derived from each manifest, so a declared entry that does not load fails the build — and
  cross-checks the `Symbol.for`-branded error and backend predicates ACROSS PACKAGES, and asserts the five
  built packages really do share **one** copy of core — every package leaves `@cloudbitmaps/core` external,
  so `instanceof` holds across them and a regression to a bundled copy would break it silently. Both halves
  are the class of bug the source-graph tests structurally cannot see.

A fresh clone must pass `install → lint → lint:arch → format:check → typecheck → test → build → smoke` with
**no manual setup** (Node ≥22.12, which the manifests enforce — `.nvmrc` pins the major, 22 — and pnpm 9; Docker only for
`test:integration`).
Every command runs from the **repo root** — it is a pnpm workspace, and the root scripts cover all five packages.

## Repo layout (a pnpm workspace of five packages)

The `@cloudbitmaps` family split makes this repo a workspace
(`pnpm-workspace.yaml` → `packages/*`). Where code lives:

| Path | Package | Holds |
|---|---|---|
| `packages/core/src/` | **`@cloudbitmaps/core`** (zero runtime deps, no cloud SDK) | the codec-agnostic `SegmentEngine` + the `CodecInterface` seam, the driver ports, the in-memory and local-filesystem drivers, the `.crbm` format, the load/publish write path, generation GC, erasure, crypto, registry, consistency, budget, eject — plus `driver-kit`, the declared contract a driver package builds against |
| `packages/roaring/src/` | **`@cloudbitmaps/roaring`** (depends on core) | the flavor: the roaring codec (`SafeBitmap` / `roaringCodec`), the `CloudRoaring` facade, the `export-segments` CLI, and the test-only conformance SDK |
| `packages/{s3,gcs,azure-blob}/src/` | **`@cloudbitmaps/{s3,gcs,azure-blob}`** (depend on core + their SDK) | one package per storage **service**, each a real dependency on its own SDK. They build against `@cloudbitmaps/core/driver-kit` and nothing else of ours — never a flavor, never a sibling |
| `tests/` (repo root) | — | **all** tests, deliberately *not* per package: many drive the facade and core internals together, so the `@/…` alias is remapped onto the packages (`@/index` → the facade, `@/roaring-codec` → the codec, `@/s3/*` → the S3 driver package, `@/*` → core) in `vitest.config.ts` + the root `tsconfig.json`. [`tests/README.md`](tests/README.md) maps each directory and every documentation gate |
| `bench/` · `fuzz/` · `scripts/` · `site/` · `docs/` | — | the benchmarks ([`bench/README.md`](bench/README.md)), fuzz targets ([`fuzz/README.md`](fuzz/README.md)), the build, release and gate scripts ([`scripts/README.md`](scripts/README.md)), the static site ([`site/README.md`](site/README.md)), and the docs trees below |

A user installs **two packages** — a flavor (`@cloudbitmaps/roaring`) and the storage they have
(`@cloudbitmaps/s3`, `/gcs` or `/azure-blob`); core arrives as a dependency of both and is never installed
directly. The dependency arrow is one-way — `lint:arch` fails if core imports a flavor or a driver package, if
any main entry outside a driver package reaches a cloud SDK, or if `core/` reaches a driver impl.

`core/` is also **runtime**-agnostic: `lint:arch` fails on any `node:*` import under `packages/core/src/core`, so
the seam stays loadable where no node builtin exists (a V8 isolate — Workers, Deno Deploy). Randomness, time and
I/O reach it through injected seams — `Clock`, `Rng`, `BlobReader`, the driver ports — which is what makes that
enforceable rather than aspirational. **Anything needing a builtin belongs in a driver** — either one of the
driver packages, or `packages/core/src/drivers/` where the SDK-free memory and local-filesystem drivers live.

## Adding a storage driver package

Most of the topology is **derived** — `scripts/build.mjs` reads each package's own `exports`, the release
workflow globs `packages/*/package.json`, and the `no-circular`, `api-reference-sync`, `issue-template-sync`
and `sdk-floor-claims` gates all read the manifests. Those need no edit.

These do, and the list is exhaustive as of this writing. A missing one fails **loudly** — in `pnpm lint`,
`pnpm typecheck` or `pnpm smoke`, long before a publish — but knowing them up front turns a bisect into a
checklist:

| File | What to add |
|---|---|
| `package.json` | the workspace devDependency, **and** the package in the `typecheck:pkgs` and `typecheck:next` chains (both spell every package out) |
| `tsconfig.json` | the two `paths` entries |
| `vitest.config.ts` · `vitest.integration.config.ts` | the two aliases in **each**, above the `@/*` catch-all |
| `eslint.config.js` | a per-package block re-stating the full SDK list **minus** this package's own — eslint replaces a rule's options rather than merging them |
| `scripts/sdk-specifiers.cjs` | the driver-name pattern |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | the two dropdown options; `tests/docs/issue-template-sync.test.ts` derives the *expectation* and fails until the template catches up |
| docs | the README install + driver tables, `docs/guide/getting-started.md` wiring, the API reference entry points and export index, and the guide index |
| npm | **bootstrap the package name** before any release can include it — see [`RELEASING.md`](RELEASING.md#bootstrapping-a-name) |

Two things to copy rather than invent: the package must declare its SDK as a **real dependency** (never an
optional peer), and its README must state the same range its manifest does — `tests/docs/sdk-floor-claims.test.ts`
compares them.

## Dependency policy

Third-party runtime dependencies are counted **per package**, and each one is deliberate:

| package | third-party runtime deps |
|---|---|
| `@cloudbitmaps/core` | **none** |
| `@cloudbitmaps/roaring` | `roaring` — the native codec, the reason a flavor is a package |
| `@cloudbitmaps/s3` · `/gcs` · `/azure-blob` | its own cloud SDK, and only its own |

A user therefore installs a flavor and the driver for the storage they actually have; nothing is an optional
peer, and no package pulls an SDK for a service the user does not use. Keep it that way:

1. **Per package: as few as that table shows.** Adding a runtime dependency is a design review, not a PR —
   and adding one to `core` means every install pays for it.
2. **A development dependency earns its place on three tests:** (a) it does something we should not write — a
   compiler, a test runner, a formatter, an official cloud SDK — *or* replaces more than ~300 lines we would
   otherwise own; (b) it is widely used (≥ 1M weekly downloads, or the vendor's official SDK) and maintained (a
   release inside 6 months); (c) it sits in the **root** graph only if it runs on every PR. A tool that runs
   nightly or on demand lives in its own manifest (`fuzz/package.json` for the fuzzer; `pnpm dlx` for mutation
   testing), so its transitive graph and its security alerts stay out of the root lockfile.
3. **Failing (b) gets a written replacement plan or an exit date**, not a shrug.
4. **Every direct dependency must be describable in one line** — purpose, and why it is not our own code. One
   nobody can describe is removed.

What we own rather than depend on, and why: the package build (`scripts/build.mjs`: esbuild for the bundles,
`tsc` for the declarations) and the architecture checks (`eslint.config.js` + `tests/arch`). What we deliberately keep
as tools: `husky` + `lint-staged` for the pre-commit hook — lint-staged's handling of *partially staged* files (it
stashes the unstaged hunks, formats the staged ones, restores) is worth its 21 packages, and rewriting it is not.

## Branching & merge conventions

- **Branch off `main`** for every change, docs included: nothing goes straight to `main`. Prefix by intent: **`feature/<slug>`**, **`fix/<slug>`**,
  **`chore/<slug>`** (setup/tooling/deps) — spelled in full; `feat/`, `bug/` and `wip/` are not the set.
- **The slug names the change, not the area it lives in.** Lowercase `kebab-case`, about three to six
  words, readable off `git branch` months later by someone who wasn't there:
  `feature/roll-segment-pointer-back-to-older-generation`, not `feature/rollback`. A one-word slug names a
  *topic*, and `packages/` already holds those. Leave issue and PR numbers out — the PR carries them.
- **Every PR body follows [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)** —
  **What & why** (the problem, not the diff), **How it was tested** (the tests that would fail if this were
  reverted), and the **checklist**. GitHub pre-fills it in the web UI; `gh pr create --body` does not, so
  apply it yourself there.
- **Squash-merge** every PR into `main` (one commit per PR → linear, readable history).
- **After merge, delete the branch — remote *and* local** (`git push origin --delete <branch>` +
  `git branch -d <branch>`). Don't let merged branches linger.
- **Every PR waits for an explicit per-PR approval** before merging, a docs-only one included; green CI is
  necessary, not sufficient.
- **Never** `git commit --no-verify` / `git push --no-verify`; never `Co-Authored-By` trailers.

## Decisions: ask before building the consequential ones

**Surface important decisions and get the user's pick before acting on them — don't just proceed on a
default.** A decision is "important" if it is hard to reverse, precedent-setting, or outward-facing:

- public API / exported surface · the on-disk or wire **format** · **dependencies** added (and how they're
  packaged: bundled vs peer/optional vs subpath export) · architecture or **phase/sub-phase sequencing** ·
  anything users consume or that later phases will build on.

For each such decision, present the realistic **options with their trade-offs**, note the **industry
standard / common practice**, give a **clear recommendation**, and let the user choose **before**
implementing. Reversible, internal, low-stakes details (naming, local algorithm choices, test structure) you
decide yourself with a sensible default — **state the notable ones** so they can be vetoed, and proceed.

When in doubt about whether something is "important," ask. This applies to **all** work, every phase.

## Per-phase working process (follow after EVERY phase AND sub-phase)

The roadmap is built in phases. A **sub-phase** is any meaningful increment / PR within a phase — the gate
below runs after sub-phases too, not just whole phases. For each, in order:

1. **Branch off `main`** per the conventions above, docs-only changes included.
2. **Build with tests, not after.** No untested code — new behavior ships with tests in the same commit.
   The [correctness invariants](AGENTS.md#hard-correctness-invariants) each get named tests, including
   property tests over loaded generations and crash/race tests for the write-then-publish path.
3. **Run the full local gate — and it must be green.** Before review or merge, run every gate command and
   confirm each passes: `pnpm lint` · `pnpm lint:arch` · `pnpm format:check` · **`pnpm typecheck`** ·
   `pnpm test` · `pnpm build`. **`pnpm typecheck` (`tsc --noEmit`) is a required gate exactly like lint and
   the tests** — a clean typecheck (zero errors *and* zero editor red squiggles, e.g. deprecations) is
   mandatory, never deferred or `// @ts-ignore`-d away. CI runs the same set; a fresh clone must pass it with
   no manual setup. Don't open/merge a PR on a red gate.
4. **Run the adversarial review gate (after every phase AND sub-phase).** Spawn **multiple parallel
   adversarial subagents**, each with a distinct lens, to hunt for flaws in what was built **end to end**
   (not just the diff). Standard lenses — use all that apply, add domain-specific ones:
   - **correctness/logic, end-to-end** — trace the whole data/control flow vs the specs + named invariants
     (races, lost writes, merge/tombstone bugs, divergence from the oracle),
   - **bug-hunt** — edge cases, error paths, resource leaks, async/boundary bugs,
   - **security** — untrusted deserialization, injection/traversal, IAM/authz, secrets/PII in logs,
     DoS/denial-of-wallet, supply chain,
   - **scale & performance** — hot chunks/partitions, cost cliffs, memory/cost bounds, O(n²), fan-out,
   - **code quality & standards** — SOLID/DRY/KISS/YAGNI, TS idioms, naming, typed errors, dead code,
   - **testing quality** — are the invariants + edge cases actually covered? property/oracle adequacy,
     determinism, no flaky/slow tests,
   - **docs & spec fidelity** — does the code match its own doc-comments and the
     [hard invariants](AGENTS.md#hard-correctness-invariants)? are the roadmap/guide/changelog current?
   - **anything else** the domain suggests.

   Triage → fix the real ones in the same change, or record them in the PR
   body and the roadmap with a severity + deferral. After substantive fixes, an **adversarial verification pass**
   (re-review the fixed code, ideally mutation-tested) before merging. This is **mandatory, not optional**.
5. **Keep the docs current** — see [Documentation](#documentation--keeping-it-current) below (guide,
   README, CHANGELOG, roadmap), *in the same change*.
6. **Commit and push always.** Commit logically, push the branch to `origin` (don't sit on local-only
   work). Open/update the PR.
7. **Never** `git commit --no-verify` / `git push --no-verify`.

## Documentation — keeping it current

Docs live in two places: **`docs/guide/`** (user-facing, accurate to what's *shipped*, never vapor) and the
root-level project files. What each one is, and when it must be updated:

| Path | Audience | Purpose | Update when |
|---|---|---|---|
| `README.md` | everyone (front page) | what CloudBitmaps is, the problem, how it works, status, a runs-today taste | the surface or status moves |
| `CHANGELOG.md` | users / developers | what changed, **newest first**; Keep a Changelog + SemVer | every user-visible change |
| `CONTRIBUTING.md` | contributors | **this file** — the canonical process & conventions | a convention or the process changes |
| `RELEASING.md` | maintainers | the automated, tokenless, human-gated release pipeline | the release mechanics change |
| `docs/README.md` | everyone | terse router into the docs | the doc structure changes |
| `docs/guide/` | **users** | how to actually use it — accurate to what's shipped | a user-visible capability or public API ships |
| `docs/guide/api-reference.md` | users | the complete callable surface — every export, every entry point | **CI-enforced**: `tests/docs/api-reference-sync.test.ts` fails the build if an export is undocumented |
| `docs/ROADMAP.md` | **users** | what's shipped, the **validated envelope**, the path to `1.0`, and the explicit not-planned list | capabilities land, or the envelope changes |
| `docs/benchmarks.md` | users | the published cost and memory figures, how each was measured or modelled, and what is still owed, in-region latency among them | a benchmark or calibration run lands |
| `bench/` · `scripts/` · `site/` · `tests/` — each `README.md` | contributors | a row for every part of that directory — each file in `bench/` and `scripts/`; each page and top-level file in `site/`; each directory, top-level file and documentation gate in `tests/` — saying what it is and what runs it | a part there is added, removed or renamed — **CI-enforced**: `tests/docs/directory-readmes.test.ts` fails when a part has no row, or a row names a path that does not exist |
| `CODE_OF_CONDUCT.md` · `.github/` | contributors | Contributor Covenant, PR template, issue forms | the gate or process changes |

**When a change ships a user-visible capability or a public-API change — in the same change:**

1. **Guide** — update [`docs/guide/getting-started.md`](docs/guide/getting-started.md); add a how-to when a
   headline capability lands.
2. **API reference** — a new export **cannot** merge undocumented; CI enforces it.
3. **README** — refresh the status line / "what works today" / quick taste if the surface moved.
4. **CHANGELOG** — add a bullet at the **top** of `[Unreleased]` (newest first). This is the prose, and it
   is hand-written: `.changeset/` does **not** generate it, deliberately
   ([why](.changeset/README.md)).
5. **Changeset** — `pnpm changeset`, if the change should move the version. It records the **bump type**
   only; all five packages move together, and pre-`1.0` a breaking change is a **minor**. A change that ships
   no version move (docs, tests, tooling) needs none.
6. **Roadmap** — update [`docs/ROADMAP.md`](docs/ROADMAP.md) after any meaningful change, not only at
   milestones. It must **never lag reality**.

Benchmark and cost claims carry their methodology, and are labelled for what they are: **measured** (read off a
run), **derived** (measured counts times list prices), **expected** (what the code predicts for a case no run
measured) or **modelled** (the estimator's output) — never presented as one when they are the other. See
[`docs/benchmarks.md`](docs/benchmarks.md).

**Nothing here may cite a document a reader cannot open.** This repository is public and its design
discussion is not, so an id like `Phase 4e`, `gap #1`, `finding S2` or `test-strategy T3` points nowhere —
and it is worse than saying less, because it implies checkable evidence and then withholds it. State the
**substance** inline instead: not *"bounded by parsed-index bytes (gap #1)"* but *"bounded by parsed-index
bytes, because a wide segment's index — not its payloads — dominates the reader's footprint"*. The reader
gets the reasoning rather than a dead reference to it.

This applies to code comments as much as prose: a doc-comment reaches users on hover in their editor and
inside the published `.d.ts` and sourcemaps. **CI-enforced** by
[`tests/docs/internal-citations.test.ts`](tests/docs/internal-citations.test.ts), which scans every tracked
text file. Ids a reader *can* resolve are fine and stay: the seven hard invariants in
[`AGENTS.md`](AGENTS.md), a `§` section of a public guide, and a `#123` issue or PR on this repository.

## Code style

- TypeScript strict; discriminated unions over class hierarchies; `readonly` state; **typed errors**
  (`WriteConflictError`, `IntegrityError`, …) over thrown strings — callers must learn *why* something failed.
- Tests live at the **repo root under `tests/`, mirroring the package source trees** (e.g.
  `packages/core/src/core/lru.ts` → `tests/core/lru.test.ts`), not co-located with source and not split per
  package — the `@/…` alias remap (see [Repo layout](#repo-layout-a-pnpm-workspace-of-five-packages)) keeps that
  mirror intact across the split. Integration tests under `tests/integration/`. Property tests over loaded
  generations, and race tests for the write-then-publish path.
- Pluggable drivers behind explicit interfaces; a driver **conformance suite**
  ([`packages/roaring/src/testing/conformance.ts`](packages/roaring/src/testing/conformance.ts)) every driver
  (incl. community ones) must pass.
- The engineering **principles** (SOLID/DRY/KISS/YAGNI, fail-fast, security-by-default, determinism,
  boy-scout) are in [`AGENTS.md`](AGENTS.md#principles); the **hard correctness invariants** (tombstones,
  generation fencing, untrusted bytes, bounded memory, storage-agnostic core) are in
  [`AGENTS.md`](AGENTS.md#hard-correctness-invariants).
