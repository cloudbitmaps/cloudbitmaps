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
Segments the id is not in are not listed. A segment where the erasure found the id in nothing it could search, and
deleted only objects no read of the segment can open ([below](#two-rules-while-you-erase)), is not listed either: the
audit sink gets `segment.collect` for it with no `fromGeneration`, and that event is the only record of the deletion.
The two calls look in different places: `subjectReport` reads what a reader reads, each segment's current generation,
while `eraseSubject` also searches older generations, a tombstoned segment's objects and a first load's object that
never published. So the ledger can name a segment the report did not.

`eraseSubject` needs a store built on a backend, because it writes generations. `subjectReport` needs one too, for
the registry it lists. A store missing what a call needs throws `UnsupportedError`: a store built on a bare storage
driver (`IStorageDriver`) or a pre-built `StorageChunkSource` instead of a backend cannot run either. Build it on `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
`AzureBlobStorage`.

**What it costs.** `subjectReport` costs one pass over the registered segments. `eraseSubject` costs more: a segment
whose current generation lacks the id is searched generation by generation, so a fleet that keeps long histories
pays for every one. The per-op budget is charged for them. The scan runs at a bounded `concurrency` (default 8; pass
`{ concurrency }`), so it is quick over a large fleet without stampeding your backend. A fault on one segment never
aborts the ledger.

An erasure that deletes an object a load may still publish (one above the pointer, a first load's object on a segment
with no generation yet, or one no read of the segment can open) writes the segment's registry row first, to renew its
`pointerId`, and reads the row again before each such delete. On a segment with no generation yet, with `n` objects to
delete, that is `3 + n` registry reads and 1 write where an erasure that deletes nothing reads the row once (counted
at the registry the S3, GCS and Azure Blob drivers share, which reads a row's version before it writes it). The cost
is paid once per affected segment: the objects are gone, so the next run reads the row once and writes nothing. A
segment whose objects no read can open is affected whatever id is erased, so the first `eraseSubject` over a fleet
pays one renewal and the deletes for each such segment, and the next pays nothing for them. A renewal that gets no
answer waits before each fresh write, under 500 ms, then 1 s, then 2 s, so up to 3.5 s in all, one wait after another
within a segment; `eraseSubject` erases `concurrency` segments at once (8 by default), so up to 8 segments can wait
side by side. A renewal on a segment with a generation moves its row's `pointerId`, so every store reading that
segment opens its current generation again once, at its next refresh: one more tail read each where the generation's
index fits in that read, and a range read for the index as well where it does not.

## Reading the ledger

`erased: true` means the call listed the segment's bucket and read what is left, and **no generation of the segment
holds the id**, above the pointer or below it. When the current generation did not hold the id, nothing was
rewritten, so that entry has no `generation`, and the audit event is `segment.collect` rather than `segment.rewrite`.

`erased: false` means this run did not erase the id from that segment. That is not the same as "the id is still
there", and `note` says why:

| `note` | Means | What to do |
|---|---|---|
| `'superseded'` | Another writer moved the pointer off the generation the rewrite was derived from, or replaced an object the call meant to delete. Usually a load; it can also be another erasure or an operator's `rollback`. On a segment with no generation yet, any other write of its row before the erasure renewed it reports it too: a first load's publish, a `setRetention`, another erasure's renewal. | Re-run. It erases the id if it is still present, and lists nothing for the segment if a racing erasure of the same id already removed it. |
| `error: <message>`, a transient storage or registry fault | The storage failed under it, or a registry write got no answer that reading the row could settle; the generations that write was to guard were not deleted. | Re-run. |
| `error: <message>`, the budget ran out | The call's `budget` ended before all the segment's generations were searched. | Re-run with a higher `budget`. |
| `error: <message>`, a missing keystore | The segment is encrypted and the store has no keystore. | Wire the keystore. |
| `error: <message>`, `requireEncryption: segment … is cleartext` | The store was built with `encryption: { required: true }`, and the rewrite would write a cleartext generation. | Erase it from a store built without `required`, or drop the segment. |
| `error: <message>`, a `NotFoundError` saying the generation is another object than its registry row names | The object under the row's current generation is not the one the row's summary names by its fingerprint: put back from outside the library, or restored from another point than the registry. The erasure read none of its ids and wrote nothing. That object stays in the bucket and may hold the id, and every read that opens it refuses it. | Re-running will not help. Run `checkConsistency({ summaries: true })`, which reports the segment as `summary-mismatch`, restore the registry and the bucket to one coherent point ([disaster recovery](disaster-recovery.md)), then re-run the erasure. |
| `error: <message>`, an `IntegrityError` naming a chunk, or saying authentication failed | That segment is corrupt: a chunk holds a value no chunk can, or a generation sealed under the segment's own key has a chunk that does not open under it, or the current generation does not open under it at all. The rewrite refused to copy the corruption into a new generation, the erasure deletes nothing on account of that error, and no erasure happened on it. | Investigate; re-running will not help. |
| `error: <message>`, a `WriteConflictError` | The erasure could not remove a generation holding the id and refused to claim it had. Often a rewrite had already published, so part of the work landed (a rollback onto a generation that still holds the id, landing while the rewrite collects, is one way). It also fires on the collect-only path, where nothing is published at all, and on a segment with no generation yet, when the erasure found a first load's object to delete and a first load wrote another, holding the id or sealed under its own key, after the erasure listed the bucket; when that load published before the erasure's last read of the row, the entry is `'superseded'` instead. | See what a re-run reports instead of assuming the job finished. |

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
  found only there, is refused, and so is a first load still writing onto a segment with no generation yet, when the
  id is found in its object: the erasure renews the segment's row (its `pointerId`) before it deletes that object, and
  a load that found no row is refused by any row at all, so the load's publish meets another writer rather than
  naming an object that is gone.
- **Never put a subject's id in a generation's metadata.** An erasure rewrites the ids and carries the metadata over as
  it is, without scanning it: it would copy an id there into the new generation, and the registry row holds a copy of
  the current generation's metadata too. Put a version, a time or a run id in it, and nothing that names a person.
- **Do not roll the segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto
  a generation the erasure did not rewrite. Roll back before the erasure starts or after it returns, and re-run an
  erasure that reports otherwise once the pointer is where you want it.
  [How it stays correct](#how-it-stays-correct) says what each landing point reports.

**On an encrypted store, an erasure of any id refuses an encrypted first load in flight that has written its object onto
a segment made ahead of its data.** A segment whose row `setRetention` made before its first load holds no key until
that load publishes, so the erasure holds none either, and cannot search the object such a load has written: it counts
that object as a holder, whatever id it is erasing. So `eraseSubject` of any id, over the namespaces it scans, renews
each such segment's row, deletes the object, and the load is refused `superseded`, whether or not its data held the id;
the segment is not listed in the ledger, since the id was not found there. Re-run the load. It does not reach a first
load onto a segment with no row (`eraseSubject` scans rows), a load onto a segment that has a generation (its object is
under the row's key, so it is searched), or a cleartext first load whose object does not hold the id. And once it has
found such an object, an encrypted first load that writes its object onto that segment before the erasure's last look at
the bucket makes the entry an `error: …` note (`WriteConflictError`), or `'superseded'` when that load published before
the erasure's last read of the row: re-run the erasure. Pausing loads while you erase, as the first rule says, avoids
both.

**An object no read of the segment can open goes too, whatever id is erased.** On a segment with a key, an object
sealed under a key its row does not hold opens for no read of the segment: the object of a first load that lost the
race to the one that published, or that crashed before its publish, each under a key it made and never stored. On a
cleartext segment with a generation, so does any encrypted object: a key is made only for a segment's first
generation, so it is a first load's that made one and crashed, or lost the race to a cleartext first load. The erasure
cannot search it, so it counts it as a holder wherever it meets one, except as the current generation, which is never
deleted for this, and under a tombstone, where it is no holder and goes only with everything there, when another
object under the tombstone holds the id. Above the pointer, and below it when no searched generation holds the id, it
deletes each one by name, under the same renewal of the row and read of the row before each delete as any holder above
the pointer, and the generations kept below the pointer that were searched and found clean stay; below the pointer
beside a searched holder, it goes with the `keep: 0` collection that takes every generation there. Each is listed in
`collected`, and on its own it does not make the answer `erased: true`. Which objects those are is read from where the
object fails to open, since an object does not name its key: on a segment with a key, such an object is exactly one
whose footer and checksums pass and whose index then fails authentication under the row's key for that segment and
generation. So an index someone altered and gave new checksums counts as one too, and goes the same way. One whose
index the segment's key opens is the segment's own, and when a chunk of it then does not open, that is corruption,
which the erasure reports with `IntegrityError`, deleting nothing on account of that error; so is a footer or a
checksum that does not match, and an object cut short.

**While encrypted first loads run, such a segment can keep an erasure asking for a re-run.** Once an erasure has found
an
object to delete on a segment with no generation yet, it looks at the bucket again before it answers, and an encrypted
first load that writes its object between the erasure's listing and that last look leaves an object the erasure cannot
search, so the erasure throws `WriteConflictError` and asks for a re-run, even when that load read the row after the
renewal and is not refused by it. A re-run that runs before such a load
publishes renews the row again, refuses the load and deletes its object; one that runs after reads the generation the
load published like any other. A steady stream of such loads can keep that up: pause loads of the segments you erase
from, as the first rule says, and re-run the loads an erasure refused.

**After a registry restore, look before you erase.** Run `checkConsistency({ summaries: true })`: it reports a row
whose pointer names a missing object, or another object than the row's summary names ([disaster
recovery](disaster-recovery.md#restore-procedure)). It does not look in the bucket of a row with no generation, so
also list `store.generations(ref)` for each row whose `currentGen` is `null`. Objects there are a first load's in
flight, or what is left of a state of the row the restore went back past: an erasure treats them all as a first
load's, and deletes each that holds the id, and every one it cannot open (on a row with no key, every encrypted one),
whatever the id. Restore the row to the state that names them, or load them again, before you erase.

## Who stops seeing the id, and when

The erasure is immediate in storage, and immediate in the store that performed it for every read that starts after it
returns: that store drops what it had cached about the segment before returning, so it cannot keep answering from
memory. A read of that store already in progress moves to the rewritten generation, but what it had already taken is the old
generation's, so it can still yield the id from it: up to 32 chunks for `iterate` and `count`, and up to `concurrency` + 1
keys (33 by default) for a combine, the key it is handing out and the `concurrency` keys it had already requested. A
combine or `iterate` reads each operand's chunks as ranges of the object, and
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

A store with a timed refresh keeps each segment's resolution, the row's wrapped keys among it (never an unwrapped
key), for `cache.genTtlMs` from the registry read that made it, whether or not the segment's reader is still open.
Within that time a store whose reader was evicted builds its next read on the kept resolution and unwraps the key from
those wrapped keys through the keystore again, so another store's crypto-shred reaches it once the resolution lapses:
within `cache.genTtlMs`, as the table says. A lapsed resolution is never read from: if the registry read that should
replace it fails with a transient fault, the read fails too, unless the store still holds the segment in its reader
cache, which rides out the outage as above until the reader cache lets it go: what it rides out on is not kept.

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
collection that follows an erasure rewrite deletes every generation below the new one, a leased one included; the
rewrite clears the row's leases. An erasure that finds the id only in a generation other than the current one deletes
that generation, leased or not, and leaves the row's leases as they are (the row writes it makes, the renewals before
it deletes a generation above the pointer or an object it cannot search, renew the row's `pointerId` and keep them),
so an entry for a generation it deleted stays in the list until the entry's own time ends or the next publish or lease
write prunes it: it spares nothing, since the object is gone, and it counts toward the 64 places until then. A
`destroySegment`, a `dropSegment` and a retention expiry delete every generation and leave no lease on the tombstone.
So erasure, shred, drop and retention always win, and a lease never holds an erased subject's data past the bounds in
the table above.

A lease written while an erasure is under way does not delay it. A lease write moves the row's token, which an erasure
rewrite is fenced on, but a row that differs from the one the rewrite read only in its leases does not refuse it: it goes on
against the row it finds, without streaming the object again, and so does the re-proof before each delete above the pointer
([how a load stays correct](loading.md#how-it-stays-correct) states the rule). A change of anything else refuses, and
`eraseSubject` reports `superseded` as it always has: run it again.

What a lease does not change is when a reader stops seeing the id. A leased handle in another store answers as any
pinned handle does until its lease ends, and then every read of it throws `LeaseExpiredError`.

## What an erasure does not reach

The **metadata** of a generation: the rewrite carries it over unchanged, and the row's summary of the new generation
holds it again, with the id count one smaller. Neither is scanned for the id. An object whose metadata block was
stripped is another object than the row's summary names, since its size is not the one the summary records, so the
erasure refuses it with `NotFoundError` and writes nothing ([the ledger](#reading-the-ledger)). A fingerprint is a size
and a checksum, which whoever can write the bucket can match on purpose: past a forged one, on an encrypted segment,
the object is rewritten with the metadata of the row's sealed summary, since the block's presence is not authenticated
and the summary is.

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
id, unless no read of the segment can open it, and then it goes whatever the id ([the effect across a
fleet](#two-rules-while-you-erase)). A rewrite is numbered above everything, so its `keep: 0` collection takes every
older generation, above the pointer or below.

**Racing writers.** Another writer that moves the pointer off the generation the rewrite derived from can be a load,
another erasure, or an operator's `rollback`. Another erasure collects with `keep: 0`, so it can delete the generation
this rewrite was still streaming, or the object it had just written. Two erasures of different ids racing on one
segment are safe: the loser's rewrite still holds the winner's id, and when it sits above the winner's pointer the
loser deletes it before returning, once its footer proves it the loser's own object.
The outcome is read off the registry row. A segment whose row is tombstoned
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
  `error: ...` note. On a segment with no generation yet, a rollback (with `allowForward`) onto a first load's object
  while the call deletes those objects is reported as `'superseded'` too, and the object stays. On a row with no key,
  which is how `setRetention` makes one, such a rollback accepts only a cleartext object: it refuses an encrypted
  target there.
- In the last instant before a delete, a rollback onto the generation being deleted leaves the pointer on a missing
  object, which `checkConsistency()` reports: a generation above the pointer; on a segment with no generation yet, a
  first load's object that a rollback with `allowForward` accepts (on a row with no key, only a cleartext one); or an
  object below the pointer that the segment's key does not open, which only a rollback with no key at hand moves onto.
  The call reads the row just before each delete; one round trip remains between that read and the delete, and a
  condition on the object cannot close it, since the pointer then names the very object the call read. Neither call
  reports it: the rollback's own check ran before the delete, so it returns success, and the erasure answers as it
  would have without the rollback (`erased: true` when the object held the id and nothing left in the bucket holds it,
  which is true of the bucket). Reads that open the segment's current generation then fail with `NotFoundError` until
  a rollback moves the pointer to a generation in the bucket, which `store.generations(ref)` lists.

**A number taken again during an erasure.** A generation number can be taken again once its object is deleted. While
a call deletes a holder by name, above the pointer or on a segment with no generation yet, another erasure of the same
id can delete that holder first, and a load that read the row after both erasures renewed it can then take the
number, write its own generation under it and publish it: nothing refuses that publish. So each such delete names the
object the call read: it passes the version the storage driver reported on the read that made the object a holder
(`delete(key, { ifVersion })`), the read of an object the call searched, or, for one it cannot search, the read of its
footer that found it encrypted under a row with no key, or the open whose index failed its authentication under the
segment's key. A driver that reports `conditionalDelete` deletes only that object. The load's generation stays, the
call deletes nothing more, and it reports `erased: true` when nothing left holds the id, or the reason the row gives,
`'superseded'` as a rule. A refused rewrite that deletes its own object again above the winner's pointer (see racing
writers above) meets the same race, another erasure deleting that object as a holder and a load taking its number, and
does the same: it first proves the object under its number is the one it wrote, by a read of its footer, keeps one
that is gone, is another object or cannot be read, and passes the version that read reported, so the load's
generation stays. A delete the driver refuses there is a fault of the cleanup, and the call reports what the row says.
Any other fault of that delete is thrown in place of the answer, as any storage delete fault of an erasure is. Which
drivers report it:

| Storage | `conditionalDelete` |
|---|---|
| `MemoryStorage` | yes: the check and the removal are one step |
| `AzureBlobStorage` | yes, by default: a Delete Blob under `ifMatch` |
| `S3Storage` | yes when its client sends to an AWS S3 host, by default: a `DeleteObject` under `If-Match`. Read from the client on the first such delete, so `capabilities()` says `false` until then, and stays `false` when the client cannot be resolved (no region). Off for any other host, MinIO included, unless you set `conditionalDelete: true` |
| `GcsStorage` | only with `conditionalDelete: true`: a delete under `ifGenerationMatch`. Off by default, since no run against GCS has shown it applies the precondition to a delete, so on GCS the window below stays open unless you set it |
| `LocalFsStorage` | no: a filesystem has no delete conditioned on which file is under a path |

On a driver that does not report it, a delete in that window removes the load's generation, and the pointer names a
missing object, which `checkConsistency()` reports: the race of two erasures and a load stays open there, above the
pointer, on a segment with no generation yet and at a refused rewrite's discard alike. These limits hold on every
driver:

- The condition names the object, not the row, so it does not cover the rollback in the last bullet above: the pointer
  then names the very object the call read.
- On S3 the version is the object's ETag, which for an object stored without SSE-KMS or SSE-C is computed from its
  bytes. Two objects with the same bytes, each stored whole in one request, or each in parts of the same sizes, share
  one, so a load that writes, under the number taken again, exactly the bytes of the holder (the same ids and metadata,
  in the clear) is not told apart from it. An encrypted generation written through the shipped keystore seals every
  chunk under a fresh random nonce, so its bytes differ from any other write's.
- A refused rewrite whose row is `destroyed` deletes its own object by number, and so does a refused load that finds
  its row unchanged, changed only in its leases, or `destroyed`: the decision comes from the row, and the write reports
  no version of what it wrote. Under a `destroyed` row every writer is refused until the row is purged, so no load
  takes the number again. Under a row that is unchanged or changed only in its leases, the round trip between the
  load's read of the row and its delete remains: if another erasure deletes that object as a holder and a load takes
  its number in it, that delete removes the load's generation.
- Generation collection, the `keep: 0` collection an erasure runs among it, deletes by number what a listing or the
  row's list of kept generations names, below the pointer, with no object read behind the decision. A number below the
  pointer is taken again only after the pointer moves down (a rollback, or a purge and re-create), inside the round
  trip between the collection's re-read of the row and its delete, which is the rollback case above.
- `dropSegment`'s sweep, and the retention sweep's collection of a tombstoned segment, delete by number every object a
  listing names under a `destroyed` row. Every writer refuses that row, so a number there is taken again only once the
  row is purged and the name re-created.

**The result of erasing one segment.** `eraseSubject` runs `eraseIdFromSegment` (on `@cloudbitmaps/core`, for flavor and
driver authors) over every registered segment, and each ledger entry is that function's result.

- `erased: true` means no generation of the segment holds the id, checked by listing the bucket and reading what is
  left. Otherwise `reason` is `'absent'`, `'destroyed'`, `'no-generation'`, `'not-member'` (no generation in the bucket
  holds it) or `'superseded'`.
- A tombstoned row has its bucket searched too. A crypto-shred leaves objects no key opens, but a cleartext destroy, a
  drop whose sweep left something, or a write that landed after it leaves objects anyone can read: when one holds the
  id, every object under the tombstone is deleted and the entry reads `erased: true`. Otherwise the result is
  `'destroyed'`, and the objects are left to the retention sweep's purge or a re-run of the drop.
- An object no read of the segment can open (on an encrypted segment, one sealed under a key the row does not hold; on
  a cleartext one with a generation, an encrypted one) is deleted as a holder whatever the id, wherever the call meets
  it but as the current generation or under a tombstone, and listed in `collected`; only a searched generation that
  held the id makes the entry `erased: true` ([the effect across a fleet](#two-rules-while-you-erase)). An object the
  segment's own key opens whose chunk does not is corrupt: `IntegrityError`. One whose chunk read fails because another
  object is under the number by then (a load took it after another erasure deleted the one listed) is not: the object
  the call listed is gone, as when a collector takes it.
- A row with no generation yet (one `setRetention` created before the first load) has its bucket searched too, since a
  first load's object can be there: its load still running, or one that crashed between its write and its publish.
  When objects hold the id, the call first renews the row's `pointerId`, with a write that names the pointer at the
  value it has, none, so a load that wrote one is refused `superseded` at its publish. Then it deletes each object
  that holds the id, reading the row before each delete and stopping if anything but its leases has changed, and the
  entry reads `erased: true`, with those generations in `collected`. Each delete passes the version of the read that
  made the object a holder: another erasure of the id can delete it first, and a load that read the row after both
  renewals take its number and publish, and on a storage driver that reports `conditionalDelete` this call's delete is
  then refused, the call deletes nothing more, and the load's generation stays; on one that does not, the delete
  removes it ([a number taken again during an erasure](#how-it-stays-correct)). So a crashed first load's object is
  erased as any other holder is. On an encrypted store such an object is sealed under a key its load has not published, so it cannot
  be searched: it counts as a holder whatever the id, and is deleted too, and with only such objects the result is
  `'no-generation'` with them in `collected` ([the effect across a fleet](#two-rules-while-you-erase)). A row with no
  object that holds the id is `'no-generation'`, under `requireEncryption` too, and the call writes nothing. A load
  that read the row before the renewal is refused at its publish whenever it writes its object. One that writes it
  between the call's listing and its last look at the bucket leaves a holder that look finds: that throws
  `WriteConflictError`, and a re-run renews the row again and deletes it. One that writes it after the last look
  leaves it in the bucket, where no pointer names it and the next erasure of that id finds it: `erased: true` was true
  at the call's last look at the bucket, and is not a promise about objects written later. A load that read the row
  after the renewal publishes its own object, which the call never deletes: do not load the id while erasing it.
- `'superseded'` means another writer moved the pointer off `fromGeneration`, or replaced an object this call meant to
  delete, while the call was in flight: a load, another erasure, or a rollback. On a segment with no generation yet it
  also means another write of the row (a `setRetention`, say) landed before the call renewed it. When an object was
  replaced, the object this call meant to delete was deleted, as a holder by another erasure (above the pointer, or on
  a segment with no generation yet) or by the refused load that wrote it, and a load stored another object under its
  number, so the storage driver's conditional delete refused this call's delete, whether or not the pointer moved. It means this call did not erase the id, not
  that the id is still there. Re-run, and if a racing erasure of the same id got there first, the re-run reports
  `'not-member'`.
- A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had
  just written. The reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` once the
  tombstone's objects are searched as a fresh call searches them (`erased: true` when one still held the id and was
  deleted), and one purged by the retention sweep reports `'absent'`.
- A `NotFoundError` is raised only when the pointer still names its generation and that generation's object is
  missing, the forbidden `missing-storage-generation` state, or is another object than the row's summary names by its
  fingerprint. No re-run fixes either: `checkConsistency({ summaries: true })` reports both.
- `collected` lists the generations this call deleted: evidence for the physical half of an Art. 17 erasure, and what
  to keep if you build a proof-of-deletion artifact. `eraseSubject`'s ledger entry does not carry it: the
  `segment.collect` audit event does, for a segment where the call deleted generations and rewrote none, and that
  event is also the only record of a segment where the call deleted only objects it could not search, which the ledger
  does not list. It can legitimately be empty on a successful erasure, when a concurrent collector removed the holding
  generation first. `erased: true` is a claim about the bucket, not about who emptied it.
- A call that could not collect throws instead of reporting `erased: true` over bytes still there:
  `WriteConflictError` when the collect could not prove the segment was still the same one (re-created, or its row
  purged), or when a generation still holding the id is left in the bucket. A chunk holding an out-of-range value throws
  `IntegrityError` instead of being re-encoded into the new generation, so a corrupt segment is reported as corrupt, not
  erased.

