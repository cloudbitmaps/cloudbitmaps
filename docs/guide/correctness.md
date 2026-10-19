# How it stays correct

The guides say what each call does and what it promises. This page is how those promises hold under crashes, races and
faults, guide by guide: what a refused load means, and how a load, a pin, the retention sweep, an erasure, encryption
and the drivers' retries stay correct. The first section, [when a load is refused](#when-a-load-is-refused), is the
one a running deployment reaches for: each `reason`, what to do about it, and what throws instead. The rest you do not
need to use the library: it is here so you can check the guarantees. Each guide keeps a short summary of its part,
with a link to it here.

The protocol rules these sections keep are the [hard correctness invariants](../../AGENTS.md#hard-correctness-invariants),
which code, tests and docs cite by number.

| Section | Its guide |
|---|---|
| [When a load is refused](#when-a-load-is-refused): each `reason` and what to do, what throws instead, and [a write that is throttled or gets no answer](#when-a-write-is-throttled-or-gets-no-answer) | [Loading in depth](loading.md) |
| [How a load stays correct](#how-a-load-stays-correct): numbering, the publish and its fences, crashes and orphans, collection and leases, and [a rollback that races a collection](#a-rollback-that-races-a-collection) | [Loading in depth](loading.md) |
| [How a pin stays correct](#how-a-pin-stays-correct): the caches a pin shares, one generation per call, a re-created segment, and what invalidates a pin | [Reading in depth](reading.md#read-one-fixed-point-in-time) |
| [How retention stays correct](#how-retention-stays-correct): the order of a drop, the purge of a tombstone, and the due index's pointers | [Retention](retention.md) |
| [How an erasure stays correct](#how-an-erasure-stays-correct): the rewrite, the row's ledger, racing writers, and what each result means | [Subject access and erasure](erasure.md) |
| [How encryption stays correct](#how-encryption-stays-correct): the seal count, and why a segment is never half-encrypted | [Encryption at rest](encryption.md) |
| [How retries stay correct](#how-retries-stay-correct): a cloud SDK's own retry, and the writes that are tagged | [Before production](production.md#reliability-retries-backoff--timeouts) |

## When a load is refused

<a id="refusal-is-reported-not-thrown"></a>A load that is refused returns `published: false` and a `reason`. It does not throw. The previous generation stays
current, and the result still carries the numbers (`cardinality`, `cardinalityBefore`) so you can log what was
refused.

<a id="judged-after-the-write"></a>**A bound is judged after the write, before the publish.** The load writes the new generation's object first, unpublished,
then judges it, and only then moves the pointer. A refused load has written its object and deletes it, one write and one
delete, unless another write changed the segment's row meanwhile in more than its leases: then the object stays in the
bucket, an orphan that a later load's collection takes, and until it goes a rollback onto it is refused unless it passes
`allowUnknown`, since the row never recorded it ([why, and the exceptions](#how-a-load-stays-correct)). Nothing a reader sees changes. To judge the outputs of a `materializeMany` call without writing anything, use a
[dry run](loading.md#look-before-you-publish-a-dry-run).

<a id="what-each-reason-means"></a>Each `reason`, what it means, and what to do (a refused load also emits `segment.load-refused`, below the table):

| `reason` | Means | What to do |
|---|---|---|
| `'empty'` | The ids produced nothing, and the segment is not empty. | Usually an upstream query that failed quietly. Fix it and re-run, or pass `allowEmpty: true` if emptying the segment is the point. |
| `'min-cardinality'` | The set has fewer ids than `guard.minCardinality`. | Check the source. Lower the guard if the smaller set is real. |
| `'min-retained'` | The set is smaller than `guard.minRetained` times the current segment. | The same: a shrink bigger than you allowed. |
| `'max-growth'` | The set is larger than `guard.maxGrowth` times the current segment. | A growth bigger than you allowed: often a source that landed twice, or a join on the wrong key. Check the source. Raise the guard if the larger set is real. |
| `'superseded'` | Another writer got there first: another load took the same generation number, or the segment's row changed while this load was writing, or appeared where it found none. | Re-run the load. |

A refused load also emits `segment.load-refused` to the `audit` sink you pass.

<a id="two-ratio-bounds"></a>**The two ratio bounds.** `minRetained` is a floor and `maxGrowth` a ceiling on the new size as a multiple of the
current one: `{ minRetained: 0.5, maxGrowth: 2 }` accepts anything from half to twice what the segment holds. Neither
judges a first load, and `maxGrowth` does not judge a load onto an empty segment either, since no ceiling is a multiple
of zero; `0` means no bound, on both. The bounds are checked in the order of the table, so a load that breaks an older
bound as well keeps that reason. Each compares in floating point, so do not rely on the exact boundary
(`100 × 1.15` is `114.99999999999999`). Setting either one makes the load read the current size, `allowEmpty: true` or
not, and fence its publish on what it read ([in the loading guide](loading.md#where-the-guard-reads-the-size-of-the-current-generation)).

A ratio judges a small segment harshly: 40 ids growing to 70 is 1.75 times. To refuse a growth only when it is also
larger than an absolute number of ids, set each load's `maxGrowth` from the segment's current size `before`:
`maxGrowth: before ? Math.max(1.5, 1 + 1000 / before) : 0` refuses only above both `before × 1.5` and
`before + 1000`, since `new > max(f × b, b + d)` is the same as `new > b × max(f, 1 + d / b)`. With no current size
(a first load, or an empty segment) it passes `0`, no bound, as the bound itself would judge nothing there. `before` is
`await segment.count()`, what your last load left (its `cardinality` if it published, its `cardinalityBefore` if it
was refused), or a `materializeMany` dry run's `cardinalityBefore` ([in the loading guide](loading.md#look-before-you-publish-a-dry-run)). The rule
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
the outputs of a `materializeMany` call, count it with a dry run ([in the loading guide](loading.md#recipes-over-a-dry-run)).

<a id="what-throws-instead"></a>**What throws instead.** A refusal is an outcome. A throw is a fault:

- invalid options or ids, or a crypto-shredded segment: `ValidationError`, an id lower than the one before it under
  `sorted: true` included;
- an error your id source throws, as it threw it, this library's own `WriteConflictError` included: under
  `sorted: true` too, where the ids are read during the upload, and the storage driver never sees it; and, under
  `sorted: true`, `IntegrityError` when a storage driver runs its write a second time;
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

<a id="a-load-makes-two-writes"></a>A load makes two writes, and the backend handles each on its own terms.

<a id="object-write-resent"></a>**The generation's object** is written once, to a number no other object holds, so a write the service refuses as too
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

<a id="row-write-settled"></a>**The registry row**: the S3 and GCS drivers send each row write once, whatever the answer. When a write ends without an
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
landed copy, and after a write that went unanswered. A fault that comes before the write reports its token, such as
the registry's own read of the row, was never a write with no answer: on a registry that reports tokens the load throws
it at once as that read's fault, with no read of the row and no fresh write. A registry of your own that does not report tokens is settled by
the object instead: the load reads the footer of the object under the pointer and takes a match as its own. The footer
carries a write identity that is random per write (12 bytes a cleartext load draws, or an encrypted load's index
nonce, which its checksum covers), so it names one write, to the 32 bits of that checksum: another load's object of the same ids under the same number does not match, and that load is not reported as this one's. On
Azure Blob the client's retry policy runs under each of those writes too, so a registry that
never answers costs the load up to four times the client's tries before it throws: about 16 s per write at the SDK's
default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the
publish's own waits (derived from that schedule, not measured).

<a id="transient-error-leaves-its-object"></a>**What a thrown `TransientError` leaves behind.** The object this load wrote stays, above the pointer, and nothing is
deleted: the write may still reach the registry after the load has returned, and a pointer that lands over a deleted
object is the one state no reader can recover from. Re-run the load. It numbers its generation past the orphan, publishes
whether or not the first attempt landed, and collection removes the orphan once a generation above it is current. To know
whether the first attempt landed, check `store.generations(ref)` rather than replaying the request.

<a id="unanswered-refusal-is-flagged"></a>A refusal that follows a write that went unanswered cannot say whether that write landed first, so the generation may have
been current for a while before another writer moved on: its `segment.load-refused` audit event carries `unanswered:
true`. So does a refusal that follows a conflict the registry marked as one that may follow the write's own landing
(`unsettledConflict`, which the Azure Blob registry raises for every conflict of a row write).

<a id="superseded-over-own-generation"></a>On a registry that reports write tokens, a `superseded` refusal over a row that names this load's generation says only
that the row's `pointerId` is not the token of a write this load sent. Usually another load published that number. It
can also be this load's own write that landed, followed before the load read the row again by a write that renews the
row's `pointerId` over it: an erasure's renewal, or a rollback back onto the generation after a publish or another
rollback moved the pointer off it. The load cannot tell the two apart, so it reports none published though its
generation may be current, and deletes nothing. A re-run publishes a new generation.

<a id="rollback-settles-its-swap"></a>A rollback settles its swap the same way as a load's publish. On a registry that reports write tokens, a swap that met a conflict or got no
answer is its own when the row's pointer is at the target and its `pointerId` is the token of a swap the rollback sent,
whatever else was written to the row since (a lease, a retention or residency write): the rollback then checks the
target, audits the move and returns, as if the swap had answered. A row whose pointer is at the target by another
write's token is not its own: another rollback's identical move, or a write that renewed the `pointerId` over this
rollback's landed swap, which cannot be told apart from it. Then the rollback throws `WriteConflictError` after a
conflict and `TransientError` after no answer, audits nothing and deletes nothing, and a re-run finds the pointer where
it is. A registry that reports no tokens settles a swap that got no answer by the row the swap would leave, and a conflict never as landed.

## How a load stays correct

<a id="numbering-is-the-loads"></a>**Generation numbering is the load's.** Generations are write-once, and a load takes the next number itself: the one
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

<a id="round-trips-overlap-encoding"></a>**A load overlaps its round trips with its encoding.** The existence check, and the keystore's unwrap of an encrypted
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

<a id="sorted-load-reads-ids-last"></a>**A sorted load reads its ids last.** With `sorted: true` the ids are read while the object is written, so everything
else comes before the first of them: the row is read again (on a first load or an encrypted segment, as above) and
judged, the existence check is joined, and the key is unwrapped or minted. A destroyed segment, an encrypted one with no
keystore, and `requireEncryption` on a cleartext one are refused with no id read. The key is then in use while the ids
stream, and a shred that lands meanwhile is caught by the publish's fence on the row's token: the publish loses, the
load reports `superseded`, and its object is deleted under the `destroyed` row, one of the deletes by number invariant 2
allows. An error the ids raise mid-stream fails the upload, so no object is committed and nothing is published or
deleted; the caller gets that error as the very object raised, and the storage driver never sees it, only a sentinel of
the load's own. The ids are read once: a driver that runs its write again gets `IntegrityError`, not a shorter
object.

<a id="publish-is-forward-only"></a>**Publish is forward-only, so a rerun is safe.** The object is written first. Only once it is durable does the load
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

<a id="row-records-the-window"></a>**The row records the window, and the write that moves the pointer writes it.** The ledger of kept generations goes in the
same compare-and-swap as the pointer, derived from the very row that write is conditioned on, so the window a load deletes
by is the window that row held and no other. A publish keeps the `keep` most recently current generations below its own,
the ones a live lease holds and the ones a rollback left above its own, and nothing else; a publish over a row with no
usable ledger starts one from the bucket: the window a listing keeps, which can name the number a refused load took,
and later publishes keep naming it until the window pushes it out (see the paragraph on orphans below). A purge and
re-create leaves the row with no ledger, which only makes the next load start one; a write that leaves the pointer where
it is (`setRetention`, a crypto-shred aside) keeps it. A `rollback` carries the ledger it found, moving the target to its
end, so the next load draws its window from the order generations were made current, and starts none over a row that
had none.

<a id="which-fence"></a>**Which fence a publish carries.** Forward-only is right for a writer whose content does not depend on what was
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

<a id="write-goes-out-on-the-row-read"></a>**The registry write goes out on the row the load read, and the store's own condition still decides.** A publish hands
the registry the row it read (or the fact that it found none), so a registry that keeps the version of the object it
read sends the compare-and-swap, or the create-only write, at once, with no read of the row first. The S3, GCS and Azure
Blob registries do. The write is conditioned on the object's own version (`If-Match` on S3 and Azure Blob,
`ifGenerationMatch` on GCS, `If-None-Match` for a row that was absent), so a row another writer changed after the load
read it fails the write exactly as a lost race does, and the load reports `superseded`. The row the load read is never
what settles a write that got no answer: that is read again, as above.

<a id="crash-never-moves-the-pointer"></a>**A crash never moves the pointer.** If the process dies mid-write, the object never completes (every storage driver
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

<a id="orphan-collected-later"></a>**An orphan is collected later, and a rollback refuses it until then.** A publish never adds an orphan to the row's
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

<a id="miss-is-a-re-read"></a>**A miss is a re-read, not a failure.** If the generation an unpinned read is on is swept, the storage driver throws
`NotFoundError`. The storage source drops the stale snapshot, re-resolves `currentGen` and retries once, covering both
the fetch and the reopen, which are separate round trips. The call then serves the newer, committed generation: a move
forward within that segment's lifetime, never a torn object. A second miss is pathological (collection outrunning
resolution) and propagates instead of fabricating an absent answer. The one case that answers empty instead of
throwing is a segment with no generation left to serve at all, destroyed (crypto-shredded, destroyed in the clear or dropped), where reading empty is the
documented outcome.

<a id="exposure-window-is-the-ttl"></a>**The exposure window is the TTL, not the length of your call.** A snapshot is re-checked every `cache.genTtlMs`, so at
most `ceil(genTtlMs ÷ gap between publishes)` publishes can land under any snapshot a read actually uses: one, at the
2 s default, against any realistic publish cadence. A sixty-second `intersect` does not need a sixty-second window. A
pinned handle is the exception: it is never re-resolved, so its window is the length of the job it serves. So is a
store with no timed refresh (no registry, `cache: { genTtlMs: 0 }`, or a `StorageChunkSource` of your own, which the store times no refresh on), whose
snapshot lasts until an eviction, a read that finds its generation swept, or an invalidation moves it on, however long
that takes. There no finite `keep` covers it, and the re-read above is the mechanism that keeps it correct. A store
with a timed refresh serves a small generation's chunks from memory (its reader kept them), so a sweep of the
generation is noticed there at the next refresh, within `cache.genTtlMs`, and not by the read.

<a id="what-collection-does"></a>**What collection does, precisely.** A listing pass deletes generations strictly below `currentGen`, keeping the most
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

<a id="lease-read-from-the-row"></a>**A lease on a pinned generation is read from the row a collection already holds.** A load's collection, by name or by
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

<a id="lease-write-refuses-no-writer"></a>**A lease write does not refuse a writer fenced on the row's token.** Invariant 1's fence stays: a load, an erasure
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

<a id="collection-re-proves-the-row"></a>A segment can be purged and re-created while a paginated listing is in flight, so both branches re-read the registry
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

<a id="list-is-not-a-receipt"></a>**A list is not a receipt, so verify the bucket.** A collection pass that returns an empty list may have found nothing
to collect, and one that returns a name may have been beaten to it by a concurrent collector, which is the outcome and
not a failure. A caller that needs a receipt, as the erasure rewrite does, therefore checks that the generation is gone
from the bucket, not that it is a member of the returned list. A by-name pass's list is no receipt either, since it
names the generation it asked to delete whether or not it was there.

<a id="lower-pointer-bound"></a>**`g < currentGen` is a safe bound only against a pointer read after the listing.** A pointer read before it can be
higher than the one a purge and re-creation or a rollback leaves behind, which is why the ordinary branch above takes
the lower of the two.

### A rollback that races a collection

<a id="every-delete-reads-the-row"></a>Every loop that deletes generations reads the segment's row just before each delete. A rollback that is held to the
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

<a id="erasure-takes-out-of-the-ledger-first"></a>**An erasure takes what it will delete out of the row's ledger first.** Before its first delete, in one write after its
search, it removes from the row's ledger of known generations each holder it will delete by name and every name below the
pointer that its collection will delete ([what the write is, and its races](#how-an-erasure-stays-correct)). Its
collections then spare every generation the row names when they read the row before a delete, so they spare what a load
or a rollback has made known since; the call takes such a name out of the ledger again, below the generation it found
current, before it deletes it, so a generation the call deletes is one the row no longer names.

<a id="deleting-call-detects"></a>**Nothing can restore a deleted object, so the deleting call detects it.** Every read of the row it makes after a
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

<a id="rollback-check-gets-time"></a>**It gives the rollback's own check time to finish.** The more common order is the other one: the rollback's check runs
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

<a id="rollback-race-what-to-do"></a>**What to do.** Look before you act: `store.generations(ref)` lists what the bucket holds and marks the current
generation, and `checkConsistency()` reports the segment as `missing-storage-generation` while its pointer names a
missing object. Act only if the pointer still names one; a rollback that found its target gone has put the pointer back
itself, and the segment needs nothing: a rollback then would undo a load that took effect. While the pointer does name
a missing object, every read that opens the segment's current generation fails: roll back to a generation the bucket
holds (a target the row does not know needs `allowUnknown`), or load the segment again, which moves the pointer onto the load's own
new generation. The erasure also needs a re-run, as its ledger entry says
([reading the ledger](erasure.md#reading-the-ledger)).

<a id="rollback-race-cost"></a>**What it costs.** One registry read after a loop's last delete, when no read followed it, and none for a loop that
deleted nothing: a steady load makes one more GET than it would without it. On S3 a single-part load that deletes by name costs
$12.00 per million at the default prices, for 2 PUT-class requests, 5 GET-class and a delete
([the cost guide](cost.md#what-each-term-counts)). The rest is made only when a read finds the row naming a deleted
number, which a call where nothing raced never sees: one zero-byte read of that object, and when it is gone, up to four
more reads of the row over the waits above, each followed by a zero-byte read while the row still names a deleted
number.

<a id="rollback-race-limits"></a>**What it does not do.** It detects; it repairs nothing, and the rollback that moved the pointer is not undone. The
argument that it sees every such landing rests on a store that is consistent for a read after a write, as every
shipped backend is: a delete that lands before the rollback's check is seen by the rollback, and one that lands after
it can finish only after the rollback's move, so the call's next read of the row sees the move.

## How a pin stays correct

- <a id="pin-shares-the-caches"></a>**A pin costs a generation number, not a retained index.** The pinned reader lives in the same bounded LRU as every
  other reader. Its decoded chunks share the store's chunk cache and its bound, under keys of their own that no live
  read writes. So a pin is never handed a chunk a live read fetched from another generation, and it pays one GET for a
  chunk a live read of its generation already cached. A small generation's reader also holds that generation's
  chunk bytes, which count in the reader cache's byte bound.
- <a id="one-generation-per-call"></a>**One call reads a segment at one generation.** A combine that holds the same segment at two generations is refused
  with `ValidationError` when it is read, as a combine's other errors are. That covers pins of two generations, pins of
  one generation number in two incarnations of its name, and a pin beside a live handle of the same segment.
  Materialize one side first with `intersectInto(dest, [])`. Two pins of one object combine freely, and an `*Into` of a
  combine that is refused throws before it reads anything.
- <a id="pin-safe-across-re-creation"></a>**A pin is safe across a re-creation.** `pin()` records the pinned object's size and footer checksum. If the segment
  is purged and loaded again, which starts the new segment at generation 0 again, the pin never reads the new
  segment: what it has already read still answers, and anything it would have to fetch fails with `NotFoundError`, with
  or without a registry. An object of another size counts as another object, damaged or not. A replacement it has
  found is remembered, so later reads fail with no request, until the store forgets it. `store.invalidate(ref)` does
  that, and so does a later `pin()` of the same version that opens the pinned object again. The store remembers at most
  `cache.readerMax` of them. So once a restore puts the object back, invalidate its store: the pin then reads it
  again, and a pin taken after that reads the object then stored as its generation.
- <a id="pin-opens-its-reader"></a>**`pin()` opens its reader as it pins.** With a registry, pins of one generation taken while its row is unchanged
  share that reader while the store keeps it open, pins taken at the same moment included. Only the first costs a tail
  read, and a key unwrap for an encrypted segment, even if it is never read. Without a registry, every `pin()` lists the
  segment's objects and makes the tail read. `pin()` and every pinned read are retried as the store's reads are.
- <a id="pin-of-no-generation"></a>**A segment with no current generation pins nothing and reads empty.** A pinned segment whose row is later dropped or
  destroyed fails with `NotFoundError` once it must open its object again, rather than going empty part-way through a
  call.
- <a id="pin-answers-from-what-it-holds"></a>**A pin answers from what it holds.** It keeps the key its reader unwrapped while that reader stays open, and
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
- <a id="pin-needs-a-crbm-reader"></a>**It needs a `.crbm` reader**: the store builds one over a backend, and over a bare `IStorageDriver`. A
  `StorageChunkSource` of your own throws `UnsupportedError`.

## How retention stays correct

<a id="drop-registry-first"></a>**Why `dropSegment` does registry first, then storage.** Each position is load-bearing:

1. **Registry first.** After the tombstone, nothing resolves a generation, so no reader can reach for bytes about to
   disappear, and no writer can publish onto it: a load refuses a `destroyed` row, so a load racing the drop cannot
   resurrect the segment.
2. **Storage second, best-effort, and swept more than once.** Once the pointer is a tombstone, the segment reads as
   empty and is correct, so a failure part-way through leaks bytes, not correctness, and re-running collects the
   remainder. The sweep repeats (up to three passes) because a load that was already writing its object when the
   tombstone landed still finishes the write. Its publish is then refused, but the object survives and holds the
   complete set. **Check `generationsRemaining`**: non-empty means bytes are still there and the drop should be
   repeated, since a re-drop of a tombstone re-sweeps its storage. The retention sweep collects them only for a
   tombstone it wrote itself, through `retireExpired`; one a hand-run `dropSegment` wrote is left to you.

<a id="tombstones-purged-narrowly"></a>**Tombstones are purged, narrowly.** A retired segment leaves a `destroyed` row behind, and one dead row per retired
daily segment would accumulate forever. The sweep deletes those rows too, but only when all three of these hold,
because deleting the row is what makes the name writable again:

1. **The row carries the sweep's own retirement stamp.** This is a positive marker `retireExpired` writes on the
   tombstones it creates. It is not an inference from "destroyed plus an expired policy", which would be wrong, and
   dangerously so. A crypto-shred leaves `retention` untouched, so the ordinary ordering (set a 30-day policy, then a
   right-to-erasure request arrives mid-window and you call `destroySegment`) produces a GDPR tombstone that carries an
   expired policy. Deleting that row would destroy the local attestation for an Art. 17 execution and un-fence the
   name. A marker cannot be forged that way, so a `destroyed` row the sweep did not create is never touched.
2. **A grace period has passed since that stamp** (default 24 h). While the row exists every writer refuses the
   segment, and that is what stops an in-flight load from resurrecting it.
3. **Storage is provably empty for it.** If storage still holds a straggler generation, such as a load that was writing
   when the tombstone landed, the sweep collects it first, then purges. (The collection takes every generation of a
   destroyed row, and nothing else would ever run it for a tombstoned segment.) Only if storage still cannot be proven
   gone does the row stay, with `tombstone-not-empty`. Without the row the collection can no longer see the segment at
   all, and the objects would be billed forever. `tombstone-not-empty` also covers the case where the collection
   declined because the row changed under it. That is not a storage fault, and the next cycle simply retries. The
   collection is held to the tombstone the sweep is working: it refuses another incarnation of the name at each read
   of the row it makes (if another sweep or a delete purged the tombstone and the name was loaded again meanwhile, it
   refuses the new row and deletes nothing of it), and counts that as a lost race. A name purged and created again
   inside the one round trip between the read of the row before a delete and that delete is the window that remains,
   as for the ordinary collection below: that delete goes by number, and no read of the row follows the last one.

<a id="what-the-purge-removes"></a>**What the purge removes.** On a backend whose registry can delete a row only while it is unchanged, the purge removes
the row from the bucket for good (a removed row stays recoverable wherever the storage keeps a copy of it: with object
versioning on, until a noncurrent-version rule expires it, and with soft delete on, for its retention window: GCS, on by
default for a new bucket, 7 days; Azure Blob, where enabled. [`PRIVACY.md`](../../PRIVACY.md) says what a row holds), with a delete the store applies only to the version the sweep judged: S3
`DeleteObject` with `If-Match`, GCS with `ifGenerationMatch`, Azure Blob with `ifMatch`. The registry says which it is:
`backend.registry.capabilities().conditionalDelete`. It is on by default for S3 when the host the client resolves is an
AWS S3 host, for Azure Blob, and for the local-filesystem and in-memory backends. A full sweep then reads what is live and what is
inside its grace, not every name the namespace ever held: after 10,000 short-lived segments are created, retired and
purged, a sweep of that namespace makes one registry read, for the one segment still live.

Where the registry cannot, the purge leaves a small tombstone in the row's place, and every later full sweep reads it,
one request per row. That is the case:

- on an S3 client that sends to a host other than AWS S3 (MinIO, Ceph, R2), by default. Such a store may accept the
  precondition and ignore it, and MinIO does: there, a delete conditioned on a version that has moved on deletes
  anyway, and two sweepers and a re-create of the name could delete a live row. Set `conditionalDelete: true` on the
  backend only once you know your store applies it. The host is the one the SDK resolves, however the endpoint was set:
  a constructor `endpoint`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config file.
  An AWS regional, FIPS, dual-stack or VPC interface endpoint is an AWS S3 host, as is an access point's, a multi-region
  access point's, an Object Lambda's, an Outpost's and a directory bucket's, and AWS S3 applies the precondition there.
  Another AWS service's host whose name starts with `s3`, such as a load balancer, an API Gateway or a website
  endpoint, is not;
- on a GCS client, by default, the public endpoint included: whether real GCS applies `ifGenerationMatch` to a delete
  has not been verified by a run against the service, and fake-gcs-server accepts the precondition and ignores it, so
  CI cannot show it. Set `conditionalDelete: true` to remove rows for good;
- with `conditionalDelete: false` on any backend.

A `deleted: true` row already in the bucket stays: the purge never sees a row that is already deleted.

<a id="index-scan-purges"></a>**An index scan purges too, where the registry removes rows.** Each retirement files a pointer in the due index under
the day its tombstone's grace ends, beside the expiry pointers, and `scan: 'index'` reads it with them, so a namespace
can sweep by index alone and keep the fleet scan as its repair pass. No field of the row records that day: the purge
works it out from the retirement's stamp and the grace. The purge removes every pointer it read to the row, and the one
its own grace would have filed. Where the registry only tombstones, no pointer is filed: nothing is removed for good, so
a pointer would only add a row for every scan to read, and the fleet scan purges. A sweep run with a
longer grace than the one that filed a pointer finds it early and leaves it; once its day is older than
`lookbackBuckets`, the fleet scan purges the row.

<a id="pointer-to-foreign-tombstone"></a>**A pointer to a tombstone the sweep did not write is removed.** A segment given a policy and then crypto-shredded or
dropped by hand keeps a tombstone with no stamp, which the sweep neither retires nor purges, so its pointer would name
nothing for ever. A sweep that reads such a pointer reads the segment's row again, and if it is still a tombstone
without the sweep's stamp removes the pointer, fenced on the pointer's token, and leaves the tombstone as it was. It
works at most `limit` such tombstones per call, apart from the retirements that `limit` also bounds; those past the
cap wait for the next call, and `limited` reports retirements or purges still to do, not this cleanup. An index scan reads it in the days it covers and an unscoped `'fleet'` scan reads every one; neither runs
under `dryRun`, or on a registry that only tombstones its rows (a delete there rewrites the pointer as a tombstone, which every scan would still read). A pointer
removal the registry refuses is counted in `purgeFaults`.

<a id="pointer-outlives-its-row"></a>**A pointer can outlive its row, and what removes it.** The pointer's key spells out the namespace and the segment name,
so until it goes the name is in the bucket, in a key. It lingers when the purge did not run to its end:

- the purge ran with another `tombstoneGraceMs` than the sweep that filed the pointer, so the day it computes holds
  none (a purge removes the pointers its scan read, whatever day they are under, but a scan limited to a `namespace`
  reads none);
- a delete landed and lost its response, so the sweep never learned the row was gone and kept the pointer, as it must;
- the registry refused the pointer's removal (`purgeFaults` counts it);
- the pointer's day has passed out of `lookbackBuckets`, where no index scan reads it.

The next scan that reads it removes it, once the segment's row is read again and still absent: an index scan removes
it from the days it reads, and an **unscoped** `'fleet'` scan (no `namespace`) removes it from every day, since the
listing it makes already reads every pointer. A scan limited to a `namespace` lists no pointers, so a deployment that
scopes every sweep, or runs only index scans, keeps such a pointer until an unscoped fleet scan runs: run one as the
repair pass. The removal is fenced on the pointer's token, so a pointer filed anew is kept; it covers the sweep's own
`shards` only, never runs under `dryRun`, and removes at most `limit` pointers per call, each a few reads and a delete
(a pointer an index scan reads costs four reads and a delete in all, the listing's read of it included; one a fleet
scan reads costs two reads and a delete more than the scan already paid).

One race stays, and the fleet scan repairs it. A name created again with a policy due on the very day a pointer to
nothing sits under (a same-day or back-dated expiry) can lose that pointer: `setRetention` takes the pointer already at
the key as its own, and a sweep that read the segment before its row existed can remove it in the two round trips that
follow. The purge's own pointer removal has the same window: it can remove a pointer a re-created name has just taken as
its own, when that name's policy is due on the pointer's day. So does the removal of a pointer to a tombstone the sweep
did not write: a tombstone purged by hand and its name re-created inside the scan's window can lose the pointer the
same way, in the round trips between the row's re-read and each delete. The row is untouched and still expires; only its expiry pointer is gone, so an index scan never finds it, and
the default `'fleet'` scan, which reads every row, retires it. An index-only deployment is repaired only if it also
schedules a fleet scan, which is why the index is the fast half of a pair.

<a id="retention-cost"></a>**What it costs.** Per segment, counted with a store that counts requests. Where the registry removes rows, a
retirement is 7 reads, 2 writes and a delete, and a purge 4 reads and 2 deletes: the pointer is filed with a create,
which is the one write the removal of the expiry pointer would otherwise have been, and the purge removes the row and
the pointer where a tombstone would have been written. On S3 a `DeleteObject` is not billed, and a `PutObject` is.
Where the registry only tombstones (`conditionalDelete: false`, or a backend that does not report it), no purge pointer
is filed or removed: a retirement is 6 reads and 2 writes, a purge 3 reads and 1 write, and two small objects stay per
segment, which every full scan reads (100 reads for 50 segments). The registry needs delete permission on its prefix
(`s3:DeleteObject`, `storage.objects.delete`, or a role that may delete blobs); without it a purge fails, the row stays,
the ledger entry and `purgeFaults` say why, and the retirements behind it still go on.

An unscoped sweep also lists the due index's pointers, one read each before it skips them, so give each sweep a
`namespace` where you can. So does every other unscoped enumeration: `checkConsistency`, `eraseSubject`,
`subjectReport`, `store.segments()` and the `export-segments` CLI read each pointer before they skip it, and where
pointers are filed each tombstone inside its grace holds a second row, so those calls read about twice the rows of the
grace period. (The [roadmap](../ROADMAP.md) lists an unscoped listing that skips the pointers before reading them.)

<a id="keep-every-tombstone"></a>Pass `purgeTombstones: false` to keep every tombstone. That is the right choice if something outside this library
treats the presence of a `destroyed` row as an attestation. It includes the row of a retirement whose drop found no
storage generation to delete and left none behind:

- With the default, the sweep deletes that row in the same pass, since it would only fence the name. A `setRetention`
  on a mistyped name mints such a row. If that delete fails, the row is stamped and kept, and a later sweep deletes it.
- With `false`, it stays, stamped, and fences the name like any kept tombstone, until a sweep with purging on deletes
  it once its grace period has passed.

The ledger entry reports the retirement the same either way. There are two options rather than one
`number | 'never'` on purpose: `0` would have to mean "purge immediately" here while `cache.genTtlMs: 0` in this same
library means "never refresh on a timer", and one option whose zero is the opposite of another's is a trap for whoever
tunes both.

## How an erasure stays correct

<a id="erasure-is-a-rewrite"></a>**An erasure is a rewrite.** There is no per-id delete on an immutable object and no mutable tier to hold a
tombstone, so `eraseSubject` does what every other write in the library does. For each registered segment the id is a
member of, it streams the current generation through, with every chunk decoded and re-encoded and the one holding the
id with that bit cleared. It verifies the new object, publishes it fenced on the generation it streamed, and then
deletes the generation that held the bit (a collection with `keep: 0`). For every segment its ledger reports
`erased: true`, the bit is physically gone from the bucket when the call returns; a noncurrent version, a replica or a
backup keeps the old object until its own lifecycle removes it, and the uploaded part of a write that failed or was
killed, which no listing shows, is not reached. It reads the generation through the reader's coalesced chunk stream, in key order: chunks that sit within 256 KiB of
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

<a id="every-holder-goes"></a>**Every generation that holds the id goes, not only the current one.** A re-seed that drops someone leaves their bit
in the generation `keep` retains. A `store.rollback` leaves the generations it rolled back from above the pointer,
where a later rollback can make them current again. So the call searches every generation in the segment's bucket. A
holder below the pointer goes with the `keep: 0` collection, and each holder above it is deleted one by one. A
generation up there that never held the id stays as a rollback target when the current generation does not hold the
id, unless no read of the segment can open it, and then it goes whatever the id ([the effect across a
fleet](erasure.md#three-rules-while-you-erase)). A rewrite is numbered above everything, so its `keep: 0` collection takes every
older generation, above the pointer or below.

<a id="ledger-loses-what-it-deletes"></a>**The row's ledger loses what the call will delete, before anything is deleted.** The row's ledger of known generations
(`knownGens`) names the generations a collection by a count spares, and the ones a rollback vouches for: a rollback moves only onto a generation the ledger names, unless it passes `allowUnknown`. A rewrite publishes a ledger of itself alone, so every older generation is out of it before the
collection. A call that deletes without rewriting (the id is only in an older generation) writes the row once instead,
after its search and before its first delete, to take out of the ledger each holder it will delete by name and every name
below the pointer that its collection will delete. The current generation is never taken out, and the order of the rest
is kept. Only then does it delete. So a rollback that read the row before the write loses its swap, and the collection,
which spares every generation the row names when it reads the row before each delete, spares what a load or a rollback
has made known since; a name that comes back that way, below the generation the call found current, is taken out of the
ledger again before the call deletes it. The same write renews the row's `pointerId` when the call deletes by name. **A rollback without `allowUnknown` cannot bring an erased generation back, even when a delete fails** (an erasure that ends with an `error:` note because it could not remove a generation, or with `'superseded'`, or that crashes after the write): the generation is already out of the ledger, so the rollback is refused as unknown, above the pointer and below it. The two cases the pointer alone decides are the exception: a row with no usable `knownGens`, and a target below a full ledger's bound (its least recently current entry that no lease names), where a rollback below the pointer needs no flag. Re-run the erasure to delete what it could not. What the write does in a race:

- <a id="no-write-when-none-owed"></a>**No write when none is owed.** A ledger that names nothing to delete, and no renewal to make, costs no write. Neither
  does a call whose renewal another erasure's write already made after this call listed the bucket and whose names that
  write already took out: two erasures of different ids on one segment that delete the same generations write once
  between them, and both report `erased: true`.
- <a id="erasure-load-lands-first"></a>**A load that lands first.** Holders below the pointer: the call prunes against the pointer it finds, keeping the
  generation it found clean, which the load's window names and the collection then spares as the load's grace
  generation, and reports `erased: true` with every holder gone. Holders above the pointer that the load's number has
  left below it are taken the same way, with no renewal, since no load can publish a number below the pointer; but when
  the pointer has passed only some of the holders (a rollback onto a generation between them: a load passes all of them or none), the call is
  `'superseded'` and deletes nothing, below the pointer too. A rollback onto a holder (it needs `allowUnknown`, the
  holder being out of the ledger; on a row with no usable ledger nothing is taken out, and below the pointer the pointer
  alone decides) leaves that holder current, and the call reports `'superseded'` after it has taken the
  holders below the pointer.
- <a id="erasure-write-that-loses"></a>**A write that loses** to another writer is made again against the row read after it. The fifth lost write across the
  call's fences ends the call with `'superseded'` and no claim; when it is the first write, nothing was deleted. On a
  segment that loads many times a second that is an outcome to expect now and then, and a re-run settles it. A write of
  the row's leases alone costs no attempt.
- <a id="erasure-collection-spared-a-name"></a>**A collection that spared a name the row knows** is followed by a second pass. A rollback onto a holder (with `allowUnknown`), a load that
  kept a holder in its window, or a load that started a ledger on a row that had none, made the row name what the
  collection meant to delete since the write took it out. The call writes the row again to take those names out and
  collects again until a collection spares nothing the row names: at most six collections in all, the first and five
  more, whether or not a write was lost. A call whose sixth collection still spared a name the row knows stops there
  and, with a holder left in the bucket, throws a `WriteConflictError` for a re-run to finish, or answers
  `'superseded'` when the pointer has meanwhile moved past every holder. The rewrite's collection does the same for the generations below the
  rewrite.
- <a id="erasure-row-gone"></a>**A row that is gone** or a tombstone has no ledger: the deletes by name stop with the row's reason, and the
  collection reads the row itself. When every holder is below the pointer, so nothing is deleted by name, the call never
  answers `'absent'` while a holder is still in the bucket: it throws. A call that deletes by name and finds its row gone
  answers `'absent'`.

<a id="erasure-racing-writers"></a>**Racing writers.** Another writer that moves the pointer off the generation the rewrite derived from can be a load,
another erasure, or an operator's `rollback`. Another erasure collects with `keep: 0`, so it can delete the generation
this rewrite was still streaming, or the object it had just written. When two erasures of different ids race on one
segment, the loser's rewrite still holds the winner's id, and when it sits above the winner's pointer the loser deletes
it before returning, once its footer matches the loser's rewrite and the loser has renewed the row, which refuses every
publish fenced on a row read before it ([a number taken again](#how-an-erasure-stays-correct)). A renewal lost to another
erasure's renewal, as the losers of one race lose to each other, is waited out, up to the limit on lease waits, and
costs nothing. After 8 renewals lost to other writes (a load, a rollback or a retention write), the loser keeps an
object that can hold the winner's id, above the pointer and one `rollback({ allowUnknown: true })` from being served,
and reports `'superseded'`, until a later call takes it: the loser's re-run collects every generation below its own
when it rewrites, an erasure of the winner's id deletes it as a holder, and once loads have numbered past it their
collection takes it as it takes any orphan below the pointer, once no window the row's ledger names holds it
([an orphan is collected later](#how-a-load-stays-correct)).
The outcome is read off the registry row. A segment whose row is tombstoned
mid-rewrite is searched as a fresh call searches a tombstone, so a cleartext object a drop left that still holds the
id is deleted; one whose row is purged mid-rewrite is left out of the ledger, as a fresh call would leave it out. The rewrite publishes fenced on the generation it streamed and the row's token, and
not forward-only, for the reason given in [which fence a publish carries](#how-a-load-stays-correct).

<a id="rollback-during-erasure"></a>**A rollback during an erasure.** What the call reports depends on where the rollback lands:

- Before the publish, the entry says `'superseded'`.
- After the publish, while the call collects, the rewrite has left the row's list of known generations (`knownGens`)
  holding itself alone, so a rollback onto a generation it replaced or any older one is refused as unknown unless the
  caller passes `allowUnknown`, or the row has no usable `knownGens` and the target is below the pointer (the pointer
  alone decides there). When one of those lowers the pointer, the generation the rewrite
  replaced can be left above it, or be the one the pointer now names. A generation that still holds the id stays in the
  bucket, and the call reports an `error: ...` note instead of `erased: true`.
- When the id was not in the current generation and nothing was published, a rollback while the call deletes
  generations above the pointer (a rollback needs `allowUnknown` for one: the write took the holders out of the ledger) is
  reported as `'superseded'` if a holder is left, and one while it collects is an `error: ...` note. On a segment with no generation yet, a rollback (with `allowUnknown`: the row has published
  nothing, so it knows no generation) onto a first load's object while the call deletes those objects is reported as
  `'superseded'` too, and the object stays. On a row with no key,
  which is how `setRetention` makes one, such a rollback accepts only a cleartext object: it refuses an encrypted
  target there.
- In the last instant before a delete, a rollback onto the generation being deleted leaves the pointer on a missing
  object, which `checkConsistency()` reports: a generation above the pointer; on a segment with no generation yet, a
  first load's object that a rollback with `allowUnknown` accepts (on a row with no key, only a cleartext one); or an
  object below the pointer that the segment's key does not open, which only a rollback with no key at hand moves onto,
  and only on a row with no usable `knownGens` or onto a number below a full ledger's bound: any other rollback onto an
  object the row does not know is refused.
  The call reads the row just before each delete; one round trip remains between that read and the delete, and a
  condition on the object cannot close it, since the pointer then names the very object the call read. The rollback's
  own check ran before the delete, so it returns success. Nothing can put the deleted object back, so the erasure
  detects it instead: every read of the row it makes after a delete, and one more after its last delete, is held to
  what it deleted, and a row that names one of those generations with no object under it (one zero-byte read, made
  only then) makes the call throw `NotFoundError` rather than answer, never `erased: true`. When nothing left in the
  bucket holds the id, it emits its `segment.collect` event first, so the deletion is on the record; with a holder
  left, it emits nothing. A rollback whose own check ran after the delete finds the object gone and puts the pointer
  back, and the erasure can read the row between the two, so before it raises it reads the row again, at once and after
  waits of up to 1.75 s in all on the store's clock, and raises only if every read still names the missing object. A
  slower rollback can still be undoing itself, so check `store.generations(ref)` or `checkConsistency()` first: while
  the pointer names a missing object, reads that open the segment's current generation fail with `NotFoundError` until
  a rollback moves it to a generation in the bucket. One delete is not held to this: a refused rewrite's delete of its
  own object above the winner's pointer, where the call reads the row, then the object's footer, renews the row, then
  deletes. A rollback that read the row before that renewal is refused with `WriteConflictError` (or `TransientError`,
  when its swap got no answer); one onto that object between the renewal and the delete (the object is one no row
  published, so with `allowUnknown`, or without it once a load has raised the pointer past the object, on a row with no usable `knownGens`) leaves the pointer on a missing object with nothing
  reported, and only `checkConsistency()` finds it. A load that numbers above the object in that round trip, onto a row
  with no usable ledger, can name the object in the ledger it seeds; after the delete that entry names a
  missing generation, which takes a place in the window until a later load's collection drops it, and fails no read.

<a id="erasure-number-taken-again"></a>**A number taken again during an erasure.** A generation number can be taken again once its object is deleted. While
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
one more: a rewrite is deleted on the strength of a read of its footer. The footer carries the write identity the
rewrite drew, so it names that write: a load of the ids the rewrite holds, in the clear, writes the same chunks but
another identity, and its object does not match. So the call first reads the footer of the object under its number and
keeps one that is gone, is another object or cannot be read. Then it renews the row it read, as it does before deleting a holder, so a
load that wrote an object that read matched (only one with an all-zero identity can), which read the row before writing it, is refused at its publish. A
renewal that loses means another write landed since: the call reads the row and decides again. One lost to a write of
leases alone, or to another erasure's renewal, is waited out, up to the limit on lease waits, and costs nothing; after
8 lost to other writes the call keeps the object, as racing writers above says. Once its own renewal lands, it deletes,
passing the version the footer read reported, so a load that took the number after the renewal keeps its generation. A
delete the driver refuses there is a fault of the cleanup, and the call reports what the row says. Any other fault of
that delete, or of the renewal (its `TransientError` when it gets no answer that reading the row can settle), is
thrown in place of the answer, as any storage delete fault of an erasure is. A load the renewal refuses reports
`superseded`, as it does after any write that landed while it ran: load again. Which drivers report it:

| Storage | `conditionalDelete` |
|---|---|
| `MemoryStorage` | yes: the check and the removal are one step |
| `AzureBlobStorage` | yes, by default: a Delete Blob under `ifMatch` |
| `S3Storage` | yes when its client sends to an AWS S3 host, by default: a `DeleteObject` under `If-Match`. Read from the client on the first such delete, so `capabilities()` says `false` until then, and stays `false` when the client cannot be resolved (no region). Off for any other host, MinIO included, unless you set `conditionalDelete: true` |
| `GcsStorage` | only with `conditionalDelete: true`: a delete under `ifGenerationMatch`. Off by default, since no run against GCS has shown it applies the precondition to a delete, so on GCS the window below stays open unless you set it |
| `LocalFsStorage` | no: a filesystem has no delete conditioned on which file is under a path |

On a driver that does not report it, a delete in that window removes the load's generation, and the pointer names a
missing object, which `checkConsistency()` reports: the race of two erasures and a load stays open there, above the
pointer, on a segment with no generation yet and at a refused rewrite's discard alike. Above the pointer and on a
segment with no generation yet, the call that made that delete reads the row after it, finds the pointer on the number
it deleted with no object under it, and throws `NotFoundError` rather than answer, so the state is reported, though not
repaired. These limits hold on every driver:

- The condition names the object, not the row, so it does not cover the rollback in the last bullet above: the pointer
  then names the very object the call read. The call detects that one instead, as that bullet says.
- On S3 the version is the object's ETag, which for an object stored without SSE-KMS or SSE-C is computed from its
  bytes. Two objects with the same bytes, each stored whole in one request, or each in parts of the same sizes, share
  one. Every object this library writes carries a random write identity in its footer (an encrypted one, its index's
  nonce, and its chunks sealed under fresh nonces), so two writes of the same ids are never the same bytes, and a
  load that takes the number again does not share the holder's ETag: the condition refuses its object there as it
  does on a driver with a version per object. An object whose identity field is all zero, which a reader accepts,
  has the bytes of any other such object of the same ids and metadata, and the round trip before the delete stays
  open for it.
- A read of the footer names a write (to the 32 bits of its checksum), so it cannot take a generation a load published for a refused rewrite's object,
  whatever its ids: the footer does not match, and the discard keeps it, including when a rollback has moved the
  pointer below that generation before the call reads the row. A generation whose identity field is all zero is the
  exception, as above.
- A refused rewrite whose row is `destroyed` deletes its own object by number, and so does a refused load that finds
  its row unchanged, changed only in its leases, or `destroyed`: the decision comes from the row, and the write reports
  no version of what it wrote. Under a `destroyed` row every writer is refused until the row is purged, so no load
  takes the number again. Under a row that is unchanged or changed only in its leases, the round trip between the
  load's read of the row and its delete remains: if another erasure deletes that object as a holder and a load takes
  its number in it, that delete removes the load's generation.
- Generation collection, the `keep: 0` collection an erasure runs among it, deletes by number what a listing or the
  row's ledger names, below the pointer, with no object read behind the decision. A number below the
  pointer is taken again only after the pointer moves down (a rollback, or a purge and re-create), inside the round
  trip between the collection's re-read of the row and its delete, which is the rollback case above.
- `dropSegment`'s sweep, the retention sweep's collection of a tombstoned segment and an erasure's collection under a
  tombstone delete by number every object a listing names under a `destroyed` row. Every writer refuses that row, so a
  number there is taken again only once the row is purged and the name re-created. The retention sweep's collection and
  an erasure's are held to the row they worked from: a row purged and created again before the pass reads it, or while
  it lists, is refused and loses nothing, and so is one re-created before a delete, at the read before it. One
  re-created inside the round trip between that read and the delete can lose the generation under that number, which is
  the rollback case above; and no read of the row follows the last delete, so the pass does not see it. On a registry whose tokens carry no incarnation id (none this library ships), a name
  purged, created again and itself destroyed, sharing one creation stamp, is accepted as the tombstone the pass was asked
  for: its leftovers are deleted, which the collection rule allows, but an erasure's event names them as the asked-for
  row's, since the event carries no incarnation to tell the two apart. `dropSegment`'s
  sweep never re-reads the row.

<a id="erasure-results"></a>**The result of erasing one segment.** `eraseSubject` runs `eraseIdFromSegment` (an
internal function of the engine) over every registered segment and turns each result into a ledger entry. That
function answers `erased: true`, or a `reason`: `'absent'`, `'destroyed'`, `'no-generation'`, `'not-member'` (no
generation in the bucket holds it) or `'superseded'`. The ledger lists no entry for the first four. An entry is
`erased: true`; `erased: false` with `note: 'superseded'`; or `erased: false` with `note: 'error: …'` for a fault the
call caught. A ledger entry carries `note`, never `reason`.

- `erased: true` means no generation of the segment holds the id, checked by listing the bucket and reading what is
  left.
- That last read opens again every generation the call already found clean, but for two: the generation it found
  current and its own rewrite. Each of those is skipped only while the row, read after the listing, names it in
  `knownGens` with the footer checksum of the object the call read or wrote (to the 32 bits of the checksum, as above):
  a number with that checksum, as invariant 2 identifies a generation, never the number alone. A number can be taken
  again once its object is deleted. Within one row, another erasure can delete a generation this call found clean and a
  load take its number; across rows, a drop, a purge and a first load of the name number from 0 again. The object
  listed is then another one, so the call reads it, and one that holds the id makes it answer `'superseded'` or throw
  `WriteConflictError`, never `erased: true`. The row vouches only for those two because they are generations the
  pointer named while the call held them, and no writer of the library leaves an entry for one naming another object:
  no collection takes a generation the pointer names, a number below the pointer is taken again only after the pointer
  moves down or the name is created again, and a load that rebuilds a ledger from the bucket read the object while the
  pointer named it. Any other entry can outlive its object. On a row with no usable `knownGens`, a load that rebuilds
  one from the bucket records each object as it read it, and another erasure can delete one above the pointer before
  that load publishes; a load of the id can then take the number, and the row names it with the deleted object's
  checksum. A lifecycle rule, or any delete from outside the library, removes an object and leaves its entry. The
  row's incarnation would not be enough either: the load within one row takes the number under the same incarnation.
  The row is read after the listing, not before, since a drop, a purge and a load that land between the two would
  leave the earlier row vouching for an object no longer there; it is read only when the listing names one of the two,
  and a row with no usable `knownGens` (a row with no pointer has none) vouches for nothing. A failed read vouches for
  nothing too: the call opens every generation listed, and its answer stands. A route this leaves open: a delete from
  outside the library of the generation the call found current, or of its rewrite, then a rollback below it (which
  the third rule asks you not to run during an erasure) and a load of the id that takes its number before the call's
  last read. Every route needs a load of the id while it is erased, which
  [the first rule](erasure.md#three-rules-while-you-erase) asks you not to run.
- A tombstoned row has its bucket searched too. A crypto-shred leaves objects no key opens, but a cleartext destroy, a
  drop whose sweep left something, or a write that landed after it leaves objects anyone can read: when one holds the
  id, every object under the tombstone is deleted and the entry reads `erased: true`. The collection is held to the
  row the call searched: if the name was purged and loaded again before the collection read the row, the row it
  finds is another segment's, and the collection throws `WriteConflictError` and deletes nothing, so the new row's
  generations stay and no `segment.collect` event names them. A re-creation inside the one round trip before a
  delete is the window that remains (see the limits below): inside it the call can still answer `erased: true`, with
  its `segment.collect` event naming the new row's generation. Otherwise the result is
  `'destroyed'`, and the segment is not listed; the objects are left to the retention sweep's purge or a re-run of the
  drop.
- An object no read of the segment can open (on an encrypted segment, one sealed under a key the row does not hold; on
  a cleartext one with a generation, an encrypted one) is deleted as a holder whatever the id, wherever the call meets
  it but as the current generation or under a tombstone, and listed in `collected`; only a searched generation that
  held the id makes the entry `erased: true` ([the effect across a fleet](erasure.md#three-rules-while-you-erase)). An object the
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
  removes it ([a number taken again during an erasure](#how-an-erasure-stays-correct)). So a crashed first load's object is
  erased as any other holder is. On an encrypted store such an object is sealed under a key its load has not published, so it cannot
  be searched: it counts as a holder whatever the id, and is deleted too, and with only such objects the result is
  `'no-generation'` with them in `collected`, so the ledger lists nothing for the segment and its `segment.collect`
  event is the record ([the effect across a fleet](erasure.md#three-rules-while-you-erase)). A row with no
  object that holds the id, read with no generation by the call's first read, is `'no-generation'`, under
  `requireEncryption` too, and the call writes nothing. A row that loses its pointer after the call found one is
  `'superseded'`, not `'no-generation'`. A load
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
  that the id is still there. Re-run, and if a racing erasure of the same id got there first, the re-run lists nothing
  for that segment (the engine's result is `'not-member'`).
- A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had
  just written. The reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` once the
  tombstone's objects are searched as a fresh call searches them (`erased: true` when one still held the id and was
  deleted), and one purged by the retention sweep reports `'absent'`.
- A `NotFoundError` is raised when the pointer still names its generation and that generation's object is missing,
  the forbidden `missing-storage-generation` state, or is another object than the row's summary names by its
  fingerprint. No re-run fixes either: `checkConsistency({ summaries: true })` reports both. It is also raised when
  another writer moved the pointer onto a generation the call deleted and the row still named it after a wait, as
  above: check `store.generations(ref)` first, roll back to a generation in the bucket only while the pointer names a
  missing one, and re-run.
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

## How encryption stays correct

<a id="seal-count"></a>**How many seals one key takes.** Each chunk is sealed with a fresh random 96-bit nonce, and two seals under one key
sharing a nonce stays negligibly likely below about 2³² seals. Nothing counts seals or enforces that limit. A segment
keeps its key for its whole life, so every load and every erasure rewrite (which seals every chunk again) counts
toward it. It is far past any realistic workload; a segment that might approach it is created again, which draws a new
key.

<a id="never-half-encrypted"></a>**A segment is never half-encrypted.** A segment's encryption is decided at its first generation. Wiring a keystore
does not retroactively encrypt a segment that already has a cleartext generation: that load stays cleartext, and
with `encryption: { required: true }` it is refused with a `ValidationError` instead of silently downgraded. The
reason is that one segment cannot be half-encrypted. A pin of a superseded cleartext generation, once its reader is
reopened, would find bytes its key cannot open. And `destroySegment` would attest that shredding one DEK made every
copy unreadable, while the older cleartext objects stay readable from any of them.

The same rule from the other side: publishing an encrypted generation onto a segment whose row carries no key
material is refused. The only two silent outcomes there are an unreadable generation or an audit trail that claims too
much.

## How retries stay correct

<a id="fault-costs-a-re-run"></a>**A fault costs a read some latency and a write a re-run, never correctness.** Generations are write-once, so no
reader can pick up a half-written object. A publish only moves the pointer forward, and each attempt of its conflict
loop re-reads the row first, so no publish can move it back. All bytes are checksum-verified before use.

<a id="sdk-retry"></a>**Your client's own retry, and the writes it does not reach.** Each cloud SDK retries a failed request itself, under
the store's retry. For a conditional write that retry gives the wrong answer. A write that lands and then loses its
response is sent again, meets itself, and fails its own precondition, which reads as a lost race for a write that
won. This covers a generation's write-once put and the registry's create, compare-and-swap and delete (a tombstone
write, or a delete under a precondition where the backend's `conditionalDelete` is on). So the S3 and GCS packages send a conditional write with the SDK's retry off for that request alone,
but for two GCS writes that keep it: an object above `simpleUploadThresholdBytes` (a resumable upload, which the SDK
retries within its session), and the registry's delete under `ifGenerationMatch`, which its precondition makes safe to
send twice (a copy that meets the first's landed delete reads as a lost race, and a re-read settles it). With the retry off, a registry row is sent once, whatever the answer, and a generation's object once, or again
after a throttle, when a random id in its metadata tells a first send that landed from another writer's object. A row
write that gets no answer is settled by the load itself, which reads the row and sends a fresh compare-and-swap from
it if nothing changed, at most three times
([a load's writes](#when-a-write-is-throttled-or-gets-no-answer)). The Azure Blob package, whose retry has
no per-request switch, tags each write and, on a conflict, reads the stored blob back to see whose write it is. The GCS package does the same for an
object above `simpleUploadThresholdBytes`, which uploads as a resumable session. The client is otherwise left as it is, a client
you pass in included, and every other request it makes keeps the SDK's retry rules. The one exception is a GCS
download on the client `GcsStorage` builds, which the SDK does not retry and the driver does
([why](production.md#reliability-retries-backoff--timeouts)). A transient failure of a
conditional write reaches its caller as `TransientError`, and the write may or may not have landed. Where each
package stands:

| package | conditional writes |
|---|---|
| `@cloudbitmaps/s3` | the registry's create, compare-and-swap and delete, a `DeleteObject` under `If-Match` included, are each sent once. A generation's write-once `PutObject` or `CompleteMultipartUpload` is sent with the SDK's retry off, and again, at most three more times, after a `503 SlowDown` (or any `503`) and nothing else, waiting a random time under 500 ms, then 1 s, then 2 s. A bare `429`, which AWS S3 does not send but some S3-compatible services do, is not retried and is not classified transient: it surfaces as the SDK's own error, so a layer of yours that keys on `TransientError` will not retry it. The object carries a random id in its user metadata (`x-amz-meta-cbwid`), and a precondition failure, a `409` or an unknown upload on a re-send reads it back; with nothing stored, a `409` or an unknown upload is an unknown outcome (`TransientError`) |
| `@cloudbitmaps/gcs` | the registry's writes are each one request, sent once. An object up to `simpleUploadThresholdBytes` (8 MiB by default) is one request, sent again, at most three more times with the same waits, after a `429` or `503` and nothing else, and carries a random id in its metadata. A larger object is a resumable upload, a session of requests that the SDK retries within, under the client's retry options; it carries the same id, as every Azure Blob write does, as described below. The registry's delete under `ifGenerationMatch` goes through the SDK's retry, which a precondition makes safe: a second copy removes nothing the first could not |
| `@cloudbitmaps/azure-blob` | sent through the client's retry policy, which sends a request again after a network error or a 500 or 503, `503 ServerBusy` and `500 OperationTimedOut` among them. Each write is tagged with a random id in blob metadata, and a conflict reads the stored blob back to tell the write's own landing from another writer's, as described below. The policy runs under each fresh compare-and-swap a load sends for a row write that went unanswered, so a registry that never answers costs a load up to four times the policy's tries (sixteen requests at its default of four) before it throws: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that schedule, not measured). The registry's delete under `ifMatch` is sent the same way, safe for the same reason as GCS's |
| in-memory and local filesystem | nothing is throttled, so nothing is sent again |

<a id="tagged-writes"></a>**Writes that are tagged.** Azure Blob's retry is a policy on the client's pipeline, a GCS resumable upload is a session
the SDK retries within, and the S3 and GCS drivers send a generation's object again after a throttle, so each of those
writes can meet itself. Each carries a random id in the object's metadata (`cbwid`), outside the `.crbm` bytes and
outside the registry row's body. When such a write reports a conflict (for an S3 object or a GCS single-request upload,
only one that follows a re-send), the backend reads the stored blob or object back with one metadata request. It reports
success when the object carries the write's own id, and `WriteConflictError` otherwise. The read happens only on a
conflict, works with a client you pass, and adds no option. A read-back that fails transiently throws `TransientError`.
A generation's `.crbm` object is never overwritten, so its read-back is definitive. A registry row is overwritten by
compare-and-swap, so a writer that swaps in over a write that landed, before the read-back, makes that write report
`WriteConflictError`. The publish reads the row again on it, and after any registry write that ended without an answer,
and recognises its own write there by its effect: the pointer at its generation and, on a registry that reports write
tokens (Azure Blob's does), the row's `pointerId` the token of a write it sent, or, on one that does not, its own object
under the number. A publish overtaken by a write that moved the pointer reports `superseded`, and its refusal event
carries `unanswered: true`: the Azure Blob registry throws every conflict of a row write as one that may follow the
write's own landing (`unsettledConflict`), since its client's retry cannot be seen from the driver, so on Azure Blob a
load that lost an ordinary race at the registry carries the flag too (a [roadmap](../ROADMAP.md#on-the-way-to-10) item
records the narrower refinement). A conflict from the S3 or GCS registry, each row write sent once, carries none. A
rollback reads the row again on both too, and recognises its swap there: on a registry that reports write tokens, by the
row's `pointerId` being the token of a write the call sent, after a conflict or after no answer; on one that does not,
only after no answer, by the row the swap would leave, and after a conflict it never settles as landed. No caller
deletes a generation because of either, and a load whose row writes all go unanswered throws the registry's
`TransientError` and keeps its object. A multipart upload whose completion ends ambiguously or exhausted is aborted: S3
completes an upload atomically, so a completion that had landed survives the abort and one that had not is cancelled.
