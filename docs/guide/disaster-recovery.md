# Disaster recovery

How to back up CloudBitmaps and how to restore it **without silent data corruption**. The one thing that makes
DR here different from a single-database app: CloudBitmaps' state is spread across **independent stores**, and
they must come back at a **mutually consistent point** — or a read can serve a wrong answer long after the
restore "succeeded". This runbook covers what to back up, the restore procedure, and the built-in check that
catches a torn restore before it bites.

## Table of contents

- [The stores you must protect](#the-stores-you-must-protect)
- [Why coordination matters (the torn restore)](#why-coordination-matters-the-torn-restore)
- [The hard requirement: registry at-or-before cold](#the-hard-requirement-registry-at-or-before-cold)
- [RPO / RTO](#rpo--rto)
- [Backup checklist](#backup-checklist)
- [Restore procedure](#restore-procedure)
- [Operational caveat: no manual publish under active compaction](#operational-caveat-no-manual-publish-under-active-compaction)
- [`checkConsistency()` — verify before you serve traffic](#checkconsistency--verify-before-you-serve-traffic)
- [Encryption & DR](#encryption--dr)
- [What is *not* recoverable (and why that's correct)](#what-is-not-recoverable-and-why-thats-correct)
- [Deferred: self-healing rebuild from cold](#deferred-self-healing-rebuild-from-cold)

## The stores you must protect

A running CloudBitmaps is up to four independent, separately-backed-up systems:

```text
  ┌─────────────────┐   the newest writes — adds/removes deltas not yet compacted.
  │  WARM (NoSQL)   │   Freshest state ⇒ usually dominates your RPO.
  └─────────────────┘
  ┌─────────────────┐   generation-keyed, immutable .crbm objects (segment.<gen>.crbm).
  │  COLD (objects) │   Largest ⇒ usually dominates your RTO. Never overwritten in place.
  └─────────────────┘
  ┌─────────────────┐   per-segment pointer: which cold generation is current (currentGen).
  │  REGISTRY       │   Small, but the linchpin: it names which cold object each read trusts.
  └─────────────────┘
  ┌─────────────────┐   the wrapping keys (only if encryption-at-rest is on).
  │  KEYSTORE       │   Lose it and encrypted cold/warm bytes are unrecoverable — by design.
  └─────────────────┘
```

If any one of these is missing after a restore, you have not recovered. The registry and the keystore are tiny
and easy to forget — and losing either is as fatal as losing the object store.

## Why coordination matters (the torn restore)

Because the stores are independent, a restore can bring them back at **different points in time**. The dangerous
case is a **registry that is ahead of the object store**:

```text
  09:00  compaction commits segment "S" generation 42:
           1. PUT  cold/S.42.crbm         (object store)
           2. SET  registry[S].currentGen = 42   (registry)

  A backup taken between step 1 and step 2, or a restore where the registry
  snapshot is NEWER than the object-store snapshot, yields:

     registry[S].currentGen = 42   ──points at──▶   cold/S.42.crbm   ❌ NOT RESTORED

  Every read of S now tries to open a .crbm that isn't there. The restore
  "succeeded" (no errors at restore time) but S is broken until you notice.
```

This is the exact failure `checkConsistency()` detects (issue `missing-cold-generation`). The reverse — the
registry *behind* the object store (its `currentGen` names an older generation that still exists in cold) — is
**safe**: cold generations are immutable, so an older one is still a correct, if slightly stale, view. You lose
the compactions that happened after the registry's point, not correctness.

## The hard requirement: registry at-or-before cold

> **Restore the registry (and warm) to a point at or before the object-store restore point — never ahead.**

That single rule prevents the torn restore. It holds because cold generations are immutable and append-only:
every `currentGen` the registry named at time *T* referred to a `.crbm` that was already durable by *T*, so a
cold snapshot taken at *T* or later contains it. To make the rule achievable you need **point-in-time recovery on
the registry and warm stores**, coordinated with the object store's versioning:

- **Object store (cold):** enable **versioning** (S3 versioning / bucket-level object versioning). Immutable
  generations mean you rarely need to roll cold back at all.
- **Registry + warm:** if backed by DynamoDB, enable **PITR (point-in-time recovery)** — this is a
  **requirement, not a nice-to-have**, because it's the only way to pick a registry restore point that lines up
  at-or-before your cold point. If backed by the object store, use its versioning with a coordinated timestamp.
- Pick a **single target timestamp** for all three, then restore registry/warm to that timestamp and cold to
  that timestamp **or later**.

## RPO / RTO

CloudBitmaps imposes no fixed RPO/RTO — they fall out of how you back the stores. What its architecture tells you:

| | Driven by | Guidance |
|---|---|---|
| **RPO** (data you can lose) | the **freshest** store's backup lag — almost always **warm**, which holds un-compacted deltas | Continuous backup (DynamoDB PITR ≈ seconds) on warm keeps RPO small. Cold changes only at compaction; the registry only at compaction/admin — both are naturally less lossy. |
| **RTO** (time to recover) | restoring the **largest** store — almost always **cold** — plus the `checkConsistency()` sweep | Object-store restore dominates; the consistency check is `O(registered segments)` at bounded concurrency and is cheap next to it. Budget RTO ≈ cold-restore time + a consistency sweep. |

The practical takeaway: **warm sets your RPO, cold sets your RTO.** Back warm continuously; keep cold versioned.

## Backup checklist

- [ ] **Object store**: versioning enabled; lifecycle rules don't expire generations a live registry still points
      at (never expire the *current* generation of any live segment).
- [ ] **Object store**: an **`AbortIncompleteMultipartUpload`** lifecycle rule is configured (a few days is
      plenty). A large generation is written as a multipart upload, and a process that dies mid-write leaves the
      parts behind. The library aborts the upload on any error it survives to handle, but it cannot abort one
      whose process is gone — that is the case this rule exists for. Incomplete parts are **billed and invisible**:
      they do not appear in an object listing, so nothing but your bill reveals them.
- [ ] **Warm (NoSQL)**: continuous/PITR backups on (this store dominates RPO).
- [ ] **Registry**: PITR (DynamoDB) or versioning (object store) on — **required** to hit an at-or-before-cold
      restore point.
- [ ] **Keystore**: backed up and restorable **independently** of the data stores, with its own access controls
      (a data-store leak must not also leak keys). Losing it is unrecoverable.
- [ ] A written target: which timestamp/snapshot IDs constitute a coordinated restore point.

### Per-backend backup & PITR mechanisms

Which mechanism to enable depends on the tier you deployed. **The warm tier holds the freshest un-compacted
deltas, so it sets your RPO** — and for a Redis warm tier it is the *only* durable copy of recent writes until
compaction flushes them to cold. Back the warm tier accordingly: a mis-backed warm tier is silent, unbounded
data loss nothing else in this runbook will warn you about.

| Tier | Backend | Backup / PITR mechanism | RPO characteristic |
|---|---|---|---|
| Warm | DynamoDB | PITR (continuous) | ≈ seconds |
| Warm | PostgreSQL | WAL / continuous archiving → PITR | near-continuous (≈ WAL archive interval) |
| Warm | MySQL / MariaDB | binlog → PITR | near-continuous (≈ binlog flush/ship) |
| Warm | MongoDB | snapshot + oplog for point-in-time (or replica-set + backups) | ≈ oplog window |
| Warm | Cassandra / ScyllaDB | snapshots + commitlog archiving | ≈ commitlog archive interval |
| Warm | Redis | AOF (`appendonly`) **+** RDB snapshots | ≈ AOF fsync policy — see caveat below |
| Cold | S3 | versioning (+ optional Object Lock) | immutable generations (write-once) |
| Cold | GCS | object versioning | immutable generations (write-once) |
| Cold | Azure Blob | blob versioning + soft-delete | immutable generations (write-once) |

> **Redis warm tier — two non-negotiables.** (1) Enable **both** AOF (`appendonly yes`) and RDB snapshots — it is
> your only durable copy of un-compacted writes until they reach cold, so an RDB-only or unpersisted Redis loses
> recent writes on restart. (2) Run Redis with **`maxmemory-policy noeviction`**; under any evicting policy Redis
> silently drops warm chunks under memory pressure — data loss that happens *independent of your backups*, and
> that `checkConsistency()` cannot see.

All three cold backends store **write-once, immutable generations**, so the coherent restore point is
backend-agnostic: it is always **the registry at-or-before cold** (the invariant above). Likewise the **registry
you back up is your S3 or DynamoDB registry** — the seven Phase-7 warm/cold drivers are tier-only and do not
implement the registry, so your registry backup is unchanged no matter which warm or cold tier you run.

## Restore procedure

1. **Pick one target timestamp** `T` from your coordinated backups.
2. **Restore cold** to `T` (or later — cold being ahead is safe).
3. **Restore the registry and warm** to `T` (or earlier — never later than cold). Use PITR to hit `T`.
4. **Restore the keystore** (if encryption is on) — verify the keys the restored segments reference are present.
5. **Run `checkConsistency()`** (below) **before** serving traffic.
6. If it reports `inconsistent` segments, resolve them (restore the missing generations, or roll the registry
   back to a generation that exists — see below) and re-run until clean.
7. Only then route traffic. Optionally run a targeted `subjectReport`/read spot-check on a few known segments.

## Operational caveat: no manual publish under active compaction

Do **not** run a manual `publishGeneration` / `bulkLoadCrbmGeneration` against a segment while the compaction
daemon is compacting that same segment. Publish is **not lease-aware yet**: a manual publish landing inside the daemon's compaction sweep window
can strand or lose a generation — the same class of silent lost-update the consistency check below cannot detect.
Quiesce the daemon for the target segment (or the fleet) before any manual publish/bulk-load, then re-run
`checkConsistency()` afterward. This applies during a restore (steps 6–7 may involve manual `currentGen` rolls)
and in steady-state ops alike.

## `checkConsistency()` — verify before you serve traffic

The store exposes a post-restore health check that verifies **every registered segment's `currentGen` `.crbm`
actually exists in cold storage**:

```ts
const report = await store.checkConsistency();
// { checked: 1284, inconsistent: [], errored: [] }   ← healthy: every currentGen resolves to a real cold object

if (report.inconsistent.length > 0) {
  for (const i of report.inconsistent) {
    // { segment, namespace?, currentGen, issue: 'missing-cold-generation' }
    console.error(`torn: ${i.namespace ?? '_default'}/${i.segment} → gen ${i.currentGen} missing from cold`);
  }
  process.exit(1); // do not serve traffic
}
if (report.errored.length > 0) {
  // couldn't read these this pass — re-run once the object store is fully available; do not assume coherent
  console.warn(`${report.errored.length} segment(s) unreadable this pass — re-run when the store is up`);
}
```

- It needs a **raw cold driver + a `registry`** (the same requirement as compaction); a store built around a
  pre-wrapped `ColdChunkSource` throws `UnsupportedError` — run it from an admin/ops store wired with the raw
  drivers. The standalone `runConsistencyCheck({ cold, registry })` is available for out-of-process ops tooling.
- It fans out at a bounded `concurrency` (default 8; pass `{ concurrency }`), and can be scoped to one
  `{ namespace }`.
- **Fault-isolated + race-safe.** A segment whose Cold/registry can't be read this pass lands in `errored` and
  the scan continues (a partial/transient object store mid-restore is exactly when you run this) — treat an
  errored segment as *unknown*, not coherent, and re-run once the store is fully up. And each segment is checked
  against its authoritative **live** registry pointer (a strong per-segment read), not the enumeration snapshot,
  so a concurrent compaction that advanced the generation during the scan isn't misreported as a torn restore.
  (A full compaction+GC landing in the tiny per-segment read gap can still yield a transient false positive — run
  the scan quiesced, per the procedure above, or re-run to confirm any reported tear.)
- **Detection is driver-agnostic.** It relies only on `IColdDriver.list()` + `IRegistryDriver.get()`, so it
  covers **any** cold backend (S3 / GCS / Azure Blob) paired with **any** warm backend — nothing about the check
  is DynamoDB/S3-specific. What it verifies is **presence**: that each segment's `currentGen` `.crbm` object
  *exists* in cold. It therefore catches the torn / dangling-`currentGen` restore, but **not** a silent
  lost-update where a publish raced a compaction sweep and left `currentGen` pointing at a valid, present object
  whose content dropped a write (Case A). Avoiding a concurrent manual
  publish during compaction (see the caveat above) is the mitigation for that case — there is no post-hoc
  presence check that can see it.
- It is also worth running **periodically** (not just after a restore) as a cheap tripwire for backup/restore
  drift or an operator mistake.

**Resolving a `missing-cold-generation`:** either (a) restore the missing cold generation from a later
object-store snapshot that contains it, or (b) roll the registry's `currentGen` for that segment **back** to a
generation that does exist — accepting the loss of compactions after that point, but restoring correctness. Then
re-run `checkConsistency()`.

## This runbook is exercised, not just written

`pnpm dr-drill` (`tests/dr-drill.test.ts`, test-strategy T5) runs this procedure end-to-end against the real
on-disk `LocalFs` tiers — it seeds a fleet, takes a coordinated backup, then injects each failure and verifies
the resolution:

- **Torn restore** (registry recovered ahead of cold) and a **lost `.crbm`** are detected as
  `missing-cold-generation`, then cleared by rolling `currentGen` back (a) or restoring the object from backup (b).
- **Byte corruption inside a present `.crbm`** is the one case `checkConsistency()` **cannot** see — it verifies
  the generation is *present*, not its bytes. The drill confirms the sweep stays clean **and** that a read fails
  closed with `IntegrityError` (the per-chunk CRC), so the corruption surfaces at the trust boundary, not as a
  wrong answer. Spot-checking a read after restore (step 7) is what catches this class.

## Encryption & DR

If encryption-at-rest is on (§9 of [getting-started](getting-started.md)), the **keystore is a first-class DR
asset**: a `.crbm` cannot be decrypted from cold storage alone (the footer holds only an opaque `key_id`; the
wrapping key lives in the keystore). So:

- Back up and restore the keystore alongside the data stores, but keep its access path **separate** — the whole
  point of app-level encryption is that a cold-bucket leak doesn't hand over plaintext, and a shared backup that
  co-locates keys with ciphertext undoes that.
- After restore, confirm the keys referenced by restored segments are present. A missing key is unrecoverable
  ciphertext, not a torn restore — `checkConsistency()` verifies the *object* exists, not that you can decrypt it.

## What is *not* recoverable (and why that's correct)

- **Crypto-shredded subjects/segments stay gone.** Crypto-shred (`destroySegment` / `eraseNamespace`, §9) works by
  destroying the key. A restore of the data stores does **not** resurrect a shredded segment, and that is the
  correct, GDPR-durable behavior — an erasure that a backup restore could undo would be no erasure at all. Do not
  treat DR as a way to recover shredded data.
- **Writes newer than your freshest (warm) backup.** Bounded by your warm RPO — back warm continuously to
  minimize it.

## Deferred: self-healing rebuild from cold

A future capability — rebuilding a **lost** registry purely from surviving cold objects — is **not** shipped.
Today the registry is authoritative and must be restored from its own backup (hence the PITR requirement above).
Making cold objects self-describing enough to rebuild the registry (and to decrypt without the original keystore)
requires a `.crbm` **format change** — carrying a KEK-wrapped DEK in the footer — which the current fully-packed
104-byte footer has no room for, and which changes the crypto-shred model (shredding would then have to delete the
cold objects too, not just the key). It's documented as a planned additive evolution in
the `.crbm` format's reserved-for-future space, and tracked in
a known deferral; until it lands, **back up the registry and keystore** — they are not
reconstructable from cold alone.
