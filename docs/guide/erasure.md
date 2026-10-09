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
route it to your audit sink. When you pass `audit`, the store also emits an event per segment it erased the id from:
`segment.rewrite` when it rewrote the current generation, `segment.collect` when it only deleted other generations.
Segments the id is not in are not listed. The two calls look in different places: `subjectReport` reads what a reader
reads, each segment's current generation, while `eraseSubject` also searches older generations, a tombstoned
segment's objects and a first load's object that never published. So the ledger can name a segment the report did
not.

`eraseSubject` needs a store built on a backend, because it writes generations. `subjectReport` needs one too, for
the registry it lists. A store missing what a call needs throws `UnsupportedError`: a store built on a bare storage
driver (`IStorageDriver`) or a pre-built `StorageChunkSource` instead of a backend cannot run either. Build it on `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
`AzureBlobStorage`.

**What it costs.** `subjectReport` costs one pass over the registered segments. `eraseSubject` costs more: a segment
whose current generation lacks the id is searched generation by generation, so a fleet that keeps long histories
pays for every one. The per-op budget is charged for them. The scan runs at a bounded `concurrency` (default 8; pass
`{ concurrency }`), so it is quick over a large fleet without stampeding your backend. A fault on one segment never
aborts the ledger.

## Reading the ledger

`erased: true` means the call listed the segment's bucket and read what is left, and **no generation of the segment
holds the id**, above the pointer or below it. When the current generation did not hold the id, nothing was
rewritten, so that entry has no `generation`, and the audit event is `segment.collect` rather than `segment.rewrite`.

`erased: false` means this run did not erase the id from that segment. That is not the same as "the id is still
there", and `note` says why:

| `note` | Means | What to do |
|---|---|---|
| `'superseded'` | Another writer moved the pointer off the generation the rewrite was derived from. Usually a load; it can also be another erasure or an operator's `rollback`. | Re-run. It erases the id if it is still present, and lists nothing for the segment if a racing erasure of the same id already removed it. |
| `error: <message>`, a transient storage fault | The storage failed under it. | Re-run. |
| `error: <message>`, the budget ran out | The call's `budget` ended before all the segment's generations were searched. | Re-run with a higher `budget`. |
| `error: <message>`, a missing keystore | The segment is encrypted and the store has no keystore. | Wire the keystore. |
| `error: <message>`, `requireEncryption: segment … is cleartext` | The store was built with `encryption: { required: true }`, and the rewrite would write a cleartext generation. | Erase it from a store built without `required`, or drop the segment. |
| `error: <message>`, a `WriteConflictError` saying the segment has no published generation | A first load's object that never published holds the id, or, on an encrypted store, is sealed under a key that load has not published and cannot be searched; its load may still publish it, so it is not deleted. | Load the segment, which makes the object collectable, or drop it, and re-run. |
| `error: <message>`, a `NotFoundError` saying the generation is another object than its registry row names | The object under the row's current generation is not the one the row's summary names by its fingerprint: put back from outside the library, or restored from another point than the registry. The erasure read none of its ids and wrote nothing. That object stays in the bucket and may hold the id, and every read that opens it refuses it. | Re-running will not help. Run `checkConsistency({ summaries: true })`, which reports the segment as `summary-mismatch`, restore the registry and the bucket to one coherent point ([disaster recovery](disaster-recovery.md)), then re-run the erasure. |
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

## A batch of materializations

A [`store.materializeMany`](loading.md#many-outputs-from-one-pass-materializemany) call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's. An output of a `materializeMany` call can carry an id that was erased while the call ran, for as long as the call ran: the call reads each operand at the generation it pinned, and an output's publish is a load, so an erasure that lands after the chunks were read does not reach what the call holds, unless the output subtracts a pinned operand that the erasure rewrote, which the call re-reads just before the publishes and refuses. An erasure that rewrites a destination before that output's publish starts does not stop the publish, which, subject to the output's own `guard` and the refusal of an empty result over a non-empty destination, writes on top of the erasure's generation; an erasure that lands inside the publish's own write, between its pointer read and its pointer write, makes the publish lose with `WriteConflictError`; after any call that overlapped an erasure, re-run `eraseSubject` and keep both ledgers. `eraseSubject` deletes the generation it rewrites even when a call holds it pinned, so a pin does not outlive an erasure, and an output that still needs a deleted operand generation fails with `NotFoundError`.

A call with a feed reads operands the library never stores, which no erasure can reach, so the guarantee above does not describe it, and it is refused instead. A `materializeMany` call with a feed is refused at its next record, and immediately before each fed output's publish (after the output has waited for its room in the memory budget), once `eraseSubject` has started in this store, one already running when the call began included: nothing is published from operands the call read before the erasure returned, apart from the window below, and the one record in hand when the erasure lands is processed and discarded. The counter it reads is moved at the start and at the end of each `eraseSubject` this store runs, so an erasure that began and finished between two of the call's checks is seen too; `rollback`, `retireExpired` and `dropSegment` do not move it. An erasure that starts after a fed output's last check and finishes before that publish's pointer write is not caught by the counter, and its window is the publish's own object write and pointer write, which lasts as long as the object takes to upload; the fences above still apply to what it touched. Only this store's `eraseSubject` moves the counter such a call reads, so an erasure by any other path (another store, another process, or the free function `eraseIdFromSegment` in this process) is not seen by it, and is bounded by nothing. An id erased from the source of a feed has to be erased there: the library holds none of it.

A dry run (`dryRun: true`) publishes nothing, so no id reaches a generation through it. Its counts describe the operands
as it read them: an erasure between a dry run and the publish that follows it changes what that publish writes, and
the [re-run recipe](loading.md#publish-what-you-reviewed) says what that means for a replayed feed.

## Two rules while you erase

- **Do not load the segment while erasing from it.** A load that lands after the rewrite carries whatever its source
  held, and the library cannot know that source was meant to exclude the id. Pause loads of the affected segments for
  the duration, or fix the source first and load after. A writer that lands during the rewrite is caught and
  reported as `'superseded'`, not as an error. A load still writing a generation above the pointer, when the id is
  found only there, is refused: the erasure writes the segment's row before it deletes that generation, and a load
  that found no row is refused by any row at all, so the load's publish meets another writer rather than naming an
  object that is gone.
- **Never put a subject's id in a generation's metadata.** An erasure rewrites the ids and carries the metadata over as
  it is, without scanning it: it would copy an id there into the new generation, and the registry row holds a copy of
  the current generation's metadata too. Put a version, a time or a run id in it, and nothing that names a person.
- **Do not roll the segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto
  a generation the erasure did not rewrite. Roll back before the erasure starts or after it returns, and re-run an
  erasure that reports otherwise once the pointer is where you want it.
  [How it stays correct](#how-it-stays-correct) says what each landing point reports.

## Who stops seeing the id, and when

The erasure is immediate in storage, and immediate in the store that performed it for every read that starts after it
returns: that store drops what it had cached about the segment before returning, so it cannot keep answering from
memory. A read of that store already in progress moves to the rewritten generation, but what it had already taken is the old
generation's, so it can still yield the id from it: up to 32 chunks for `iterate` and `count`, and up to `concurrency`
keys (32 by default) for a combine. A combine or `iterate` reads each operand's chunks as ranges of the object, and
resolves the segment again before it serves each chunk, one held in its cache included, as a read of that chunk alone
does, so the ranges it had already
requested are dropped when the erasure has landed, not served ([a long call can describe two
instants](reading.md#how-soon-a-reader-sees-a-new-load)). Every other store is a different
question, in this process or another. This library ships nothing that could answer it for you: there is no daemon,
no bus, and no connection between two stores that happen to point at the same bucket.

| | when the id stops being readable |
|---|---|
| storage | on return: the generation holding it is deleted |
| the store that performed the erasure | on return, for every read that starts after it, and its pins then fail; a read already in progress there can still yield it from a chunk it had requested before |
| another store, with a registry and a `cache.genTtlMs` above 0 | within `cache.genTtlMs` (default 2 s), while the registry can be read, for a small generation's chunks too, which its reader holds and serves until the refresh moves it on; an outage of the registry stretches it ([how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load)) |
| `seg.pinAt` of a generation the erasure rewrote, in any store | on return it fails with `NotFoundError`, since the object is deleted (and, with a registry, the row has moved on); during the erasure, between the rewrite's publish and its delete of the old generation, it can still open that generation, and a handle opened then is a pin, covered by the next row |
| a `materializeMany` call with a feed, and an erasure by any path but this store's `eraseSubject` | **no bound**: the call is refused only by this store's `eraseSubject` |
| a pinned handle (`seg.pin()`) in another store | **no bound**: until that store's reader cache evicts the pin's reader (in a store with a timed pointer refresh, a small generation's reader holds all of its chunks, decoded or not) and its chunk cache evicts the chunks the pin decoded, or `store.invalidate(ref)` is called there |
| a leased pinned handle (`seg.pin({ leaseUntil })`) in another store | until its lease ends, at most 14 days after it was taken: its reads then throw `LeaseExpiredError`, whether or not its reader still holds the chunks. Until then, as for any pinned handle in the row above |
| another store with **no registry** (built on a bare `IStorageDriver` instead of a backend), with `cache: { genTtlMs: 0 }`, or on a pre-built `StorageChunkSource` built with **no clock** | **no bound**: only when its caches happen to let the segment go, or something tells it |

A refresh that fails with anything but a transient fault (an access denial, a row that will not parse) does not keep
serving: the read that meets it throws, and the reader is dropped with the key it unwrapped.

`cache: { genTtlMs: 0 }` turns the timed refresh off. It is a reasonable setting for a read-only replica of immutable
data, but a store set that way has no bound on when it observes an erasure or a crypto-shred. `store.invalidate(ref)`
is the hook, and fanning the reference out to your fleet is yours, because the transport is yours. The same applies to
`destroySegment` and `eraseNamespace`, which are free functions over a backend's `registry` and invalidate no store: every store
beside them keeps the **unwrapped** key for as long as that table's row for it says. See
[freshness](reading.md#how-soon-a-reader-sees-a-new-load).

## A lease keeps superseded generations, and erasure ignores it

A pinned handle taken with [`pin({ leaseUntil })`](reading.md#hold-a-generation-for-a-job-a-lease) keeps its generation out
of a load's collection until the lease ends, at most 14 days after it was taken and a 60-second margin after that. While it
does, the bucket holds a generation that a newer load has superseded, including ids that load removed, and a lease is a
reason for a deleted-looking id to still be in storage that is easy to forget.

Erasure ignores every lease. `eraseSubject` and `eraseIdFromSegment` delete the generations that hold the id, and the
collection that follows an erasure rewrite deletes every generation below the new one, a leased one included; the rewrite
clears the row's leases. An erasure that finds the id only in a generation other than the current one deletes that
generation, leased or not, and writes no row of its own, so an entry for a generation it deleted stays in the list until the
entry's own time ends or the next publish or lease write prunes it: it spares nothing, since the object is gone, and it
counts toward the 64 places until then. A `destroySegment`, a `dropSegment` and a retention expiry delete every generation
and leave no lease on the tombstone. So erasure, shred, drop and retention always win, and a lease never holds an erased
subject's data past the bounds in the table above.

A lease written while an erasure is under way does not delay it. A lease write moves the row's token, which an erasure
rewrite is fenced on, but a row that differs from the one the rewrite read only in its leases does not refuse it: it goes on
against the row it finds, without streaming the object again, and so does the re-proof before each delete above the pointer
([how a load stays correct](loading.md#how-it-stays-correct) states the rule). A change of anything else refuses, and
`eraseSubject` reports `superseded` as it always has: run it again.

What a lease does not change is when a reader stops seeing the id. A leased handle in another store answers as any
pinned handle does until its lease ends, and then every read of it throws `LeaseExpiredError`.

## What an erasure does not reach

The **metadata** of a generation: the rewrite carries it over unchanged, and the row's summary of the new generation
holds it again, with the id count one smaller. Neither is scanned for the id. On an encrypted segment, an object whose
metadata block is missing, with a sealed summary on the row that has metadata, is rewritten with the row's metadata, since
the block's presence is not authenticated and the summary is.

A **deleted row**, where the registry cannot remove one. A registry that reports `conditionalDelete` (S3 when its
client sends to an AWS S3 host, Azure Blob, the local filesystem and memory, by default) removes a row it deletes,
whether by `registry.delete` or the retention sweep's purge of a tombstone. One that does not (an S3 client that sends to
an S3-compatible store or an emulator, or a GCS client, by default, or `conditionalDelete: false`) keeps the row's record
in a deleted marker, so the token counter survives a re-create. A tombstone from `dropSegment` or `destroySegment` holds
no key and no summary, since both clear them, so what such a purge keeps is the name, the pointer, the retention policy
and the timestamps. A live row deleted directly with `registry.delete` keeps its summary too, in a marker where one is
written.

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
when the call returns. It reads the generation through the reader's coalesced chunk stream, in key order: chunks that sit within 256 KiB of
each other are fetched in one range request of at most 1 MiB, so a segment of 2,000 chunks of about 8 KiB takes about
16 range requests rather than 2,000 (expected, from the test that counts them), and the ranges go out 4 at a time. Every
chunk is checked exactly as a read of it alone is checked: its CRC32C, its AEAD on an encrypted segment, and the
payload cap. Memory is bounded by the stream, never the segment: it holds at most 4 ranges at once, in flight or
landed and not yet taken by the writer, each at most 1 MiB plus 28 bytes (a range is larger only when one chunk is,
and no chunk is larger than the reader's cap of 1 MiB, [SECURITY](../../SECURITY.md)). That is at most 4 MiB plus 112
bytes per segment and `concurrency` times that for `eraseSubject`, 32 MiB plus 224 bytes at the default 8; a segment
smaller than that is held whole. A well-formed segment of chunks of about 8 KiB reads ahead up to 4 MiB, where a read
of one chunk at a time held about 256 KiB. `eraseSubject` erases up to `concurrency` segments at once (8 by default),
so its rewrites can have up to `concurrency × 4` range requests open together, 32 by default, each one range and not
one chunk. Each segment's search of the other generations for a holder, before and after its rewrite, reads up to 4
generations at once (up to 8 object requests, and up to 4 chunk payloads held, no more than 4 MiB for a corrupt one),
so `eraseSubject` has at most `concurrency × 8` requests open, 64 by default: within the 128 sockets of the client the
store builds, while on a client you pass with the SDK's default of 50 the requests past 50 wait for a socket unless you
raise `maxSockets` ([production](production.md)). `eraseNamespace` shreds 8 segments at once, a registry read and write
each, with nothing held but the rows.

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
loser deletes it before returning. The outcome is read off the registry row. A segment whose row is tombstoned
mid-rewrite is searched as a fresh call searches a tombstone, so a cleartext object a drop left that still holds the
id is deleted; one whose row is purged mid-rewrite is left out of the ledger, as a fresh call would leave it out. The rewrite publishes fenced on the generation it streamed and the row's token, and
not forward-only, for the reason given in [which fence a publish carries](loading.md#how-it-stays-correct).

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
- A tombstoned row has its bucket searched too. A crypto-shred leaves objects no key opens, but a cleartext destroy, a
  drop whose sweep left something, or a write that landed after it leaves objects anyone can read: when one holds the
  id, every object under the tombstone is deleted and the entry reads `erased: true`. Otherwise the result is
  `'destroyed'`, and the objects are left to the retention sweep's purge or a re-run of the drop.
- A row with no generation yet (one `setRetention` created before the first load) has its bucket searched too. An
  object a first load wrote and never published that holds the id is refused with `WriteConflictError`, and kept: the
  erasure writes nothing to such a row, so the load that wrote the object may still publish it. On an encrypted store
  such an object is sealed under a key its load has not published yet, so it cannot be searched and is refused the
  same way. A row with nothing in its bucket is `'no-generation'`, under `requireEncryption` too. In `eraseSubject`'s
  ledger it is an `error: …` entry. Load the segment, which makes the object collectable, or drop it, and re-run.
- `'superseded'` means another writer moved the pointer off `fromGeneration` while the call was in flight: a load,
  another erasure, or a rollback. It means this call did not erase the id, not that the id is still there. Re-run, and
  if a racing erasure of the same id got there first, the re-run reports `'not-member'`.
- A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had
  just written. The reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` once the
  tombstone's objects are searched as a fresh call searches them (`erased: true` when one still held the id and was
  deleted), and one purged by the retention sweep reports `'absent'`.
- A `NotFoundError` is raised only when the pointer still names its generation and that generation's object is
  missing, the forbidden `missing-storage-generation` state, or is another object than the row's summary names by its
  fingerprint. No re-run fixes either: `checkConsistency({ summaries: true })` reports both.
- `collected` lists the generations this call deleted: evidence for the physical half of an Art. 17 erasure, and what to
  keep if you build a proof-of-deletion artifact. It can legitimately be empty on a successful erasure, when a
  concurrent collector removed the holding generation first. `erased: true` is a claim about the bucket, not about who
  emptied it.
- A call that could not collect throws instead of reporting `erased: true` over bytes still there:
  `WriteConflictError` when the collect could not prove the segment was still the same one (re-created, or its row
  purged), or when a generation still holding the id is left in the bucket. A chunk holding an out-of-range value throws
  `IntegrityError` instead of being re-encoded into the new generation, so a corrupt segment is reported as corrupt, not
  erased.

