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
- a current generation that will not open when the load has to read its size for a guard, which it does only when the
  segment's row has no usable summary of it (see [the guard's size](#where-the-guard-reads-the-size-of-the-current-generation)): `IntegrityError`;
- a failure from your backend's storage or registry service, such as `TransientError`, which does not by itself mean
  the load did not take effect ([below](#when-a-write-is-throttled-or-gets-no-answer));
- a failure in the collection's own reads or deletes, which can be raised after the publish landed, so a throw does not
  by itself mean the load did not take effect. A collection, by name or by listing, that finds another writer has moved
  the row since the load's publish (a load, a rollback, a purge) stops and returns what it deleted in `collected`: a load
  that took effect does not throw for a race it won.

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
| names this load's generation, over the object this load wrote | `published: true`: the write landed, and only its response was lost |
| names this load's generation over another writer's object, or belongs to another incarnation of the name | `published: false`, `reason: 'superseded'`: nothing this load wrote is published |
| has moved on, because another write changed it | `published: false`, `reason: 'superseded'`: this load's write can no longer land. An unguarded load of a segment with no row fences on nothing, and publishes over the row that appeared |
| is still as the write found it | the load sends a fresh compare-and-swap from the row it just read, after a wait on the store's clock: at most three, after under 500 ms, then 1 s, then 2 s. It is a new request, not a replay, and it carries the version the first one did, so the registry lets at most one of the two land. Each is settled by this same table. Still unanswered, the load throws the registry's own `TransientError` |

Whether the object under the row's pointer is the load's own is proved by its footer, never taken from the pointer and
the incarnation alone. On Azure Blob the client's retry policy runs under each of those writes too, so a registry that
never answers costs the load up to four times the client's tries before it throws: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that schedule, not measured).

**What a thrown `TransientError` leaves behind.** The object this load wrote stays, above the pointer, and nothing is
deleted: the write may still reach the registry after the load has returned, and a pointer that lands over a deleted
object is the one state no reader can recover from. Re-run the load. It numbers its generation past the orphan, publishes
whether or not the first attempt landed, and collection removes the orphan once a generation above it is current. To know
whether the first attempt landed, check `store.generations(ref)` rather than replaying the request.

A refusal that follows a write that went unanswered cannot say whether that write landed first, so the generation may have
been current for a while before another writer moved on: its `segment.load-refused` audit event carries `unanswered:
true`, and says only that the generation is not current now.

## What a load accepts

**Any id source, in any order, with duplicates.** The input is a sync or async iterable, consumed lazily and
deduplicated as it goes: an array, a `Set`, a generator, a file stream, a warehouse cursor. Or a whole bitmap, below.

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

**A bitmap you already hold.** When the segment is the result of set algebra you ran in memory, pass the bitmap
rather than its ids. `{ bitmap }` takes anything with `serialize('portable')`, such as `roaring`'s `RoaringBitmap32`;
`{ serialized }` takes bytes you already have in the portable Roaring format, from a file, a queue message, or an
export (`exportSegments`' `'roaring'` format writes it, so an export loads straight back).

```ts
import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;
// Your bitmaps: conditions evaluated once each, combined in memory.
declare const active: InstanceType<typeof RoaringBitmap32>;
declare const churned: InstanceType<typeof RoaringBitmap32>;
declare const bytes: Uint8Array; // portable Roaring, from wherever you keep it

const retained = RoaringBitmap32.andNot(active, churned);
await store.load({ segment: 'audience:retained' }, { bitmap: retained });
await store.load({ segment: 'audience:imported' }, { serialized: bytes });
```

- **It is the same load.** The generation is byte for byte the one the same ids write, and everything above holds
  unchanged: the guard and the empty refusal, `keep`, the fenced publish, encryption and the result.
- **It is checked first.** The bytes are size-capped at 537,403,396 bytes, more than any canonical 32-bit bitmap
  serializes to (call `runOptimize()` before serializing a bitmap that is over it), checked structurally the way
  every stored chunk is, and decoded by the safe deserializer, all before the load's first request. Bytes that fail
  are a `ValidationError`, and nothing is read or written. `{ bitmap }` is checked the same way: it is serialized once,
  at the call, so changing the bitmap after the call does not change what is loaded.
- **One buffer is one bitmap.** Bytes after the bitmap's last container are refused with `ValidationError`, so two
  serializations concatenated into one buffer are refused rather than loaded as the first of them. An empty buffer,
  or a detached one, is the empty bitmap.
- **No per-id work.** The chunks are cut out of the bitmap's own containers. What runs in JavaScript is per
  container and per byte: the structural check, which reads an array container's values once, and the checksum the
  write computes anyway.
- **It yields, except for two whole-bitmap steps.** Two steps do not yield, each for a time that grows with the
  bitmap's bytes: the input check and the native decode, which run at the call, before the load's first request;
  and re-encoding the bitmap before the write. The load yields on each side of the re-encode, and every 1,024
  containers while it cuts, re-checks and writes them. At the 537,403,396-byte cap they take about 400 ms or more and
  about 250 ms (derived: twice a load of 256 MiB of bitsets on an Apple M3 Pro, where the decode alone took 189–211 ms
  and the re-encode 113–136 ms; a smaller load understates them, since their time grows faster than the bytes).
- **The bytes must not change while the call runs.** A buffer that another thread is still writing (an `fs.read`
  or a `crypto.randomFill` into it that has not finished, say) can be decoded as bytes the check never saw. The load
  checks every container again as it writes it, so such a load throws `IntegrityError` and publishes nothing rather
  than a generation readers refuse; but bytes that change into another valid bitmap load as that bitmap. Await the
  write before you load the buffer.
- **It holds more than the bitmap.** At its peak a bitmap load holds a decoded copy of the bitmap and its
  re-encoded bytes, each about the size of the serialization, on top of the bytes you passed and what the backend
  buffers of the object it writes (one 8 MiB part on S3).
- **A bare `RoaringBitmap32` passed where ids go takes the same path**, when it comes from the copy of `roaring` that
  `@cloudbitmaps/roaring` uses. One from another copy is loaded as the ids it iterates, which is correct and slower;
  `{ bitmap }` works with either.
- **A byte array is not ids.** A `Uint8Array`, `Uint8ClampedArray` or `Buffer` passed as ids is refused with
  `ValidationError`, because each byte would be loaded as an id. Pass bytes as `{ serialized }`, and ids as a
  `Uint32Array` or an array of numbers. Every other typed array is ids. The refusal is made when the load runs: a byte
  array is an iterable of numbers, so the compiler accepts one as ids.
- **Parts of one segment, built separately.** Join them in one process and load the union once: a load writes one
  generation from one process. [The recipe](#parts-of-one-segment-built-separately) is below.

<!-- load-input:start -->
**How fast a bitmap loads.** `pnpm bench:load-input` measures a load from ids against one from a bitmap, on five sets
up to 14.4M members, and on one container layout at 10 % and at 90 % density. That pair holds nine times the members
in the same containers, so a path that works per id is expected to cost about nine times as much on the second, and
one that does not is expected to cost about the same. Its figures have not been measured yet. What is checked on every
change is that a 12M-member load from a bitmap calls none of the per-id routes: no iteration, no build from values,
no id split (`tests/roaring/load-no-per-id.test.ts`).
<!-- load-input:end -->

### Parts of one segment, built separately

A refresh split by id range across several processes builds one part of the segment in each. A load writes one
generation from one process, so the parts reach one process, which joins them and loads the union once.

```ts
import roaring from 'roaring';
import { CloudRoaring, ValidationError, deserializePortable } from '@cloudbitmaps/roaring';
const { RoaringBitmap32 } = roaring;

// In each worker: its range's part, as portable Roaring bytes. Send these to the joining process.
export function partBytes(part: InstanceType<typeof RoaringBitmap32>): Uint8Array {
  return part.serialize('portable');
}

// In the joining process: decode every part, join them, refuse an overlap, and load once.
export async function loadParts(
  store: CloudRoaring,
  ref: { segment: string; namespace?: string },
  shipped: Uint8Array[],
) {
  const parts = shipped.map((bytes) => deserializePortable(bytes)); // ValidationError if malformed
  const union = RoaringBitmap32.orMany(parts);
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  if (union.size !== total) {
    throw new ValidationError(`the parts overlap: ${total} ids in them, ${union.size} in their union`);
  }
  return store.load(ref, { bitmap: union });
}
```

- **Decode with `deserializePortable`, not `RoaringBitmap32.deserialize`.** Parts that cross between processes are
  untrusted input, as stored bytes are. `RoaringBitmap32.deserialize` hands the bytes to the native decoder, which
  bounds its reads and checks nothing else: bytes of the wrong shape decode into a bitmap whose sizes and answers are
  wrong, and some shapes crash the process. `deserializePortable(bytes)` makes the check a `{ serialized }` load makes
  first (the size cap, the structural check, exactly one bitmap) and only then decodes, and throws `ValidationError`
  for bytes that fail it. It takes a `Uint8Array`, which a Node `Buffer` is. A single part that needs no joining goes
  straight to `store.load(ref, { serialized: bytes })`.
- **Overlap is refused by the size check.** `orMany` merges parts that share ids without a word, so a range that two
  workers both built would load as if nothing were wrong. The members of disjoint parts add up to the members of their
  union, and they add up to fewer when any id is in two parts, so the recipe compares the two and refuses.
- **A range boundary may fall inside a chunk.** A chunk is the 65,536 ids that share their high 16 bits. When a
  boundary splits one, both parts hold a piece of it and the union merges them, so the generation is the same bytes a
  load of the whole set writes. Cutting on whole chunks keeps each part's chunks its own, and a union of parts like
  that copies containers rather than merging them.
- **It costs the requests of one load.** The parts never touch storage: they are bytes in your processes, so one part
  or eight make the same requests. A segment's first load is 2 PUT + 3 GET, pointer included, for a single-part
  object. A multipart load, one whose union is large enough to be uploaded in parts, makes 5 PUT-class + 3 GET. Both
  are [measured](../benchmarks.md#the-in-region-run--run-2026-10-06-9d36b), on a 1.05 MB and a 12.6 MB segment. A
  reload and a steady load at `keep: 12` are [measured](../benchmarks.md#the-in-region-run--run-2026-10-06-9d36b) too.
- **When this is not enough.** A segment too large for one process to hold, as its union and its serialization
  together, is not served by this recipe.

## Metadata: what a generation was computed from

`metadata` attaches a small record of your own to the generation a load writes: the version of the definition it was
computed from, when its data landed, the run that built it. It goes on `load`, on every `*Into` verb, and on a load of a
bitmap.

```ts
await store.load({ segment: 'audience:active' }, ids, {
  metadata: { definition: 'v41', landedAt: 1_790_000_000_000, run: 'r-2204' },
});
```

- **What it may hold.** A flat object of string keys and string or finite-number values. Nothing nested, and no boolean,
  `null`, `NaN`, `Infinity`, array or class instance. A key is at most 128 bytes and the whole record at most 1,024 bytes
  as canonical JSON: keys sorted by UTF-16 code unit, no whitespace, braces and quotes counted. Text has to be
  well-formed (a lone surrogate is refused), and `__proto__` is not a key. `undefined` and `{}` store nothing, and a
  generation without metadata is byte for byte the object it always was. Anything that breaks a rule is a
  `ValidationError`, thrown **before the load makes a request**: nothing is read and nothing is written.
- **It is copied when you call.** What is stored is the record as it was at the call, whatever the load's id source
  takes to run and whatever you do to your object meanwhile. Key order never changes the bytes, so the same record
  gives the same object.
- **Published with the pointer, and immutable.** The metadata is in the generation's object, and the segment's row
  carries a summary of the current generation (its id count and its metadata), written by the same compare-and-swap that
  moves the pointer to it. A reader that sees generation N as current therefore sees N's metadata, never a later
  generation's and never none. Nothing edits it afterwards: a new generation is how it changes, and a load does not
  inherit the previous generation's.
- **A rollback restores it.** The pointer moves to the target with the target's own count and metadata in the row. An
  erasure's rewrite is the same generation without one id, so it carries the metadata over as it is, and counts one id
  fewer. The metadata is not scanned for the erased id.
- **Never put a subject's id in it.** An erasure removes an id from the ids and leaves your metadata alone, and the row
  holds a copy of it. Put a version, a time or a run id there, and nothing that names a person.
- **Encrypted segments seal it** in the object, as the index is, and in the row. See
  [encryption](encryption.md#what-is-sealed-where).
- **Reading it back.** `seg.stat()` returns the generation's number, id count and metadata in one request when cold,
  and the current entry of `store.generations()` carries them from the row it already reads. See
  [reading](reading.md#stat-the-generation-its-count-and-its-metadata).

### Where the guard reads the size of the current generation

A guarded load compares what it wrote with what the segment held, which is the size of the current generation. It reads
that size from the row's summary of the generation: a row that carries one for the generation it names gives the guard
the number with no request for the object. A row with no usable summary is read as before, from the object's index
with one tail read: a row written before rows carried one, a summary that names another generation, or a sealed one
that does not open. The first load onto such a row writes a summary, and the next load reads none.

One behaviour follows from reading the row. A row that names an object that is gone (a lifecycle rule, a partial
restore) still remembers the size, so a repair load is judged against it: a repair smaller than `guard.minRetained`
allows is refused. A guard that has to open the object, because the row has no usable summary, meets an object it cannot
read and judges against nothing. Leave `minRetained` out to repair a segment whose row
remembers a size: `allowEmpty: true` does not lift a `minRetained` refusal. See [disaster recovery](disaster-recovery.md).

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
  this call's job. A torn restore (a live pointer whose object was deleted) makes reads of the object throw, while a cold `count()` still
  answers the number the row records, so `checkConsistency` is the call for it. And a handle with an expired `expiresAt` reads empty by a rule that lives on the handle.
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
| a long job on a pinned handle (`seg.pin()`), such as an export or a send | at least one for every generation written above the pinned one while the job runs: each load that lands, and each that is superseded or crashes before publishing. Set it on **every** writer that loads the segment, since each load collects with its own `keep`. Or lease the pin: [`pin({ leaseUntil })`](reading.md#hold-a-generation-for-a-job-a-lease) keeps that one generation whatever `keep` says, for up to 14 days |
| a long job that must see **one** instant, not merely succeed | a pinned handle, with `keep` sized as the row above |

**Each retained generation is a whole copy of the segment, billed.** `keep: 3` over a 40 GB segment holds 160 GB of
object storage, not 40. That is the cost of a wide window, and the reason the default is `1`.

**A pin is a hold, and a lease makes it a bounded one.** A pin is never re-resolved. Once its generation is collected, a
chunk it has not already fetched fails with `NotFoundError`. So does every chunk once the pin's own store writes the
segment (a load, a `rollback` or an `*Into` write), since that drops what the store has cached. No value of `keep`
survives an erasure, which collects every generation below its new pointer, and neither does a lease.
[Reading in depth](reading.md#read-one-fixed-point-in-time) covers pins and
[leases](reading.md#hold-a-generation-for-a-job-a-lease).

**What no value of `keep` gives you is a single instant.** A read whose TTL elapses, whose reader is evicted, or whose
store is invalidated moves to another generation whether or not the old one still exists. A job that needs one
instant, such as an export, a reconciliation, or a send that must match the count you reported, needs a pinned handle.
See [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load).

There is deliberately no time-based floor on collection ("keep nothing younger than 24 h"). It would read as a
durability guarantee and would not be one: an ordinary read is already covered by a re-read, and a window wide enough to
hope with is not a hold. A job that must not change generations needs a pin, and one with a known end can lease it: a lease
names the one generation it holds, so it never delays the collection of anything else, it ends at a time you set, and a
read after it throws rather than reads empty. See [Hold a generation for a job](reading.md#hold-a-generation-for-a-job-a-lease)
and [Deliberately not planned](../ROADMAP.md#deliberately-not-planned).

**Who collects.** Collection deletes generations strictly below the current one, keeping the newest `keep` of them.
`keep` is a non-negative integer: a negative, fractional, `NaN` or infinite value is refused with `ValidationError`
before anything is written. It never touches the current generation or anything above it.

**How `store.load` collects.** The segment's registry row records which generations below the pointer the last load
kept, up to 64 of them. A load that found a list there writes the new one in the same write that moves the pointer (the
newest `keep` of the old list and the generation it superseded) and, once that has landed, deletes **by name** each
generation that fell out of it, after re-reading the row before each delete. It lists nothing. A segment that loads
cleanly therefore pays one pointer read and one delete for collection at any `keep` up to 64, not a listing. A generation
is in the list only if a load published it, so a number a refused or crashed load took is never in the way of a window.
A load lists the segment's objects instead in these cases:

- every 16th generation, so what the by-name loads leave behind is gone within 16 generations: the object a crashed or
  refused load left below the pointer, one a delete that failed left, a generation a rollback or an erasure stranded.
  The pass deletes every generation below the pointer that the row does not name. The count is of generation numbers, so
  a rollback, which moves the pointer down, starts it again from the generation it moves to;
- when the load's check of its generation number met an object, which is a crashed load's or what a rollback left
  above the pointer, or its check of the current generation's object found it gone, which a lifecycle rule or a
  partial restore does. A guard that opens the object finds that out itself. A guard that took the size from the row's
  summary opened nothing, so a load with a `keep` of 1 or more that is about to delete by name looks for the current
  object with one zero-byte read first, and lists unless it finds it. A `keep` of 0 deletes the generation it
  superseded, which is the object in question, so it makes no such read;
- when the row records no list: a `keep` above 64, which a row cannot record, and the first load of a row that no
  load of this release has written, or that a rollback moved. That load keeps the newest `keep` generations it finds
  below the pointer and records them, so the next one collects by name. A `keep` above 64 lists on every load.

The row's list is a cache of what a listing would keep, and the listing repairs it. A name in it can be missing from
the bucket after a lifecycle rule or a collection that was not a load's took the object; the window then holds fewer than
`keep` real generations until the name ages out, at most `keep` loads, and nothing that should stay is deleted. A fleet
that mixes `keep` values up to 64 with larger ones, or with writers that record no list, lists on the loads with the
smaller `keep`, because the larger one drops the list: set the same `keep` on every writer. Because each load collects with its
own `keep`, a load with a smaller `keep` can delete a generation that a wider load's list names; the list is a request to
keep, not a promise that the object is there.

A `keep` that is at least the generation just published collects nothing and asks the bucket for nothing, since no
more generations than that exist below it: that includes a default `*Into`, which keeps every generation.

`LoadResult.collected` then names the generations it deleted by name, and one may have been gone already: a
delete of an absent object succeeds on every backend and does not say it found nothing. A list is not a receipt, and
neither is this one. An `*Into` always lists when it is given a `keep`.

| Path | Collects? |
|---|---|
| `store.load` | **It does.** Collection is part of the call, keeping `keep` generations (default 1): by name at any `keep` up to 64, by listing on every 16th generation and in the cases above. |
| an `*Into` | **You do.** Pass `keep` to collect on the way through: it lists the destination and deletes every generation below the new one beyond `keep`, however many earlier `*Into` calls kept. Without it nothing is collected, and the next `store.load` of the destination lists once, collects everything below its pointer beyond its `keep`, and records the window it kept. This is the step `store.load` exists to stop you forgetting. |
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
- A rollback deletes nothing, so a generation it rolled back from stays in the bucket until something collects it
  (see "What happens to the generations above the new pointer" below), and `seg.pinAt` can reopen it, with its
  fingerprint, once a later load has moved the pointer past it. It is fenced on the row it read, so a load that lands
  meanwhile makes it throw `WriteConflictError` instead of being undone. A rollback to a generation a concurrent load is
  collecting can still lose that generation: the collection proves the row before each delete, and a rollback landing
  between that proof and the delete is the one window it cannot close.
- A generation that is not in the bucket throws `NotFoundError` naming the ones that are.
- A target above the pointer throws `ValidationError` without `allowForward`, because that is also where objects live
  that were never published, such as those of a load that died before its publish.
- A target that is not what the row says the segment is throws `IntegrityError` before the pointer moves: a cleartext
  object under an encrypted segment (a write that never published, from a store with no keystore, before the
  segment's first keyed load), or an encrypted one under a cleartext segment. Every read would refuse it. The check is
  one tail read of the target, which needs no key to tell which kind it is.
- The same read gives the target's id count and metadata, which the rollback writes into the row with the pointer (one
  tail read, and a range read as well when the target's index is longer than the tail read). An encrypted target is
  opened with the store's keystore for that, and a store without one, or one that cannot open the segment's key for any
  reason, an unreachable or timed-out key service included, still rolls the segment back and leaves the row with no
  summary of the target; the next load writes one. A target whose index or metadata does not open is refused, since no
  read could use it either. A target above the pointer (`allowForward`) is read once more after the swap, and if it is
  no longer the object that was read (an erasure deleted it and a load took its number meanwhile) the pointer and the
  old summary are put back and the rollback throws `NotFoundError`.
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
are then above `currentGen`, where collection never looks. They remain until one of three things happens, and until then `seg.pinAt` can reopen one of them, with its fingerprint, once a load has moved the pointer past it. Loads pass
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
  immutable object, and the pointer moves only once the object is durable. The combine reads its operands under a bounded
  window (`concurrency × operands × chunk`, a range being at most a chunk's cap) and hands the result over as chunks, not
  ids: each is written as the bitmap it is, and no id is built for a value. A result whose chunks are dense, runs or full
  bitsets, costs the least, because the work is per chunk; for a result spread thinly over many chunks, the write costs about half what writing its ids
  would, and the reads, which each chunk still needs, can be most of the call. Like a load, the write holds the
  result, one compressed bitmap per non-empty chunk, until the object is written.
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
supersession at all (a `setRetention`), and a purge. Re-read
the destination and decide; do not treat it as "the write did not happen". A call that involves an expired handle is
refused earlier and harder, with `ValidationError`. An `*Into` publishes with the fences a load does: see
[which fence a publish carries](#how-it-stays-correct).

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

## Many outputs from one pass: `materializeMany`

A refresh that writes hundreds of segments, each a different `and` / `or` / `andNot` over the same stored operands,
costs a lot as `*Into` calls: each one reads its operands again, and a nested expression needs a scratch segment per
inner group, a published generation each. `store.materializeMany` computes the outputs together. It reads each
operand's chunks once per group of outputs, for every output of the group that uses them (one group when the outputs fit the
memory budget, more when they do not), evaluates every output chunk by chunk, and publishes each as the
`*Into` it replaces would, to a `dest` of its own.

```ts
const run = await store.materializeMany({
  operands: {
    us: store.segment('us'),
    engaged: store.segment('engaged'),
    optOut: store.segment('global-opt-out', { namespace: 'suppression' }),
  },
  outputs: [
    { dest: store.segment('send-1'), expr: { and: ['us', 'engaged'] }, exclude: ['optOut'] },
    { dest: store.segment('send-2'), expr: { andNot: ['us', 'engaged'] }, exclude: ['optOut'] },
    { dest: store.segment('send-3'), expr: { and: [{ or: ['us', 'engaged'] }, 'engaged'] } },
  ],
  keep: 3, // required
});
run.outputs[0]; // a MaterializeResult, or { published: false, error }
run.stats; // groups, requests, the budget used, memory, and each operand's generations
```

**The expression.** A string names an operand; a node holds exactly one of `and`, `or` or `andNot` over a non-empty
list of expressions, and `andNot` subtracts every entry after the first from the first, so it takes at least two. Trees
nest to 64 operators and 4,096 nodes, and are plain JSON. `exclude` is a list of expressions subtracted from the
output. A `dest` cannot also be an operand, and no two outputs share a `dest`: one call is one pass over operands that
do not change under it, so chaining is two calls.

**What a result means.** `run.outputs[i]` is index-aligned with `outputs` and is exactly what output `i`'s `*Into`
would have returned: a `MaterializeResult`, published or refused with its `reason`. For what the `*Into` would have
thrown, or what stopped it, it is `{ published: false, error }`: a lost race (`WriteConflictError`), a publish whose
outcome is unknown (`TransientError`), a damaged operand (`IntegrityError`), a lapsed lease (`LeaseExpiredError`), a
pinned exclude that moved (`StaleOperandError`), the memory budget (`BudgetExceededError`). One output's refusal or error
never stops another. The call throws only for bad input (`ValidationError` naming the output index and the path in the
expression, before any request), an operand that names no segment unless `allowAbsentOperands`, and a `budget` its own
plan exceeds, the last two before any chunk is read. Each output's generation is byte for byte what the same ids would
load, since every chunk goes through the codec's canonical encoding before it is written.

**`keep` is required.** An `*Into` keeps every generation unless told otherwise, and a thousand outputs would leave a
thousand uncollected destinations on every refresh. The call's `keep` applies to every output, and an output's own
`keep` overrides it. `guard`, `allowEmpty`, `metadata` and `audit` are per output, with the meaning they have on an `*Into`.

**One generation per operand.** By default (`pin: true`) the call pins each stored operand that is not already pinned,
so it reads the generation the operand had when the call started, however long the call runs. That is one generation
per operand, not one instant across operands: two pins are two registry reads, and the registry has no multi-row
snapshot. On a cold store a pin makes the row and tail reads the pass would have made to open the operand; on a warm one it costs
one row read and one tail read per operand more. An operand you pass already pinned is used as it is. A generation collected during the call fails the
outputs that read it with `NotFoundError`, where a live read would have served a mix, so size `keep` on the operands'
loaders past the call, or lease the pins. `pin: false` reads each operand live, as a combine does, and can describe two
generations of one operand, which also breaks the call's pruning. **With `pin: false` the re-check below does not run**: an
opt-out list can move during the call and the outputs that subtract it are published; `stats.operands` still says, from
one registry read at the end, that it moved.

**Every pinned operand an output subtracts is re-checked.** A suppression list that moved during a long call is the
dangerous staleness. An output subtracts an operand when it is in its `exclude`, or under any entry of an `andNot` after
the first, at any depth, so `{ andNot: ['us', 'opt-out'] }` and `exclude: ['opt-out']` are guarded alike. Immediately
before the publishes the call re-reads the registry row of every pinned operand any output of the group subtracts, and
compares what it finds with what was pinned: the generation, the row's incarnation and the fingerprint of the generation's
object, not the generation number alone, since a name deleted and created again starts at generation 0 and a number can be
taken again by other bytes once its object is gone. A write to the row that is not a replacement (a retention policy, a
lease) is not a move. The re-check costs one registry read per subtracted operand per group, and, to read the object's
fingerprint, a tail read of the current generation where the store does not already hold its reader. If one moved, every output that subtracts it gets `{ published: false, error:
StaleOperandError }` and is not published, and the others publish. `StaleOperandError` carries `code: 'stale-operand'`, the
operand's name in the call (`operand`) and why (`reason: 'moved'`). A subtracted operand that cannot be re-read is not
assumed unchanged, and its outputs are not published.

**`stats.operands[name]`** (an object with no prototype, so any name is a key) gives each operand's `pinnedGeneration`,
`startGeneration`, `endGeneration` and `moved`, for every operand of the call, those read live included: the end is one
registry read of the operand's row when the call finishes, or the re-check's read for a subtracted one, so it is the last
read of the call and not a snapshot of one instant. `stats.outputs[i]` gives the operands an output read, the group that
computed it and when it ran.

**Memory is a budget, and the call regroups to keep it.** `maxBufferedBytes` (default 256 MiB) bounds what the pass counts
as **resident**, which is not what it serializes to: a native bitmap costs a fixed amount over its serialized bytes
(about 440 bytes for a sparse chunk on macOS and about 360 on Linux, measured on the shipped codec on arm64 only; the model
sits above both), so the ledger counts each buffered output chunk, each operand stream's ranges (the operand's object size
where the source knows it, capped at the window the call asked for, since an index is not trusted to say how much a stream
holds; for a source that cannot say its size, which no shipped one is, the index's own cardinalities are the estimate), each
chunk being evaluated, and the plan itself: the root keys and expression of every output and the operand indexes (2 bytes a root key, 320 a node and 3,700 an output, so about 10 KB an output of 8 nodes over 2,000
keys: 10 MB at a thousand outputs and 103 MB at ten thousand, derived; the constants are measured upper bounds, about 1.5 times
what a wide and a deep expression held in a process of its own). A call
whose plan alone passes the budget is refused with `BudgetExceededError` before any chunk is read, and the expressions of one
call may hold 200,000 nodes in all (`ValidationError`, naming the output that passes it). When the outputs do not fit, they run
in groups, filled in call order; each group reads its operands once, and a group's buffers are released only as its
publishes settle, so the next group starts with room. Order related outputs next to each other and fewer operands are read
again. The ledger is also enforced while the pass runs, so an index that understates a chunk's size cannot grow a group past
the budget: the largest buffer is dropped and that output runs again alone. An output that cannot fit alone has
`BudgetExceededError` as its result, naming the budget it needs. The pass reads at most 64 range requests at once across all
operands, inside the S3 client's 128 sockets, so many operands do not queue behind the pool with their read timeouts running;
`concurrency` (default 1) is the range requests held ahead per operand within that window, and `publishConcurrency` (default 8)
the outputs published at once.

**The budget is the pass's own count, and process memory is more.** Not counted: the process's own baseline, the
allocator's slack, range responses and chunk buffers that wait for the garbage collector, the encoded bytes of an object
being written beyond their serialized size, and, in a test against the in-memory backend, the backend's own objects. Measured
on the in-memory backend with the baseline taken after the operands were loaded, the growth in resident set size over the
ledger's high water was 1.6 times on Linux (aarch64, glibc 2.36, the 100-operand shape below at 256 MiB) and 2.5 to 5
times on macOS (arm64, the same shape and a 200,000-id one); at a smaller budget the macOS growth stayed near 400 to 500 MB
rather than shrinking with it. These are measurements on two machines, not a bound: size a container for the baseline, twice
the budget and the plan, and watch the call's own `stats.memory`.

**Groups, and the operand re-reads they cost, grow with the total output size over the budget.** The call reads each operand
once per group, so it is one read of each operand only when every output fits one group. Each group also holds a window
of every operand it reads (about 1 MiB an operand) for its whole pass, so many operands leave less of the budget for outputs.
Counted in memory (`bench/materialize-many-counts.cjs`, the `target` shape: 100 operands of 3,000,000 ids over
1,500 chunks, 1,000 outputs of about 5 MB each, 926 of them published):

| budget | groups | range reads | chunk reads (the `budget` unit) | ledger high water |
|---|---|---|---|---|
| 256 MiB, the default | 81 | 19,005 | 4,852,500 | 201 MiB |
| 2 GiB | 6 | 3,570 | 900,000 | 1,472 MiB |

so at that size the default makes 4,852,500 chunk reads in 81 groups, about 32 times the 150,000 that one read of every chunk of every operand (100 operands of 1,500 chunks) makes, and 5.4 times the 2 GiB call's; a larger `maxBufferedBytes` is the lever.
Planning sizes groups from the index, which cannot know how much two operands overlap, so an `and` of two large operands is
priced at the smaller and is often far smaller in fact; the high water mark above shows how much of the budget a call used.

**Reads are chunk-skipping, and bypass the chunk cache.** Each output reads an operand only at the chunks that can change
its result: an `and` at the keys all its operands hold, an `or` at any, an `andNot` at its left side's keys, and a
subtrahend only where the left side can overlap it, so a long opt-out list costs reads in proportion to the audience.
`stats.chunks.pruned` counts the chunks skipped. The pass reads through the storage source and never writes the decoded
chunk cache, so a batch neither evicts another reader's hot chunks nor is served from them. Every chunk is decoded
through the checks on untrusted bytes. A key an operand's index lists whose bytes are missing is an error for the outputs
that read that operand, never an empty chunk: an exclude would otherwise subtract nothing.

**Leases and deadlines.** An expired or released handle anywhere in the call, an operand or a `dest`, is refused before
any request, as the `*Into` verbs refuse one. A leased operand's lease, and an operand's `expiresAt`, are checked before
each chunk key is read: a lapse fails only the outputs that read that operand (`LeaseExpiredError` for a lease,
`ValidationError` for a deadline) and never reads empty. Each `dest`'s lease and deadline are checked again just before
its publish.

**Requests of a refresh-shaped call.** Counted in memory by `bench/materialize-many-counts.cjs`, which wraps the storage
driver and the registry of the in-memory backend and counts every call they are asked, not measured on S3 and with no
time recorded: 100 stored operands of 200,000 ids each, 1,000 outputs that are trees of one or two levels of
`and` / `or` / `andNot`, each with the same opt-out list excluded, every `dest` already holding a generation, `keep: 12`.
The counts are in `bench/materialize-many-counts.json`, and a test holds these figures to it; CI recounts a smaller shape
(20 operands, 100 outputs) with `pnpm bench:materialize-many-counts:check`, and this one is committed and recounted on
demand with `node bench/materialize-many-counts.cjs --check --all`.

| | range reads | tail reads | row reads | **GET-class** | **PUT-class** | scratch segments |
|---|---|---|---|---|---|---|
| 1,000 `*Into` calls, nested groups through scratch segments | 137,037 | 2,736 | 3,988 | **143,761** | **3,404** | 818 |
| one `materializeMany`, default 256 MiB (6 groups) | 590 | 1,100 | 1,815 | **3,505** | **1,768** | 0 |

GET-class is range reads, tail reads and registry row reads; PUT-class is object writes, registry writes and listings;
deletes are free and not counted. The publishes, one object and one pointer write per output, are the floor of any
design and most of the batch's PUT-class. The `*Into` route reads with the default chunk cache, which holds 1,024
chunks; a cache sized to the whole working set would cut its range reads, at the cost of the memory to hold it.

**`stats.requests`** gives the call's own requests. `rangeReads`, `chunkReads`, `registryReads` (the re-checks, the end-of-call
reads and the existence checks), `opens` and `publishes` are exact counts of what the call did, and `attributed: { get, put }`
is the part of the drivers' totals the call can name, a **lower bound** and not the cost: `get` is range reads plus registry
reads, and `put` the object write and pointer write of each published output and the object write of each refused one.
To reconstruct the total GET-class requests, add to `attributed.get` two reads (a tail read and a row read, fewer where the
store already holds the operand's reader) for each operand a pin took, which with `pin` on is every named operand whether or not
an output reads it, or for each of `opens` with `pin: false`; and for each publish the reads of its load, two for a destination
that has a generation and three for one that has none, and one more when the guard refuses it. A test holds that recipe to a
recording driver over pinned and live operands, new and existing destinations, refused and published outputs and unused
operands. Not known to the call: a multipart upload's extra requests, a listing, and what a publish that threw sent.
In the counted call above `attributed.put` equals the drivers' PUT-class count and `attributed.get` is a small part of the
GET-class count; the counts are side by side in the JSON.

**The budget.** `budget` counts chunk reads over all the groups, re-reads included. A call that passes none gets, when the store
was built with a `budget` of its own, that one, so a store ceiling below the plan throws `BudgetExceededError` before any chunk
is read, as it does for every other operation, and it can refuse a realistic call: the `target` shape above plans
4,852,500 chunk reads at the default memory budget and 900,000 at 2 GiB, against a library default of
1,000,000. When the store is on the library default (a store whose `budget` is exactly 1,000,000 is treated as one on it), the
call sizes its own from its plan, twice the chunk reads the plan needs and a thousand, so it trips only when an output has to
run again past it. Pass `budget` to set one for the call, or `false` to lift it. `stats.budget` has the limit, the chunk reads
planned and those made.

**Erasure.** A batch widens the window of an in-flight read to the length of the call:
see [a batch of materializations](erasure.md#a-batch-of-materializations).

**Two limits of the form.** Like an `*Into`, a range (`after`, `through`) replaces each destination whole, so several
tasks each running a range of one expression into one `dest` supersede each other. And an output cannot name another
output of the call.

### Operands that arrive as records: a feed

Conditions too many to hold or to store (tens of thousands of audience queries, say) can be **fed** to the call as records in
chunk-key order, beside the stored operands. The call keeps one chunk key of them at a time.

```ts
await store.materializeMany({
  operands: { unsub: store.segment('global-unsub', { namespace: 'suppression' }) }, // stored, as above
  feed: {
    names: ['us', 'ca', 'engaged'], // the fed operand names, declared up front
    records, // AsyncIterable<{ key: number; operands: Record<string, Uint32Array> }>
    counts: () => countsFromTheWarehouse(), // required: the ids each fed operand holds, or an object
  },
  mayBeEmpty: ['ca'], // fed names allowed to be empty everywhere
  maxBufferedBytes: 512 * 1024 * 1024, // required with a feed
  outputs: [{ dest: store.segment('send-1'), expr: { and: ['us', 'engaged'] }, exclude: ['unsub'] }],
  keep: 12,
});
```

An output names a fed operand as it names a stored one, and one name is not both. The call's outputs are byte for byte what the
same operands stored would publish.

**The records.** `key` is `id >>> 16`, an integer from 0 to 65,535, and never below the previous record's. A key may arrive
as several consecutive records, each carrying some of the operands, or as one; an operand is named at most once per key (a
second appearance is refused, never merged), and an empty array is the same as leaving the name out. Each value is a real
`Uint32Array`: strictly ascending, no duplicates, every id inside its key. A key is evaluated when a record with a higher key
arrives or the feed ends, so a key's operands are never held across keys. The call converts each record into compressed
bitmaps as it arrives, so the caller may drop or reuse its arrays once it has yielded the record.

**Every record is checked before the pass sees it, and a bad feed is refused, never read as fewer members.** A key that is not an
integer in range or is below the previous; `operands` that is not an object, or that holds a name `feed.names` does not declare
(or a symbol key); a value that is not a real `Uint32Array` (an `Int32Array`, a `Buffer`, an array, an object that claims the
type and a proxy are all refused, since each would read as other members; a subclass, a view on shared memory and another
realm's `Uint32Array` are accepted, and are read through the typed array's own accessors, so a subclass cannot show the
check different ids from the ones used); an array whose buffer was detached; ids that are not ascending and unique, or that
fall outside the key; and a name given twice at one key. Each is a `ValidationError` that names the record's key and the operand; it
never names an id. The ids are read once, in one pass that checks and copies them, so an array a producer changes after
yielding it cannot make the checked ids differ from the used ones.

**The end of the feed.** `feed.counts` is **required**: an object, or a function called exactly once after the iterator has
ended and before any fed output is published, that gives the ids each fed operand holds over the whole feed, keyed by exactly
`feed.names`. The call counts the ids it saw for each name while it checks them, and a count that differs, a name missing or
extra, a count that is not a non-negative integer, or a function that throws or rejects refuses every fed output. That is what
catches a feed that ended early or skipped a key, which no record check can see: the records are valid, and short. A declared
fed name that appears in no record of the whole feed is refused too, since an operand that is empty everywhere is usually an
upstream query that failed quietly (a suppression list that came back empty subtracts nothing); name it in `mayBeEmpty` where
that is expected, and an `and` with it empties and an exclude of it subtracts nothing. `mayBeEmpty` naming anything that is not a fed
or held operand is a `ValidationError`. The counts are the producer's own: a producer whose records and counts both come from the
same failed source agrees with itself, and the call cannot tell.

**Fed outputs are atomic.** A fed output (one that names a fed operand) is published only after the whole feed has been read and
every end-of-feed check passed. A bad record, an iterator that throws, a count that does not match, an empty name, the budget
passed while the feed is read, or an erasure before the publishes begin refuses **every fed output** and publishes none of them,
and the iterator is told to stop; the call does not throw, each `run.outputs[i]` of a fed output carries the error
(`ValidationError` for the feed, the error the iterator threw as it was, `BudgetExceededError`, `StaleOperandError`). Once the
feed has been read and checked, each fed output publishes on its own, as any output does: an erasure is checked again before each
publish, so one that lands while the publishes run refuses every fed output not yet published and leaves those already published,
and a fed output whose object would not fit the budget at its publish is refused alone, with `BudgetExceededError`, while the
others publish. Outputs that name only stored operands are planned and published as before and are not affected.

**One group, and a budget that is required.** A feed is read once, so a call with one runs all its outputs as one group, and a fed
output's size is not known before the feed is read. `maxBufferedBytes` is therefore **required** with a feed (a
`ValidationError` without it), and the ledger is enforced while the feed is read: the records' bitmaps (the key in hand and
the one that proved it whole) and every fed output's buffer are counted, and **the call fails as soon as the count passes the
budget**, with `BudgetExceededError` for every fed output, not after the whole feed was read. Stored-only outputs of the same call run again alone, as a call
without a feed does, if the pass has to evict them.

**Memory.** The operand side is one key plus the key that proved it whole. Counted with 10,000 fed operands of 800 ids a key (a
key is 32 MB as the caller's `Uint32Array`s, and the call's bitmaps for it are 31 MB in the ledger): the ledger's high water was
62 MB over five keys, two keys' worth, where holding the feed would be five. The count is the ledger's own, so process memory runs
above it as it does for stored operands, and the caller's record, which is 4 bytes an id, is on top of it.

**Range.** `after` and `through` apply as to stored operands: a record outside the window is checked and counted, then dropped,
and edge chunks are cut after evaluation. A bad record beyond `through` is refused all the same.

**Reads.** A stored operand is read at the keys an output can hold it at. A fed operand's keys are not known until its records
arrive, so with a fed operand an output's stored operands are fetched over a superset (`and(storedA, fedB)` fetches `A` at every key it holds,
since the feed's future keys are unknowable), and each key is then decided exactly: an output is evaluated, and a stored chunk decoded,
only at a key where the output can be non-empty given the record at that key. A fed operand is empty at a key the feed has passed,
which is exact because the feed is ascending.

**The call waits as long as the producer takes.** The call has no timeout and no abort option. A slow producer that ends is
read to its end and the call completes correctly. A `records` iterator or a `counts` function that never settles hangs the
call, and with it every output of the call that is not yet published, the stored-only ones too, since a fed call is one group
and nothing is published before the feed ends. A caller that wants a bound ends its own iterator (and rejects its `counts`) after
its deadline. When a fed call stops early (a bad record, the budget, an erasure), the call also waits for the iterator's own
`return()` to settle before it returns, so a slow cleanup in the producer delays the call, stored-only publishes included. A
feed that no output names is never read, and its `counts` is never called: declare only names an output uses.

**Erasure.** A fed operand is the caller's memory, which no erasure can reach, so the call is refused instead: see
[a batch of materializations](erasure.md#a-batch-of-materializations).

### Operands held in memory: `store.memory`

A few conditions, or one suppression list the caller already holds, need no producer: `await store.memory(input)` holds them
as an operand of `materializeMany`, beside stored and fed ones.

```ts
const vip = await store.memory([7, 42, 99_001]); // or { bitmap } or { serialized }
await store.materializeMany({
  operands: { vip, engaged: store.segment('cond-engaged') },
  outputs: [{ dest: store.segment('send-1'), expr: { and: ['vip', 'engaged'] } }],
  keep: 12,
});
vip.release(); // frees it; any later use throws
```

**Where it works.** A held operand is accepted in `materializeMany`'s `operands` and nowhere else: `intersect`, `union`,
`andNot`, the `*Into` verbs and `load` take what they always took. The call's outputs are byte for byte what the same
operands stored, or fed, would publish, and the three kinds mix in one call.

**What it takes, and what is checked.** `store.memory` takes what [a load takes](#what-a-load-accepts) as input (ids as a
sync or async iterable or a typed array, `{ bitmap }`, `{ serialized }`) and runs the same checks with the same errors, before
the handle exists: the size cap, the structure, the safe deserializer and each id's range. **Only a real `Uint32Array` skips the
per-id range check**, by a brand that nothing but a real typed array carries: a subclass, a view on shared memory and another realm's
`Uint32Array` are real ones and are read through the typed array's own accessors, and any other typed array (an `Int32Array`
holding `-1`, a `Float64Array` holding `1.5` or `NaN`), an array with a bad id, an object that claims the type and a proxy go
through the per-id check and are refused with `ValidationError`. An object with an `ascending` key is refused, with a message that names the feed: ids that
arrive in key order are fed, not held. The ids are held as they were when the call returned: a change to a caller's array or
bitmap afterwards is not seen.

**Empty.** An empty set is accepted by `store.memory` and **refused by `materializeMany`**, before any request, unless its name
is in `mayBeEmpty`, for the reason a stored operand that names no segment is refused: an empty suppression list is usually
an upstream query that failed quietly. With the name in `mayBeEmpty`, an `and` with it empties and an exclude of it subtracts
nothing. `mayBeEmpty` may name fed and held operands; naming anything else is a `ValidationError`.

**Memory.** The handle holds the ids as the chunks a stored generation would hold (a 10,000,000-id operand is about 15 MB), and
**between calls that memory is the caller's**: `release()` zeroes and drops it, any later use throws `ValidationError`, and
releasing twice does nothing. While a call runs, its held operands count against `maxBufferedBytes` (a handle under two names is
counted once), and a call whose held operands alone pass it throws `BudgetExceededError` before any chunk is read. There is no size option: a serialized input has the load's cap.
A held operand is read from memory, so it makes no request and the shared chunk cache never sees it; its chunks still count as
chunk reads in `stats.requests.chunkReads` and against `budget`. A release that lands while a call runs fails the outputs that
read it with `ValidationError` and never reads zeros.

**One store.** A handle belongs to the store that made it; passing it to another is a `ValidationError`.

**Erasure.** A held operand is the caller's memory, which no erasure can reach, so it is refused instead. The store keeps a counter
that `eraseSubject` moves when it starts and again when it ends. A handle records it when `store.memory` is called, so a handle made
while an erasure is running, or one an erasure starts under while its ids are still being read, is stale. A call checks it before
any request and again immediately before each publish of an output that reads the handle, and an output whose handle was made
before an erasure that has started in this store since fails with `StaleOperandError` (`reason: 'erased'`, `operand` naming it)
and is not published; outputs that do not read it publish. A handle made after the erasure ended works. **Only this store's
`eraseSubject` moves the counter**: an erasure by any other path (another store, another process, `dropSegment`,
`eraseNamespace`, `destroySegment` or the free function `eraseIdFromSegment`) is not seen. The handle is the caller's copy, so
build it from the source of truth at the start of each refresh and release it at the end. See [a batch of materializations](erasure.md#a-batch-of-materializations).

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
changed since its load read it, or finds a row where its load read none, and is refused. A load that won the number can
still be refused by its guard. The one exception is a segment with no row yet, loaded with `allowEmpty: true` and no
`guard.minRetained`: neither load read anything to fence on, so each is a forward-only publish. If the lower
generation number lands first, both land and the higher stays current. If the higher lands first, the lower is
refused as `superseded`, because a publish never moves the pointer back. Publishing the generation that is already current is a
no-op that reports success, unless the publish is fenced (below), in which case it is refused.

**The row records the window, and the write that moves the pointer writes it.** The list of kept generations goes in the
same compare-and-swap as the pointer, derived from the very row that write is conditioned on, so the list a load deletes
by is the list that row held and no other. It names only generations that were current, never the number a refused load
took. Anything else that moves the pointer (a `rollback`, a purge and re-create) leaves the row recording no list, which
only makes the next load list; a write that leaves the pointer where it is (`setRetention`, a crypto-shred) keeps it. A
row a load of an earlier release wrote records none, so the first load of this release lists once and records it.

**Which fence a publish carries.** Forward-only is right for a writer whose content does not depend on what was
current: a load's ids come from upstream, so winning a race loses nothing it knew about. It is wrong for a writer that
derived its content from a particular generation, and such a writer publishes with `expectFrom` and `expectToken`.
The publish then lands only while the pointer is still exactly there, on the same row, and reports `superseded`
otherwise, so the caller can re-derive. Every load that finds a row fences its publish on the row's token. A guarded
load (the default, since the empty refusal needs the size of the current generation) also fences on the pointer it
judged, and one that found no row fences on that absence, so a row that appeared meanwhile refuses it. Only an
unguarded load onto a segment with no row publishes bare forward-only, which is right for it: there was nothing to
judge, and its ids come from upstream. An [`*Into`](#write-a-result-into-another-segment-the-into-verbs) is a load and
publishes the same way. Forward-only would be wrong for the erasure rewrite, whose object is one generation minus a
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
`TransientError`), and a refused load that finds another write has changed the segment's row, since by then its
generation number may name a re-created segment's object. The orphan is named by no row's list, because only a generation that was current is recorded as kept, so it takes no
place in a window. A load whose check meets it numbers above it by a listing and, once its own generation is current,
that listing deletes the orphan, which is below the pointer and not named. An orphan stranded elsewhere below the pointer
waits for the next listing, at most 16 generations on. There is no half-loaded state a reader can observe: a read resolves one generation and reads
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
zero-byte read before the pass takes a name. A load that makes no such check, one with `allowEmpty` and no `minRetained`,
cannot tell, and deletes the names its list pushed out.

The listing pass a load runs on a row that records a list (every 16th generation, a check that met an object, a caller
that asks for a listing) deletes every generation below the pointer that the row does not name, whether the row
names it as the publish wrote it or as it reads after the listing (a load that published meanwhile keeps its own window),
and re-proves before each delete that the row still names a list and still does not name the generation. Where it cannot
prove a delete it stops, and the load returns. Where the row records none, it keeps the
newest `keep` generations it finds, as a listing always has, and records them with one compare-and-swap on the row it
just published: that write moves the row's token, so a derived writer in flight on the row, an erasure rewrite, meets a
lost fence and re-derives, and it happens once for each row that records no list. A lost race there is not an error.

**A lease on a pinned generation is read from the row a collection already holds.** A load's collection, by name or by
listing, spares a generation that a live lease in the row names, and goes on to the next: the by-name pass reads the row
before each delete and the listing pass re-proves it, so a lease that lands while the pass runs is seen at the next name,
and one that lands in the round trip between that read and the delete is not. A leased generation takes no place in the
`keep` window, and the record of the window leaves it out. The collection that runs for an erasure, a shred, a drop and a
retention expiry does not read leases at all. A lease is written by one compare-and-swap on the row, so it is one more
writer of the row, but never one that refuses the others: see the next paragraph. A load's publish drops the leases that
have ended from the row in its own write, at no request of its own. A load with no clock (`deps.clock` absent, which the
store never is) cannot tell a live lease from an ended one, so its collection reads none and its publish prunes none.

**A lease write does not refuse a writer fenced on the row's token.** Invariant 1's fence stays: a load, an erasure
rewrite and a rollback publish only against the row they read. But readers write a segment's leases, in numbers no
operator controls, and each write moves the token. So a writer that finds the token moved re-reads the row, and when it
differs from the one the writer read only in its leases (the same incarnation, and every other field equal, the update time and
the token aside), it waits, reads the row again, and goes on against that row, without writing its object again and
without deriving its content again. The wait is a random time of up to 25 ms, growing with each retry to up to 400 ms, taken on the
store's clock; a writer given no clock `sleep` retries without waiting, and one given no `rng` waits the whole bound. A difference in anything else, the pointer, the kept window, the summary,
a retention policy, the key wrappings or the status, refuses as it always has. This covers a load's publish, an erasure
rewrite's publish and the re-proof before each delete above the pointer, a rollback's swap and its undo, a retention
write, and a shred or a drop, which re-read the row on every attempt and do not count a lost race to a lease write. Each waits
out at most 136 such changes (a take and a release by each of the 64 holders a row can hold, and a few more) and then
reports what it would have: `superseded`, or `WriteConflictError`. The rule is what lets an erasure, a shred, a drop and a
retention write win over leases that readers write without limit.

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
instead and returns what it deleted. One more consequence of the reconcile:
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
