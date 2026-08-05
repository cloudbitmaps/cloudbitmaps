# Changelog

All notable, user-facing changes to CloudBitmaps are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adopts
[Semantic Versioning](https://semver.org/) from **v0.1.0**.

> **SemVer starts here.** `0.1.0` is the first published release and the first versioned section below.
> Everything before it accumulated as a running dev log; from now on changes land under **[Unreleased]** and
> are cut into a version on release. For granular per-phase detail see the roadmap and phase docs, and for
> *why* decisions were made the decision log.
>
> **Pre-1.0 means the format and API can still move.** Breaking changes are possible in a minor bump until
> `1.0`, at which point the `.crbm` format freezes and normal SemVer guarantees apply.

## [Unreleased]

## [0.8.2] — 2026-08-04

### Fixed

- **Retiring an accumulator segment reported failure while succeeding.** A segment created by writing to it —
  never bulk-loaded, never compacted, so it has no registry row and no Cold objects — is the documented way to use
  this as a runtime set (a dedup wave, a daily sent-list). `dropSegment` retires one correctly by deleting its Warm
  rows, but reported `{ dropped: false, reason: 'absent' }` **with a non-zero `warmRowsDeleted`** — self-
  contradictory, and `'absent'` was documented as "nothing happened". A retention cron written as the obvious
  `if (!res.dropped) alert()` fired on **every successful retirement**.

  `dropped` now answers the question callers actually ask — *is this segment empty as a result of this call, or was
  it already?* — and `reason` says which route got there: **`'warm-only'`** for a retired accumulator (`dropped:
  true`), `'already'` for an existing tombstone, and `'absent'` **only when nothing existed at all**, which is the
  one value worth alerting on and almost always a mistyped name or an omitted `namespace`.

  Still no tombstone for the warm-only case, deliberately: a `destroyed` row per retired daily bucket would be
  registry litter, and would refuse that name if it were ever legitimately reused.

  Found by the first real consumer, whose entire workload is this shape. It went unnoticed because **every**
  existing `dropSegment` test seeded a Cold generation first — the accumulator lifecycle had no coverage at all.
  It does now, including the full wave (`claimMany` → dedup a retry → retire), and both failure directions are
  mutation-verified: reverting to the old under-report and over-correcting to "always claim success" each turn the
  suite red.

### Documentation

- **The accumulator pattern is now documented** in the getting-started guide, with the result-shape table, the
  reason an empty `bulkLoadCrbmGeneration(..., [])` seed is pointless (it writes a real object and a registry row
  for a segment with no data), and a hard warning that a native Warm-table row TTL is **silent total data loss**
  in this mode — everything you have is Warm, so expiring rows expires the dataset.

## [0.8.1] — 2026-08-04

### Documentation

- **The npm package page did not mention either of `0.8.0`'s headline features.**
  `packages/roaring/README.md` is a separate file from the repo-root `README.md`, and it is the one npm renders —
  so it is at once the most-read surface and the easiest to forget. It shipped `0.8.0` without `claimMany` or
  `dropSegment`, while still claiming Redis operations *"carry over one-for-one"* with no boundary. For a few
  hours the package page was the least accurate surface in the project. It now carries both, the two limits
  (no addressable-bit surface; do not port a per-id write loop), the pricing-model caveat, and the
  no-seed/compaction-is-optional framing.

- **A gate so it cannot drift a third time.** `tests/docs/flavor-readme-sync.test.ts` asserts the published flavor
  README (a) mentions every `SegmentHandle` method the guide presents as the answer to a Redis command, (b) does not
  claim Redis parity without stating a limit, and (c) warns against the per-id write loop. Both halves are
  **derived** — from the live `SegmentHandle` prototype and from the guide's own Redis section — rather than from a
  hand-maintained list, because a list you must remember to update is a check that cannot fire, and forgetting is
  exactly what happened here. This is the second drift of this file: `0.7.0`'s Redis mapping was also reported as
  being on the npm README when only the root README had it.

No code changes. `@cloudbitmaps/core` is republished only to keep the two package versions in lockstep, which the
publish workflow enforces.

## [0.8.0] — 2026-08-04

**Retention and dedup.** `dropSegment` closes a spec/implementation divergence that had sat since day one — there
was no supported way to delete a segment and stop paying for it. `claimMany` closes the one Redis-bitmap capability
we did not have. And `store.compact` stops leaking storage, which it had been doing silently since it shipped.

**Read this before upgrading if you compact in-process.** `store.compact()` now deletes superseded Cold
generations. Your S3/GCS/Azure object count for compacted segments will **drop** on the first compaction after
upgrading — that is the fix, not a fault. It keeps the same one-generation grace window the daemon has always kept,
so no reader loses a generation it could still be pinned to. If you were relying on old generations lingering for
manual point-in-time recovery, that was never a documented guarantee and it is now gone: use
`compactSegment` + your own `gcOrphanGenerations` schedule instead.

### Added

- **`seg.claimMany(ids)` — atomically claim ids: add them, and get back only the ones that were not already
  there.** The durable analogue of Redis `SETBIT` returning the prior bit, which is what an exactly-once *"have I
  already sent to / already processed this id?"* check needs. `has()` then `add()` cannot express it: two workers
  both read absent and both proceed.

  **It takes a batch, and that is the whole design.** A Warm write rewrites an entire 64K-id chunk bitmap, so
  per-id claiming is the single most expensive way to use this library — measured at **5,000 writes / 23,762 KB**
  for 5,000 ids claimed one at a time, against **1 write / 8 KB** for the same ids in one call. `claimMany` does
  one OCC read-modify-write per distinct *chunk*: Redis's semantics without Redis's per-id cost shape.

  Exactly-once holds **per id** — each id lives in one chunk and a chunk is one OCC row, so exactly one concurrent
  claimer sees any given id as new (pinned by a 10-worker race test). Like `addMany` it is not atomic across
  chunks; re-running is safe, because already-claimed ids simply come back as not-new. The presence test is the
  full effective set `(cold ∪ adds) \ removes`, not the Warm delta alone — checking `adds` would report an id as
  newly claimed after a compaction folded it into Cold, silently breaking exactly-once on any long-lived segment.

- **`segment.dispose` audit event.** `dropSegment` now attests what it actually did. Previously a **cleartext**
  drop emitted nothing at all: `segment.erase` could not be reused, because four documents define that event as
  proof of an irreversible crypto-shred — bytes unreadable *everywhere*, backups included — and an object delete
  is strictly weaker (a noncurrent version, a replica or a PITR snapshot still holds the cleartext). Emitting one
  kind for both would make a compliance dashboard over-attest, which is the one failure an audit trail exists to
  prevent.

  So a cleartext drop emits `segment.dispose` (with `generationsDeleted`), and an **encrypted** drop emits
  **both** — `segment.erase` for the key shred, then `segment.dispose` for the storage reclamation — because both
  genuinely happened. See [dashboards.md](docs/guide/dashboards.md) for which one answers which question. An
  absent no-op and a dry run emit nothing.

- **`store.dropSegment(ref, { confirmSegment, dryRun? })` — retire a segment and actually reclaim its storage.**
  Tombstones the registry row, deletes the Warm rows, deletes the Cold generations. Works on a cleartext
  segment, and on an encrypted one it *also* discards the DEK, so it is a strict superset of crypto-shred there.
  Afterwards the segment **reads as empty** rather than erroring — within `coldGenTtlMs` for a reader that has a
  clock. `DropResult.generationsRemaining` is the field to check: non-empty means the storage was *not* fully
  reclaimed and the drop should be re-run.

  **This closes a real hole.** `destroySegment` crypto-shreds — the bytes become unreadable everywhere including
  backups, which no object deletion can achieve — but it leaves the objects in your bucket, still billed, and it
  *requires* encryption. `gcOrphanGenerations` only collects superseded generations. So until now there was no
  supported way to delete a segment and stop paying for it, and the obvious workaround (an object-store lifecycle
  rule on the prefix) deletes the bytes while the registry still points at them — the `missing-cold-generation`
  torn state, presenting **intermittently** because a read consults the hot cache before Cold.

  **The order is the contract, and it is why this is a library function rather than a recipe:** Warm rows first
  (a tombstone with live Warm deltas would still answer `true`), then the registry pointer (after which nothing
  resolves a generation), then the Cold objects, best-effort — so a partial failure leaks bytes rather than
  correctness, and re-running collects the rest. Also `dryRun`, because `confirmSegment` guards a typed literal
  and does nothing in the loop this function exists for; it previews `wouldDelete`, `wouldDeleteWarmRows` and
  `wouldCryptoShred`.

  **An adversarial review before merge found three defects in the first cut of this, all from ordinary
  interleavings, and all invisible to a single-actor test suite.** They are fixed here, and the fix is worth
  knowing because it shapes the contract:

  - **The Cold sweep repeats.** A compaction already in flight when the tombstone lands still finishes *staging*
    a generation from data it read beforehand — its commit fails on the voided lease, but the object survives and
    holds the complete effective set including the Warm deltas just deleted. One list-then-delete missed it, and
    nothing else would have collected it. `gcOrphanGenerations` now also takes **every** generation of a
    tombstoned segment (previously only those below `currentGen`), so a running daemon collects any residual.
  - **A segment with objects but no registry row now gets a tombstone before anything is deleted.** Objects
    without a row is a real state — `bulkLoadCrbmGeneration` writes the object, *then* publishes. Deleting
    without the tombstone produced either a dangling `active` pointer at no object (the very
    `missing-cold-generation` state this function exists to prevent) or a full resurrection when the racing
    writer published. A genuinely nonexistent segment still gets `reason: 'absent'` and no row, so a typo leaves
    no litter.
  - **A second Warm pass runs after the tombstone.** A Warm write landing after step 1 was *immortal*, because
    compaction refuses to fold or purge a destroyed segment — a fresh reader would report the dropped segment as
    non-empty forever.

  The free function `dropSegment(ref, { registry, warm, cold }, …)` is exported for out-of-process callers.

### Fixed

- **`store.compact()` never reclaimed the generation it superseded** ([#47](https://github.com/cloudbitmaps/cloudbitmaps/issues/47)).
  Cold generations are immutable and generation-keyed, so *every* compaction leaves its predecessor on disk.
  `runCompactionCycle` (the daemon) has always collected them via `gcOrphanGenerations`; `compactSegment` never
  did, and the facade's `store.compact` wraps `compactSegment` — so a deployment that compacted **in-process
  without running the daemon grew its Cold footprint without bound, forever.** Reads stayed correct throughout
  (`currentGen` always pointed at a real object), which is precisely why nothing ever surfaced it.

  `store.compact` now calls `gcOrphanGenerations` best-effort after a successful commit, matching the daemon, with
  its default `keep: 1` grace window so a reader pinned to the just-superseded generation is unaffected. Failure
  is swallowed: GC is housekeeping, and a compaction that committed must not be reported as failed because cleanup
  could not run — the next cycle collects what this one missed.

  The free function **`compactSegment` is deliberately unchanged**, staying a single-responsibility primitive for
  callers who schedule GC themselves. If you use it directly, call `gcOrphanGenerations` yourself.

- **`destroySegment` / `eraseNamespace` could report `warmRowsDeleted: 0` after physically deleting every Warm
  row.** The tally was declared *inside* the tombstone CAS retry loop, so only the final attempt's count
  survived: one benign concurrent registry write (`findCompactable`'s change-guarded CAS, a failure-count bump, a
  lease acquisition) made the first attempt conflict, and the second attempt re-listed an already-empty Warm set.
  On a GDPR Art. 17 erasure record that is **under-attestation** — the same class of defect as over-attesting,
  pointed the other way — and it has been present since crypto-shred shipped. The tally is now hoisted and
  accumulated across attempts.

- **`gcOrphanGenerations` now collects every generation of a `destroyed` segment**, not only those below
  `currentGen`. A tombstoned segment resolves no generation, so no reader can be pinned to one and the grace
  window is meaningless — while nothing else in the library would ever have collected them, because the reconcile
  path that deletes generations above `currentGen` returns early on a destroyed row. Those objects were billed
  forever. Behaviour on a live segment is unchanged.

- **Error messages from a `dropSegment` call no longer name `destroySegment`.** They shared a helper, so a
  contended Warm row during a drop produced "destroySegment: … the segment was NOT destroyed" — operator-facing
  text on the one path where the operator has to act.

- **`UnsupportedError` from `store.dropSegment` now names `dropSegment`.** It listed only
  `compact`/`eraseSubject`/`checkConsistency`, so a caller following the documented requirement got an error
  about three operations they had not called.

### Documentation

- **Retention, TTL and pruning are now documented — including a footgun that could lose data silently.**
  There is no TTL and no per-id expiry (a bitmap stores ids, not `(id, timestamp)` pairs, so an expiry per id
  costs more than the compression saves), and the guidance for what to do instead existed only in `PRIVACY.md` —
  which is not where anyone asking *"does it support TTL?"* looks. New guide section, plus a note on `/usage`.

  **The warning is the important part: never enable your backend's native row expiry on the Warm table.**
  DynamoDB TTL, Redis `EXPIRE`, a MongoDB TTL index, a Postgres cleanup job — Warm rows are **un-compacted
  deltas**, so expiring them discards adds/removes that were never folded into Cold, and the next read returns
  the Cold generation without them. **No error is raised; the answer is quietly wrong.** "The Warm table is
  growing, I'll put a TTL on it" is a reasonable instinct and a data-loss bug — the answer is to compact more
  often. Nothing in the docs said so before.

  Also corrected an overstatement: `PRIVACY.md` described dropping a segment as "an object delete or
  crypto-shred", implying the first is available. It is not. `destroySegment` crypto-shreds — the Cold bytes
  become unreadable everywhere including backups, but **they stay in your bucket and you keep paying for them** —
  and it requires encryption at rest, since a cleartext segment has no key to discard. `gcOrphanGenerations`
  collects only *superseded* generations. **No operation deletes a live segment's Cold objects**, so reclaiming
  storage is out-of-band work (an S3 lifecycle rule on the key prefix). Segment-level retention is now on the
  roadmap with that gap named as its first requirement.

## [0.7.0] — 2026-08-01

One narrowly breaking rename, and the docs a Redis-bitmap user needs to evaluate this at all.

The rename is the reason this is a minor: `.crbm`'s footer field `roaring_serialization_id` is now
`payload_codec_id`. **No stored bytes move** — same offset, same width, every generation ever written still
reads, and the golden byte-layout corpus passes unmodified. What changes is what the field *means* and how it
is checked. It had to happen before `1.0` freezes the format, because a field frozen under a codec-specific
name cannot be reinterpreted afterwards without a major format version.

If you have never set `CrbmWriterOptions.roaringSerializationId` — and almost nobody has, the facade never
passes it — this release is docs and internals, and upgrading is a version bump.

### Internal

- **`core/` is now gated as runtime-agnostic, not just storage-agnostic.** `pnpm lint:arch` fails on any `node:*`
  import under `packages/core/src/core` (`core-no-node-builtins`). Nothing changed in the code — the seam already
  imported zero builtins, which is why the engine is portable to a V8 isolate at all — but the property was
  asserted in the docs and enforced by nobody, so a single `import { createHash } from 'node:crypto'` in the seam
  passed every gate in the repo. Drivers are unaffected and still hold every builtin import in the project.

- **A dependency-free JavaScript reader for the portable Roaring format** (`packages/roaring/src/portable/`).
  **Not exported and not wired into anything** — there is no user-visible change here, and nothing to call. It
  is the first piece of edge-runtime membership: the engine seam is already portable, but `roaring` is a native
  C++ addon that no V8 isolate can load, so reading a chunk without it is the prerequisite for everything else.
  Read-only by design (`has` / `count`); writes and compaction stay on the native codec.

  Correctness is differential rather than asserted: the native library generates both the bytes and the expected
  answers across every container encoding, both header cookies, and 200 randomly-shaped bitmaps. Untrusted bytes
  are bounds-checked at every header read, and non-ascending container keys are rejected rather than fed to a
  binary search that would return silently wrong membership.

### Changed

- **The `.crbm` footer's codec field is generalized: `roaring_serialization_id` → `payload_codec_id`.** Same byte
  offset, same width, **no layout change** — the golden byte-layout corpus passes unmodified, and every generation
  ever written still reads. What changes is the field's meaning and how it is validated: it now says *which codec
  produced the chunk payloads*, and the reader checks membership in a registry of ids it can decode rather than
  equality with a single constant. `1` = roaring portable, unchanged and permanent.

  **Why now, and why it could not wait.** `.crbm` is a shared container — the index, the CRC32Cs, the AEAD
  framing and the generation model are all codec-independent, and only the payload bytes belong to a flavor. The
  format **freezes at `1.0`**, and a field frozen under a codec-specific name cannot be reinterpreted afterwards
  without a major format version. A second codec is genuinely expected, so this is a one-line registration later
  instead of a format migration.

  An unregistered id is rejected with a typed `UnsupportedError` naming both the id and what this build can read
  — **fail-closed**, which is the safe direction: a store uses one codec throughout, so meeting a foreign
  generation means misconfiguration, and a loud rejection beats decoding someone else's bytes as your own.

  **Breaking, narrowly:** `CrbmWriterOptions.roaringSerializationId` is renamed to `payloadCodecId`. It is an
  escape hatch on a lower-level writer that virtually nobody sets — the facade never passes it — but if you do,
  rename the property. No stored data is affected.

### Documentation

- **"Coming from Redis bitmaps?" — a direct answer to the question the flavors table provokes.** Now that
  `/flavors` lists a plain-bitset flavor as *Not planned*, a reader who runs Redis bitmaps today is entitled to
  ask what they give up. The answer, on both `/flavors/roaring` and in the
  [guide](docs/guide/getting-started.md), is a per-command mapping (`SETBIT`→`add`, `GETBIT`→`has`,
  `BITCOUNT`→`count`, `BITOP AND`/`OR`/`DIFF`→`intersect`/`union`/`andNot`) plus the point that above 4,096 ids
  in a chunk — 6.25% of it — roaring stores that chunk *as* a flat bit array, so the dense case is byte-for-byte
  what they have now.

  It also states plainly what does **not** port, because the rest is not credible without it: `BITFIELD`,
  `BITPOS`, `BITOP NOT`/`ONE` and byte-range `BITCOUNT` have no equivalent, and nothing that reads a Redis
  bitmap's raw string will read a `.crbm`. Raw bit-position import/export is unbuilt and explicitly demand-gated.

- **Fixed: the README and the getting-started guide both advertised `0.1.1`** while the packages shipped
  `0.6.0` — stale across five releases. The version gate only ever opened `site/**/*.html` and `llms.txt`, so
  markdown was invisible to it; it now covers `README.md` and `docs/` (with `docs/ROADMAP.md` carved out, since
  a release history naming old versions is correct). This is the third hole found in the same gate, and the
  scope is now derived by walking the tree rather than enumerated, so a new doc is covered the day it is added.
  Renamed `tests/docs/site-version.test.ts` → `tests/docs/version-claims.test.ts` to match what it guards.

## [0.6.0] — 2026-07-30

Two production-path fixes, one of them a large and entirely silent storage multiplier. Nothing here changes the
`.crbm` format or an existing signature; the reason it is a minor rather than a patch is that the bytes written
for a cold generation genuinely change shape, and `eraseNamespace` now returns a ledger where it used to throw.
Read the `eraseNamespace` note before upgrading if you call it.

### Added

- **`pnpm bench:encoding`** — the measured evidence behind the site's structural claim ("the honest comparison is
  not us versus Redis: it is Roaring versus a fixed representation"), which was the one layer of the argument
  published on assertion alone. Compares one id set across roaring and the two fixed representations it chooses
  between, over four workload shapes. Deterministic and seeded, with no wall-clock or RSS component, so unlike the
  other benches it can be asserted rather than only recorded. It reports the shape where roaring LOSES as
  prominently as the ones where it wins, because the claim being tested is adaptivity, not superiority.

### Fixed

- **`eraseNamespace` no longer discards its ledger when one segment cannot be erased.** It called
  `shredSegment` per segment with no isolation, so a single failure aborted the loop: the caller got an exception,
  no ledger, and no way to learn which segments had *already* been destroyed before the throw — the worst answer
  available on an erasure command, because some data really was destroyed and the record of which is gone. Faults
  are now isolated per segment, matching `eraseSubject`, whose entries already worked this way ("one failure never
  aborts the ledger"). A failed segment appears in the result with `destroyed: false` and a `reason` —
  `'contended'` for warm rows rewritten during every erase pass, `` `failed: <message>` `` otherwise.

  **This trades loud-but-empty for quiet-but-complete, so entries must be inspected**: `destroyed: false` means
  that segment still holds data. The `namespace.erase` audit event carries the honest `segmentsShredded` count,
  which will be lower than the segment count, so an audit trail still shows the shortfall even if the return
  value is ignored. Additive to `DestroyResult` — no field changed type, so nothing that compiled before stops
  compiling.

- **Cold generations were never run-encoded, costing up to 570× the bytes they should.** Roaring picks per
  container between an array, a bitset and a **run** — but no implementation selects the run form on its own; it
  takes an explicit `runOptimize()` pass, and nothing here was making it. Two of the three container types were
  therefore ever used, and run-shaped ids paid list or bitmap prices. Measured on the shipped codec: a contiguous
  1,000,000-id range serialized to **128.1 KiB where run-encoding needs 0.2 KiB (570×)**, and a 2,000-run shape
  **536.5 KiB against 8.5 KiB (63×)**. Sequential and time-ordered ids — auto-increment keys, batch inserts — are
  exactly the shapes this hits, so this was a large, quiet multiplier on cold storage, transfer and every read.

  Fixed via a new optional `CodecBitmap.optimize?()`, called where an immutable cold generation is written.
  Sparse ids come out byte-identical, so it is never a losing trade — roaring keeps whichever encoding is smaller
  per container. Deliberately NOT called on the per-operation warm delta path: the hot path must not pay for it,
  and warm rows are folded into a cold generation by compaction, where they are optimized then.

  The `.crbm` envelope is unchanged (the golden byte-layout test passes untouched) and run containers are part of
  the standard portable Roaring format, so this is a size change, not a format change.

## [0.5.0] — 2026-07-30

**A minor, not a patch, and deliberately so.** Everything below is a bug fix, but two of them turn a call that
previously *returned* into a call that *throws*, and this project routes a behaviour change through a minor bump
until `1.0` rather than hiding it in a patch. If you call `destroySegment` or `eraseNamespace`, check that it sits
inside a `try`/`catch` before upgrading: a contended erasure that used to report success now raises
`WriteConflictError`. That is the point of the fix — but it is a new exception on a path that did not throw.

### Changed

- **The planned plain-bitset flavor is renamed `@cloudbitmaps/bitset` (facade `CloudBitset`), from
  `@cloudbitmaps/bitmap`.** Nothing is published under either name yet, so this costs nobody anything — which is
  exactly why it is being done now rather than after. Three reasons: `bitmap` is the singular of its own scope
  and so differentiates nothing (every flavor is a bitmap); putting `roaring` and `bitmap` side by side in a
  picker implies Roaring is not a bitmap, when one of Roaring's three containers *is* a bitset and the real axis
  is compressed vs uncompressed; and `bitset` is a term of art — `java.util.BitSet`, `std::bitset` — that means
  precisely "an uncompressed array of bits", which is the actual differentiator. The tell was in our own copy:
  the site's subtitle for `@cloudbitmaps/bitmap` read "Plain bitset — one bit per id", so the name needed the
  word `bitset` to explain itself. It also gives the naming pattern that generalises —
  `roaring`/`CloudRoaring`, `bitset`/`CloudBitset`, `soaring`/`CloudSoaring` — and avoids the `.bmp`
  image-format collision in search. The generic term `bitmap` is retained where it is genuinely generic: npm
  keywords, repo topics, the `CodecBitmap` type, `core/bitmap.ts`, and prose about the data structure.
- **The site adopts a designed visual language, and gains a `/flavors` hub and a `/flavors/roaring` page.** One
  engine, pluggable codecs — the hub is a single choose-one table (including a *cost of choosing it* column), and
  the flavor page is also the template a second flavor fills in. The library itself is untouched.
  - Two themes, both **designed**: light is not an inversion — the mark's cyan cannot hold 4.5:1 on paper, so
    both accents are re-picked for their ground. The toggle is applied before first paint, so there is no flash.
  - Three explainers move and nothing else does: the chunk-skipping centrepiece on `/architecture` (three views
    of one statement — which chunks · from which tier · prove it) and one codec animation per flavor page. Every
    one holds a readable final frame, so `prefers-reduced-motion` loses the motion and none of the information.
  - The **counter-case is staged as a peer of the pitch** throughout — "Use Redis instead." sits in the same grid
    row, bezel, padding and weight as the cost figure, and the two crossover rows where a flat Redis node is
    simply cheaper are in the same table at the same weight as the four rows above them. No alert colour
    anywhere.

### Fixed

- **`destroySegment` could report `destroyed: true` on a segment it had not finished erasing.** `eraseWarm`
  retries rows that are rewritten mid-erase for a bounded number of passes, and when that bound ran out it
  returned the count deleted so far and let the caller CAS the `destroyed` tombstone anyway. Warm rows are
  **cleartext**, so a right-to-erasure command could attest to a destruction while the data was still readable,
  and the result could not reveal it — `warmRowsDeleted` counts successes only. It now throws
  `WriteConflictError` naming the number of rows still contended; because Warm is cleared *before* the tombstone
  is written, the failure leaves the segment un-destroyed and safely retryable. Every other bounded retry in the
  codebase already failed typed on exhaustion — this one function was the exception.
- **A generation could be published onto a segment destroyed while that generation was being written.**
  `bulkLoadCrbmGeneration` reads the registry once, refuses if the segment is already destroyed, and then spends
  a KMS call and a whole object write before publishing — seconds to minutes on a large load. A `destroySegment`
  landing inside that window was invisible to `publishGeneration`, which compares only `currentGen`, so the
  pointer advanced on a destroyed record and left an object encrypted with the DEK destroy had just shredded:
  unreadable, still stored, and attached to a segment the registry says was erased. `publishGeneration` now
  refuses a destroyed record, using the record it had already re-read for its own CAS — so the check and the
  write see the same state. This is the publish-step half of the coupling `erasure.ts` had noted as "a later
  hardening".
- **The retry wrapper leaked the inner scan whenever a warm enumeration was abandoned.**
  `RetryingWarmDriver.listChunks` is the only wrapper that drives its inner iterator by hand — deliberately, so
  that it does not buffer and defeat the engine's resident-memory bound — but it never closed that iterator when
  its own consumer walked away. The engine abandons a scan *by design*, throwing `BudgetExceededError` from
  inside its `for await` once `maxWarmScanBytes` is crossed, so the leak fired precisely when the memory ceiling
  was protecting the process, leaving an open Mongo cursor or Cassandra stream behind each time. Now closed in a
  `finally`. The other drivers were never affected: Postgres, MySQL and DynamoDB page statelessly, and Mongo and
  Cassandra drive their cursors with `for await`, which closes on an abrupt exit by itself.

### Changed

- **Corrected three comments that promised retry behaviour the hot read path does not have.** The retry module's
  header still described `listChunks` as buffering and re-enumerating from the start — true of the cold and
  registry `list` wrappers, and true of `listChunks` only before its bound was fixed. The stale wording had been
  copied into the Postgres and MySQL warm drivers. A mid-stream fault on a warm enumeration propagates; that is
  the documented trade for bounded memory, and now all four places say so.

- **The light theme's label colour failed WCAG AA.** `--cb-faint` — used for every label, caption and column
  head, and the one token the design explicitly holds to AA *because it carries information* — shipped as
  `#7A8393`, which gives **3.60:1** on the light ground where AA needs 4.5:1. Both the design bundle's
  `tokens.css` and its README stated 4.6:1 for that value; measured, neither was right. Corrected to
  `#666E7B` (**4.84:1**), the value in the design-language specimen, whose own stated contrast figures all
  reproduce to two significant figures.
- **The favicon's progressive bit reduction never reached a browser.** The mark's nine bits turn to mud below
  64px, so the design ships simplified 32px (five bits) and 16px (three bits) art. Both files were in
  `site/assets/` and neither was ever referenced — every page declared only the full 64px icon. Now declared
  by size.
- **The site's own logo mark rendered with no letterform in dark mode.** It was loaded via `<img src>`, and an
  SVG referenced that way is an isolated document, so its `fill="currentColor"` resolved against *itself* —
  i.e. to black — leaving only the coloured bits visible on the graphite ground. The mark is now inlined, so
  `currentColor` and the bit tokens resolve against the page and one file serves both themes. Favicons, which
  browser chrome always fetches standalone, carry their own `prefers-color-scheme` instead.
- **`llms.txt` had been advertising `v0.1.0` for three releases.** The site-version gate only read `*.html`, so
  nothing caught it. Gate widened to every file that carries a version string.
- **The site's reveal-on-scroll script is gone.** It held whole sections at `opacity: 0` until an
  IntersectionObserver fired — invisible to anyone with JavaScript disabled, and it left the new
  `/architecture` centrepiece blank in every static render.

## [0.4.1] - 2026-07-27

A correctness release from **audit round 4** — four independent adversarial review passes over the 0.4.0 diff
(correctness, cost, test quality, docs fidelity). Every finding below survived my own mutation testing and was
caught only by an outside pass; two of them are claims this project had already published as true.

### Fixed

- **`addMany`/`removeMany` could silently drop ids from a synchronous input.** *(Regression introduced in
  0.4.0.)* An async function body runs synchronously to its first `await`, so a sync input had always been
  effectively **snapshotted** at call time — a caller could pass a scratch buffer and immediately reuse it.
  0.4.0's cooperative yield sat inside that loop and voided the guarantee: a 40,000-id buffer recycled before
  the promise was awaited landed exactly **16,384 ids with no error thrown**. Size-dependent, so nothing under
  the yield cadence would have shown it. The yield is removed from the sync path (it bought ~11 ms per 1M ids
  against OCC round-trips that dominate the operation); the async path, which never promised a snapshot,
  keeps it.

- **The per-op budget did not bound memory in the default wiring.** `RetryingWarmDriver.listChunks` drained the
  entire warm scan into an array before yielding its first row, so the engine's per-row ceiling — the whole
  point of 0.3.0's bounding work — only saw rows *after* the segment was already resident. Measured on a
  500-row segment under `budget: { maxRequests: 3 }`: **500 rows materialised with the default wiring, 4 with
  `retry: false`.** Both threw the same `BudgetExceededError`, which is why no test caught it: the error was
  never the distinguishing observable, the row count was. Present in **0.3.0 and 0.4.0**.
  - The wrapper now retries only while *establishing* the scan (each attempt builds a fresh iterator, so no row
    can be yielded twice) and streams from there. **Trade-off:** a transient fault *mid-stream* now propagates
    instead of being retried. It cannot be retried honestly — rows are already with the consumer and the driver
    interface exposes no resumption token — and bounded memory is a hard invariant where mid-scan retry is not.

- **Compaction never actually yielded the event loop.** `writeCrbmGenerationStream` gained a `clock` in 0.4.0
  and no caller passed one; `CompactionDeps.clock` was typed `Pick<Clock, 'now'>`, so callers *could not*. The
  0.4.0 notes claimed compaction was covered. It now is: the clock type accepts optional `sleep`/`yieldNow`
  (still only `now` required, so no caller breaks), it is threaded to both write sites, and the
  `compact-segments` daemon supplies a real clock.

- **`InstantClock` now declares its no-op yield explicitly** instead of silently falling back to a `sleep(1)`
  that its own `sleep` resolves on a microtask.

### Changed

- **Docs corrected across the board.** The site said union and difference were "on the roadmap" on the same
  page whose badge read v0.4.0; the guide's operations table omitted the new ops while the README called it
  exhaustive; the exclude cost claim said "1 extra read" where the bound is one per *surviving key* (never
  scaling with the suppression list's size); "strictly less memory" held only above the 1M staging cap; the
  `writeConcurrency` sweep is now described as **modelled** (an in-process fake, not a real DynamoDB); the
  three separate yield experiments are labelled so their baselines stop being spliced together; and
  `intersect`'s memory/generation contract — orphaned into an unattached JSDoc block — is reattached.

- **`fetchedChunks` documentation clarified** (the metric is unchanged): it counts distinct chunk **keys**, not
  requests, which is why it reads lower than the budget's charge for the same call. Deliberately not redefined
  — silently changing a published observability field in a patch release would break dashboards built on it.

### Tests

Five test files were hardened after an independent pass showed each had a **surviving mutation** — assertions
that could not fail. Worst cases: the cooperative bulk-load file counted total loop turns against a bound of
`> 20` when the real figure was ~119, so any *one* of its several yield sites satisfied the whole file; a
"no cross-chunk bleed" test asserted an algebraic identity of `bit-route` and compared a call to itself,
passing against a `union` that returned nothing; and a "no silent partial write" assertion was tautological
because the fake incremented its counter *after* the throw it was measuring. Each is now pinned to a
per-site or absolute observable, and every fix in this release ships with a regression that fails against the
pre-fix code.

## [0.4.0] - 2026-07-27

The release the first real consumer asked for: **set composition** and **streaming batch writes**, plus the
production-safety follow-through that 0.3.0 started. `bulkLoadCrbmGeneration` no longer blocks the event loop
for the duration of a load, which was the last way this library could take an instance out of service.

Both features arrived with a measurement that contradicted the obvious implementation — the async codec variants
that looked like a free win are a **7x regression**, and the obvious way to accept a stream would have
multiplied a caller's write bill by the length of their input. Neither shipped.

### Added
- **`union` / `andNot` and an `exclude` option on `intersect`** — set composition without materialising an
  intermediate segment.

  ```ts
  // (audience ∩ in-market) minus every suppression list, in ONE chunk-aligned pass:
  await audience.intersectInto(dest, [inMarket], { exclude: [optOut, churned] });

  for await (const id of audience.union([lookalikes], { exclude: [optOut] })) { … }
  for await (const id of audience.andNot([optOut])) { … }
  ```

  - **`exclude` is the part that delivers "suppression composes".** Chaining would not: `andNot` applied after
    `intersectInto(tmp, …)` still writes `tmp`. Folding suppression into the intersect pass is what removes the
    intermediate — so the two standalone operations alone would not have solved the request they came from.
  - **The cost model is a property of the set operation, not of this implementation**, and the guide now states
    it plainly:

    | | chunks read | can skip? |
    | --- | --- | --- |
    | `intersect` | keys present in **every** operand | yes — the crown jewel |
    | `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly |
    | `union` | every chunk of **every** operand | no |

  - An `exclude` operand can only subtract, never introduce a key, so candidate keys come from the includes
    alone — and a suppression chunk is fetched only at keys that list actually holds. **The cost is bounded by
    the surviving key count and never scales with the size of the suppression list:** subtracting a
    61,000-chunk global opt-out list from a 40-chunk audience costs at most 40 extra reads, not 61,000.
  - All three are charged against the same per-op budget, and only for chunks actually read, so a wide `union`
    is refused rather than quietly billed while cheap suppression is not penalised.
  - New: `unionInto` / `andNotInto`; exported option types `BaseCombineOptions`, `CombineOptions`,
    `CombineIntoOptions`; `MetricOpName` gains `'unionInto'` / `'andNotInto'`; the `intersect` metric event
    gains an optional `op` discriminator (absent ⇒ `'intersect'`, so existing consumers are unaffected).

- **`addMany`/`removeMany` accept an `AsyncIterable`**, so a database cursor streams straight in —
  `addMany(athenaCursor())` instead of hand-batching `page → addMany(page)`. `bulkLoadCrbmGeneration` already
  did; this closes the gap.
  - **Streaming is an input-shape choice, never a cost choice.** Each chunk is written **exactly once** however
    long the stream, so a stream costs no more backend writes than the equivalent array.
  - That property is the whole design problem, and the obvious implementation destroys it. "Buffer N ids, flush
    to the backend, repeat" bounds memory and, because ids arrive in arbitrary order, makes every flush touch
    nearly every chunk again — an 11M-id stream at a 1M-id buffer would issue **11x** the round-trips of a
    single pass. Instead the staging buffer folds into per-chunk **compressed bitmaps** and the backend is
    touched once at the end. Measured: 5M pending ids occupy **11 MB as bitmaps against 212 MB as JS numbers**,
    which is what makes writing-once affordable. Above the 1M staging cap this holds less than the previous
    sync-only path; below it the two are comparable — the guarantee is that a stream of *any* length stays
    bounded, not that every call got smaller.
  - This does not move the `addMany` ↔ `bulkLoad` crossover, and the guide now says so explicitly: both take a
    stream, so the same cursor pipes into either, and streaming is exactly the situation in which it is easiest
    to reach for the wrong one. Amending a segment is `addMany`; defining one is bulk-load.
  - Internally a batch is now applied to a chunk's delta **set-wise** (`orInPlace`/`andNotInPlace`) rather than
    id-by-id, so the adds/removes disjoint invariant is enforced by set algebra instead of by a loop.


- **`Clock.yieldNow?()`** — an optional member on the determinism seam meaning "hand the event loop back once",
  as distinct from `sleep(0)`, which is contractually a microtask and yields nothing. Optional, so every
  existing `Clock` implementation stays valid; callers degrade to `sleep(1)`, which yields correctly at ~1 ms of
  dead wall-clock apiece. Production wiring backs it with `setImmediate`; the simulator makes it a no-op so a
  replayable run is not perturbed by what is purely a scheduling courtesy.

- **`writeCrbmGeneration` and `writeCrbmGenerationStream` accept `clock`**, so a caller driving them directly
  gets the same cooperative behaviour.

### Changed
- **`writeConcurrency` now defaults to 4 instead of 1.** The bounded flusher behind `addMany`/`removeMany` was
  serial by default, so a 100-chunk batch against a backend with ~10 ms round-trips spent a full second doing
  nothing but waiting — one round-trip at a time, on work with no ordering requirement between chunks. Distinct
  chunks are independent OCC rows.
  - **The bound exists for the backend, not for correctness.** A provisioned-capacity store answers a burst by
    throttling, which is free only while the transient-retry path absorbs it. Swept against a **modelled**
    backend — an in-process fake that throttles on concurrent requests in flight, not a real DynamoDB — that
    throttles on concurrent requests in flight (64 chunks, 5 trials, a lost id or surfaced error counting as a
    failure): 4, 8 and 16 were clean at every capacity tested; the first failures appeared at **32** against a
    capacity-1 backend. 4 sits 8x below that, leaving the headroom for the multiplier a single-call sweep
    cannot show — many concurrent `addMany` calls sharing one backend.
  - Set `writeConcurrency: 1` to restore the previous strictly-serial behaviour. `addMany`/`removeMany` remain
    non-atomic either way; concurrency changes only *how much* of a batch may already have landed when the
    first error surfaces, since the flusher stops scheduling on first failure but in-flight writes still settle.
  - Exported as `DEFAULT_WRITE_CONCURRENCY`.

### Fixed
- **Bulk-load no longer blocks the event loop for the whole load.** `bulkLoadCrbmGeneration` was a single
  synchronous stretch: a 1M-id load (~62,000 chunks) measured **442 ms wall with 450 ms during which the event
  loop did not turn once**. Wired into a request handler that stalls every other request on the instance —
  health checks included — for the duration, which is the difference between a slow endpoint and one that looks
  dead to its load balancer. The load now hands the loop back periodically: **worst stall 450 ms → 19 ms**.
  - Applies to the four loops that dominate a load — id ingest, the per-chunk flush, the cardinality tally, and
    the serialize/CRC/frame pass — plus `writeCrbmGenerationStream`, which compaction runs over whole segments.
  - **The obvious fixes do not work, and this is worth knowing before you write your own.** Making the work
    async is a **7x regression** (636 ms vs 92 ms): handing each chunk's insert to the threadpool costs ~9 µs of
    dispatch against ~1.5 µs of work. And `await Promise.resolve()` — equivalently `Clock.sleep(0)` — yields
    *nothing*, because microtasks drain before the loop advances a phase; measured at 555 ms of starvation
    against a 568 ms unyielded baseline. The yield has to be a macrotask, and it has to be periodic.
  - Users of `@cloudbitmaps/roaring` get this automatically — the flavor pre-binds a real clock, exactly as it
    pre-binds the codec. Calling `@cloudbitmaps/core` directly with no `clock` keeps the old behaviour
    unchanged, so this is purely additive.

- **Bulk-load is 42% faster on sync input** (1M ids: **442 ms → 256 ms**), independent of the fix above. Both
  sync and async sources were normalised through one async generator, which forces a microtask per id: 224 ms
  against 11 ms for a plain `for..of` over the same array — 55% of a whole load spent on iteration protocol
  rather than work. The two ingest paths are now separate.

## [0.3.0] - 2026-07-27

A production-safety release. An adversarial audit round found that the per-op budget bounded **fan-out** but
not the **enumeration** that fed it — so the documented denial-of-wallet control could be exceeded in memory
before it could refuse in requests. Every enumeration in the library is now bounded, and three hot paths got
measurably faster along the way. No format change; two new options, both additive.

### Added

- **`checkConsistency` bounds its registry scan** via a new `maxScanSegments` option (default **250,000**, exported
  as `DEFAULT_MAX_SCAN_SEGMENTS`). It was the last unbounded enumeration in the library: the function's own
  comment said "fail fast before the (possibly huge) registry scan" and then drained that scan into an array
  anyway, so memory scaled with total fleet size with no way for the caller to cap it. Operator-invoked rather
  than request-reachable — which is why it was fixed after the GDPR paths — but "an operator runs it" is not a
  bound, and a DR drill against a large fleet from a modest box is precisely the case that hurts. The default
  sits comfortably above the 100K+ fleets the compaction docs target, so no real deployment should meet it.

- **`maxWarmScanBytes` — a memory ceiling that is deliberately *not* the budget** (default **64 MiB**, exported
  as `DEFAULT_MAX_WARM_SCAN_BYTES`). It caps the warm-delta bytes a single segment scan may hold resident, for
  every read op, and — unlike `budget` — **stays in force when `budget: false`**.
  - Two controls because there are two axes. `budget` bounds **cost** (backend requests); this bounds
    **memory**. Treating one as the other is what allowed a segment to materialise ~12 MB before a
    `maxRequests: 2` budget could refuse it, and then caused a first attempt at that fix to wrongly tighten
    `intersect`.
  - **It is the only bound `intersect` can have.** Its budget is `common keys × operands`, a product a single
    wide operand can legitimately exceed in row count while remaining entirely within contract — so a request
    budget cannot express a memory limit for it. `intersect` was the last unbounded read path; it no longer is.
  - **Always on, and raisable.** A ceiling that `budget: false` switches off is missing exactly when it is
    needed; one you cannot raise is a landmine for a legitimately large segment. Invalid values (including the
    `NaN` you get from an unset `Number(process.env.X)`) are rejected at construction, not on the first read.

### Changed

- **Four development-only advisories are now fixed rather than tolerated**, via `pnpm.overrides`: `adm-zip`
  (high, via `cassandra-driver`), `qs` (via Stryker), `uuid` (via `@google-cloud/storage`) and `esbuild`. The
  production-scoped audit gate correctly ignored all four and CI was green, but "correctly ignored" is not
  "fine". Upstream cannot resolve the first one — `cassandra-driver@4.9.0`, the latest, still pins
  `adm-zip ~0.5.10`, a range that cannot reach the patched 0.6.0 — so an override is the only route. Verified
  against the full nine-backend integration suite, since the `adm-zip` and `uuid` paths are ones the unit tests
  never touch. **No consumer impact:** these are dev dependencies; `core` ships zero runtime dependencies.
- **`dependency-cruiser` 16 → 18**, which requires `^22 || ^24` and was therefore blocked until the Node floor
  moved in this release. Architecture lint still passes (120 modules, 389 dependencies cruised).

### Fixed

- **The per-op budget now bounds the enumeration, not just the fan-out it feeds.** Every affected call site
  drained an async iterable in full and only then called `checkBudget(budget, items.length, op)`. That refuses
  the fan-out, but only *after* materialising the list — so `budget.maxRequests`, the documented
  denial-of-wallet control, provided **no memory protection at all**. Measured against the previous release: a
  store configured with `budget: { maxRequests: 2 }` still buffered 3,000 warm chunk rows (~12 MB) before
  `count()` threw, and `subjectReport` buffered 20,000 registry records. That contradicts the bounded-memory
  invariant, and on a small container it is an OOM rather than a refusal.
  - Fixed on the read path (`count`, `iterate`) and on the GDPR paths (`subjectReport`, `eraseSubject`), which
    are reachable from ordinary end-user traffic. Resident memory during these scans is now `O(budget)` rather
    than `O(segment)` / `O(fleet size)`.
  - **`intersect` is deliberately unchanged.** Its budget is `common keys × operands`, a product — one wide
    operand can legitimately hold far more warm rows than that product, so applying the row count as a ceiling
    would refuse work the documented contract allows. An existing budget test caught exactly this. Bounding
    `intersect`'s per-operand warm snapshot needs an explicit memory ceiling rather than a reinterpretation of
    the budget, and is tracked separately.
  - **`runConsistencyCheck` is also unchanged**: it accepts no `budget` option at all, so bounding it means
    adding public API. It is operator-invoked rather than request-reachable, so it is tracked rather than
    rushed.
- **New: `collectWithinBudget`** — the shared helper the above is built on. Its error message deliberately says
  "more than N" instead of an exact total, because an exact total requires finishing the scan, which is the
  cost being refused.

### Performance

- **`bulkLoadCrbmGeneration` inserts per chunk instead of once per id — measured 1,344 ms → 879 ms for 1M ids**
  (identical input, same harness; ~35% off). The old loop crossed the JS↔native boundary once per id, and did
  it in one unbroken synchronous stretch: on Node's single thread that stalls every other request on the
  instance, measured separately as a 0.7 ms health check taking 275 ms. Fewer, larger inserts cut both the
  wall-clock and the length of that stall.
  - The buffer is **capped** rather than accumulating the whole input. Bucketing everything first is faster
    still, but holds every remainder as an uncompressed JS number across up to 65,536 chunks — unbounded in
    exactly the way this library refuses to be. Flushing at a fixed pending count bounds the transient buffer
    to ~8 MB regardless of input size or key distribution.
  - Note this is a **35% improvement, not the 3–9× an isolated insert microbenchmark suggests**: end-to-end,
    serialization, per-chunk CRC and driver writes account for the rest of the time.
  - Bulk-load remains a **batch primitive** — it is still hundreds of milliseconds for large inputs and still
    belongs in a job or worker, never a request handler. See the guide's event-loop section.

- **CRC32C is now slicing-by-8 — ~1.5× faster, and it runs on every cold reader open.** The `.crbm` index is
  checksummed in full when a reader opens, which happens on a cold-start, an LRU eviction, or a real generation
  change. The byte-at-a-time implementation measured ~3.3 ms/MiB, so a maximally-sized 8 MiB index cost ~27 ms
  of synchronous stall; it is now ~18 ms, and a typical wide segment's index drops from ~5.5 ms to ~3.7 ms.
  (Not the 3–4× slicing-by-8 achieves in C — JS bounds-checking and the absence of native 32-bit loads take
  most of that back.)
  - **Byte-identical output, which is the only thing that matters here** — this is a wire-format checksum, and
    a deviation would make every existing `.crbm` unreadable. Verified against the previous implementation over
    6,001 cases: every length from 0 to 2,000 (covering all eight tail remainders and the empty input), 4,000
    random buffers, non-zero seeds for the streaming path, and the published CRC-32C known-answer vector for
    `"123456789"` (`0xe3069283`).
  - Note this was **not** the audit's suggested fix. The proposal was to yield around the CRC or shrink the
    index cap; making the checksum itself faster helps every caller instead, needs no new configuration, and
    leaves the pure-core determinism seam untouched (a yield would have required a timer, which `core/`
    lint-bans).

### Documentation

- **In-region latency is now measured, closing the last deferred claim on the benchmarks page.** A warm `has()`
  runs at **p50 5.27 ms · p90 6.36 · p95 7.15 · p99 12.71** (n=2,000) from a client inside `us-east-1`, against
  a North Star target of single-digit-to-~25 ms. The previously-published cost run measured from ~96 ms outside
  the region — roughly 4× the entire latency budget — so it could neither confirm nor contradict the target;
  that caveat is replaced with the figure rather than deleted. Two independent runs agree on every percentile to
  within ~0.5 ms. Stated precisely: the claim is **p99 inside budget**, not *always* inside budget, since `max`
  was 39.61 ms; **p999 is deliberately not published**, being ~2 samples deep at this sample size. Measured
  against the **published package**, not a local build.

## [0.2.0] - 2026-07-27

**Minimum Node is now 22.** A minor bump rather than a patch, because dropping a runtime narrows the supported
surface even when the dropped runtime is end-of-life. No format change; no API change.

### Changed

- **`engines.node` is now `>=22` (was `>=20`) on both published packages.** Node 20 reached **end-of-life on
  2026-04-30**, so the packages were advertising support for a major that receives no security patches — and
  that nobody was developing against: the repo's own version file already said `22`, and only the manifests
  disagreed. Shipping an EOL runtime is a security liability and a tooling one; the toolchain is already moving
  past it (dependency-cruiser 18 declares `^22 || ^24`).
  - **If you are on Node 20:** stay on `0.1.3`, which is unaffected and remains installable, and upgrade Node
    when you can. Node 20 receives no upstream security fixes, so this is worth doing regardless of this
    package.
  - The CI matrix moves to **22 + 24** — the active LTS plus the current release — so the floor is exercised
    rather than merely declared, and the next major is tested before it becomes the floor.

### Added

- **A test pinning the runtime floor across all three places it is declared.** The floor lives in `engines`, the
  version file, and the CI matrix, and it had already drifted: the version file said `22` while all three
  manifests said `>=20`. Each file is individually plausible, so only the *disagreement* is wrong and no single
  file can see it. It was noticed by accident — an unrelated AWS SDK warning during a latency run mentioned Node
  20 — which is not a detection strategy. `tests/ci/runtime-version-policy.test.ts` now fails if the three
  disagree, if a CI job pins a Node below the floor, or if the matrix stops exercising the floor.

## [0.1.3] - 2026-07-27

A correctness fix that closes the last gap in "all tier bytes are untrusted", plus release-pipeline and
public-surface hardening from a three-agent audit sweep. No format change; no breaking API change.

### Fixed

- **Chunk payloads are now range-checked on read, closing the last gap in "all tier bytes are untrusted".**
  A chunk payload holds 16-bit **remainders**, and nothing verified it. The size caps bound length, and
  CRC/AEAD only prove the bytes are the bytes that were written — which anyone able to write your storage
  satisfies. A value `>= 65536` then reached `joinId`, which masked it and emitted a **fabricated id belonging
  to a different chunk's id space**: indistinguishable from real data, inflating `count()` and creating
  spurious `intersect` matches. Compaction was the only path that already failed loudly, which merely turned
  the same row into a permanently poison segment.
  - Checked where a payload is interpreted **as a chunk** — the cold-chunk read and both halves of a warm
    delta — **not** in the codec. The first attempt put it in `safeDeserialize` and broke two tests
    immediately: that is the codec's *general* entry point, also used by full-segment export, where u32 values
    are entirely legitimate.
  - Costs **one check per chunk, not per id**. See the new `maximum()` below.

### Added

- **`CodecBitmap.maximum?()` — an optional method on the codec seam.** Returns the largest value, or
  `undefined` when empty. The engine uses it for the range assertion above. **Optional by design:** a codec
  that cannot answer in better than O(n) omits it and the engine skips the check, rather than walking every
  value on the read path — the one thing this must never cost. Roaring answers it in O(1) from its container
  index, so `@cloudbitmaps/roaring` implements it. Additive and backwards-compatible: an existing custom codec
  keeps working untouched.

### Security

- **The release pipeline now scans the artifact it publishes, not just the source that produced it.** Every
  package is packed, unpacked and leak-scanned before the publish
  (`pnpm leak-scan:tarballs`). `dist/` is gitignored, so the existing source and git-history scans
  structurally could not see the majority of the published bytes — and the sourcemaps carry every `src`
  comment verbatim through `sourcesContent`. Verified against a planted string: the new gate catches a comment
  that reaches the tarball *only* by that route.
- **Every recoverable check now runs before the irreversible one.** An npm tarball is immutable outside a
  72-hour window, so the release-notes extraction and the dependency audit moved ahead of `pnpm publish`
  instead of after it (notes were previously only read by the `github-release` job, i.e. once nothing could be
  done about a missing section). The audit specifically must re-run here because it is the one gate whose
  verdict changes with no commit at all. `tests/ci/release-workflow.test.ts` now fails if any precondition is
  ever moved after the publish.
- **A release is never cancelled in flight** (`concurrency.cancel-in-progress: false`), so the two packages
  cannot be left half-published; the npm upgrade the OIDC publish requires is pinned to a floor
  (`npm@^11.5.1`) rather than `@latest`; and the `packages/*` guards fail closed if the glob ever matches
  nothing instead of looping once over a literal path.

### Documentation

- **Private-doc citations removed from the surfaces consumers actually hit.** JSDoc references of the form
  `DECISIONS #N` were rendered by tsup into the published `.d.ts` files — where an editor shows them on hover —
  and embedded in the sourcemaps via `sourcesContent`. They pointed at a document that is not in this
  repository, so there was nothing a reader could follow. Also removed: bare citations to numbered internal
  design docs in the API reference and a CI comment, and a markdown link in `cost.ts` to a decision-log file
  that does not exist in this repository at all. The `CHANGELOG` keeps its citations deliberately — it is a historical record and
  the ids are stable.
- **The example workload on the site is now written at the level of abstraction the rest of the project uses.**
  The walkthrough's two maintenance modes are described as *batch rebuild* and *live update*, with neutral
  example segment names and a generic SQL source. The technical content — which mode maps to which topology,
  and why — is unchanged.

## [0.1.2] - 2026-07-27

Correctness fixes found by an adversarial audit of the shipped source, plus the documentation defects the same
sweep turned up. No format change; no API change.

### Fixed

- **`withRetry` could skip the operation entirely and reject with `undefined`.** `Math.max(1, maxAttempts)`
  guards `0` and negatives but **not `NaN`** — `Math.max(1, NaN)` is `NaN`, and `1 <= NaN` is `false`, so the
  retry loop body never ran. The wrapped operation was **never invoked**, and the call rejected with the
  literal `undefined` rather than an `Error`, so every typed-error branch in the caller's stack fell through.
  With the retrying drivers on (the default), that means writes silently no-op **without ever touching the
  backend**. Reachable from ordinary wiring: `retry: { maxAttempts: Number(process.env.X) }` is `NaN` when the
  variable is unset. Now rejected with a `ValidationError` naming the value, and a fractional `maxAttempts` is
  floored so it can no longer sleep toward an attempt that never happens.
- **The DynamoDB registry enumerated segments with an eventually-consistent `Scan`** while `get()` on the same
  table was strong. Every caller treats `list()` as the *complete* segment set, so a segment registered
  moments earlier could be missing from: `eraseSubject`'s erasure ledger (**a GDPR Art. 17 miss, reported as
  success**), `subjectReport`'s Art. 15 answer, and `runExport`'s manifest — where the segment lands in
  neither the manifest nor `failed[]`, making "a manifest exists ⇒ the run finished" untrue. Now
  `ConsistentRead: true`, matching `get()` and the warm driver's `listChunks`. Costs 2× RCU on that Scan,
  which is the right trade for a correctness-critical enumeration.

### Documentation

- **`PRIVACY.md` — which ships inside the tarball — showed two calls that throw.** `subjectReport(id)` and
  `eraseSubject(id, { owner })` both hit a tenancy guard requiring an explicit `namespace` (or an
  `{ allNamespaces: true }` acknowledgement), because ids live in one global space shared across namespaces.
  Installed users were reading a GDPR compliance document whose examples fail. Corrected there and in
  `README.md`.
- **`PRIVACY.md` credited `subjectReport` with returning the erasure ledger.** It returns membership only; the
  ledger comes from `eraseSubject`. This sat in the Art. 30 accountability section.
- **The README overstated the integrity guarantee.** It read "every object a SHA-256, verified before use".
  The digest is computed at write and handed back to the caller — it is **not stored and never re-compared on
  read**. The read-path guarantee is the CRC32C, which *is* verified before the bytes reach the deserializer.
  Reworded to say exactly that, and to say what the SHA-256 is actually for.
- **`api-reference` documented a `keep` option on `store.compact`** that `CompactionOptions` does not have;
  `keep` exists only on `gcOrphanGenerations`/`runCompactionCycle`. Replaced with the real options.
- **Status lines still said pre-publish** and told readers to use a local clone, two releases after publishing.

## [0.1.1] - 2026-07-26

Documentation-only. No runtime code changed — `dist/` is byte-identical in intent; only the prose that ships
beside it differs.

### Fixed

- **The shipped docs still called the library CloudRoaring.** `PRIVACY.md` travels *inside* the published
  tarball and named the old project in 11 places, so this was visible to anyone who had already installed
  `0.1.0`. Renamed across the shipped `README.md` and `PRIVACY.md` (and 12 more files in the repo), along with
  the crossover chart's baked-in SVG label.
  - The rename is **context-aware, not a blunt substitution**: `CloudRoaring` is still the exported class, so
    fenced blocks and inline code are untouched, and `CloudRoaringOptions`, `CloudRoaringError`,
    `isCloudRoaringError` and `CloudRoaring.estimateCost()` are all preserved — 34 API references verified
    individually. Possessives read "CloudBitmaps'", not "CloudBitmaps's".

### Added

- **The GitHub Release is cut by the pipeline**, not by hand, with notes lifted verbatim from this file — one
  source of truth, so the release page and the changelog cannot drift.
  [`scripts/changelog-section.cjs`](scripts/changelog-section.cjs) extracts the section and **fails loudly**
  rather than emitting something plausible: a missing version, an empty section, or a body over GitHub's
  125,000-character cap all stop the job. It also strips the trailing maintainer comments the last section
  inevitably absorbs — invisible in rendered Markdown, so a leak there would never be caught by eye.
  - It runs as a **separate job holding `contents: write`**, which the publish job deliberately does not get.
    [SECURITY.md](SECURITY.md) promises the publish job carries only the OIDC `id-token` permission, and
    creating a release needs write — so the write scope goes on a job that cannot publish. (Both sibling
    projects let `changesets/action` do this inside the publish job; simpler, and it widens the blast radius
    of the one job worth attacking.) `needs: publish` means a release object only appears for a version that
    really published.

## [0.1.0] - 2026-07-26

First public release. Published as
[`@cloudbitmaps/roaring`](https://www.npmjs.com/package/@cloudbitmaps/roaring) (install this one) and
[`@cloudbitmaps/core`](https://www.npmjs.com/package/@cloudbitmaps/core), Apache-2.0, with npm build
provenance. Everything below is the work that got it here.

### Added

- **Release auth is now tokenless** — `release.yml` carries **no
  `NPM_TOKEN`**, publishes from the workflow's GitHub OIDC identity (npm Trusted Publishing), runs behind a
  protected `release` environment whose required reviewer is the approval gate, and sets
  `NPM_CONFIG_PROVENANCE=true`. Root [`RELEASING.md`](RELEASING.md) documents the pipeline, the one-time npm +
  GitHub setup, and the break-glass path.
  - **This resolves a trap rather than dodging it.** Setting a package to *"require 2FA and disallow tokens"* —
    which the standards ask for — **rejects an automation-token publish outright**, so token auth and that
    hardening are mutually exclusive. Trusted Publishing is not a token, so it passes. Choosing the token model
    would have meant silently dropping the hardening.
  - **Bootstrap:** a Trusted Publisher is a *per-package* setting and needs the package to exist, so the very
    first version is published manually with interactive 2FA — the order both sibling projects actually used,
    confirmed from their git history. One-time, not a standing token. Since a manual publish carries no
    provenance attestation, [`RELEASING.md`](RELEASING.md) documents two bootstraps: publish `0.1.0` manually
    (as the siblings did), or publish a throwaway `0.1.0-rc.0` to create the names and ship the real `0.1.0`
    through the gated workflow **with** provenance. **The prerelease route is the chosen one** — deliberately
    diverging from the siblings so the launch artifact isn't the single unattested tarball in a project whose
    supply-chain story is the point.
  - The decision was taken by **matching the sibling projects** (`onadiet`, `babystack` already publish this way)
    rather than inventing a third model; cloud-roaring was the outlier. The tag trigger and its two guards —
    tag↔version agreement, and refusing to "publish" a still-`private` package that `pnpm publish` would silently
    skip while exiting 0 — are kept as-is.
- **Internal-doc citations removed from shipped code comments** (Phase 9 Stage 3). Packing the tarballs revealed
  **362** internal-doc references inside the published `@cloudbitmaps/core` artifact (and 20 in `roaring`) —
  carried there by preserved JSDoc and by sourcemap `sourcesContent`, which copies every source comment verbatim.
  Two consequences: a user hovering a type in their editor saw links that would **404** (that directory is dropped
  from the public snapshot), and `leak-scan --snapshot` fatally failed the tarball. Every citation is now replaced
  by the fact it was pointing at — a comment should *say* the thing, not cite a file the reader cannot open. Also
  swept the `spec-04` / `spec-09` shorthand, which had the same problem in disguise. **Now 0 in both tarballs.**
- **Three real defects in `pnpm leak-scan`, found by actually scanning the npm tarballs** (Phase 9 Stage 3) — and
  `tests/scripts/leak-scan.test.ts`, the test file that should have existed from the start. Nothing in the gate
  guarded the script that decides whether a tree is safe to publish, which is why all three survived.
  - **False positive that would have failed the launch gate.** `const token = crypto.randomUUID();` was reported
    as a "hardcoded secret literal" — the callee is 17 characters of otherwise-legal literal characters. It fired
    on **five shipped driver bundles** (the random-UUID OCC tokens) and made `leak-scan --snapshot` fail the core
    tarball outright. Not cosmetic: a scanner that cries wolf gets bypassed with `--force`, and then it protects
    nothing. Call expressions are now rejected as values.
  - **False negative.** Any env-var name with a *suffix* slipped through, because the keyword had to sit
    immediately before the `=`/`:` — so `DJANGO_SECRET_KEY=…` and `MY_API_TOKEN_VALUE=…` were both unflagged, and
    the `SECRET_KEY` convention is near-universal. Verified against the pre-fix script rather than assumed.
    (`AWS_SECRET_ACCESS_KEY` was *never* in this gap — it has its own dedicated rule. Worth stating because it is
    the example one reaches for first, and it is wrong.) An all-numeric-value exclusion keeps the widening from
    tripping on `tokenExpiryNanos = 1730000000000000000`.
  - **Two rules disagreeing.** The URL rule carefully exempted `mysql://root:pw@host.docker.internal` — and then
    the *email* rule flagged `pw@host.docker.internal` anyway, so a compose DSN still failed. The loopback/compose
    host list is now defined once and shared, since keeping two copies is what caused it.
  - The scanner also skips its own test file by exact path (that file exists to hold secret-*shaped* fixtures, the
    same reasoning that keeps `.leak-needles` gitignored) — an exact-path allowlist, not a `tests/` glob, because a
    real credential under `tests/` is still a real credential.
- **Planned: `analyze` — decide before adopting** (Phase 9.5). Not built; scoped on paper. Every cost tool we ship currently
  presupposes adoption — `costReport()` needs data already in CloudRoaring, `estimateCost()` needs half a dozen
  guessed parameters — so the thing that would *convince* a team to adopt requires them to have adopted. `analyze`
  streams a candidate's own ids through `bulkLoadCrbmGeneration` into a Memory/LocalFs driver (**no cloud account,
  no credentials, nothing created**) to *measure* cardinality, `.crbm` bytes and above all **chunk density** — the
  figure nobody can guess and the one that drives everything — then feeds those measured numbers to `estimateCost`
  in place of the guesses. It will refuse to invent what it can't know: traffic rates and arrival pattern stay
  caller-declared and labelled as such. Stage **9.5b** adds the *"do you even need the native addon?"* comparison
  (a plain per-chunk bitset is exactly `chunkCount × 8192` bytes against a measured roaring size — ratio ~1 ⇒ skip
  CRoaring and deploy to edge runtimes), gated on the `bitset` flavor existing.
- **`CostReport.advisories` — the estimator now compares you to *us*, not only to Redis**.
  `verdict` has always been Redis-relative, which left a blind spot: feed it the id-at-a-time write shape and it
  returns `'win-big'` — true, and thoroughly misleading, because you can beat the $346/mo baseline by 40× while
  paying ~150× more than *this same library* would charge for the same outcome. `advisories` is a second,
  self-relative channel that closes it.
  - Ships one code, **`'batchable-writes'`**, carrying `currentUSD` and `batchedFloorUSD`. Empty array is the
    normal case (never `undefined`, so consumers iterate unconditionally); dollar figures, `verdict` and
    `rationale` are untouched.
  - **The trigger is arithmetic, not a heuristic.** A 16-bit chunk key caps a segment at 65,536 warm rows, and a
    segment can't occupy more rows than it holds ids — so if modeled writes/month far exceed that bound, the same
    rows are provably being rewritten many times over.
  - **The bound is deliberately an *upper* bound.** Over-stating it only makes the advisory quieter; under-stating
    it makes it fire on already-optimal workloads, which trains people to ignore it — at which point the feature is
    worse than absent. Byte-derived cardinality is rejected for exactly this reason (it understates a dense 8 KiB
    bitmap container by ~16×). Two further gates keep it quiet: a ratio floor of 8 and a $1/mo savings floor.
  - **A hit is a prompt to check, not an accusation** — the message says so. If those ids genuinely arrive one at a
    time (real-time qualification) then `add()` *is* the right path; the estimator sees the shape, not the arrival
    pattern.
  - **Planning-time by design.** Detecting this at runtime would put a counter, map lookup and clock read on every
    `add()` — the hot path everyone pays for, taxed to catch a mistake a minority makes once. Rejected outright
    rather than deferred.
- **Corrected: `add()`-in-a-loop at scale costs more than we published.** "$7.50 for 10M ids" was a **floor**, not
  the figure. The measured $0.75/million holds for warm rows ≤1 KiB — what the calibration run exercised at ~500
  ids/segment — but DynamoDB bills writes per **1 KiB** and a chunk's delta grows as you fill it, so a full ~8 KiB
  roaring-bitmap row costs 2 RRU + 8 WRU = **$5.25/million**, i.e. ~$52 for the same 10M ids. **Denser data makes
  the loop worse**, which is precisely the case where bulk-load was the obvious call. Now published as a range in
  the README, benchmarks page, and guide.
- **`pnpm test` now validates doc *anchors*, not just paths** (`tests/docs/links.test.ts`). Resolving the path
  was never the whole invariant: `[x](docs/benchmarks.md#renamed-heading)` passed the existing check and still
  dumped the reader at the top of the page with no signal anything was wrong. Adding the check immediately found
  three real breaks — a stale table-of-contents entry in the threat model, and **six** links to a phase-doc
  heading that had since gained a `*(gate — ☑ SHIPPED)*` suffix (fixed with a stable `<a id>` so a future status
  edit can't break them again). The subtlety worth recording: GitHub maps **each** space to a hyphen, so
  `## Cost & performance` is `cost--performance` — collapsing whitespace runs instead would have declared most of
  this repo's own correct links broken, and the slugifier is unit-tested against that specific mistake.
- **Real-cloud calibration — MEASURED.** The library's cost claim is no longer a model. Run
  `2026-07-25-60291` against real S3 + DynamoDB in `us-east-1` (20 segments / 2,000 `add`s / 20 publishes /
  2,000 `count`s, concurrency 16) cost **$0.001911** across 6,355 billed requests, against an always-on
  Redis-HA line of **$346/mo**. Unit economics: **$0.75 per million** incremental writes, **$0.14 per million**
  `count()`s, **$5.88 per million** segment publishes. Published with the full method, the cost-safety evidence,
  and what it does *not* establish, in [`docs/benchmarks.md`](docs/benchmarks.md#real-cloud-calibration--aws).
  - **The run measured two things the estimator could only assume.** **Zero SDK retry billing** — `attempts`
    equalled `commands` for every command type (6,355 = 6,355), so no throttle/5xx storm quietly multiplied the
    bill; and a **2.65% OCC conflict rate** (53 retries over 2,053 write attempts = 1.027 attempts per write,
    against the engine's bound of 17). It also confirmed `cold.list = 0` — LIST bills at the PUT rate, 12.5× a
    GET, so a stray list-per-read is the classic cost blowup in this design, and the read path issues none.
  - **The pre-flight projection was 95× the actual, by design.** It assumes every write exhausts all 16 OCC
    retries, making the spend ceiling a true upper bound rather than a forecast — a run that fits under it cannot
    surprise you, and one that does not gets refused rather than trimmed. (It refused at $0.10.)
  - **Latency was measured but does *not* calibrate the in-region claim, and the docs now say so.** The client sat
    outside the region: a same-machine TCP probe put the network floor at **96.0 ms** to DynamoDB and 92.6 ms to
    S3, which decomposes the phases exactly — READ p50 95.47 ms ≈ **one** round trip, WRITE p50 197.72 ms ≈ **two**
    (`add()` is `GetItem` then conditional `UpdateItem` under OCC), and throughput tracks concurrency ÷ latency
    rather than any engine ceiling. Since the North Star warm-`has()` target is
    single-digit-to-~25 ms and the floor here is ~4× that whole budget, run 1 neither confirms nor contradicts it.
    An **in-region run** (Lambda/EC2 in `us-east-1`) is recorded as the named follow-up in
    the production-readiness review, and no in-region figure is published until
    it happens.
  - **One honest floor:** AWS bills a failed conditional write at 1 WCU, but the 53
    `ConditionalCheckFailedException` responses carried no `ConsumedCapacity`, so the meter could not recover those
    units. True total ≈ $0.001944; the published figure understates by $0.000033. Disclosed on the page.
- **Real-cloud calibration harness** (`pnpm calibrate:aws`) — Phase 9 Stage 2, the tool behind the numbers above.
  Drives the real S3 + DynamoDB drivers against a real AWS account through the same three phases as `pnpm load`
  (WRITE / PUBLISH / READ), timing every op for p50/p99/p999 and metering every billable request. Method, safety
  properties, a per-run log, and an explicit list of what a run does **not** cover:
  the real-cloud method doc.
  - **Ops are metered at the AWS SDK layer, not through our own telemetry.** `IMetricsSink` emits only
    `cold.get`/`warm.read`/`warm.write`, so it cannot see S3 **PUTs** — the ingest path, billed at **12.5× a
    GET** — nor LIST, DELETE, or any registry operation. A cost figure derived from an op set missing the most
    expensive write would be an overclaim, so the harness counts commands on the client itself.
  - **DynamoDB cost comes from AWS's own numbers.** The meter injects `ReturnConsumedCapacity: 'TOTAL'` and reads
    the units back off each response, replacing our size→`ceil`→units estimate (which mis-rounds on a
    size-varied workload) with the capacity AWS reports consuming.
  - **Safety, because it spends money:** dry-run by default; a hard `CR_CALIBRATE_MAX_USD` ceiling checked
    against a projection computed the same way the result is; a required explicit region (no default — a silent
    us-east-1 fallback is how you bill the wrong account); typed confirmation; the account identity printed
    before anything is created; uniquely-named, cost-allocation-tagged resources; a refusal to touch any
    pre-existing bucket or table; and teardown from the `finally`, from a SIGINT/SIGTERM handler, or by
    `--cleanup <runId>` after an uncatchable kill. Every one of these was verified against LocalStack.
  - `CR_CALIBRATE_ENDPOINT` rehearses the whole harness against LocalStack for free, so a real-account run has no
    untested moving parts. Rehearsal also relaxes SDK checksum validation (LocalStack doesn't implement it
    fully); a **real** run leaves validation on, because end-to-end integrity is something a calibration run
    should be exercising.
- **`bench/lib/measure.cjs`** — the latency and cost maths are now shared by the LocalStack and AWS harnesses, so
  the *arithmetic* cannot drift between them. Their **dollar** figures are still not comparable, and the review
  quantified why: the LocalStack one **over-states S3 GET cost by ~90×**, because `IMetricsSink` counts *logical*
  chunk reads and the `.crbm` reader answers most of them from its cached index with no HTTP request at all
  (1901 events carrying 1016 total bytes in the committed result). Disclosed in the harness output, the method
  doc, and the test-strategy figure that quoted it.
- **`pnpm test` now guards the calibration script's refusal paths** (`tests/bench/calibrate-guards.test.ts`, 19
  cases on the pure-projection path — no AWS, no credentials, no cost).

- **Launch prep — the repo is now presentable to the public** (Phase 9, Stage 1 of the launch runbook):
  - **A public [roadmap](docs/ROADMAP.md)** — what's shipped, the **validated envelope** (what's proven, at what
    scale, and what isn't), the path to `1.0`, and an explicit *deliberately not planned* list. It is a curated,
    public-safe subset of the internal roadmap, and `CONTRIBUTING.md` now requires the two to move together.
  - **Community-health files** — a Contributor Covenant [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), issue forms
    (bug / feature, routing security reports to the private policy and questions to Discussions), and a pull
    request template tailored to this project's gate rather than generic filler.
  - **README badges** — npm version, CI, license, and supported Node. The npm/Node badges read the registry and
    the CI badge needs a public repo, so all three resolve themselves at launch.
  - **`pnpm leak-scan`** — the pre-publish gate. Always fatal: credentials (including the unquoted `.env`/YAML
    shapes, which is how secrets actually leak), private keys, non-noreply email addresses, and absolute local
    machine paths. Fatal under `--snapshot`: stale old-owner URLs and dangling private-doc references, in both
    the path form and the bare `NN-DOC-NAME.md` form. Scans tracked files, an arbitrary directory (`--dir`, for
    an **unpacked npm tarball** — the artifact no git-based scan can see and the one that's immutable once
    published), or every blob reachable from **every ref** (`--history`; `git log -p` walks HEAD only and emits
    no diff for merge commits, so it would miss a secret added as a merge resolution or left on an unmerged
    branch — both of which `git push --mirror` carries).
  - **`pnpm verify-blob-hashes`** — content-verifies a repo migration by **git blob hash**, so the package
    split's renames don't produce false alarms; relocated matches are listed rather than silently counted,
    because duplicated content (the per-package `LICENSE`/`NOTICE`/`PRIVACY.md` copies) would otherwise mask a
    real deletion. Nothing gets archived until every file provably survives.
  - **Three new doc gates** — every relative link in the docs, `site/`, and `.github/` resolves; `site/` and the
    public roadmap link nothing at a private path (which the snapshot drops, so those links resolve locally
    and 404 only in public — the reason five of them survived the package split); no user-facing file tells a
    reader to install or import the retired unscoped `cloud-roaring` name; and the exported `VERSION` matches
    **both** package manifests, pinning the lockstep-release invariant that previously had no test.

### Changed

- **Every open dependency advisory is now patched rather than accepted, and the triage list is empty.**
  `vitest` `^2` → `^3.2.7` (clearing two criticals in the UI server), and `tar`, `vite`, `postcss`, `js-yaml`,
  `fast-uri` and `brace-expansion` moved to patched releases within their existing ranges.
  - **The three accepted `tar` advisories were removed, not re-justified.** They were held on reachability
    grounds — `tar` reaches the tree only through `roaring`'s *install-time* native-build chain and is never on
    a runtime path — but the entry carried an explicit revisit condition ("`tar` ships a fixed release"), which
    upstream met. `pnpm.auditConfig.ignoreGhsas` is now `[]`. Reachability is a reason not to panic; it is not a
    reason to stay unpatched once a patch exists.
  - What remains open is dev-scope only and blocked on upstream majors (`adm-zip` via `cassandra-driver`, `qs`
    via Stryker's `typed-rest-client`, `uuid`); none of it appears in either published tarball, which carry
    **zero** and **two** runtime dependencies respectively.
- **Both packages are versioned `0.1.0-rc.0` and are no longer `private`** — the bootstrap prerelease that
  creates the two names on npm so a Trusted Publisher can be bound to each. It publishes under the `rc`
  dist-tag, so `latest` stays unset and a plain `npm i` resolves nothing until the real `0.1.0` ships through
  the attested pipeline. `private: true` was the last accidental-publish guard, and `pnpm publish` *silently
  skips* a private package (no error, exit 0) — which would have turned a real release attempt into a fully
  green run that published nothing. That guard is now carried by
  [`pnpm release:bootstrap`](scripts/bootstrap-publish.cjs) and by the release workflow, both of which **fail
  loudly** instead, and both of which verify the registry afterwards rather than trusting a clean log. The
  **root** manifest stays `private` — it is never published.
- **Both packages gained `prepack`**, so a publish can never ship a stale or absent `dist`.

- **Launch decisions locked**: the public repo will be
  **`cloudbitmaps/cloudbitmaps`** — the family monorepo, not a flavor name — with language ports as suffixed
  siblings; and the repo goes **public before the first publish**, so `0.1.0` ships with npm build provenance
  (which requires a public source repo) instead of deferring the attestation.

### Fixed

- **`publishConfig.provenance: true` made every manual publish impossible.** npm honoured it off-CI too, went
  looking for a provider to mint the attestation from, found none on a laptop, and aborted with
  `EUSAGE: Automatic provenance generation not supported for provider: null` — taking out both the bootstrap
  and the documented break-glass path. Neither `--no-provenance` nor `NPM_CONFIG_PROVENANCE=false` could
  override it (and pnpm does not forward `--no-provenance` at all). Provenance is now opt-in at the call site,
  where [`release.yml`](.github/workflows/release.yml) already passed `--provenance` explicitly, so CI's
  attestation is unchanged — verified by confirming npm still *attempts* provenance from the flag alone.
- **The post-publish check called a successful publish a failure.** npm ACKs a publish on the write path
  (`PUT 200`) but serves `npm view` from a replica that lagged **~7 minutes** for these brand-new packages, so
  probing once immediately afterwards reported `not found after publish` for two packages that were live,
  public and correct — the worst available wrong answer directly after an irreversible step. It now waits the
  propagation out (with `--prefer-online`, since npm had also cached the pre-publish 404 from its own
  precondition probe) and, if it really does time out, says to confirm against the authoritative API rather
  than assume failure.
- **The `latest` dist-tag claim was wrong in the safe direction, and the repair for it did not exist.**
  `--tag rc` states the intent but does not stop a registry from also pointing `latest` at a package's first
  version, and `npm dist-tag rm … latest` is refused. The tooling now **reports** which happened instead of
  failing a successful, irreversible publish over a condition that resolves itself when the real release claims
  `latest`. Established against a real registry rather than reasoned about.
- **A timing-fragile RNG test could fail the gate under load.** `next() stays in [0, 1)` ran 200,000 `expect()`
  calls inside its loop — ~1.3 s alone, but past the 5 s timeout when scheduled beside the heavier suites. The
  loop now records the first offending draw and asserts once afterwards, which is both stable and a better
  failure message (*which* draw broke, not "expected 1 to be less than 1"). The file dropped 1,240 ms → 37 ms and
  the whole suite 19.7 s → 9.3 s; the timeout was left at its default rather than raised to paper over it.
- **The calibration script's spend ceiling could be silently deleted.** A non-numeric `CR_CALIBRATE_MAX_USD`
  (`1,00`, `$1.00`, `abc`) parses to `NaN`, and `total > NaN` is `false` — so the documented "real bound" wasn't
  one. Now rejected, and regression-tested.
- **Refusing a pre-existing DynamoDB table orphaned the S3 bucket it had just created**, and bailed via
  `process.exit`, which skips `finally` — so nothing was even printed about the leak. Both existence probes now
  run before either resource is created.
- **Three exit paths raced each other's teardown.** A SIGTERM'd run printed only one of two deletes because the
  top-level catch's `process.exit(1)` killed an in-flight `DeleteTable`. There is now one memoised teardown
  promise awaited by the `finally`, the signal handler, and the catch. Re-verified at two interrupt points: both
  deletes complete, zero leftovers.
- **A signal during table creation would have torn down nothing** — `createFresh` returned a fresh `created`
  object, so the caller's copy stayed all-false for up to the 120 s `waitUntilTableExists` window on real AWS.
- **The meter counted commands, not billed requests, and lost capacity on failures.** It sat above the SDK's
  retry loop, so a throttled run — the case calibration exists to catch — would have under-reported. Split into
  two middlewares: attempts are tallied inside the retry loop, capacity and byte sizes are read where the output
  is actually parsed, and a failed data-plane command's `ConsumedCapacity` is recovered off the error (an OCC
  `ConditionalCheckFailedException` consumes capacity like any other write).
- **Published op counts disagreed with the published cost.** `measuredOps` was assigned by reference, so
  teardown's own LIST/DELETE landed in it *after* cost was computed — anyone recomputing cost from the counts got
  a higher number. Snapshotted now.
- **`CR_CALIBRATE_WRITES=0` ran the full default workload**, because the shared `int()` helper maps 0 to the
  default. Sizes now mean what they say, and a malformed one is an error.
- **The projection was not a bound.** Measured writes came within *one request* of a ×2 projection, so the
  multipliers were raised and the ceiling is additionally re-checked against measured cost after every phase.
- **A silently understated DynamoDB cost can no longer be published as a measurement** — if fewer capacity units
  are reported than requests issued, the run warns and stamps `cost.capacityWarning` into the result.
- `--cleanup <runId>` was documented but only the env var was read; an empty `CR_CALIBRATE_RUN_ID` would have
  named resources `cloudbitmaps-calib-`.
- **A present-but-empty `CR_CALIBRATE_ENDPOINT` meant "real AWS".** `CR_CALIBRATE_ENDPOINT=$LOCALSTACK` with the
  variable unset turned the documented *free rehearsal* — whose command line already carries
  `CR_CALIBRATE_CONFIRM=spend-real-money` — into a billed run, and for `--cleanup` a deletion aimed at a real
  account. Now an error.
- **A second Ctrl-C leaked everything.** `process.once` meant an impatient repeat signal during teardown reached
  Node's default handler and killed the process mid-delete, leaking bucket, objects and table with no warning —
  immediately after printing "tearing down before exit". Teardown is 4+ round trips on real AWS, so "press it
  again" is the expected reaction. It now warns and prints the recovery command.
- **A failed existence probe read as "absent".** `HeadBucket` answers **403, not 404**, for a bucket you own but
  can't `ListBucket` — and in **us-east-1** `CreateBucket` on a bucket you already own returns **200 OK**. The run
  would have written into your bucket and teardown would then have emptied and deleted it. Only a genuine
  not-found now counts as absent.
- **The projection still wasn't a bound.** Each OCC retry round issues another `GetItem` + `UpdateItem`, so reads
  and writes track each other — but reads had the *smaller* multiplier, so the read slot always breached first
  (measured 237 against a projected 186, triggered by `CONCURRENCY > SEGMENTS`, i.e. exactly what you'd set to
  make a run cheaper). Both now derive from the engine's own OCC retry bound, and the ceiling is additionally
  enforced **during** the WRITE phase rather than only at phase boundaries.
- **The failure counter was inverted.** A 4xx (`ConditionalCheckFailedException` — the dominant OCC case)
  *resolves* at the `deserialize` step, because the SDK's own deserializer sits outside the middleware, so it was
  recorded as a clean success and `failedAttempts` published `{}` on runs full of conflicts. Meanwhile a
  transport failure, where nothing reached AWS and nothing was billed, was counted as a billed attempt.
  Classification is now off the HTTP status. A rehearsal that reported 0 failures now reports 131.
- **Teardown couldn't empty a versioned bucket or abort an in-flight multipart upload** — the parts are billed,
  and real `DeleteBucket` refuses while one is in progress, so the last-resort cleanup tool could dead-end. It now
  aborts uploads and deletes object versions plus delete-markers.
- **A crashed run discarded every measurement it had already paid for** (reproducible: OCC exhaustion at ~90% of
  the workload). Results are now written from the `finally`, flagged `partial`.
- **`--cleanup` reported non-existent resources as leftovers that "will keep costing money"** — crying wolf on the
  common case, which trains you to ignore the one signal that matters for spend.
- The identity check could print **"@aws-sdk/client-sts is not installed"** when the real cause was an expired
  token, resolved credentials *separately* from the clients doing the work, and only ever printed the account at
  someone rather than checking it. Both clients must now agree, and `CR_CALIBRATE_EXPECT_ACCOUNT` is enforced.
- Percentiles a sample can't support now print `—` instead of a number: with n < 1000, `p999` degenerates to
  `max`, so a 20-op phase was presenting p99/p999/max as three statistics drawn from one observation.
- Meter details: don't mutate the caller's input object; count the harness's own bucket-lifecycle requests
  (billed); sum array-shaped `ConsumedCapacity` from batch/transact commands; add `TransactGetItems`.

- **The three `pnpm fuzz:*` targets silently lost coverage guidance under any other directory name.** They
  filtered instrumentation with `--includes cloud-roaring/fuzz/build`, a path substring that matched only because
  the checkout directory happened to be called `cloud-roaring`. Renaming the repo — which the launch will do —
  loaded **1 module / 512 counters instead of 2 / 663**, dropping our own code from the fuzzer's feedback loop
  while the nightly job still exited 0. Now `--includes fuzz/build`, verified to instrument identically on all
  three targets.

- **`site/` still told readers to `npm i cloud-roaring` and to import from `'cloud-roaring'`** — 32 occurrences
  across all four pages, missed when the package split swept the source and the docs. That package is a
  non-functional `0.0.0` placeholder, so every copy-pasteable example on the most shareable surface we have
  produced an empty install and a `Cannot find module`. Now guarded by a test.
- **Five `site/` pages linked into the private docs tree** — a path the public snapshot drops, so they resolved
  locally and would have 404'd only once deployed. Also a `src/` path stale since the package split, and
  `docs/guide/`'s pointer to the conformance suite.
- **The shipped `packages/roaring/PRIVACY.md` linked `docs/guide/…` relatively** — but the tarball contains no
  `docs/` tree, so those links were dead for every npm reader. It also cited a private adversarial-research doc
  by name, inside an artifact that is immutable once published.
- **`site/`'s status block** still described the drivers as upcoming and Phase 8 as the `1.0` release.
- **`site/`'s framing of the design target** claimed a productized-replacement pedigree that the roadmap
  explicitly says isn't there yet (adoption feedback is listed as still owed). Softened to what's true: the
  design target was a real workload of that shape.
- **npm keywords** now include `mysql`/`mariadb` (a shipped driver that was missing) plus `cloud-roaring` and
  `cloudbitmaps` on the flavor, so the retired unscoped name and the family name both still find it.
- **Split into the `@cloudbitmaps` family: `@cloudbitmaps/core` + `@cloudbitmaps/roaring`**
. The repo is now a pnpm workspace of two publishable packages.
  **What you install changes name, not shape:** `npm i @cloudbitmaps/roaring` (plus only the backend SDK(s) you
  use); `@cloudbitmaps/core` arrives **transitively** and is never installed directly. Every import keeps its
  form — `import { CloudRoaring } from '@cloudbitmaps/roaring'`,
  `import { S3ColdDriver } from '@cloudbitmaps/roaring/s3'` — because the flavor re-exports core wholesale and
  mirrors each driver subpath.
  - **`@cloudbitmaps/core`** — the codec-agnostic engine: `SegmentEngine` + the `CodecInterface` seam, **all**
    storage drivers (each on its own subpath, SDKs as optional peers), the `.crbm` format, crash-safe compaction,
    encryption/crypto-shred, the registry, consistency check, budget, and eject. **Zero runtime dependencies.**
  - **`@cloudbitmaps/roaring`** — the flagship flavor: the roaring codec (`SafeBitmap`/`roaringCodec`), the
    `CloudRoaring` facade, the driver re-export barrels, and both CLIs (`compact-segments`, `export-segments`).
  - **Completing the codec seam:** core can no longer default the codec (the concrete codec lives in a package
    that *depends on* core — a default would invert that arrow). `EngineDeps.codec` is now **required**; the
    public entry points that need one (`bulkLoadCrbmGeneration`, `compactSegment`, `runCompactionCycle`,
    `runExport`) keep it optional and fail fast with a typed error, while the flavor re-exports **codec-bound**
    wrappers that shadow the star-export — so existing call signatures are unchanged.
  - **Additive API surface:** core's barrel now also exports the **flavor-author kit** (`SegmentEngine`,
    `EngineDeps`, `BoundedLru`, `safeMetrics`, `groundedReport`, `validateCompactionOptions`, `runExport`,
    `splitId`/`joinId`, `mapWithConcurrency`, the budget helpers, `validateSegmentRef`) and the **driver kit**
    (`NO_ROW`, `NoRow`, `Token`, `WarmRow`, `WarmReadOptions`, `chunkRefKey`, `segmentKey`) — what a flavor or
    driver author composes, which is core's audience. Documented in
    [the API reference](docs/guide/api-reference.md).
  - Both packages shipped **private at `0.0.0`** (since versioned `0.1.0`, still private — see above);
    publishing under the scope is the Phase-9 launch itself.
  - Guard-rails added/repaired with the split: a dep-cruiser rule that **core may never import a flavor**
    (one-way arrow), the api-reference sync guard extended to both barrels + the flavor driver barrels, and the
    determinism / SDK-free-core ESLint override, the bundle-purity dep-cruiser rules, and the mutation-testing
    targets all retargeted to the new paths (they had silently matched nothing after the move).

### Fixed

- **Conformance `D4` now rides out a `TransientError`, ending a recurring Cassandra CI flake.** The
  concurrent read-modify-write conformance test asserts the OCC contract — *no lost updates* — but its retry loop
  only absorbed `WriteConflictError` and rethrew everything else. A cold Cassandra node whose Paxos layer isn't
  warm answers a burst of `INSERT … IF NOT EXISTS` with *"Server timeout at consistency SERIAL (0 peer(s)
  acknowledged)"*, failing the lane for a reason unrelated to lost updates. Production never sees this because
  `CloudRoaring` wraps every warm driver in `RetryingWarmDriver` by default, so the contract test now reflects
  real usage: transients are retried with a short linear backoff, **bounded** (25) so a driver that only throws
  transients still fails loudly. Predicted by the Phase-7 warm-driver audit (finding F2) and deferred at the
  time; promoted after it reddened CI again. Verified against a freshly-recreated (cold) Cassandra container.

### Added

- **Bitmap-codec seam** — `core/` is now **codec-agnostic**: the
  `SegmentEngine`, compaction, and the `.crbm` read/write helpers construct and combine bitmaps only through a
  new `CodecInterface` factory + `CodecBitmap` value type (`src/core/codec.ts`), never a concrete implementation.
  Roaring is the flagship codec (`roaringCodec`, delegating to `SafeBitmap`); the `CloudRoaring` facade injects
  it, so nothing changes for callers. This is the pre-split step that lets `@cloudbitmaps/bitset` /
  `@cloudbitmaps/soaring` plug in behind the same seam with zero engine or driver changes. New public exports:
  `CodecInterface`, `CodecBitmap`, `roaringCodec`. A codec-agnostic test drives the whole engine (add/has/remove/
  count/iterate/tier-merge/intersect) on a non-roaring `Set`-backed codec to prove no roaring assumption leaked.
  The hot path is unchanged — the codec is resolved once at store construction, never per-op. *(The physical
  `@cloudbitmaps/core` + `@cloudbitmaps/roaring` package split is the follow-up; the `.crbm` serialization-id
  generalizes to a per-codec id with the second codec's format work.)*

### Security

- **Supply-chain hardening (Phase 8; threat model S9).** Publishing now runs through a hardened, provenance-
  signed pipeline. A new gated [release workflow](.github/workflows/release.yml) publishes with
  `npm publish --provenance` (SLSA build provenance via GitHub OIDC; `publishConfig.provenance: true`), re-runs
  the **entire** gate against the exact commit before creating the tarball, enforces `vX.Y.Z`-tag ↔
  `package.json`-version agreement, and installs with `pnpm install --frozen-lockfile`. **Every GitHub Action
  is now pinned to a full commit SHA** (a moved tag can no longer inject code). Workflows declare least-privilege
  `permissions:` (only the release job gets `id-token: write`). Documented in
  [SECURITY.md](SECURITY.md#supply-chain-build-publish--provenance), incl. the optional from-source `roaring`
  build (already proven by the AL2023 Lambda CI job) for consumers who won't trust a prebuilt addon. The first
  real publish is the Phase 9 launch; until then the workflow runs in dry-run. The threat model
  is finalized — S9 marked implemented, and the stale per-op-budget (shipped Phase F) / audit-sink (5d) statuses reconciled.

- **Hard memory & OS ceilings (Phase 8).** Closes the readiness deferrals that were *hardening* (not launch):
  - **`pnpm rss-gate`** — the definitive hard-RSS-ceiling gate (96 residual #1).
    Runs a sustained write+read+compact workload under a hard cgroup `--memory` limit (swap off) and **fails if
    OOM-killed** — so peak RSS, *including the `roaring` addon's off-heap native memory*, is now gated, not just
    leak-watched. Wired as a CI job; runnable locally on any Linux-VM Docker (Colima/Docker Desktop).
  - **Native OS matrix** — a gated `native-os-matrix` CI job builds + loads the addon on ubuntu/windows/macOS ×
    node 20/22 (gated off on the private repo to save paid minutes; proven on `workflow_dispatch`, always-on at
    go-public — not yet run in CI).
  - **`pnpm build-lambda-layer`** — produces a ready-to-attach AWS Lambda **layer** (`roaring` compiled from
    source for Amazon Linux 2023; builder verified locally), uploaded as an artifact by a gated CI job.
  - Hardened the Cassandra integration lane's cold-boot warm-up to prime the **LOCAL_SERIAL read** path (not
    just the LWT write), fixing an intermittent `Server timeout … at LOCAL_SERIAL` flake in the concurrent-D4
    conformance test on cold CI nodes.

- **Continuous fuzzing (Phase 8).** Promoted the coverage-guided jazzer/libFuzzer campaign (T3) toward
  continuous: the fuzz workflow now runs a **nightly** (10 min/target) **and a weekly deep soak** (60 min/target)
  with an accretive cached corpus, exercising the untrusted-`.crbm` boundary well beyond a single nightly budget.
  The fully-continuous **OSS-Fuzz / ClusterFuzzLite** lane (targets are already Jazzer.js-compatible) is
  documented as the post-go-public follow-on (it needs a public repo). **Phase 8 is complete.**

### Tests

- **Per-driver engine end-to-end + wide-segment scale coverage for the Phase-7 drivers.** The six new drivers
  were conformance-verified but only S3 was exercised behind the real engine. Each driver now has an
  **engine-level end-to-end** test in its integration lane: the two cold drivers (GCS, Azure Blob) bulk-load →
  `count` / `iterate` / chunk-skipping `intersect` through a real `CloudRoaring` store; the four warm drivers
  (PostgreSQL, Redis, MongoDB, Cassandra/ScyllaDB) layer live `add`/`remove` deltas over an immutable cold base
  and prove the tier-merge (`(cold ∪ warm.adds) \ warm.removes`) + intersect. Each warm driver also gets a
  **wide-segment scale** test that writes 1.1K–2.1K chunks (past several of its own default `listChunks`
  pagination pages) and asserts the enumeration is complete + strictly ascending with no dropped/duplicated
  chunk at a page/batch seam. All green against the real docker-compose backends.

### Added

- **MySQL / MariaDB warm driver (`cloud-roaring/mysql`; Phase 7g).** `MysqlWarmDriver` — an `IWarmDriver` over
  MySQL / MariaDB via the official `mysql2` (its promise API; an **optional peer dependency**, so the core
  install stays SDK-free). A `mysql2` `Pool` is **injected**. Each chunk is one row in a single table
  (`PRIMARY KEY (key_prefix, namespace, segment, chunk_key)`) with an opaque random-UUID OCC **token** and the
  delta `payload` (LONGBLOB). OCC is real, cross-process, server-side plain SQL: create-if-absent = a plain
  `INSERT` (a pre-existing row raises `ER_DUP_ENTRY` ⇒ `WriteConflictError`); token-fenced update/delete =
  `UPDATE`/`DELETE … AND token = ?` with an `affectedRows !== 1` conflict check. The fresh-UUID-per-write makes
  `affectedRows` (which MySQL counts as *changed* rows) cleanly reflect the *match*, and the table's
  **`utf8mb4_bin` collation** makes the key columns compare **byte-exact and case-sensitive** (MySQL's default ci
  collation would alias `A`/`a` — a correctness hole the DDL closes). Column lengths keep the composite primary
  key within InnoDB's 3072-byte index limit under utf8mb4. Ships an idempotent `mysqlWarmTableDDL()` for
  deploy-time schema. Tokens are never reused across delete→recreate (ABA-safe).
  Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB / Postgres / Redis / Mongo /
  Cassandra warm drivers (finding V8) against a real MySQL (new docker-compose service + integration lane, incl.
  the engine-e2e tier-merge + wide-segment scale checks), plus a case-sensitivity regression. `mysql2` is MySQL-
  first [babystack](https://github.com/sharvilk/babystack)'s wheelhouse, so it doubles as a real-engine local
  test harness. **Rounds out the Phase 7 warm-driver set as a fast-follow.**

- **Cassandra / ScyllaDB warm driver (`cloud-roaring/cassandra`; Phase 7).** `CassandraWarmDriver` — an
  `IWarmDriver` over Cassandra / ScyllaDB via the official `cassandra-driver` (an **optional peer dependency**;
  the core install stays SDK-free). A connected `Client` is injected. Each chunk is one row in a table
  partitioned by `(kp, ns, seg)` and clustered by `ck`, so all of a segment's chunks share one partition and
  `listChunks` is a single partition read already ordered by `ck` ascending (streamed with auto-paging). The
  opaque random-UUID OCC **token** lives in a `tok` column (`token` is a CQL reserved word); OCC is a **lightweight transaction** (LWT —
  Paxos-linearizable CAS): create-if-absent = `INSERT … IF NOT EXISTS`; token-fenced update/delete =
  `UPDATE`/`DELETE … IF tok = ?` — not-applied ⇒ `WriteConflictError`. The keyspace + table names are
  identifier-validated + quoted (the sole CQL-injection vector; every other value is a bound `?`). Ships an
  idempotent `cassandraWarmTableDDL()` for deploy-time schema. Tokens are never reused across delete→recreate
  (ABA-safe). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB / Postgres / Redis /
  Mongo warm drivers (finding V8) against a real Cassandra (new docker-compose service + integration lane).
  **Completes the planned Phase 7 warm-driver set.**

- **MongoDB warm driver (`cloud-roaring/mongodb`; Phase 7).** `MongoWarmDriver` — an `IWarmDriver` over
  MongoDB / DocumentDB via the official `mongodb` driver (an **optional peer dependency**; the core install
  stays SDK-free). A `Db` is injected. Each chunk is one document keyed by a **deterministic composite `_id`**
  (`<prefix>|<ns>|<seg>|<chunkKey>`) with an opaque random-UUID OCC token + the delta payload (BSON binary).
  OCC is per-document + server-side: create-if-absent = `insertOne` (a duplicate `_id` ⇒ `WriteConflictError`);
  token-fenced update/delete = `updateOne`/`deleteOne` filtered on `{ _id, token }` (a 0 matched/deleted count ⇒
  `WriteConflictError`). Each op is single-document atomic (no transaction). `listChunks` streams a `find` cursor
  sorted numerically by `ck` (bounded memory). Ships `ensureMongoWarmIndexes()` for the `listChunks` index (the
  composite `_id` already makes create-if-absent unique — no extra index needed). Tokens are never reused across
  delete→recreate (ABA-safe). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB /
  Postgres / Redis warm drivers (finding V8) against a real MongoDB (new docker-compose service + integration
  lane).

- **Redis warm driver (`cloud-roaring/redis`; Phase 7).** `RedisWarmDriver` — an `IWarmDriver` over Redis via
  the official `ioredis` (an **optional peer dependency**; the core install stays SDK-free). An `ioredis`
  client is injected. The "sub-millisecond writes, accept always-on" warm tier. Each chunk is a Redis **hash**
  (`t` = opaque random-UUID OCC token, `b` = delta payload); each segment keeps a **sorted-set index** of its
  live chunk keys (Redis has no range scan) that `listChunks` reads ascending. Optimistic concurrency is a
  **server-side atomic Lua compare-and-set** (Redis runs the script atomically — no `WATCH`/`MULTI`): create-
  if-absent fails if the hash exists; token-fenced update/delete fails unless the stored token matches — both
  ⇒ `WriteConflictError`. The hash + index share a Redis-Cluster **hash tag** so the multi-key script is
  slot-safe. Tokens are never reused across delete→recreate (ABA-safe). Passes the same `warmConformance`
  suite as the in-memory / LocalFs / DynamoDB / Postgres warm drivers (finding V8) against a real Redis (new
  docker-compose service + integration lane).

- **PostgreSQL warm driver (`cloud-roaring/postgres`; Phase 7).** `PostgresWarmDriver` — an `IWarmDriver`
  over PostgreSQL via the official `pg` (an **optional peer dependency**; the core install stays SDK-free). A
  `pg.Pool` is injected. "No DynamoDB — use the Postgres you already run." Each chunk is one row keyed by
  `(key_prefix, namespace, segment, chunk_key)` with an opaque OCC **token** (a random UUID minted per write)
  and the delta payload (`bytea`). Optimistic concurrency is real, cross-process, server-side: create-if-absent
  is `INSERT … ON CONFLICT DO NOTHING` (0 rows ⇒ `WriteConflictError`); token-fenced update/delete is
  `UPDATE`/`DELETE … WHERE … AND token = :expected` (0 rows ⇒ `WriteConflictError`). Tokens are **never reused**
  across delete→recreate (ABA-safe). `listChunks` is keyset-paginated (bounded memory on wide segments). Ships
  an idempotent `postgresWarmTableDDL()` to create the table at deploy time (the driver stays thin — no runtime
  DDL); the table name is identifier-validated + quoted (the one non-parameterizable value → the sole injection
  vector, closed). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB warm drivers
  (finding V8) against a real Postgres (new docker-compose service + integration lane). **First non-AWS warm
  tier — "use the datastore you already run."**

- **Azure Blob cold driver (`cloud-roaring/azure`; Phase 7).** `AzureBlobColdDriver` — an `IColdDriver` over
  Azure Blob Storage via the official `@azure/storage-blob` (an **optional peer dependency**; the core install
  stays SDK-free). A container-scoped `ContainerClient` is injected. Generations are **write-once** immutable
  blobs — the conditional `ifNoneMatch: '*'` makes publish atomic (a second write is a `WriteConflictError`,
  never a silent overwrite), the Azure analogue of S3's `If-None-Match: *` and GCS's `ifGenerationMatch: 0`.
  Writes **stream in constant memory** (a small blob is a single conditional `upload`; a larger one is staged as
  blocks, each freed as it goes, committed with a conditional `commitBlockList` — **write-once enforced on both
  paths, empirically verified against Azurite**). Range + tail reads, idempotent delete, and generation listing
  round out the contract. Passes the same `coldChunkSourceConformance` suite as the in-memory / LocalFs / S3 /
  GCS cold drivers (finding V8) against the Azurite emulator (new docker-compose service + integration lane).
  **Completes the object-store story on all three major clouds: AWS (S3) + GCP (GCS) + Azure (Blob).**

- **GCS cold driver (`cloud-roaring/gcs`; Phase 7).** `GcsColdDriver` — an `IColdDriver` over Google Cloud
  Storage via the official `@google-cloud/storage` (an **optional peer dependency**; the core install stays
  SDK-free). The `Storage` client is injected. Generations are **write-once** immutable objects — a resumable
  upload with `ifGenerationMatch: 0` makes publish atomic (a second write is a `WriteConflictError`, never a
  silent overwrite), the GCS analogue of S3's `If-None-Match: *`. Writes **stream in constant memory**; range +
  tail reads, idempotent delete, and generation listing round out the contract. Passes the same
  `coldChunkSourceConformance` suite as the in-memory / LocalFs / S3 cold drivers (finding V8) against the
  `fake-gcs-server` emulator (new docker-compose service + integration lane). Runs on any major cloud's object
  store: **AWS (S3) + GCP (GCS)**, with Azure Blob next.

- **Byte-aware cold-reader cache bound + native-memory soak proof; production-readiness verdict → READY within a validated envelope.**
  A fresh 6-lens adversarial re-audit of production readiness (verified against the *current code*) found the
  fixes solid — docs-vs-code honesty **resolved**, correctness clean — with two gaps in the *memory-bound proof*,
  now closed: (1) the cold-reader cache is bounded by aggregate parsed-index **bytes** (new `coldReaderCacheMaxBytes`,
  default 64 MiB), not just open-segment **count**, so a working set of unusually *wide* segments can't pin
  gigabytes of indices while the count looks in-bounds (finishes audit gap #1); (2) the soak endurance harness now
  watches the roaring addon's **off-heap native memory** (`getRoaringUsedMemory()`) for creep alongside JS heap —
  a flat heap alone was not evidence the native footprint is bounded. Scope stated honestly: these prove *no leak*
  on the read path, not a hard RSS ceiling (the cgroup `--memory` gate stays deferred to the public launch). Also:
  the reference `compact-segments` daemon can emit per-attempt `MetricEvent`s on stdout via `CR_COMPACT_METRICS=1`.
  The the production-readiness review verdict is upgraded from the original
  analytical NOT READY to **READY within a validated envelope** (read-mostly / ≤~100K segments / tens-of-millions
  ids-per-segment / single-tenant / single-region; billions-ids, real-AWS cost calibration, and multi-tenant
  isolation are the named Phase-8 deferrals). Hot path (`add`/`has`/`remove`/`count`/`intersect`) unchanged.
- **Chaos drills against LocalStack (test-strategy T8) — completes the T1–T8 testing frontier.**
  `pnpm chaos` (`bench/chaos-localstack.cjs`; offline, needs LocalStack + `docker`, not a CI gate) injects real
  faults at the AWS SDK drivers: a **throttle storm** (`ThrottlingException` at ~30% of DynamoDB calls, SDK
  retries off) — the store's retry layer rode out 818 injected throttles with **no lost update** — and a
  **backend outage** (`docker pause` for 2.5 s) — ridden through, every write lands, consistency preserved.
  Daemon-kill-mid-2PC stays with the in-process crash-at-every-step sweep; disk-full is deferred (not injectable
  on ephemeral LocalStack). No product code change.
- **Load + tail-latency harness against LocalStack (test-strategy T7).**
  `pnpm load` (`bench/load-localstack.cjs`; offline, not a CI gate) drives the **real** S3 + DynamoDB drivers
  against LocalStack (a new on-demand `docker-compose.localstack.yml`) in three timed phases (add → DynamoDB OCC,
  bulk-load → S3 PUT, count → tier-merge), reporting throughput **and p50/p99/p999** tail latency, plus a $
  projection computed from a metrics sink's **measured** op-counts at published AWS prices (vs the always-on
  Redis baseline). Explicitly LocalStack-on-a-laptop numbers, not an AWS SLA. **This workload surfaced the CJS
  cross-bundle identity bug** (see Fixed / ).
- **Security hardening (test-strategy T6).** Three additions atop
  the existing crypto/trust-boundary coverage: **external AES-256-GCM known-answer vectors**
  (`tests/crypto-vectors.test.ts` — McGrew–Viega / NIST test cases) pin the AEAD to published answers, not just
  self-referential round-trips; an **end-to-end KEK-rotation test** (`tests/key-rotation.test.ts`) proves old
  segments read under a retained old KEK (and compact without re-wrapping) while new segments adopt the new
  active KEK; and a **blocking CI dependency audit** (`pnpm audit` → `scripts/audit.cjs`, prod deps at high)
  guards the supply chain. Adds a **`SECURITY.md`** (private reporting policy, trust boundary, and the three
  triaged build-time `tar` advisories reached only via `roaring`'s install-time `node-pre-gyp` chain — never on
  the runtime path). No product code change.
- **Executable DR drill (test-strategy T5).** `pnpm dr-drill`
  (`tests/dr-drill.test.ts`) turns the [disaster-recovery runbook](docs/guide/disaster-recovery.md) into a
  gated, **on-disk** `backup → corrupt → restore → verify` exercise against the real `LocalFs` cold + registry
  tiers. It injects a **torn restore** (registry recovered ahead of cold) and a **lost `.crbm`** — both detected
  as `missing-cold-generation` and cleared by rolling `currentGen` back / restoring the object — and **byte
  corruption** inside a present `.crbm`, which `checkConsistency` deliberately **cannot** see (it is
  presence-only) but which fails closed on read with `IntegrityError` (per-chunk CRC). Documents and verifies
  why the runbook's post-restore read spot-check exists. No product code change — the DR primitives already
  shipped in Phase F.
- **Stress harness (test-strategy T4).** An offline `pnpm stress`
  (`bench/stress.cjs`; machine-dependent, **not** a CI gate) pushes three subsystems past their comfort zone,
  each against a deterministic oracle: **S1** a budgeted compaction-backlog drain (1,000 dirty segments drain in
  16 monotonic cycles, ≤ 64 compacted/cycle — the compaction *count* is budget-bounded; discovery stays
  O(fleet)); **S2** hot-row OCC contention (4,800 concurrent ops on one chunk → the effective set equals a
  per-writer oracle exactly, no lost update); **S3** a 50 M-id single segment where `count === 50 M` (no loss),
  counted in tens of ms, footprint tracking the roaring container structure (RSS ~370 MiB; JS heap stays ~5.4 MiB
  only because roaring is off-heap). **S2 surfaced a real data-loss bug** (the OCC-backoff premature-exit fixed
  in ) — see Fixed. Results persist to
  `bench/stress-results.json` with `STRESS_INJECT=1`.
- **Mutation testing of the core with Stryker (test-strategy T2).**
  A [Stryker](https://stryker-mutator.io) pass (`pnpm mutation`) injects mutants into the highest-risk core logic
  — compaction 2PC/OCC, tombstone merge, bounded concurrency, bit routing (~1,115 LOC) — to quantify how well the
  suite catches bugs. **83.4% mutation score on covered code** (79.1% incl. uncovered; 449 killed / 90 survived /
  29 no-cov / 2 timeout of 570). It found **real gaps**, now hardened: a one-sided boundary in `decodeDelta` (the
  suite tested only _over-cap rejection_, never that a _maximal in-spec_ delta is _accepted_ — an off-by-N in the
  cap arithmetic would reject legitimate Warm rows; **chunk.ts 68% → 85%**), plus two reachable compaction
  branches (bootstrap-clean; encrypted-segment-without-keystore → `KeyUnavailableError`, never a silent decode).
  Residual survivors (concentrated in `compaction.ts`) are error-message strings (unasserted by design),
  observability/metrics-timing mutants, and defensive/edge branches. Offline + on-demand (not a CI gate; re-run
  pre-freeze). Dev-only (`@stryker-mutator/*` devDeps).
- **Coverage-guided fuzzing of the untrusted-`.crbm` boundary (test-strategy T3).**
  Beyond the seeded property fuzz already in the suite, a [jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
  (libFuzzer) campaign (`pnpm fuzz:*`, nightly) evolves adversarial inputs toward unreached branches over three
  targets — the **native** CRoaring portable deserializer (ungated), the hand-written index parser `parseIndex`
  **directly** (past the CRC wall a mutational fuzzer can't cross), and `CrbmReader.open`'s validation front.
  All assert the boundary contract: arbitrary bytes yield a typed `CloudRoaringError` or a self-consistent
  success, never a `RangeError`/native crash/hang.
  - Recorded run (Apple M3 Pro, 120 s/target): **~11.3 M adversarial executions, 0 crashes** — 4.19 M against
    the deserializer (~34.6k/s, black-box: native C++ isn't instrumentable), 3.72 M against `parseIndex`
    (~30.7k/s, coverage-guided: 34 edges / 189 features), 3.37 M against the reader front (~27.8k/s,
    coverage-guided: 102 edges / 163 features).
  - **Offline + nightly, not a CI gate** (corpus cached so coverage accretes). A found crash becomes a committed
    reproducer under `tests/core/crbm/fuzz-corpus/`, replayed by a new test on **every** PR — so the campaign
    stays offline while every fixed bug is guarded. Harness + policy in [`fuzz/README.md`](fuzz/README.md).
  - Dev-only (`@jazzer.js/core` devDep; nothing enters the published bundle).
- **Soak / endurance harness — no heap creep under sustained load (test-strategy T1).**
  A new offline endurance harness (`pnpm soak`) runs sustained mixed load — continuous writes + reads across the
  population + compaction (with orphan-generation GC) — and samples **post-GC retained heap over time**, asserting
  the last-third median hasn't grown past the first-third median beyond a **relative** band. Complements G4's
  memory _snapshot_ with the _steady state over time_:
  - **No creep** — 90 s / 400 segments / 712 real compactions leaves post-GC heap flat (~7.3 → 7.4 MiB; +0.1 vs a
    2.1 MiB band) → PASS (measured; Apple M3 Pro).
  - **Isolated reader-child footprint** (closes G4's follow-up) — a fresh reader-only child reading the whole fleet
    holds a **6.8 MiB post-GC heap** (the read-path bound); its ~65 MiB RSS is the fixed Node + roaring-addon floor.
  Requires `--expose-gc` (the script sets it) and **fails fast without it**, since a no-op GC would hide a leak.
  Measured + machine-dependent, so — like the other benches — **not** a CI gate; a multi-day run is the same
  harness at a larger `SOAK_SECONDS` (nightly). Results in
  the test-strategy doc + `bench/soak-results.json`.
- **At-scale benchmark — measured readiness at 1K→10K→100K segments (Phase G4).**
  A new offline load benchmark (`pnpm bench:scale`) that converts the production-readiness audit's code-read
  conclusions into **measured** evidence at fleet scale, building up to 100K real `.crbm` segments on local disk:
  - **Bounded memory (the headline).** Reading across the _entire_ fleet under the default reader-cache cap holds
    retained live heap **flat at ~7 MiB from 1K to 100K segments** (measured; Apple M3 Pro) — memory is a function
    of the working set (the cap), not the fleet, exactly as the design claims (closes the measurement half of gap #1).
  - **Discovery cost characterized** — `findCompactable` timing across fleet sizes shows the honest `O(total)`
    registry-enumeration floor (gap #3); sharding (which splits the Warm drain, not the enumeration) is discussed
    in prose, not measured here.
  - **Chunk-skipping intersection holds at scale** — two large multi-chunk segments intersect by fetching only
    the shared chunks, skipping the rest by key alignment.
  Measured (wall-clock + RSS) and machine-dependent, so — like the cost bench — **not** a CI gate; the
  deterministic claims stay gated in `tests/bench/anchors.test.ts`. Results land in a new "At scale" section of
  [docs/benchmarks.md](docs/benchmarks.md).
- **Simulator hardening — compaction under concurrency (Phase G3).**
  The deterministic simulator now runs the **real** engine + `.crbm`/registry path with a compaction actor racing
  each batch's live reads/writes through one seeded scheduler, closing audit gap #12's "simulator half": the 2PC,
  intersection-under-compaction, torn-read, and crash-recovery are proven by a **searched interleaving** rather than
  hand-examples. New oracle coverage — effective-set equivalence under a racing compaction (fenced-purge / no-lost-write),
  chunk-skipping `intersect` equals the oracle intersection on a just-rewritten segment, and no torn read of a
  write-free segment being compacted (generation-pinning). New faults — a **process crash injected at any durable
  2PC step** (staged generation + lease-acquire/`currentGen`-swap/lease-release), and **transient faults on cold
  reads** ridden out by the retry decorator. Determinism holds: a disabled fault draws no randomness, so every
  prior seed replays byte-for-byte. Test-only (nothing enters the published bundle).
- **Zero-cost pre-freeze test/release gates (Phase G2).**
  Two release gates that run for **$0** on the self-hosted runner, before the 1.0 format freeze:
  - **Bounded-memory gate (structural).** A deterministic at-scale test proves the cold-reader cache is bounded
    by its cap, not the fleet size (gap #1): reading a fleet far larger than the cap twice re-opens every
    segment (2N opens) because each is evicted before the loop returns — an unbounded cache (the pre-Phase-C
    regression) would keep them resident (N opens) and fail. (A hard cgroup-OOM gate is deferred to the
    public-launch Linux runners — Docker Desktop for Mac doesn't reliably enforce `--memory`.)
  - **AWS Lambda / Amazon Linux 2023 deployability smoke.** Builds the native `roaring` dep for the AL2023
    Lambda runtime and loads the packaged library under both ESM and CJS in a container (`pnpm lambda-smoke`
    + a CI job). Surfaces a real deploy note: `roaring` ships no linux-arm64 prebuilt for the current Lambda
    node runtimes, so it must be **built for the target** (container build / SAM `--use-container` / a layer) —
    see [Deploying to AWS Lambda](docs/guide/getting-started.md#deploying-to-aws-lambda). A prebuilt Lambda
    layer for a drop-in experience, and a native windows/ubuntu OS matrix, are deferred to the public launch.
- **Schema-version stamps on the Warm-delta & registry formats (Phase G1 — pre-1.0 format-freeze prerequisite).**
  A pre-1.0 format-freeze prerequisite: every persisted format now carries a version discriminator, so a
  future, incompatible writer's bytes **fail closed** on an old reader instead of being silently misparsed
  (the Cold `.crbm` format already had this).
  - **Warm delta** gains a 1-byte version prefix (`[u8 version][u32 addsLen][adds][removes]`); an unrecognized
    version is rejected with `UnsupportedError`.
  - **Registry rows** gain a `schemaVersion` field (LocalFs/S3 envelope + DynamoDB body): a **newer** version
    is rejected (`UnsupportedError`), an **absent** one is tolerated as legacy v1 so durable pre-freeze rows
    stay readable across the upgrade. The stamp is wire-only — it never appears on the in-memory record; the
    in-RAM `Memory*` drivers carry no stamp.
  - Error-type split mirrors the `.crbm` reader: unknown *version* → `UnsupportedError`, structural
    *corruption* → `IntegrityError`. **Scope:** the *logical* formats are stamped; the per-driver *physical*
    framings (e.g. LocalFs warm's `[counter][deleted]` prefix) wrap the versioned payload and are intentionally
    not separately stamped. **+1 byte/Warm-row, ~18 bytes/registry-row; O(1), off the hot path.**
  - **Upgrade note:** pre-stamp *Warm* rows fail closed on read (never a silent wrong answer) — because Warm is
    a transient tier, drain/compact or wipe+re-seed it on an in-place upgrade; durable *registry* rows are
    tolerated as v1 and need no action.
  - Incidental hardening: `parseRegistryEnvelope` now rejects `null`/primitive JSON with a typed
    `IntegrityError` instead of an uncaught `TypeError` (invariant 5).
- **Tenancy, denial-of-wallet budget & DR consistency (Phase F — audit gaps #8/#11).**
  Three pre-1.0 hardening items, scoped lean (the fuller tenancy/crypto/format work is deferred to Phase 7/8 — see below):
  - **Per-op request budget (#8) — the denial-of-wallet ceiling the specs asserted but never built.** A new
    `BudgetExceededError` + a store-level `budget` option (default `{ maxRequests: 1_000_000 }` — on, but
    generous), with a per-op override and `budget: false` to disable. `count` / `iterate` / `intersect` /
    `subjectReport` / `eraseSubject` now **refuse before fan-out** when the work would exceed the ceiling.
    The check is **O(1)** against the already-known fan-out size, so the hot path (`add`/`has`/`remove`) is
    untouched. Byte volume is **transitively bounded** by requests × the per-request safe-deserialize size
    cap, so no per-chunk byte accounting is added (a deliberate refinement of the spec's "requests *and* bytes"; T3 / Decision #3 updated to match).
  - **Minimal tenancy guard.** `subjectReport` / `eraseSubject` operate over the **global u32 id space**
    shared across namespaces, so a namespace-less call is a fleet-wide sweep. They now require an explicit
    `namespace` **or** an `{ allNamespaces: true }` acknowledgement — a fleet-wide erase/report can no longer
    be the accidental default. (Full namespace-scoped handles + per-namespace KEK are deferred to Phase 7/8.)
  - **Torn-restore detection (#11).** `store.checkConsistency()` (and the standalone `runConsistencyCheck`)
    verify every registered segment's `currentGen` `.crbm` is actually present in cold storage — catching a
    **registry recovered ahead of the object store** (its `currentGen` points at a generation that was never
    restored), which would otherwise surface as a failed read much later. Paired with a coordinated-restore
    runbook ([docs/guide/disaster-recovery.md](docs/guide/disaster-recovery.md)). The self-healing
    footer-DEK format change is documented as a deferred evolution (the footer is full; it also changes the crypto-shred model — "Reserved / future").

  New `BudgetExceededError`, `DEFAULT_BUDGET`, `runConsistencyCheck`, and the `Budget` / `BudgetOption` /
  `ConsistencyReport` / `ConsistencyIssue` types are exported.

### Documentation

- **Production-readiness re-audit — operator docs + envelope re-scope.** A second 6-lens adversarial readiness
  re-audit against the merged 10-driver code found the correctness verdict unchanged (no in-envelope
  silent-wrong-answer hole in the 8 Phase-7 drivers) but surfaced **operator-facing footguns** the
  DynamoDB/S3-era docs never covered. Closed here (companion to the code fixes in
  ):
  - **getting-started** now documents production wiring for all 7 new backends + a "choosing a registry"
    callout: the **Redis eviction footgun** (`maxmemory-policy noeviction` + AOF, or warm chunks silently drop →
    wrong answers), the **registry-pairing rule** (the new drivers are tier-only → a compaction-enabled
    deployment needs an S3/DynamoDB registry), and per-driver required settings (MySQL `utf8mb4_bin` +
    `ROW_FORMAT=DYNAMIC`, Cassandra RF + must-wrap-in-`RetryingWarmDriver`, Mongo simple collation +
    `ensureMongoWarmIndexes`).
  - **disaster-recovery** gains a **per-backend backup/PITR table** (warm: DynamoDB PITR · PG WAL · MySQL binlog
    · Mongo oplog/snapshot · Cassandra snapshot · Redis AOF+RDB; cold: S3/GCS/Azure versioning) — warm sets your
    RPO, and Redis-warm is the only live copy; the `checkConsistency` **Case-A honesty note** (detects the torn/dangling-pointer case, not the #35 silent lost-update); and a **no manual
    publish during active compaction** caveat.
  - **the production-readiness review** §2.2 re-scopes the validated envelope to **DynamoDB + S3 (fully documented)**,
    with the other 8 drivers labeled **conformance-passing + correctness-clean**; roadmap updated.
  - **README + SECURITY**: Alpine/musl install note (`roaring` has no musl prebuilt → needs a build toolchain).

- **Post-Phase-8 accuracy sweep.** Reconciled all docs against the merged Phase 7–8 state. Launch facts
  corrected everywhere: public launch is **Phase 9 at `0.1.0`** (not "Phase 8"/`1.0.0`); the **`.crbm` format
  freeze gates `1.0`, not the `0.1.0` launch**; the package publishes scoped as **`@cloudbitmaps/roaring`**
  (umbrella family) and the split is the Phase-9 pre-release gate;
  trademark search/registration is a Phase-9 task, not "deferred". Added a *partially-superseded* banner to the
  release runbook and fixed its decisions table, publish command, and
  checklist. Marked the **hard cgroup-RSS ceiling gate** as **shipped** (`pnpm rss-gate`, Phase 8) across the
  testing/readiness docs (previously listed as deferred), and the **Lambda layer** as shipped
  (`pnpm build-lambda-layer`). Added **MySQL/MariaDB** to warm-driver enumerations; corrected barrel count to
  **ten**; updated fuzz-PR references (`#92` → `#93`); refreshed roadmap/phase status markers to Phases 1–8
  complete. Clarified that the conformance suite stays **internal** (no public `./testing` export — the Phase-7-publish note in was deferred).
- **Phase 7 driver-doc sweep.** Synced the docs to the shipped driver set now that all six Phase-7 drivers have
  merged. Corrected the `IWarmDriver` OCC-token table in the driver SDK contract — the
  **PostgreSQL** row wrongly described the token as a `version`/`xmin`/counter; all four warm drivers (Postgres,
  Redis, Mongo, Cassandra) use a **per-write random UUID + hard delete**, now recorded as a first-class
  contract-valid realization alongside the monotonic counter (reconciled the "recommended implementation" prose and the locked-decision row). Added a **Cassandra/ScyllaDB
  operational note** (LWT + `LOCAL_SERIAL` reads + single-partition-per-segment hot-partition guidance).
  Refreshed the stale status/"works today"/driver-list prose in the [README](README.md), the
  [getting-started guide](docs/guide/getting-started.md), and the usage guide; fixed the
  "three barrel files" → nine count and completed the driver-option-types index in
  [the API reference](docs/guide/api-reference.md); corrected the `tsup.config.ts` entry comment
  ("AWS SDK" → the per-driver backend SDKs). Marked **Phase 7 complete** in the roadmap and phase doc.

### Fixed

- **Pre-launch hardening from the production-readiness re-audit** (6-lens adversarial pass against the merged
  Phase 7–8 code). Four sharp code/test fixes; no in-envelope correctness defect was found, these close latent
  edges before the `0.1.0` publish:
  - **MongoDB warm driver now pins a binary collation** (`{ locale: 'simple' }`) on every `get`/`update`/
    `delete`/`list` op + the index. Under a case-**insensitive** collection default collation, an unpinned query
    could match the wrong document (case-differing segments/namespaces are distinct stores) → cross-segment
    read/leak. This is the Mongo analogue of the MySQL `utf8mb4_bin` requirement; a case-sensitivity integration
    test (mirroring MySQL's) now guards it. *(insert uniqueness is still governed by the `_id` index collation —
    the operator guide states the warm collection must use the simple default collation.)*
  - **`InProcessKeystore.openDek` now tries every held wrapping**, not just the first. A DEK is wrapped under
    both the active and (optional) offline **recovery** KEK precisely so a corrupt/tampered active-KEK wrapping
    can be recovered from the other — but the loop returned on the first held keyId and let a failed unwrap
    throw, defeating that insurance. It now falls through to the next held wrapping and only surfaces the
    integrity failure when **all** held wrappings fail (a missing-KEK case still raises `KeyUnavailableError`).
  - **Chunk-skipping intersection is now tested at the boundaries** — the crown-jewel path at the maximum
    chunk-key span (id `0xFFFFFFFF`, chunk `65535`) and a common chunk whose effective set is fully tombstoned
    in one operand (must yield `null` and be skipped, not a phantom id). Membership was already proven at the
    ceiling; intersect was only sampled below chunk key 4.
  - **GCS resumable (large-object) upload path is now exercised end-to-end against fake-gcs-server** (previously
    only the ≤8 MiB simple path was emulator-grounded). Write-once *enforcement* on the resumable finalize stays
    covered by the driver mock (sends `ifGenerationMatch:0`, maps a 412 → `WriteConflictError`) + real GCS,
    because fake-gcs-server does not honor the precondition on resumable finalize — documented in the test.

- **Cross-bundle identity broke the DynamoDB driver + all retry/resilience in the published CJS package (found by the T7 LocalStack load harness).**
  The package ships separate bundles (the core entry + the `./s3` / `./dynamodb` subpaths); the CJS output
  inlines its own copy of `core/*` into each, so values compared by **identity across that boundary** broke for
  `require()` consumers. Two symptoms, both invisible to the test suite (one source module graph): (1) the
  `NO_ROW` create sentinel was a plain `Symbol('no-row')` → distinct per bundle → `expected === NO_ROW` always
  false → **every warm-row create failed** (empty-`:expected` `ValidationException`); (2) the typed **error
  classes** were duplicated per bundle → the engine/retry/compaction `instanceof WriteConflictError` /
  `isTransient` checks against **driver-thrown** errors returned false → **OCC retry, transient-fault retry, and
  compaction race-handling were silently disabled** (the Phase-4b resilience layer was a no-op in CJS). Fixes:
  `NO_ROW` is now a global-registry `Symbol.for`; errors carry `Symbol.for` **brands** and are classified by new
  exported predicates — **`isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
  `isNotFoundError` · `isIntegrityError` · `isValidationError`** (prefer these over `instanceof` when catching
  errors from a cloud driver) — replacing every cross-boundary `instanceof` in `core/`. Guarded by unit tests +
  a built-bundle cross-check in `scripts/smoke.cjs`. Verified end-to-end against LocalStack.
- **OCC-backoff premature process exit — silently dropped contended writes (found while developing the T4 hot-row stress).**
  The default clock's `sleep` **unref'd** its backoff timer. Because that `sleep` only ever backs a
  caller-awaited, bounded retry (the engine's OCC read-modify-write and the driver `withRetry` loop), the
  timer was the sole thing holding a short-lived process open during a retry. Under contention on a hot chunk,
  a losing writer would back off, and if that backoff timer was the process's only remaining handle, Node
  treated the event loop as empty and **exited `0` mid-retry** — the awaited `add()`/`remove()` neither applied
  nor threw. This struck exactly the serverless target (Lambda/CLI/short-lived scripts) the library is built
  for. Fix: the default clock now uses a **ref'd** timer; a pending backoff keeps the loop alive until the
  awaited, bounded retry resolves. Guarded by a regression test (`tests/backoff-liveness.test.ts`); the
  bare-process end-to-end contention scenario that first exposed it lands with the T4 stress PR. No hot-path or
  steady-state cost (retries are bounded).
- **Read-path cost & admin latency (Phase E — audit gaps #9/#10).**
  Four cost/latency gaps from the readiness audit, kept lean (two heavier sub-items deferred — see below):
  - **Opt-in eventually-consistent warm reads (#9).** Every warm `has()`/`count()`/`iterate()`/`intersect()`
    previously forced a **strongly-consistent** DynamoDB read (2× RCU) with no in-process absorption. A new store
    option `warmReadConsistency: 'strong' | 'eventual'` (default `'strong'`, unchanged) makes the **read paths**
    eventually-consistent — **~½ the read cost** — while the OCC read-modify-write path stays strong regardless
    (correctness). No effect on the always-strong in-memory / LocalFs drivers. Trades read-after-write for cost.
  - **Compaction is now in the cost estimator (#10).** `estimateCost` / `segment.costReport` add a `compaction`
    term (whole-generation re-read + PUT + Warm purge) to `byOp` / `byTier`. Default `compactionsPerMonth: 0`
    leaves existing estimates unchanged, but the report now **discloses** the omission instead of silently
    under-reporting the background job that usually dominates operational cost. (First consumer of
    `pricing.cold.putPerMillion`, now validated.)
  - **Bounded admin fan-out.** `subjectReport` / `eraseSubject` scanned segments **serially**; they now fan out
    at a bounded `concurrency` (default 8) — per-segment fault isolation preserved. The **S3 registry `list()`**
    did one GET per key serially (an N+1); it now reads each page's rows at bounded parallelism.
  - **Bounded flusher.** `addMany` / `removeMany` gain an opt-in `writeConcurrency` (default **1** ⇒ unchanged
    serial) to fan distinct-chunk writes out for throughput on wide batches.

  New reusable `mapWithConcurrency` primitive (`core/concurrency.ts`) underpins the fan-out. **Deferred
  (documented):** an in-process short-TTL warm-chunk cache (#9) and compaction's coalesced constant-memory merge
  GET (#10) — each needs its own focused change.
- **Scaled the compaction daemon for the fleet + made it observable (Phase D — audit gaps #2/#3).**
  The crash-safe daemon was correct but a single unsharded worker, invisible to monitoring, and could wedge on one
  bad segment. Phase D closes those fleet-scale gaps (kept lean — see the deferred list):
  - **Observability + a dead-man's-switch (#2).** Every compaction attempt now emits a `compaction` metric to your
    `IMetricsSink` (committed / clean no-op / error, dirty-chunk count, rows purged, ms), and every commit stamps
    `lastCompactedAt` on the segment's registry record. Alarm on "nothing compacted in the last hour" to catch a
    wedged or absent daemon — previously a compaction failure was logged-and-swallowed with no signal at all.
  - **Poison-segment quarantine (#2).** A segment whose compaction kept throwing (e.g. one corrupt warm row) used
    to be retried every cycle **forever** — freezing that segment's compaction and burning money. It's now
    quarantined after `quarantineThreshold` consecutive failures (default 5), skipped until a cooldown elapses
    (default 5 min), then retried once; a success clears the streak. One poison segment can no longer wedge a worker.
  - **Shardable, budgeted, urgency-ordered discovery (#3).** Run N workers over disjoint shards (`shard`/`totalShards`;
    CLI `CR_COMPACT_SHARD` / `CR_COMPACT_TOTAL_SHARDS`) partitioned by a stable hash — disjoint and covering the whole
    fleet, no coordination. `maxScanSegments` (CLI `CR_COMPACT_MAX_SEGMENTS`) caps work per cycle, compacting the
    most-backed-up segments first (dirty-chunk count, oldest-compacted tiebreak) and deferring the rest so a burst
    can't starve the tail. A change-guarded CAS skips the registry write when nothing moved. `runCompactionCycle`
    now returns `{ candidates, compacted, deferred, results }`.

  Two **optional** registry fields (`lastCompactedAt`, `consecutiveFailures`) carry the daemon state — both optional
  for backward-compatibility with existing rows. **Deferred (documented):** an O(dirty) enumeration seam
  (`Select:COUNT` / GSI / projection) + resumable cursor, lease heartbeat/renewal, and lease-aware publishing (the
  Phase B #5 residual).
- **Bounded the cold-reader cache — no more unbounded index growth (Phase C — audit gap #1).**
  `CrbmColdChunkSource` held opened `.crbm` readers (each carrying a fully-parsed index) in an **unbounded** map,
  so a long-running server that read across many segments grew its footprint with *every distinct segment ever
  read* (tens of GB / OOM at 100K+ segments). The reader cache is now a `BoundedLru` capped by a new
  `coldReaderCacheMax` option (default **1024** segments): past the ceiling the least-recently-used segment's
  reader is evicted, and re-reading it later re-opens it in one cheap tail GET (generations are immutable). The
  gap-#4 currentGen TTL is unchanged (orthogonal). Steady-state memory is now bounded by the working set, capped
  at the ceiling.
- **Correctness holes closed (Phase B — audit gaps #4/#5/#6;–#36).**
  Three silent-wrong-answer bugs outside the well-tested crash paths:
  - **Stale reads after compaction (#4).** A long-lived reader (a Topology-B app server) pinned a segment's
    generation for its lifetime, so after a separate daemon compacted it served the prior generation
    indefinitely — a folded add read `false`, and an **erased id resurrected to `true`**. The cold source now
    re-resolves `currentGen` on a short TTL (`coldGenTtlMs`, default 2000 ms; lazy — checked on read, no timer)
    and the HOT cache is **generation-keyed**, so a reader converges to the new generation within the TTL. Reads
    are now **bounded eventually-consistent** — up to `coldGenTtlMs` of staleness after a compaction, then they
    converge; the hot path stays I/O-free within the window. Needs a `registry` (else the source pins as before,
    which suits single-process/local use).
  - **Compaction RECONCILE vs a concurrent publish (#5).** A `publishGeneration` / `bulkLoadCrbmGeneration`
    that advanced `currentGen` mid-compaction could have its generation deleted by RECONCILE — a silent
    whole-generation lost update. Compaction now re-reads `currentGen` under its lease and **aborts**
    (`reason: 'superseded'`) if it moved, so RECONCILE never deletes a just-published generation.
  - **`.crbm` format-field validation (#6).** `CrbmReader.open` now validates `element_width` /
    `roaring_serialization_id` / `container_codec` and throws `UnsupportedError` on a mismatch, so a future
    64-bit or re-codec'd generation can never be silently fed to the 32-bit deserializer. A 64-bit generation
    is a **major**-version bump (old readers auto-reject).
- **ESM import under Node** — the shipped package now imports cleanly in a native Node ESM project
  (`import { CloudRoaring } from 'cloud-roaring'`). The `roaring` native addon is CommonJS, and a _named_
  ESM import of it crashed Node's ESM loader (`SyntaxError: Named export 'DeserializationFormat' not found`);
  the core now takes those runtime values off `roaring`'s default export (Node maps a CJS module's
  `module.exports` to the ESM `default`). A `scripts/smoke.cjs` package smoke test — wired into CI and
  runnable via `pnpm smoke` — loads every published entry (`index`, `s3`, `dynamodb`) under **both** ESM and
  CJS and exercises the roaring-backed path, so this can't regress.

### Added

- **Export / eject your data — `store.exportSegments()` + the `export-segments` CLI**: dump every registered segment's
  current effective set to a portable file, using only public read APIs, so your data is readable **without
  CloudRoaring** (the exit path / a building block for a data-portability response). `format: 'roaring'` (default) writes one
  portable RoaringBitmap32 per segment (loadable by any roaring library in any language); `'ndjson'` writes
  newline-delimited ids (zero-dependency, streamed). Writes through an injected `ExportSink` (the store never
  imports `node:fs`); the `export-segments` CLI supplies a filesystem sink (atomic `.part`→rename) and writes a
  self-describing `manifest.json` last (its presence = the run **finished**; a crash leaves none → re-run into a
  fresh dir). Reuses the store's own registry (needs one, else `UnsupportedError`); folds in warm deltas; decrypts
  transparently if a keystore is wired (export is **cleartext**); skips crypto-shredded segments. **Fault
  isolation**: a segment that can't be read (corrupt cold object, or an encrypted segment with no keystore) is
  recorded in the manifest's `failed[]` and the export continues — one bad segment never blocks the rest (the CLI
  exits non-zero when any failed). **Warm-only escape hatch**: all-warm segments not yet in the registry can be
  named via the `candidates` option (CLI: `CR_EXPORT_SEGMENTS`), mirroring the compaction daemon's discovery
.

- **Store lifecycle methods reuse the store's own drivers** — `store.compact(ref, { owner })` (new), plus
  `store.eraseSubject(id, { owner })` and `store.subjectReport(id)` now build their compaction/erasure deps from
  the store's own cold/warm/registry, so you no longer re-pass a `registry` or a hand-assembled `CompactionDeps`.
  `compact`/`eraseSubject` require the store built with a raw cold driver + a `registry`; `subjectReport` needs
  only a `registry` (it just enumerates + `has()`) — all throw `UnsupportedError` when the store lacks what they
  need. The `compactSegment` / `destroySegment` / `bulkLoadCrbmGeneration` free functions remain for
  out-of-process daemons/CLIs. This also removes a footgun: the erasure ledger can no longer report a false purge
  from mismatched deps — the drivers are provably the store's own. `eraseSubject` isolates per-segment faults
  (records `physicallyPurged:false`, `note:'error: …'` and continues, so one segment can't discard the whole
  ledger) and validates `owner` before writing any tombstone.

- **Simpler wiring — one config shape (`cold` / `warm` / `registry` / `keystore`)**: the `CloudRoaring`
  constructor now accepts a **raw `IColdDriver`** as `cold` (`S3ColdDriver`, `LocalFsColdDriver`,
  `MemoryColdDriver`, …) and assembles the `.crbm` cold source for you, with `registry` / `keystore` /
  `requireEncryption` lifted to the same config object — so each driver is named **once** instead of being
  threaded through a hand-built `new CrbmColdChunkSource(cold, { registry, keystore })` wrapper. Passing an
  already-built `ColdChunkSource` still works unchanged (for a source-only backend like `MemoryColdChunkSource`,
  or a source you configured with advanced reader options like `tailBytes`/size caps), so no capability is lost.
  Fail-fast guards reject `registry`/`keystore`/`requireEncryption` paired with a pre-built source (configure
  them on the source), a keystore without a registry, and a `cold` that is nullish, ambiguous, or neither a
  driver nor a source. Wiring-time only — the hot path is untouched.

- **`S3RegistryDriver` — run the registry on S3, no DynamoDB** (`cloud-roaring/s3`): an `IRegistryDriver`
  backed by one tiny object per segment in the same bucket as your Cold data, using **S3 conditional writes**
  (`If-None-Match` for create, `If-Match` ETag for the atomic compare-and-swap; GA Nov 2024) instead of a
  server-side counter — so a **read-mostly deployment runs on S3 alone**. Same OCC + ABA-safe token (monotonic
  counter, tombstone-on-delete) as the other registries; passes the shared `registryConformance` suite in the
  unit lane (faithful fake S3) and against **MinIO** in the integration lane. Requires a backend that honors
  `If-Match`, `s3:ListBucket`, and no lifecycle-expiry on the `registry/` prefix (see the driver docs +
  getting-started §7). Also hardened both S3 drivers to treat a **`409 ConditionalRequestConflict`** (S3's
  other concurrent-conditional-write outcome, not just `412`) as a `WriteConflictError`
.

- **Phase 6c — legal hold (documented)**: the legal-hold posture is enforced via **S3 Object Lock** (a locked
  Cold object can't be deleted before its retention date — stronger than an in-library flag) plus excluding
  held segments from compaction/erasure; documented in `PRIVACY.md`. A native `legalHold` flag was
  deliberately not built (it would be advisory where Object Lock is enforced at rest, and wasn't cheap). This
  completes the lean **Phase 6 → milestone M4**.

- **Phase 6b — subject access & erasure (`subjectReport` / `eraseSubject`)**: two admin helpers on the store
  for GDPR Art. 15 / 17. `subjectReport(id, registry)` returns which **registered** segments an id is a member
  of; `eraseSubject(id, compaction, { owner })` writes a logical `remove` **and force-compacts** each affected
  segment on the spot — so the bit is physically gone from Cold on return, even for idle/archival segments
  organic compaction would never touch (the P13 fix) — and returns an **erasure ledger** (per-segment proof of
  deletion; return-value only, route it to your audit sink). Both scan registered segments (`O(registered
  segments)`, admin-only) — **no `id→segments` reverse index**, so nothing taxes the hot path. If a daemon
  holds a live lease, that segment's purge is deferred honestly (`physicallyPurged:false`); logical removal
  always holds. Per-subject crypto-shred is infeasible, so this is the single-subject route; whole-segment/
  tenant erasure remains `destroySegment`/`eraseNamespace`. See getting-started §13 + `PRIVACY.md`.

- **Phase 6a — `PRIVACY.md` (privacy & shared responsibility)**: a user-facing statement of the trust
  boundary (CloudRoaring is an embedded library, sends nothing to the authors, so *you* are the
  controller/processor and we are not a sub-processor), the honest erasure model (logical `remove` →
  scheduled-compaction physical purge → `destroySegment` crypto-shred, incl. the backups/WORM trap), the
  residency transfer surface, retention guidance, a shared-responsibility matrix, and a DPIA skeleton + Art. 30
  record template. Documents residency/classification/retention as integrator responsibilities rather than
  building policy-engine machinery (see Phase 6 plan).

- **Phase 5d — audit sink (security/compliance events)**: an optional, off-by-default `IAuditSink` — separate
  from the metrics sink — records the compliance-relevant state changes: `segment.publish` (a generation
  became current), `segment.compact` (a generation was committed), `segment.erase` (a genuine crypto-shred),
  and `namespace.erase` (with an honest `segmentsShredded` count). It's the natural feed for an append-only
  audit log / SIEM and a truthful GDPR Art. 30 erasure receipt — `segment.erase` fires only for a real key
  shred, never for a cleartext tombstone (bytes stay readable) or an idempotent re-run, and `segment.compact`
  fires at the durable commit so a purge fault can't drop it. Pass `audit` to `bulkLoadCrbmGeneration` /
  `compactSegment` / `runCompactionCycle` / `destroySegment` / `eraseNamespace`; the sink is exception-safe
  (a throwing sink never breaks the op) and vendor-neutral. Also hardens the compaction boundary
  (`owner`/`leaseMs` validated fail-fast). **KEK rotation is not emitted** — it's operator-side keystore
  reconfiguration with no library hook (see the [dashboards guide](docs/guide/dashboards.md) and). Completes **Phase 5 (M4)**.

- **Phase 5c — cheap `count()`**: `count()` now sums per-chunk cardinality straight from the `.crbm` index
  for warm-delta-free chunks — **zero payload reads or deserializes** — and merges only the chunks with
  pending Warm deltas. A fully-compacted (Topology-A steady-state) segment counts for free; this is now a
  build-breaking CI anchor (`count()` → 0 payload reads). Adds an optional `cardinalities()` to
  `ColdChunkSource` (the in-memory source omits it and falls back to fetch-and-merge — same answer, just not
  free); `has` / `iterate` / intersection are unchanged.

- **Phase 5c — benchmark-as-test + published crossover chart**: the verified economics are now
  **build-breaking CI assertions** ([`tests/bench/anchors.test.ts`](tests/bench/anchors.test.ts)) so a
  cost/perf regression or overclaim can't ship — chunk-skipping byte-savings (a 5%-overlap intersection
  fetches ≤ 10% of a full download, measured through the metrics sink), at-rest ≤ 10% of a Redis-HA node,
  the write crossover ≥ the published rate, and the estimator within **±20%** of the engine's measured
  backend cost (**K3**). Adds an offline, **zero-dependency** `pnpm bench` generator that draws the
  CloudRoaring-vs-flat-Redis crossover chart straight from the shipped `estimateCost()` (so it can't drift),
  published to `bench/crossover.svg`, `bench/results.json`, [`docs/benchmarks.md`](docs/benchmarks.md), and
  the [site](site/benchmarks.html). Wall-clock latency stays offline (too noisy to gate on shared CI
  runners). The `count()` → 0-payload-reads anchor + the enabling cheap-count optimization land next
.

- **Phase 5b — cost estimator**: a first-class cost API. **Planning:** pure
  `CloudRoaring.estimateCost({ segments, workload, topology, pricing? })` — size a workload with no instance
  or data. **Grounded:** `segment.costReport({ workload?, pricing?, topology? })` — storage cost from the
  segment's **real** `.crbm` size (exact, no payload reads), request cost from the supplied workload. Rates are
  a pluggable `PricingProfile` (default `aws-us-east-1-ondemand`, from the fact-checked research; set
  `wruPerMillion: 0` to model a flat/provisioned Warm tier). Every `CostReport` carries a `verdict`
  (`win-big` | `win` | `lose-zone` — never hides where flat Redis wins), the `redisCrossover` rates (matching
  the verified ~26 writes/s + ~329 reads/s), and `assumptions` (the grounded flag + the model's
  simplifications). Malformed inputs — workload rates, segment sizes, and pricing rates — are rejected
  fail-fast with `ValidationError` (a report is never silently `NaN`). Adds an optional `sizeOf()` to
  `ColdChunkSource` for grounded size from the index. New
  exports: `estimateCost`, `DEFAULT_PRICING`, `AWS_US_EAST_1_ONDEMAND`, and the `PricingProfile` /
  `CostReport` / `Workload` / `SegmentSizing` / `EstimateInput` / `Topology` / `SegmentSize` types. Deferred:
  whole-store aggregation + live-metrics-derived request cost.

- **Phase 5a — observability metrics sink**: an optional, injected `IMetricsSink` that receives typed
  `MetricEvent`s — cold GET (+ bytes + latency), warm read/write (+ bytes), cache hit/miss, OCC + transient
  retries, intersection fetched-vs-skipped chunks, and per-op latency. **Off by default** (a no-op sink;
  emission is skipped entirely when unused — a `metricsOn` fast-path, near-zero overhead); enable it with
  `new CloudRoaring({ warm, cold, metrics })`. The library emits **vendor-neutral
  events**, so you map the handful you care about to OpenTelemetry / Datadog / a log line in ~12 lines (a
  copy-paste OTel adapter is in the getting-started guide) — **no telemetry dependency is added to the
  library**. A buggy sink can never break a read/write (its exceptions are swallowed). Ships
  `CountingMetricsSink` (tallies events into a `MetricsSnapshot` — handy for tests and the upcoming grounded
  `costReport()`), `NOOP_METRICS`, and `safeMetrics`. New exports: `IMetricsSink`, `MetricEvent`,
  `MetricOpName`, `MetricsSnapshot`, `CountingMetricsSink`, `NOOP_METRICS`
.

- **Phase 4f — streaming / constant-memory compaction**: compaction now merges **and writes as a stream**, so
  the daemon streams the **cold** merge in constant memory — flat on the cold side (the dirty warm delta set is still buffered; a deferred fix) (the "runs in a 128 MB Lambda" property,
  now true for the write path too). `mergeChunksStream` yields one merged chunk at a time and
  `writeCrbmGenerationStream` feeds each to a streaming cold sink, freeing it. The **S3 cold driver uploads via
  multipart** (buffering ≤ one ~8 MiB part, flushed as the codec writes); a small object that fits one part is a
  single conditional `PutObject`, a larger one finishes with a conditional `CompleteMultipartUpload` — **both
  keep S3-enforced write-once** (a second writer → `WriteConflictError`, never a silent overwrite). In-flight
  uploads are aborted on error and SHA-256 is hashed incrementally; the S3 default object ceiling rises to the
  5 TiB multipart max (`partBytes` tunable). LocalFs already streamed to a temp file; the in-memory cold driver
  stays buffered (RAM by definition). Encryption composes unchanged.

- **Phase 4e — encryption-at-rest + crypto-shred**: opt-in **AES-256-GCM** encryption of the Cold `.crbm`
  objects (payloads **and** index, so a leaked object reveals neither ids nor cardinality), with **crypto-shred**
  erasure. Envelope model: a per-segment **DEK** is wrapped under one or more operator **KEKs** and stored in the
  registry; reads unwrap it, `destroySegment` / `eraseNamespace` delete it (the at-rest bytes are then
  permanently unrecoverable — GDPR erasure that works even on immutable/backed-up storage). Each ciphertext is
  AAD-bound to its `(namespace, segment, generation, chunkKey)` so it can't be relocated. **Key management is
  dependency-free by default**: an `InProcessKeystore` (BYOK — you supply 32-byte KEK(s)) using `node:crypto`;
  the `IKeystore`/`Aead` seams keep `core/` crypto-free and let KMS/Vault adapters drop in later. KEK rotation
  needs no data re-encryption (keyId-aware), and a DEK can be wrapped under an offline **recovery KEK** so losing
  the active KEK isn't fatal. Encryption is **store-level opt-in** (pass a keystore) with an optional
  `requireEncryption` guard; lose every KEK and a segment's at-rest data is gone by design (rebuild it from
  source). Threads through `bulkLoadCrbmGeneration`, `CrbmColdChunkSource`, and the compaction daemon (which
  reuses a segment's DEK across generations). New exports: `InProcessKeystore`, `NodeAead`, `destroySegment`,
  `eraseNamespace`, `aadFor`, `KeyUnavailableError`, and the `Aead`/`IKeystore`/`WrappedDek` types
.

- **Phase 4d — crash-safe compaction daemon**: consolidates accumulated Warm deltas into a fresh immutable
  Cold generation via a **2-phase commit** — `compactSegment()` (pin → merge `(cold ∪ adds) \ removes` → stage
  → verify chunk-keyset + cardinality → atomic `currentGen` swap → **version-fenced** Warm purge → orphan GC),
  merged chunk-by-chunk with working memory bounded by one segment's size. A write that lands mid-compaction is
  never lost (its newer OCC token fails the purge fence), and a crash at **any** step recovers cleanly (proven
  by a crash-at-every-step test sweep). A per-segment **lease** (registry `status` + owner/expiry, stealable on
  expiry) avoids duplicate work across multiple workers — though correctness never depends on it (concurrent
  compactions are safe); the lease is released even on an abnormal abort so a faulted segment isn't stuck
  `compacting`, and a per-segment fault is isolated so one bad segment can't abort the whole cycle. Concurrent
  **bootstrap** is no-data-loss: only the worker that actually writes generation 0 purges its Warm rows; an
  adopter leaves them for the next compaction. Readers self-heal if GC sweeps the exact generation they pinned
  mid-read (re-resolve to the current generation rather than fail — **no torn read**). Discovery
  (`findCompactable` / `runCompactionCycle`) scans the registry and drains Warm per segment (O(total warm)/cycle); the write path stays uncoupled from the registry. Ships the **`compact-segments` CLI** (`once` for Lambda/cron, `loop` for
  K8s/ECS) over the local-filesystem backend; cloud users call `runCompactionCycle` from their own handler.
  Also adds an in-memory `MemoryColdDriver`. (Crypto-shred-driven erase is Phase 4e.)

- **Phase 4c — segment registry**: an `IRegistryDriver` — the authoritative per-segment record holding the
  current generation (`currentGen`), discovery index, status, and a reserved wrapped-DEK slot — in three
  backends (`MemoryRegistryDriver`, `LocalFsRegistryDriver`, and `DynamoDbRegistryDriver` at the
  `cloud-roaring/dynamodb` subpath, co-located with warm rows in the single table). Reads can now resolve the
  current generation through the registry instead of a per-read **list-scan** of every generation: pass a
  `registry` to `CrbmColdChunkSource` (`new CrbmColdChunkSource(cold, { registry })`) — **optional**, with the
  list-scan kept as the fallback when absent. `bulkLoadCrbmGeneration(..., { registry })` publishes the new
  generation, and `publishGeneration(registry, key)` is the standalone, forward-only publish primitive. OCC,
  ABA-safety, and discovery all pass a shared `registryConformance` suite (vs in-memory, LocalFs, and
  DynamoDB-Local). Also: a `RetryingRegistryDriver` decorator, and a shared driver key-grammar helper
  (`_default` sentinel) extracted now that it has five consumers.

- **Phase 4b — resilience & fault-tolerance**: CloudRoaring now **rides through transient cloud faults**
  (throttling, 5xx, dropped connections, request timeouts) instead of surfacing them. A shared retry layer
  retries such faults with **bounded exponential backoff + full jitter** (default: 4 attempts; 50ms→100→200,
  capped at 2s),
  **on by default** for every warm/cold call — tune with the `retry` option or disable with `retry: false`.
  OCC conflict retries now back off too. **No data is ever lost or double-applied**: retries are idempotent
  (the OCC token detects a phantom-success; cold writes stay write-once), and the deterministic simulator now
  injects transient faults and proves effective-set equivalence holds under them. New public surface:
  `TransientError`/`TimeoutError`, `withRetry`, `RetryPolicy`, `DEFAULT_RETRY_POLICY`, and the
  `RetryingWarmDriver`/`RetryingColdChunkSource`/`RetryingColdDriver` decorators (driver authors can wrap
  their own). **Configure a request timeout on your injected S3/DynamoDB client** — timeouts are retried as
  transient (see the [getting-started guide](docs/guide/getting-started.md) §reliability).

- **Phase 4a — DynamoDB warm driver**:
  `DynamoDbWarmDriver` for the live warm tier, at the **`cloud-roaring/dynamodb`** subpath with
  `@aws-sdk/client-dynamodb` as an **optional peer dependency** (core's only runtime dep stays `roaring`).
  Real cross-process optimistic concurrency via DynamoDB conditional writes (a monotonic, ABA-safe counter);
  single-table layout; an optional `keyPrefix` lets several logical stores share one table. Inject your own
  `DynamoDBClient` (`new DynamoDbWarmDriver({ client, tableName })`). Passes the same warm-driver conformance
  suite as the in-memory and local-filesystem tiers.

- **Phase 3c — S3 cold driver**: `S3ColdDriver`
  for S3-compatible object storage (AWS S3 / MinIO), exposed at the **`cloud-roaring/s3`** subpath. Built on
  `@aws-sdk/client-s3` as an **optional peer dependency** — the core package's only runtime dependency stays
  `roaring`; you install the AWS SDK only if you use S3. Inject your own `S3Client`
  (`new S3ColdDriver({ client, bucket, prefix? })`); write-once via conditional `If-None-Match:*`. Passes the
  same cold-driver conformance suite as the in-memory and local-filesystem tiers.

- **Phase 3b — bulk-load**:
  `bulkLoadCrbmGeneration(driver, key, ids)` builds an immutable `.crbm` Cold generation from an arbitrary
  **unsorted** id stream (sync or async iterable) — the batch "seed/sweep" entry point. Folds ids into
  per-chunk Roaring bitmaps as they stream (input consumed lazily; deduped on insert), then writes chunks
  ascending. Returns `{ size, sha256, chunkCount, cardinality }`.

- **Phase 3a — chunk-skipping intersection engine**:
  `segment.intersect([...others])` and `intersectInto(dest, [...others])` — the crown jewel. Computes
  `A ∩ B ∩ …` by aligning the segments' chunk-key maps and fetching **only** the Cold chunks present in every
  operand (non-overlapping keys are never downloaded), streaming result ids ascending under a bounded
  in-flight window so it runs over huge segments in a small/serverless process. Tier-merging (warm adds +
  tombstones honored) and commutative.

- **Phase 2e — deterministic simulator**:
  a seeded scheduler (gating at driver-call boundaries) + fault-injecting fake drivers + a `Set`-oracle
  effective-set equivalence check, running the real engine under reproducible, replayable concurrency.
  Failures print a seed that reproduces the exact interleaving; a regression-seed corpus + seeded
  Warm-bytes fuzz round it out. Internal test infrastructure (not part of the published bundle).
  **Completes Phase 2 (M1, local end-to-end).**
- **Phase 2d — driver conformance suite**: shared
  `warmConformance` / `coldChunkSourceConformance` factories that every driver must pass, run against the
  in-memory **and** LocalFs drivers.
- **Phase 2c — Warm tier**: a persistent
  `LocalFsWarmDriver` with filesystem optimistic concurrency (monotonic counter token, ABA-safe tombstones,
  per-row lossless CAS chain). Engine writes survive a restart.
- **Phase 2b — Cold tier**: `IColdDriver` +
  `LocalFsColdDriver` (write-once via atomic `link`, symlink-hardened) + `CrbmColdChunkSource` bridging
  `.crbm` generations to the engine (generation-pinned). The engine now reads a persistent Cold tier.
- **Phase 2a — `.crbm` archive codec**: a streaming
  writer + speculative-tail-read reader for the on-disk Cold format — delta+varint footer index, per-chunk
  + index + footer CRC32C, version/flag gating, and a frozen golden-file corpus.
- **Phase 1 — in-memory core engine**: id routing,
  `SafeBitmap` (safe-deserialize + size cap over the `roaring` engine), the tombstone-aware chunk model +
  effective-set merge, a bounded LRU+TTL HOT cache, and the seven segment operations
  (`add`/`addMany`/`remove`/`removeMany`/`has`/`count`/`iterate`) over an OCC read-modify-write loop, with
  in-memory drivers and property tests against a `Set` oracle.
- **Phase 0 — Foundations**: repo scaffold
  (TypeScript strict, ESLint/Prettier, Vitest, CI, Husky, docker-compose), the 7 design specs, and the
  reserved npm name.
- **Public API exports:** `CloudRoaring`, `Segment`, the in-memory + LocalFs drivers, `CrbmColdChunkSource`,
  `writeCrbmGeneration`, `SafeBitmap`, the `.crbm` codec + blob seam, and the typed error classes.

<!-- The section above is the 0.1.0 release; new work goes under [Unreleased] at the top. -->
