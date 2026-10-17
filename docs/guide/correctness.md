# How it stays correct

The guides say what each call does and what it promises. This page is how those promises hold under crashes, races and
faults, guide by guide: what a refused load means, and how a load, a pin, the retention sweep, an erasure, encryption
and the drivers' retries stay correct. You do not need it to use the library: it is here so you can check the
guarantees. Each guide keeps a short summary of its part, with a link to it here.

The protocol rules these sections keep are the [hard correctness invariants](../../AGENTS.md#hard-correctness-invariants),
which code, tests and docs cite by number.

| Section | Its guide |
|---|---|
| [When a load is refused](#when-a-load-is-refused): each `reason` and what to do, what throws instead, and [a write that is throttled or gets no answer](#when-a-write-is-throttled-or-gets-no-answer) | [Loading in depth](loading.md) |
| [How a load stays correct](#how-a-load-stays-correct): numbering, the publish and its fences, crashes and orphans, collection and leases, and [a rollback that races a collection](#a-rollback-that-races-a-collection) | [Loading in depth](loading.md) |
| [How a pin stays correct](#how-a-pin-stays-correct): the caches a pin shares, one generation per call, a re-created segment, and what invalidates a pin | [Reading in depth](reading.md#read-one-fixed-point-in-time) |

## When a load is refused

A load that is refused returns `published: false` and a `reason`. It does not throw. The previous generation stays
current, and the result still carries the numbers (`cardinality`, `cardinalityBefore`) so you can log what was
refused.

**A bound is judged after the write, before the publish.** The load writes the new generation's object first, unpublished,
then judges it, and only then moves the pointer. A refused load has written its object and deletes it, one write and one
delete, unless another write changed the segment's row meanwhile in more than its leases: then the object stays in the
bucket, an orphan that a later load's collection takes, and until it goes a rollback onto it is refused unless it passes
`allowUnknown`, since the row never recorded it ([why, and the exceptions](#how-a-load-stays-correct)). Nothing a reader sees changes. To judge the outputs of a `materializeMany` call without writing anything, use a
[dry run](loading.md#look-before-you-publish-a-dry-run).

| `reason` | Means | What to do |
|---|---|---|
| `'empty'` | The ids produced nothing, and the segment is not empty. | Usually an upstream query that failed quietly. Fix it and re-run, or pass `allowEmpty: true` if emptying the segment is the point. |
| `'min-cardinality'` | The set has fewer ids than `guard.minCardinality`. | Check the source. Lower the guard if the smaller set is real. |
| `'min-retained'` | The set is smaller than `guard.minRetained` times the current segment. | The same: a shrink bigger than you allowed. |
| `'max-growth'` | The set is larger than `guard.maxGrowth` times the current segment. | A growth bigger than you allowed: often a source that landed twice, or a join on the wrong key. Check the source. Raise the guard if the larger set is real. |
| `'superseded'` | Another writer got there first: another load took the same generation number, or the segment's row changed while this load was writing, or appeared where it found none. | Re-run the load. |

A refused load also emits `segment.load-refused` to the `audit` sink you pass.

**The two ratio bounds.** `minRetained` is a floor and `maxGrowth` a ceiling on the new size as a multiple of the
current one: `{ minRetained: 0.5, maxGrowth: 2 }` accepts anything from half to twice what the segment holds. Neither
judges a first load, and `maxGrowth` does not judge a load onto an empty segment either, since no ceiling is a multiple
of zero; `0` means no bound, on both. The bounds are checked in the order of the table, so a load that breaks an older
bound as well keeps that reason. Each compares in floating point, so do not rely on the exact boundary
(`100 × 1.15` is `114.99999999999999`). Setting either one makes the load read the current size, `allowEmpty: true` or
not, and fence its publish on what it read ([below](loading.md#where-the-guard-reads-the-size-of-the-current-generation)).

A ratio judges a small segment harshly: 40 ids growing to 70 is 1.75 times. To refuse a growth only when it is also
larger than an absolute number of ids, set each load's `maxGrowth` from the segment's current size `before`:
`maxGrowth: before ? Math.max(1.5, 1 + 1000 / before) : 0` refuses only above both `before × 1.5` and
`before + 1000`, since `new > max(f × b, b + d)` is the same as `new > b × max(f, 1 + d / b)`. With no current size
(a first load, or an empty segment) it passes `0`, no bound, as the bound itself would judge nothing there. `before` is
`await segment.count()`, what your last load left (its `cardinality` if it published, its `cardinalityBefore` if it
was refused), or a `materializeMany` dry run's `cardinalityBefore` ([below](loading.md#look-before-you-publish-a-dry-run)). The rule
is exact while nothing else writes the segment in between.

A key shift keeps the size: a join on the wrong key can replace a segment's members with as many others, which no ratio
sees. To refuse one, count how many of the current ids the new set keeps before you load it, reading the segment a chunk
at a time:

```ts
declare const next: InstanceType<typeof RoaringBitmap32>; // the set you are about to load
const before = await store.segment('active-us').count();
let kept = 0;
for await (const batch of store.segment('active-us').iterate().batches()) {
  for (const id of batch) if (next.has(id)) kept++;
}
if (before > 0 && kept < 0.8 * before) throw new Error('refusing a load that keeps under 80% of the segment');
await store.load({ segment: 'active-us' }, { bitmap: next }, { guard: { maxGrowth: 1.5 } });
```

It reads the current generation once, and nothing fences it against another writer between the count and the load. For
the outputs of a `materializeMany` call, count it with a dry run ([below](loading.md#recipes-over-a-dry-run)).

**What throws instead.** A refusal is an outcome. A throw is a fault:

- invalid options or ids, or a crypto-shredded segment: `ValidationError`;
- a key the keystore cannot provide: `KeyUnavailableError`;
- a current generation that will not open when the load has to read its size for a guard, which it does only when the
  segment's row has no usable summary of it (see [the guard's size](loading.md#where-the-guard-reads-the-size-of-the-current-generation)): `IntegrityError`;
- a failure from your backend's storage or registry service, such as `TransientError`, which does not by itself mean
  the load did not take effect ([below](#when-a-write-is-throttled-or-gets-no-answer));
- a failure in the collection's own reads or deletes, which can be raised after the publish landed, so a throw does not
  by itself mean the load did not take effect. A collection, by name or by listing, that finds another writer has moved
  the row since the load's publish (a load, a rollback, a purge) stops and returns what it deleted in `collected`: a load
  that took effect does not throw for a race it won;
- a rollback that moved the pointer onto a generation the load had just deleted, one its collection took or its own
  refused object, and still named it when the load read the row again, after a wait on the store's clock:
  `NotFoundError`. After the publish it says the load took effect at its generation; after a refusal it names the
  refusal, after the `segment.load-refused` event when the load answers the refusal rather than its publish raising
  it. The pointer may then name a missing object: check `store.generations(ref)` or `checkConsistency()`, and roll back
  to a generation the bucket holds only if it does, since a rollback that found its target gone puts the pointer back
  itself ([a rollback that races a collection](#a-rollback-that-races-a-collection)).

The `*Into` verbs throw on the same superseded condition instead of reporting it.

A load that throws may already have consumed its input, a one-shot iterable included: retry with a fresh source, not the
one that was passed.

### When a write is throttled or gets no answer

A load makes two writes, and the backend handles each on its own terms.

**The generation's object** is written once, to a number no other object holds, so a write the service refuses as too
fast can be sent again. S3 answering `503 SlowDown` (or any `503`), and GCS answering `429` or `503`, make the driver
send the write again, up to three more times, after a random wait under 500 ms, then under 1 s, then under 2 s; Azure
Blob's client does the same under its own retry policy. Every object carries a random id in its metadata, because a
service does not promise that a request it throttled was not applied: a re-send that meets an object carrying its own id
is a write that landed, and one that meets any other object is a `WriteConflictError`, as any collision is. On S3, a
refusal of a concurrent write (`409`) or an unknown upload ID after a re-send can be the first send still applying, so
with nothing stored yet it is an unknown outcome, a `TransientError`, and never a report that nothing was written. A
lost response, a timeout or a `500` is not sent again. A write throttled on every send throws `TransientError`, and its
object may or may not exist. A load on the in-memory or the local-filesystem driver has nothing to throttle.

A multipart upload whose completion is throttled on every send, or ends ambiguously, is aborted. S3 completes an upload
atomically, so the abort never tears an object: a completion that had landed survives it, and one that had not is
cancelled and its parts are reclaimed. Either way no object is deleted.

**The registry row**: the S3 and GCS drivers send each row write once, whatever the answer. When a write ends without an
answer (a throttle, a lost response, a timeout), it may have landed, and may still be on its way. The load reads the row
again and decides from what it holds:

| The row, read again | The load |
|---|---|
| names this load's generation, and, on a registry that reports write tokens, its `pointerId` is the token of a write this load sent; on one that does not, the object under it has a footer matching the one this load wrote | `published: true`: taken as the write having landed with only its response lost |
| names this load's generation, but on a registry that reports write tokens its `pointerId` is not the token of a write this load sent; on one that does not, the footer of the object under the number is not the one this load wrote; or the row belongs to another incarnation of the name | `published: false`, `reason: 'superseded'`: the load reports none published and deletes nothing. On a registry that reports tokens this is usually another load's publish of that number; the paragraph on `superseded` refusals below says what else it can mean |
| has moved on, because another write changed it | `published: false`, `reason: 'superseded'`: this load's write can no longer land. A load that found no row is refused by any row that appeared meanwhile, guarded or not |
| is still as the write found it | the load sends a fresh compare-and-swap from the row it just read, after a wait on the store's clock: at most three, after under 500 ms, then 1 s, then 2 s. It is a new request, not a replay, and it carries the version the first one did, so the registry lets at most one of the two land. Each is settled by this same table. Still unanswered, the load throws the registry's own `TransientError` |

Whether the write that set the row's pointer is the load's own is settled by the token of each write. A registry that
reports tokens (the in-memory, local-filesystem, S3, GCS and Azure Blob registries do) tells the load the token of each
write it sends, before it sends it (a write sent again with a new token reports it; one that repeats the same body
repeats the token already reported). The row's `pointerId` names the writer of the write that last set the pointer, so
the pointer is over this load's write if and only if the `pointerId` is one of those tokens. The object's bytes play no
part, so another load of the same cleartext ids, which takes the number once an erasure has freed it, is not mistaken for
this one: this load reports `superseded`, audits no `segment.publish` and deletes nothing. The
same check runs after a write the registry refused as a conflict, since a client that re-sends a write can meet its own
landed copy, and after a write that went unanswered. A registry of your own that does not report tokens is settled by
the object instead: the load reads the footer of the object under the pointer and takes a match as its own. The footer
carries a write identity that is random per write (12 bytes a cleartext load draws, or an encrypted load's index
nonce, which its checksum covers), so it names one write, to the 32 bits of that checksum: another load's object of the same ids under the same number does not match, and that load is not reported as this one's. On
Azure Blob the client's retry policy runs under each of those writes too, so a registry that
never answers costs the load up to four times the client's tries before it throws: about 16 s per write at the SDK's
default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the
publish's own waits (derived from that schedule, not measured).

**What a thrown `TransientError` leaves behind.** The object this load wrote stays, above the pointer, and nothing is
deleted: the write may still reach the registry after the load has returned, and a pointer that lands over a deleted
object is the one state no reader can recover from. Re-run the load. It numbers its generation past the orphan, publishes
whether or not the first attempt landed, and collection removes the orphan once a generation above it is current. To know
whether the first attempt landed, check `store.generations(ref)` rather than replaying the request.

A refusal that follows a write that went unanswered cannot say whether that write landed first, so the generation may have
been current for a while before another writer moved on: its `segment.load-refused` audit event carries `unanswered:
true`.

On a registry that reports write tokens, a `superseded` refusal over a row that names this load's generation says only
that the row's `pointerId` is not the token of a write this load sent. Usually another load published that number. It
can also be this load's own write that landed, followed before the load read the row again by a write that renews the
row's `pointerId` over it: an erasure's renewal, or a rollback back onto the generation after a publish or another
rollback moved the pointer off it. The load cannot tell the two apart, so it reports none published though its
generation may be current, and deletes nothing. A re-run publishes a new generation.

## How a load stays correct


This section is the mechanism. You do not need it to use a load, and it is here so you can check the guarantees.

**Generation numbering is the load's.** Generations are write-once, and a load takes the next number itself: the one
after the pointer it read, `currentGen + 1`, when one existence check finds no object holding it, and otherwise one
above the pointer and above every object in the bucket, from a listing. A brand-new segment starts at `0`. The check is
there on purpose. A load that wrote its object and crashed before publishing leaves an object above `currentGen`, and a
writer consulting only the pointer would pick that same number and conflict on every retry. A load can therefore
number below an object above the pointer, such as one a rollback left there, but never onto one: write-once refuses a
put to a number an object holds, and a load that loses that race reports `superseded`. A number whose object was
deleted can be taken again, so nothing identifies a generation by its number alone: caches key on the number and the
row's `pointerId` (the token of the last write that named a field a read resolves through, at any value, as every
publish does), checked against the object the row's summary names whenever a reader opens it for a row with a summary
the store can use, and a reader
that finds another object under the number re-reads the segment rather than serve it.

**A load overlaps its round trips with its encoding.** The existence check, and the keystore's unwrap of an encrypted
segment's key, are sent before the ids are bucketed and encoded, and the write waits for their answers only when it
needs them. The keystore is asked for the key once per load, and that one key serves both the guard's read of the
current generation and the write; it is used only if the row the write reads after the ids still carries the same
wrappings, and a load of a crypto-shredded row never asks for it. What a fence rests on keeps its order: the row the
guard judges is read first, a first load or an encrypted segment reads the row again after the ids, and the publish is
fenced on the row the guard judged.

What changes is the order in which a failure surfaces, never whether anything is written. A failed existence check
(and the listing it falls back to) is raised after the ids have been consumed, so the encoding's error, or the refusal
of the second row read (a crypto-shredded segment), can be raised instead of it; either way nothing is written or
published. A load that fails or is refused after its first row read may already have made its one keystore call for an
existing encrypted segment, which a load that failed earlier did not.

**Publish is forward-only, so a rerun is safe.** The object is written first. Only once it is durable does the load
advance the registry pointer, with a compare-and-swap that never moves backwards. Run the same job twice and the second
load is simply a newer identical generation. Run two loads of one segment at once and at most one of them lands; the
other reports `published: false` with `reason: 'superseded'`. If both took the same generation number, the second to
write it is refused by the write-once put and writes nothing. If not, the publish that lands second finds the row
changed since its load read it, or finds a row where its load read none, and is refused, whatever its options: two
first loads of a segment with no row race to create it, and the one that loses is refused whichever number it holds.
The row the refusal then reads is another writer's, so its object stays in the bucket (unless the loser wrote
cleartext and the winner's row holds key material, or the row has since been dropped or purged, as the paragraph on
crashes below says): it is an orphan, collected as the
paragraph on orphans below says, and billed until then, or until `dropSegment` or the retention sweep removes the
segment. A load that won the number can still be refused by its guard. Publishing the
generation that is already current is a no-op that reports success, unless the publish is fenced (below), in which
case it is refused.

**The row records the window, and the write that moves the pointer writes it.** The ledger of kept generations goes in the
same compare-and-swap as the pointer, derived from the very row that write is conditioned on, so the window a load deletes
by is the window that row held and no other. A publish keeps the `keep` most recently current generations below its own,
the ones a live lease holds and the ones a rollback left above its own, and nothing else; a publish over a row with no
usable ledger starts one from the bucket: the window a listing keeps, which can name the number a refused load took,
and later publishes keep naming it until the window pushes it out (see the paragraph on orphans below). A purge and
re-create leaves the row with no ledger, which only makes the next load start one; a write that leaves the pointer where
it is (`setRetention`, a crypto-shred aside) keeps it. A `rollback` carries the ledger it found, moving the target to its
end, so the next load draws its window from the order generations were made current, and starts none over a row that
had none.

**Which fence a publish carries.** Forward-only is right for a writer whose content does not depend on what was
current: a load's ids come from upstream, so winning a race loses nothing it knew about. It is wrong for a writer that
derived its content from a particular generation, and such a writer publishes with `expectFrom` and `expectToken`.
The publish then lands only while the pointer is still exactly there, on the same row, and reports `superseded`
otherwise, so the caller can re-derive. Every load that finds a row fences its publish on the row's token, and every
load that finds none fences on that absence, guarded or not, so a row that appeared meanwhile refuses it: another
first load's, one `setRetention` made, or a drop's tombstone. A guarded load (the default, since the empty refusal
needs the size of the current generation) also fences on the pointer it judged. An unguarded load carries no fence on
the pointer, which is right for it: there was nothing to judge, and its ids come from upstream. An
[`*Into`](loading.md#write-a-result-into-another-segment-the-into-verbs) is a load and publishes the same way. Forward-only would be wrong for the erasure rewrite, whose object is one generation minus a
bit and which is numbered above everything in the bucket: a forward-only publish would out-rank a concurrent publish
and then delete it, so the rewrite fences on its source generation and the row's token instead.

**The registry write goes out on the row the load read, and the store's own condition still decides.** A publish hands
the registry the row it read (or the fact that it found none), so a registry that keeps the version of the object it
read sends the compare-and-swap, or the create-only write, at once, with no read of the row first. The S3, GCS and Azure
Blob registries do. The write is conditioned on the object's own version (`If-Match` on S3 and Azure Blob,
`ifGenerationMatch` on GCS, `If-None-Match` for a row that was absent), so a row another writer changed after the load
read it fails the write exactly as a lost race does, and the load reports `superseded`. The row the load read is never
what settles a write that got no answer: that is read again, as above.

**A crash never moves the pointer.** If the process dies mid-write, the object never completes (every storage driver
commits atomically: a hard link, a conditional PUT, a multipart complete) and the pointer still names the previous
generation, which readers keep serving. A load that dies between the write and the publish leaves an orphan: an object
that was never current. So does a load whose registry write ended without an answer that the row could settle (it throws
`TransientError`). A refused load that finds the row unchanged, changed only in its leases, or `destroyed` deletes its
object by number: the decision comes from the row, and the object is this load's own write, of which the write reports
no version. One that finds the row gone, or holding key material where the load wrote cleartext (which has no place in
an encrypted segment's bucket), deletes its object only once one read of its footer matches the object this load wrote,
since by then its generation number may name another writer's object (a re-created segment's, say). The footer carries
the write identity this load drew, so it matches that object and no other: a re-created segment's load of the same
cleartext ids, which writes the same chunks under the same number, is another object, and a refusal that straddles a
purge keeps it. The delete passes the version that read reported, so on a storage driver that reports
`conditionalDelete` an object put under the number since is kept; one the read does not match stays, an orphan. An
object whose identity field is all zero (a reader accepts one) names no write, so two such objects of the same ids are
alike, and a refusal that matches one by its footer cannot tell it from another's. Under any other row another write changed, the object stays, an orphan, whatever its number:
the decision there comes from the row, not from the footer. Above the pointer an erasure deletes an object that holds the id it erases
and a load can take the freed number; below it a rollback can lower the pointer and let a load take the number again,
and a generation another load published can sit in a window the row does not record.

**An orphan is collected later, and a rollback refuses it until then.** A publish never adds an orphan to the row's
list: what it adds is the generation it superseded, which was current. A load whose check meets it numbers above it by a
listing and, once its own generation is current, that listing deletes the orphan, which is below the pointer, where the
row's window does not name it. Where the row has no usable ledger, that listing keeps a window from what it finds, the
generation the load superseded first and then the newest by number, and, at a `keep` up to 64, its publish wrote it as
the ledger: the orphan can take a place in that window, and the publishes after it carry it in the row's window until the
window pushes it out. A load with a `keep` above 64 counts the ledger's own most recently current names first and then
the newest others by number, so an orphan takes a place only when the ledger names fewer than `keep`. An orphan stranded elsewhere below the pointer waits for the next
listing, at most 16 generations on, unless a window holds it. Until it goes, [`rollbackSegment`](loading.md#roll-back-a-segment)
refuses it as a target unless the caller passes `allowUnknown`: the row never recorded it, so a rollback throws
`ValidationError` before any request to storage, and with the override it publishes what no load published, an empty
generation a guard refused among them. Two cases do not refuse it: the orphan is below the pointer and the row has no
usable ledger or the orphan is numbered below a full ledger's bound, where the pointer alone decides, and the orphan is
one a ledger seeded over a row with none recorded, which the row then knows.
Nothing yet
tells an orphan from a published generation under the same number: a number is taken again once its object is deleted
(after a rollback below it, or an erasure's delete above the pointer), so a `segment.publish` audit event naming the
number can belong to an earlier object under it ([the roadmap](../ROADMAP.md) plans a ledger that tells a generation a load published from one a seed
recorded). There is no half-loaded state a reader can observe: a read resolves one generation and reads whole,
checksum-verified chunks from it.

**A miss is a re-read, not a failure.** If the generation an unpinned read is on is swept, the storage driver throws
`NotFoundError`. The storage source drops the stale snapshot, re-resolves `currentGen` and retries once, covering both
the fetch and the reopen, which are separate round trips. The call then serves the newer, committed generation: a move
forward within that segment's lifetime, never a torn object. A second miss is pathological (collection outrunning
resolution) and propagates instead of fabricating an absent answer. The one case that answers empty instead of
throwing is a segment with no generation left to serve at all, dropped or crypto-shredded, where reading empty is the
documented outcome.

**The exposure window is the TTL, not the length of your call.** A snapshot is re-checked every `cache.genTtlMs`, so at
most `ceil(genTtlMs ÷ gap between publishes)` publishes can land under any snapshot a read actually uses: one, at the
2 s default, against any realistic publish cadence. A sixty-second `intersect` does not need a sixty-second window. A
pinned handle is the exception: it is never re-resolved, so its window is the length of the job it serves. So is a
store with no timed refresh (no registry, `cache: { genTtlMs: 0 }`, or a `StorageChunkSource` of your own, which the store times no refresh on), whose
snapshot lasts until an eviction, a read that finds its generation swept, or an invalidation moves it on, however long
that takes. There no finite `keep` covers it, and the re-read above is the mechanism that keeps it correct. A store
with a timed refresh serves a small generation's chunks from memory (its reader kept them), so a sweep of the
generation is noticed there at the next refresh, within `cache.genTtlMs`, and not by the read.

**What collection does, precisely.** A listing pass deletes generations strictly below `currentGen`, keeping the most
recent `keep` of them, so a read still fetching from the just-superseded generation need not re-resolve mid-call. It
deletes nothing while `currentGen` is `null`, because an object under a pointer-less row is either a load about to
publish or an orphan, and the two cannot be told apart safely. The one exception: on a `destroyed` segment (a drop or
crypto-shred tombstone) every generation is garbage and all are collected, because no reader can resolve a tombstoned
segment.

A by-name pass takes the generations the load's publish pushed out of the row's window, which it learned from the
list it wrote, and is bound by the same rules. It re-reads the row before **each** delete. It stops, deleting nothing
more and returning what it has, when the row is gone, when the pointer has fallen below the generation the load
published (a rollback does that, and so does a name purged and re-created that has not yet loaded as far), or when the
row's own list no longer vouches for the name: the list is gone (a rollback drops it), or it now names the generation,
which a rollback and later loads with a wider `keep` can bring about. The publish already landed, so the load returns as
published, and the pointer is wherever the operator put it. A publish landing meanwhile moves the pointer up and changes
nothing. A fault is not a lost race: a registry read or a delete that throws rejects the load, after its publish landed
and with the pointer at the published generation, so re-read the pointer rather than assuming. Every generation it
deletes is below the one it published and below the pointer it just read, so it never touches the current generation.
A load whose check of the previous current object finds it gone, the state a lifecycle rule or a partial restore leaves
and `checkConsistency` reports, lists instead, and keeps the newest `keep` generations a listing finds, and records
them: the check is the guard's read of the object, or, for a guard that took the size from the row's summary, one
zero-byte read before the pass takes a name. A load that makes no such check, one with `allowEmpty` and neither `minRetained` nor `maxGrowth`,
cannot tell, and deletes the names its list pushed out.

The listing pass a load runs on a row that has a window (every 16th generation, a check that met an object, a caller
that asks for a listing) deletes every generation below the pointer that the row does not name, whether the row
names it as the publish wrote it or as it reads after the listing (a load that published meanwhile keeps its own window),
and re-proves before each delete that the row still has a window and still does not name the generation. Where it cannot
prove a delete it stops, and the load returns. A pass that keeps by a count (a `keep` above 64, or a first load over a row
with no usable ledger) keeps `keep` of the generations it finds. Where the row's ledger is usable, that is the ledger's
own most recently current names below the pointer first, up to 127 of them and the ones that are there, then the newest
others by number, `keep` in all; the generation the load superseded is the ledger's newest name below the pointer, so it
comes first, and one whose object has gone does not count, so the window still holds `keep`. A name the ledger holds
only for a lease is older than that span, takes no place in it, and is spared beside it. Before each delete the pass
reads the row again and spares every name the row knows then, which a publish or a rollback that landed since can have
added. A pass that protects what the row names (a number the listing chose, or every sixteenth generation) counts as well
when the generation the load superseded is not in its listing. Where the row has no usable ledger, it keeps the one the load superseded first and then the newest by number, the
window its publish wrote. It puts the superseded generation first only while the lower of its two reads of the pointer,
the one before its listing and the one after, is the load's own generation. Otherwise another writer moved the pointer
before the pass first read it, or a rollback lowered it by the second read, and the generation that pointer superseded is
not one this load knows, so the window is the newest by number. A publish that lands after the first read, or a rollback
down and forward again to the load's generation, leaves the superseded generation first. Whatever it keeps, every
generation it deletes is below that lower pointer. It writes nothing: the publish it follows wrote the window, so it
moves the row's token once less than a pass that recorded its result in a write of its own.

**A lease on a pinned generation is read from the row a collection already holds.** A load's collection, by name or by
listing, spares a generation that a live lease in the row names, and goes on to the next: the by-name pass reads the row
before each delete and the listing pass re-proves it, so a lease that lands while the pass runs is seen at the next name,
and one that lands in the round trip between that read and the delete is not. The `keep` window is chosen without
looking at leases. A leased generation it leaves out takes no place in it, and the record of the window leaves it out;
one it holds anyway, such as the generation the load superseded, takes its place there as any other would. The
collection that runs for an erasure, a shred, a drop and a retention expiry does not read leases at all. A lease is
written by one compare-and-swap on the row, so it is one more writer of the row, but never one that refuses the others:
see the next paragraph. A load's publish drops the leases that have ended from the row in its own write, at no request
of its own. A load with no clock (`deps.clock` absent, which the store never is) cannot tell a live lease from an ended
one, so its collection reads none and its publish prunes none.

**A lease write does not refuse a writer fenced on the row's token.** Invariant 1's fence stays: a load, an erasure
rewrite and a rollback publish only against the row they read. But readers write a segment's leases, in numbers no
operator controls, and each write moves the token. So a writer that finds the token moved re-reads the row, and when
it differs from the one the writer read only in its leases (the same incarnation, and every other field equal, the
update time and the token aside), it waits, reads the row again, and goes on against that row, without writing its
object again and without deriving its content again. The wait is a random time of up to 25 ms, growing with each retry
to up to 400 ms, taken on the store's clock; a writer given no clock `sleep` retries without waiting, and one given no
`rng` waits the whole bound. A difference in anything else, the pointer, the kept window, the summary, a retention
policy, the key wrappings, the status or the row's `pointerId` (another writer named the pointer, even at the value it
had), refuses. This covers a load's publish, an erasure rewrite's publish, an erasure's renewal of
the row and the re-proof before each delete above the pointer, a rollback's swap and its undo, a retention write, and
a shred or a drop, which re-read the row on every attempt and do not count a lost race to a lease write. Each waits
out at most 136 such changes (a take and a release by each of the 64 holders a row can hold, and a few more) and then
reports what it would have: `superseded`, or `WriteConflictError`. The rule is what lets an erasure, a shred, a drop
and a retention write win over leases that readers write without limit.

A segment can be purged and re-created while a paginated listing is in flight, so both branches re-read the registry
row afterwards and reconcile with it:

- On a tombstone, the row must still be the same row, compared by its **token**. A generation number is not an
  identity, and a re-created name can wear the very `currentGen` the tombstone held.
- On the ordinary branch, the cutoff becomes the **lower** of the two pointers. A load numbers its generation from the
  pointer and what is in the bucket, so numbering restarts at 0 once a row is purged and the bucket emptied. A re-created name then wears a lower pointer than the one read before the listing, and deleting
  "everything below it" would take the new incarnation's live object. A publish landing mid-listing moves the pointer
  forward and so changes nothing, which is what keeps routine collection working on a busy segment.

The row is re-proved before **every** delete, not once after the listing, because the deletes are one round trip each.
If the segment changed underneath the pass, a collection that is not a load's throws `WriteConflictError`; re-run it, and
note that a refusal part-way through may already have deleted objects it will now never report. A load's own pass stops
instead and returns what it deleted. A re-proof that finds the pointer on a generation the pass already deleted is not a
race it won, on either pass, and throws `NotFoundError` ([below](#a-rollback-that-races-a-collection)). One more consequence of the reconcile:
`keep` counts distinct generations, not listing entries, so a listing that enumerates the same generation twice cannot
eat the grace window.

**A list is not a receipt, so verify the bucket.** A collection pass that returns an empty list may have found nothing
to collect, and one that returns a name may have been beaten to it by a concurrent collector, which is the outcome and
not a failure. A caller that needs a receipt, as the erasure rewrite does, therefore checks that the generation is gone
from the bucket, not that it is a member of the returned list. A by-name pass's list is no receipt either, since it
names the generation it asked to delete whether or not it was there.

**`g < currentGen` is a safe bound only against a pointer read after the listing.** A pointer read before it can be
higher than the one a purge and re-creation or a rollback leaves behind, which is why the ordinary branch above takes
the lower of the two.

### A rollback that races a collection

Every loop that deletes generations reads the segment's row just before each delete. A rollback that is held to the
row's record of its generations (`knownGens`) is kept out of all of them:

- a load's collection by name removes the generations it deletes from the record in its publish, before it deletes
  anything, so a rollback onto one is refused as unknown, or, when it read the row before that publish, loses its swap
  with `WriteConflictError`;
- a load's pass that keeps by count never deletes a generation the row names when it re-reads the row;
- a refused load's own object is in no record, so it is not a target;
- an erasure's rewrite leaves only itself in the record, before it collects, and an erasure that rewrites nothing takes
  each generation it will delete out of the record in a write made before its first delete.

What is left is a rollback that is not held to the record: `allowUnknown`, or a target below the pointer on a row with no
usable record or below a full record's bound. It can meet a deleter and land on the very generation being deleted, inside
the round trip that remains between the read of the row and the delete:

```
deleting call        reads the row: g may go ──────── round trip ──────────────────▶ deletes g
rollbackSegment(g)         reads g's footer: g is there │ moves the pointer onto g │ reads g's footer: g is there
                                                                                        └▶ the row names g, and g is gone
```

The rollback reads the target's footer after it moves the pointer, so a delete that lands before that check is caught
there: the rollback puts the pointer back and throws `NotFoundError`. A delete that lands after it is not, and the
rollback reports success over an object that is gone. Below the pointer that is a rollback onto a generation a
collection is taking; above it, a rollback onto an erasure's holder or a refused load's own object.

**An erasure takes what it will delete out of the row's ledger first.** Before its first delete, in one write after its
search, it removes from the row's ledger of known generations each holder it will delete by name and every name below the
pointer that its collection will delete ([what the write is, and its races](erasure.md#how-it-stays-correct)). Its
collections then spare every generation the row names when they read the row before a delete, so they spare what a load
or a rollback has made known since; the call takes such a name out of the ledger again, below the generation it found
current, before it deletes it, so a generation the call deletes is one the row no longer names.

**Nothing can restore a deleted object, so the deleting call detects it.** Every read of the row it makes after a
delete, and one more read after its last delete when nothing read the row since, is held to what it deleted. A row of
the same incarnation whose pointer names one of those generations, with no object under that number, is the state: one
zero-byte read of the object decides that last part, and it is made only when the row names a deleted number, because a
number can be taken again (after a rollback below it, a load can number it afresh and publish, and then the object is
there and nothing is wrong). On a storage driver that ignores a delete's condition, an erasure's stale delete can remove
a load's object published under a number taken again; the same read reports that too. A tombstone's collection makes no
such read: no rollback moves a `destroyed` row's pointer. One delete is not held to this: a refused erasure rewrite's
delete of the object above the winner's pointer whose footer matches its rewrite, made after it renews the row, which a rollback onto that object in
the round trip between the renewal and the delete leaves named by the pointer, with nothing reported;
`checkConsistency()` finds it.

**It gives the rollback's own check time to finish.** The more common order is the other one: the rollback's check runs
after the delete, finds the object gone and puts the pointer back, and the deleting call's read lands between the move
and the undo. A rollback client no nearer the store than the deleting call is always in that order:

```
deleting call       reads: g may go → deletes g → reads: names g, g is gone → reads again: the pointer is back
rollbackSegment(g)    moves the pointer onto g ──→ reads g's footer: g is gone ──→ puts the pointer back
```

So a read that finds the pointer on a deleted generation with no object under it is not yet the answer. The call
reads the row again at once and, on a store (which always has a clock), again after waits of 250, 500 and 1,000 ms,
1.75 s in all, and it reports the state only when every one of those reads still names a deleted generation that is
missing. A rollback's check is one footer read and one
compare-and-swap, two round trips, so the waits cover a rollback client a few hundred milliseconds further
from the store than the deleting call. A caller of the core functions that passes no clock gets only the read at once.
A rollback whose undo takes longer than that can still be reported while it is undoing, which is why the message says
to look before acting. A rollback whose swap got no answer is one: it puts the pointer back only after its own request
timeout and a read of the row, often longer than the 1.75 s the deleting call waits.

What the caller sees is `NotFoundError` naming the generation, in place of the answer it would have given:

| The delete | The message says | Already sent |
|---|---|---|
| a load's collection, after its publish landed | the load took effect at its generation, and its collection deleted the one the pointer named | `segment.publish` |
| a refused load's delete of its own object | the load was refused, naming the refusal, and published nothing | `segment.load-refused` for a refusal the load answers (a guard's, or a publish that answered `false`); nothing for one its publish raised as a `ValidationError` or `KeyUnavailableError`, whose name and message it carries |
| the erasure's collection, after its rewrite published | an erasure deleted the generation | `segment.rewrite` |
| the erasure's deletes when it rewrote nothing | an erasure deleted the generation | `segment.collect` when nothing left in the bucket holds the id; nothing when a holder is left |

**What to do.** Look before you act: `store.generations(ref)` lists what the bucket holds and marks the current
generation, and `checkConsistency()` reports the segment as `missing-storage-generation` while its pointer names a
missing object. Act only if the pointer still names one; a rollback that found its target gone has put the pointer back
itself, and the segment needs nothing: a rollback then would undo a load that took effect. While the pointer does name
a missing object, every read that opens the segment's current generation fails: roll back to a generation the bucket
holds (a target the row does not know needs `allowUnknown`), or load the segment again, which moves the pointer onto the load's own
new generation. The erasure also needs a re-run, as its ledger entry says
([reading the ledger](erasure.md#reading-the-ledger)).

**What it costs.** One registry read after a loop's last delete, when no read followed it, and none for a loop that
deleted nothing: a steady load makes one more GET than it would without it. On S3 a load that deletes by name costs
$12.00 per million at the default prices, for 2 PUT-class requests, 5 GET-class and a delete
([the cost guide](cost.md#what-each-term-counts)). The rest is made only when a read finds the row naming a deleted
number, which a call where nothing raced never sees: one zero-byte read of that object, and when it is gone, up to four
more reads of the row over the waits above, each followed by a zero-byte read while the row still names a deleted
number.

**What it does not do.** It detects; it repairs nothing, and the rollback that moved the pointer is not undone. The
argument that it sees every such landing rests on a store that is consistent for a read after a write, as every
shipped backend is: a delete that lands before the rollback's check is seen by the rollback, and one that lands after
it can finish only after the rollback's move, so the call's next read of the row sees the move.

## How a pin stays correct

- **A pin costs a generation number, not a retained index.** The pinned reader lives in the same bounded LRU as every
  other reader. Its decoded chunks share the store's chunk cache and its bound, under keys of their own that no live
  read writes. So a pin is never handed a chunk a live read fetched from another generation, and it pays one GET for a
  chunk a live read of its generation already cached. A small generation's reader also holds that generation's
  chunk bytes, which count in the reader cache's byte bound.
- **One call reads a segment at one generation.** A combine that holds the same segment at two generations is refused
  with `ValidationError` when it is read, as a combine's other errors are. That covers pins of two generations, pins of
  one generation number in two incarnations of its name, and a pin beside a live handle of the same segment.
  Materialize one side first with `intersectInto(dest, [])`. Two pins of one object combine freely, and an `*Into` of a
  combine that is refused throws before it reads anything.
- **A pin is safe across a re-creation.** `pin()` records the pinned object's size and footer checksum. If the segment
  is purged and loaded again, which starts the new segment at generation 0 again, the pin never reads the new
  segment: what it has already read still answers, and anything it would have to fetch fails with `NotFoundError`, with
  or without a registry. An object of another size counts as another object, damaged or not. A replacement it has
  found is remembered, so later reads fail with no request, until the store forgets it. `store.invalidate(ref)` does
  that, and so does a later `pin()` of the same version that opens the pinned object again. The store remembers at most
  `cache.readerMax` of them. So once a restore puts the object back, invalidate its store: the pin then reads it
  again, and a pin taken after that reads the object then stored as its generation.
- **`pin()` opens its reader as it pins.** With a registry, pins of one generation taken while its row is unchanged
  share that reader while the store keeps it open, pins taken at the same moment included. Only the first costs a tail
  read, and a key unwrap for an encrypted segment, even if it is never read. Without a registry, every `pin()` lists the
  segment's objects and makes the tail read. `pin()` and every pinned read are retried as the store's reads are.
- **A segment with no current generation pins nothing and reads empty.** A pinned segment whose row is later dropped or
  destroyed fails with `NotFoundError` once it must open its object again, rather than going empty part-way through a
  call.
- **A pin answers from what it holds.** It keeps the key its reader unwrapped while that reader stays open, and
  answers from the chunks it decoded while they stay cached, and, for a small generation, from the chunk bytes its
  reader kept while the reader stays open. Its own store invalidates it on a `load`, a `rollback` or an `*Into` of its segment, and on a
  `dropSegment` of its segment. It also invalidates it on a `retireExpired` whose ledger lists its segment, retired or
  not, and on an `eraseSubject` that scans its segment while it is not destroyed. A dry run of `dropSegment` or
  `retireExpired` invalidates nothing. An invalidated pin opens its
  object again, and fails if that object is gone or replaced, or its row is gone or destroyed. A read of the pin
  already running when the invalidation comes, a combine on the same store with the pin as an operand included, looks
  the pin up again before it hands out its next chunk: it carries on with what it holds where the object is still
  there, and fails with `NotFoundError` where it is gone, so after an erasure it yields no more than [the bound a read
  in progress has](erasure.md#who-stops-seeing-the-id-and-when). It caches nothing more of what it began reading before
  the invalidation, so the pin's next read opens the object again too.

  Anything else leaves it as it is. After a `destroySegment` beside its store, or an erasure, a drop or a retirement
  through another store, in the same process or another, it answers from what it holds. That lasts until its store's
  reader cache evicts the pin's reader and the store's chunk cache evicts the chunks the pin decoded, or until
  `store.invalidate(ref)` is called on its store. Where the object it reads has been deleted, a chunk it has not cached
  fails at once, unless its reader kept the generation's chunks, which it serves until the reader is evicted. A
  combine on another store refuses the pin.
- **It needs a `.crbm` reader**: the store builds one over a backend, and over a bare `IStorageDriver`. A
  `StorageChunkSource` of your own throws `UnsupportedError`.
