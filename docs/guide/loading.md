# Loading in depth

[Getting started](getting-started.md#load-real-data) shows one load. This page covers the rest of the write side:
why a load is refused, what a load accepts, how many old generations to keep, how to roll back, and how to write a
result into another segment. How loads stay correct under crashes and races is at the end.

## Load a segment

`store.load(ref, ids)` is the write path. It is one call for what is always four steps: take the next generation
number, write one immutable object, move the pointer, and collect what the move superseded. The fourth is the one
that gets left out when the sequence is composed by hand, so segments pile up old generations that everybody pays for.

```ts
// Your function: yields the ids your warehouse query returns.
declare function idsFromWarehouse(): AsyncIterable<number>;

const r = await store.load({ segment: 'audience:active' }, idsFromWarehouse(), {
  guard: { minRetained: 0.5 }, // refuse a load that would drop more than half the segment
});
if (!r.published) console.warn(`load refused: ${r.reason} (${r.cardinalityBefore} → ${r.cardinality})`);
```

`r` is the result: `{ generation, published, reason?, size, sha256, chunkCount, cardinality, cardinalityBefore, collected }`.

`sha256` is the SHA-256 of the object as stored, and an empty string when another load took the generation number
first. The library does not keep it or check it on read: reads are checked with CRC32C. Record it if you want an
end-to-end check of your own.

**Branch on `published`.** A load replaces: whatever the stream contains is what the segment contains afterwards. An
upstream query that returns fewer rows than usual is a shrink nobody asked for, and an empty one is a wipe. At the
storage layer both are an ordinary successful write, which is why a load checks its result before it publishes.
`guard: { minCardinality, minRetained }` says what counts as implausible, and an empty result over a non-empty
segment is refused even with no guard. A refusal is reported rather than thrown, so a discarded result is a load that
silently did nothing.

## When a load is refused

A load that is refused returns `published: false` and a `reason`. It does not throw. The previous generation stays
current, and the result still carries the numbers (`cardinality`, `cardinalityBefore`) so you can log what was
refused.

| `reason` | Means | What to do |
|---|---|---|
| `'empty'` | The ids produced nothing, and the segment is not empty. | Usually an upstream query that failed quietly. Fix it and re-run, or pass `allowEmpty: true` if emptying the segment is the point. |
| `'min-cardinality'` | The set has fewer ids than `guard.minCardinality`. | Check the source. Lower the guard if the smaller set is real. |
| `'min-retained'` | The set is smaller than `guard.minRetained` times the current segment. | The same: a shrink bigger than you allowed. |
| `'superseded'` | Another writer got there first: another load took the same generation number, or the segment's row changed while this load was writing. | Re-run the load. |

A refused load also emits `segment.load-refused` to the `audit` sink you pass.

**What throws instead.** A refusal is an outcome. A throw is a fault:

- invalid options or ids, or a crypto-shredded segment: `ValidationError`;
- a key the keystore cannot provide: `KeyUnavailableError`;
- a current generation that will not open when the load reads its size for a guard: `IntegrityError`;
- a failure from your backend's storage or registry service, such as `TransientError`;
- a collection pass that could not prove the segment was unchanged: `WriteConflictError`. This can be raised after the
  publish landed, so a throw does not by itself mean the load did not take effect.

The `*Into` verbs throw on the same superseded condition instead of reporting it.

## What a load accepts

**Any id source, in any order, with duplicates.** The input is a sync or async iterable, consumed lazily and
deduplicated as it goes: an array, a `Set`, a generator, a file stream, a warehouse cursor.

```ts
// Your function: pages through the warehouse and yields each user id.
declare const warehouse: { paginate(query: string): AsyncIterable<Array<{ user_id: number }>> };
declare const query: string;

async function* activeUsers() {
  for await (const page of warehouse.paginate(query)) for (const row of page) yield row.user_id;
}
const res = await store.load({ namespace: 'audiences', segment: 'active-30d' }, activeUsers());
res; // { generation, published, cardinality, collected, ... }: what was written, and whether it is current
```

Pass the cursor itself. The one way to make a load expensive is to build the whole id list in memory first.

**Memory is bounded by the distinct set, not by the input.** A load holds one compressed bitmap per non-empty chunk, so a
billion duplicate-heavy ids stream through holding only the distinct result. The buffer between the input and the
bitmaps holds at most 1,048,576 ids, about 28 MB measured, whatever the key distribution. On S3 the writer also buffers
up to one upload part (8 MiB by default); an object that fits in one part goes up as a single PUT. A load still holds
the whole generation in memory, which suits a batch job and not a request handler.

**A load is a batch job, not a request handler.** It streams the object to the bucket and is CPU-heavy in short bursts
(serializing about 65,000 chunks for a segment spread across the id space). It yields the event loop periodically, so
it is a well-behaved neighbour, but it still burns a core for a fraction of a second and holds a whole generation in
RAM. Run it from a job runner, a queue consumer, a scheduled task or a short-lived container, and keep the request
path for `has`, `count` and `intersect`. See [where to run it](production.md#what-blocks-the-event-loop-and-where-to-run-it).

**Do not load an empty segment "to create it".** A never-loaded segment already answers `count() → 0`,
`has(x) → false` and `iterate() → []`. An empty load just costs an object and a registry row you then have to retire.

## Does this segment exist?

There is no `create`, so you can never collide with an existing segment: `store.segment(name)` validates a name and
does no I/O. A segment starts existing when something is first loaded into it. A load replaces whatever was there, so
the question worth asking before one is usually "is there data here already?", not "will this fail?".

```ts
// Reporting, and skipping work you do not need to do:
if (await store.exists({ segment: 'users' })) {
  console.log('already loaded:', await store.segment('users').count());
}
```

`exists()` is one registry point read. It is deliberately not the same as `count() > 0`: a segment loaded with no ids
exists and counts zero, and telling "never loaded" from "loaded, and genuinely empty" is exactly what `count()`
cannot do.

Used as a guard before a load, `exists` is a check-then-act and races like one: a concurrent load can land between the
two lines. That is usually fine for a batch job that owns its segment. When it is not, use `load`'s own `guard`.

To see everything you have, ask the registry. **Do not keep your own list of segment names beside the store.** That
list is a second source of truth, and it drifts from this one the first time a load fails halfway:

```ts
for await (const s of store.segments({ namespace: 'active-daily' })) {
  console.log(s.segment, s.currentGen, s.status);
}
```

- `segments()` is the registry's own enumeration, a paged listing over the `registry/` prefix, so its cost tracks the
  size of your fleet, not the size of the answer. It is an admin and dashboard call, not one for a request path.
- Scope it to a `namespace` whenever you can: that narrows the listing and is the difference between reading one
  tenant and reading all of them.
- It streams, so stopping the loop stops the scan. It reads the registry directly and is not retried (see
  [reliability](production.md#reliability-retries-backoff--timeouts)): a transient fault part-way through ends the loop
  with that error, and calling `segments()` again scans from the start. It yields `destroyed` tombstones and rows with
  no data as they are, rather than quietly filtering them.
- `exists` answers `false` for a row minted ahead of the first load (`setRetention` does that) and for a `destroyed`
  tombstone, because a read answers empty in both. Two states answer `true` where a read still gives you nothing, and neither is
  this call's job. A torn restore (a live pointer whose object was deleted) makes reads throw, which `checkConsistency`
  is the call for. And a handle with an expired `expiresAt` reads empty by a rule that lives on the handle.
- `segments()` yields `destroyed` tombstones and rows whose `currentGen` is `null`, because a filtered enumeration that
  looks complete is worse than an honest one. Filter yourself, or ask `exists` the narrower question. Internal
  bookkeeping rows are the one exclusion, and only on an unscoped scan: they live in the reserved `cbm.due.` namespace,
  so a `namespace` starting with it throws `ValidationError`, as it does in every call that takes one.
- Neither `exists` nor `segments` is a lock: a segment can appear or vanish between the check and whatever you do
  next. When the answer has to hold, use the fence built for that: `load`'s `guard`, or `expectFrom` and
  `expectToken` on a publish.

## Generations and `keep`

Storage objects are immutable and generation-keyed, so every write leaves its predecessor in the bucket until
something collects it, still billed. Reads are unaffected, because the pointer always names a live object, so the only
symptom of never collecting is a storage bill that never goes down. In a library with no background process, the
write's own collection does the cleanup. `keep` says how many old generations to leave behind.

**The default, `keep: 1`, is right for almost everyone.** `cache.genTtlMs` (2 s by default) is how long a reader may serve the generation it has before it checks for a newer one ([how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load)). Change `keep` only for one of the situations in this table:

| your situation | `keep` |
|---|---|
| anything on a normal `cache.genTtlMs`: the common case | **`1`**, the default |
| publishes landing faster than `cache.genTtlMs` (a tight loader, or a raised TTL) | cover them: `ceil(genTtlMs ÷ gap between publishes)` |
| a large segment where a rare re-read is cheaper than a second copy | `0` |
| a long job on a pinned handle (`seg.pin()`), such as an export or a send | at least one for every generation written above the pinned one while the job runs: each load that lands, and each that is superseded or crashes before publishing. Set it on **every** writer that loads the segment, since each load collects with its own `keep` |
| a long job that must see **one** instant, not merely succeed | a pinned handle, with `keep` sized as the row above |

**Each retained generation is a whole copy of the segment, billed.** `keep: 3` over a 40 GB segment holds 160 GB of
object storage, not 40. That is the cost of a wide window, and the reason the default is `1`.

**A pin is a hold, not a lease.** A pin is never re-resolved. Once its generation is collected, a chunk it has not
already fetched fails with `NotFoundError`. So does every chunk once the pin's own store writes the segment (a load, a
`rollback` or an `*Into` write), since that drops what the store has cached. No value of `keep` survives an erasure,
which collects every generation below its new pointer. [Reading in depth](reading.md#read-one-fixed-point-in-time)
covers pins.

**What no value of `keep` gives you is a single instant.** A read whose TTL elapses, whose reader is evicted, or whose
store is invalidated moves to another generation whether or not the old one still exists. A job that needs one
instant, such as an export, a reconciliation, or a send that must match the count you reported, needs a pinned handle.
See [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load).

There is deliberately no time-based floor on collection ("keep nothing younger than 24 h"). It would read as a
durability guarantee and would not be one: an ordinary read is already covered by a re-read, and a job that must not
change generations needs a pin, not a window wide enough to hope with. See
[Deliberately not planned](../ROADMAP.md#deliberately-not-planned).

**Who collects.** Collection deletes generations strictly below the current one, keeping the newest `keep` of them.
`keep` is a non-negative integer: a negative, fractional, `NaN` or infinite value is refused with `ValidationError`
before anything is written. It never touches the current generation or anything above it.

| Path | Collects? |
|---|---|
| `store.load` | **It does.** Collection is part of the call, keeping `keep` generations (default 1). |
| an `*Into` | **You do.** Pass `keep` to collect on the way through. Without it nothing is collected, and the next `store.load` of the destination collects everything below its own pointer beyond its `keep`. This is the step `store.load` exists to stop you forgetting. |
| `eraseSubject` | **Yes**, with `keep: 0`: the generation holding the bit must not survive the call. A holder above the pointer, which a `rollback` leaves there, is outside collection's range, so the erasure deletes it itself. |
| `retireExpired` | **Yes**, for the tombstones it wrote itself, and only with `purgeTombstones` (on by default) and after the grace period. It collects a straggler generation before purging the row. A tombstone a hand-run `dropSegment` or a crypto-shred left is never touched. |
| `dropSegment` | Deletes every generation of the segment it drops, and reports any it could not in `generationsRemaining`. |

An `*Into` that collects on the way through:

```ts
// Deletes every generation below the new one, keeping the newest 1 as a grace window.
// `collected` lists what it deleted.
const { collected } = await store
  .segment('campaign-targets')
  .intersectInto(store.segment('campaign-final'), [store.segment('opted-in')], { keep: 1 });
```

## Roll back a segment

`store.generations(ref)` lists what the bucket holds for a segment, and
`store.rollback(ref, toGeneration, { audit?, allowForward? })` moves the pointer to one of them. It is the one
pointer move no automatic path makes.

```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink();
const ref = { segment: 'audience:active' };
await store.generations(ref); // → [{ generation: 3, current: false }, { generation: 4, current: true }]
await store.rollback(ref, 3, { audit }); // → { fromGeneration: 4, generation: 3 }

// Generation 4 is still in the bucket, above the pointer now, so undoing the rollback needs the opt-in:
await store.rollback(ref, 4, { audit, allowForward: true });
```

- `generations` is one registry read and one listing, and it does not open the objects. It lists the bucket whether or
  not the segment has a registry row, so it also finds the objects a purged row left behind. It shows what the bucket
  holds, not what the segment has ever been, since collection deletes superseded objects.
- A rollback deletes nothing, and it is fenced on the row it read, so a load that lands meanwhile makes it throw
  `WriteConflictError` instead of being undone.
- A generation that is not in the bucket throws `NotFoundError` naming the ones that are.
- A target above the pointer throws `ValidationError` without `allowForward`, because that is also where objects live
  that were never published, such as those of a load that died before its publish.
- A target that is not what the row says the segment is throws `IntegrityError` before the pointer moves: a cleartext
  object under an encrypted segment (a write that never published, from a store with no keystore, before the
  segment's first keyed load), or an encrypted one under a cleartext segment. Every read would refuse it. The check
  reads the target's footer, one request, with no key.
- A load keeps one generation below the one it publishes by default (`keep: 1`), so there is one to roll back to. Pass
  a larger `keep` on the loads of a segment you may want to roll further back.
- Each move emits `segment.rollback` to the `audit` sink you pass
  ([the audit trail](observability.md#audit-trail-security--compliance-events)), and this store drops its cached view of
  the segment.

**Why rollback is not forward-only.** Forward-only is right for a writer: a load whose ids came from upstream loses
nothing by being out-raced, and regressing would let a slow loader silently undo a fast one. It is wrong for an
operator who has looked at the segment and knows which generation they want. So rollback refuses rather than guesses.
A crypto-shredded segment throws `ValidationError`, since every generation of it is unreadable, and rolling to the
generation already current is a reported no-op.

**What happens to the generations above the new pointer.** They stay, which is what makes a rollback reversible. They
are then above `currentGen`, where collection never looks. They remain until one of three things happens. Loads pass
them: each takes the next number up while no object holds it, the first whose number one of them holds numbers above
them all, and collection then keeps the newest `keep` of what is below its pointer. Or `dropSegment` deletes
them. Or an erasure deletes them: all of them when it rewrites, only those that hold the id when the current
generation does not. Rollback is audited as
`segment.rollback`, because every other pointer move can be reconstructed from "a load happened" and this one cannot.

## Write a result into another segment: the `*Into` verbs

The three combines each have a twin that writes the result as a **new generation of a destination segment** instead
of streaming it to you: `intersectInto`, `unionInto`, `andNotInto`.

```ts
// Your functions: each yields ids.
declare const shopperIds: Iterable<number>;
declare const activeIds: Iterable<number>;
declare const optOutIds: Iterable<number>;

// Every operand has to name a segment that exists, so these are loaded first.
await store.load({ segment: 'high-value-shoppers' }, shopperIds);
await store.load({ segment: 'active-this-week' }, activeIds);
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, optOutIds);

const shoppers = store.segment('high-value-shoppers');
const active = store.segment('active-this-week');
const optedOut = store.segment('global-opt-out', { namespace: 'suppression' });

const res = await shoppers.intersectInto(store.segment('campaign-targets'), [active], {
  exclude: [optedOut],
});
res; // { generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size, collected }
```

The verbs need a store built on a backend, because they publish through its registry, and throw `UnsupportedError`
otherwise. Five properties follow from "a write is a load":

- **The destination is superseded, not added to.** `campaign-targets` now holds exactly this result. Re-running a window
  into the same target each day is correct: each run is a fresh generation, so nothing accumulates.
- **A range replaces the whole destination too.** The `*Into` verbs take the combine's `after` and `through`
  ([page through a segment](reading.md#page-through-a-segment)), and the destination then holds exactly the result's
  ids inside `(after, through]`. Whatever it held outside the range is superseded with the rest. Materializing a range
  page by page into one destination leaves only the last page.
- **Readers of the destination see the old generation or the new one, never a partial.** The result streams into one
  immutable object under a bounded memory window (`concurrency × operands × chunk`), and the pointer moves only once
  the object is durable.
- **It deletes nothing**, unlike `load()`. The destination's previous generations stay in the bucket until you collect
  them (see [Generations and `keep`](#generations-and-keep)), so a `rollback` target is still there afterwards. Pass
  `keep` to collect on the way through.
- **An empty or implausible result is refused, not published.** A combine that comes out empty over a non-empty
  destination leaves it alone and reports it:

  ```ts
  const res = await audience.intersectInto(dest, [eligible]);
  if (!res.published) {
    // res.reason: 'empty' | 'min-cardinality' | 'min-retained'
    // res.cardinalityBefore: what dest still holds
  }
  ```

  An empty result into a destination that was never loaded still publishes: there is nothing to protect. Pass
  `allowEmpty: true` when emptying the destination is the point, and `guard: { minCardinality, minRetained }` for the
  same bounds `load()` takes, judged against what the destination held. A refusal is reported, not thrown; a lost race
  still throws `WriteConflictError`. A refused call also emits `segment.load-refused` to `audit`, since a
  materialization is a load.

A `WriteConflictError` from an `*Into` means the destination changed underneath the call, and it does not by itself
mean nothing was published. The same error covers a pointer that moved, a row rewritten by something that is not a
supersession at all (a `setRetention`), a purge, and the collection pass that runs after a successful publish. Re-read
the destination and decide; do not treat it as "the write did not happen". A call that involves an expired handle is
refused earlier and harder, with `ValidationError`.

To suppress the result of an intersection, pass `exclude` to `intersectInto` instead of writing a temporary segment and
then calling `andNotInto`. The suppression folds into the same chunk-aligned pass, and each exclude is read only where
the intersection survived.

**An operand that names a segment which does not exist is refused**, by every combine, streamed or not.
`store.segment('global-opt-out')` and `store.segment('global-opt-out', { namespace: 'suppression' })` are different
segments, and unchecked, the first would resolve to nothing and suppress nobody, returning the full audience with no
error. The dangerous direction is the quiet one: a mistyped include collapses an intersect to nothing and you notice,
while a mistyped exclude removes a safeguard and you do not. Both throw a `ValidationError` naming the segment. A
segment with a registry row but no ids is still accepted, because somebody created it deliberately: a row minted by
`setRetention` before its first load, a tombstone, or a segment loaded empty. Only a name with no registry row is
refused. `store.exists()` answers `false` for the first two, since a read of them finds nothing. Pass
`allowAbsentOperands: true` to combine against a name that may not exist yet; it then reads as empty.

## How it stays correct

This section is the mechanism. You do not need it to use a load, and it is here so you can check the guarantees.

**Generation numbering is the load's.** Generations are write-once, and a load takes the next number itself: the one
after the pointer it read, `currentGen + 1`, when one existence check finds no object holding it, and otherwise one
above the pointer and above every object in the bucket, from a listing. A brand-new segment starts at `0`. The check is
there on purpose. A load that wrote its object and crashed before publishing leaves an object above `currentGen`, and a
writer consulting only the pointer would pick that same number and conflict on every retry. A load can therefore
number below an object above the pointer, such as one a rollback left there, but never onto one: write-once refuses a
put to a number an object holds, and a load that loses that race reports `superseded`. A number whose object was
deleted can be taken again, so nothing identifies a generation by its number alone: caches key on the number and the
row's token, and a reader that finds the object under its number replaced re-reads the segment.

**Publish is forward-only, so a rerun is safe.** The object is written first. Only once it is durable does the load
advance the registry pointer, with a compare-and-swap that never moves backwards. Run the same job twice and the second
load is simply a newer identical generation. Run two loads of one segment at once and at most one of them lands; the
other reports `published: false` with `reason: 'superseded'`. If both took the same generation number, the second to
write it is refused by the write-once put and writes nothing. If not, the publish that lands second finds the row
changed since its load read it, or finds a row where its load read none, and is refused. A load that won the number can
still be refused by its guard. The one exception is a segment with no row yet, loaded with `allowEmpty: true` and no
`guard.minRetained`: neither load read anything to fence on, so each is a forward-only publish. If the lower
generation number lands first, both land and the higher stays current. If the higher lands first, the lower is
refused as `superseded`, because a publish never moves the pointer back.

**A crash never moves the pointer.** If the process dies mid-write, the object never completes (every storage driver
commits atomically: a hard link, a conditional PUT, a multipart complete) and the pointer still names the previous
generation, which readers keep serving. A load that dies between the write and the publish leaves an orphan: an object
that was never current. So does a refused load that finds another write has changed the segment's row, since by then
its generation number may name a re-created segment's object. Once a generation above the orphan is current, the orphan
is one more generation below the pointer, which collection counts within `keep` like any other. So under the default
`keep: 1` the load that lands above it keeps the orphan and collects the generation readers were on, and the next load
collects the orphan. There is no half-loaded state a reader can observe: a read resolves one generation and reads
whole, checksum-verified chunks from it.

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
store with no timed refresh (no registry, `cache: { genTtlMs: 0 }`, or a pre-built `StorageChunkSource` built with no clock), whose
snapshot lasts until an eviction, a read that finds its generation swept, or an invalidation moves it on, however long
that takes. There no finite `keep` covers it, and the re-read above is the mechanism that keeps it correct.

**What collection does, precisely.** It deletes generations strictly below `currentGen`, keeping the most recent `keep`
of them, so a read still fetching from the just-superseded generation need not re-resolve mid-call. It deletes nothing
while `currentGen` is `null`, because an object under a pointer-less row is either a load about to publish or an
orphan, and the two cannot be told apart safely. The one exception: on a `destroyed` segment (a drop or crypto-shred
tombstone) every generation is garbage and all are collected, because no reader can resolve a tombstoned segment.

A segment can be purged and re-created while a paginated listing is in flight, so both branches re-read the registry
row afterwards and reconcile with it:

- On a tombstone, the row must still be the same row, compared by its **token**. A generation number is not an
  identity, and a re-created name can wear the very `currentGen` the tombstone held.
- On the ordinary branch, the cutoff becomes the **lower** of the two pointers. A load numbers its generation from the
  pointer and what is in the bucket, so numbering restarts at 0 once a row is purged and the bucket emptied. A re-created name then wears a lower pointer than the one read before the listing, and deleting
  "everything below it" would take the new incarnation's live object. A publish landing mid-listing moves the pointer
  forward and so changes nothing, which is what keeps routine collection working on a busy segment.

The row is re-proved before **every** delete, not once after the listing, because the deletes are one round trip each.
If the segment changed underneath the pass, the call throws `WriteConflictError`. Re-run it, and note that a refusal
part-way through may already have deleted objects it will now never report. One more consequence of the reconcile:
`keep` counts distinct generations, not listing entries, so a listing that enumerates the same generation twice cannot
eat the grace window.
