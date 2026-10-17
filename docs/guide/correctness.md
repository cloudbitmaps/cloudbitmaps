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

## When a load is refused

A load that is refused returns `published: false` and a `reason`. It does not throw. The previous generation stays
current, and the result still carries the numbers (`cardinality`, `cardinalityBefore`) so you can log what was
refused.

**A bound is judged after the write, before the publish.** The load writes the new generation's object first, unpublished,
then judges it, and only then moves the pointer. A refused load has written its object and deletes it, one write and one
delete, unless another write changed the segment's row meanwhile in more than its leases: then the object stays in the
bucket, an orphan that a later load's collection takes, and until it goes a rollback onto it is refused unless it passes
`allowUnknown`, since the row never recorded it ([why, and the exceptions](loading.md#how-it-stays-correct)). Nothing a reader sees changes. To judge the outputs of a `materializeMany` call without writing anything, use a
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
  itself ([a rollback that races a collection](loading.md#a-rollback-that-races-a-collection)).

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
