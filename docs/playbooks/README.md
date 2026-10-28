# Playbooks

Runnable, end-to-end walkthroughs for one job each, on invented data, ending in the limits and the errors you may see.

A guide explains a part of the library; a playbook walks one job from the first load to the last read. Every code block on
a playbook page is run by the repo's tests, in order, as one program against the package sources on `MemoryStorage`
(no network, no Docker, no build step), and the output shown under a block is what that run prints, compared exactly. A
change that breaks a page fails CI. The pages are also compiled under `strict` with the other documentation samples.

To follow one, install `@cloudbitmaps/roaring`, copy a page's blocks in order into one TypeScript file and run it with
your TypeScript runner as an ES module, which allows the top-level `await` the blocks use. Each page says what it does not claim: a playbook on
`MemoryStorage` shows what the calls do, not what a bucket costs or how long it takes. For that, see [the cost guide](../guide/cost.md) and [the benchmarks](../benchmarks.md).

| Playbook | What it does | What it uses | Size |
|---|---|---|---|
| [Sets of integers without a store: the standalone RoaringBitmap](roaring-bitmap.md) | Builds, combines, counts, serializes and loads sets of 32-bit ids in memory | `RoaringBitmap`, `deserialize`, `store.load` of a bitmap | M |
| [Audience segments from a warehouse, end to end](audience-segments.md) | Seeds segments from an export, refreshes them, composes and counts a campaign audience, pages through it to send | `store.load` with a guard, `intersect`, `union`, `andNot`, `exclude`, `materializeMany`, `pin`, `everyNth` | M |
| [Feature flags, rollouts and experiment cohorts by user set](feature-flags.md) | Checks a flag per request, flips it by a load, rolls out by percentage and expires an experiment | `has`, `unionInto`, a hash recipe, `setRetention`, `retireExpired` | M |
| [Dedup against what you have already processed, by day](dedup-seen-sets.md) | Drops ids a batch pipeline has seen, over a window of day buckets that expire | `andNot`, `unionInto`, `allowAbsentOperands`, `setRetention`, `retireExpired` | M |
| [Who may see what: permission sets per resource and group](permissions.md) | Checks access, revokes by a load, removes a person everywhere and shreds a tenant | `has`, `unionInto`, `pin`, `subjectReport`, `eraseSubject`, `eraseNamespace`, encryption | M |
| [Getting your ids into dense unsigned 32-bit integers](id-mapping.md) | Keeps a table that maps emails and UUIDs to small integers, assigns new ids without reuse and translates back for a send | `load`, `intersect`, `subjectReport`, `eraseSubject` | M |
| [Opt-outs, bounces and consent at send time](suppression.md) | Subtracts suppression lists from an audience, guards their refresh, pins them for a send and erases an opt-out that must be forgotten | `andNot`, `exclude`, `load` with a guard, `pin`, `pinnedAt`, `subjectReport`, `eraseSubject` | M |
| [A membership check in a long-running service](membership-service.md) | Opens segments at start, checks ids per request from the cache, follows new loads and holds a fixed point | `has`, `exists`, `stat`, `cache` options, `invalidate`, `pin` | M |
| [Privacy requests, end to end](privacy-requests.md) | Reports where an id is held, erases it, keeps the ledger and audit events and crypto-shreds a segment | `subjectReport`, `eraseSubject`, `destroySegment`, `RecordingAuditSink`, encryption | M |
| [The audience as it was on the send date](reproducible-audiences.md) | Records the generation a send read, reopens it while it is retained and rolls back a bad refresh | `load` with `keep`, `pin`, `pinAt`, `generations`, `rollback` | M |
| [Is this the right tool?](right-tool.md) | Names six places bitmaps live elsewhere, what to use instead and what the library still adds | none; links out | S |
| [A set per user: seen items and follows](per-user-sets.md) | Shows why a segment per user does not fit, keeps per-user bitmaps in a key-value store and in one process | `RoaringBitmap`, `serialize`, `deserialize` | M |
| [Counting an intersection, union or difference of stored segments](counting.md) | Counts a combine of stored segments five ways with today's calls, and says what each reads, holds and writes | `intersect` and `batches()`, `pin`, `RoaringBitmap` counts, `materializeMany` dry run, `intersectInto`, `unionInto` | L |
| [Moving a Redis bitmap or set workload to stored segments](redis-migration.md) | Draws the line between what moves and what stays in Redis, exports a bitmap and a set, loads them and checks the answers side by side | `load` with `sorted`, a guard, `has`, `count`, `intersect` | M |
| [Faceted filters: a segment per field and value](facets.md) | Names a segment per field and value, filters with AND across fields and OR within one, and counts each facet | `intersect`, `materializeMany` with expressions and a dry run, `segments`, namespaces | M |
| [Serverless intersection in AWS Lambda](lambda.md) | Builds a handler that intersects segments once per container, sizes the cache against the function's memory and states what is not measured | `intersect` with `after`, `cache` options, `S3Storage`, `errorKind` | M |
| [Funnels: what sets can answer and what they cannot](funnels.md) | Counts "did both" from step sets, shows order and time are out of reach and names what to use instead | `intersect`, `andNot`, `count`, `RoaringBitmap` | S |

More are planned: [the roadmap](../ROADMAP.md) lists them.
