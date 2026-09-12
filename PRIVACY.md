# Privacy, data protection & shared responsibility

> **Engineering guidance, not legal advice.** This document explains CloudBitmaps' data-handling posture and
> the controls it gives you, so you (and your privacy counsel / DPO) can place it correctly in your compliance
> program. Regulatory references (GDPR, CCPA/CPRA, HIPAA, …) are illustrative. Nothing here is a compliance
> certification — before deploying against personal data, get it reviewed by qualified counsel.

## TL;DR — the trust boundary

**CloudBitmaps is an embedded library.** It runs inside *your* process/function and talks to *your* storage
accounts (S3, DynamoDB, local disk — whatever drivers you wire). **It has no hosted backend and transmits no
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
| **Cold** (object store) | immutable `.crbm` generations — every generation a segment has had, until a superseded one is collected | the region of the bucket you wire |
| **Registry** (DynamoDB / S3 / local) | one row per segment: the current-generation pointer, wrapped keys, retention metadata — no IDs | the region of the table or bucket you wire |
| **HOT cache** (process RAM) | decoded chunks, bounded LRU | **wherever your process/Lambda runs** — an EU segment queried from a US function is processed in the US |
| **Loads and rewrites** (`bulkLoadCrbmGeneration`, the `*Into` verbs, `eraseSubject`) | read your source (or existing generations), write a new generation | run wherever you run them — a loader in one region writing to a bucket in another is a transfer |
| **Intersection** | pulls chunks from N segments into one process | co-locates those segments in one region |

**Guidance (not enforced by the library):** to keep EU data in EU infrastructure, wire region-local drivers
*and* run your loaders and erasure jobs in-region; keep a segment's Cold, registry, and the querying compute in
one jurisdiction; treat the HOT cache and the intersection runtime as **processing locations** in your transfer
assessment and breach scope (process RAM, and any heap/core dumps, hold personal data). A fail-closed
residency-enforcement policy in the library was considered and deferred as over-engineering for v1 — the honest
posture is "you wire it correctly," documented here.

## Erasure — what "delete" actually means

CloudBitmaps gives you three levers with different guarantees. Use them deliberately:

| Lever | API | Guarantee | Use for |
|---|---|---|---|
| **Subject erasure** | `store.eraseSubject(id, { namespace })` (or `eraseIdFromSegment(ref, id, deps)` for one segment) | *Physical on return* — the segment's current generation is rewritten without the id (every chunk streamed through, one bit cleared), published **fenced on the generation it streamed**, and **the generation that held the bit is deleted before the call returns**. A retained *superseded* generation still holding the id (an ex-member dropped by a re-seed) is found and collected too. The store that performs the call stops serving the id immediately; **other processes converge on their own read TTL** — see [One process, and the rest of your fleet](#one-process-and-the-rest-of-your-fleet). Does **not** reach backups, replicas or noncurrent object versions — those hold the old generation until their own lifecycle removes it. | "forget this person" — GDPR Art. 17 |
| **Dispose** | `store.dropSegment(ref, { confirmSegment })` | *Immediate* — the segment is tombstoned and its Cold generations deleted, reclaiming the storage. **Check `generationsRemaining`:** if it is non-empty the storage was *not* fully reclaimed and the drop should be re-run (a load that was already writing when the tombstone landed still finishes its object). Works on cleartext; on an encrypted segment it *also* discards the key. Does **not** reach noncurrent versions / replicas / PITR snapshots — deleting an object is weaker than destroying a key. | retiring a dated bucket; rolling-window retention |
| **Crypto-shred** | `destroySegment` / `eraseNamespace` | *Instant + total at rest* — destroys the segment's wrapped key, so **every** copy (current, prior generations, backups, WORM-locked objects) becomes unreadable without touching the bytes. Requires the segment to be encrypted. A process that had already opened the segment holds the **unwrapped** key in memory and keeps reading until it is told — call `store.invalidate(ref)` there; see [One process, and the rest of your fleet](#one-process-and-the-rest-of-your-fleet). | whole-segment / tenant offboarding; erasure under immutable backups (see below) |

