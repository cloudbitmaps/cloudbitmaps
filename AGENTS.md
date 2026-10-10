# AGENTS.md — CloudBitmaps

> The operating manual for AI agents working in this repo. `CLAUDE.md` is a symlink to this file, so every
> agent reads the same one: edit `AGENTS.md`, never the link. It says how to work here; how the system behaves is in
> the docs it links to.

Distributed, cloud-native Roaring Bitmaps. A segment is a set of **write-once `.crbm` generations** in object
storage behind one registry pointer, read through a bounded in-RAM **cache** over that immutable **storage** tier,
with `roaring-node`/CRoaring for the bit math. Data enters by **loading** a new generation, never by mutating a stored
one. The crown jewel is **serverless chunk-skipping intersection**: `A ∩ B` fetches only the chunks that can possibly
contribute.

Start with the [README](README.md), then the [getting-started guide](docs/guide/getting-started.md) and the
[API reference](docs/guide/api-reference.md), the complete callable surface, kept in sync with the exports by CI.
[`docs/ROADMAP.md`](docs/ROADMAP.md) is what's shipped and what's next; [`docs/benchmarks.md`](docs/benchmarks.md)
carries the published cost and memory figures and how each was measured or modelled.

## Repo layout

A pnpm workspace of six packages, versioned in lockstep: `packages/core` (`@cloudbitmaps/core`: the codec-agnostic
engine, the `.crbm` format, the write path and the driver ports, with zero runtime dependencies and no cloud SDK),
`packages/roaring` (the flavor and the `CloudRoaring` facade), one driver package per storage service,
`packages/{s3,gcs,azure-blob}`, and `packages/tools` (`@cloudbitmaps/tools`: offline tools, the cost model). Users
install two packages, a flavor and a driver; core arrives transitively. Tests live at the repo root under `tests/`, and
every gate command runs from the root. Detail:
[CONTRIBUTING](CONTRIBUTING.md#repo-layout-a-pnpm-workspace-of-six-packages).

## Principles

Build by these:

- **SOLID** — one responsibility per module; extend by composition and new driver implementations, not edits; substitutable implementations (one conformance suite); small interfaces; depend on abstractions (inject drivers, `Clock`, `Rng`).
- **DRY** — one source of truth; **derive state, don't duplicate it**; reuse before adding.
- **KISS / YAGNI — simplicity and performance are non-negotiable.** The simplest thing that works, built for today's requirement (reserve format space for the future, build it when real). **Never ship something that hurts performance**: a feature most users won't use must not tax the hot path (`has`/`count`/`iterate`/`intersect`) everyone pays for; push it to wiring time, load time, an admin call, a recipe or the docs. Over-engineering is itself a failure.
- **Fail fast, typed errors** — validate at boundaries; typed errors (`WriteConflictError`, `IntegrityError`, …) over thrown strings; never silently swallow.
- **Security by default** — all tier bytes are untrusted; least privilege; never log keys, PII or bitmap contents.
- **Determinism** — inject `Clock`/`Rng`; keep `packages/core/src/core/` pure: no I/O, time, randomness, global object or run-time loading. `pnpm lint` refuses each way round it; [`eslint.config.js`](eslint.config.js) is the list.
- **Readable over clever; boy-scout rule** — leave code cleaner than you found it; delete dead code and assets.

## Working process & conventions

**Canonical: [`CONTRIBUTING.md`](CONTRIBUTING.md)** (branching and merge, the full process, code style).

**Ask before consequential decisions.** For any choice that is hard to reverse, precedent-setting, or
outward-facing — public API/exports, the on-disk/wire **format**, **dependencies** and how they're packaged, or
architecture — present the options (trade-offs + industry norm + a recommendation) and get agreement **before**
building. Decide reversible/internal details yourself with a sensible default, and say which ones you chose so
they can be vetoed. The public signatures are held by a gate: `pnpm api:surface:check` compares the built declarations with `api-surface/surface.json`, and a pull request fails on a removed or changed entry unless it adds a row with its reason to `api-surface/allowed.json`. Add that row only for a change that was agreed.

The essentials, in order:

1. **Branch off `main` for every change, docs included** — `feature/`/`fix/`/`chore/`. Nothing goes straight to
   `main`, and every PR waits for an explicit approval before it merges.
2. **Build with tests, not after** — new behavior ships with tests in the same commit; each
   [hard invariant](#hard-correctness-invariants) gets named tests (property tests over loaded generations, and
   crash/race tests for the write-then-publish path).
3. **Run the full local gate green** — `lint · lint:arch · format:check · typecheck · test · build · smoke`, and
   `test:integration` against the docker-compose backends ([the gate](CONTRIBUTING.md#commands-the-gate)). CI runs
   all of them. **`pnpm typecheck` is required exactly like `test`/`lint`**: zero errors and zero editor red
   squiggles, never deferred or `@ts-ignore`-d.
4. **Run the adversarial review gate — MANDATORY, on every pull request before it merges.** **Spawn multiple
   parallel adversarial subagents**, one per lens (correctness · bug-hunt · security · scale & perf · code
   quality · testing quality · docs fidelity), against the whole component **end to end**, not just the diff.
   Self-review does not satisfy this and neither does your own mutation testing: both target the code you
   were already reasoning about, which is precisely the blind spot. Fix the real findings in the same change,
   or record each with a severity and a deferral; after substantive fixes, re-review. *A change can pass the
   full green gate and every CI job with blockers in it, including ones that break compliance guarantees this
   repo makes in writing; this review is what finds them.*
5. **Keep docs current in the same change** — the [guide](docs/guide/getting-started.md),
   [API reference](docs/guide/api-reference.md), [README](README.md), `CHANGELOG.md` (`[Unreleased]`,
   newest-first), and [`docs/ROADMAP.md`](docs/ROADMAP.md). Docs must never lag reality. **This file holds
   instructions, not reference**: how the system behaves goes in the docs, and this file links to it.
6. **Commit + push**; open the PR **in the shape of
   [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)** — `What & why` · `How it was
   tested` · the checklist. The template auto-fills in the web UI but **not** for `gh pr create --body` or
   `--fill`, which is how most of these are opened, so it has to be applied deliberately there. **Squash-merge**, then delete
   the branch.
7. **Never** `git commit --no-verify` / `git push --no-verify`.
8. **Agent history** is working history, not documentation — durable conclusions land in tracked docs. Keeping the transcripts themselves is machine setup, not project setup: set your agent's transcript retention explicitly and back the agent config directory up to a private remote.

Releases are automated, tokenless and human-gated — see [`RELEASING.md`](RELEASING.md).

## Hard correctness invariants

The protocol rules the design *must* honor. Each one shapes the data model, each has named tests, and code, tests and
docs cite them by number. Each rule below is what you must not break; the linked docs say exactly how the code keeps it.

1. **Write-once generations; the pointer only moves forward — within one incarnation of a row.** A write never touches a stored object: it writes a new generation and moves the registry pointer forward by compare-and-swap. Only `rollbackSegment` moves it down, and a purged and re-created row starts again at `0`, so a segment's identity is its row's OCC **token**, never its generation number. Every publish is fenced on what its writer found: a load on the row's token when it found a row, or on that absence when it found none, and, when guarded, also on the pointer it judged; a writer that derived its content from a generation on that generation too (`expectFrom` with `expectToken`). A registry write that got no answer is settled by reading the row, deleting nothing until it is. Detail: [how a load stays correct](docs/guide/loading.md#how-it-stays-correct) and [a write that gets no answer](docs/guide/loading.md#when-a-write-is-throttled-or-gets-no-answer).
2. **Storage objects are immutable and generation-keyed** (`segment.<gen>.crbm`), and the pointer is moved by compare-and-swap. Never overwrite in place: a number is never taken while an object holds it. A number can be taken again once its object is deleted, so a generation is identified by its number with the row's `pointerId` (the token of the last write that named a field a read resolves through), or by its object's fingerprint (a pin), never by its number alone; where the row has a summary the store can use, every live open of that generation is held to the object's fingerprint it records. A delete decided from a read of one object (an erasure's delete of a holder above the pointer or on a row with no pointer, its delete by name of an object it cannot search, a refused rewrite's discard of its own object above the winner's pointer, and a refused load's reclaim of an object it proved its own) passes that read's version (`delete(key, { ifVersion })`), so a storage driver that applies the condition (it reports `conditionalDelete`) removes only that object, or one stored with the same bytes where its versions derive from them. A driver that ignores the condition removes whatever is under the number, and so does every delete decided from a row or a listing: collection, a load's eviction from its kept window, a drop's sweep, a refused rewrite's discard under a `destroyed` row, and a refused load's reclaim under a row that is unchanged, changed only in its leases, or `destroyed`. Detail: [how a load stays correct](docs/guide/loading.md#how-it-stays-correct) and [how a pin stays correct](docs/guide/reading.md#how-a-pin-stays-correct).
3. **Every chunk comes from one whole generation; a read is never torn.** A read resolves the segment's current generation once, before any fan-out, and each chunk is a whole, checksum-verified, immutable generation object, never a merge of two sources. A long call can re-resolve mid-call and so describe two instants, within a stated bound on what it serves of the earlier one; only a snapshot handle (`seg.pin()`) gives one instant. That bound is a written privacy guarantee, held by `tests/docs/erasure-in-flight-bound.test.ts`: change it only with the docs that state it. Detail: [how soon a reader sees a new load](docs/guide/reading.md#how-soon-a-reader-sees-a-new-load) and [reading one fixed point in time](docs/guide/reading.md#read-one-fixed-point-in-time).
4. **GC never touches the current generation.** Only generations strictly below the pointer are collectable, beyond the `keep` window; the sole exception is a `destroyed` (crypto-shredded) segment, where every generation is garbage because no reader can resolve it. A collection pass re-proves the row before every delete, because the pointer can move down: on an active segment its bound is the lower of the pointers read before and after the listing, and on a `destroyed` segment any change of the row's token refuses the pass. Its returned list is not a receipt: a caller that needs one verifies the generation is gone from the bucket. Detail: [generations and `keep`](docs/guide/loading.md#generations-and-keep) and [how a load stays correct](docs/guide/loading.md#how-it-stays-correct).
5. **All tier bytes are untrusted input.** Use the **safe** roaring deserializer plus a hard size cap before the native addon (never the trusting variant), and range-check every chunk key and payload value that comes back from storage, through the shared checks in `packages/core/src/core/chunk-checks.ts`: a new read path calls them rather than writing its own.
6. **Bounded memory & cost, always.** Hard LRU ceiling; bounded intersection concurrency; per-op budgets. The headline cost story must be honest (the published read crossover against an always-on Redis cluster).
7. **Storage-agnostic *and* runtime-agnostic core.** `packages/core/src/core/` imports no cloud SDK, no driver implementation, no flavor package and no `node:*` builtin, and the main entry stays SDK-free, so the seam loads where none exists (a V8 isolate); randomness, time and I/O arrive through injected seams (`Clock`, `Rng`, `BlobReader`, the driver ports), and anything needing a builtin belongs in a driver. `pnpm lint` enforces it, and `pnpm lint:arch` (`tests/arch`) proves each rule fires and that the import graph is acyclic.
