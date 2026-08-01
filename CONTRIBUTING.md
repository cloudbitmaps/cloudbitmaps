# Contributing to CloudBitmaps

How this project is built — the **canonical** record of our conventions and working process, for humans
*and* for any AI tooling. (The agent operating manual, [`CLAUDE.md`](CLAUDE.md), embeds the engineering
**principles** and the project's **hard correctness invariants**, and points here for the process below.)

> CloudBitmaps is pre-release and built in phases — see the roadmap (the
> living source of project state).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Issues and pull requests use the
forms and template in [`.github/`](.github/); security reports go **privately** via
[`SECURITY.md`](SECURITY.md), never a public issue.

## Commands (the gate)

CI runs exactly these, and all must pass (TypeScript, pnpm):

- `pnpm lint` · `pnpm lint:arch` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` · `pnpm build` ·
  `pnpm smoke`
- `pnpm test:integration` — against the docker-compose backends (DynamoDB-Local, MinIO, fake-gcs-server,
  Azurite, Postgres, Redis, Mongo, Cassandra, MySQL) — no real cloud account needed
- `pnpm lint:arch` is the dependency-cruiser gate enforcing the storage-agnostic-core rule — and, since
  `core-no-node-builtins`, the **runtime**-agnostic one too.
- `pnpm smoke` loads the **built** packages through their `exports` maps under both ESM and `require()`, on
  every driver subpath, and cross-checks the `Symbol.for`-branded error predicates across bundles — the class
  of bug the source-graph tests structurally cannot see.

A fresh clone must pass `install → lint → lint:arch → format:check → typecheck → test → build → smoke` with
**no manual setup** (Node ≥20 — `.nvmrc` pins 22 — and pnpm 9; Docker only for `test:integration`).
Every command runs from the **repo root** — it is a pnpm workspace, and the root scripts cover both packages.

## Repo layout (a pnpm workspace of two packages)

The `@cloudbitmaps` family split makes this repo a workspace
(`pnpm-workspace.yaml` → `packages/*`). Where code lives:

| Path | Package | Holds |
|---|---|---|
| `packages/core/src/` | **`@cloudbitmaps/core`** (zero runtime deps) | the codec-agnostic `SegmentEngine` + the `CodecInterface` seam, **every** storage driver (`drivers/` + the `s3` / `dynamodb` / `gcs` / `azure` / `postgres` / `redis` / `mongodb` / `cassandra` / `mysql` subpath barrels, SDKs as optional peers), the `.crbm` format, compaction, crypto, registry, consistency, budget, eject |
| `packages/roaring/src/` | **`@cloudbitmaps/roaring`** (depends on core) | the roaring codec (`SafeBitmap` / `roaringCodec`), the `CloudRoaring` facade, one-line re-export barrels for each driver subpath, the `compact-segments` / `export-segments` CLIs, and the test-only conformance SDK |
| `tests/` (repo root) | — | **all** tests, deliberately *not* per package: many drive the facade and core internals together, so the `@/…` alias is remapped onto the two packages (`@/index` → the facade, `@/roaring-codec` → the codec, `@/*` → core) in `vitest.config.ts` + the root `tsconfig.json` |
| `bench/` · `fuzz/` · `scripts/` · `site/` · `docs/` | — | benchmarks, fuzz targets, gate scripts, the static site, and the docs trees below |

A user installs **one flavor** (`@cloudbitmaps/roaring`); core arrives transitively and is never installed
directly. The dependency arrow is one-way — `lint:arch` fails if core imports a flavor package, if the main entry
reaches a cloud SDK, or if `core/` reaches a driver impl.

`core/` is also **runtime**-agnostic: `lint:arch` fails on any `node:*` import under `packages/core/src/core`, so
the seam stays loadable where no node builtin exists (a V8 isolate — Workers, Deno Deploy). Randomness, time and
I/O reach it through injected seams — `Clock`, `Rng`, `BlobReader`, the driver ports — which is what makes that
enforceable rather than aspirational. **Anything needing a builtin belongs in a driver under `src/drivers`**,
where all of them live today.

## Branching & merge conventions

- **Branch off `main`** for all code. Prefix by intent: **`feature/<slug>`**, **`fix/<slug>`**,
  **`chore/<slug>`** (setup/tooling/deps). **Docs-only** changes may go straight to `main`.
- **Squash-merge** every PR into `main` (one commit per PR → linear, readable history).
- **After merge, delete the branch — remote *and* local** (`git push origin --delete <branch>` +
  `git branch -d <branch>`). Don't let merged branches linger.
- **Code PRs wait for an explicit per-PR approval** before merging; docs-only PRs may merge once green.
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

1. **Branch off `main`** per the conventions above. **Docs-only** changes may go straight to `main`.
2. **Build with tests, not after.** No untested code — new behavior ships with tests in the same commit.
   The [correctness invariants](CLAUDE.md#hard-correctness-invariants) each get named tests, including
   property/concurrency tests for the compaction and OCC paths.
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
   - **docs & spec fidelity** — does the code match the specs (``–`09`) and its own
     doc-comments? are the roadmap/guide/changelog current?
   - **anything else** the domain suggests.

   Triage → fix the real ones in the same change, or log to the roadmap /
   the phase doc with a severity + deferral. After substantive fixes, an **adversarial verification pass**
   (re-review the fixed code, ideally mutation-tested) before merging. This is **mandatory, not optional**.
5. **Keep the docs current** — see [Documentation](#documentation--keeping-it-current) below (guide,
   README, CHANGELOG, DECISIONS, roadmap), *in the same change*.
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
| `docs/benchmarks.md` | users | measured cost/latency + the methodology behind each number | a benchmark or calibration run lands |
| `CODE_OF_CONDUCT.md` · `.github/` | contributors | Contributor Covenant, PR template, issue forms | the gate or process changes |

**When a change ships a user-visible capability or a public-API change — in the same change:**

1. **Guide** — update [`docs/guide/getting-started.md`](docs/guide/getting-started.md); add a how-to when a
   headline capability lands.
2. **API reference** — a new export **cannot** merge undocumented; CI enforces it.
3. **README** — refresh the status line / "what works today" / quick taste if the surface moved.
4. **CHANGELOG** — add a bullet at the **top** of `[Unreleased]` (newest first).
5. **Roadmap** — update [`docs/ROADMAP.md`](docs/ROADMAP.md) after any meaningful change, not only at
   milestones. It must **never lag reality**.

Benchmark and cost claims carry their methodology, and are labelled **measured** or **modeled** — never
presented as one when they are the other. See [`docs/benchmarks.md`](docs/benchmarks.md).

## Code style

- TypeScript strict; discriminated unions over class hierarchies; `readonly` state; **typed errors**
  (`WriteConflictError`, `IntegrityError`, …) over thrown strings — callers must learn *why* something failed.
- Tests live at the **repo root under `tests/`, mirroring the package source trees** (e.g.
  `packages/core/src/core/lru.ts` → `tests/core/lru.test.ts`), not co-located with source and not split per
  package — the `@/…` alias remap (see [Repo layout](#repo-layout-a-pnpm-workspace-of-two-packages)) keeps that
  mirror intact across the split. Integration tests under `tests/integration/`. Concurrency/property tests for
  compaction, OCC, and tier-merge.
- Pluggable drivers behind explicit interfaces; a driver **conformance suite**
  ([`packages/roaring/src/testing/conformance.ts`](packages/roaring/src/testing/conformance.ts)) every driver
  (incl. community ones) must pass.
- The engineering **principles** (SOLID/DRY/KISS/YAGNI, fail-fast, security-by-default, determinism,
  boy-scout) are in [`CLAUDE.md`](CLAUDE.md#principles); the **hard correctness invariants** (tombstones,
  generation fencing, untrusted bytes, bounded memory, storage-agnostic core) are in
  [`CLAUDE.md`](CLAUDE.md#hard-correctness-invariants).