**Subject-wide erasure** (GDPR Art. 17 — "forget this person everywhere") is
`store.eraseSubject(id, { namespace })` — or `{ allNamespaces: true }` to sweep every tenant deliberately. For
every **registered** segment the id is in, it rewrites the current generation without the id, publishes the
rewrite, and deletes the generation that held the bit — so the bit is physically gone from the bucket on
return, for idle and archival segments as much as busy ones. There is no logical-then-physical gap and no
scheduled step to wait for: an erasure *is* a new generation, the same shape as every other write in the library.
It reuses the store's own drivers (so build the store with a raw cold driver + a registry). It returns an
**erasure ledger** — one entry per segment the id was found in, `{ segment, namespace?, erased, fromGeneration,
generation, note? }` — as your proof of deletion; persist it or route it to your audit sink, which also receives
one `segment.rewrite { fromGeneration, generation }` event per rewrite when you pass `audit`. Segments the id is
not in are not listed. `store.subjectReport(id, { namespace })` answers the read side (Art. 15 — which segments
an id is in).

Two rules. **Do not load a segment while erasing from it**: a load that lands after the rewrite carries whatever
its source held, and the library cannot know that source was meant to exclude the id — fix the source first, or
quiesce loads of the affected segments for the duration. A writer that lands *during* the rewrite is caught and
the entry says `erased: false, note: 'superseded'` — either because the publish was refused **by that fence**, or
because a racing **erasure** (which collects with `keep: 0`) deleted the generation the rewrite was still
streaming. **Read the ledger**: an `erased: false` entry means *this run* did not erase the id from that segment,
which is not the same as the id still being present — if the racing writer was another erasure of the same id, it
is already gone. For `'superseded'` re-run `eraseSubject`: it is idempotent, it erases the id if the id is still
there, and a segment the id is no longer in is simply not listed. Because a settled segment drops out of the
ledger entirely, **the attestation for a subject is the ledger of the run that reported `erased: true`** — if you
must hold one artifact per request, re-run until no entry carries a `'superseded'` note, and keep that run's
ledger alongside any earlier one. An `error: …` note is an isolated per-segment fault; if it occurred *after* the
rewrite was published (a Cold `delete` fault), the pointer has already moved, so a re-run will not list the
segment — collect the residual with `gcOrphanGenerations(ref, { cold, registry }, { keep: 0 })`. That note is the
signal that a *published* rewrite's physical half did not complete, which is why it is reported rather than
swallowed.

### One process, and the rest of your fleet

Erasure and crypto-shred are **immediate in storage and immediate in the process that performed them**. They are
not immediate in *other* processes, and this library ships nothing that could make them so — there is no daemon,
no bus, and no connection between two stores that happen to point at the same bucket.

| | when the id stops being readable |
|---|---|
| storage | on return — the generation holding it is deleted, the DEK is destroyed |
| the store that performed the call | on return — it invalidates what it cached |
| another store, with a clock and a registry | within `coldGenTtlMs` (default 2 s), when its snapshot re-resolves |
| another store with **no clock**, or `coldGenTtlMs: 0` | **never**, until something tells it |

That last row is the one to design around. `coldGenTtlMs: 0` means "pin forever" and is a legitimate setting for
a read-only replica of immutable data — but a segment pinned that way does not observe a shred at all. If a
compliance deadline depends on every reader converging, fan the reference out to your fleet and have each
process call `store.invalidate(ref)`; that is the hook, and delivering it is yours because the transport is
yours.

A read served from a stale cache is bounded by the same window and answers from memory, so nothing on the
storage side — a bucket policy, a lifecycle rule, the object's own deletion — can shorten it.

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
handles segment/tenant-level erasure and is the only erasure that survives immutable backups / WORM. And a
**materialised segment** (`intersectInto` / `unionInto` / `andNotInto`) is a point-in-time snapshot of its
inputs: erasing a subject from a source does not touch a destination computed earlier — which is exactly why
`eraseSubject` scans *every* registered segment, destinations included, rather than erasing per source.

