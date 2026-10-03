# Disaster recovery

How to back up CloudBitmaps and how to restore it **without silent data corruption**. The one thing that makes
DR here different from a single-database app: CloudBitmaps' state is spread across **independent stores**, and
they must come back at a **mutually consistent point** — or a read can serve a wrong answer long after the
restore "succeeded". This runbook covers what to back up, the restore procedure, and the built-in check that
catches a torn restore before it bites.

## Table of contents

- [The stores you must protect](#the-stores-you-must-protect)
- [Why coordination matters (the torn restore)](#why-coordination-matters-the-torn-restore)
- [The hard requirement: one restore point for both stores](#the-hard-requirement-one-restore-point-for-both-stores)
- [RPO / RTO](#rpo--rto)
- [Backup checklist](#backup-checklist)
- [Restore procedure](#restore-procedure)
- [Quiesce writers during a restore](#quiesce-writers-during-a-restore)
- [Readers still on an old generation](#readers-still-on-an-old-generation)
- [Repair: an unstamped tombstone after a hard kill](#repair-an-unstamped-tombstone-after-a-hard-kill)
- [`checkConsistency()` — verify before you serve traffic](#checkconsistency--verify-before-you-serve-traffic)
- [A registry row the library did not write](#a-registry-row-the-library-did-not-write)
- [This runbook is exercised, not just written](#this-runbook-is-exercised-not-just-written)
- [Encryption & DR](#encryption--dr)
- [What a restore does and does not bring back](#what-a-restore-does-and-does-not-bring-back)
- [Not shipped: rebuilding the registry from storage](#not-shipped-rebuilding-the-registry-from-storage)

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

There is no mutable tier. Data enters only as a **new generation** — a bulk load, an `*Into` materialization,
a subject-erasure rewrite — written to storage first and then made current by moving the registry pointer with a
compare-and-swap on the segment's row. So the freshest state of a segment is always *one object plus one pointer*, and the two live in
different stores.

If any one of these is missing after a restore, you have not recovered. The registry and the keystore are tiny
and easy to forget — and losing either is as fatal as losing the object store.

## Why coordination matters (the torn restore)

Because the stores are independent, a restore can bring them back at **different points in time**, and any
difference can tear. The obvious case is a **registry that is ahead of the object store**:

```text
  09:00  a load publishes segment "S" generation 42:
           1. PUT  storage/S.42.crbm              (object store; committed whole, atomically)
           2. SET  registry[S].currentGen = 42    (registry; compare-and-swap on the row)

  A backup that copied storage before step 1 and the registry after step 2,
  or a restore where the registry snapshot is NEWER than the object-store
  snapshot, yields:

     registry[S].currentGen = 42   ──points at──▶   storage/S.42.crbm   ❌ NOT RESTORED

  Every read of S now tries to open a .crbm that isn't there, and fails with
  NotFoundError. The restore "succeeded" (no errors at restore time) but S is
  broken until you notice.
```

This is the exact failure `checkConsistency()` detects (issue `missing-storage-generation`). The reverse — storage
restored to a *later* point than the registry — tears the same way. Storage generations are immutable, but they
are not kept: a `load` collects, by default, the generations below its new pointer except
the newest one (`keep: 1`), a subject erasure collects every one below its rewrite (`keep: 0`), and `dropSegment`
deletes them all. Two loads after the registry's point are enough to delete the generation the restored registry
names.

## The hard requirement: one restore point for both stores

> **Restore the registry and storage to the same instant `T` — storage to `T` itself, with every object deleted
> since `T` brought back.**

That single rule prevents the torn restore. Every live row the registry held at `T` named a generation that
storage held at `T`, because an object is committed whole before any pointer names it (unless the fleet was
already torn at `T`, which `checkConsistency()` finds either way). At any other pair of
instants the two can disagree: after `T`, collection deletes generations a `T` registry names (above); before `T`,
storage lacks generations a `T` registry names.

Restoring storage to `T` means every object key that existed at `T` holds the version it held at `T`. For most
keys that means bringing back an object deleted since `T` (restore its noncurrent version, or remove the delete
marker over it). A key can also have been **written again**: once a segment's row is purged and its bucket
emptied, generation numbers restart at 0, so a name loaded anew after `T` re-writes keys that existed at `T` with
another incarnation's bytes. Put the `T` version back there too; `checkConsistency()` checks presence only, so it
would not notice the wrong bytes. Keys that did not exist at `T` can stay: they belong to loads after `T`, which sit
above the restored pointers (a name purged and loaded anew after `T` can also leave some below one, where the next
`load`'s collection takes them), or to segments with no row at `T`, which step 4 of the procedure deals with. Reads
through a backend never see either (a store built on a bare storage driver, `IStorageDriver`, instead of a backend is the exception; see
[readers still on an old generation](#readers-still-on-an-old-generation)).

**Bringing back a deleted object undoes the deletion.** When the object is a generation a subject erasure deleted
after `T`, the restored registry points at it again, and **the erased id is back**. The restore procedure therefore
re-runs every erasure made after `T` (step 8).

To make the rule achievable you need **object versioning covering both the storage objects and the `registry/`
prefix** — which one bucket makes easier, since both live in it and share one version history:

- **Storage (the object store):** enable **versioning** (S3 versioning, GCS object versioning, Azure blob
  versioning + soft delete). A generation is never overwritten in place, so what a restore to `T` writes back —
  objects deleted since `T`, and keys a re-created segment wrote again — exists only as noncurrent versions.
- **Registry:** enable **versioning** on the bucket or container holding the `registry/` prefix — this is a
  **requirement, not a nice-to-have**, because it's the only way to put every row back as it was at `T`. The
  registry lives in the object store, so this is usually the same setting you just enabled for storage; confirm it
  covers the `registry/` prefix too. Those versions also keep every wrapped key a crypto-shred removed from a row;
  see [Encryption & DR](#encryption--dr).
- Pick a **single target timestamp** `T`, and restore both stores to it. How far back `T` can go is bounded by how
  long each prefix keeps noncurrent versions: a lifecycle rule that expires them sooner also deletes what a restore
  to an earlier `T` needs.

## RPO / RTO

CloudBitmaps imposes no fixed RPO/RTO — they fall out of how you back the stores. What its architecture tells you:

| | Driven by | Guidance |
|---|---|---|
| **RPO** (data you can lose) | the **registry's** backup lag. A load is durable the moment its pointer advance is, and a registry restored to *T* forgets every load published after *T* — their objects may still sit in storage, above the restored pointer, but no read through a backend sees them (see [what a restore does and does not bring back](#what-a-restore-does-and-does-not-bring-back)). | Object versioning captures one version per row write, so your RPO is the gap between the last pointer advance and your restore point — not a fixed interval. A restore to *T* also needs every storage object deleted since *T*, so the oldest *T* you can choose is bounded by how long each prefix keeps noncurrent versions. |
| **RTO** (time to recover) | restoring the **largest** store — almost always **storage** — plus the `checkConsistency()` sweep | Object-store restore dominates; the consistency check is `O(registered segments)` at bounded concurrency and is cheap next to it. Budget RTO ≈ storage-restore time + a consistency sweep. |

The practical takeaway: **the registry sets your RPO, storage sets your RTO.** Version both — one bucket
setting covers them — and remember that the registry's version history is the thing that bounds how much
you can lose.

## Backup checklist

- [ ] **Object store**: versioning enabled; lifecycle rules don't expire generations a live registry still points
      at (never expire the *current* generation of any live segment). A rule on *noncurrent versions* deletes
      nothing a live row names, and is part of the erasure story in `PRIVACY.md`, but it also bounds how far back
      you can restore: a restore to `T` needs every object deleted since `T`.
- [ ] **Object store, S3**: an **`AbortIncompleteMultipartUpload`** lifecycle rule is configured (a few days is
      plenty). A large generation is written as a multipart upload, and a process that dies mid-write leaves the
      parts behind. The library aborts the upload on any error it survives to handle, but it cannot abort one
      whose process is gone — that is the case this rule exists for. Incomplete parts are **billed and invisible**:
      they do not appear in an object listing, so nothing but your bill reveals them.
- [ ] **Object store, the other backends**: know what a dead writer leaves. None of it is a generation — every
      backend commits an object whole or not at all, so no listing, read or restore ever sees a partial one.
  - **GCS**: a generation above the backend's threshold (8 MiB by default) is a resumable upload. One its process
    abandons never becomes an object (only a completed upload appears in the bucket), and GCS ends the session a
    week after it started.
  - **Azure Blob**: a generation above one block (8 MiB by default) is staged as blocks and committed as one block
    list. Azure has no call to discard staged blocks, so they stay after any failed write, dead process or not,
    until Azure garbage-collects uncommitted blocks, a week after the last one staged for that blob.
  - **`LocalFsStorage`**: an object is written to a temporary file beside it
    (`<segment>.<generation>.crbm.<uuid>.tmp`) and linked into place. A killed process leaves that file; a listing
    ignores it and nothing in the library deletes it, so remove stale `.tmp` files yourself.
- [ ] **Registry**: object versioning on, covering the `registry/` prefix — **required** to restore every row to
      `T`, and the store that sets your RPO. It also keeps the wrapped keys a crypto-shred removes from a row; see
      [Encryption & DR](#encryption--dr).
- [ ] **Keystore**: backed up and restorable **independently** of the data stores, with its own access controls
      (a data-store leak must not also leak keys). Losing it is unrecoverable.
- [ ] **Audit sink and erasure records**: an `audit` sink passed to every erasure and disposal call
      (`eraseSubject`, `dropSegment`, `retireExpired`, `destroySegment`, `eraseNamespace`) and to `rollback`, writing
      somewhere this restore does not roll back, plus your own record of each subject id you erased. A restore to
      `T` undoes every erasure made after `T`, and step 8 of the procedure re-applies them from these records. The
      events carry no subject id and no time of their own, only what your sink stamps on them.
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
backend-agnostic: it is always **both stores at the same instant** (the requirement above). Every object store
hosts the registry too, so a single-cloud deployment backs up one account: turn on versioning and the registry
rows are recoverable exactly like storage objects, from the same snapshot, at the same timestamp — which is what
makes the coordinated restore point easy to hit rather than something you have to line up across two services.

## Restore procedure

1. **Pick one target timestamp** `T` from your coordinated backups.
2. **Quiesce writers** for the affected segments (below) — loads, `*Into` materializations, `eraseSubject`, the
   retention sweep.
3. **Restore storage** to `T` itself — not later: collection since `T` has deleted generations the restored
   registry names. For every storage key whose current version is not the one it held at `T` — deleted since `T`,
   or deleted and written again by a segment re-created under the same name — put the `T` version back (restore the
   noncurrent version, or remove the delete marker over it), and only those. Keys that did not exist at `T` can
   stay.
4. **Restore the registry** to `T`. There is **no single restore-to-timestamp operation on an object store**, so
   this is a sweep, not a button: for every object under the `registry/` prefix (`<prefix>registry/` on a backend
   built with a `prefix`) whose current version is newer than `T`, find the newest version at or before `T` and
   copy it back to current. Script it. Copy versions back rather than writing a row's body yourself: the registry
   refuses a row it did not write, and one such row stops every listing that reaches it (see
   [a registry row the library did not write](#a-registry-row-the-library-did-not-write)). A row created after `T`
   has no such version; the row's body names its `namespace` and `segment`. If you do not want that segment's
   objects, first run `store.dropSegment(ref, { confirmSegment: ref.segment, audit })`, which deletes them and
   removes the wrapped key from the row. Then remove the row with the backend's `registry.delete(ref)`, which
   leaves a tombstone that keeps the row's token counter, and the rest of the row with it, wrapped keys included —
   the reason for dropping first. Prefer it to an object-store delete, which takes the tombstone too: the name's
   next row is then told apart from the earlier ones only by the random parts of its tokens, with overwhelming
   probability rather than by construction. A segment you delete the row of without dropping keeps its objects in
   the bucket with no row; `store.generations(ref)` lists them. Step 6 is what tells you the result is coherent.
5. **Restore the keystore** (if encryption is on), and check it can open the key of every restored segment:
   [Encryption & DR](#encryption--dr) has the check.
6. **Run `checkConsistency()`** (below) **before** serving traffic.
7. If it reports `inconsistent` segments, resolve them (restore the missing generations, or roll the registry
   back to a generation that exists — see below) and re-run until clean.
8. **Re-apply every erasure made after `T`.** The restore undid them: a crypto-shred's row has its wrapped key back,
   and a dropped or erased segment has its generations back, with the registry pointing at them. Take the segments
   from the events your audit sink stamped after `T`, and the subjects from your own record of erasure requests,
   since no event carries a subject id:

   ```ts
   import { destroySegment } from '@cloudbitmaps/roaring';

   // `backend` is the one this store is built with; `audit` is your sink.
   for (const ref of shreddedAfterT) {
     // each segment with a `segment.erase` event after T
     await destroySegment(ref, { registry: backend.registry }, { confirmSegment: ref.segment, audit });
   }
   for (const ref of disposedAfterT) {
     // each segment with a `segment.dispose` event after T (a drop re-shreds an encrypted segment too)
     const r = await store.dropSegment(ref, { confirmSegment: ref.segment, audit });
     if (r.generationsRemaining.length > 0) console.warn(`${ref.segment}: not fully reclaimed, re-run`);
   }
   for (const { id, scope } of subjectsErasedAfterT) {
     // `scope` as the original call had it: `{ namespace }` or `{ allNamespaces: true }`
     const { erasedFrom } = await store.eraseSubject(id, { ...scope, audit });
     // keep this ledger with the original; re-run while any entry says `erased: false`
   }
   ```

   `destroySegment` reports `reason: 'absent'` for a segment whose row did not exist at `T`, which step 4 already
   removed. It reports `reason: 'cleartext'` and leaves the row active for a row that held no key yet at `T` (its
   first encrypted load came after `T`): that row names no generation, and `store.dropSegment` deletes the objects
   the later load left and fences the name. A re-shred is complete only on the terms
   [Encryption & DR](#encryption--dr) sets out.
9. **Restart every process that holds a store over the bucket, or invalidate in each the segments steps 3 to 8
   touched** (`store.invalidate(ref)`), then route traffic. Until then a store answers from what it resolved before
   the restore: for up to `cache.genTtlMs` if it refreshes on a timer, and for as long as
   [readers still on an old generation](#readers-still-on-an-old-generation) says if it does not. A restored row
   carries the token it had at `T`, and every write after the restore gives it a token it never had, because each
   write draws a random part of its token, so a store keying a segment's cached chunks by generation and token never
   takes them for a generation written since. Optionally run a targeted `subjectReport`/read spot-check on a few
   known segments.

## Quiesce writers during a restore

Writers are safe *against each other* without any coordination. A load publishes with a compare-and-swap fenced
on the row it read (an unguarded load onto a segment with no row publishes forward-only instead), and a
subject-erasure rewrite on the generation it streamed, so the one that loses a race
reports `superseded` rather than clobbering the newer generation: a load as `published: false, reason:
'superseded'`, a rewrite as `erased: false, note: 'superseded'`. A load that finds its generation number already
taken writes nothing and reports the same `superseded` (objects are write-once). A writer racing a **restore** is a
different matter. The consistency check reads each segment's
live pointer and then lists its objects, and a load followed by a GC of the superseded generation — or an
`eraseSubject`, which deletes its predecessor the moment its rewrite is current — landing in that gap yields a
transient false positive. And a manual `currentGen` roll (step 7) under a concurrent loader is a race you do not
need to think about if the loader is simply not running.

So: pause the calls for the duration. Nothing here is a daemon — a load, a materialization, an erasure and the
sweep are all calls your own schedulers make — so "pause" means not invoking them, and there is no background
process to stop. If you cannot quiesce, re-run the scan to confirm a reported tear before acting on it.

## Readers still on an old generation

A store that has resolved a segment keeps serving that generation for up to `cache.genTtlMs` (default 2 s) before
it re-reads the pointer (and while the registry cannot be read because of a transient fault, until a retry 500 ms
apart reaches it), and decoded chunks sit in the cache for as long as the cache keeps them. After a manual
`currentGen` roll, a long-lived process may therefore keep answering from the generation it resolved *before* the
roll for that window. After a registry restore, restart each store or invalidate the restored segments in it (step 9
of the procedure) rather than wait: a restored row's later writes are given tokens it never had, so no cache is
misled, but each store answers from the generation it resolved before the restore until it re-reads the row. Some
stores need more than waiting after a roll too. One with no registry (built on a bare
`IStorageDriver`), with **`cache: { genTtlMs: 0 }`**, or on a pre-built `StorageChunkSource` built with no clock, has no timed refresh, so nothing bounds how
long it keeps the generation it resolved — restart those readers, or `store.invalidate(ref)` the restored segments
in each, as part of the procedure. One on a bare `IStorageDriver`, with **no registry**, reads no pointer: it lists
the bucket and serves the newest generation there, whatever the restored pointer says, so while generations above
the pointer remain, neither a restart nor an invalidation moves it back. Read through a backend, whose reads follow
the pointer, or, once you are sure the generations above the restored pointer are not wanted, delete those objects
through the backend's storage (`backend.storage.delete({ namespace, segment, generation })` for each; a load's collection never
reaches a generation at or above the pointer), and then restart those readers or invalidate the segments in
each. A live read on a generation that has since been **deleted** (an `eraseSubject` collects its predecessor on
return) re-resolves on its next read; that is the documented cost of physical deletion on return, not a fault. A
`seg.pin()` handle is the exception on both counts: a restore does not move it, so it keeps reading its own
generation while that object is there, and once the object is gone or replaced it answers only from what it has
already read, and fails with `NotFoundError` for the rest rather than re-resolve. Once a restore puts its object
back, it reads that object again once its store is invalidated (`store.invalidate(ref)`); a restart ends the pin
with its process. Take new pins after that invalidation.

## Repair: an unstamped tombstone after a hard kill

The one failure in the retention path that does **not** self-heal, so it needs a human. It costs nothing in steady
state and is cheap to check for, so check for it after any hard kill of a process that runs `retireExpired`
(whatever scheduler you run it from).

**What happens.** Retiring an expired segment is two registry writes with the whole storage sweep between them:

```text
  1. dropSegment(ref)          CAS the registry row → status: 'destroyed'   ← the retirement itself
                               then sweep Storage: list + delete, up to three passes
     forgetDuePointer(ref)     delete the segment's due-index pointer, if it has one
  2. stampRetirement(ref)      CAS retention.retiredBySweepAt = now         ← the attribution
```

A `SIGKILL` — or a `terminationGracePeriodSeconds` that expires, or a node that vanishes — landing anywhere after
the tombstone and before the stamp, a window that spans the storage sweep, leaves a tombstone with no stamp. The
in-process `catch` that would re-stamp it cannot run.

**Why the stamp is a separate write, and why we won't merge it.** The stamp is a *positive marker the sweep
writes on its own work*. The alternative — inferring "this tombstone was a retirement because the row is
`destroyed` and carries an expired policy" — is wrong in a way that matters: `destroySegment` never touches
`retention`, so the ordinary sequence *(set a 30-day policy → a GDPR request arrives mid-window →
`destroySegment`)* produces a **crypto-shred** tombstone carrying an expired policy. Auto-purging that row
destroys your local attestation for a right-to-erasure execution and un-fences the name for every writer. The
marker cannot be forged by that ordering; the inference can. One narrower ordering does put the marker on a
crypto-shred's tombstone: a `destroySegment` that lands between the sweep's re-read of an expired row and its
drop. The drop finds the tombstone, reports it dropped, and the sweep stamps it. The trail then holds a
`segment.erase` and a `segment.dispose`, as a sweep's own retirement of an encrypted segment does; only the actors
your sinks stamp on the two tell them apart.

**Why nothing tells you.** The purge path reads the stamp and, finding none, does a bare `continue`:

```ts
const retiredAt = retirementStamp(rec.retention);
if (retiredAt === null) continue;   // not ours — a GDPR tombstone, or a manual drop
```

No ledger entry, no counter, no metric. `checkConsistency()` won't see it either — it skips `destroyed`
segments by design. **The symptom you will actually notice is downstream**, and it looks like something else:

| | What you see |
|---|---|
| **The name is fenced, permanently** | A load **throws** on a `destroyed` row, and `eraseSubject` skips it. Re-loading that segment name never produces a readable generation — the load's object may land in the bucket, but nothing will ever point at it. |
| **The row and its objects are billed forever** | the sweep will not purge an unstamped tombstone, and nothing else in the library runs the collection for a tombstone the sweep does not own — so any generations left behind (and any object a late load wrote) stay. |

### Detect

Use the backend's registry directly. The store does not expose it; the backend you built the store with does, as
`backend.registry` (and its storage as `backend.storage`), and this is an admin action, not an API. `list()`
carries `status` and `retention` in its projection, so this is one scan, no per-segment reads. It stops at the first
row it cannot parse; see [a registry row the library did not write](#a-registry-row-the-library-did-not-write).

```ts
import { MIN_EXPIRES_AT_MS } from '@cloudbitmaps/roaring';

const { registry, storage } = backend; // used by the repairs below too
for await (const rec of registry.list(/* namespace? */)) {
  if (rec.status !== 'destroyed') continue;
  // Match the sweep's OWN predicate, not a looser one: it accepts a stamp only if it is an INTEGER at or
  // above the epoch floor it uses for expiry instants. A row carrying `0`, `NaN` or a fractional value is
  // unstamped as far as the sweep is concerned — it will never be auto-purged — so a looser check here
  // silently drops exactly the rows this audit exists to surface.
  const stamp = rec.retention?.retiredBySweepAt;
  if (typeof stamp === 'number' && Number.isInteger(stamp) && stamp >= MIN_EXPIRES_AT_MS) continue;
  console.log(rec.namespace ?? '_default', rec.segment, rec.retention);
}
```

Every row this prints is an unstamped tombstone. **Most of them are legitimate** — a crypto-shred
(`destroySegment` / `eraseNamespace`) or a manual `dropSegment` is *supposed* to be unstamped and permanent.
Deciding which is which is the part that needs a person:

- **Check your audit sink** for that segment, and read its events together, because no event says who made the
  call: an event carries no origin, only what your sink stamps on it. A crypto-shred (`destroySegment`,
  `eraseNamespace`) emits `segment.erase` alone, and `eraseNamespace` adds one `namespace.erase` for the namespace.
  A `dropSegment` of an encrypted segment emits the same `segment.erase` first, and every `dropSegment` then emits
  `segment.dispose` once its storage sweep ends. The sweep's retirements are `dropSegment` calls, so they emit
  exactly what a manual drop does. One killed mid-sweep emits the `segment.erase` if the segment was encrypted,
  nothing if it was cleartext, and no `segment.dispose`; one killed after its sweep but before the stamp emits
  both. So a `segment.erase` with no `segment.dispose` is a crypto-shred or an interrupted drop of an encrypted
  segment, and a `segment.dispose` is a drop, the sweep's or anyone's. What tells the sweep's drops apart is the actor your
  sink stamps, when the process that runs the sweep passes a sink that names it. If the events cannot settle it,
  leave the row alone: a tombstone kept costs a fenced name and a few bytes, and a crypto-shred's tombstone deleted
  is a lost attestation.
- An expired `retention.expiresAt` on the row is **not** sufficient evidence on its own — see the GDPR ordering
  above. Treat it as a hint that narrows the list, never as the answer.
- Correlate with the kill: an interrupted retirement is contemporaneous with the crash. `updatedAt` on the row is
  the tombstone write, which precedes the kill by at most the storage sweep, including any hang in it.

### Repair

Once you have established a row was an interrupted *retirement*, pick by whether the name must come back:

**(a) Let the sweep finish its job — the default.** Write the stamp the crash prevented. The first fleet sweep
that reaches the row at least `tombstoneGraceMs` (default 24 h) after the stamp's value — `retireExpired` with the
default `scan: 'fleet'`, over the row's namespace (and shard, if you shard), with `purgeTombstones` not set to
`false`, and not cut short by its `limit` before the row (`limited: true`) — then treats the row as its own,
verifies storage is actually empty, collects any orphan generations itself, and deletes the row. A `scan: 'index'` pass may never
reach it: that scan reads only the rows the due index points at, and the retirement can have removed the
segment's pointer before the kill.

```ts
import { MIN_EXPIRES_AT_MS } from '@cloudbitmaps/roaring';

const rec = await registry.get(ref);
const stamp = rec?.retention?.retiredBySweepAt;
const stamped = typeof stamp === 'number' && Number.isInteger(stamp) && stamp >= MIN_EXPIRES_AT_MS;
if (rec?.status === 'destroyed' && !stamped) {
  await registry.compareAndSwap(ref, rec.token, {
    retention: { ...rec.retention, retiredBySweepAt: Date.now() },
  });
}
```

Use the *original* retirement time if you have it from your logs rather than `Date.now()`; the value only
controls when the grace window elapses.

**(b) Return the name to service now.** Delete the row — but **only** after confirming storage holds nothing for
it. That precondition is not bureaucracy: deleting the row while storage objects remain strands them permanently
(the collection reads the row to decide what to collect, and collects nothing when there is none).

```ts
for await (const k of storage.list(ref)) throw new Error(`storage not empty: generation ${k.generation}`);
await registry.delete(ref);
```

If storage is non-empty, re-run `store.dropSegment(ref, { confirmSegment: ref.segment, audit })` first (it is
idempotent and re-sweeps storage, so it is how a residual in `generationsRemaining` is collected, and with the
`audit` sink it records the re-run as a `segment.dispose`), then prefer **(a)** and let the sweep reclaim it.

### Prevent

The window only opens on a kill that skips the graceful path, so close that path:

- **Give the sweep's process a termination grace period longer than a full cycle, plus margin** —
  `terminationGracePeriodSeconds` on Kubernetes, `stopTimeout` on ECS, the function timeout on Lambda. A cycle's
  length is knowable because you bound it: `limit` (default 100) caps the retirements per call, so size the
  grace period to the p99 of a `limit`-sized pass. Otherwise every deploy is a `SIGKILL`.
- **Make sure `SIGTERM` is actually delivered.** A shell-form `CMD` puts a shell at PID 1 that does not forward
  signals, so the container never receives it and *every* stop becomes a kill after the grace period. Use
  exec-form `CMD`, or an init that forwards.
- **Set a request timeout on the SDK client you inject.** The library times no write, deliberately, since a timeout
  of its own would abandon a write in flight; the only requests it can time are reads, through `readTimeoutMs` on
  `S3Storage` and `AzureBlobStorage`. The consequence is that a black-holed connection hangs a write, a listing or an
  untimed read indefinitely; without a client timeout, a stuck sweep eats its whole grace period and is then killed
  between the two writes above. This is the single highest-value thing you own.

The library does not pair the audit trail against unstamped tombstones itself; an automated reconcile is listed on
the [roadmap](../ROADMAP.md) and not shipped, so this section is the procedure.

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

- It needs a **backend** (the same requirement as every lifecycle helper); a store built
  around a pre-wrapped `StorageChunkSource` throws `UnsupportedError` — run it from an admin/ops store wired with
  a backend.
- It fans out at a bounded `concurrency` (default 8; pass `{ concurrency }`), and can be scoped to one
  `{ namespace }`. It holds the registry listing in memory, and refuses with `BudgetExceededError` past 250,000
  rows rather than materialize a fleet it cannot hold. `store.checkConsistency` takes no option to raise that
  ceiling, so check a larger fleet one namespace at a time.
- **Fault-isolated per segment, not at the listing.** The check first drains `registry.list()` (over the
  namespace, or over every namespace), and a failure there aborts the whole check with that error and no report:
  a list call that fails, or one registry row it cannot parse, which throws `IntegrityError` naming the row's key
  (see [a registry row the library did not write](#a-registry-row-the-library-did-not-write)). Re-run after a
  transient failure. Once the listing is in hand, a segment whose Storage/registry can't be read this pass lands in
  `errored` and the scan continues (a partial/transient object store mid-restore is exactly when you run this) —
  treat an errored segment as *unknown*, not coherent, and re-run once the store is fully up. And each segment is checked
  against its authoritative **live** registry pointer (a strong per-segment read), not the enumeration snapshot,
  so a concurrent load that advanced the pointer during the scan isn't misreported as a torn restore. (A load
  followed by a GC of the superseded generation — or an `eraseSubject`, which collects its predecessor
  immediately — landing in the tiny per-segment read gap can still yield a transient false positive: run the
  scan quiesced, per the procedure above, or re-run to confirm any reported tear.)
- **Detection is backend-agnostic.** It relies only on `IStorageDriver.list()` + `IRegistryDriver.get()`, so it
  covers **any** storage backend (S3 / GCS / Azure Blob) with **any** registry backend — nothing about the check is
  backend-specific. What it verifies is **presence**: that each segment's `currentGen` `.crbm` object
  *exists* in storage. It therefore catches the torn / dangling-`currentGen` restore, but **not**:
  - **byte corruption inside a present object** — the trust boundary catches that on read, failing closed with
    `IntegrityError` (the per-chunk CRC), which is what the read spot-check in the procedure is for;
  - **a pointer that is valid but older than you intended** — a registry restored to an earlier point than you
    meant is stale, not torn, wherever the generations it names are still in the bucket, and reads serve a correct
    older view;
  - **objects above the pointer** — loads that published after the registry's restore point. Reads through a
    backend never see them (a store on a bare `IStorageDriver` serves the newest of them; see
    [readers still on an old generation](#readers-still-on-an-old-generation)); see
    [what a restore does and does not bring back](#what-a-restore-does-and-does-not-bring-back).
- **A segment with no Storage generation is healthy, not torn.** A registry row whose `currentGen` is `null` says
  *this segment exists and has no Storage data yet* — a row minted by `setRetention` ahead of the first load, so the
  policy is recorded before the data. There is no generation that ought to exist, so nothing can be missing, and
  the scan reports it as consistent. (Reporting it would be worse than useless here: `missing-storage-generation`
  would fire on the healthy steady state of every such segment and bury the one signal a triage is looking for.)
- **It visits registry rows, so objects whose row is gone are not in its report.** `store.generations(ref)` lists
  those, since it reads the bucket whether or not a row exists.
- It is also worth running **periodically** (not just after a restore) as a cheap tripwire for backup/restore
  drift or an operator mistake — an object-store lifecycle rule that expired a current generation shows up here.

**Resolving a `missing-storage-generation`:** either (a) restore the missing storage generation from the object's
version history or a backup (after a restore to `T`, usually an object that existed at `T` and step 3 did not bring
back), or (b) roll the registry's `currentGen` for that segment **back** to a generation that does exist —
accepting the loss of the loads after that point, but restoring correctness. Then re-run `checkConsistency()`.

Remedy (b) is a supported call rather than a manual registry edit:

```ts
await store.generations(ref);              // what is actually in the bucket, current one marked
await store.rollback(ref, 4, { audit });   // put the pointer on one that exists, and record that you did
await store.checkConsistency();            // confirm
```

`rollback` refuses rather than guessing: a generation not in the bucket throws `NotFoundError` and **names what is
available**, a `destroyed` row (a crypto-shred's or a drop's tombstone) throws `ValidationError`, a row that
changed after `rollback` read it throws `WriteConflictError` and moves nothing, and a target *above* the pointer
needs an explicit `allowForward: true` — above the pointer is where objects live that may never have been current,
such as a load that wrote its object and died before the publish. Make a forward move with
`await store.rollback(ref, n, { allowForward: true, audit })`; `store.rollback` invalidates its own store. It deletes
nothing, so the rollback is itself reversible. It records the move as `segment.rollback` on the `audit` sink passed
to the call, and that event is the only record the library makes of it: with no sink, it records nothing. A
rollback to the generation already current changes nothing and records nothing.

**A rollback can fail half-way.** It moves the pointer and then checks the target is still in the bucket, because
collection can take a generation below the pointer between the listing and the move. If the target has gone, it
moves the pointer back and throws `NotFoundError` saying `the pointer was put back`. If moving it back fails too
(the row changed again, or the registry write failed), it throws `NotFoundError` saying
`the move back failed, so the pointer may still name <n>`. It says "may" because a write that landed and lost its
response reads as a failure: the pointer may already be back, or moved elsewhere by the write that beat the undo,
or still on the missing generation, the torn state this section resolves.
Check with `store.generations(ref)`, which marks the current generation, and `checkConsistency()`; roll back again
to a generation it lists, or restore the object. Neither failure records `segment.rollback` — the event is emitted
only once the pointer is on the target — so keep the error with your incident record.

> **One thing to know before you roll back a segment a subject was erased from.** An erasure entry that says
> `erased: true` means no generation of the segment holds the id: not the current one, not one below the
> pointer, and not one above it, which is where a rollback leaves the generations it rolled back from. An erasure
> performed *after* a rollback deletes **every** generation up there that holds the id, so no rollback can bring
> the id back. If the generation the pointer names does not hold the id, the ones up there that never held it stay
> as rollback targets; if it does, the rewrite is numbered above everything and its `keep: 0` collection takes
> every older generation, above the pointer or below. A rollback that lands *while* an
> erasure is running is not attested over: that erasure reports `note: 'superseded'`, or an `error: …` note if
> its rewrite had already published, and a re-run settles it. So if you roll back a segment while a subject
> erasure may be in flight against it, **re-run `eraseSubject` afterwards** and keep both ledgers.

## A registry row the library did not write

The registry reads a row only in a shape the library writes, and refuses anything else rather than guess at it:
a body that is not JSON, that has no `schemaVersion`, that carries a field the library does not write (at the top
level or in the record) or one its `schemaVersion` did not have, or that holds a value out of range, such as an
unknown `status`, a malformed `wrappedDeks` list, a malformed `summary`, or a `token` in none of the forms the
library writes. A row stamped 1 holds a decimal counter; one stamped 2 holds a decimal counter and a write part
(16 lowercase hex digits), `.`-separated, or 32 lowercase hex digits of incarnation id before those two. Each is an
`IntegrityError`, and its message names the row's key, except for a row over the 1 MiB size cap and a malformed
`wrappedDeks` list. This release writes rows stamped 2 and reads rows stamped 1 or 2. A row with a higher
`schemaVersion` than this build reads was written by a newer release; it is refused with `UnsupportedError`, and the
fix is to upgrade the process reading it, not to touch the row. A release before 0.12 refuses every row this one
writes the same way.

One refused row costs far more than its own segment:

- **`get` of that segment throws**, so every fresh resolve of the segment fails (a store that already had it
  resolved keeps answering from the generation it holds), and so does every call that reads its row first —
  `load`, `rollback`, `dropSegment`, `setRetention`, a subject erasure.
- **Every `list()` that reaches it throws**, whether it lists the row's namespace or every namespace, so the one row
  stops the whole listing. Every fleet-wide call enumerates through one. `checkConsistency`, a fleet
  `retireExpired`, `eraseSubject`, `subjectReport` and `eraseNamespace` read the whole listing before acting, so
  each fails with no result; `exportSegments` and `store.segments()` stream it, so they deliver the rows listed
  before the bad one and then throw. A `retireExpired` with `scan: 'index'` does not list the namespace, and throws
  only when a due pointer names the row. A subject erasure scoped to that namespace, or to every namespace, cannot
  run at all.

How one gets there: a row body written by hand or by a script, including a restore script that writes a row rather
than copying a version back; an object another tool put under the `registry/` prefix at a row's key
(`registry/<namespace>/<segment>.reg`, with names encoded as the library encodes them); a truncated or damaged
copy. An object under the prefix whose key is not a row's key is skipped by the listing, not refused.

**Repair.** Read the object the error names (on `LocalFsStorage`, the file), then:

1. If a version of it that the library wrote is available — a noncurrent object version, or a backup of the
   file — copy that version back to current, as restore step 4 does. Then restart or invalidate the stores over
   the bucket, as after any registry restore: the row moves back to the token it had then.
2. If there is no such version, delete the object with the object store's own delete; `registry.delete(ref)` cannot,
   since it has to read the row first. That also removes any token counter the key held, so a row created later
   under the same name starts its counter again at 0, under a new random incarnation id that keeps its tokens apart
   from the earlier row's; restart or invalidate the stores over the bucket afterwards. The segment then has no
   row: it reads empty, nothing collects its objects (`store.generations(ref)` lists them), and an encrypted one
   cannot be decrypted without a registry version that holds its key. Reload it from your source, or drop it with
   `store.dropSegment`.

Then run `checkConsistency()` — a version copied back can name a generation collected since it was current — and
re-run whatever failed.

**Prevent it.** Change a row only through the library: `store.load`, `store.rollback`, `store.setRetention` /
`clearRetention`, `store.dropSegment`, `destroySegment`, and for this runbook's repairs `compareAndSwap` / `delete`
on `backend.registry`. Restore a row by copying one of its versions back, never by writing its body.

## This runbook is exercised, not just written

`pnpm dr-drill` (`tests/dr-drill.test.ts`) runs this procedure end-to-end against the on-disk `LocalFs` storage and registry, wired as a backend — it seeds a fleet, takes a coordinated backup, then injects each failure and verifies the
resolution:

- **Torn restore** (registry recovered ahead of storage) and a **lost `.crbm`** are detected as
  `missing-storage-generation`, then cleared by rolling `currentGen` back with `store.rollback`, which records a
  `segment.rollback` (remedy (b) above), or by restoring the object from backup (remedy (a)). A read of the torn
  segment fails with `NotFoundError` until then.
- **Byte corruption inside a present `.crbm`** is the one case `checkConsistency()` **cannot** see — it verifies
  the generation is *present*, not its bytes. The drill confirms the sweep stays clean **and** that a read fails
  closed with `IntegrityError` (the per-chunk CRC), so the corruption surfaces at the trust boundary, not as a
  wrong answer. Spot-checking a read after restore (step 9) is what catches this class.
- **Readers still on an old generation.** After a `rollback`, a store on a bare `IStorageDriver` answers from the
  newest generation in the bucket through an invalidation and a restart, and from the restored pointer's once the
  generation above it is deleted. A `seg.pin()` handle whose object is replaced out of band answers from what it has
  read and refuses the rest. Once a restore puts the object back, it still refuses it until its store is
  invalidated, or a later `pin()` of the same version opens the object again, and then it reads the whole object
  again.

## Encryption & DR

If encryption-at-rest is on (see the [encryption guide](encryption.md)), the
**keystore is a first-class DR asset**: a `.crbm` cannot be decrypted from storage alone. The object carries no key
material and no key reference (its footer's 16-byte `key_id` field is written as zeros); the KEKs live in the
keystore, and the wrapped per-segment DEKs live in the segment's registry row. So:

- Back up and restore the keystore alongside the data stores, but keep its access path **separate** — the whole
  point of app-level encryption is that a storage-bucket leak doesn't hand over plaintext, and a shared backup that
  co-locates keys with ciphertext undoes that.
- **After a restore, check the keystore can open the key of every restored segment.** A missing key is
  unrecoverable ciphertext, not a torn restore — `checkConsistency()` verifies the *object* exists, not that you can
  decrypt it. The check reads only the registry, and asks the keystore to unwrap each segment's DEK:

  ```ts
  import { KeyUnavailableError } from '@cloudbitmaps/roaring';

  // `keystore` is the one the store is built with (`encryption: { keystore }`).
  for await (const rec of backend.registry.list()) {
    if (rec.status === 'destroyed' || rec.wrappedDeks === undefined) continue;
    try {
      await keystore.openDek(rec.wrappedDeks);
    } catch (err) {
      const why = err instanceof KeyUnavailableError ? 'no KEK it names is held' : 'no wrapping opens';
      console.error(rec.namespace ?? '_default', rec.segment, rec.wrappedDeks.map((w) => w.keyId), why);
    }
  }
  ```

  `KeyUnavailableError` means the keystore holds none of the KEKs the row's wrappings name: restore that KEK, or
  its recovery KEK. From `InProcessKeystore`, any other error (an `IntegrityError`) means it holds one of them but no
  wrapping opens under it: the wrong key material under that `keyId`, or a damaged row.
- **A crypto-shred is complete only once nothing can unwrap the key again.** A shred (`destroySegment`,
  `eraseNamespace`, or a `dropSegment` of an encrypted segment) is one compare-and-swap that removes the wrapped
  DEKs from the segment's current registry row. It destroys no KEK, and the shred itself leaves the objects where
  they are (a `dropSegment` then deletes them from the bucket, which does not reach their versions or backups).
  Versioning on the `registry/` prefix, which this runbook requires, keeps the row's earlier versions, and each of
  them written since the segment's first encrypted load still holds the wrapped DEKs; so does every backup or
  point-in-time copy of the prefix. Anyone holding one of
  those copies and a KEK that wrapped it can decrypt the segment, and a registry restore to a point before the shred
  copies such a version back to current, where the segment reads again. So a shred is complete once no retained
  copy of the row still holds the wrapped key — noncurrent object versions, backups and PITR copies included — or
  once every KEK that wrapped it is destroyed. How long the first takes is set by how long your storage keeps those
  copies, which is also the history a registry restore picks from. The second happens in your keystore, with no
  library call, and shreds a segment only once every KEK in its wrappings is destroyed: with `InProcessKeystore`,
  the KEK that was active when the segment was first loaded and, if one was configured, the recovery KEK, which
  wraps every segment's DEK a second time. Destroying those shreds every segment they wrapped.
- After a restore, re-shred every segment with a `segment.erase` event after `T`
  ([restore procedure](#restore-procedure), step 8).

### Optional: make a shred durable with a registry expiry rule

A crypto-shred stays open to undoing for as long as your storage keeps a superseded version of the registry row. To
close it on a schedule, add a **noncurrent-version expiry** lifecycle rule to the `registry/` prefix: once a
superseded version of a row is that many days old it is deleted, so a shred is durable that many days after it is
made. The cost is the restore window: you can restore the registry only that far back, because a point older than
the rule's days no longer has its row versions.

On S3 that is a rule filtered on the `registry/` prefix (`<prefix>registry/` on a backend built with a `prefix`) with
a `NoncurrentVersionExpiration` of `NoncurrentDays: 30`, for example, which leaves the current version of every row and every tombstone alone. GCS and Azure Blob have an
equivalent (a lifecycle condition on noncurrent versions of the prefix); take its exact syntax from your provider's
documentation. Set the days at or above the restore window your [RPO](#rpo--rto) needs, and never apply the rule to
current versions.

## What a restore does and does not bring back

- **A crypto-shred made after `T` is undone.** A shred removes the wrapped DEKs from the segment's current row and
  leaves its objects in the bucket, so a registry restored to a point before the shred has the wrapped key back, and
  the segment reads again. Step 8 of the procedure re-shreds it. Do not treat DR as a way to recover shredded data:
  an erasure a restore undoes has to be re-applied, or it is no erasure at all.
- **A subject erasure made after `T` is undone.** A subject-erasure rewrite deletes the generation that held the
  bit; a restore to `T` brings that generation back and points the registry at it. Step 8 re-runs the erasure.
  Outside a restore, a rewrite still does not reach the copies your storage keeps on its own — noncurrent
  versions, replicas, backups — which is why `PRIVACY.md` says it does not reach backups.
- **Loads published after the registry's restore point are not recovered.** Their objects may still exist in
  storage, *above* the restored pointer. Reads through a backend never see them (the pointer is authoritative; a
  store on a bare `IStorageDriver` does, see [readers still on an old generation](#readers-still-on-an-old-generation)),
  and collection never touches a generation at or above `currentGen` — so they sit there, billed, until you act. The
  safe recovery is to **re-run the load from your source**. A load takes the number after the pointer while no
  object holds it, and collection usually freed the numbers just above the restored pointer, so the first re-runs can
  number *below* the strays and leave them above the pointer; the first load whose number a stray holds numbers
  above every object in the bucket, which puts them all below the pointer. List `store.generations(ref)` and load
  until the pointer is above the highest stray. Below the pointer, collection counts them within `keep` like any
  other generation: `keep` counts every generation below the new pointer, strays first, so collection takes
  all but the newest `keep` of them, and each later load takes one more. Under the default `keep: 1` it keeps the
  newest stray and collects the rest, the restored generation included. The re-runs that number below the strays
  are generations below the pointer too, so by the time the pointer passes the strays every number from the restored
  pointer to the highest stray can be there: if the restored generation must stay a rollback target, pass a `keep` of
  at least the highest stray minus the restored pointer, plus one, on every re-run until the pointer is above the
  strays. With the pointer restored to 1 and strays at 4 and 5, that is `keep: 5`; a `keep` of the number of strays
  plus one, 3, collects generation 1 on the re-run that passes them. Do not hand-publish an
  object you cannot vouch for. A stray
  above the pointer is a whole object — every backend commits an object atomically, so a crash never leaves a
  partial one — but the bucket cannot tell you whether it was ever current. After a restore it is usually a load
  published after `T`; otherwise it can be a load whose process died between writing and publishing, a load refused
  or superseded after the row changed, or a load whose publish threw. A `TransientError` from a load whose registry
  writes were never answered leaves its object for that reason: a write can still land after the load returned, and
  then points the row at it, so a load never deletes it. A rollback with
  `allowForward: true` will point at it if asked.

## Not shipped: rebuilding the registry from storage

The library cannot rebuild a **lost** registry from the storage objects that survive it: the registry is
authoritative and must be restored from its own version history (hence the versioning requirement above). Making
storage objects self-describing enough to rebuild it (and to decrypt without the registry row, though still with
the keystore's KEK) would take a
`.crbm` **format change** that carries a KEK-wrapped DEK in each object. The fixed 104-byte footer cannot hold one
(its reserved field is 2 bytes, and its 16-byte `key_id` field, written as zeros, is smaller than a wrapped DEK), so
it would be a new section in the extension block, with a footer flag bit of its own, since every reader must
understand it. It
would also change the crypto-shred model, since shredding would then have to delete the storage objects too, not
just the key. The capability is listed on the [roadmap](../ROADMAP.md). **Back up the registry and keystore** —
they are not reconstructable from storage alone.
