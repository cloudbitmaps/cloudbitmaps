# AGENTS.md — CloudBitmaps

> The operating manual for AI agents working in this repo. `CLAUDE.md` is a symlink to this file, so every
> agent reads the same one: edit `AGENTS.md`, never the link.

Distributed, cloud-native Roaring Bitmaps. A segment is a set of **write-once `.crbm` generations** in object
storage behind one registry pointer; each 16-bit Roaring chunk is addressable inside a generation, and reads are
served from a bounded in-RAM **cache** over that immutable **storage** tier, wrapping `roaring-node`/CRoaring for the bit
math. Data enters by **loading** a new generation, never by mutating a stored one. The crown jewel is
**serverless chunk-skipping intersection**: `A ∩ B` fetches only the chunks that can possibly contribute.

Start with the [README](README.md), then the [getting-started guide](docs/guide/getting-started.md) and the
[API reference](docs/guide/api-reference.md) — the complete callable surface, kept in sync with the exports by CI.
[`docs/ROADMAP.md`](docs/ROADMAP.md) is what's shipped, what's proven to what degree, and what's next;
[`docs/benchmarks.md`](docs/benchmarks.md) carries the published cost and memory figures, how each was measured
or modelled, and what is still owed, in-region latency among them.

## Repo layout

A **pnpm workspace of five packages**, all versioned in lockstep. Two axes: the **codec** is a flavor
package, the **storage service** is a driver package, and core is what both build on.

- **`packages/core` → `@cloudbitmaps/core`** — the codec-agnostic read engine (`SegmentEngine` + the
  `CodecInterface` seam), the `.crbm` format, the load/publish write path, generation GC, erasure-by-rewrite,
  crypto, registry, consistency, budget, eject, the in-memory and local-filesystem drivers, and the driver
  ports. Publishes `@cloudbitmaps/core/driver-kit`, the declared contract a driver package builds against.
  **Zero runtime dependencies, and no cloud SDK anywhere in it.**
- **`packages/roaring` → `@cloudbitmaps/roaring`** — the flavor: the roaring codec
  (`SafeBitmap`/`roaringCodec`), the `CloudRoaring` facade, and the `export-segments` CLI. Depends on core.
- **`packages/{s3,gcs,azure-blob}` → `@cloudbitmaps/{s3,gcs,azure-blob}`** — one package per storage
  **service**, each depending on its SDK **for real** rather than as an optional peer. Named by service, not
  by cloud: an `aws` package would have to carry both the S3 and DynamoDB SDKs, and "azure" is ambiguous
  across Blob, Table, Files and Data Lake.
- **Users install two packages** — `pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3`, the codec they want and
  the storage they have. `@cloudbitmaps/core` arrives **transitively, never installed directly.** Nothing is
  an optional peer, so there is no "install the peer" error path and no pnpm strict-resolution hazard.
