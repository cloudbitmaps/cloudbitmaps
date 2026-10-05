# Reading in depth

> **These docs describe `main`.** The library is pre-1.0 and the API can still change. [The changelog](../../CHANGELOG.md#unreleased)
> lists what `main` has that the latest release does not, and the docs for each release are at its tag, on the
> [releases page](https://github.com/cloudbitmaps/cloudbitmaps/releases).

[Getting started](getting-started.md#read-it) shows the read verbs. This page covers what each one reads and costs,
how soon a reader sees a new load, how to read one fixed point in time, and how to page through a segment. Every
option of every verb is in the [segment verbs table](api-reference.md#the-segment-verbs-the-90-of-daily-use).

## Combine segments: intersect, union, andNot

`intersect`, `union` and `andNot` stream ids in ascending order, and each holds only a small window of ranges in
memory. What each one has to read is a property of the set operation, not of the implementation; how many requests it
takes to read it is not. Each operand's chunks are read as ranges of the object: chunks that sit within 256 KiB of each
other come in one request, up to 1 MiB, so two segments sharing 100 chunks that lie together are read in one request
each, where a request for every chunk would take a hundred:

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

- **`count()` is one request when cold, and reads no payload.** The registry row records the id count of the
  generation it names, so a cold count is the pointer read and nothing else: no read of the object, however wide its
  index, encrypted or not. A reader that already has the segment re-reads only the pointer, at most once each
  `cache.genTtlMs`, and a refresh that finds the same generation under a changed row (a `setRetention`) costs the count
  no re-open. So counting a ten-million-id segment makes the same requests as counting a thousand. A row with no
  summary it can use (one written before rows carried it, one that names another generation, one that does not open)
  sends the count to the `.crbm` index, which costs a tail read more. The row's word is what the count trusts: see
  [What `count()` trusts](#what-count-trusts).
- **`has()` comes from memory once warm.** A `has()` whose chunk is in the cache makes no request, beyond at most one
  pointer read per segment each `cache.genTtlMs` (2 s by default) for as long as the reader cache keeps the segment
  open.
- **`intersect` skips.** Two 2,000,000-id segments that share 100 of their 2,000 chunks intersect by fetching only the
  shared chunks. The [at-scale benchmark](../benchmarks.md#at-scale--measured-1k--10k--100k-segments) measured it at
  24.6 ms, on in-memory storage on an Apple M3 Pro, so that figure times the engine and not object storage.
- **A `has()` that misses the cache is a ranged GET against object storage.** Callers that miss the same chunk of the
  same generation while a request for it is open wait on that request, with or without a cache, so fifty concurrent
  cold `has()` calls of one chunk make one GET. A combine or `iterate` does not join those requests: it reads each
  operand as a stream of ranges, so concurrent identical cold combines each make their own few range requests. If you need sub-millisecond answers on
  a working set that fits a bounded cache, an in-process store is the right tool.

What a load costs is on the [benchmarks page](../benchmarks.md#real-cloud-calibration--aws), and
[what it costs at your size](sizing.md) prices whole deployments.

## What `count()` trusts

`count()` answers from the registry row's summary of the current generation when the row has one it can use, and from
the `.crbm` index otherwise. Neither decodes a payload, which is what makes it cheap.

**The row's summary** is used only for the generation it names, on an active row, in the shape the row's keys call
for: clear on a segment with no wrapped keys, sealed on one with them, and a sealed one is used only if it opens under
the segment's key with its generation as associated data. Anything else is no summary, and the count reads the index.
`requireEncryption` applies as it does to a read: a cleartext row is refused with `KeyUnavailableError`. The summary is
**not confirmed on the cold path**: someone who can write the registry row can edit it, and a count then answers what
the row says, as it answers a crafted but consistent index, and as that person could already repoint the generation.
Whenever a read opens the generation's object anyway (a `has`, an `iterate`, a combine, a `pin()`), the store holds the
row's id count and metadata against the object, at no extra request; a disagreement, including a row that has metadata
over an object that has none, stops that store from using that row's summary for that generation, so its counts then
read the object, and fails no read. `checkConsistency({ summaries: true })` finds the disagreement across a fleet. A
segment whose pointer names an object that is gone (a torn restore) still counts the row's number, which is true of
the generation the row names, while every read of the object throws: `checkConsistency()` is what finds it.

**The index**, which answers when the row has no summary it can use. Opening a generation checks the index once, and
refuses with `IntegrityError` an index that is not internally consistent:

- every chunk key in range and ascending;
- every cardinality in `1..65536`;
- every payload inside the payload region;
- on an unencrypted object, the footer's chunk count and total cardinality equal to what the index holds.

A corrupt index that is still internally consistent yields a wrong count, with no error. `iterate()` and the combines
decode the payloads, whose structure is checked. The same index supplies the chunk keys an `intersect` plans its
fetches from, and `load`'s `cardinalityBefore` when the row carries no summary of the generation. Where an exact answer matters more than the request count, `iterate()` the
segment and count what it yields.

## `stat()`: the generation, its count and its metadata

`seg.stat()` returns `{ generation, cardinality, metadata? }`: the number of the generation the handle reads, its id
count, and the metadata it was loaded with (absent when it has none). One resolution answers all three, so they
describe one generation and cannot straddle a publish. It is one registry read when cold, none when the store has the
segment, and none on a pinned handle, which answers for the generation it pinned. The same row read answers a `count()`,
so a `stat()` then a `count()` is one request. It trusts what `count()` trusts. A segment with no generation answers
`{ generation: null, cardinality: 0 }`, as does an expired handle.

`store.generations(ref)` carries the same `cardinality` and `metadata` on its current entry, from the row it already
reads. Only the current entry has them: the other generations are not opened.

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
- **An eviction re-resolves early.** When the reader cache evicts a segment's reader, the next read re-resolves the
  segment even if `cache.genTtlMs` has not elapsed.
- **An outage of the registry stretches the bound.** A refresh that fails with a transient fault (throttling, a 5xx, a
  dropped connection) keeps serving the generation the reader holds, and retries 500 ms later (or after the TTL, if
  that is shorter). The store converges within one retry of the registry answering. A refresh that fails with anything
  else, such as an access denial or a row that will not parse, is not ridden out: the call that meets it throws that
  error, and the next read resolves the segment afresh.
- **`store.invalidate(ref)` forgets what this store derived about a segment**: its open reader and the key that reader
  unwrapped, its decoded chunks, and those of every pin of the segment, so its next read resolves the current
  generation afresh. It also drops the segment's open chunk reads: a caller already waiting on one still gets its
  answer, a call made after the invalidation starts its own read, and the dropped read is not written to the cache.
  It does no I/O. The store's own writes (`load`, `rollback`, the `*Into` verbs, `eraseSubject`,
  `dropSegment`, `retireExpired`) do this for themselves. Call it for what they cannot see: a `destroySegment` or
  `eraseNamespace` beside the store, or another process's publish, erasure or drop, when your own fan-out delivers
  the news.
- **A small generation's chunks come with its reader.** When a reader's first read returned a whole object and its
  chunks total at most the reader cache's share per reader (`cache.readerMaxBytes` over `cache.readerMax`, 64 KiB by
  default), the reader keeps them and serves them from memory, so a sweep of that generation is not met by a read it
  serves, as a chunk-cache hit does not meet one. Only a store with a timed refresh keeps them, and the refresh is what
  moves the read on: a store with `cache.genTtlMs: 0`, or with no registry, keeps nothing and heals off a swept
  generation as above.
- **Without a registry** (a store built on a bare storage driver, `IStorageDriver`, instead of a backend, which is read-only and cleartext), a store finds the generation by
  listing the bucket when it opens a segment, and keeps it until the reader cache evicts the segment, a read finds it
  swept, or it is invalidated.

**A long call can describe two instants.** Within one read, such as one `count` or one `intersect`, the generation is
resolved once, before any chunk is fetched, and every chunk is a whole, checksum-verified chunk of one generation. A
load landing mid-call never tears a chunk. A long call can still re-resolve: a `cache.genTtlMs` boundary after a publish,
the reader cache evicting the segment, a sweep that collects the generation it was reading or an object replaced under
its number, and an invalidation (the store's own `load`, `rollback`, `eraseSubject` and `*Into` writes, `dropSegment`,
`retireExpired`, and `invalidate()`) each move the rest of it to the generation that is current then. A combine or
`iterate` reads each operand's chunks as ranges of the object and does this before it serves each chunk, exactly where
a read of one chunk would, so a range it had already requested of the earlier generation is dropped, not served; an
`exclude` read after an AND of two or more includes, a point read and every read of a source that reads chunk by chunk
(a custom one) re-resolve the same way. What a read can still serve from the earlier generation is what it had already
taken: up to `concurrency` keys per operand (32 by default) for a combine, up to 32 chunks for `iterate`, and up to 32
chunk keys on a source that reads chunk by chunk and for `count` where it reads chunks. Its answer then describes two
instants. A running combine or `iterate` holds the reader of the generation it is reading (its parsed index, any chunk bytes it kept, and, on an
encrypted segment, the key it unwrapped) until it moves on or ends, outside the reader cache's `readerMax` and
`readerMaxBytes`: one reader per streamed operand, for as long as the read runs. [Pin the segment](#read-one-fixed-point-in-time)
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
- **A pin is a hold, and a lease makes it a bounded one.** Without a lease, nothing stops a collection (a load's
  `keep`, an erasure, the retention sweep) from deleting the generation underneath you. A pinned read deliberately does
  not heal forward, because silently serving a different generation is what a pin exists to prevent. It fails with
  `NotFoundError` instead, for any chunk it must fetch from a generation that has since been collected. Chunks it
  already cached still answer, and so does every chunk of a small generation whose reader kept its chunks, for as long
  as the pin's reader stays in the reader cache; the reader's reopen after an eviction then fails the same way.
  [`pin({ leaseUntil })`](#hold-a-generation-for-a-job-a-lease) keeps the generation out of a load's collection until
  a time you choose.
- **Size `keep` for your longest pinned job:** keep more generations than the loads that can land on the segment while
  the job runs. See [Generations and `keep`](loading.md#generations-and-keep). An erasure collects the generation it rewrote whatever
  `keep` says.

### Hold a generation for a job: a lease

A job with a known end, such as a send that runs for 72 hours while a refresh job keeps loading the segment, can ask
for its generation to be kept instead of sizing `keep` for it:

```ts
const snap = await store.segment('active-30d').pin({ leaseUntil: Date.now() + 72 * 3_600_000 });
snap.lease;            // { holder, until }
// ... read snap for the length of the job ...
await snap.release();  // optional: lets a load's collection take the generation as soon as you are done
```

`leaseUntil` is an absolute instant in epoch **milliseconds**, after now and at most `MAX_LEASE_MS` (14 days) from it.
The lease is recorded in the segment's registry row, so every load that collects the segment, from any process, leaves the
leased generation in the bucket until the lease has ended. It is a hold on one named generation and on nothing else:
`keep` and the rest of collection are unchanged.

- **A read after the lease throws, and never reads empty.** Once the clock reaches `leaseUntil`, or after
  `release()`, every read of the handle throws `LeaseExpiredError`: `has`, `count`, `stat`, `iterate`, `batches()`,
  `costReport`, and a call of another handle that takes this one as an operand or as an `exclude`, or as the target of an
  `*Into`. An opt-out list held through a lease that has ended is an error, never an empty list that suppresses nobody. It
  throws whether or not the object is still in the bucket, and a small generation's cached reader is not consulted.
  `pin()` of a leased handle past its lease throws too; before it, `pin()` takes the generation current now, with no lease
  of its own.
- **A stream checks the lease before its first pull and each time it reads a chunk.** A stream built while the lease is
  live and first pulled after it ended throws, even when its result is empty. A read that is under way when the lease ends
  finishes the chunk it is on and throws at the next one, per id and per batch. `has`, `count` and `stat` check once, before
  they read, so one that starts before the lease ends may return after it.
- **Collection resumes after the lease.** A leased generation takes none of the `keep` window, and a load that spares it
  does not name it again. After the lease and a 60-second margin have ended, the next listing pass takes it: that is every
  sixteenth generation of the segment, or any load that has to list, so within 16 later loads of the segment. A segment
  that is never loaded again keeps it until something else collects it. A number retaken after a rollback and an
  erasure can be spared by an entry that named the object before it: a different object is then kept for at most the
  lease's own length, and the pin's own fingerprint stops it being read as the leased one.
- **The longest lease is 14 days, and a segment holds at most 64 live leases.** The 65th is refused with
  `LeaseLimitError` before anything is written. A lease that has ended makes room. Take one lease per job and give the job's
  tasks the one handle: each lease is one write to the segment's row, and writers of one row take turns. The row is as
  trusted as the registry: whoever can write it can fill its 64 places for 14 days, as whoever can write it can delete
  the segment, and a job that crashes without releasing keeps its place until its lease ends.
- **The margin is 60 seconds, and covers clocks that differ by that much either way.** The handle ends the lease at
  `leaseUntil` by its own store's clock, and a collector holds it for `LEASE_SKEW_MS` (60 seconds) longer by its own. A
  reader whose clock is behind a collector's by more than that, or a collector whose clock is ahead of the reader's by
  more, can find the generation collected inside the lease: a `NotFoundError` on a chunk it has not cached, never a wrong
  answer and never empty.
- **A lease is not an erasure shield.** `eraseSubject`, `eraseIdFromSegment`, `destroySegment`, `dropSegment` and a
  retention expiry delete a leased generation and clear the lease. A lease keeps superseded generations in the bucket,
  including ids a newer load removed, until it ends: [Erasing a subject](erasure.md) says what that means for a
  deletion request.
- **What it costs.** A leased pin makes the row read, one conditional write to the row and the tail read: one PUT-class
  request more than a pin without a lease. The write moves the row's token, which a load, an erasure rewrite, a
  shred, a drop, a rollback and a retention write are fenced on. None of them is refused by it: a row that differs from the
  one the writer read only in its leases does not refuse the writer, which goes on against the row it finds, after a
  jittered wait and without redoing its work ([how a load stays correct](loading.md#how-it-stays-correct)). A lease is one
  write per job, not per read.
- **It needs a backend with a registry**: `UnsupportedError` on a bare `IStorageDriver`, and `NotFoundError` on a segment
  with no current generation. A failed pin releases the lease it took. A store built with no clock cannot judge a lease,
  and its loads read none: `CloudRoaring` always has one, and a core `loadSegment` is given one in `deps.clock`.

### How a pin stays correct

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
  object again, and fails if that object is gone or replaced, or its row is gone or destroyed.

  Anything else leaves it as it is. After a `destroySegment` beside its store, or an erasure, a drop or a retirement
  through another store, in the same process or another, it answers from what it holds. That lasts until its store's
  reader cache evicts the pin's reader and the store's chunk cache evicts the chunks the pin decoded, or until
  `store.invalidate(ref)` is called on its store. Where the object it reads has been deleted, a chunk it has not cached
  fails at once, unless its reader kept the generation's chunks, which it serves until the reader is evicted.
- **It needs a `.crbm` reader**: a backend does, and so does a bare `IStorageDriver` or a pre-built
  `CrbmStorageChunkSource`. Any other pre-built `StorageChunkSource` throws `UnsupportedError`.

## Read a chunk at a time: `batches()`

`iterate`, `intersect`, `union` and `andNot` return an `IdStream`: `for await` it for one id at a time, as always, or
call `.batches()` on it for one `Uint32Array` per chunk.

```ts
for await (const id of audience.iterate()) send(id); // one id per await
for await (const ids of audience.iterate().batches()) await sendMany(ids); // one array per chunk
for await (const ids of audience.andNot([optOut]).batches()) await sendMany(ids);
```

- **When to use it.** A large scan spends its time on one `await` per id; `batches()` pays one per chunk. Measured
  locally on an in-memory segment of 10 million ids, `iterate()` ran at about 6 million ids per second and
  `.batches()` at about 90 million (the [changelog](../../CHANGELOG.md) has the run). Against real storage the round
  trips dominate either way, and the two read the same chunks. Use the per-id stream when you handle ids one at a time.
- **The same read.** The ids, their order, the chunks fetched, the budget charge, the read-ahead window and the
  generation rules are the per-id stream's. A range (`after`, `through`) is cut at its edges exactly as it is for the
  per-id stream, and a chunk with nothing in the range yields no array.
- **Ordering.** Each array is ascending, and the arrays arrive in ascending chunk order, so the arrays joined end to end
  are the per-id stream. No array is empty.
- **Memory.** One array per chunk: at most 65,536 ids, 256 KiB. It is allocated for that chunk and is yours to keep or
  change: the store keeps no reference to it, and changing it changes no later read.
- **Stopping.** Leaving the loop (`break`, `return`, a throw) ends the read, as for the per-id stream, with the same
  read-ahead already in flight.
- **`batches()` is its own read.** Each call starts a new read when it is called and fetches its chunks afresh, charged
  to the budget again, whether or not the per-id stream was read. The per-id stream is as it has always been:
  single-use, and a second `for await` over it yields nothing. On a pinned handle a `batches()` read is of the pin's
  generation; two separate reads of a live handle can see different generations, as any two reads can. A call that
  throws when its stream is first read (a bad range, an absent operand, a budget refusal) throws the same error from
  `batches()`.
- **Each array owns exactly its ids.** It is a copy of just those ids, not a view into a larger buffer, so
  `ids.buffer` is the array's own and can be handed to a worker.
- **A custom codec** without the optional `toUint32Array` export is read through its iterator: the same arrays, slower.

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
`after` alone is charged to the end of the segment however early it stops. It counts chunk reads, which is an upper
bound on the requests a read makes: chunks that sit near each other are read in one range request, so the requests are
fewer. A combine reads each operand as a stream of ranges and fetches ahead: it starts 4 ranges at once (or
`concurrency`, if that is lower), doubles with each range it takes until the window is `concurrency` wide (32 by
default), on every segment it reads. A page that stops early has already requested up to `concurrency` ranges per
operand past the one holding its last id: fewer when it stops in its first ranges, since the window opens narrow. Each is
up to 1 MiB, so a small page of a large segment can read up to a MiB where a request for its one chunk read a few hundred
bytes: free inside the region, transfer billed outside it. The chunks of those ranges that the read needed land in
the chunk cache, where the next page usually finds them. Pass a lower `concurrency` to ask for less ahead, at the price
of more round trips on a long read. `iterate` reads ahead too, through a stream that opens 1, 2, 4 and on up to 32 ranges
wide: a page that stops in its first range has requested that range alone. A full read keeps up to 32 ranges open, so a
segment too large for one range reads many times faster when the storage round trip dominates (a read that needs `n`
ranges of each operand takes about `n / 32` round trips in sequence), and a read that fits one range, as the calibration
shape does, is one round trip. An `andNot`, and a `union` with `exclude`, also read an exclude's chunks in the same round
as the include's, where an `intersect` of two or more segments reads an exclude's chunk only once the intersection of
that chunk is known to be non-empty. A range already requested is not cancelled when the caller stops: it finishes and
is billed, what it carries is dropped, and it is not retried, and the store reports a `storage.get` for it when it settles. On a source that reads chunk by chunk, a fetch already started finishes, lands in the chunk cache and is metered, and on one
that retries a transient failure, its retries run to their limit after the caller has gone.
