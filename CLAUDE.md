# CLAUDE.md — CloudBitmaps

Distributed, cloud-native Roaring Bitmaps. Maps each 16-bit Roaring chunk onto tiered pluggable cloud storage
(**hot** RAM LRU → **warm** NoSQL/SQL deltas → **cold** immutable `.crbm` objects), wrapping `roaring-node`/CRoaring
for the bit math. The crown jewel is **serverless chunk-skipping intersection**: `A ∩ B` fetches only the chunks
that can possibly contribute.

Start with the [README](README.md), then the [getting-started guide](docs/guide/getting-started.md) and the
[API reference](docs/guide/api-reference.md) — the complete callable surface, kept in sync with the exports by CI.
[`docs/ROADMAP.md`](docs/ROADMAP.md) is what's shipped, what's proven to what degree, and what's next;
[`docs/benchmarks.md`](docs/benchmarks.md) carries the measured cost/latency numbers and their methodology.

## Repo layout

A **pnpm workspace of two packages**, both versioned in lockstep:

- **`packages/core` → `@cloudbitmaps/core`** — the codec-agnostic engine (`SegmentEngine` + the `CodecInterface`
  seam) and **every** storage driver as optional-peer subpaths (`/s3`, `/dynamodb`, `/gcs`, `/azure`, `/postgres`,
  `/redis`, `/mongodb`, `/cassandra`, `/mysql`), plus the `.crbm` format, compaction, crypto, registry,
  consistency, budget, eject. **Zero runtime dependencies.**
- **`packages/roaring` → `@cloudbitmaps/roaring`** — the roaring codec (`SafeBitmap`/`roaringCodec`), the
  `CloudRoaring` facade, one-line re-export barrels per driver subpath, and the two CLIs. Depends on core.
- **Users install one flavor** — `npm i @cloudbitmaps/roaring` (+ only the backend SDK(s) they use);
  `@cloudbitmaps/core` arrives **transitively, never installed directly**.
