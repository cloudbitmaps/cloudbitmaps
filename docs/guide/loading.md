# Loading in depth

How a load works, how generations are kept and collected, how to roll back, and the `*Into` verbs.

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

## Loading a segment

Loading is **the** write path, and `store.load(ref, ids)` is how you do it:

```ts
const r = await store.load({ segment: 'audience:active' }, idsFromWarehouse, {
  guard: { minRetained: 0.5 }, // refuse a load that would drop more than half the segment
});
if (!r.published) console.warn(`load refused: ${r.reason} (${r.cardinalityBefore} → ${r.cardinality})`);
```

That is one call for what is always four steps — take the next generation number, write one immutable object,
move the pointer, collect what the move superseded — and **the fourth is the one that gets left out** when the
sequence is composed by hand, so segments accumulate superseded generations nobody notices and everybody pays
for.

**Branch on `published`.** A load *replaces*: whatever the stream contains is what the segment contains
afterwards. So an upstream query returning fewer rows than usual is a shrink nobody asked for and an empty one
is a wipe — and at the storage layer both are an ordinary successful write, which is why a load checks its result
before it publishes. `guard: { minCardinality, minRetained }` says what counts as implausible, and an empty result
over a non-empty segment is refused even with no guard, as the last of the five points below says. A refusal is
reported rather than thrown, which means a discarded result is a load that silently did nothing.

Underneath, a load consumes a stream of ids, routes each into its chunk's bitmap, writes the whole set as one
immutable `.crbm` object, and publishes it so readers see it. Five things to know:

**Any id source, any order, duplicates welcome.** The input is a sync *or* async iterable, consumed lazily and
deduplicated on insert. An array, a `Set`, a generator, a file stream, a warehouse cursor:

```ts
async function* activeUsers() {
  for await (const page of warehouse.paginate(query)) for (const row of page) yield row.user_id;
}
const res = await store.load({ namespace: 'audiences', segment: 'active-30d' }, activeUsers());
res; // { generation, published, cardinality, collected, … } — what was written, and whether it is current
```

