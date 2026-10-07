# Privacy, data protection & shared responsibility

> This is the copy published with the npm package; it is kept identical in substance to
> [`PRIVACY.md`](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/PRIVACY.md) in the repository.


> **Engineering guidance, not legal advice.** This document explains CloudBitmaps' data-handling posture and
> the controls it gives you, so you (and your privacy counsel / DPO) can place it correctly in your compliance
> program. Regulatory references (GDPR, CCPA/CPRA, HIPAA, …) are illustrative. Nothing here is a compliance
> certification — before deploying against personal data, get it reviewed by qualified counsel.

## TL;DR — the trust boundary

**CloudBitmaps is an embedded library.** It runs inside *your* process/function and talks to *your* storage
accounts (S3, GCS, Azure Blob, local disk — whatever drivers you wire). **It has no hosted backend and transmits no
data to the authors or any third party** — there is no telemetry, no phone-home, no usage ping. The metrics
and audit sinks are local and off by default; they only go where *you* send them.

Consequently: **you are the data controller (and/or processor); CloudBitmaps is not a sub-processor.** There is
no SaaS relationship and no data-processing agreement to sign with us, because no data ever reaches us. What
the library gives you is a set of *mechanisms* — you own the *policy*.

## What CloudBitmaps processes — and why it's usually personal data

CloudBitmaps' job is to store, at scale, **the fact that an integer ID belongs to a named set**. The moment
that ID is (or can be linked to) a natural person — which is the intended use — that membership bit is
**personal data**. Often it is behavioural/inference data, and **membership alone can be special-category**:
a segment that means "pregnant", "in HIV outreach", "flagged for fraud", "likely-LGBTQ", or
"political-affiliation" makes the single bit `id ∈ segment` GDPR Art. 9 / CPRA sensitive data, needing an
explicit lawful basis and heightened safeguards.

**The library cannot see this.** It handles opaque integer IDs in named segments and applies uniform controls;
it has no way to know segment 7 is sensitive. **Classifying your segments is your responsibility** (see the
matrix below). If a segment holds special-category data, you should pair it with encryption (a keystore) and
an audit sink, and a short retention.

## Where the data lives — the transfer / residency surface

You choose every storage location by wiring the drivers, so **data residency is under your control — and your
responsibility.** The library never moves data to a region you didn't configure, but it also won't stop you
from constructing a cross-region topology. The points where personal data moves or is processed:

| Location | What's there | Residency note |
|---|---|---|
| **Storage** (object store) | immutable `.crbm` generations — every generation a segment has had, until a superseded one is collected. Azure Blob objects, and GCS objects above the simple-upload threshold, also carry a random write id in their metadata (`cbwid`): 128 random bits, no data from the bitmap or the source | the region of the bucket you wire |
| **Registry** (S3 / GCS / Azure Blob / local) | one row per segment: the current-generation pointer, wrapped keys, retention metadata, and the current generation's id count and your metadata (sealed when the segment is encrypted) — no IDs, unless you put one in the metadata, which you must not. An Azure Blob row also carries the random write id in its metadata | the region of the bucket you wire |
| **cache** (process RAM) | decoded chunks, and the stored chunk bytes (ciphertext on an encrypted segment) a reader keeps of a small generation it read whole; bounded LRU | **wherever your process/Lambda runs** — an EU segment queried from a US function is processed in the US |
| **Loads and rewrites** (`store.load()`, the `*Into` verbs, `eraseSubject`) | read your source (or existing generations), write a new generation | run wherever you run them — a loader in one region writing to a bucket in another is a transfer |
| **Intersection** | pulls chunks from N segments into one process | co-locates those segments in one region |

**Guidance (not enforced by the library):** to keep EU data in EU infrastructure, wire region-local drivers
*and* run your loaders and erasure jobs in-region; keep a segment's storage objects, its registry row, and the querying compute in
one jurisdiction; treat the cache and the intersection runtime as **processing locations** in your transfer
assessment and breach scope (process RAM, and any heap/core dumps, hold personal data). The library has no
fail-closed residency-enforcement policy; the posture is "you wire it correctly," documented here.

## Erasure — what "delete" actually means

CloudBitmaps gives you three levers with different guarantees. Use them deliberately:

