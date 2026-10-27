# The audience as it was on the send date

Pin the generation a send reads, keep the last few so it can be reopened, roll a bad refresh back, and record which generation each send used.

Segments are written once and never edited: a refresh writes a new generation and moves a pointer to it, and the older
generations stay in storage until a later load collects them. That makes "the audience as it was on the send date"
something the library can give you for as long as you retain the generation. This page walks it on `MemoryStorage` with invented
ids: the send that records what it read, the retention that lets you reopen it, the rollback of a refresh that went wrong, and the
limits of each. Every `Output` is what the repo's tests print when they run the blocks as written.

Use it when a send, a report or a model run has to be explained later ("who was in the audience on the 3rd"), or when a bad
refresh must be undone without rebuilding the audience. It is not an archive: see [Limits](#limits).

## Refresh with a window that keeps the last few

`keep` is how many older generations a load leaves behind when it collects. The default is 1. A weekly refresh that wants the
last three sends reopenable sets it to 3, on every writer of the segment, since each load collects with its own `keep`. Each
retained generation is a whole copy of the segment in storage ([generations and `keep`](../guide/loading.md#generations-and-keep)).

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });
const ref = { segment: 'vip' };
const refresh = (ids: number[]) => store.load(ref, ids, { keep: 3 });

const week1 = await refresh([1, 2, 3]);
const week2 = await refresh([1, 2, 3, 4]);
console.log(week1.generation, week2.generation);
```

Output:

<!-- output -->
```text
0 1
```

## Record what a send read

A send pins the segment, so that a refresh landing mid-send cannot change what it reads, and writes down what it pinned. The
pin's `pinnedAt` is the record: a generation number and a fingerprint of the object, which together name exactly that object
(a number alone does not, because a number can be taken again after its object is deleted).

<!-- typecheck -->
```ts
const send1 = await store.segment('vip').pin();
const sendRecord = { campaign: 'spring-1', readAt: send1.pinnedAt }; // store this beside the campaign
console.log(sendRecord.campaign, 'read generation', send1.pinnedAt?.generation, 'with', await send1.count(), 'ids');
await send1.release();
```

Output:

<!-- output -->
```text
spring-1 read generation 1 with 4 ids
```

`release()` on a pin with no lease does nothing: there is no lease to end, and the pin still reads. Store `readAt` with the campaign: it is the only thing that lets you
find the audience again. A send long enough to overlap refreshes takes a lease instead, so its generation is held while it runs
([hold a generation for a job](../guide/reading.md#hold-a-generation-for-a-job-a-lease)).

## Reopen it later

More refreshes land. `pinAt` reopens a recorded generation as a pinned handle, if the object is still there and is the object the
fingerprint names.

<!-- typecheck -->
```ts
await refresh([1, 2, 3, 4, 5]);
await refresh([1, 2, 3, 4, 5, 6]);

const at = sendRecord.readAt;
if (!at || at.generation === null) throw new Error('the send recorded no generation');
const then = await store.segment('vip').pinAt(at);
console.log('the audience of', sendRecord.campaign, 'was', await then.count(), 'ids; today it is', await store.segment('vip').count());
console.log(await collect(then.iterate()));

async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const ids: number[] = [];
  for await (const id of stream) ids.push(id);
  return ids;
}
```

Output:

<!-- output -->
```text
the audience of spring-1 was 4 ids; today it is 6
[ 1, 2, 3, 4 ]
```

Reopening costs a registry read and a tail read. It keeps nothing alive: how long a generation can be reopened is how long `keep`
retains it, or how long a lease holds it. Here the pointer is at generation 3 and `keep` is 3, so generations 2, 1 and 0 are
below it, and each refresh from here collects the oldest.

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

const old = sendRecord.readAt;
await refresh([1, 2, 3, 4, 5, 6, 7]); // generation 4: the window holds 3, 2 and 1
await refresh([1, 2, 3, 4, 5, 6, 7, 8]); // generation 5: the window holds 4, 3 and 2, and generation 1 is collected
try {
  if (!old || old.generation === null) throw new Error('no record');
  await store.segment('vip').pinAt(old);
} catch (error) {
  console.log(errorKind(error));
}
console.log(await store.generations(ref).then((all) => all.map((g) => `${g.generation}${g.current ? '*' : ''}`)));
```

Output:

<!-- output -->
```text
NotFoundError
[ '2', '3', '4', '5*' ]
```