Memory is bounded by the **distinct set being built** — one compressed bitmap per non-empty chunk — not by the
input length, so a billion duplicate-heavy ids stream through holding only the distinct result. (The staging
buffer between input and bitmaps is capped at ~28 MB measured, whatever the key distribution.) It is `O(distinct
set)`, though, not window-bounded like `intersect`: a load holds the whole generation in RAM, which suits a batch
job and not a request handler — see [where to run it](production.md#what-blocks-the-event-loop-and-where-to-run-it).

**Generation numbering is the load's.** Generations are write-once, and a load takes the next number itself: one
above the highest the registry points at *or* that is present in the bucket, whichever is higher (a brand-new
segment starts at `0`). Both are consulted on purpose: a load that wrote its object and crashed before publishing
leaves an object *above* `currentGen`, and a writer consulting only the pointer would pick that same number and
conflict on every retry.

**Publish is forward-only, so a rerun is safe.** The object is written first; only once it is durable does the
load advance the registry pointer — a compare-and-swap that never moves backwards. Run the same job twice and the
second load is simply a newer identical generation. Run two loads of one segment at once and at most one of them
lands, and the other reports `published: false` with `reason: 'superseded'`. If both took the same generation
number, the second to write it is refused by the write-once put and writes nothing; if not, the publish that lands
second finds the row changed since its load read it, or finds a row where its load read none, and is refused. A load
that won the number can still be refused by its guard. The one exception is a segment with no row yet, loaded with
`allowEmpty: true` and no `guard.minRetained`: neither load read anything to fence on, so each is a forward-only
publish. If the lower generation number lands first, both land and the higher stays current; if the higher lands
first, the lower is refused as `superseded`, because a publish never moves the pointer back.

**A crash never moves the pointer.** If the process dies mid-write, the object never completes (every storage driver
commits atomically — a rename, a conditional PUT, a multipart complete) and the pointer still names the previous
generation, which readers keep serving. A load that dies between the write and the publish leaves an orphan: an
object that was never current. So does a refused load that finds another write has changed the segment's row, since
by then its generation number may name a re-created segment's object. Once a generation above it is current, it is one more
generation below the pointer, which collection counts within `keep` like any other. So under the default `keep: 1`
the load that lands above it keeps the orphan and collects the generation readers were on, and the next load
collects the orphan ([generation bookkeeping](#generation-bookkeeping-what-a-load-leaves-behind)). There is no half-loaded state a reader can observe: a
read resolves one generation and reads whole, checksum-verified chunks from it.

**An empty result over a non-empty segment is refused.** That is the wrong result for a warehouse query that
returned nothing because it failed upstream, and the library cannot tell it from a set that is genuinely empty, so
it asks: pass `allowEmpty: true` when emptying the segment is the point.

> **Do not load an empty segment "to create it".** A never-loaded segment already answers `count() → 0`,
> `has(x) → false`, `iterate() → []`; an empty load just costs an object and a registry row you then have to
> retire.

### Does this segment already exist?

There is no `create`, so you can never collide with an existing segment: `store.segment(name)` validates a name
and does no I/O at all. A segment starts existing when something is first **loaded** into it — and a load
**replaces** whatever was there, so the question worth asking before one is usually "is there data here
already?", not "will this fail?".

```ts
// Reporting, and skipping work you do not need to do:
if (await store.exists({ segment: 'users' })) {
  console.log('already loaded:', await store.segment('users').count());
}
```

Used as a *guard* before a load, it is a check-then-act and races like one — a concurrent load can land between
the two lines. That is usually fine for a batch job that owns its segment, and when it is not, the fence to
reach for is `load`'s own `guard` rather than this call.

`exists()` is one registry point read. It is deliberately **not** the same as `count() > 0`: a segment loaded
with no ids exists and counts zero, and telling *never loaded* from *loaded, and genuinely empty* is exactly
what `count()` cannot do.

To see everything you have, ask the registry — **do not keep your own list of segment names beside the store.**
That list is a second source of truth, and it drifts from this one the first time a load fails halfway:

```ts
for await (const s of store.segments({ namespace: 'active-daily' })) {
  console.log(s.segment, s.currentGen, s.status);
}
```

`segments()` is the registry's own enumeration — a paged LIST over the `registry/` prefix on an object-store
registry — so its cost tracks the size of your fleet, not the size of the answer. It is an admin and dashboard
call, not one for a request path.

Scope it to a `namespace` whenever you can: that narrows the LIST prefix, and really is the difference between
reading one tenant and reading all of them.

It streams, so stopping the loop stops the scan. It reads the registry directly and is not retried
([reliability](production.md#reliability-retries-backoff--timeouts)): a transient fault part-way through ends the loop with that error,
and calling `segments()` again scans from the start. It yields `destroyed` tombstones and rows with no data as-is rather than
quietly filtering them.

Neither call is a lock: a segment can appear or vanish between the check and whatever you do next. When the
answer has to *hold*, use the fence built for that — `load`'s `guard` (`minCardinality` / `minRetained`,
which refuse an implausible result instead of publishing it), or `expectFrom`/`expectToken` on a publish.

### A load is a batch job, not a request handler

A load is I/O-heavy — it streams the object to the bucket (S3 multipart past one part) — and CPU-heavy in short
bursts (serializing ~62,000 chunks for a segment spread across the id space). It yields the event loop
periodically so it is a well-behaved neighbour, and its memory is bounded, but it still burns a core for a
fraction of a second and holds a whole generation in RAM. Run it from a job runner, a queue consumer, a scheduled
task or a short-lived container — the process that produced the set is usually the right one — and keep the
request path for what it is good at: `has`, `count`, `intersect`.

## Materializing: the `*Into` verbs

The three combines each have a materializing twin — `intersectInto`, `unionInto`, `andNotInto` — that writes the
result as a **new generation of a destination segment** instead of streaming it to you:

```ts
// Every operand has to name a segment that exists (see below), so these are loaded first.
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

> **An operand that names a segment which does not exist is refused**, by every combine — the streamed ones as
> well as these. `store.segment('global-opt-out')` and
> `store.segment('global-opt-out', { namespace: 'suppression' })` are **different segments**, and unchecked the
> first one would resolve to nothing and suppress nobody — returning the full audience, with no error.
> The dangerous direction is the quiet one: a mistyped *include* collapses an intersect to nothing and you
> notice; a mistyped *exclude* removes a safeguard and you do not. Both are a `ValidationError` naming the
> segment. A segment with a registry row but no ids is still accepted, because somebody created it deliberately:
> a row minted by `setRetention` before its first load, a tombstone, or a segment loaded empty — even though
> `store.exists()` answers `false` for the first two, since a read of them finds nothing. It is only a name with
> no registry row that is refused. Pass `allowAbsentOperands: true` if you mean to combine against a name that
> may not exist yet; it then reads as empty.

Five properties, all consequences of "a write is a load":

- **The destination is superseded, not added to.** `campaign-targets` now holds exactly this result; whatever it
  held before is the previous generation. Re-running a window into the same target each day is therefore correct
  — each run is a fresh generation — and there is no accumulating-window hazard.
- **A range replaces the whole destination too.** The `*Into` verbs take the combine's `after` / `through`
  ([Page through a segment](reading.md#page-through-a-segment)), and `dest` then holds exactly the result's ids inside
  `(after, through]`: whatever it held outside the range is superseded with the rest, not kept. Materialising a
  range page by page into one destination leaves only the last page.
- **Readers of the destination see the old generation or the new one, never a partial.** The result streams into
  one immutable object under a bounded memory window (`concurrency × operands × chunk`), and the pointer moves
  only once the object is durable.
- **It deletes nothing**, unlike `load()`. The destination's previous generations stay in the bucket until you
  collect them — see [generation bookkeeping](#generation-bookkeeping-what-a-load-leaves-behind) — so a `rollback` target is
  still there afterwards. Pass `keep` to collect on the way through.
- **An empty or implausible result is refused, not published.** A combine that comes out empty over a
  **non-empty** destination leaves `dest` alone and reports it:

  ```ts
  const res = await audience.intersectInto(dest, [eligible]);
  if (!res.published) {
    // res.reason: 'empty' | 'min-cardinality' | 'min-retained'
    // res.cardinalityBefore: what dest still holds
  }
  ```

  An empty result into a destination that was never loaded still publishes — there is nothing to protect.
  Pass `allowEmpty: true` when emptying `dest` is the point, and `guard: { minCardinality, minRetained }` for
  the same plausibility bounds `load()` takes, judged against what `dest` held. A refusal is **reported, not
  thrown**; a lost race still throws `WriteConflictError`. A refused call also emits `segment.load-refused` to
  `audit` — a materialisation is a load, so it reports as one.

The verbs need the store built with a **backend** (they publish through its registry) and throw
`UnsupportedError` otherwise. To suppress the result of an
intersection, pass `exclude` to `intersectInto` rather than materializing a temp segment and then `andNotInto` —
the suppression folds into the same chunk-aligned pass and each exclude is read only where the intersection
survived.

## Generation bookkeeping: what a load leaves behind

Storage objects are immutable and generation-keyed, so **every write leaves its predecessor in the bucket until
something collects it**, still billed. Reads are unaffected — the pointer always names a live object — so the
only symptom of never collecting them is a storage bill that never goes down. Something has to delete them, and
in a library with no background process that something is the write's own collection, as the table below says:
`store.load` collects the generations it superseded, and an `*Into` does when you pass `keep`.

```ts
// An *Into that collects on the way through: deletes every generation below the new one, keeping the newest 1
// as a grace window. `collected` lists what it deleted.
const { collected } = await store
  .segment('campaign-targets')
  .intersectInto(store.segment('campaign-final'), [store.segment('opted-in')], { keep: 1 });
```

What the collection does, precisely: it deletes generations **strictly below `currentGen`**, keeping the most
recent `keep` of them (default `1` for `load`) so a read still fetching from the just-superseded generation need
not re-resolve mid-call — a window, not a lock, and [sized below](#sizing-keep). `keep` is a non-negative
integer: a negative, fractional, `NaN` or infinite value is refused with `ValidationError` before anything is
written. It never touches the current generation or anything above it (a load that is mid-write), and it deletes
nothing while `currentGen` is `null` — an object under a pointer-less row is either a load about to publish or an
orphan, and the two cannot be told apart safely. The one exception: on a `destroyed` segment (a drop or
crypto-shred tombstone) **every** generation is garbage and all are collected, because no reader can resolve a
tombstoned segment. A segment can be purged and re-created while a paginated listing is in flight, so **both**
branches re-read the registry row afterwards and reconcile with it. On a tombstone the row must still be the same
row, compared by its **token**: a generation number is not an identity, and a re-created name can wear the
very `currentGen` the tombstone held. On the ordinary branch the cutoff becomes the **lower** of the two
pointers — a load numbers its generation one above the highest of the pointer and any object in the bucket, so
it restarts at 0 once a row is purged and the bucket emptied, and a re-created name
wears a *lower* pointer than the one read before the listing, and deleting "everything below it" would take
the new incarnation's live object. A publish landing mid-listing moves the pointer *forward* and so changes
nothing, which is what keeps routine collection working on a busy segment.

The row is re-proved before **every** delete, not once after the listing, because the deletes are one round trip
each. If the segment changed underneath the pass the call **throws `WriteConflictError`** — re-run it, and note
that a refusal part-way through may already have deleted objects it will now never report. One more consequence of
the reconcile: `keep` counts distinct generations, not listing entries, so a listing that enumerates the same
generation twice cannot eat the grace window.

Who runs it today:

| Path | Collects? |
|---|---|
| `store.load` | **it does** — collection is part of the call, keeping `keep` generations (default 1) |
| an `*Into` | **you** — pass `keep` to collect on the way through; without it nothing is collected, and the next `store.load` of the destination collects everything below its own pointer beyond its `keep`. This is the step `store.load` exists to stop you forgetting |
| `eraseSubject` | **yes**, with `keep: 0` — the whole point is that the generation holding the bit does not survive the call. A holder *above* the pointer, which a `rollback` leaves there, is outside collection's range, so the erasure deletes it itself |
| `retireExpired` | **yes**, for the tombstones it wrote itself, and only with `purgeTombstones` (on by default) and after the grace period — it collects a straggler generation before purging the row. A tombstone a hand-run `dropSegment` or a crypto-shred left is never touched |
| `dropSegment` | deletes every generation of the segment it drops (and reports any it could not in `generationsRemaining`) |

**Read staleness, restated for the whole picture.** With a registry and a `cache.genTtlMs` above 0, a store
notices a new generation within `cache.genTtlMs` (default 2 s) and its cache is keyed by generation, so it never
serves a stale decoded chunk for a new generation. A `count()` is a single index read, so it is always internally
consistent. A **long** call is the one shape where the generation can move underneath you. A resolved snapshot
is re-checked once the TTL elapses, and three things force a fresh resolve even sooner: the reader cache evicting
an operand mid-call, a sweep collecting the generation the call was reading, and an invalidation (this store's own
`load`, `rollback`, `eraseSubject` or `*Into` writes, or `store.invalidate(ref)`). So a long `intersect` across a publish may read
its later chunks from another generation: every chunk whole, immutable and checksum-verified, never torn, but the
answer describing two instants rather than one, with nothing in the result saying so. `cache.genTtlMs: 0` removes
only the timed re-check, so it is no way to get one instant. That is what a snapshot handle is for:
`seg.pin()` holds a segment at the generation current when you call it, for the life of the handle it returns
([API reference](api-reference.md#the-segment-verbs-the-90-of-daily-use)), so a long export or reconciliation describes one instant.

### Sizing `keep`

`keep` is a **grace window**: a read fetches from the generation its snapshot names, and `keep` decides how
many publishes can land underneath before that object is gone. Three facts size it.

**A miss is a re-read, not a failure.** If the generation an unpinned read is on is swept, the Storage driver throws
`NotFoundError`; the storage source drops the stale snapshot, re-resolves `currentGen` and retries **once** —
covering both the fetch and the reopen, which are separate round trips and separately exposed. The call then
serves the newer, committed generation: a monotonic move forward within that segment's lifetime, never a torn object. A second miss is
pathological (GC outrunning resolution) and propagates rather than fabricating an absent answer; the one case
that answers empty instead of throwing is a segment with no generation left to serve at all — dropped or
crypto-shredded, where reading empty is the documented outcome.

**The exposure window is the TTL, not the length of your call.** A snapshot is re-checked every `cache.genTtlMs`, so
at most `ceil(genTtlMs ÷ gap between publishes)` publishes can land under any snapshot a read actually uses — **one**,
at the 2 s default, against any realistic publish cadence. A sixty-second `intersect` does not need a sixty-second
window. A pinned handle is the exception: it is never re-resolved, so its window is the length of the job it serves. So is a store with no timed refresh — no registry, `cache: { genTtlMs: 0 }`, or a storage source
built with no clock — whose snapshot lasts until an eviction, a read that finds its generation swept, or an
invalidation moves it on, however long that takes; there no finite `keep` covers it, and the re-read above is the
mechanism that keeps it correct.

**Each retained generation is a whole copy of the segment, billed.** `keep: 3` over a 40 GB segment holds
160 GB of object storage, not 40. That is the cost of a wide window, and the reason the default is `1`.

Which gives:

| your situation | `keep` |
|---|---|
| anything on a normal TTL — the common case | **`1`**, the default |
| publishes landing faster than `cache.genTtlMs` (a tight loader, or a raised TTL) | cover them: `ceil(genTtlMs ÷ gap between publishes)` |
| a large segment where a rare re-read is cheaper than a second copy | `0` |
| a long job on a pinned handle (`seg.pin()`), an export or a send | at least one for every generation written above the pinned one while the job runs — each load that lands, and each that is superseded or crashes before publishing — set on **every** writer that loads the segment, since each load collects with its own `keep`. A pin is never re-resolved: once its generation is collected, a chunk it has not already fetched fails with `NotFoundError`, and so does every chunk once the pin's own store writes the segment — a load, a `rollback` or an `*Into` write — since that drops what the store has cached. No value survives an erasure, which collects every generation below its new pointer |
| a long job that must see **one** instant, not merely succeed | a pinned handle, with `keep` sized as the row above — see below |

**What no value of `keep` gives you is a single instant.** The generation hop above has four causes, and
collection is one of them: a read whose TTL elapses, whose reader is evicted, or whose store is invalidated moves to
another generation whether or not the old one still exists. Retaining more copies removes only the sweep's heal,
and not even that after an erasure, whose rewrite collects every generation below its new pointer whatever `keep` says. A job that needs one instant (an export,
a reconciliation, a send that must match the count you reported) needs a snapshot handle, and the handle needs
`keep` sized as the table says.

There is deliberately **no time-based floor** on collection ("keep nothing younger than 24 h"). It would read
as a durability guarantee and would not be one: an ordinary read is already covered by the retry above, and a
job that must not change generations needs the snapshot handle, not a window wide enough to hope with. See
[Deliberately not planned](../ROADMAP.md#deliberately-not-planned).

### Rolling a segment back

`store.generations(ref)` lists what the bucket holds for a segment, and
`store.rollback(ref, toGeneration, { audit?, allowForward? })` moves the pointer to one of them — the one pointer
move no automatic path makes:

```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink();
const ref = { segment: 'audience:active' };
await store.generations(ref); // → [{ generation: 3, current: false }, { generation: 4, current: true }]
await store.rollback(ref, 3, { audit }); // → { fromGeneration: 4, generation: 3 }

// Generation 4 is still in the bucket, above the pointer now, so undoing the rollback needs the opt-in:
await store.rollback(ref, 4, { audit, allowForward: true });
```

A rollback deletes nothing, and it is fenced on the row it read, so a load that lands meanwhile makes it throw
`WriteConflictError` rather than being undone. A generation that is not in the bucket throws `NotFoundError` naming
the ones that are, and a target above the pointer throws `ValidationError` without `allowForward`, because that is
also where objects live that were never published, such as those of a load that died before its publish. A load
keeps one generation below the one it publishes by default (`keep: 1`), so there is one to roll back to; pass a
larger `keep` on the loads of a segment you may want to roll further back. Each move emits `segment.rollback` to
the `audit` sink you pass ([the audit trail](observability.md#audit-trail-security--compliance-events)), and this store drops its cached
view of the segment.
