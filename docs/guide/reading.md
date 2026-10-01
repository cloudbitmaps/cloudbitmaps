# Reading in depth

[Getting started](getting-started.md#read-it) shows the read verbs. This page covers what each one reads and costs,
how soon a reader sees a new load, how to read one fixed point in time, and how to page through a segment. Every
option of every verb is in the [segment verbs table](api-reference.md#the-segment-verbs-the-90-of-daily-use).

## Combine segments: intersect, union, andNot

`intersect`, `union` and `andNot` stream ids in ascending order, and each holds only a small window of chunks in
memory. What each one has to read is a property of the set operation, not of the implementation:

| | chunks read | can skip? |
| --- | --- | --- |
| `intersect` | keys present in **every** operand | **yes**: the headline feature |
| `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly, on the suppression side |
| `union` | every chunk of **every** operand | no: an id in any operand belongs to the result |

All three are charged against the same per-op budget, so a wide `union` is refused rather than quietly billed.
`intersect` is commutative: `a.intersect([b])` gives the same ids as `b.intersect([a])`.

**To suppress the result of an intersection, pass `exclude`. Do not chain.** `a.intersect([b], { exclude: [s] })`
folds the subtraction into one pass and reads `s` only at the keys that survived. Writing the intersection to a
temporary segment and then calling `andNot` makes an intermediate nobody wants, and reads `s` in full.

**Every operand must have been loaded.** A combine refuses an operand that names no segment, `this` and every
`exclude` included, with a `ValidationError` that names it. Read directly, a segment that was never loaded is empty,
which is right. As an operand, a mistyped name or a missing `namespace` would contribute nothing and look correct,
and as an `exclude` it would suppress nobody and return the whole audience. Pass `allowAbsentOperands: true` when an
operand may legitimately not exist yet. A segment loaded with no ids, or one that only has a retention policy, counts
as existing.

**To keep a result, use the `*Into` verbs.** `intersectInto`, `unionInto` and `andNotInto` write the result as a new
generation of another segment. See [Loading in depth](loading.md#write-a-result-into-another-segment-the-into-verbs).

## What a read costs

- **`count()` reads no payload.** It is summed from the `.crbm` index. A cold count is a pointer read and one tail
  read, which brings the index (a second read for an index larger than the tail read). A reader that already has the
  segment open re-reads only the pointer, at most once each `cache.genTtlMs`. So counting a ten-million-id segment
  makes the same requests as counting a thousand, while its index fits that one tail read.
- **`has()` comes from memory once warm.** A `has()` whose chunk is in the cache makes no request, beyond at most one
  pointer read per segment each `cache.genTtlMs` (2 s by default) for as long as the reader cache keeps the segment
  open.
- **`intersect` skips.** Two 2,000,000-id segments that share 100 of their 2,000 chunks intersect by fetching only the
  shared chunks. The [at-scale benchmark](../benchmarks.md#at-scale--measured-1k--10k--100k-segments) measured it at
  24.6 ms, on in-memory storage on an Apple M3 Pro, so that figure times the engine and not object storage.
- **A `has()` that misses the cache is a ranged GET against object storage.** If you need sub-millisecond answers on
  a working set that fits a bounded cache, an in-process store is the right tool.

What a load costs is on the [benchmarks page](../benchmarks.md#real-cloud-calibration--aws), and
[what it costs at your size](sizing.md) prices whole deployments.

## How soon a reader sees a new load

**A reader sees a new generation within `cache.genTtlMs`, 2000 ms by default.** After a load publishes, a reader may
serve the previous generation for up to that long, then switches. No restart is needed. This is the one place the
bound is stated; other pages link here.

- **Fresher reads:** lower `cache.genTtlMs`. It costs more registry reads.
- **Fewer registry reads:** raise it, and accept a little more staleness.
- **`cache.genTtlMs: 0` turns the timed refresh off.** The store then re-resolves a segment only when its reader
  cache evicts it, when a read has to fetch from a generation a sweep deleted, or when it is invalidated: by this
  store's own `load`, `rollback`, `eraseSubject` or `*Into` writes, or by `store.invalidate(ref)`. Another process's
  load then reaches it with no bound at all. Use `0` only for a store that never needs to see another process's
  loads.
- **An outage of the registry stretches the bound.** A refresh that fails with a transient fault (throttling, a 5xx, a
  dropped connection) keeps serving the generation the reader holds, and retries 500 ms later (or after the TTL, if
  that is shorter). The store converges within one retry of the registry answering. A refresh that fails with anything
  else, such as an access denial or a row that will not parse, is not ridden out: the call that meets it throws that
  error, and the next read resolves the segment afresh.
- **Without a registry** (a bare storage driver, which is read-only and cleartext), a store finds the generation by
  listing the bucket when it opens a segment, and keeps it until the reader cache evicts the segment, a read finds it
  swept, or it is invalidated.

**A long call can describe two instants.** Within one read, such as one `count` or one `intersect`, the generation is
resolved once, before any chunk is fetched, and every chunk is a whole, checksum-verified chunk of one generation. A
load landing mid-call never tears a chunk. But a long call can read its later chunks from another generation if it
straddles a TTL boundary, if the reader cache evicts the segment mid-call, if a sweep collects the generation it was
reading, or if the store invalidates the segment. Its answer then describes two instants. [Pin the segment](#read-one-fixed-point-in-time)
when that matters.

## Read one fixed point in time

`seg.pin()` returns a handle held at the generation that is current right now, for the life of the handle. A long
export, reconciliation or send then describes one instant instead of whichever generations happened to be current as
it ran. An ordinary handle re-resolves on `cache.genTtlMs`; a pinned one does not.

```ts
const audience = await store.segment('active-30d').pin();
for await (const id of audience.iterate()) {
  // every id of one generation, however long this takes
}
```

- **A pin covers one segment.** `snap.intersect([other])` reads `snap` at its pin and `other` live. Pin each segment to
  hold a whole query. A pinned handle used as an operand is still read at its pin.
- **A pin is a hold, not a lease.** Nothing stops a collection (a load's `keep`, an erasure, the retention sweep) from
  deleting the generation underneath you. A pinned read deliberately does not heal forward, because silently serving
  a different generation is what a pin exists to prevent. It fails with `NotFoundError` instead, for any chunk it must
  fetch from a generation that has since been collected. Chunks it already cached still answer.
- **Size `keep` for your longest pinned job:** keep more generations than the loads that can land on the segment while
  the job runs. See [Generations and `keep`](loading.md#generations-and-keep). An erasure collects the generation it rewrote whatever
  `keep` says.

## Page through a segment

`iterate` and every combine take a range: `after` and `through` yield only the ids in `(after, through]`, and fetch
only the chunks the range overlaps. That is keyset paging: each page asks for the ids after the last one the page
before it ended on, so no page walks from the first id. Give each page both bounds.

```ts
// Your functions: each yields or consumes ids.
declare const activeIds: Iterable<number>;
declare const euIds: Iterable<number>;
declare const optOutIds: Iterable<number>;
declare function send(page: number[]): Promise<void>;

// All three are loaded segments: an operand that names no segment is refused.
await store.load({ segment: 'active-30d' }, activeIds);
await store.load({ segment: 'zone-eu' }, euIds);
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, optOutIds);

// The audience is held at one generation for the whole send; the zone and the opt-out list are read live, page by
// page, so an opt-out that lands mid-send applies to the pages after it.
const audience = await store.segment('active-30d').pin();
const zone = store.segment('zone-eu');
const optOut = store.segment('global-opt-out', { namespace: 'suppression' });

// One streamed pass finds the window ends: every 1,000th id, then the end of the id space.
const ends: number[] = [];
let n = 0;
for await (const id of audience.iterate()) if (++n % 1_000 === 0) ends.push(id);
ends.push(4_294_967_295);

// Each window is an independent page, so workers can take them in any order. The first leaves `after` out, which
// is the only way to include id 0.
let after: number | undefined;
for (const through of ends) {
  const page: number[] = [];
  for await (const id of audience.intersect([zone], { after, through, exclude: [optOut] })) page.push(id);
  await send(page);
  after = through;
}
```

The range applies to every operand and every `exclude`, and a pinned operand is read at its pin. Each bound is an
integer in `0..4294967295`, or the stream throws `ValidationError` when first read. `after >= through` reads nothing,
so a cursor that reaches the end of its window needs no special case.

**Cost.** The per-op budget is charged once, before the first fetch, for every chunk in the range, so a page with
`after` alone is charged to the end of the segment however early it stops. A combine also fetches ahead: it starts
`concurrency` chunk keys at once (8 by default), and one more each time it yields a key's ids, on every segment it
reads. A page that stops early has already fetched up to `concurrency` keys past the one holding its last id. Those
chunks land in the chunk cache, where the next page usually finds them. `iterate` fetches one chunk at a time and
nothing ahead.