A generation past the window is gone, and `pinAt` says so with `NotFoundError`: it never reads empty and never serves another
generation. If a campaign must be reproducible for longer than the window, do not widen `keep` for every segment (each retained
generation is a full copy): write the audience of that send, the ids themselves, to storage you retain (stream the
pinned handle's `iterate()` or `batches()` into a file or a `RoaringBitmap` and its `serialize()`; [`exportSegments`](../guide/export.md)
writes every segment's current generation, not a pinned one), and record where you put it. That copy is outside the store: `eraseSubject` cannot reach it, so list its location where
privacy requests look ([copies you made](privacy-requests.md#what-the-receipt-proves-and-what-it-leaves-out)) and give it an expiry.

## Undo a bad refresh

A refresh that publishes the wrong audience (a broken export that no guard caught) is undone by moving the pointer back to a
generation the segment's row still knows. `generations` lists what the bucket holds, and `rollback` moves.

<!-- typecheck -->
```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink();
const bad = await store.load(ref, [8], { keep: 3 }); // a truncated export, published
console.log('bad refresh', bad.generation, 'holds', await store.segment('vip').count(), 'id');

const rolled = await store.rollback(ref, 5, { audit });
console.log(rolled.fromGeneration, '->', rolled.generation, 'holds', await store.segment('vip').count());
console.log(audit.snapshot().map((event) => event.kind));
```

Output:

<!-- output -->
```text
bad refresh 6 holds 1 id
6 -> 5 holds 8
[ 'segment.rollback' ]
```

A rollback deletes nothing: generation 6 stays in the bucket until a later load collects it. On a row that has a record of its
generations, it moves only onto one the row knows (one a load or an earlier rollback made current, whose object still has the
checksum the row recorded); a generation the row does not know throws `ValidationError`, and `allowUnknown: true` is the deliberate
override, which the audit event records. Two cases are decided by the pointer alone: a target below the pointer needs no flag when the
row has no usable record or the target lies under the bound of a full one, and a target above the pointer always needs `allowUnknown`
([roll back a segment](../guide/loading.md#roll-back-a-segment)). The pointer otherwise moves only forward, so the next load numbers
above generation 6 and not above 5. Pass `audit` and the rollback leaves a `segment.rollback` event: that is the record of who moved
the audience back, and from where.

## What goes wrong

<!-- typecheck -->
```ts
try {
  await store.rollback(ref, 1); // generation 1 was collected: the row no longer knows it
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
ValidationError
```

| You see | What to do |
|---|---|
| `NotFoundError` from `pinAt` or from a read of a pin | The generation was collected: it is past the `keep` window and no lease holds it. Reproduce the audience from your own export, or widen `keep` and the lease for the next one. |
| `ValidationError` from `pinAt` | The record is not a pin's: a bare number, a missing fingerprint, an unknown key, or a pin of a segment that had no generation. Store `pinnedAt` as it is. |
| `ValidationError` from `rollback` | The target is not a generation the row knows. List with `store.generations(ref)`; `allowUnknown` is for an object you have checked by other means. |
| `IntegrityError` from `rollback` | A known generation whose object is not the one the row recorded: an object replaced or restored from outside the library. Do not roll onto it. |
| `WriteConflictError` or `TransientError` from `rollback` | A load landed meanwhile, so the rollback did not undo it, or a write got no answer. Read the segment, and run it again if it is still wanted. |
| `LeaseExpiredError` | The lease ended. A lease is at most 14 days. Take a longer one for the next send, and never treat this as an empty set. |

## Limits

- **`keep` is a count, not a time.** A window holds the last `keep` generations below the pointer whatever their age, and the library
  has no "keep nothing younger than a day" rule on purpose: it would read as a durability promise and not be one. Each retained
  generation is a whole copy, billed.
- **A lease is at most 14 days**, and a segment holds at most 64 live leases at once.
- **An erasure ends reproducibility on purpose.** `eraseSubject` deletes every generation that held the id, whatever `keep` or a
  lease says, so an audience as of the send date no longer exists for a person who asked to be forgotten
  ([a lease keeps superseded generations, and erasure ignores it](../guide/erasure.md#a-lease-keeps-superseded-generations-and-erasure-ignores-it);
  [why every holder goes](../guide/correctness.md#every-holder-goes)).
- **A pointer only moves forward within one incarnation of a row** ([publish is forward-only](../guide/correctness.md#publish-is-forward-only)).
  Only `rollback` moves it down, and only onto a generation the row knows, except the two cases the pointer decides (above). A segment that is purged and loaded again starts at generation 0, so a segment's identity is its row, never its generation
  number: record the fingerprint with the number, as `pinnedAt` does.
- **A retained copy is yours to erase.** An export of an audience's ids is beyond `eraseSubject`: keep a list of where copies are, and
  expire them.
- **A pin and a rollback are not a snapshot of several segments.** Each segment has its own pointer. A send that read three
  segments records three pins.
- **This page ran on `MemoryStorage`**, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