**Erasure vs. backups / WORM (the trap).** If you enable S3 versioning, Object Lock, or registry PITR for
durability, a subject-erasure rewrite *does not* reach the retained copies — the deleted bit survives in
noncurrent versions, locked objects, and backups. **Crypto-shred is the only erasure that survives all of
them**, because it destroys the key, not the bytes. So: use **per-segment/tenant encryption** as your erasure
posture under immutable storage; give noncurrent versions a short expiry (a lifecycle rule on *noncurrent*
versions is fine — it is *current* generations that a rule must never expire, see below); reserve S3 Object
Lock **COMPLIANCE** mode for data under a genuine legal hold (it *cannot* be deleted before its retention date,
by anyone — incompatible with on-demand erasure), and prefer **GOVERNANCE** mode where erasure must remain
possible.

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
  The registry row's `retention` is untouched by a load, an `*Into` materialisation or an erasure rewrite, so the
  `expiresAt` you set stays put across all of them.
- Surface segment age/size via the **metrics sink** so unbounded growth is visible, not silent.

**Be precise about what "drop the oldest" involves**, because the three levers differ in what they guarantee:

- **`store.dropSegment(ref, { confirmSegment })` is the retention primitive**, and `setRetention` +
  `retireExpired` is the policy-driven form that calls it — and its result must be inspected, not
  assumed: `generationsRemaining` non-empty means bytes survived and the call should be repeated. It tombstones
  the segment and deletes **every Cold generation** — so the storage is actually reclaimed. It works on a
  cleartext segment, and on an encrypted one it *also* discards the key, making it a strict superset there.
- **`destroySegment` crypto-shreds** — it discards the key, so the Cold bytes become unreadable *everywhere
  including backups, replicas and WORM-locked copies*, which no object deletion can achieve. But **the objects
  remain in your bucket** and you keep paying for them, and it **requires encryption at rest** (a cleartext
  segment has no key to discard; `allowCleartext` writes the tombstone while leaving the Cold bytes readable — and
  still in the bucket).
- **`gcOrphanGenerations`** deletes only *superseded* generations, never the current one — with `keep: 0` it is
  how a subject erasure removes the generation that held the bit.

So the two are complements, not alternatives: **`dropSegment` for "stop paying for it", `destroySegment` for
"it must be unreadable even in backups"** — and on an encrypted segment `dropSegment` gives you both at once.

> ⚠️ **Do not use an object-store lifecycle rule as your retention mechanism.** It deletes the bytes while the
> registry still points at them, which is the `missing-cold-generation` torn state — and it surfaces
> *intermittently*, because a read consults the in-process cache before Cold, so it passes testing on a warm
> process and starts failing after a restart. A lifecycle rule is a fine **backstop** for orphans left by a
> failed `dropSegment`, and a fine way to expire *noncurrent* object versions; give it a window comfortably
> longer than your retention and never let it touch a current generation. Earlier revisions of this document
> recommended it as the primary mechanism, which was wrong.

Full detail, including the dated-bucket pattern and the pitfalls, is in the retention section of the
[guide](docs/guide/getting-started.md).

## Legal hold

A litigation/regulatory hold *forbids* deletion — the opposite of erasure — and can apply to the same segment.
**Enforce a hold with S3 Object Lock**, which is the real, tamper-proof mechanism: in **COMPLIANCE** mode a
locked Cold object *cannot* be deleted before its retention date by anyone (not even the account root); in
**GOVERNANCE** mode a privileged role can override. To place a hold on a segment:

1. Enable **Object Lock** on the segment's Cold `.crbm` objects (and enable versioning) for the hold period.
2. **Exclude the segment from your erasure runs and your loads** — don't call `eraseSubject` in a scope that
   reaches it, `destroySegment`, **`dropSegment`**, or load a new generation onto a held segment, so the current
   generation (and its members) is preserved. Because `eraseSubject` scans a whole namespace, the practical
   shape is to keep held segments in a namespace of their own. **`dropSegment` matters most here**: it is the only
   call that deletes the bytes a hold exists to protect. In COMPLIANCE mode Object Lock will refuse the delete,
   so the drop reports the generation as not deleted rather than silently succeeding — but the tombstone is
   still written, so the segment reads as empty while the locked bytes remain. **Do not rely on Object Lock to be
   the guard**, and note how exclusion works today: `retireExpired` has **no exclusion predicate**, so a held
   segment must either *never carry a retention policy*, or have it removed with `clearRetention` for the
   duration of the hold and re-set afterwards. Recording the hold itself is free — any key other than
   `expiresAt` in the row's `retention` metadata is yours and survives both `setRetention` and
   `clearRetention`, so `{ legalHold: 'case-1234' }` is a durable marker; it is simply not yet something the
   sweep reads. (An `exclude` predicate is under consideration; say so on an issue if you need it.)
