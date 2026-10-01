# Subject access and erasure

Two calls answer "what do you hold about this person?" (GDPR Art. 15) and "forget this person everywhere" (Art. 17):
`store.subjectReport(id)` and `store.eraseSubject(id)`. Both scan the registered segments, so build the store on the
backend your loads used.

## Find an id, and erase it

Both calls need a scope. Ids live in one global 32-bit space shared across namespaces, so a call with no namespace
would sweep every tenant. To keep that from happening by accident, pass either a `namespace` or an explicit
`{ allNamespaces: true }`. A call with neither throws `ValidationError`.

```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

// Art. 15: which segments is this id in? (scoped to one tenant)
const report = await store.subjectReport(userId, { namespace: 'eu' });
report.segments; // [{ segment, namespace }, ...]    report.scannedSegments: the completeness denominator

// Art. 17: remove the id everywhere, across all tenants (the explicit fleet-wide acknowledgement)
const audit = new RecordingAuditSink(); // or your own audit sink: see Observability
const ledger = await store.eraseSubject(userId, { allNamespaces: true, audit });
ledger.erasedFrom; // [{ segment, namespace, erased: true, fromGeneration: 4, generation: 5 }, ...]
```

`ledger.erasedFrom` is your **erasure ledger**, the proof of deletion. It is a return value only, so persist it or
route it to your audit sink. When you pass `audit`, the store also emits a `segment.rewrite` event per rewrite.
Segments the id is not in are not listed.

