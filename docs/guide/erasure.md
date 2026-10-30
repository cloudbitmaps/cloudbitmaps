# Subject access and erasure

Two calls answer "what do you hold about this person?" (GDPR Art. 15) and "forget this person everywhere" (Art. 17):
`store.subjectReport(id, scope)` and `store.eraseSubject(id, scope)`. Both scan the registered segments, so build the store on the
backend your loads used.

## Find an id, and erase it

Both calls need a scope. Ids live in one global 32-bit space shared across namespaces, so a call with no namespace
would sweep every tenant. To keep that from happening by accident, pass either a `namespace` or an explicit
`{ allNamespaces: true }`. A call with neither, or with both, throws `ValidationError`: they are alternatives, and a
call that names a namespace and `allNamespaces: true` is unclear about which one it means. The types refuse the pair
too.

A segment loaded with no `namespace` is in no namespace you can name: only `{ allNamespaces: true }` reaches it.
`_default`, the label the export tool and the disaster-recovery samples print, and the bucket's object keys use, for those segments, is an ordinary
namespace name here, and passing it scans a namespace of that name, not them. A `namespace: '_default'` call over a
fleet whose segments were loaded with no namespace lists none, and its `scannedSegments` is `0`.

<!-- typecheck-skip: a fragment: the page leaves `userId` to the reader -->
```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

// Art. 15: which segments is this id in? (scoped to one tenant)
const report = await store.subjectReport(userId, { namespace: 'eu' });
report.segments; // [{ segment, namespace }, ...]    report.scannedSegments: the completeness denominator
report.tombstones; // destroyed segments whose leftover objects still hold the id

// Art. 17: remove the id everywhere, across all tenants (the explicit fleet-wide acknowledgement)
const audit = new RecordingAuditSink(); // or your own audit sink: see Observability
const ledger = await store.eraseSubject(userId, { allNamespaces: true, audit });
ledger.erasedFrom; // [{ segment, namespace, erased: true, fromGeneration: 4, generation: 5 }, ...]
```