- **Tests live at the repo root under `tests/`** (many drive the facade + core internals together), with the
  `@/…` alias remapped onto the packages in `vitest.config.ts` and the root `tsconfig.json`. All gate commands
  run from the root. See [CONTRIBUTING](CONTRIBUTING.md#repo-layout-a-pnpm-workspace-of-two-packages).

## Principles

Build by these:

- **SOLID** — one responsibility per module; extend via composition / new driver impls, not edits; substitutable implementations (same conformance suite); small interfaces; depend on abstractions (inject drivers, `Clock`, `Rng`).
- **DRY** — one source of truth; **derive state, don't duplicate it**; reuse before adding.
- **KISS / YAGNI — simplicity and performance are non-negotiable.** The simplest thing that works; build for today's requirement (reserve format space for the future, build it when real). **Don't over-complicate anything, and never ship something that hurts performance** — a feature most users won't use must not tax the hot path (`add`/`has`/`remove`/`count`/`intersect`) everyone pays for. No always-on write-amplification, extra storage copies, or per-op overhead to speed up a rare operation; push it to wiring-time, create-time, the daemon, an admin call, a recipe, or docs instead. Over-engineering is itself a failure.
- **Fail fast, typed errors** — validate at boundaries; typed errors (`WriteConflictError`, `IntegrityError`, …) over thrown strings; never silently swallow.
- **Security by default** — all tier bytes are untrusted (safe-deserialize + size cap); least privilege; never log keys/PII/bitmap contents.
- **Determinism** — inject `Clock`/`Rng`; keep `packages/core/src/core/` a pure, storage-agnostic seam (no I/O, time, randomness, or cloud SDK), lint-enforced.
- **Readable over clever; boy-scout rule** — leave code cleaner than you found it; delete dead code/assets.

## Working process & conventions

**Canonical: [`CONTRIBUTING.md`](CONTRIBUTING.md)** (branching/merge, the full process, code style).

**Ask before consequential decisions.** For any choice that is hard to reverse, precedent-setting, or
outward-facing — public API/exports, the on-disk/wire **format**, **dependencies** and how they're packaged, or
architecture — present the options (trade-offs + industry norm + a recommendation) and get agreement **before**
building. Decide reversible/internal details yourself with a sensible default, and say which ones you chose so
they can be vetoed.

The essentials, in order:

1. **Branch off `main`** — `feature/`/`fix/`/`chore/`; docs-only may go straight to `main`.
2. **Build with tests, not after** — new behavior ships with tests in the same commit; each
   [hard invariant](#hard-correctness-invariants) gets named tests (property/concurrency for the compaction and
   OCC paths).
3. **Run the full local gate green** — `lint · lint:arch · format:check · typecheck · test · build`; every one
   must pass before review. **`pnpm typecheck` is required exactly like `test`/`lint`** — zero `tsc` errors *and*
   zero editor red squiggles; never deferred or `@ts-ignore`-d.
4. **Review adversarially, end to end** — distinct lenses (correctness · bug-hunt · security · scale & perf ·
   code quality · testing quality · docs fidelity), not just the diff. Fix the real findings in the same change
   or record them with a severity and a deferral.
5. **Keep docs current in the same change** — the [guide](docs/guide/getting-started.md),
   [API reference](docs/guide/api-reference.md), [README](README.md), `CHANGELOG.md` (`[Unreleased]`,
   newest-first), and [`docs/ROADMAP.md`](docs/ROADMAP.md). Docs must never lag reality.
6. **Commit + push**; open the PR. **Squash-merge**, then delete the branch.
7. **Never** `git commit --no-verify` / `git push --no-verify`.

**Gate** (CI runs all; all must pass): `pnpm lint · lint:arch · format:check · typecheck · test · build`, plus
`pnpm test:integration` against real backends via docker-compose. A fresh clone must pass
`install → lint → format:check → typecheck → test → build` with no manual setup. **`pnpm typecheck` runs two
compilers** — TypeScript 5.9 (primary; drives lint and the dts build) and a TS7 forward `--noEmit` gate
(`typecheck:next`); it collapses to TS7-primary once `typescript-eslint` supports it.

Releases are automated, tokenless and human-gated — see [`RELEASING.md`](RELEASING.md).

## Hard correctness invariants

These are the protocol fixes the design *must* honor — each one reshapes the data model, and each came out of an adversarial review before a line was written:

1. **Tombstones are first-class.** A chunk carries `adds` + `removes`; effective set = `(Cold ∪ Warm.adds) \ Warm.removes`. There is a real `remove()`. (Fixes the "OR-merge can't delete" hole.)
2. **Generation + per-chunk version fencing.** Compaction purges Warm rows **conditionally** on the version it archived; post-scan writes survive. Cold objects are **generation-keyed and immutable** (`segment.<gen>.crbm` + a `LATEST` pointer); never overwrite in place.
3. **Compaction merges Cold ∪ Warm**, never rebuilds from Warm alone.
4. **Reads are tier-merging** where a chunk can co-reside; a single-tier fast path is allowed only where provably safe.
5. **All tier bytes are untrusted input.** Use the **safe** roaring deserializer + a hard size cap before the native addon; never the trusting variant.
6. **Bounded memory & cost, always.** Hard LRU ceiling; bounded intersection concurrency; per-op budgets. The headline cost story must be honest (per-1KB DynamoDB write billing; published crossover vs Redis).
7. **Storage-agnostic *and* runtime-agnostic core.** `packages/core/src/core/` imports no cloud SDK and no driver impl — only the driver interfaces; the main entry stays SDK-free and core never imports a flavor package. It also imports **no `node:*` builtin**, so the seam loads where none exists (a V8 isolate); randomness, time and I/O arrive through injected seams (`Clock`, `Rng`, `BlobReader`, the driver ports). Anything needing a builtin belongs in a driver. All four rules are enforced in CI (`pnpm lint:arch`) — the builtin one is `core-no-node-builtins`.