| Lever | API | Guarantee | Use for |
|---|---|---|---|
| **Subject erasure** | `store.eraseSubject(id, { namespace })` | *Physical on return* — the segment's current generation is rewritten without the id (every chunk streamed through, one bit cleared), published **fenced on the generation it streamed**, and **the generation that held the bit is deleted before the call returns**. So is every other generation still holding the id: a retained *superseded* one (an ex-member dropped by a re-seed), and each one above the pointer after a `rollback` — generations a rollback can move the pointer onto again — while, when the current generation does not hold the id, the ones there that never held it stay as rollback targets (a rewrite is numbered above everything, so its `keep: 0` collection takes every older generation, above the pointer or below). Before it says `erased: true` the call lists the bucket and reads what is left, so **`erased: true` means no generation of the segment holds the id**, above the pointer or below it. `eraseSubject` reports a per-segment fault as an `error: …` ledger entry rather than throwing it, and a call that a racing writer overtook (a load, another erasure, or a rollback) as `erased: false, note: 'superseded'`, so "on return" is a claim about every segment whose entry says **`erased: true`** (a fault is an `error: …` entry, never `erased: true`). The store that performs the call stops serving the id immediately; **other processes converge on their own read TTL** — see [One process, and the rest of your fleet](#one-process-and-the-rest-of-your-fleet). Does **not** reach backups, replicas or noncurrent object versions — those hold the old generation until their own lifecycle removes it. It carries a generation's metadata over unchanged and does **not** scan it, so **never put a subject's id in metadata**. | "forget this person" — GDPR Art. 17 |
| **Dispose** | `store.dropSegment(ref, { confirmSegment })` | *Immediate* — the segment is tombstoned and its Storage generations deleted, reclaiming the space. **Check `generationsRemaining`:** if it is non-empty the space was *not* fully reclaimed and the drop should be re-run (a load that had read the segment before the tombstone landed, even one still consuming its ids, can write its object after the drop's sweep; it deletes that object itself once its publish is refused, and only one whose process stops in between, or whose publish fails without a definite answer (a lost response, a timeout), leaves it, for a re-run of the drop). Works on cleartext; on an encrypted segment it *also* crypto-shreds, on the terms in the next row. Does **not** reach noncurrent versions / replicas / PITR snapshots — deleting an object is weaker than removing a key. | retiring a dated bucket; rolling-window retention |
| **Crypto-shred** | `destroySegment` / `eraseNamespace` | *At rest, complete once no copy of the wrapped key survives* — removes the segment's wrapped DEK(s) from its registry row in one compare-and-swap, without touching the bytes or any KEK. **Every** copy of the objects (current, prior generations, backups, WORM-locked objects) is then unreadable once no retained copy of that row still holds the wrapped key — noncurrent object versions, backups and PITR copies of the row included — or once every KEK that wrapped it is destroyed. Until then, a retained copy of the row and a KEK that wrapped it decrypt the segment, and a registry restore to a point before the shred makes it readable again; see *Erasure vs. backups / WORM* below, and [an optional registry expiry rule](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/disaster-recovery.md#optional-make-a-shred-durable-with-a-registry-expiry-rule) that makes a shred durable after a set number of days. Requires the segment to be encrypted. A process that had already opened the segment holds the **unwrapped** key in memory and keeps reading until it is told — call `store.invalidate(ref)` there; see [One process, and the rest of your fleet](#one-process-and-the-rest-of-your-fleet). | whole-segment / tenant offboarding; erasure under immutable backups (see below) |

**Subject-wide erasure** (GDPR Art. 17 — "forget this person everywhere") is
`store.eraseSubject(id, { namespace })` — or `{ allNamespaces: true }` to sweep every tenant deliberately. For
every **registered** segment the id is in, it rewrites the current generation without the id, publishes the
rewrite, and deletes every generation that held the bit — the one it replaced, a retained superseded one, and
any above the pointer that a rollback left — so the bit is physically gone from the bucket on return, for idle
and archival segments as much as busy ones. It checks rather than assumes: before an entry says `erased: true`,
the call lists the segment's generations and reads each one it has not already seen without the id. There is no logical-then-physical gap and no
scheduled step to wait for: an erasure *is* a new generation, the same shape as every other write in the library.
It reuses the store's own drivers (so build the store with a backend). It returns an
**erasure ledger** — one entry per segment the id was found in, `{ segment, namespace?, erased, fromGeneration,
generation, note? }` — as your proof of deletion; persist it or route it to your audit sink, which also receives
one `segment.rewrite { fromGeneration, generation }` event per rewrite when you pass `audit` — an id found only
outside the current generation (a retained *superseded* one, or one above the pointer after a rollback) is
collected rather than rewritten, so it emits no event and its ledger entry carries no `generation`. Segments the id is
not in are not listed. `store.subjectReport(id, { namespace })` answers the read side (Art. 15 — which segments
an id is in).

Two rules. **Do not load a segment while erasing from it**: a load that lands after the rewrite carries whatever
its source held, and the library cannot know that source was meant to exclude the id — fix the source first, or
quiesce loads of the affected segments for the duration. A writer that lands *during* the rewrite is caught and
the entry says `erased: false, note: 'superseded'` — because the publish was refused **by that fence**, because
a racing **erasure** (which collects with `keep: 0`) deleted the generation the rewrite was still streaming, or
because an operator's `rollback` moved the pointer while the call was deleting generations above it. Two
erasures of different ids racing on one segment are safe: the loser's rewrite was derived from the generation the
winner replaced, so it still holds the winner's id, and when it sits above the winner's pointer the loser deletes
it before returning. **Read the ledger**: an `erased: false` entry means *this run* did not erase the id from that segment,
which is not the same as the id still being present — if the racing writer was another erasure of the same id, it
is already gone. For `'superseded'` re-run `eraseSubject`: it is idempotent, it erases the id if the id is still
there, and a segment the id is no longer in is simply not listed — though "not listed" alone does not prove the
id is gone, since a segment whose **registry row** has been purged is not scanned either and its objects outlive
it as orphans (`store.checkConsistency()` does not report them: it visits registry rows only). Because a settled segment drops out of the
ledger entirely, **the attestation for a subject is the ledger of the run that reported `erased: true`** — if you
must hold one artifact per request, re-run until no entry carries a `'superseded'` note, and keep that run's
ledger alongside any earlier one. An `error: …` note is an isolated per-segment fault, and it is reported rather
than swallowed because it can be the signal that a *published* rewrite's physical half did not complete **on that
call**. If it occurred *after* the rewrite was published — a Storage `delete` fault, a collection pass that
could not prove the segment was still the same one, or a generation still holding the id when the bucket is listed at the end, such as one an operator
rolled the pointer onto while the rewrite was collecting — then the pointer has already moved, and the re-run
searches every generation in the bucket, not only the current one. A transient fault on the publish itself is an `error: …` note too, and there the rewrite may or
may not have become current: the re-run settles it either way, rewriting the id out if the pointer did not move and
finding it in the generation the rewrite replaced if it did. (The collection-side errors just listed — a Storage `delete` fault, a pass that could not prove the segment was the
same one, a generation still holding the id — can also come from the collect-only path, where the bit was found
only outside the current generation and nothing was published; there the pointer has not moved, and a re-run
simply repeats the attempt.) **Read what the re-run says.** Usually it reports `erased: true` against the
generation it found the id in, which is the receipt the failed call could not give you. If a racing collector took
that generation first it reports nothing for the segment: the bit is gone, but no run holds a receipt for it, so
keep the failed call's error alongside your ledger. And if the segment's registry row has since been purged, it is
not a segment any more and `eraseSubject` does not scan it at all — anything left in its bucket is an **orphan**,
which neither `store.checkConsistency()` (it visits registry rows only) nor the collection a load and the retention
sweep run (it collects nothing without a row) reaches. List those objects with `store.generations(ref)` and delete them with
`store.dropSegment(ref, { confirmSegment: ref.segment })`, which leaves a tombstone row fencing the name. An empty
ledger is not by itself proof the id is gone.

**Do not roll a segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto a
generation the erasure did not rewrite, so the id can be current again. Roll back before the erasure starts or
after it returns, and re-run any erasure a rollback interrupted.

### A batch of materializations

A `store.materializeMany` call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's. An output of a `materializeMany` call can carry an id that was erased while the call ran, for as long as the call ran: the call reads each operand at the generation it pinned, and an output's publish is a load, so an erasure that lands after the chunks were read does not reach what the call holds, unless the output subtracts a pinned operand that the erasure rewrote, which the call re-reads just before the publishes and refuses. An erasure that rewrites a destination before that output's publish starts does not stop the publish, which, subject to the output's own `guard` and the refusal of an empty result over a non-empty destination, writes on top of the erasure's generation; an erasure that lands inside the publish's own write, between its pointer read and its pointer write, makes the publish lose with `WriteConflictError`; after any call that overlapped an erasure, re-run `eraseSubject` and keep both ledgers. `eraseSubject` deletes the generation it rewrites even when a call holds it pinned, so a pin does not outlive an erasure, and an output that still needs a deleted operand generation fails with `NotFoundError`.

A call with a feed reads operands the library never stores, which no erasure can reach, so the guarantee above does not describe it, and it is refused instead. A `materializeMany` call with a feed is refused at its next record, and immediately before each fed output's publish (after the output has waited for its room in the memory budget), once `eraseSubject` has started in this store: nothing is published from operands the call read before the erasure returned, and the one record in hand when the erasure lands is processed and discarded. The counter it reads is moved at the start and at the end of each `eraseSubject` this store runs, so an erasure that began and finished between two of the call's checks is seen too; `rollback`, `retireExpired` and `dropSegment` do not move it. An erasure that starts after a fed output's last check and finishes before that publish's pointer write is not caught by the counter, and its window is the publish's own object write and pointer write, which lasts as long as the object takes to upload; the fences above still apply to what it touched. Only this store's `eraseSubject` moves the counter such a call reads, so an erasure by any other path (another store, another process, or the free function `eraseIdFromSegment` in this process) is not seen by it, and is bounded by nothing. An id erased from the source of a feed has to be erased there: the library holds none of it.

### One process, and the rest of your fleet

Erasure and crypto-shred are **immediate in storage and immediate in the store whose verb performed them**, for
every read that starts after the verb returns. A read already in progress in that store can still yield an erased id
from a chunk it had requested before the verb ran: up to 32 chunks for `iterate` and `count`, and up to `concurrency`
keys (32 by default) for a combine. A combine or `iterate` reads ranges of the object, and resolves the segment again before it serves each chunk, as a read of that chunk alone does, so the ranges it had already requested are dropped, not served. They are not immediate in any *other* store, in the same process or another, and this library ships nothing that could
make them so — there is no daemon, no bus, and no connection between two stores that happen to point at the same
bucket.

| | when the id stops being readable |
|---|---|
| storage | on return — the generation holding it is deleted, or the wrapped DEK is removed from the segment's current registry row (a crypto-shred is complete once no retained copy of that row holds it, or every KEK that wrapped it is destroyed; see *Erasure vs. backups / WORM* below) |
| the store whose verb made the call (`eraseSubject`, `dropSegment`, `retireExpired`) | on return, for every read that starts after it — it invalidates what it cached, and its pins then fail; a read already in progress there can still yield it from a chunk it had requested before |
| another store, with a registry and a `cache.genTtlMs` above 0 | within `cache.genTtlMs` (default 2 s), when its snapshot re-resolves, **while the registry can be read** (see below) |
| another store with **no registry** (a bare `IStorageDriver`), with `cache: { genTtlMs: 0 }`, or on a storage source built with **no clock** | **no bound** — only when its caches happen to let the segment go, or something tells it |
| `seg.pinAt` of a generation the erasure rewrote, in any store | on return it fails with `NotFoundError`, since the object is deleted (and, with a registry, the row has moved on); during the erasure, between the rewrite's publish and its delete of the old generation, it can still open that generation, and a handle opened then is a pin, covered by the row below |
| a `materializeMany` call with a feed, and an erasure by any path but this store's `eraseSubject` | **no bound**: the call is refused only by this store's `eraseSubject` |
| a pinned handle (`seg.pin()`) in another store | **no bound** — until that store's reader cache evicts the pin's reader (in a store with a timed pointer refresh, a small generation's reader holds all of its chunks, decoded or not) and its chunk cache evicts the chunks the pin decoded, or something tells it |
| a leased pinned handle (`seg.pin({ leaseUntil })`) in another store | until its lease ends, at most 14 days after it was taken: its reads then throw `LeaseExpiredError`, whether or not its reader still holds the chunks. Until then, as for any pinned handle in the row above |

**An outage of the registry extends that bound.** A refresh that cannot read the row because of a transient fault
(throttling, a 5xx, a dropped connection) keeps serving the generation the reader already holds, and the key it
unwrapped, and asks again 500 ms later, or after `cache.genTtlMs` if that is shorter. So while the registry cannot
be read, a shred or a drop is not seen, and the store converges within one retry of the registry answering. Any
other failure of the refresh (an access denial, a row that will not parse) is not ridden out: the read that finds it
fails with that error, and the reader is dropped with the key it held.

`destroySegment` and `eraseNamespace` are free functions over raw drivers, not verbs of a store, so for them every
store is another store, one in the same process included.

The last two rows are the ones to design around. `cache: { genTtlMs: 0 }` turns the timed refresh off, and is a
legitimate setting for a read-only replica of immutable data — but a store set that way has no bound on when it
observes a shred: until its reader cache lets the segment go, it keeps decrypting with the key it already unwrapped.
A pinned handle is that case in any store, clock or none, and holds on longer: its reader keeps the key until the
reader cache evicts it, and after that the pin still answers `has()` for the ids in chunks it decoded, until the
chunk cache drops them. If a
compliance deadline depends on every reader converging, fan the reference out to your fleet and have each
process call `store.invalidate(ref)`; that is the hook, and delivering it is yours because the transport is
yours.

A read served from a stale cache is bounded by the same window and answers from memory, so nothing on the
storage side — a bucket policy, a lifecycle rule, the object's own deletion — can shorten it.

**A lease keeps superseded generations, and erasure ignores it.** A pinned handle taken with `pin({ leaseUntil })` keeps
its generation out of a load's collection until the lease ends: at most 14 days after it was taken, and a 60-second margin
after that. While it does, the bucket holds a generation that a newer load has superseded, including ids that load
removed. `eraseSubject`, `eraseIdFromSegment`, `dropSegment`, `destroySegment` and a retention expiry never read a lease:
they delete the generations they must, a leased one included, so a lease never holds an erased subject's data past the
bounds above, and erasure, shred, drop and retention always win over it. A rewrite, a shred and a drop clear the row's
leases; an erasure that deletes a generation without rewriting leaves an entry for it in the row, which spares nothing and
is pruned by the next publish or lease write after it ends. A lease write does not delay an erasure: a row that differs
from the one the erasure read only in its leases does not refuse it. What a lease holds against is an ordinary load's
collection, and the generation is collected by the next listing pass after the lease ends: within 16 later loads of the
segment, and a segment that is never loaded again keeps it until an erasure, a drop or a retention expiry takes it. A
leased handle stops answering when its lease ends, and its reads then throw `LeaseExpiredError`. The lease entry in the
registry row is a random holder id, a generation number and an instant, with no id and no count.

**Your exit path** (and a building block for a **data-portability / Art. 20** response): `store.exportSegments(sink,
{ format })` (and the `export-segments` CLI) dumps every registered segment's current generation to a portable
file — `roaring` (loadable by any roaring library) or `ndjson` (newline ids) — readable without CloudBitmaps.
It's a **controller-side bulk dump** (all segments, opaque ids), not a per-subject deliverable — the per-subject
rights are `subjectReport` (Art. 15) / `eraseSubject` (Art. 17). Encrypted segments are decrypted transparently
if the store has the keystore, so the **export is cleartext — protect it** (the CLI writes owner-only files;
also encrypt the dump at rest, restrict access, and delete it when done).

**Honest limits.** Subject erasure deletes the object that held the bit; it does not reach the copies of that
object your storage keeps on its own — noncurrent versions (S3 versioning), cross-region replicas, backups and
WORM-locked copies hold the old generation until their own lifecycle expires it. **Per-subject crypto-shred is
infeasible** (one DEK covers the whole segment, and a subject's bit is co-mingled with millions of others), so
single-subject erasure is a rewrite (`eraseSubject`), while crypto-shred (`destroySegment` / `eraseNamespace`)
handles segment/tenant-level erasure and is the only erasure that reaches immutable backups / WORM copies of the
objects — once no copy of the segment's registry row still holds its wrapped key, or every KEK that wrapped it
is destroyed (below). And a
**materialized segment** (`intersectInto` / `unionInto` / `andNotInto`) is a point-in-time snapshot of its
inputs: erasing a subject from a source does not touch a destination computed earlier — which is exactly why
`eraseSubject` scans *every* registered segment, destinations included, rather than erasing per source. What that
costs is one unit of the per-op `budget` for each segment, and one more for each generation it opens in a segment
whose current generation lacks the id (it searches every generation left in the bucket, since a retained one can
still hold the bit). A segment that runs the budget out is listed `erased: false` with an `error:` note, with
nothing of it deleted before the refusal (a segment that holds the id is rewritten first, and the last check
after it can be the one refused, which the same note reports); re-run with a higher `budget`.

**Erasure vs. backups / WORM (the trap).** If you enable S3 versioning, Object Lock, or registry PITR for
durability, a subject-erasure rewrite *does not* reach the retained copies — the deleted bit survives in
noncurrent versions, locked objects, and backups, and a restore that brings one of them back brings the erased id
back with it (the [disaster-recovery guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/disaster-recovery.md#restore-procedure) re-runs the
erasures made after the restore point). **Crypto-shred reaches the retained copies of the objects without touching
them**, because it removes the key, not the bytes — but it removes the key from one place: the segment's current
registry row. The same versioning, PITR and backups keep earlier copies of that row, and every copy written since
the segment's first encrypted load still holds the wrapped key. **A shred is complete once no retained copy of the
registry row still holds the wrapped key** (noncurrent object versions, backups and PITR copies included), **or
once every KEK that wrapped it is destroyed.** Until then, a retained copy of the row plus a KEK that wrapped it
decrypts the segment, and a registry restore to a point before the shred makes it readable again, which is why the
disaster-recovery guide re-shreds after a restore. Versioning on the registry prefix is a requirement of that
guide's restore procedure, so with it on, when a shred completes is set by how long your storage keeps the row's
noncurrent versions and backups — the same history a registry restore picks from — and an Object Lock default
retention on a bucket that also holds the registry locks those versions for that retention period. Destroying a
KEK happens in your keystore, not through the library, and a segment is shredded that way only once every KEK in
its wrappings is destroyed: with `InProcessKeystore`, the KEK that was active when the segment was first loaded
and, if one was configured, the recovery KEK, which wraps every segment's DEK a second time. Destroying those
shreds every segment they wrapped. So: use **per-segment/tenant encryption** as your erasure posture under
immutable objects, and count the registry row's retained copies in when you state that a shred is complete; give
noncurrent versions of the objects a short expiry (a lifecycle rule on *noncurrent* versions is fine — it is
*current* generations that a rule must never expire, see below — though it also bounds how far back the
disaster-recovery guide can restore); reserve S3 Object Lock **COMPLIANCE** mode for data under a genuine legal
hold (it *cannot* be deleted before its retention date, by anyone — incompatible with on-demand erasure), and
prefer **GOVERNANCE** mode where erasure must remain possible.

## Retention & data minimization

The library will age a **segment** out for you once you tell it when to — but it will not schedule that for you,
and it will never age out an individual **id** (a bitmap stores ids, not timestamps). "Cheap to keep forever" is a
storage-limitation anti-pattern if the data is personal, so: **the policy is yours to set, the heartbeat is yours
to run, and the deletion is ours to perform correctly.** Practical patterns:

- **A per-segment expiry** — `store.setRetention(ref, { expiresAt })` records when a segment becomes eligible for
  retirement, and `store.retireExpired()` retires every expired segment (through `dropSegment`, so the ordering
  and the storage reclamation below are inherited rather than reimplemented). The expiry is an absolute instant
  the writer sets; the sweep is a call **you** schedule (EventBridge, a CronJob, cron, a queue job), because this
  library starts no background timer. Bounded per cycle, previewable with `dryRun`, and it returns a per-segment
  ledger you should inspect — an entry can say a segment's storage was not fully reclaimed.
- **Rolling windows** (e.g. "active this week"): keep N daily sub-segments, union them for reads, and let the
  policy above retire the oldest wholesale — turning retention into cheap whole-segment disposal, not per-bit aging.
- **A reload is the per-id retention.** Since a segment's content is whatever its last load said, ageing members
  out *within* a segment is a matter of loading the next generation from a source that no longer includes them.
  The registry row's `retention` is untouched by a load, an `*Into` materialization or an erasure rewrite, so the
  `expiresAt` you set stays put across all of them.
- Surface segment age and size so unbounded growth is visible, not silent. The **metrics sink** carries neither (its `storage.get` events count the bytes of each read, not a segment's size).
  `seg.count()` gives a segment's cardinality; `seg.costReport()` prices its current generation's measured size
  (`monthlyUSD.byOp.storage`, $0 when the storage source cannot measure it), and does not count superseded
  generations still in the bucket, which `store.generations(ref)` lists; and its registry row carries `createdAt`
  and `updatedAt`, which the backend's `registry.list()` returns for every row.

**Be precise about what "drop the oldest" involves**, because the three levers differ in what they guarantee:

- **`store.dropSegment(ref, { confirmSegment })` is the retention primitive**, and `setRetention` +
  `retireExpired` is the policy-driven form that calls it — and its result must be inspected, not
  assumed: `generationsRemaining` non-empty means bytes survived and the call should be repeated. It tombstones
  the segment and deletes **every Storage generation** — so the space is actually reclaimed. It works on a
  cleartext segment, and on an encrypted one it *also* crypto-shreds, making it a strict superset there.
- **A deleted row keeps its record only where the registry cannot remove it.** Where the registry reports
  `conditionalDelete` (the default for S3 when its client sends to an AWS S3 host, for
  Azure Blob, the local filesystem and memory), `registry.delete` and the retention sweep's purge of a tombstone remove
  a row created by 0.12 from the bucket, and its token's random incarnation id keeps a re-create apart from it. Where it
  does not (an S3 client that sends to an S3-compatible store or an emulator, or a GCS client, by default, or
  `conditionalDelete: false`), and for a row written by a release before 0.12 on any backend, a delete writes a deleted marker that holds
  the record, so the row's token counter survives a re-create. A tombstone left by `dropSegment` or `destroySegment`
  holds no wrapped key and no summary, since both clear them, so a purge that leaves a tombstone keeps the name, the
  pointer, the retention policy and the timestamps. A **live** row deleted directly with `registry.delete` keeps its
  summary, the current generation's id count and your metadata, in a marker where one is written.
- **`destroySegment` crypto-shreds** — it removes the wrapped key from the registry row, so the Storage bytes
  become unreadable *everywhere including backups, replicas and WORM-locked copies* once no retained copy of that
  row still holds the key, or every KEK that wrapped it is destroyed (see the trap above), which no object
  deletion can achieve. But **the objects
  remain in your bucket** and you keep paying for them, and it **requires encryption at rest** (a cleartext
  segment has no key to discard; `allowCleartext` writes the tombstone while leaving the Storage bytes readable — and
  still in the bucket).
- **The collection a `load` runs** (its `keep` window; an `*Into` runs it when given `keep`) deletes only
  *superseded* generations, never the current one — with `keep: 0` it is what a subject erasure runs to remove the
  generations below the pointer that held the bit. A holder *above* the pointer
  is outside its range, so the erasure deletes that one itself.

So the two are complements, not alternatives: **`dropSegment` for "stop paying for it", `destroySegment` for
"it must be unreadable even in backups"** — and on an encrypted segment `dropSegment` gives you both at once.

> ⚠️ **Do not use an object-store lifecycle rule as your retention mechanism.** It deletes the bytes while the
> registry still points at them, which is the `missing-storage-generation` torn state — and it surfaces
> *intermittently*, because a read consults the in-process cache before Storage, so it passes testing on a warm
> process and starts failing after a restart. A lifecycle rule is a fine **backstop** for orphans left by a
> failed `dropSegment`, and a fine way to expire *noncurrent* object versions; give it a window comfortably
> longer than your retention and never let it touch a current generation.

> ⚠️ **Never let a lifecycle rule expire a registry row's current version, a tombstone, or a due-index pointer** —
> a separate trap, and a worse one. A rule cannot tell a live row from a tombstone, and an expired live row is a
> segment whose pointer is gone: its generations look unreferenced, and nothing reads or collects them. The library
> removes a row only by a delete the store applies to the exact version it judged, and only a row whose token
> carries a random incarnation id, so a name re-created later is told apart from it with overwhelming probability.
> A tombstone of a row written by a release before 0.12 carries the row's token counter on instead, and that counter
> is what keeps the name's tokens unique against a process still on that release. That token is the segment's
> **identity**: it is what a cached reader, a fenced publish and a generation-collection pass each compare to decide
> whether two observations describe the same segment. Re-issue one and they can all answer "yes" about a segment that
> no longer exists — serving a deleted incarnation's data, or collecting a live one's objects. A rule on
> *noncurrent* versions of the registry prefix touches neither the current row nor its tombstone; what it shortens is
> the history a registry restore picks from, and the time a crypto-shred takes to complete (above).

**What the registry keeps of a retired segment, and for how long.** A retirement by `retireExpired` leaves a
`destroyed` row: the segment's namespace and name, its `retention` and `residency` metadata (any keys of yours in
them included), its timestamps and its token. It holds no id, and on an encrypted segment no wrapped key, since the
drop shreds it. The due index holds a pointer to it whose name spells out the same namespace and name. Both stay
for `tombstoneGraceMs` (24 h by default) after the retirement, and for as long as the segment's storage cannot be
proven gone. Then the sweep's purge removes the row, and the pointers it read to it, from the bucket, where the registry
reports `conditionalDelete`: the default for S3 when its client sends to an AWS S3 host,
for Azure Blob, the local filesystem and memory. **A pointer can outlive its row**, and with it the name in its key: a
purge that ran with another `tombstoneGraceMs` than the sweep that filed the pointer, a delete that landed and lost its
response, a removal the registry refused (`purgeFaults` counts it), or a pointer older than an index scan's
`lookbackBuckets`. The next sweep that reads it removes it once its row is confirmed absent: an index scan from the days
it reads, and an unscoped fleet scan, one given no `namespace`, from every day. A deployment that scopes every sweep to a
namespace, or runs only index scans, keeps such a pointer until an unscoped fleet scan runs. Where the registry does not
report `conditionalDelete` (an S3 client that sends to an S3-compatible store or an emulator, or a GCS client, by default, or
`conditionalDelete: false`), and for a row written by a release before 0.12 on any backend, the purge leaves a tombstone
instead: every one of those fields, in the bucket, indefinitely, read by every full listing. A registry that does not
report it files no pointer to begin with. A removed
row stays recoverable wherever the storage keeps a copy of it: with object versioning on, its earlier versions stay until
a noncurrent-version rule expires them, as an overwritten row's do; with soft delete on, it stays for the retention
window (GCS: on by default for a new bucket, 7 days; Azure Blob: where enabled, for the days set), whatever the registry
did. A tombstone a hand-run `dropSegment` or a
crypto-shred left is never purged by the library.

Full detail, including the dated-bucket pattern and the pitfalls, is in the retention section of the
[retention guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/retention.md).

## Legal hold

A litigation/regulatory hold *forbids* deletion — the opposite of erasure — and can apply to the same segment.
**Enforce a hold with S3 Object Lock**, which is the real, tamper-proof mechanism: in **COMPLIANCE** mode a
locked Storage object *cannot* be deleted before its retention date by anyone (not even the account root); in
**GOVERNANCE** mode a privileged role can override. To place a hold on a segment:

1. Enable **Object Lock** on the segment's Storage `.crbm` objects (and enable versioning) for the hold period.
2. **Exclude the segment from your erasure runs and your loads** — don't call `eraseSubject` in a scope that
   reaches it, `destroySegment`, **`dropSegment`**, or load a new generation onto a held segment, so the current
   generation (and its members) is preserved. Because `eraseSubject` scans a whole namespace, the practical
   shape is to keep held segments in a namespace of their own. **`dropSegment` matters most here**: it is the only
   call that deletes the bytes a hold exists to protect. In COMPLIANCE mode Object Lock will refuse the delete,
   so the drop reports the generation as not deleted rather than silently succeeding — but the tombstone is
   still written, so the segment reads as empty while the locked bytes remain. **Do not rely on Object Lock to be
   the guard**, and note how exclusion works today: `retireExpired` has **no exclusion predicate**, so a held
   segment must either *never carry a retention policy*, or have it removed with `clearRetention` for the
   duration of the hold and re-set afterwards. Recording the hold itself is free — any key in the row's
   `retention` metadata other than `expiresAt` and `retiredBySweepAt` (the stamp the sweep puts on its own
   retirements, which marks a tombstone as one it may purge) is yours and survives both `setRetention` and
   `clearRetention`, so `{ legalHold: 'case-1234' }` is a durable marker; it is simply not yet something the
   sweep reads. `setRetention` writes only `expiresAt`, so write the marker yourself, with `compareAndSwap` on the
   backend's `registry`. (An `exclude` predicate is under consideration; say so on an issue if you need it.)
3. Decide hold-vs-erasure precedence when both apply to the same subject — that is a **legal determination**;
   under a hold, erasure is suspended.

CloudBitmaps deliberately does **not** ship a native `legalHold` flag: Object Lock is a stronger guarantee than
an in-library flag (which our own erasure and sweep could respect but a direct caller could bypass), so a flag
would be advisory where Object Lock is enforced at rest. If a real deployment needs a library-managed hold that
`eraseSubject` and `retireExpired` refuse to touch, it's a clean fast-follow — but the enforced posture is
Object Lock + operational exclusion, documented in this section.

## Audit & accountability (GDPR Art. 30 / Art. 5(2))

Wire the **audit sink** (`IAuditSink`) to get an append-only, vendor-neutral record of the compliance-relevant
state changes — `segment.publish` (a loaded generation became current), `segment.load-refused` (a load that did
not publish, because its guard refused it or another writer got there first), `segment.rollback` (an operator moved
the pointer to a generation it named), `segment.rewrite` (a subject-erasure
rewrite: `fromGeneration` → `generation`), `segment.erase` (a genuine crypto-shred), `segment.dispose` (a
`dropSegment`, including every retirement the sweep performs) and `namespace.erase` — for your audit log / SIEM.
It is off by default and exception-safe. See the [dashboards guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/dashboards.md), which also says
which event is the receipt for which claim. An erasure *ledger* — per-subject-request proof of physical deletion
— is returned by **`eraseSubject`**. `subjectReport` is the read side and returns only which segments an id is
in; it performs no deletion and issues no ledger.

**Log hygiene:** `segment` / `namespace` are *your* strings and may encode sensitive purpose; IDs are personal
data. The library never logs bitmap contents or raw IDs, but **you** should treat segment names and IDs as PII
in your own logs, error reporting, and metric/trace tags — hash or redact them, and prefer opaque/coded
segment names for sensitive segments (keeping the human label in your own classified registry). The name rules are deliberately permissive — any non-empty string — so a name can carry an email
address, free text, or anything else an upstream system hands you. That makes this advice stronger rather than
weaker: the library will store what you name, and will not sanitise it for you.

## Shared-responsibility matrix

| Concern | CloudBitmaps provides | You (the integrator) must |
|---|---|---|
| **Controller/processor role** | an embedded library; sends nothing to us | be the controller/processor; run your own DPAs with *your* cloud providers |
| **Encryption at rest** | AES-256-GCM envelope encryption, BYOK keystore (`InProcessKeystore`), per-segment DEK + active/recovery KEK | hold and protect your keys (KMS/HSM); enable encryption for sensitive segments |
| **Erasure** | `eraseSubject` (per-id rewrite, physical on return), `dropSegment` (dispose), `destroySegment`/`eraseNamespace` (crypto-shred) | read the erasure ledger and re-run on `erased: false`; don't load a segment while erasing from it; choose crypto-shred under WORM/backups, and count the registry row's retained copies in when a shred is complete; re-apply erasures after a restore; classify what needs erasing |
| **Residency** | region-agnostic drivers; you choose every location | wire region-correct drivers; run loaders and compute in-region; assess transfers |
| **Classification** | opaque handling; a place to keep sensitive segments encrypted + audited | classify your segments (the library can't infer sensitivity) |
| **Retention** | per-segment `expiresAt` + `retireExpired` (bounded, previewable, ledgered); rolling-window pattern | set the policy per segment; **schedule the sweep yourself** and alarm on its ledger |
| **Legal hold** | Object Lock guidance (the enforced mechanism; no in-library flag, and no sweep-level exclusion — see above) | place holds via Object Lock; keep a held segment out of the retention sweep by not giving it a policy, and out of `eraseSubject`'s scope; decide precedence |
| **Accountability** | `IAuditSink` (publish / rewrite / erase / dispose events) | route it to durable, append-only storage; keep your Art. 30 record |
| **Telemetry** | **none** — no phone-home | (nothing — there is nothing to disable) |

## DPIA skeleton (for deployments with sensitive segments)

A minimal Data-Protection-Impact-Assessment outline to adapt:

1. **Processing description** — which segments, what each membership *means*, source of the IDs, volume.
2. **Necessity & proportionality** — lawful basis per segment (esp. Art. 9 special-category); why membership
   is retained and for how long.
3. **Data flow & residency** — Storage and registry regions, where compute (loaders, the cache, intersection)
   runs, cross-border transfers and their safeguards.
4. **Risks** — re-identification, sensitive inference (incl. *derived* segments from intersections — treat a
   `paying ∩ pregnant` result as at least as sensitive as its inputs, and note it's a point-in-time snapshot
   that does not auto-honour later erasures of source members), breach scope (incl. process RAM / dumps).
5. **Controls** — encryption + crypto-shred, subject erasure that is physical on return (`eraseSubject`),
   retention windows, audit sink, access control on keys and storage, redaction of names/IDs in logs.
6. **Residual risk & sign-off** — DPO review.

## Art. 30 record — mapping template

Map CloudBitmaps' processing onto the categories a record of processing needs:

| Art. 30 field | CloudBitmaps mapping |
|---|---|
| Categories of processing | storage of set-membership; set intersection (incl. materialized results); loading of generations; caching |
| Categories of data subjects / data | your IDs' subjects; membership (possibly special-category) |
| Recipients | none external to your infrastructure (no sub-processor) |
| Transfers | any cross-region driver/compute topology *you* configure |
| Retention | your per-segment policy — `setRetention(ref, { expiresAt })`, enforced by a `retireExpired` sweep **you schedule** |
| Security measures | AES-256-GCM at rest, crypto-shred erasure, audit sink, your access controls |

---

**See also:** the [encryption](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/encryption.md), [observability](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/observability.md) (metrics and
audit) and [erasure](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/erasure.md) guides, and the [dashboards guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/dashboards.md).
