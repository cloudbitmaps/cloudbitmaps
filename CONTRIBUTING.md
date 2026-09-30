# Contributing to CloudBitmaps

How this project is built — the **canonical** record of our conventions and working process, for humans
*and* for any AI tooling. (The agent operating manual, [`AGENTS.md`](AGENTS.md), embeds the engineering
**principles** and the project's **hard correctness invariants**, and points here for the process below.
`CLAUDE.md` is a symlink to `AGENTS.md`.)

> CloudBitmaps is pre-`1.0`: the format and the API can still move in a minor release.
> [`docs/ROADMAP.md`](docs/ROADMAP.md) is what's shipped, what's proven, and what's next.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Issues and pull requests use the
forms and template in [`.github/`](.github/); security reports go **privately** via
[`SECURITY.md`](SECURITY.md), never a public issue.

## Commands (the gate)

Every change must pass these locally, and CI runs each of them on every pull request (TypeScript, pnpm):

- `pnpm lint` · `pnpm lint:arch` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` · `pnpm build` ·
  `pnpm smoke`
- `pnpm test:integration` — against the docker-compose backends (MinIO, fake-gcs-server,
  Azurite) — no real cloud account needed. Locally it needs Docker with the backends started first
  (`docker compose up -d`, as [`tests/README.md`](tests/README.md) says), and a change that touches a driver runs it
- `pnpm lint:arch` runs `tests/arch`: the import graph is acyclic; every import-boundary rule in
  `eslint.config.js` (the storage-agnostic-core rule and its siblings, the **runtime**-agnostic
  `core-no-node-builtins` among them) is proven to fire on a planted violation, and so is `core/`'s ban on the
  `fetch` and `crypto` globals, on the global object (`globalThis`, `self`, `window`, `global`), on `eval` and the
  `Function` constructor, and on dynamic `import()`; and the
  detectors the build, `pnpm smoke` and the Node-floor gate rely on are fired at planted inputs in both
  directions.
- `pnpm smoke` loads **every** built package through its own `exports` map under both ESM and `require()` —
  the entry list is derived from each manifest, so a declared entry that does not load fails the build. It checks
  that core's error predicates classify an error the built `@cloudbitmaps/s3` throws, and that the store takes a
  backend that package builds, so the predicates are wired across a real package boundary; and it asserts that
  core, the flavor and the S3 package share **one** copy of core — every package leaves `@cloudbitmaps/core`
  external, so `instanceof` holds across them and a regression to a bundled copy would break it silently. Both
  halves are the class of bug the source-graph tests structurally cannot see. It cannot see whether the brands are
  registered `Symbol.for`s, since with one shared copy of core a plain `Symbol` passes too; that is
  [`tests/core/error-predicates.test.ts`](tests/core/error-predicates.test.ts)'s to prove.

CI runs more than these. Its `build & test` job also holds the site and the benchmark pages to their sources
(`site:replay:check`, `bench:scale:check`, `site:figures`, `site-classes.py`, `site-links.py`, `bench:sizing:check`,
`bench:check`), scans the tracked tree and the packed tarballs for leaks, and checks the fuzz lockfile; separate
jobs run the dependency audit, the smoke test on the declared Node floor, the Lambda deployability smoke, the hard
RSS ceiling and the native addon on Linux, Windows and macOS. [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
says why each one is there.

A fresh clone must pass `install → lint → lint:arch → format:check → typecheck → test → build → smoke` with
**no manual setup** (Node ≥22.12, the floor the packages declare — `.nvmrc` pins the major, 22, and the dev tools
want a current 22: lint-staged, which the pre-commit hook runs, declares 22.22.1 or later — and pnpm 9; Docker only
for `test:integration`).
Every command runs from the **repo root** — it is a pnpm workspace, and the root scripts cover all five packages.

## Repo layout (a pnpm workspace of five packages)

The `@cloudbitmaps` family is five packages, so this repo is a workspace
(`pnpm-workspace.yaml` → `packages/*`). Where code lives:

| Path | Package | Holds |
|---|---|---|
| `packages/core/src/` | **`@cloudbitmaps/core`** (zero runtime deps, no cloud SDK) | the codec-agnostic `SegmentEngine` + the `CodecInterface` seam, the driver ports, the in-memory and local-filesystem drivers, the `.crbm` format, the load/publish write path, generation GC, erasure, crypto, registry, consistency, budget, eject — plus `driver-kit`, the declared contract a driver package builds against |
| `packages/roaring/src/` | **`@cloudbitmaps/roaring`** (depends on core) | the flavor: the roaring codec (internal, not exported), the `CloudRoaring` facade, the `export-segments` CLI, and the test-only conformance SDK |
| `packages/{s3,gcs,azure-blob}/src/` | **`@cloudbitmaps/{s3,gcs,azure-blob}`** (depend on core + their SDK) | one package per storage **service**, each a real dependency on its own SDK. They build against `@cloudbitmaps/core/driver-kit` and nothing else of ours — never a flavor, never a sibling |
| `tests/` (repo root) | — | **all** tests, deliberately *not* per package: many drive the facade and core internals together, so the `@/…` alias is remapped onto the packages (`@/index` → the facade, `@/roaring-codec` → the codec, `@/s3/*` → the S3 driver package, `@/*` → core) in `vitest.config.ts` + the root `tsconfig.json`. [`tests/README.md`](tests/README.md) maps each directory and every documentation gate |
| `bench/` · `fuzz/` · `scripts/` · `site/` · `docs/` | — | the benchmarks ([`bench/README.md`](bench/README.md)), fuzz targets ([`fuzz/README.md`](fuzz/README.md)), the build, release and gate scripts ([`scripts/README.md`](scripts/README.md)), the static site ([`site/README.md`](site/README.md)), and the docs trees below |

A user installs **two packages** — a flavor (`@cloudbitmaps/roaring`) and the storage they have
(`@cloudbitmaps/s3`, `/gcs` or `/azure-blob`); core arrives as a dependency of both and is never installed
directly. The dependency arrow is one-way — `pnpm lint` fails if core imports a flavor or a driver package, if
core or the flavor names a cloud SDK, or if `core/` reaches a driver impl, and `pnpm smoke` fails if a built main
entry outside a driver package names an SDK or a driver package. `pnpm lint:arch` proves each of those lint rules
fires.

`core/` is also **runtime**-agnostic: `pnpm lint` fails on any `node:*` import under `packages/core/src/core` (a dynamic `import()` is refused there
whatever its source), and
on the `fetch` and `crypto` globals there, and on the global object that would reach them (`globalThis`, `self`,
`window`, `global`) and on `eval` and the `Function` constructor, so the seam stays loadable where no node builtin exists (a V8 isolate — Workers, Deno Deploy). Randomness, time and I/O reach it through injected seams — `Clock`, `Rng`, `BlobReader`, the
driver ports — which is what makes that enforceable rather than aspirational. **Anything needing a builtin belongs
in a driver** — either one of the driver packages, or `packages/core/src/drivers/` where the SDK-free memory and local-filesystem drivers live.

## Adding a storage driver package

Most of the topology is **derived** — `scripts/build.mjs` reads each package's own `exports`, the release
workflow globs `packages/*/package.json`, and the `no-circular`, `api-reference-sync` and `sdk-floor-claims` gates
all read the manifests. Those need no edit.

These do. The last column says what fails when one is missing: most fail a local gate long before a publish, and
the ones marked **nothing** fail no gate at all, so this table is the only thing that remembers them.

| File | What to add | What fails without it |
|---|---|---|
| `package.json` | the workspace devDependency, **and** the package in the `typecheck:pkgs` and `typecheck:next` chains (both spell every package out) | the devDependency: `pnpm smoke`, which loads each package by name. The chains: **nothing** — the root program still typechecks the source, but under the root's settings rather than the package's own `tsconfig.json` |
| `tsconfig.json` | the two `paths` entries | `pnpm typecheck`, once a test imports the package through them |
| `vitest.config.ts` · `vitest.integration.config.ts` | the two aliases in **each**, above the `@/*` catch-all | `pnpm test` or `pnpm test:integration`, once a test imports the package through them |
| `eslint.config.js` | a per-package block re-stating the full SDK list **minus** this package's own — eslint replaces a rule's options rather than merging them | `pnpm lint`, at the package's first import of its own SDK, which the generic driver block refuses |
| `eslint.config.js` | the new name in the flavor block's driver-package pattern (`^@cloudbitmaps/(s3\|gcs\|azure-blob)(/\|$)`) | **nothing** — the flavor can then import or re-export the new driver, lint-clean |
| `tests/arch/import-boundaries.test.ts` | planted violations for that block and the flavor pattern, as the s3, gcs and azure-blob blocks have | **nothing** — and without them, a later edit that empties the block fails nothing either. (A package named `r2` is the exception: the file plants its generic-block cases at `packages/r2`, which a real `r2` block then fails until they move.) |
| `scripts/sdk-specifiers.cjs` | the driver-name pattern | **nothing** — `pnpm smoke` then misses a main entry that names the new package |
| `.github/workflows/release.yml` | `EXPECTED_PACKAGES`, the number of manifests the release must find | `pnpm test`: `tests/ci/release-workflow.test.ts` compares it with the workspace |
| `.github/ISSUE_TEMPLATE/bug_report.yml` · `tests/docs/issue-template-sync.test.ts` | the two dropdown options, and the backend's label in the test's `LABELS` map | `pnpm test`: the test derives which drivers exist from the packages, and spells each one's options from `LABELS` |
| `docker-compose.yml` | the backend's emulator, as a service on a pinned image | a floating tag: `pnpm test` (`tests/ci/compose-images.test.ts`). The service: `pnpm test:integration`, once a test needs it. The CI image pull reads the file, so it needs no edit |
| `tests/integration/` | a test that runs the conformance suite against that emulator, as `s3.test.ts`, `gcs.test.ts` and `azure.test.ts` do | **nothing** — the package is then never run against a backend |
| the package's `README.md` · `site/usage.html` | the SDK range the manifest declares, verbatim, in both: the README's statement of it and the site's driver table | `pnpm test`: `tests/docs/sdk-floor-claims.test.ts` compares all three |
| docs and site | the README install + driver tables, `docs/guide/getting-started.md` wiring, the API reference entry points and export index, the guide index, and every site page that lists the drivers (`grep -rl '@cloudbitmaps/gcs' site` finds them) | the API reference: `pnpm test` (`tests/docs/api-reference-sync.test.ts`). The rest: **nothing** |
| every place that names the SDK roots, if the new SDK is not under `@aws-sdk/`, `aws-sdk`, `@google-cloud/` or `@azure/` | the new root in each eslint `group` list, `SDK_ROOTS` in `scripts/sdk-specifiers.cjs`, `CLOUD_SDK` in `scripts/smoke.cjs`, and the SDK patterns in `tests/docs/issue-template-sync.test.ts` and `tests/docs/sdk-floor-claims.test.ts` | **nothing** — those gates then do not see the package as a driver, so the eslint, issue-template and SDK-range rows above fail nothing either |
| npm | **bootstrap the package name** before any release can include it — see [`RELEASING.md`](RELEASING.md#bootstrapping-a-name) | the release workflow's registry probe, which refuses the run before its publish step |

One thing to copy rather than invent: the package declares its SDK as a **real dependency**, never an optional
peer.

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
stashes the unstaged hunks, formats the staged ones, restores) is worth its three dependencies, and rewriting it is
not.

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
  packaged: bundled vs peer/optional vs subpath export) · architecture or **the order work lands in** ·
  anything users consume or that later work will build on.

For each such decision, present the realistic **options with their trade-offs**, note the **industry
standard / common practice**, give a **clear recommendation**, and let the user choose **before**
implementing. Reversible, internal, low-stakes details (naming, local algorithm choices, test structure) you
decide yourself with a sensible default — **state the notable ones** so they can be vetoed, and proceed.

When in doubt about whether something is "important," ask. This applies to **all** work.

## Working process (every pull request)

Every change reaches `main` as a pull request, however small, and every pull request follows these steps, in
order:

1. **Branch off `main`** per the conventions above, docs-only changes included.
2. **Build with tests, not after.** No untested code — new behavior ships with tests in the same commit.
   The [correctness invariants](AGENTS.md#hard-correctness-invariants) each get named tests, including
   property tests over loaded generations and crash/race tests for the write-then-publish path.
3. **Run the full local gate — and it must be green.** Before review or merge, run every gate command and
   confirm each passes: `pnpm lint` · `pnpm lint:arch` · `pnpm format:check` · **`pnpm typecheck`** ·
   `pnpm test` · `pnpm build` · `pnpm smoke`. **`pnpm typecheck` is a required gate exactly like lint and the
   tests**, and it runs two compilers, each `--noEmit` over the root program and every package's own
   `tsconfig.json`: TypeScript 5.9, which lint and the declaration build use, and TypeScript 7
   (`typecheck:next`). A clean typecheck (zero errors *and* zero editor red squiggles, e.g. deprecations) is
   mandatory, never deferred or `// @ts-ignore`-d away. CI runs the same set and more; a fresh clone must pass it
   with no manual setup. Don't open/merge a PR on a red gate.
4. **Run the adversarial review gate (every pull request).** Spawn **multiple parallel
   adversarial subagents**, each with a distinct lens, to hunt for flaws in what was built **end to end**
   (not just the diff). Standard lenses — use all that apply, add domain-specific ones:
   - **correctness/logic, end-to-end** — trace the whole data/control flow vs the specs + named invariants
     (races, lost writes, a torn read, a pointer that moves backwards, a live generation collected, divergence
     from the oracle),
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
4. **CHANGELOG** — add a bullet at the **top** of its subsection of `[Unreleased]` (newest first): **Breaking**
   (with what a caller does about it, and the section's opening count kept in step), **Added**, **Changed** or
   **Fixed**. This is the prose, and it
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
[`tests/docs/internal-citations.test.ts`](tests/docs/internal-citations.test.ts), which scans every `.ts`, `.js`,
`.cjs`, `.mjs`, `.md`, `.html`, `.json`, `.yml`, `.yaml` and `.txt` file in the tree — except itself and this file,
which spell the forms out to define the rule. A shell or Python script is not scanned, so keep ids out of those by
hand. Ids a reader *can* resolve are fine and stay: the seven hard invariants in
[`AGENTS.md`](AGENTS.md), a `§` section of a public guide, and a `#123` issue or PR on this repository.

## Code style

- TypeScript strict; discriminated unions over class hierarchies; `readonly` state; **typed errors**
  (`WriteConflictError`, `IntegrityError`, …) over thrown strings — callers must learn *why* something failed.
- Tests live at the **repo root under `tests/`, mirroring the package source trees** (e.g.
  `packages/core/src/core/lru.ts` → `tests/core/lru.test.ts`), not co-located with source and not split per
  package — the `@/…` alias remap (see [Repo layout](#repo-layout-a-pnpm-workspace-of-five-packages)) keeps that
  mirror intact across the packages. Integration tests under `tests/integration/`. Property tests over loaded
  generations, and race tests for the write-then-publish path.
- Pluggable drivers behind explicit interfaces; a driver **conformance suite**
  ([`packages/roaring/src/testing/conformance.ts`](packages/roaring/src/testing/conformance.ts)) that every driver
  in this repo passes: the memory and local-filesystem drivers in `tests/conformance/`, the cloud drivers against
  their emulators in `tests/integration/`. The suite is **not published** — `@cloudbitmaps/roaring` exports its main entry only — so a driver outside this repo cannot run it;
  the [API reference](docs/guide/api-reference.md#driver-kit--what-you-need-to-implement-a-driver) lists the
  behaviours such a driver has to reproduce by hand.
- The engineering **principles** (SOLID/DRY/KISS/YAGNI, fail-fast, security-by-default, determinism,
  boy-scout) are in [`AGENTS.md`](AGENTS.md#principles); the seven **hard correctness invariants** (write-once
  generations whose pointer only moves forward within a row's incarnation, immutable generation-keyed objects, a
  read that is never torn, GC that never touches the current generation, untrusted tier bytes, bounded memory and
  cost, and a storage- and runtime-agnostic core) are in [`AGENTS.md`](AGENTS.md#hard-correctness-invariants).