`ledger.erasedFrom` is your **erasure ledger**, the proof of deletion. It is a return value only, so persist it or
route it to your audit sink. When you pass `audit`, the store also emits an event per segment it erased the id from:
`segment.rewrite` when it rewrote the current generation, `segment.collect` when it only deleted other generations.
Segments the id is not in are not listed, except a segment the call cannot search: an encrypted one on a store with no
keystore, or a cleartext one on a store built with `encryption: { required: true }`. It is listed as an `error:` entry
whatever id you erase, because the call cannot tell whether the id is there. A segment where the erasure found the id in nothing it could search, and
deleted only objects no read of the segment can open ([below](#three-rules-while-you-erase)), is not listed either: the
audit sink gets `segment.collect` for it with no `fromGeneration`, and that event is the only record of the deletion.
The two calls look in different places: `subjectReport` reads what a reader reads, each segment's current generation,
and searches each destroyed segment's leftover objects as the erasure does, listing one that holds the id under
`tombstones`. A cleartext `destroySegment` (`allowCleartext`), or a `dropSegment` whose sweep missed an object a load was
still writing, leaves the id readable in the bucket though no read resolves the segment. A crypto-shredded segment's own
objects are sealed under a key no row holds and are never a holder, so it is listed only when an object left under it in
the clear holds the id (a cleartext writer's leftover, say). `eraseSubject` also searches an active
segment's older generations and a first load's object that never published, so the ledger can still name a segment the
report did not. `subjectReport` reads each segment and throws on the first it cannot read (`KeyUnavailableError` for an
encrypted segment on a store with no keystore, or for a cleartext one under `required`), rather than return a report
that leaves it out; answer an access request over a mixed bucket from a store that can read every segment.

`eraseSubject` needs a store built on a backend, because it writes generations. `subjectReport` needs one too, for
the registry it lists. A store missing what a call needs throws `UnsupportedError`: a store built on a bare storage
driver (`IStorageDriver`) or a pre-built `StorageChunkSource` instead of a backend cannot run either. Build it on `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
`AzureBlobStorage`.

**What it costs.** `subjectReport` costs one pass over the registered segments, plus, for each destroyed segment in
scope, one listing and an open of each object under it until one holds the id (two tail reads for an encrypted object,
which never does), charged to the budget as `eraseSubject` charges them. Measured on the in-memory backend: a drop that
deleted everything costs 1 request; a cleartext destroy with 3 objects costs 7 (one listing, then a tail read and a
chunk read for each object); with 10 objects, 21; a crypto-shred with 10 objects, 21 (two tail reads each, no chunk
read). A fault reading a destroyed segment's leftover objects (the listing included, after the store's retry), or a
budget that runs out, rejects the whole report rather than leaving the segment out, so one leftover object that cannot
be opened makes every report over its scope reject until it is removed: `store.generations(ref)` lists what is left
under the segment, and `store.dropSegment(ref, { confirmSegment })` deletes it (a drop of an already destroyed row sweeps
again). `eraseSubject` costs more: a segment
whose current generation lacks the id is searched generation by generation, so a fleet that keeps long histories
pays for every one. The per-op budget is charged for them, once for each generation however often the call opens
it: a retry of a failed read, or a later open of a generation the call already opened, costs no further unit. The scan runs at a bounded `concurrency` (default 8; pass `{ concurrency }`), so it is quick over a large fleet
without stampeding your backend. A fault on one segment never aborts the ledger.

An erasure that deletes an object a load may still publish (one above the pointer, a first load's object on a segment
with no generation yet, or one no read of the segment can open) writes the segment's registry row first, to renew its
`pointerId`, and reads the row again before each such delete and once after the last. On a segment with no generation
yet, with `n` objects to delete, that is `4 + n` registry reads and 1 write where an erasure that deletes nothing reads
the row once (counted
at the registry the S3, GCS and Azure Blob drivers share, which reads a row's version before it writes it). Objects
there that the erasure searched and found clean add no registry read: after its last listing of the bucket the erasure
opens each of them again (a tail read, and a chunk read where its index lists the id's chunk), which costs no budget
unit more ([reading the ledger](#reading-the-ledger)). The cost is paid once per affected segment: the objects are gone, so the next run reads the row once and writes nothing. A
segment whose objects no read can open is affected whatever id is erased, so the first `eraseSubject` over a fleet
pays one renewal and the deletes for each such segment, and the next pays nothing for them. A renewal that gets no
answer waits before each fresh write, under 500 ms, then 1 s, then 2 s, so up to 3.5 s in all, one wait after another
within a segment; `eraseSubject` erases `concurrency` segments at once (8 by default), so up to 8 segments can wait
side by side. A renewal on a segment with a generation moves its row's `pointerId`, so every store reading that
segment opens its current generation again once, at its next refresh: one more tail read each where the generation is cleartext
and its row has a summary (which sizes the read to take the index), and a range read for the index as well where it is
encrypted, or the row has no summary, and the index does not fit in that read.

An erasure that finds the id only in generations below the pointer, with nothing to delete by name, reads the row ahead
of its collection and writes it once when the row's ledger of known generations names a generation the collection will
delete: the write takes those names out of the ledger before anything is deleted
([how an erasure stays correct](correctness.md#how-an-erasure-stays-correct)). On a row with no usable ledger it also reads the row once more after the
collection, in case a load started a ledger meanwhile. Every erasure that finds something to delete then lists the
bucket for its receipt. When that listing names the generation it found current, or its own rewrite, it reads the row
once more, a single read whatever else is listed, and skips that generation only while the row's ledger names it with
the checksum of the object it read or wrote; every other generation it found clean it opens again, as the search
opened it ([reading the ledger](#reading-the-ledger)). Counted at an object-store registry on the in-memory
backend, for a segment with one older generation that holds the id: 8 requests that read and 1 that writes when the
ledger names it, 7 and none when a usable ledger does not, and 8 and none on a row with no usable ledger, where the
erasure also opens the current generation again, since no ledger vouches for it. An erasure that rewrites the current
generation costs 10 reads and 1 write. The write moves the row's token, so a load running on that segment at that
moment is refused, as any load is by a write that landed while it ran (`superseded`: load again). It also leaves a timing
signal in the registry, which [the privacy note](../../PRIVACY.md) describes.

## Reading the ledger

`erased: true` means the call listed the segment's bucket and read what is left, and **no generation of the segment
holds the id**, above the pointer or below it. When the current generation did not hold the id, nothing was
rewritten, so that entry has no `generation`, and the audit event is `segment.collect` rather than `segment.rewrite`.

That last read opens again every generation the call had already found clean, but for two: the current generation it
read and its own rewrite. Each of those is skipped only while the segment's row, read after the listing, names it in
its ledger of known generations with the checksum of the object the call read or wrote. A generation number can be
taken again once its object is deleted: another erasure can delete a generation this call found clean and a load take
its number, a lifecycle rule can delete one outside the library, and a drop, a purge and a first load of the name start
numbering at 0 again. The object under that number is then another one, and the call reads it, so when it holds the id
the entry is `'superseded'` or an `error:` note with a `WriteConflictError`, never `erased: true`. Only the current
generation and the rewrite are taken on the row's word, because no writer of the library leaves the row naming one of
them with an object that is gone; a ledger entry for any other generation can outlive its object (a load that rebuilds
a ledger from the bucket records what it read there, and a lifecycle rule leaves the row as it was). Each of these
needs a load of the id while it is being erased, which the [first rule](#three-rules-while-you-erase) asks you not to
run. If the read of the row fails, the call skips nothing and opens every generation listed, so the answer stands.

`erased: false` means this run did not erase the id from that segment. That is not the same as "the id is still
there", and `note` says why:

| `note` | Means | What to do |
|---|---|---|
| `'superseded'` | Another writer moved the pointer off the generation the rewrite was derived from, replaced an object the call meant to delete, or beat the call's write to the segment's row five times in a row before it deleted anything (nothing was deleted). Usually a load; it can also be another erasure or an operator's `rollback`. Two erasures of different ids on one segment race each other: both can number the same next generation, the second put is refused as the write-once rule says, and that one reports `'superseded'` with nothing written or deleted. On a segment with no generation yet, any other write of its row before the erasure renewed it reports it too: a first load's publish, a `setRetention`, another erasure's renewal. A row that loses its pointer after the call found one (purged and created again, or written by hand without a pointer) and a row purged and created again as another incarnation of the name report it as well: the call found a holder there and stopped before deleting it, so the bucket can still hold an object that holds the id. On a registry that reports write tokens, a rewrite counts as published only when the row's pointer is over its own write: another load of the same ids can take the rewrite's number once an erasure has freed it, and the rewrite is then `'superseded'`, with no `segment.rewrite` event and none of the generations the row names deleted. The same can happen to a rewrite whose own write landed and was then followed, ahead of the rewrite's next read of the row, by a write that renews the row's `pointerId` over it (an erasure's renewal, or a rollback back onto the generation after a publish or another rollback moved the pointer off it): it cannot tell that from another load's write, so it reports `erased: false` and deletes nothing, and a re-run erases. On a registry that does not report write tokens, a rewrite whose write got no answer counts as published when the footer of the object under its number is the rewrite's own, the write identity it drew included: another load's object there, of the same ids or others, is `'superseded'` and deletes nothing. An object whose identity field is all zero (one written with zero entropy) can carry the rewrite's footer, and then the rewrite stands, with a `segment.rewrite` event for a generation another writer may have published. | Re-run. It erases the id if it is still present, and lists nothing for the segment if a racing erasure of the same id already removed it. |
| `error: <class>: <message>`, a transient storage or registry fault | A request failed under it, past the call's retries: a registry write that got no answer that [reading the row](correctness.md#row-write-settled) could settle (the generations that write was to guard were not deleted), or a refused rewrite's read of its own object, to prove it its own before it deletes it, that still failed after the read retry (the object stays, and may hold an id another erasure reported gone), or a storage delete whose object was still there when the call read it back, or whose read failed too. Generations deleted before it stay deleted. | Re-run. A re-run that lists nothing for the segment found the id gone: a delete whose read failed, or that landed after it, took it. Keep this entry's error with your ledger as the record of that deletion. |
| `error: BudgetExceededError: <message>`, the budget ran out | The call's `budget` ended before all the segment's generations were searched. | Re-run with a higher `budget`. |
| `error: KeyUnavailableError: <message>` saying the segment "is encrypted, and the erasure has no keystore" (a missing keystore) | The segment is encrypted and the store has no keystore, so the call cannot open its key. It is listed whatever id you erase. | Wire the keystore (`encryption.keystore`). |
| `error: KeyUnavailableError: requireEncryption: segment … is cleartext but encryption is required` (the same class as the missing keystore: tell the two apart by the message) | The store was built with `encryption: { required: true }` and the segment is cleartext, so the erasure did not read its current generation, as `required` refuses a cleartext read. It is listed whatever id you erase. A cleartext object left under a tombstone, or a first load's object on a segment with no generation yet, is still searched and deleted. | Erase it from a store built without `required`, or drop the segment. |
| `error: NotFoundError: <message>`, saying the generation is another object than its registry row names | The object under the row's current generation is not the one the row's summary names by its fingerprint: put back from outside the library, or restored from another point than the registry. The erasure read none of its ids and wrote nothing. That object stays in the bucket and may hold the id, and every read that opens it refuses it. | Re-running will not help. Run `checkConsistency({ summaries: true })`, which reports the segment as `summary-mismatch`, restore the registry and the bucket to one coherent point ([disaster recovery](disaster-recovery.md)), then re-run the erasure. |
| `error: NotFoundError: <message>`, saying an erasure deleted a generation and another writer moved the pointer onto it | A rollback landed between the erasure's read of the row and one of its deletes, onto the generation it was deleting (or, on a storage driver that ignores a delete's condition, a load took that number again and published, [below](#reading-the-ledger)), and the row still named it, with no object under it, when the call read the row again after a wait. The pointer may then name a missing object, and while it does every read of the segment fails; a rollback that found its target gone puts the pointer back itself, and the segment is then whole. Nothing restores a deleted object. On the rewrite path the call had published and sent `segment.rewrite`, and its collection stopped at that generation. With nothing rewritten, when nothing left in the bucket held the id, the deletion was recorded first, as a `segment.collect` event; with a holder left, nothing was recorded. | Check first: `store.generations(ref)` marks the current generation and lists the bucket, and `checkConsistency()` reports the segment as `missing-storage-generation` while the pointer names a missing object. Roll back to a generation still in the bucket only if it does. Then re-run. A re-run that lists nothing for the segment found the id gone: keep this entry's error and the `segment.collect` event with your ledger. |
| `error: IntegrityError: <message>`, saying a chunk is corrupt, or that authentication failed | That segment is corrupt: a chunk holds a value no chunk can, or a generation sealed under the segment's own key has a chunk that does not open under it, or the current generation does not open under it at all. The rewrite refused to copy the corruption into a new generation, or the search of the other generations for a holder of the id refused a chunk it read there (a chunk is range-checked wherever the erasure reads it, so it is never taken for "does not hold the id"), the erasure deletes nothing on account of that error, and no erasure happened on it. The message says what is wrong, never the value or the chunk key (part of the id being erased). | Re-running will not help. When the corrupt chunk is in an old generation (below the pointer, or above it and never published), that object blocks every erasure of an id in the same chunk: inspect it, and once it is confirmed unwanted, delete that generation's object from the bucket (`segment.<gen>.crbm`) and run the erasure again; a corrupt current generation is restored from a good copy or reloaded. |
| `error: WriteConflictError: <message>` | The erasure could not remove a generation holding the id and refused to claim it had. Often a rewrite had already published, so part of the work landed (a rollback onto a generation that still holds the id, landing while the rewrite collects, is one way). It also fires on the collect-only path, where nothing is published at all, and on a segment with no generation yet, when the erasure found a first load's object to delete and a first load wrote another, holding the id or sealed under its own key, after the erasure listed the bucket; when that load published before the erasure's last read of the row, the entry is `'superseded'` instead. A load of the id that took the number of a generation the erasure had found clean ends the same way, or as `'superseded'` when the erasure saw the row change before its deletes ([above](#reading-the-ledger)). | See what a re-run reports instead of assuming the job finished. |

A fault can also land after a rewrite published. Examples are a storage `delete` fault, a collect that could not prove
the segment was still the same one, and a generation still holding the id when the bucket is listed at the end (such
as a rollback target an operator moved the pointer onto mid-collect). The pointer has then moved, and the re-run
searches every generation in the bucket. It usually reports `erased: true` against the generation it found the id in, and nothing at
all if a racing collector took that generation first, or if this call's own delete of it landed after a fault the call could not settle (its read failed too, or the delete landed after the read): gone, but unreceipted. A storage delete that gets no answer and whose object is gone when the call reads it back is not this case: it counts as deleted, and the call answers `erased: true`.

Re-running is safe and idempotent: a segment the id is no longer in is simply not listed. But "not listed" is not by
itself proof the id is gone. A segment whose registry row was purged is not scanned either, and its objects outlive it
as orphans. `store.generations(ref)` lists those, since it reads the bucket whether or not a row exists, and
`store.dropSegment(ref, { confirmSegment })` deletes them, writing a `destroyed` row first, which
then fences the name. `store.checkConsistency()` and the collection a load runs start from the rows, so neither
reaches them.

## A batch of materializations

A [`store.materializeMany`](loading.md#many-outputs-from-one-pass-materializemany) call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's. An output of a `materializeMany` call can carry an id that was erased while the call ran, for as long as the call ran: the call reads each operand at the generation it pinned, and an output's publish is a load, so an erasure that lands after the chunks were read does not reach what the call holds, unless the output subtracts a pinned operand that the erasure rewrote, which the call re-reads just before the publishes and refuses. An erasure that rewrites a destination before that output's publish starts does not stop the publish, which, subject to the output's own `guard` and the refusal of an empty result over a non-empty destination, writes on top of the erasure's generation; an erasure that lands inside the publish's own write, between its pointer read and its pointer write, makes the publish lose with `WriteConflictError`; after any call that overlapped an erasure, re-run `eraseSubject` and keep both ledgers. `eraseSubject` deletes the generation it rewrites even when a call holds it pinned, so a pin does not outlive an erasure, and an output that still needs a deleted operand generation fails with `NotFoundError`.

A call with a feed reads operands the library never stores, which no erasure can reach, so the guarantee above does not describe it, and it is refused instead. A `materializeMany` call with a feed is refused at its next record, and immediately before each fed output's publish (after the output has waited for its room in the memory budget), once `eraseSubject` has started in this store, one already running when the call began included: nothing is published from operands the call read before the erasure returned, apart from the window below, and the one record in hand when the erasure lands is processed and discarded. The counter it reads is moved at the start and at the end of each `eraseSubject` this store runs, so an erasure that began and finished between two of the call's checks is seen too; `rollback`, `retireExpired` and `dropSegment` do not move it. An erasure that starts after a fed output's last check and finishes before that publish's pointer write is not caught by the counter, and its window is the publish's own object write and pointer write, which lasts as long as the object takes to upload; the fences above still apply to what it touched. Only this store's `eraseSubject` moves the counter such a call reads, so an erasure by any other path (another store, another process, or the free function `eraseIdFromSegment` in this process) is not seen by it, and is bounded by nothing. An id erased from the source of a feed has to be erased there: the library holds none of it.

A dry run (`dryRun: true`) publishes nothing, so no id reaches a generation through it. Its counts describe the operands
as it read them: an erasure between a dry run and the publish that follows it changes what that publish writes, and
the [re-run recipe](loading.md#publish-what-you-reviewed) says what that means for a replayed feed.

<a id="two-rules-while-you-erase"></a>

## Three rules while you erase

- **Do not load the segment while erasing from it.** A load that lands after the rewrite carries whatever its source
  held, and the library cannot know that source was meant to exclude the id. Pause loads of the affected segments for
  the duration, or fix the source first and load after, and let loads already running finish before you start. Every
  load that read the row before an erasure that found the id began is refused as `'superseded'` and never publishes
  what its source held, either by this erasure's write to the row (its [prune of the ledger](correctness.md#ledger-loses-what-it-deletes), or a renewal of the
  `pointerId` when the ledger names nothing) or by an earlier write that changed the row's `pointerId` or ledger since the call read it (a load or
  rollback that moved the pointer, another erasure's renewal or prune; a write of the retention or residency does not count; [when no write is owed](correctness.md#no-write-when-none-owed)); a load that starts during
  the erasure is not covered. A writer that lands during the rewrite is caught and
  reported as `'superseded'`, not as an error. A load still writing a generation above the pointer, when the id is
  found only there, is refused, and so is a first load still writing onto a segment with no generation yet, when the
  id is found in its object: the erasure renews the segment's row (its `pointerId`) before it deletes that object, and
  a load that found no row is refused by any row at all, so the load's publish meets another writer rather than
  naming an object that is gone. The same goes for another erasure: erasures of different ids on one segment race
  each other, one wins and the rest report `'superseded'`. Run them one after another, or re-run each while any of
  its entries says `'superseded'`. An entry with another note is settled by what its row in the
  [table](#reading-the-ledger) says: a re-run for some (a transient fault, the budget), never for others. A segment the
  call cannot search is listed whatever id you erase.
- **Never put a subject's id in a generation's metadata.** An erasure rewrites the ids and carries the metadata over as
  it is, without scanning it: it would copy an id there into the new generation, and the registry row holds a copy of
  the current generation's metadata too. Put a version, a time or a run id in it, and nothing that names a person.
- **Do not roll the segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto
  a generation the erasure did not rewrite. Roll back before the erasure starts or after it returns, and re-run an
  erasure that reports otherwise once the pointer is where you want it.
  [How an erasure stays correct](correctness.md#how-an-erasure-stays-correct) says what each landing point reports.

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
recovery](disaster-recovery.md#restore-procedure)); `generations: true` also holds the older generations the row
knows to the footer checksum it recorded for each. It does not look in the bucket of a row with no generation, so
also list `store.generations(ref)` for each row whose `currentGen` is `null`. Objects there are a first load's in
flight, or what is left of a state of the row the restore went back past: an erasure treats them all as a first
load's, and deletes each that holds the id, and every one it cannot open (on a row with no key, every encrypted one),
whatever the id. Restore the row to the state that names them, or load them again, before you erase.

## Who stops seeing the id, and when

The erasure is immediate in storage, and immediate in the store that performed it for every read that starts after it
returns: that store drops what it had cached about the segment before returning, so it cannot keep answering from
memory. A read of that store already in progress moves to the rewritten generation, but what it had already taken is the old
generation's, so it can still yield the id from it: up to 32 chunks for `iterate` and `count`, and up to `concurrency` + 1
keys (33 by default) for a combine or a count of one. That is the bound: the chunk or key a read is handing out and what it had already
requested, which a `count` that reads chunks (on a source of your own with no index) reaches. A running `iterate` or
combine stops sooner: the erasure invalidates the segment, so before the next key it takes the read looks at its
segments, finds the rewritten generation, lists its chunk keys again from it and drops what it had requested, and so
yields the id only from the chunk or key it is handing out ([a running read plans its keys
again](reading.md#a-running-read-plans-its-keys-again-after-a-move)). On a source of your own that names neither a
version nor a generation it cannot tell, and can reach the bound. A combine or `iterate` reads each operand's chunks as
ranges of the object, and
resolves the segment again before it serves each chunk, one held in its cache included, as a read of that chunk alone
does, so the ranges it had already
requested are dropped when the erasure has landed, not served ([a long call can describe two
instants](reading.md#how-soon-a-reader-sees-a-new-load)). A pinned read in progress does not move to the rewritten
generation: before its next chunk it opens its object again, and fails with `NotFoundError` once the erasure has
deleted it, so it yields no more than that bound either. A pin of a generation the erasure could not remove (its
ledger entry has `erased: false`) finds the object still there, and reads it, the id included, until a re-run of the
erasure removes it. Every other store is a different
question, in this process or another. This library ships nothing that could answer it for you: there is no daemon,
no bus, and no connection between two stores that happen to point at the same bucket.

| | when the id stops being readable |
|---|---|
| storage | on return: the generation holding it is deleted |
| the store that performed the erasure | on return, for every read that starts after it, and its pins then fail; a read already in progress there can still yield it from a chunk it had requested before |
| another store, with a registry and a `cache.genTtlMs` above 0 | within `cache.genTtlMs` (default 2 s), while the registry can be read, for a small generation's chunks too, which its reader holds and serves until the refresh moves it on; an outage of the registry stretches it ([how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load)) |
| `seg.pinAt` of a generation the erasure rewrote, in any store | on return it fails with `NotFoundError`, since the object is deleted (and, with a registry, the row has moved on); during the erasure, between the rewrite's publish and its delete of the old generation, it can still open that generation, and a handle opened then is a pin, covered by the rows for the store that performed the erasure and for a pinned handle in another store |
| a `materializeMany` call with a feed, and an erasure by any path but this store's `eraseSubject` | **no bound**: the call is refused only by this store's `eraseSubject` |
| a pinned handle (`seg.pin()`) in another store | **no bound**: until that store's reader cache evicts the pin's reader (in a store with a timed pointer refresh, a small generation's reader holds all of its chunks, decoded or not) and its chunk cache evicts the chunks the pin decoded, or `store.invalidate(ref)` is called there |
| a leased pinned handle (`seg.pin({ leaseUntil })`) in another store | until its lease ends, at most 14 days after it was taken: its reads then throw `LeaseExpiredError`, whether or not its reader still holds the chunks. Until then, as for any pinned handle in the row above |
| another store with **no registry** (built on a bare `IStorageDriver` instead of a backend), with `cache: { genTtlMs: 0 }`, or on a `StorageChunkSource` of your own, which the store times no refresh on | **no bound**: only when its caches happen to let the segment go, or something tells it |

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
it deletes a generation above the pointer, an object it cannot search or the object of its own refused rewrite, renew the row's
`pointerId`, and its removal of the generations it will delete from the row's ledger, keep them),
so an entry for a generation it deleted stays in the list until the entry's own time ends or the next publish or lease
write prunes it: it spares nothing, since the object is gone, and it counts toward the 64 places until then. A
`dropSegment` and a retention expiry delete every generation and leave no lease on the tombstone. A `destroySegment`
deletes no generation: it clears the row's leases with its keys, so the tombstone holds no lease, and the objects stay
in the bucket. After a crypto-shred they are unreadable once no retained copy of the row holds the key (or every KEK
that wrapped it is destroyed); after a cleartext destroy (`allowCleartext`) they are readable. So erasure, shred, drop
and retention always win, and a lease never holds an erased subject's data past the bounds in the table above.

A lease written while an erasure is under way does not delay it. A lease write moves the row's token, which an erasure
rewrite is fenced on, but a row that differs from the one the rewrite read only in its leases does not refuse it: it goes on
against the row it finds, without streaming the object again, and so does the re-proof before each delete above the pointer
([how a load stays correct](correctness.md#how-a-load-stays-correct) states the rule). A change of anything else refuses, and
`eraseSubject` reports `superseded`: run it again.

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
at-rest guarantee that reaches those, encrypt and crypto-shred (`destroySegment` and `eraseNamespace`, see
[encryption](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)), which is complete once no retained copy of
the segment's registry row holds its wrapped key, or every KEK that wrapped it is destroyed
([disaster recovery](disaster-recovery.md#encryption--dr)). That works per segment: a per-id shred is
infeasible, because one key covers the whole segment. See [`PRIVACY.md`](../../PRIVACY.md).

## How it stays correct

[An erasure is a rewrite](correctness.md#erasure-is-a-rewrite): for each segment the id is a member of, `eraseSubject`
streams the current generation into a new one with that bit cleared, verifies it, [publishes it fenced on the generation
it streamed and the row's token](correctness.md#which-fence), and [deletes every generation in the bucket that holds the
id, above the pointer or below](correctness.md#every-holder-goes). Before it deletes anything, it [takes what it will
delete out of the row's ledger of known generations](correctness.md#ledger-loses-what-it-deletes), so a rollback without
`allowUnknown` cannot bring an erased generation back, even when a delete fails, except where the pointer alone decides.
[A race with a load, a rollback or another erasure is reported](correctness.md#erasure-racing-writers), as
`'superseded'`, an `error:` note or a thrown error, with two exceptions at a refused rewrite's delete of its own object
above the winner's pointer: [a rollback onto that object between the call's renewal of the row and the
delete](correctness.md#rollback-during-erasure), and, on a storage driver that does not report `conditionalDelete`, [a
delete that removes a load's generation published under that object's
number](correctness.md#erasure-number-taken-again). Each leaves the pointer on a missing object with nothing reported,
and only `checkConsistency()` finds it. A refused rewrite whose read of its own object faults, past the read retry, is reported too: `eraseIdFromSegment` rejects with the fault and `eraseSubject` records an `error:` note for the segment, and the object stays ([why](correctness.md#erasure-number-taken-again)). A call that could not collect [throws rather than report `erased: true` over
bytes still there](correctness.md#erasure-results). The mechanism, its memory and request bounds, each race, which
drivers apply a conditional delete, and what each result means are in [How an erasure stays
correct](correctness.md#how-an-erasure-stays-correct).
