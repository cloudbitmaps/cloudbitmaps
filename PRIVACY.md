# Privacy, data protection & shared responsibility

> **Engineering guidance, not legal advice.** This document explains CloudRoaring's data-handling posture and
> the controls it gives you, so you (and your privacy counsel / DPO) can place it correctly in your compliance
> program. Regulatory references (GDPR, CCPA/CPRA, HIPAA, …) are illustrative. Nothing here is a compliance
> certification — before deploying against personal data, get it reviewed by qualified counsel.

## TL;DR — the trust boundary

**CloudRoaring is an embedded library.** It runs inside *your* process/function and talks to *your* storage
accounts (S3, DynamoDB, local disk — whatever drivers you wire). **It has no hosted backend and transmits no
data to the authors or any third party** — there is no telemetry, no phone-home, no usage ping. The metrics
and audit sinks are local and off by default; they only go where *you* send them.

Consequently: **you are the data controller (and/or processor); CloudRoaring is not a sub-processor.** There is
no SaaS relationship and no data-processing agreement to sign with us, because no data ever reaches us. What
the library gives you is a set of *mechanisms* — you own the *policy*.

## What CloudRoaring processes — and why it's usually personal data

CloudRoaring's job is to store, at scale, **the fact that an integer ID belongs to a named set**. The moment
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
| **Cold** (object store) | immutable `.crbm` generations | the region of the bucket you wire |
| **Warm** (NoSQL) | pending add/remove deltas | the region of the table you wire |
| **HOT cache** (process RAM) | decoded chunks, bounded LRU | **wherever your process/Lambda runs** — an EU segment queried from a US function is processed in the US |
| **Compaction** (daemon) | reads Cold+Warm, writes new Cold | runs wherever you run the daemon |
| **Intersection** | pulls chunks from N segments into one process | co-locates those segments in one region |

**Guidance (not enforced by the library):** to keep EU data in EU infrastructure, wire region-local drivers
*and* run the process/daemon in-region; keep a segment's Warm, Cold, and the querying compute in one
jurisdiction; treat the HOT cache and the intersection runtime as **processing locations** in your transfer
assessment and breach scope (process RAM, and any heap/core dumps, hold personal data). A fail-closed
residency-enforcement policy in the library was considered and deferred as over-engineering for v1 — the honest
posture is "you wire it correctly," documented here.

## Erasure — what "delete" actually means

CloudRoaring gives you three erasure levers with different guarantees. Use them deliberately:

| Lever | API | Guarantee | Use for |
|---|---|---|---|
| **Logical remove** | `segment.remove(id)` / `removeMany` | *Immediate* — reads exclude the ID at once (tombstone; `effective = (Cold ∪ adds) \ removes`). The bit **physically persists** in the immutable Cold `.crbm` until that chunk is next compacted. | everyday "take this user out of this audience" |
| **Physical purge** | `store.compact(ref, { owner })` on demand, or the compaction daemon (`compact-segments` / `runCompactionCycle`) on a schedule | A compaction folds the tombstone into a fresh generation and **physically drops** the bit. | meeting a physical-deletion deadline — *run compaction (the daemon on a schedule, or `store.compact` on demand) inside your SLA* |
| **Crypto-shred** | `destroySegment` / `eraseNamespace` | *Instant + total* — destroys the segment's wrapped key, so **every** copy (current, prior generations, backups, WORM-locked objects) becomes unreadable without touching the bytes. Requires the segment to be encrypted. | whole-segment / tenant offboarding; erasure under immutable backups (see below) |

**Subject-wide erasure** (GDPR Art. 17 — "forget this person everywhere") is `store.eraseSubject(id, { owner })`:
it removes the id from every **registered** segment it's in *and* force-compacts those segments on the spot, so
the bit is physically gone from Cold on return — even for idle/archival segments organic compaction would never
touch. It reuses the store's own drivers (so build the store with a raw cold driver + a registry). It returns an
**erasure ledger** (per-segment: removed / physically-purged / which generation retired the bit) as your proof
of deletion; persist it or route it to your audit sink. `store.subjectReport(id)` answers the read side (Art. 15
— which segments an id is in). Run erasure without concurrently re-adding the same id; any ledger entry with
`physicallyPurged:false` (a held compaction lease, or an isolated fault) needs a follow-up `store.compact(ref)` —
re-running `eraseSubject` won't re-purge it.