- **Tests live at the repo root under `tests/`** (many drive the facade + core internals together), with the
  `@/…` alias remapped onto the packages in `vitest.config.ts` and the root `tsconfig.json`. All gate commands
  run from the root. See [CONTRIBUTING](CONTRIBUTING.md#repo-layout-a-pnpm-workspace-of-five-packages).

## Principles

Build by these:

- **SOLID** — one responsibility per module; extend via composition / new driver impls, not edits; substitutable implementations (same conformance suite); small interfaces; depend on abstractions (inject drivers, `Clock`, `Rng`).
- **DRY** — one source of truth; **derive state, don't duplicate it**; reuse before adding.
- **KISS / YAGNI — simplicity and performance are non-negotiable.** The simplest thing that works; build for today's requirement (reserve format space for the future, build it when real). **Don't over-complicate anything, and never ship something that hurts performance** — a feature most users won't use must not tax the hot path (`has`/`count`/`iterate`/`intersect`) everyone pays for. No always-on extra storage copies or per-op overhead to speed up a rare operation; push it to wiring-time, load-time, an admin call, a recipe, or docs instead. Over-engineering is itself a failure.
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

1. **Branch off `main` for every change, docs included** — `feature/`/`fix/`/`chore/`. Nothing goes straight to
   `main`, and every PR waits for an explicit approval before it merges.
2. **Build with tests, not after** — new behavior ships with tests in the same commit; each
   [hard invariant](#hard-correctness-invariants) gets named tests (property tests over loaded generations, and
   crash/race tests for the write-then-publish path).
3. **Run the full local gate green** — `lint · lint:arch · format:check · typecheck · test · build · smoke`; every one
   must pass before review. **`pnpm typecheck` is required exactly like `test`/`lint`** — zero `tsc` errors *and*
   zero editor red squiggles; never deferred or `@ts-ignore`-d.
4. **Run the adversarial review gate — MANDATORY, after every phase AND sub-phase.** **Spawn multiple
   parallel adversarial subagents**, one per lens (correctness · bug-hunt · security · scale & perf · code
   quality · testing quality · docs fidelity), against the whole component **end to end**, not just the diff.
   Self-review does not satisfy this and neither does your own mutation testing: both target the code you
   were already reasoning about, which is precisely the blind spot. Fix the real findings in the same change,
   or record each with a severity and a deferral; after substantive fixes, re-review. *Skipping this once let
   a change through the full green gate and 13 CI jobs with five blockers in it, two of them breaking
   compliance guarantees this repo makes in writing.*
5. **Keep docs current in the same change** — the [guide](docs/guide/getting-started.md),
   [API reference](docs/guide/api-reference.md), [README](README.md), `CHANGELOG.md` (`[Unreleased]`,
   newest-first), and [`docs/ROADMAP.md`](docs/ROADMAP.md). Docs must never lag reality.
6. **Commit + push**; open the PR **in the shape of
   [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)** — `What & why` · `How it was
   tested` · the checklist. The template auto-fills in the web UI but **not** for `gh pr create`, which is
   how most of these are opened, so it has to be applied deliberately there. **Squash-merge**, then delete
   the branch.
7. **Never** `git commit --no-verify` / `git push --no-verify`.
8. **Agent history** is working history, not documentation — durable conclusions land in tracked docs. Keeping the transcripts themselves is machine setup, not project setup: set your agent's transcript retention explicitly and back the agent config directory up to a private remote.

**Gate** (CI runs all; all must pass): `pnpm lint · lint:arch · format:check · typecheck · test · build · smoke`, plus
`pnpm test:integration` against real backends via docker-compose. A fresh clone must pass
`install → lint → lint:arch → format:check → typecheck → test → build → smoke` with no manual setup. **`pnpm typecheck` runs two
compilers** — TypeScript 5.9 (primary; drives lint and the dts build) and a TS7 forward `--noEmit` gate
(`typecheck:next`); it collapses to TS7-primary once `typescript-eslint` supports it.

Releases are automated, tokenless and human-gated — see [`RELEASING.md`](RELEASING.md).

## Hard correctness invariants

These are the protocol rules the design *must* honor — each one shapes the data model, and each came out of an adversarial review rather than from a bug:

1. **Write-once generations; the pointer only moves forward — within one incarnation of a row.** A write never touches a stored object: it writes a *new* generation and then advances the segment's registry pointer, which only ever moves forward (an out-of-order or duplicate publish is refused, never a regression). **That monotonicity ends at the row.** `nextGeneration` returns `max(currentGen, highest object) + 1`, so it restarts at `0` once a row is purged and the bucket emptied: a retired-and-re-created name is a *different segment* wearing a *lower* pointer. **And an operator can move it down on purpose**: `rollbackSegment` is the one call that does, which is why generation collection re-proves the row before *every* delete rather than trusting a pointer it read a moment ago. Segment identity is therefore the row's OCC **token**, never the generation number — which is why anything comparing two observations of a segment (a cached reader, a fenced publish, a GC pass that listed before it acted) compares tokens, and why `g < currentGen` is only a safe collection bound against a pointer re-read from the same incarnation. A crash before the publish leaves the previous generation authoritative, so a rerun is idempotent. **A writer that DERIVED its content from a particular generation publishes with `expectFrom` instead** — the compare-and-swap then lands only while the pointer is still exactly there, and reports `superseded` otherwise. Forward-only is right for a load, whose ids come from upstream and so lose nothing by winning a race; it is wrong for the erasure rewrite, whose object *is* one generation minus a bit, and which would otherwise out-rank a concurrent publish and delete it (`nextGeneration` deliberately numbers above everything in the bucket, so forward-only alone refuses nothing here).
2. **Storage objects are immutable and generation-keyed** (`segment.<gen>.crbm`), and the pointer is moved by compare-and-swap. Never overwrite in place; never reuse a generation number (a colliding put fails write-once).
3. **Every chunk comes from one whole generation; a read is never torn.** A read resolves the segment's current generation *once*, before any fan-out, and each chunk it fetches is a whole, checksum-verified, immutable generation object — never a merge of two sources. The **only** thing a long call may not get is a single *instant*. Four things re-resolve a segment mid-call, and its later chunks then come from whichever generation is current: a `cache.genTtlMs` boundary after a publish; the reader cache evicting an operand, which re-resolves even sub-TTL; a sweep collecting the generation it was reading, which heals the read forward; and an invalidation, which the same store's own `load`, `rollback`, `eraseSubject` and `*Into` writes make (a `rollback` moves the read to an *older* generation) and `invalidate()` makes on request. (`dropSegment` and `retireExpired` invalidate too, and end the read rather than move it.) `cache.genTtlMs: 0` removes only the first. Whole and verified either way, but describing two instants — which is what a snapshot handle (`seg.pin()`) is for, and why neither a GC setting nor `genTtlMs: 0` substitutes for one.
4. **GC never touches the current generation.** Only generations strictly below the pointer are collectable, keeping a configurable grace window (`keep`) so a read still fetching from a just-superseded one need not re-resolve mid-call; the sole exception is a `destroyed` (crypto-shredded) segment, where every generation is garbage because no reader can resolve it. A collection pass reads the row, lists, then acts, so it re-reads the row afterwards — before every delete, since the deletes are a round trip each — and reconciles: the bound is the **lower** of the two pointers (see invariant 1: the later one can be *lower*, whether from a purge-and-recreate or from a deliberate rollback), and a pass that started on a row and can no longer prove that row is the same one refuses with `WriteConflictError`. It still returns an empty list for the two cases that are genuinely "nothing to collect" rather than a lost race — no row at all, and no pointer yet — so **an empty list is not a receipt**. Nor is a non-empty one: a caller that needs a receipt (the erasure rewrite does) verifies the **claim** — that the generation is gone from the bucket — and not its own membership in the returned list, because a concurrent collector may have taken it first and that is the outcome, not a failure.
5. **All tier bytes are untrusted input.** Use the **safe** roaring deserializer plus a hard size cap before the native addon (never the trusting variant), and range-check every chunk key and payload value that comes back from storage.
6. **Bounded memory & cost, always.** Hard LRU ceiling; bounded intersection concurrency; per-op budgets. The headline cost story must be honest (published read crossover vs an always-on Redis node).
7. **Storage-agnostic *and* runtime-agnostic core.** `packages/core/src/core/` imports no cloud SDK and no driver impl — only the driver interfaces; the main entry stays SDK-free and core never imports a flavor package. It also imports **no `node:*` builtin**, so the seam loads where none exists (a V8 isolate); randomness, time and I/O arrive through injected seams (`Clock`, `Rng`, `BlobReader`, the driver ports). Anything needing a builtin belongs in a driver. All four rules are eslint `no-restricted-imports` rules (eslint.config.js) enforced by `pnpm lint`, and `pnpm lint:arch` (`tests/arch`) proves each one fires and that the import graph is acyclic.
