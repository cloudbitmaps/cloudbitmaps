# Disaster recovery

How to back up CloudBitmaps and how to restore it **without silent data corruption**. The one thing that makes
DR here different from a single-database app: CloudBitmaps' state is spread across **independent stores**, and
they must come back at a **mutually consistent point** — or a read can serve a wrong answer long after the
restore "succeeded". This runbook covers what to back up, the restore procedure, and the built-in check that
catches a torn restore before it bites.

## Table of contents

- [The stores you must protect](#the-stores-you-must-protect)
- [Why coordination matters (the torn restore)](#why-coordination-matters-the-torn-restore)
- [The hard requirement: registry at-or-before storage](#the-hard-requirement-registry-at-or-before-storage)
- [RPO / RTO](#rpo--rto)
- [Backup checklist](#backup-checklist)
- [Restore procedure](#restore-procedure)
- [Quiesce writers during a restore](#quiesce-writers-during-a-restore)
- [Readers pinned to a generation](#readers-pinned-to-a-generation)
- [Repair: an unstamped tombstone after a hard kill](#repair-an-unstamped-tombstone-after-a-hard-kill)
- [`checkConsistency()` — verify before you serve traffic](#checkconsistency--verify-before-you-serve-traffic)
- [Encryption & DR](#encryption--dr)
- [What is *not* recoverable (and why that's correct)](#what-is-not-recoverable-and-why-thats-correct)
- [Deferred: self-healing rebuild from storage](#deferred-self-healing-rebuild-from-storage)

## The stores you must protect

A running CloudBitmaps is up to three independent, separately-backed-up systems:

```text
  ┌─────────────────┐   generation-keyed, immutable .crbm objects (segment.<gen>.crbm).
  │  STORAGE        │   Every write is a new object; nothing is overwritten in place.
  └─────────────────┘   Largest ⇒ usually dominates your RTO.
  ┌─────────────────┐   per-segment row: which storage generation is current (currentGen),
  │  REGISTRY       │   plus wrapped keys and retention metadata. Small, but the linchpin:
  └─────────────────┘   it names which storage object each read trusts.
  ┌─────────────────┐   the wrapping keys (only if encryption-at-rest is on).
  │  KEYSTORE       │   Lose it and encrypted storage bytes are unrecoverable — by design.
  └─────────────────┘
```

There is no mutable tier. Data enters only as a **new generation** — a bulk load, an `*Into` materialisation,
a subject-erasure rewrite — written to storage first and then made current by advancing the registry pointer
forward-only. So the freshest state of a segment is always *one object plus one pointer*, and the two live in
different stores.

If any one of these is missing after a restore, you have not recovered. The registry and the keystore are tiny
and easy to forget — and losing either is as fatal as losing the object store.

## Why coordination matters (the torn restore)

Because the stores are independent, a restore can bring them back at **different points in time**. The dangerous
case is a **registry that is ahead of the object store**:

```text
  09:00  a load publishes segment "S" generation 42:
           1. PUT  storage/S.42.crbm              (object store; written, then verified)
           2. SET  registry[S].currentGen = 42    (registry; forward-only CAS)

  A backup taken between step 1 and step 2, or a restore where the registry
  snapshot is NEWER than the object-store snapshot, yields:

     registry[S].currentGen = 42   ──points at──▶   storage/S.42.crbm   ❌ NOT RESTORED

  Every read of S now tries to open a .crbm that isn't there. The restore
  "succeeded" (no errors at restore time) but S is broken until you notice.
```

This is the exact failure `checkConsistency()` detects (issue `missing-storage-generation`). The reverse — the
registry *behind* the object store (its `currentGen` names an older generation that still exists in storage) — is
**safe**: storage generations are immutable, so an older one is still a correct, if stale, view. You lose the
loads published after the registry's point, not correctness.

## The hard requirement: registry at-or-before storage

> **Restore the registry to a point at or before the object-store restore point — never ahead.**

That single rule prevents the torn restore. It holds because storage generations are immutable and write-once:
every `currentGen` the registry named at time *T* referred to a `.crbm` that was already durable by *T* (the
object is written and verified before the pointer moves), so a storage snapshot taken at *T* or later contains it.
To make the rule achievable you need **object versioning covering the `registry/` prefix**, and a restore
that is coordinated with storage — which is easier than it used to be, since both now live in the same bucket
and share one version history:

- **Storage (the object store):** enable **versioning** (S3 versioning / bucket-level object versioning). Immutable
  generations mean you rarely need to roll storage back at all.
- **Registry:** enable **versioning** on the bucket or container holding the `registry/` prefix — this is a
  **requirement, not a nice-to-have**, because it's the only way to pick a registry restore point that lines up
  at-or-before your storage point. The registry lives in the object store, so this is usually the same setting you
  just enabled for storage; confirm it covers the `registry/` prefix too.
- Pick a **single target timestamp** for both, then restore the registry to that timestamp and storage to that
  timestamp **or later**.

## RPO / RTO

CloudBitmaps imposes no fixed RPO/RTO — they fall out of how you back the stores. What its architecture tells you:

| | Driven by | Guidance |
|---|---|---|
| **RPO** (data you can lose) | the **registry's** backup lag. A load is durable the moment its pointer advance is, and a registry restored to *T* forgets every load published after *T* — their objects may still sit in storage, above the restored pointer, but no read sees them (see [what is not recoverable](#what-is-not-recoverable-and-why-thats-correct)). | Object versioning captures one version per row write, so your RPO is the gap between the last pointer advance and your restore point — not a fixed interval. Storage objects are versioned and write-once, so they are rarely the thing you lose. |
| **RTO** (time to recover) | restoring the **largest** store — almost always **storage** — plus the `checkConsistency()` sweep | Object-store restore dominates; the consistency check is `O(registered segments)` at bounded concurrency and is cheap next to it. Budget RTO ≈ storage-restore time + a consistency sweep. |

The practical takeaway: **the registry sets your RPO, storage sets your RTO.** Version both — one bucket
setting now covers them — and remember that the registry's version history is the thing that bounds how much
you can lose.

## Backup checklist

- [ ] **Object store**: versioning enabled; lifecycle rules don't expire generations a live registry still points
      at (never expire the *current* generation of any live segment — a rule on *noncurrent versions* is fine
      and is part of the erasure story in `PRIVACY.md`).
- [ ] **Object store**: an **`AbortIncompleteMultipartUpload`** lifecycle rule is configured (a few days is
      plenty). A large generation is written as a multipart upload, and a process that dies mid-write leaves the
      parts behind. The library aborts the upload on any error it survives to handle, but it cannot abort one
      whose process is gone — that is the case this rule exists for. Incomplete parts are **billed and invisible**:
      they do not appear in an object listing, so nothing but your bill reveals them.
- [ ] **Registry**: object versioning on, covering the `registry/` prefix — **required** to hit an
      at-or-before-storage restore point, and the store that sets your RPO.
- [ ] **Keystore**: backed up and restorable **independently** of the data stores, with its own access controls
      (a data-store leak must not also leak keys). Losing it is unrecoverable.
- [ ] A written target: which timestamp/snapshot IDs constitute a coordinated restore point.

### Per-backend backup & versioning mechanisms

Which mechanism to enable depends on the backends you deployed:

| Store | Backend | Backup mechanism | Characteristic |
|---|---|---|---|
| Registry | S3 | versioning | one version per row write — this is what sets your RPO |
| Registry | GCS | object versioning | one version per row write |
| Registry | Azure Blob | blob versioning + soft-delete | one version per row write |
| Storage | S3 | versioning (+ optional Object Lock) | immutable generations (write-once) |
| Storage | GCS | object versioning | immutable generations (write-once) |
| Storage | Azure Blob | blob versioning + soft-delete | immutable generations (write-once) |

All three storage backends store **write-once, immutable generations**, so the coherent restore point is
backend-agnostic: it is always **the registry at-or-before storage** (the invariant above). Every object store
hosts the registry too, so a single-cloud deployment backs up one account: turn on versioning and the registry
rows are recoverable exactly like storage objects, from the same snapshot, at the same timestamp — which is what
makes the coordinated restore point easy to hit rather than something you have to line up across two services.

## Restore procedure

1. **Pick one target timestamp** `T` from your coordinated backups.
2. **Quiesce writers** for the affected segments (below) — loads, `*Into` materialisations, `eraseSubject`, the
   retention sweep.
3. **Restore storage** to `T` (or later — storage being ahead is safe).
4. **Restore the registry** to `T` (or earlier — never later than storage). There is **no single
   restore-to-timestamp operation on an object store**, so this is a sweep, not a button: for every object
   under the `registry/` prefix, find the newest version whose timestamp is at-or-before `T` and copy it back
   to current. Script it — and note that a row created after `T` has no such version, so it should be deleted
   rather than left at its current value. Step 6 is what tells you the result is coherent.
5. **Restore the keystore** (if encryption is on) — verify the keys the restored segments reference are present.
6. **Run `checkConsistency()`** (below) **before** serving traffic.
7. If it reports `inconsistent` segments, resolve them (restore the missing generations, or roll the registry
   back to a generation that exists — see below) and re-run until clean.
8. **Restart long-lived readers** (see [pinned readers](#readers-pinned-to-a-generation)), then route traffic.
   Optionally run a targeted `subjectReport`/read spot-check on a few known segments.

## Quiesce writers during a restore

Writers are safe *against each other* without any coordination: a publish is a forward-only CAS, a
subject-erasure rewrite that loses the race reports `superseded` rather than clobbering the newer generation,
and a load that finds its generation number already taken gets a `WriteConflictError` (objects are
write-once). A writer racing a **restore** is a different matter. The consistency check reads each segment's
live pointer and then lists its objects, and a load followed by a GC of the superseded generation — or an
`eraseSubject`, which deletes its predecessor the moment its rewrite is current — landing in that gap yields a
transient false positive. And a manual `currentGen` roll (step 7) under a concurrent loader is a race you do not
need to think about if the loader is simply not running.

So: pause the calls for the duration. Nothing here is a daemon — a load, a materialisation, an erasure and the
sweep are all calls your own schedulers make — so "pause" means not invoking them, and there is no background
process to stop. If you cannot quiesce, re-run the scan to confirm a reported tear before acting on it.

## Readers pinned to a generation

A store that has resolved a segment keeps serving that generation for up to `storageGenTtlMs` (default 2 s) before
it re-reads the pointer, and decoded chunks sit in the hot LRU for as long as the cache keeps them. After a
restore or a manual `currentGen` roll, a long-lived process may therefore keep answering from the generation it
resolved *before* the restore for that window. Two cases need more than waiting: a store built **without a
clock**, or with **`storageGenTtlMs: 0`** ("pin forever"), holds its resolved generation for its own lifetime —
restart those readers as part of the procedure. A reader pinned to a generation that has since been **deleted**
(an `eraseSubject` collects its predecessor on return) re-resolves on its next read; that is the documented cost
of physical deletion on return, not a fault.

## Repair: an unstamped tombstone after a hard kill

The one failure in the retention path that does **not** self-heal, and the only one in this runbook that needs a
human. It costs nothing in steady state and is cheap to check for, so check for it after any hard kill of a
process that runs `retireExpired` (whatever scheduler you run it from).

**What happens.** Retiring an expired segment is two round trips, not one:

```text
  1. dropSegment(ref)          CAS the registry row → status: 'destroyed'   ← the retirement itself
  2. stampRetirement(ref)      CAS retention.retiredBySweepAt = now         ← the attribution
```

A `SIGKILL` — or a `terminationGracePeriodSeconds` that expires, or a node that vanishes — landing **between**
those two leaves a tombstone with no stamp. The in-process `catch` that would re-stamp it cannot run.

**Why the stamp is a separate write, and why we won't merge it.** The stamp is a *positive marker the sweep
writes on its own work*. The alternative — inferring "this tombstone was a retirement because the row is
`destroyed` and carries an expired policy" — is wrong in a way that matters: `destroySegment` never touches
`retention`, so the ordinary sequence *(set a 30-day policy → a GDPR request arrives mid-window →
`destroySegment`)* produces a **crypto-shred** tombstone carrying an expired policy. Auto-purging that row
destroys your local attestation for a right-to-erasure execution and un-fences the name for every writer. The
marker cannot be forged by that ordering; the inference can.

**Why nothing tells you.** The purge path reads the stamp and, finding none, does a bare `continue`:

```ts
const retiredAt = retirementStamp(rec.retention);
if (retiredAt === null) continue;   // not ours — a GDPR tombstone, or a manual drop
```

No ledger entry, no counter, no metric. `checkConsistency()` won't see it either — it skips `destroyed`
segments by design. **The symptom you will actually notice is downstream**, and it looks like something else:

| | What you see |
|---|---|
| **The name is fenced, permanently** | `publishGeneration` and `bulkLoadCrbmGeneration` **throw** on a `destroyed` row, and `eraseSubject` skips it. Re-loading that segment name never produces a readable generation — the load's object may land in the bucket, but nothing will ever point at it. |
| **The row and its objects are billed forever** | the sweep will not purge an unstamped tombstone, and nothing else in the library calls `gcOrphanGenerations` for a tombstone the sweep does not own — so any generations left behind (and any object a late load wrote) stay. |

### Detect

Use your own registry driver instance — the facade keeps it private on purpose, and this is an admin action, not
an API. `list()` carries `status` and `retention` in its projection, so this is one scan, no per-segment reads:

```ts
for await (const rec of registry.list(/* namespace? */)) {
  if (rec.status !== 'destroyed') continue;
  if (typeof rec.retention?.retiredBySweepAt === 'number') continue;   // a normal sweep retirement
  console.log(rec.namespace ?? '_default', rec.segment, rec.retention);
}
```

Every row this prints is an unstamped tombstone. **Most of them are legitimate** — a crypto-shred
(`destroySegment` / `eraseNamespace`) or a manual `dropSegment` is *supposed* to be unstamped and permanent.
Deciding which is which is the part that needs a person:

- **Check your audit sink** for a `segment.erase` / `namespace.erase` (a crypto-shred) or a `segment.dispose`
  outside any sweep window (a manual drop) for that segment. That is the reliable discriminator. An erasure
  event ⇒ leave the row alone; it is your attestation.
- An expired `retention.expiresAt` on the row is **not** sufficient evidence on its own — see the GDPR ordering
  above. Treat it as a hint that narrows the list, never as the answer.
- Correlate with the kill: an interrupted retirement is contemporaneous with the crash. `updatedAt` on the row
  is within seconds of it.

### Repair

Once you have established a row was an interrupted *retirement*, pick by whether the name must come back:

**(a) Let the sweep finish its job — the default.** Write the stamp the crash prevented. The next
`retireExpired` then treats the row as its own, waits out the grace window, verifies storage is actually empty,
collects any orphan generations itself, and deletes the row:

```ts
const rec = await registry.get(ref);
if (rec?.status === 'destroyed' && rec.retention?.retiredBySweepAt === undefined) {
  await registry.compareAndSwap(ref, rec.token, {
    retention: { ...rec.retention, retiredBySweepAt: Date.now() },
  });
}
```

Use the *original* retirement time if you have it from your logs rather than `Date.now()`; the value only
controls when the grace window elapses.

**(b) Return the name to service now.** Delete the row — but **only** after confirming storage holds nothing for
it. That precondition is not bureaucracy: deleting the row while storage objects remain strands them permanently
(`gcOrphanGenerations` reads the row to decide what to collect, and returns nothing when there is none).

```ts
for await (const k of storage.list(ref)) throw new Error(`storage not empty: generation ${k.generation}`);
await registry.delete(ref);
```

If storage is non-empty, re-run `dropSegment(ref, { confirmSegment: ref.segment })` first (it is idempotent and
re-sweeps storage, so it is how a residual in `generationsRemaining` is collected), then prefer **(a)** and let the
sweep reclaim it.

### Prevent

The window only opens on a kill that skips the graceful path, so close that path:

- **Give the sweep's process a termination grace period longer than a full cycle, plus margin** —
  `terminationGracePeriodSeconds` on Kubernetes, `stopTimeout` on ECS, the function timeout on Lambda. A cycle's
  length is knowable because you bound it: `limit` (default 100) caps the retirements per call, so size the
  grace period to the p99 of a `limit`-sized pass. Otherwise every deploy is a `SIGKILL`.
- **Make sure `SIGTERM` is actually delivered.** A shell-form `CMD` puts a shell at PID 1 that does not forward
  signals, so the container never receives it and *every* stop becomes a kill after the grace period. Use
  exec-form `CMD`, or an init that forwards.
- **Set a request timeout on the SDK client you inject.** There is no `AbortSignal` anywhere in this library —
  deliberately, since a homegrown timeout would abandon in-flight requests mid-write. The consequence is that a
  black-holed connection hangs a call indefinitely; without a client timeout, a stuck sweep eats its whole grace
  period and is then killed between the two writes above. This is the single highest-value thing you own.

An automated reconcile — one that pairs the audit trail against unstamped tombstones itself — is a recorded
deferral, not a shipped feature. Until it lands, this section is the procedure.

## `checkConsistency()` — verify before you serve traffic

The store exposes a post-restore health check that verifies **every registered segment's `currentGen` `.crbm`
actually exists in storage**:

```ts
const report = await store.checkConsistency();
// { checked: 1284, inconsistent: [], errored: [] }   ← healthy: every currentGen resolves to a real storage object

if (report.inconsistent.length > 0) {
  for (const i of report.inconsistent) {
    // { segment, namespace?, currentGen, issue: 'missing-storage-generation' }
    console.error(`torn: ${i.namespace ?? '_default'}/${i.segment} → gen ${i.currentGen} missing from storage`);
  }
  process.exit(1); // do not serve traffic
}
if (report.errored.length > 0) {
  // couldn't read these this pass — re-run once the object store is fully available; do not assume coherent
  console.warn(`${report.errored.length} segment(s) unreadable this pass — re-run when the store is up`);
}
```

- It needs a **raw storage driver + a `registry`** (the same requirement as every lifecycle helper); a store built
  around a pre-wrapped `StorageChunkSource` throws `UnsupportedError` — run it from an admin/ops store wired with
  the raw drivers. The standalone `runConsistencyCheck({ storage, registry })` is available for out-of-process ops
  tooling.
- It fans out at a bounded `concurrency` (default 8; pass `{ concurrency }`), and can be scoped to one
  `{ namespace }`. Like every fleet-wide scan it refuses past `maxScanSegments` rather than materialising a
  fleet it cannot hold.
- **Fault-isolated + race-safe.** A segment whose Storage/registry can't be read this pass lands in `errored` and
  the scan continues (a partial/transient object store mid-restore is exactly when you run this) — treat an
  errored segment as *unknown*, not coherent, and re-run once the store is fully up. And each segment is checked
  against its authoritative **live** registry pointer (a strong per-segment read), not the enumeration snapshot,
  so a concurrent load that advanced the pointer during the scan isn't misreported as a torn restore. (A load
  followed by a GC of the superseded generation — or an `eraseSubject`, which collects its predecessor
  immediately — landing in the tiny per-segment read gap can still yield a transient false positive: run the
  scan quiesced, per the procedure above, or re-run to confirm any reported tear.)
- **Detection is driver-agnostic.** It relies only on `IStorageDriver.list()` + `IRegistryDriver.get()`, so it
  covers **any** storage backend (S3 / GCS / Azure Blob) with **any** registry backend — nothing about the check is
  backend-specific. What it verifies is **presence**: that each segment's `currentGen` `.crbm` object
  *exists* in storage. It therefore catches the torn / dangling-`currentGen` restore, but **not**:
  - **byte corruption inside a present object** — the trust boundary catches that on read, failing closed with
    `IntegrityError` (the per-chunk CRC), which is what the read spot-check in the procedure is for;
  - **a pointer that is valid but older than you intended** — a registry restored earlier than storage is stale,
    not torn, and reads it as a correct older view;
  - **objects above the pointer** — loads that published after the registry's restore point. Harmless to reads
    and invisible to them; see [what is not recoverable](#what-is-not-recoverable-and-why-thats-correct).
- **A segment with no Storage generation is healthy, not torn.** A registry row whose `currentGen` is `null` says
  *this segment exists and has no Storage data yet* — a row minted by `setRetention` ahead of the first load, so the
  policy is recorded before the data. There is no generation that ought to exist, so nothing can be missing, and
  the scan reports it as consistent. (Reporting it would be worse than useless here: `missing-storage-generation`
  would fire on the healthy steady state of every such segment and bury the one signal a triage is looking for.)
- It is also worth running **periodically** (not just after a restore) as a cheap tripwire for backup/restore
  drift or an operator mistake — an object-store lifecycle rule that expired a current generation shows up here.

**Resolving a `missing-storage-generation`:** either (a) restore the missing storage generation from a later
object-store snapshot that contains it, or (b) roll the registry's `currentGen` for that segment **back** to a
generation that does exist — accepting the loss of the loads after that point, but restoring correctness. Then
re-run `checkConsistency()`.

Remedy (b) is a supported call rather than a manual registry edit:

```ts
await store.generations(ref);              // what is actually in the bucket, current one marked
await store.rollback(ref, 4);              // put the pointer on one that exists
await store.checkConsistency();            // confirm
```

`rollback` refuses rather than guessing: a generation not in the bucket throws and **names what is available**,
a crypto-shredded segment throws (every generation of it is unreadable), and a target *above* the pointer needs
an explicit `{ allowForward: true }` — above the pointer is where objects live that were never published, such
as a load that wrote its object and died before the publish. It deletes nothing, so the rollback is itself
reversible, and it is audited as `segment.rollback` because no other record of a backwards pointer move exists.

> **One thing to know before you roll back a segment a subject was erased from.** An erasure removes the id from
> the current generation and deletes the generation that held it, so it cannot be rolled back onto — an erasure
> performed *after* a rollback also reaches above the pointer and deletes the holder there. But a rollback is
> still the one operator action that changes which generations are reachable, so if a subject erasure ran
> against this segment between the target generation and now, **re-run `eraseSubject` afterwards** and keep both
> ledgers.

## This runbook is exercised, not just written

`pnpm dr-drill` (`tests/dr-drill.test.ts`) runs this procedure end-to-end against the on-disk `LocalFs` storage
and registry drivers — it seeds a fleet, takes a coordinated backup, then injects each failure and verifies the
resolution:

- **Torn restore** (registry recovered ahead of storage) and a **lost `.crbm`** are detected as
  `missing-storage-generation`, then cleared by rolling `currentGen` back (a) or restoring the object from backup (b).
- **Byte corruption inside a present `.crbm`** is the one case `checkConsistency()` **cannot** see — it verifies
  the generation is *present*, not its bytes. The drill confirms the sweep stays clean **and** that a read fails
  closed with `IntegrityError` (the per-chunk CRC), so the corruption surfaces at the trust boundary, not as a
  wrong answer. Spot-checking a read after restore (step 8) is what catches this class.

## Encryption & DR

If encryption-at-rest is on (see the encryption section of [getting-started](getting-started.md)), the
**keystore is a first-class DR asset**: a `.crbm` cannot be decrypted from storage alone (the footer holds
only an opaque `key_id`; the wrapping key lives in the keystore, and the wrapped per-segment DEKs live in the
registry row). So:

- Back up and restore the keystore alongside the data stores, but keep its access path **separate** — the whole
  point of app-level encryption is that a storage-bucket leak doesn't hand over plaintext, and a shared backup that
  co-locates keys with ciphertext undoes that.
- After restore, confirm the keys referenced by restored segments are present. A missing key is unrecoverable
  ciphertext, not a torn restore — `checkConsistency()` verifies the *object* exists, not that you can decrypt it.

## What is *not* recoverable (and why that's correct)

- **Crypto-shredded subjects/segments stay gone.** Crypto-shred (`destroySegment` / `eraseNamespace`) works by
  destroying the key. A restore of the data stores does **not** resurrect a shredded segment, and that is the
  correct, GDPR-durable behavior — an erasure that a backup restore could undo would be no erasure at all. Do not
  treat DR as a way to recover shredded data.
- **Erased subjects stay erased — from the current generation.** A subject-erasure rewrite deletes the object
  that held the bit; restoring an *older* registry point re-exposes whatever generation was current then. That
  is the same fact as the next bullet seen from the other side, and it is why `PRIVACY.md` says a rewrite does
  not reach backups: if your erasure posture must survive a restore, the segment has to be encrypted and the
  erasure a crypto-shred.
- **Loads published after the registry's restore point.** Their objects may still exist in storage, *above* the
  restored pointer. Reads never see them (the pointer is authoritative), `nextGeneration` skips past them, and
  `gcOrphanGenerations` never touches a generation at or above `currentGen` — so they sit there, billed, until
  you act. The safe recovery is to **re-run the load from your source**: it writes the next generation and
  supersedes the strays, which GC then collects. Do not hand-publish an object you cannot vouch for — a load that
  crashed mid-write can leave a partial object above the pointer, and `publishGeneration` will point at it if
  asked.

## Deferred: self-healing rebuild from storage

A future capability — rebuilding a **lost** registry purely from surviving storage objects — is **not** shipped.
Today the registry is authoritative and must be restored from its own version history (hence the versioning requirement above).
Making storage objects self-describing enough to rebuild the registry (and to decrypt without the original keystore)
requires a `.crbm` **format change** — carrying a KEK-wrapped DEK in the footer — which the current fully-packed
104-byte footer has no room for, and which changes the crypto-shred model (shredding would then have to delete the
storage objects too, not just the key). It's a planned additive evolution into the `.crbm` format's reserved-for-future space, and a known
deferral rather than an oversight; until it lands, **back up the registry and keystore** — they are not
reconstructable from storage alone.