3. Decide hold-vs-erasure precedence when both apply to the same subject — that is a **legal determination**;
   under a hold, erasure is suspended.

CloudBitmaps deliberately does **not** ship a native `legalHold` flag: Object Lock is a stronger guarantee than
an in-library flag (which our own erasure and sweep could respect but a direct caller could bypass), so a flag
would be advisory where Object Lock is enforced at rest. If a real deployment needs a library-managed hold that
`eraseSubject` and `retireExpired` refuse to touch, it's a clean fast-follow — but the enforced posture is
Object Lock + operational exclusion, documented in this section.

## Audit & accountability (GDPR Art. 30 / Art. 5(2))

Wire the **audit sink** (`IAuditSink`) to get an append-only, vendor-neutral record of the compliance-relevant
state changes — `segment.publish` (a loaded generation became current), `segment.rewrite` (a subject-erasure
rewrite: `fromGeneration` → `generation`), `segment.erase` (a genuine crypto-shred), `segment.dispose` (a
`dropSegment`, including every retirement the sweep performs) and `namespace.erase` — for your audit log / SIEM.
It is off by default and exception-safe. See the [dashboards guide](docs/guide/dashboards.md), which also says
which event is the receipt for which claim. An erasure *ledger* — per-subject-request proof of physical deletion
— is returned by **`eraseSubject`**. `subjectReport` is the read side and returns only which segments an id is
in; it performs no deletion and issues no ledger.

**Log hygiene:** `segment` / `namespace` are *your* strings and may encode sensitive purpose; IDs are personal
data. The library never logs bitmap contents or raw IDs, but **you** should treat segment names and IDs as PII
in your own logs, error reporting, and metric/trace tags — hash or redact them, and prefer opaque/coded
segment names for sensitive segments (keeping the human label in your own classified registry).

## Shared-responsibility matrix

| Concern | CloudBitmaps provides | You (the integrator) must |
|---|---|---|
| **Controller/processor role** | an embedded library; sends nothing to us | be the controller/processor; run your own DPAs with *your* cloud providers |
| **Encryption at rest** | AES-256-GCM envelope encryption, BYOK keystore (`InProcessKeystore`), per-segment DEK + active/recovery KEK | hold and protect your keys (KMS/HSM); enable encryption for sensitive segments |
| **Erasure** | `eraseSubject` (per-id rewrite, physical on return), `dropSegment` (dispose), `destroySegment`/`eraseNamespace` (crypto-shred) | read the erasure ledger and re-run on `erased: false`; don't load a segment while erasing from it; choose crypto-shred under WORM/backups; classify what needs erasing |
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
3. **Data flow & residency** — Cold and registry regions, where compute (loaders, the HOT cache, intersection)
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
| Categories of processing | storage of set-membership; set intersection (incl. materialised results); loading of generations; caching |
| Categories of data subjects / data | your IDs' subjects; membership (possibly special-category) |
| Recipients | none external to your infrastructure (no sub-processor) |
| Transfers | any cross-region driver/compute topology *you* configure |
| Retention | your per-segment policy — `setRetention(ref, { expiresAt })`, enforced by a `retireExpired` sweep **you schedule** |
| Security measures | AES-256-GCM at rest, crypto-shred erasure, audit sink, your access controls |

---

**See also:** the [getting-started guide](docs/guide/getting-started.md) (its encryption/crypto-shred, metrics,
audit, and subject access & erasure sections) and the [dashboards guide](docs/guide/dashboards.md).