**Your exit path** (and a building block for a **data-portability / Art. 20** response): `store.exportSegments(sink,
{ format })` (and the `export-segments` CLI) dumps every registered segment's effective set to a portable file —
`roaring` (loadable by any roaring library) or `ndjson` (newline ids) — readable without CloudRoaring. It's a
**controller-side bulk dump** (all segments, opaque ids), not a per-subject deliverable — the per-subject rights
are `subjectReport` (Art. 15) / `eraseSubject` (Art. 17). Encrypted segments are decrypted transparently if the
store has the keystore, so the **export is cleartext — protect it** (the CLI writes owner-only files; also encrypt
the dump at rest, restrict access, and delete it when done).

**Honest limits.** Logical `remove()` is *not* physical deletion on its own — you need compaction (which
`eraseSubject` forces, or a scheduled daemon), or crypto-shred. **Per-subject crypto-shred is infeasible** (a
subject's bit is co-mingled with millions of others in one shared container), so single-subject erasure goes
through remove + compaction (`eraseSubject`), while crypto-shred (`destroySegment`/`eraseNamespace`) cleanly
handles segment/tenant-level erasure and is the only erasure that survives immutable backups / WORM.

**Erasure vs. backups / WORM (the trap).** If you enable S3 versioning, Object Lock, or DynamoDB PITR for
durability, a `remove()`+compaction *does not* reach the retained copies — the deleted bit survives in
noncurrent versions, locked objects, and backups. **Crypto-shred is the only erasure that survives all of
them**, because it destroys the key, not the bytes. So: use **per-segment/tenant encryption** as your erasure
posture under immutable storage; reserve S3 Object Lock **COMPLIANCE** mode for data under a genuine legal
hold (it *cannot* be deleted before its retention date, by anyone — incompatible with on-demand erasure), and
prefer **GOVERNANCE** mode where erasure must remain possible.

## Retention & data minimization

The library does not age data out for you — segments grow until you prune them, and "cheap to keep forever" is
a storage-limitation anti-pattern if the data is personal. **Retention policy is yours.** Practical patterns:

- **Rolling windows** (e.g. "active this week"): keep N daily sub-segments, union them for reads, and drop the
  oldest wholesale — turning retention into cheap whole-segment deletion (an object delete or crypto-shred),
  not per-bit aging.
- **Scheduled compaction** enforces any tombstones you've written for aged-out members within your window.
- Surface segment age/size via the **metrics sink** so unbounded growth is visible, not silent.

## Legal hold

A litigation/regulatory hold *forbids* deletion — the opposite of erasure — and can apply to the same segment.
**Enforce a hold with S3 Object Lock**, which is the real, tamper-proof mechanism: in **COMPLIANCE** mode a
locked Cold object *cannot* be deleted before its retention date by anyone (not even the account root); in
**GOVERNANCE** mode a privileged role can override. To place a hold on a segment:

1. Enable **Object Lock** on the segment's Cold `.crbm` objects (and enable versioning) for the hold period.
2. **Exclude the segment from your compaction and erasure runs** — don't call `eraseSubject`, `destroySegment`,
   or the compaction daemon against held segments, so the current generation (and its members) is preserved.
3. Decide hold-vs-erasure precedence when both apply to the same subject — that is a **legal determination**;
   under a hold, erasure is suspended.

CloudRoaring deliberately does **not** ship a native `legalHold` flag: Object Lock is a stronger guarantee than
an in-library flag (which our own daemon could respect but a direct caller could bypass), so a flag would be
advisory where Object Lock is enforced at rest. If a real deployment needs a library-managed hold that the
daemon refuses to purge, it's a clean fast-follow — but the enforced posture is Object Lock + operational
exclusion, documented here (P10).

## Audit & accountability (GDPR Art. 30 / Art. 5(2))

Wire the **audit sink** (`IAuditSink`) to get an append-only, vendor-neutral record of the compliance-relevant
state changes — `segment.publish`, `segment.compact`, `segment.erase` (a genuine crypto-shred), and
`namespace.erase` — for your audit log / SIEM. It is off by default and exception-safe. See the
[dashboards guide](docs/guide/dashboards.md). An erasure *ledger* — per-subject-request proof of physical
deletion — is returned by `subjectReport` / `eraseSubject` (shipped in Phase 6b).

**Log hygiene:** `segment` / `namespace` are *your* strings and may encode sensitive purpose; IDs are personal
data. The library never logs bitmap contents or raw IDs, but **you** should treat segment names and IDs as PII
in your own logs, error reporting, and metric/trace tags — hash or redact them, and prefer opaque/coded
segment names for sensitive segments (keeping the human label in your own classified registry).

## Shared-responsibility matrix

| Concern | CloudRoaring provides | You (the integrator) must |
|---|---|---|
| **Controller/processor role** | an embedded library; sends nothing to us | be the controller/processor; run your own DPAs with *your* cloud providers |
| **Encryption at rest** | AES-256-GCM envelope encryption, BYOK keystore (`InProcessKeystore`), per-segment DEK + active/recovery KEK | hold and protect your keys (KMS/HSM); enable encryption for sensitive segments |
| **Erasure** | `remove` (logical), compaction (physical), `destroySegment`/`eraseNamespace` (crypto-shred) | run compaction within your SLA; choose crypto-shred under WORM/backups; classify what needs erasing |
| **Residency** | region-agnostic drivers; you choose every location | wire region-correct drivers; run compute in-region; assess transfers |
| **Classification** | opaque handling; a place to keep sensitive segments encrypted + audited | classify your segments (the library can't infer sensitivity) |
| **Retention** | scheduled compaction; rolling-window pattern | set and enforce retention windows |
| **Legal hold** | Object Lock guidance (the enforced mechanism; no in-library flag) | place holds via Object Lock; exclude held segments from compaction/erasure; decide precedence |
| **Accountability** | `IAuditSink` (publish/compact/erase events) | route it to durable, append-only storage; keep your Art. 30 record |
| **Telemetry** | **none** — no phone-home | (nothing — there is nothing to disable) |

## DPIA skeleton (for deployments with sensitive segments)

A minimal Data-Protection-Impact-Assessment outline to adapt:

1. **Processing description** — which segments, what each membership *means*, source of the IDs, volume.
2. **Necessity & proportionality** — lawful basis per segment (esp. Art. 9 special-category); why membership
   is retained and for how long.
3. **Data flow & residency** — Warm/Cold regions, where compute (HOT cache, intersection) runs, cross-border
   transfers and their safeguards.
4. **Risks** — re-identification, sensitive inference (incl. *derived* segments from intersections — treat a
   `paying ∩ pregnant` result as at least as sensitive as its inputs, and note it's a point-in-time snapshot
   that does not auto-honour later erasures of source members), breach scope (incl. process RAM / dumps).
5. **Controls** — encryption + crypto-shred, erasure SLA (scheduled compaction), retention windows, audit
   sink, access control on keys and storage, redaction of names/IDs in logs.
6. **Residual risk & sign-off** — DPO review.

## Art. 30 record — mapping template

Map CloudRoaring's processing onto the categories a record of processing needs:

| Art. 30 field | CloudRoaring mapping |
|---|---|
| Categories of processing | storage of set-membership; set intersection; compaction; caching |
| Categories of data subjects / data | your IDs' subjects; membership (possibly special-category) |
| Recipients | none external to your infrastructure (no sub-processor) |
| Transfers | any cross-region driver/compute topology *you* configure |
| Retention | your per-segment policy (enforced via scheduled compaction / rolling windows) |
| Security measures | AES-256-GCM at rest, crypto-shred erasure, audit sink, your access controls |

---

**See also:** the [getting-started guide](docs/guide/getting-started.md) (§9 encryption/crypto-shred, §10
metrics, §12 audit) and the [dashboards guide](docs/guide/dashboards.md).