`eraseSubject` needs a store built on a backend, because it writes generations. `subjectReport` needs one too, for
the registry it lists. A store missing what a call needs throws `UnsupportedError`: a store built on a pre-built
`StorageChunkSource` cannot run either. Build it on `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
`AzureBlobStorage`.

**What it costs.** `subjectReport` costs one pass over the registered segments. `eraseSubject` costs more: a segment
whose current generation lacks the id is searched generation by generation, so a fleet that keeps long histories
pays for every one. The per-op budget is charged for them. The scan runs at a bounded `concurrency` (default 8; pass
`{ concurrency }`), so it is quick over a large fleet without stampeding your backend. A fault on one segment never
aborts the ledger.

## Reading the ledger

`erased: true` means the call listed the segment's bucket and read what is left, and **no generation of the segment
holds the id**, above the pointer or below it. When the current generation did not hold the id, nothing was
rewritten, so that entry has no `generation` and no `segment.rewrite` event is emitted.

`erased: false` means this run did not erase the id from that segment. That is not the same as "the id is still
there", and `note` says why:

| `note` | Means | What to do |
|---|---|---|
| `'superseded'` | Another writer moved the pointer off the generation the rewrite was derived from. Usually a load; it can also be another erasure or an operator's `rollback`. | Re-run. It erases the id if it is still present, and lists nothing for the segment if a racing erasure of the same id already removed it. |
| `error: <message>`, a transient storage fault | The storage failed under it. | Re-run. |
| `error: <message>`, the budget ran out | The call's `budget` ended before all the segment's generations were searched. | Re-run with a higher `budget`. |
| `error: <message>`, a missing keystore | The segment is encrypted and the store has no keystore. | Wire the keystore. |
| `error: <message>`, an `IntegrityError` naming a chunk | That segment is corrupt. The rewrite refused to copy the corruption into a new generation, and no erasure happened on it. | Investigate; re-running will not help. |
| `error: <message>`, a `WriteConflictError` | The erasure could not remove a generation holding the id and refused to claim it had. Often a rewrite had already published, so part of the work landed (a rollback onto a generation that still holds the id, landing while the rewrite collects, is one way). It also fires on the collect-only path, where nothing is published at all. | See what a re-run reports instead of assuming the job finished. |

A fault can also land after a rewrite published. Examples are a storage `delete` fault, a collect that could not prove
the segment was still the same one, and a generation still holding the id when the bucket is listed at the end (such
as a rollback target an operator moved the pointer onto mid-collect). The pointer has then moved, and the re-run
searches every generation in the bucket. It usually reports `erased: true` against the generation it found the id in, and nothing at
all if a racing collector took that generation first (gone, but unreceipted).

Re-running is safe and idempotent: a segment the id is no longer in is simply not listed. But "not listed" is not by
itself proof the id is gone. A segment whose registry row was purged is not scanned either, and its objects outlive it
as orphans. `store.generations(ref)` lists those, since it reads the bucket whether or not a row exists, and
`store.dropSegment(ref, { confirmSegment })` deletes them, writing a `destroyed` row first as it always does, which
then fences the name. `store.checkConsistency()` and the collection a load runs start from the rows, so neither
reaches them.

## Two rules while you erase

- **Do not load the segment while erasing from it.** A load that lands after the rewrite carries whatever its source
  held, and the library cannot know that source was meant to exclude the id. Pause loads of the affected segments for
  the duration, or fix the source first and load after. A writer that lands during the rewrite is caught and
  reported as `'superseded'`, not as an error.
- **Do not roll the segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto
  a generation the erasure did not rewrite. Roll back before the erasure starts or after it returns, and re-run an
  erasure that reports otherwise once the pointer is where you want it.
  [How it stays correct](#how-it-stays-correct) says what each landing point reports.

## Who stops seeing the id, and when

The erasure is immediate in storage and immediate in the store that performed it: that store drops what it had cached
about the segment before returning, so it cannot keep answering from memory. Every other store is a different
question, in this process or another. This library ships nothing that could answer it for you: there is no daemon,
no bus, and no connection between two stores that happen to point at the same bucket.

| | when the id stops being readable |
|---|---|
| storage | on return: the generation holding it is deleted |
| the store that performed the erasure | on return, and its pins then fail |
| another store, with a registry and a `cache.genTtlMs` above 0 | within `cache.genTtlMs` (default 2 s), while the registry can be read: a transient fault in reading it keeps the store serving what it holds and retries 500 ms later |
| a pinned handle (`seg.pin()`) in another store | **no bound**: until that store's reader cache evicts the pin's reader and its chunk cache evicts the chunks the pin decoded, or `store.invalidate(ref)` is called there |
| another store with **no registry** (a bare `IStorageDriver`), with `cache: { genTtlMs: 0 }`, or on a storage source built with **no clock** | **no bound**: only when its caches happen to let the segment go, or something tells it |

A refresh that fails with anything but a transient fault (an access denial, a row that will not parse) does not keep
serving: the read that meets it throws, and the reader is dropped with the key it unwrapped.

`cache: { genTtlMs: 0 }` turns the timed refresh off. It is a reasonable setting for a read-only replica of immutable
data, but a store set that way has no bound on when it observes an erasure or a crypto-shred. `store.invalidate(ref)`
is the hook, and fanning the reference out to your fleet is yours, because the transport is yours. The same applies to
`destroySegment` and `eraseNamespace`, which are free functions over raw drivers and invalidate no store: every store
beside them keeps the **unwrapped** key for as long as that table's row for it says. See
[freshness](reading.md#how-soon-a-reader-sees-a-new-load).

## What an erasure does not reach

Backups, replicas and noncurrent object versions hold the old object until their own lifecycle removes it. For an
at-rest guarantee that survives those, encrypt and crypto-shred (`destroySegment` and `eraseNamespace`, see
[encryption](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)). That works per segment: a per-id shred is
infeasible, because one key covers the whole segment. See [`PRIVACY.md`](../../PRIVACY.md).

## How it stays correct

**An erasure is a rewrite.** There is no per-id delete on an immutable object and no mutable tier to hold a
tombstone, so `eraseSubject` does what every other write in the library does. For each registered segment the id is a
member of, it streams the current generation through, with every chunk decoded and re-encoded and the one holding the
id with that bit cleared. It verifies the new object, publishes it fenced on the generation it streamed, and then
deletes the generation that held the bit (a collection with `keep: 0`). The bit is physically gone from the bucket
when the call returns, in constant memory with one chunk in flight.

**Every generation that holds the id goes, not only the current one.** A re-seed that drops someone leaves their bit
in the generation `keep` retains. A `store.rollback` leaves the generations it rolled back from above the pointer,
where a later rollback can make them current again. So the call searches every generation in the segment's bucket. A
holder below the pointer goes with the `keep: 0` collection, and each holder above it is deleted one by one. A
generation up there that never held the id stays as a rollback target when the current generation does not hold the
id. A rewrite is numbered above everything, so its `keep: 0` collection takes every older generation, above the
pointer or below.

**Racing writers.** Another writer that moves the pointer off the generation the rewrite derived from can be a load,
another erasure, or an operator's `rollback`. Another erasure collects with `keep: 0`, so it can delete the generation
this rewrite was still streaming, or the object it had just written. Two erasures of different ids racing on one
segment are safe: the loser's rewrite still holds the winner's id, and when it sits above the winner's pointer the
loser deletes it before returning. The outcome is read off the registry row, so a segment whose row is tombstoned or
purged mid-rewrite is left out of the ledger, as a fresh call would leave it out.

**A rollback during an erasure.** What the call reports depends on where the rollback lands:

- Before the publish, the entry says `'superseded'`.
- After the publish, while the call collects, the generation it replaced can be left above the lowered pointer, or be
  the one the pointer now names. A generation that still holds the id stays in the bucket, and the call reports an
  `error: ...` note instead of `erased: true`.
- When the id was not in the current generation and nothing was published, a rollback while the call deletes
  generations above the pointer is reported as `'superseded'` if a holder is left, and one while it collects is an
  `error: ...` note.
- In the last instant before a delete, a rollback onto the generation being deleted leaves the pointer on a missing
  object, which `checkConsistency()` reports.

**The result of erasing one segment.** `eraseSubject` runs `eraseIdFromSegment` (on `@cloudbitmaps/core`, for flavor and
driver authors) over every registered segment, and each ledger entry is that function's result.

- `erased: true` means no generation of the segment holds the id, checked by listing the bucket and reading what is
  left. Otherwise `reason` is `'absent'`, `'destroyed'`, `'no-generation'`, `'not-member'` (no generation in the bucket
  holds it) or `'superseded'`.
- `'superseded'` means another writer moved the pointer off `fromGeneration` while the call was in flight: a load,
  another erasure, or a rollback. It means this call did not erase the id, not that the id is still there. Re-run, and
  if a racing erasure of the same id got there first, the re-run reports `'not-member'`.
- A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had
  just written. The reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` and one purged by
  the retention sweep reports `'absent'`.
- A `NotFoundError` is raised only when the pointer still names the missing object, the forbidden
  `missing-storage-generation` state, which no re-run fixes.
- `collected` lists the generations this call deleted: evidence for the physical half of an Art. 17 erasure, and what to
  keep if you build a proof-of-deletion artifact. It can legitimately be empty on a successful erasure, when a
  concurrent collector removed the holding generation first. `erased: true` is a claim about the bucket, not about who
  emptied it.
- A call that could not collect throws instead of reporting `erased: true` over bytes still there:
  `WriteConflictError` when the collect could not prove the segment was still the same one (re-created, or its row
  purged), or when a generation still holding the id is left in the bucket. A chunk holding an out-of-range value throws
  `IntegrityError` instead of being re-encoded into the new generation, so a corrupt segment is reported as corrupt, not
  erased.

