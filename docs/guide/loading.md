# Loading in depth

[Getting started](getting-started.md#load-real-data) shows one load. This page covers the rest of the write side:
what a load accepts, how many old generations to keep, how to roll back, how to write a result into another segment,
and how to write many results from one pass, with operands that arrive as records, a set you hold included. Why a load
is refused, and how loads stay correct under crashes and races, each have a summary here; the full text is in
[When a load is refused](correctness.md#when-a-load-is-refused) and
[How a load stays correct](correctness.md#how-a-load-stays-correct).

## Load a segment

`store.load(ref, ids)` is the write path. It is one call for what is always four steps: take the next generation
number, write one immutable object, move the pointer, and collect what the move superseded. The fourth is the one
that gets left out when the sequence is composed by hand, so segments pile up old generations that everybody pays for.

<!-- typecheck: store -->
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
`guard: { minCardinality, minRetained, maxGrowth }` says what counts as implausible, and an empty result over a non-empty
segment is refused even with no guard. A refusal is reported rather than thrown, so a discarded result is a load that
silently did nothing.

## When a load is refused

[A refused load returns `published: false` and a `reason` rather than throwing, and the previous generation stays
current](correctness.md#refusal-is-reported-not-thrown): [`'empty'` (the ids produced nothing over a segment that is not
empty), `'min-cardinality'`, `'min-retained'` and `'max-growth'` (a `guard` bound), or `'superseded'` (another writer
got there first)](correctness.md#what-each-reason-means). It also emits `segment.load-refused` to the `audit` sink you
pass. What to do about each reason, how the two ratio bounds judge, how
to bound a growth in ids or refuse a key shift, and what throws instead of a refusal are in
[When a load is refused](correctness.md#when-a-load-is-refused).

### When a write is throttled or gets no answer

[A load makes two writes](correctness.md#a-load-makes-two-writes). The generation's object goes to a number no other
object holds, so [a write the service throttles is sent again](correctness.md#object-write-resent), and a random id in
the object's metadata tells a re-send that landed from another writer's object. A registry row write that ends without
an answer may still land, so [the load reads the row again and decides from what it
holds](correctness.md#row-write-settled), deleting nothing until it has. A load that throws `TransientError` [leaves its
object above the pointer](correctness.md#transient-error-leaves-its-object): re-run it. The outcomes, each backend's
retries and waits, and [what a `superseded` refusal over the load's own generation can
mean](correctness.md#superseded-over-own-generation) are in [When a write is throttled or gets no
answer](correctness.md#when-a-write-is-throttled-or-gets-no-answer).

## What a load accepts

**Any id source, in any order, with duplicates.** The input is a sync or async iterable, consumed lazily and
deduplicated as it goes: an array, a `Set`, a generator, a file stream, a warehouse cursor. Or a whole bitmap, below.

<!-- typecheck: store -->
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

**Ids that already ascend: `sorted: true`.** A load of ids holds the whole generation in memory before it writes it
([memory](#memory-and-where-a-load-runs), below). When your source yields its ids in ascending order, as a query with an
`ORDER BY` on the id, a sorted file or a merge of sorted runs does, pass `sorted: true`: the load cuts the ids into one
chunk at a time and writes each chunk while the object uploads, so it holds one chunk and the writer's index of the
chunks written, up to about 7 MiB, about 8 MiB for an encrypted segment (derived), whatever the segment's size.

<!-- typecheck: store -->
```ts
// Your function: yields the ids in ascending order, as `ORDER BY user_id` returns them.
declare function idsInOrder(): AsyncIterable<number>;

await store.load({ segment: 'audience:all' }, idsInOrder(), { sorted: true });
```

- **It writes the same object.** The generation is the one an unsorted load of the same ids writes, byte for byte
  under the same write identity, and everything else holds unchanged: the guard and the empty refusal, `keep`, the
  fenced publish, encryption and the result.
- **Ascending, with repeats.** An id equal to the one before it is skipped. An id lower than the one before it throws
  `ValidationError` naming its position and never the id (`ids[41]: lower than the id before it; …`): sort at the
  source, or leave `sorted` off. A bad id is refused as it is without the option, at its position.
- **For ids only.** With `{ serialized }`, `{ bitmap }`, a bitmap `deserializePortable` returned, or
  any other object with a `serialize` method (a `RoaringBitmap32` is one), `sorted: true` throws `ValidationError` before any request:
  those are held whole already and written from their own containers. A `sorted` that is not a boolean throws too. The `*Into`
  verbs do not take it.
- **The segment is judged before an id is read.** The row and its refusals (a destroyed segment, an encrypted one the
  load has no keystore for, `requireEncryption` on a cleartext one), the generation number and the key are all settled
  first, so a load refused there reads none of your ids.
- **Your ids are read during the upload.** An error your source throws, or an id that is refused, therefore fails the
  upload part way. No object is committed, on any backend, and the error reaches you as the very object your source
  threw: a database error that happens to carry a 409 or an `ECONNRESET` is not reported as a lost race or a storage
  fault. The parts uploaded before it may already be billed, though: S3 aborts its multipart upload, a GCS resumable
  session never becomes an object, and Azure Blob has no call to discard staged blocks, so they are billed until Azure
  collects them, a week after the last one was staged ([before production](production.md#bucket-lifecycle)). Without
  `sorted`, a bad id is refused before anything is uploaded.
- **Read once.** A storage driver may run its write again after a failed attempt, which a source read once cannot
  serve, so a sorted load whose ids are asked for a second time throws `IntegrityError` rather than writing a shorter
  object. The drivers this project ships run it once.
- **A long stream is a long load.** The row is read before the stream and fenced at the publish after it, as for an
  unsorted load, so a write to the row while your ids stream (another load, a `setRetention`) makes the load
  `superseded`. A segment destroyed while they stream is caught the same way, and the object the load wrote is
  deleted under the `destroyed` row ([how a load stays correct](correctness.md#how-a-load-stays-correct)).

**A bitmap you already hold.** When the segment is the result of set algebra you ran in memory, pass the bitmap
rather than its ids. `{ bitmap }` takes anything with `serialize('portable')`, such as `roaring`'s `RoaringBitmap32`;
`{ serialized }` takes bytes you already have in the portable Roaring format, from a file, a queue message, or an
export (`exportSegments`' `'roaring'` format writes it, so an export loads straight back).

The samples that build a bitmap import the `roaring` package from npm, the native bitmap library (not
`@cloudbitmaps/roaring`), so add it to your own `package.json`: `pnpm add roaring@2.7.0` is the version
`@cloudbitmaps/roaring` uses, so the two share one copy and a bare bitmap takes the fast path (another
version works, slower). Under pnpm a package your own
`package.json` does not list cannot be imported.

<!-- typecheck: store -->
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

- **It is the same load.** The generation holds chunk for chunk what the same ids write (every write also carries its
  own write identity in the footer, and an encrypted one seals its chunks with a fresh nonce, so two writes of one set
  are never the same bytes), and everything above holds unchanged: the guard and the empty refusal, `keep`, the fenced publish, encryption and the result.
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
- **A bare bitmap `deserializePortable` returned takes the same path where ids go, and so does a bare
  `RoaringBitmap32` from the copy of `roaring` that `@cloudbitmaps/roaring` uses.** A `RoaringBitmap32` from another
  copy loads as the ids it iterates, which is correct and slower; `{ bitmap }` works with either.
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
generation from one process, so the parts reach one process, which checks them, joins them and loads the union once.

<!-- typecheck -->
```ts
import roaring from 'roaring';
import { CloudRoaring, ValidationError, deserializePortable } from '@cloudbitmaps/roaring';
const { RoaringBitmap32 } = roaring;

// In each worker: its range's part, as portable Roaring bytes. Send these to the joining process.
export function partBytes(part: InstanceType<typeof RoaringBitmap32>): Uint8Array {
  return part.serialize('portable');
}

// In the joining process: check and decode every part, join them, refuse an overlap, and load once.
export async function loadParts(
  store: CloudRoaring,
  ref: { segment: string; namespace?: string },
  shipped: Uint8Array[],
) {
  const parts = shipped.map((bytes) => {
    const checked = deserializePortable(bytes); // ValidationError if malformed
    return RoaringBitmap32.deserialize(checked.serialize('portable'), 'portable');
  });
  const union = RoaringBitmap32.orMany(parts);
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  if (union.size !== total) {
    throw new ValidationError(`the parts overlap: ${total} ids in them, ${union.size} in their union`);
  }
  return store.load(ref, { bitmap: union });
}
```

- **Check with `deserializePortable`, then decode with `roaring`.** Parts that cross between processes are untrusted
  input, as stored bytes are. `RoaringBitmap32.deserialize` hands the bytes to the native decoder, which bounds its
  reads and checks nothing else: bytes of the wrong shape decode into a bitmap whose sizes and answers are wrong, and
  some shapes crash the process. `deserializePortable(bytes)` makes the check a `{ serialized }` load makes first (the
  size cap, the structural check, exactly one bitmap) and throws `ValidationError` for bytes that fail it. It takes a
  `Uint8Array`, which a Node `Buffer` is. What it returns is a `ReadonlyBitmap`, with `size`, `has(id)`, ascending
  iteration and `serialize('portable')`; the rest of `roaring`'s API (the union here) is reached by decoding its bytes
  with `roaring`, which is the second line of the map. Passing the `ReadonlyBitmap` itself to a method of the `roaring` package from npm answers
  wrongly, and `JSON.stringify` of one gives `"{}"`: write `JSON.stringify([...bitmap])`
  ([why](api-reference.md#decode-portable-bytes--deserializeportablebytes)).
- **The recipe costs about four passes over a part where a native decode makes one.** Each part's bytes are checked,
  decoded twice and serialized once. The second decode is made from the checked bitmap's own bytes, never from the
  bytes you were sent: a `SharedArrayBuffer` can change between the check and a decode of the original, and the library
  copies a shared buffer only for its own decode. A single part that needs no joining goes straight to
  `store.load(ref, { serialized: bytes })`.
- **Overlap is refused by the size check.** `orMany` merges parts that share ids without a word, so a range that two
  workers both built would load as if nothing were wrong. The members of disjoint parts add up to the members of their
  union, and they add up to fewer when any id is in two parts, so the recipe compares the two and refuses.
- **A range boundary may fall inside a chunk.** A chunk is the 65,536 ids that share their high 16 bits. When a
  boundary splits one, both parts hold a piece of it and the union merges them, so the generation holds the same chunks a
  load of the whole set writes. Cutting on whole chunks keeps each part's chunks its own, and a union of parts like
  that copies containers rather than merging them.
- **It costs the requests of one load.** The parts never touch storage: they are bytes in your processes, so one part
  or eight make the same requests. A segment's first load is 2 PUT + 3 GET, pointer included, for a single-part
  object. A multipart load, one whose union is large enough to be uploaded in parts, makes 5 PUT-class + 3 GET. Both
  are [measured](../benchmarks.md#the-in-region-run--run-2026-10-13-b329d), on a 1.05 MB and a 12.6 MB segment. A
  reload and a steady load at `keep: 12` are [measured](../benchmarks.md#the-in-region-run--run-2026-10-13-b329d) too.
- **When this is not enough.** A segment too large for one process to hold, as its union and its serialization
  together, is not served by this recipe.

## Metadata: what a generation was computed from

`metadata` attaches a small record of your own to the generation a load writes: the version of the definition it was
computed from, when its data landed, the run that built it. It goes on `load`, on every `*Into` verb, and on a load of a
bitmap.

<!-- typecheck-skip: a fragment: the page leaves `ids` to the reader -->
```ts
await store.load({ segment: 'audience:active' }, ids, {
  metadata: { definition: 'v41', landedAt: 1_790_000_000_000, run: 'r-2204' },
});
```

- **What it may hold.** A flat object of string keys and string or finite-number values. Nothing nested, and no boolean,
  `null`, `NaN`, `Infinity`, array or class instance. A key is at most 128 bytes and the whole record at most 1,024 bytes
  as canonical JSON: keys sorted by UTF-16 code unit, no whitespace, braces and quotes counted. Text has to be
  well-formed (a lone surrogate is refused), and `__proto__` is not a key. `undefined` and `{}` store nothing: a load given either writes an object with no extension block, as a load given no `metadata` does. Anything that breaks a rule is a
  `ValidationError`, thrown **before the load makes a request**: nothing is read and nothing is written.
- **It is copied when you call.** What is stored is the record as it was at the call, whatever the load's id source
  takes to run and whatever you do to your object meanwhile. Key order never changes the bytes of the metadata, so the same record
  gives the same block.
- **Published with the pointer, and immutable.** The metadata is in the generation's object, and the segment's row
  carries a summary of the current generation (its id count, its metadata and its object's fingerprint), written by the
  same compare-and-swap that
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
- **Reading it back.** `seg.stat()` returns the generation's number, id count and metadata, with its size, from the
  row's summary, which names the generation's object by its fingerprint, and the current entry of `store.generations()`
  carries the number, count and metadata from the row it already reads; neither reads the object. See
  [reading](reading.md#stat-the-generation-its-count-its-metadata-and-its-size).

### Where the guard reads the size of the current generation

A guarded load compares what it wrote with what the segment held, which is the size of the current generation. It reads
that size from the row's summary of the generation: a row that carries one for the generation it names gives the guard
the number with no request for the object. A row with no usable summary is read from the object's index with one tail
read: a row written without one, a summary that names another generation, or a sealed one that does not open. The
first load onto such a row writes a summary, and the next load reads none.

One behaviour follows from reading the row. A row that names an object that is gone (a lifecycle rule, a partial
restore) still remembers the size, so a repair load is judged against it: a repair smaller than `guard.minRetained`
allows, or larger than `guard.maxGrowth` allows, is refused. A guard that has to open the object, because the row has
no usable summary, meets an object it cannot read and judges against nothing. Leave `minRetained` and `maxGrowth` out to
repair a segment whose row remembers a size: `allowEmpty: true` lifts neither refusal. See [disaster recovery](disaster-recovery.md).

## Memory, and where a load runs

**Without `sorted`, memory is bounded by the distinct set, not by the input.** A load holds one compressed bitmap per
non-empty chunk, so a billion duplicate-heavy ids stream through holding only the distinct result. The buffer between
the input and the bitmaps holds at most 1,048,576 ids, about 28 MB measured, whatever the key distribution. Such a load
holds the whole generation in memory, which suits a batch job and not a request handler.

**With `sorted: true`, memory does not grow with the ids.** The load holds one chunk's ids (a fixed buffer of 65,536 of
them, 256 KiB) and that chunk's bitmap, and the writer's index of the chunks written so far, which it needs for the
object's footer. The index grows with the chunks a segment has, never with its ids: while the footer is written it
takes about 110 bytes a chunk (about 125 on an encrypted segment, where sealing the index holds two more copies of it
beside the plain one), so **up to about 7 MiB** at the 65,536 chunks a segment can have, **about 8 MiB encrypted**
(derived from the writer's code and the measured figures). The measured figures, how they were taken, and what an
unsorted load of the same ids holds are in [the benchmarks](../benchmarks.md#what-a-sorted-load-holds-in-memory).

**Either way, the backend buffers some of the object** (derived from the drivers' code, not measured). On S3 and Azure
Blob the writer buffers up to one upload part or block (8 MiB by default) and copies it into one body to send it, so it
holds up to about twice that at a flush, 16 MiB at the default; an object smaller than one part goes up as a single
request. On GCS it buffers up to the simple-upload threshold (8 MiB by default), about twice that when it switches to a
resumable upload, and then the stream's own buffer. `LocalFsStorage` writes to a file as it goes and holds next to
nothing. `MemoryStorage` holds the whole object, as it holds every object.

**A load is a batch job, not a request handler.** It streams the object to the bucket and is CPU-heavy in short bursts
(serializing about 65,000 chunks for a segment spread across the id space). It yields the event loop periodically, so
it is a well-behaved neighbour, but it still burns a core for a fraction of a second and, unless its ids are sorted,
holds a whole generation in RAM. Run it from a job runner, a queue consumer, a scheduled task or a short-lived container, and keep the request
path for `has`, `count` and `intersect`. See [where to run it](production.md#what-blocks-the-event-loop-and-where-to-run-it).

**Do not load an empty segment "to create it".** A never-loaded segment already answers `count() → 0`,
`has(x) → false` and `iterate() → []`. An empty load just costs an object and a registry row you then have to retire.

## Does this segment exist?

There is no `create`, so you can never collide with an existing segment: `store.segment(name)` validates a name and
does no I/O. A segment starts existing when something is first loaded into it. A load replaces whatever was there, so
the question worth asking before one is usually "is there data here already?", not "will this fail?".

<!-- typecheck: store -->
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

<!-- typecheck: store -->
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
  answers the number the row records, so `checkConsistency` is the call for it.
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
survives an erasure that finds the id, and neither does a lease: one that rewrites the segment collects every generation below its new pointer, and one that finds the id only in a generation other than the current one deletes every generation below the pointer and each one above it that holds the id.
[Reading in depth](reading.md#read-one-fixed-point-in-time) covers pins and
[leases](reading.md#hold-a-generation-for-a-job-a-lease).

**What no value of `keep` gives you is a single instant.** A read whose TTL elapses, whose reader is evicted on a store
with no timed refresh, whose resolution is let go by the resolution cache of a store with one, whose segment another
read of the store resolves again (finding its generation swept, or failing to open it), or whose store is invalidated
moves to another generation whether or not the old one still exists. A job that needs one instant, such as an export, a reconciliation, or a send that must match the count you reported, needs a pinned handle.
See [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load).

There is deliberately no time-based floor on collection ("keep nothing younger than 24 h"). It would read as a
durability guarantee and would not be one: an ordinary read is already covered by a re-read, and a window wide enough to
hope with is not a hold. A job that must not change generations needs a pin, and one with a known end can lease it: a lease
names the one generation it holds, so it never delays the collection of anything else, it ends at a time you set, and a
read after it throws rather than reads empty. See [Hold a generation for a job](reading.md#hold-a-generation-for-a-job-a-lease)
and [Deliberately not planned](../ROADMAP.md#deliberately-not-planned).

**Who collects.** Collection deletes generations strictly below the current one, keeping `keep` of them: the `keep`
most recently current. The row's ledger records the order generations were made current, so the generation the load
superseded comes first. Without a rollback that is the newest below the pointer, so the window is the newest `keep`;
after a rollback it is the generation the rollback restored, and it stays in the window of every load after that one,
ahead of the generations the rollback moved away from, for as many loads as `keep` allows
([what a load keeps after a rollback](#what-a-load-keeps-after-a-rollback)).
`keep` is a non-negative integer: a negative, fractional, `NaN` or infinite value is refused with `ValidationError`
before anything is written. It never touches the current generation or anything above it.

**How `store.load` collects.** The segment's registry row carries a ledger of the generations it made current,
`knownGens` ([the schema](api-reference.md#driver-kit--what-you-need-to-implement-a-driver)), in the order they were
made current, oldest first and the current one last. Its entries below the pointer are the generations the last load
kept, up to 64 of them for a load that collects by name, and the ones a live lease holds. A load that found a usable
ledger writes the new one in the same write that moves the pointer: the `keep` most recently current of the generations
numbered below the new one, every generation a live lease holds, whatever `keep` says, the generations a rollback left
numbered above the new one (a load takes a free number under them), and the new generation. Once that has landed it
deletes **by name** each generation that fell out of the window, after re-reading the row before each delete, and reads the row once more after the last
delete, which sees a rollback that landed between the read before it and the delete
([below](#a-rollback-that-races-a-collection)). It lists nothing. A segment that loads cleanly therefore pays two pointer
reads and one delete for collection at any `keep` up to 64, not a listing: on S3 a steady load of a single-part segment that deletes by name makes
2 PUT-class requests, 5 GET-class and a delete, 8 requests, with the delete free ([what each term
counts](cost.md#what-each-term-counts)). The window is drawn from the order in the ledger, so the generation the
publish superseded, which was current, comes first, then the ones made current before it. A publish over a row that has
no usable ledger (a registry repaired by hand, or a row restored without its ledger)
starts a ledger from the bucket instead (the first publish of an incarnation, over no row or a row with no pointer, writes
the new generation alone): the generations a count by `keep` keeps, with the live-leased ones beside them,
which can include a number a refused or crashed load took, and the publishes after it carry that number until the
window pushes it out ([an orphan is collected later](correctness.md#how-a-load-stays-correct)). A usable ledger is never started again, however wide: one that
names more than 64 generations below the pointer that no lease holds (a `keep` above 64 leaves up to 127) keeps its
order, the generations a live lease holds and the ones a rollback left above the new number, and the load that follows
it with a `keep` of 64 or less collects by listing, counting the ledger's own names first, instead of by name. The
leases a new ledger holds are read from the row once more just before it is written, one more row read; a lease taken
after that read, before the write, keeps its generation in the bucket but is not named while its lease lasts, as one
taken between a publish and its collection is not. With a `keep` of 127 or more, or when the generations the window and
the leases hold already reach 128 entries, the entries a rollback left above a load's number are capped out of the
ledger, and a later load that numbers past them collects them.
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
- when there is no window to collect by name: a `keep` above 64, which a window cannot hold, and the first load over a
  row with no usable ledger. A `keep` above 64 lists on every load and keeps the ledger's own most recently current
  names below the pointer first (up to 127), then the newest others by number, `keep` in all, with the ones a live lease
  holds beside them. The first load over a row with no ledger keeps `keep` of the generations it finds below the pointer,
  the one it superseded first and then the newest by number, and its publish writes them as the ledger, so the next one
  collects by name.

The row's window is a cache of what a listing would keep, and the listing repairs it. A name in it can be missing from
the bucket after a lifecycle rule or a collection that was not a load's took the object; the window then holds fewer than
`keep` real generations until the name ages out, at most `keep` loads, and nothing that should stay is deleted. A fleet
that mixes `keep` values up to 64 with larger ones, or with writers that record no ledger, lists on the loads with the
smaller `keep` whenever the larger one leaves a ledger too wide for it to extend by name (more than 64 generations below
the pointer that no lease holds): set the same `keep` on every writer. Because each load collects with its
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
| an `*Into` | **You do.** Pass `keep` to collect on the way through: it lists the destination and deletes every generation below the new one beyond `keep`, however many earlier `*Into` calls kept. Without it nothing is collected, and the next `store.load` of the destination lists twice when its number was free (once to seed the ledger, once to collect; it sends no separate write), collects everything below its pointer beyond its `keep`, and records the window it kept. This is the step `store.load` exists to stop you forgetting. |
| `eraseSubject` | **Yes**, with `keep: 0`: the generation holding the bit must not survive the call. Collection's range leaves out three kinds of object, so the erasure deletes each itself, by name: a holder above the pointer, which a `rollback` leaves there; a first load's object that holds the id on a segment with no generation yet; and an object no read of the segment can open, which it cannot search and deletes whatever the id. |
| `retireExpired` | **Yes**, for the tombstones it wrote itself, and only with `purgeTombstones` (on by default) and after the grace period. It collects a straggler generation before purging the row. A tombstone a hand-run `dropSegment`, a crypto-shred or a cleartext destroy left is never touched. |
| `dropSegment` | Deletes every generation of the segment it drops, and reports any it could not in `generationsRemaining`. |

An `*Into` that collects on the way through:

<!-- typecheck: store -->
```ts
// Deletes every generation below the new one but one, the one it superseded, kept as a grace window.
// `collected` lists what it deleted.
const { collected } = await store
  .segment('campaign-targets')
  .intersectInto(store.segment('campaign-final'), [store.segment('opted-in')], { keep: 1 });
```

**Keep every generation of the last N hours.** `keep` counts generations, so how far back you can roll a segment depends
on how often it refreshes: hourly at `keep: 12` is 12 hours, and a bad landing at 19:00 found at 09:00 the next day can
no longer be rolled back to 18:00. Two ways to hold a time window, both with what the library has:

- **Size `keep` from the cadence.** Hourly for 72 hours is `keep: 72`. The row records the newest 64 kept generations,
  so a `keep` above 64 makes each load list the segment to collect, one listing per load.
- **Lease each generation as it lands.** Right after a publish, `await store.segment(name).pin({ leaseUntil: Date.now()
  + 72 * 3_600_000 })` holds the generation current when the pin lands for 72 hours, however `keep` collects, and the
  ledger holds it for as long, so it stays a rollback target, with no flag, while its lease lives (a lease is
  at most 14 days, and a segment holds at most 64 at once, so hourly for 72 hours needs the first way). It costs one row
  write per lease, and suits a segment that refreshes rarely, where `keep` would hold more than the window. An erasure still deletes a leased generation that held the erased id.

## Roll back a segment

`store.generations(ref)` lists what the bucket holds for a segment, and
`store.rollback(ref, toGeneration, { audit?, allowUnknown? })` moves the pointer to one of them. It is the one
pointer move no automatic path makes.

A rollback moves only onto a generation the segment's row **knows**: one its loads and rollbacks made current, whose
object is still the one the row recorded. The row keeps that record in `knownGens`, a list of generation numbers with the
footer checksum of each object, in the order they were made current. It holds the current generation, the ones a load's
`keep` keeps below it, every generation a live lease holds, and the ones a rollback left above the pointer until a load
numbers above them. The checksum is in the object's footer, which is in the clear, so a rollback needs no key to check it.
`generations` marks each generation `known` or not, so you can see which targets need no flag before you ask.

<!-- typecheck: store -->
```ts
import { RecordingAuditSink } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink();
const ref = { segment: 'audience:active' };
await store.generations(ref);
// → [{ generation: 3, current: false, known: true }, { generation: 4, current: true, known: true }]
await store.rollback(ref, 3, { audit }); // → { fromGeneration: 4, generation: 3 }

// Generation 4 is still in the bucket and the row still knows it, so undoing the rollback needs no flag and,
// on an encrypted segment, no key: its checksum vouches for it.
await store.rollback(ref, 4, { audit });

// An object no load of this row published (a load that died before its publish, a refused load's object, a load
// published after a registry was restored to an older version) is in the bucket and not in the record:
await store.generations(ref); // → [..., { generation: 7, current: false, known: false }]
await store.rollback(ref, 7); // ValidationError, before any request to storage
await store.rollback(ref, 7, { audit, allowUnknown: true }); // moves, and the audit event says `unknown: true`
```

- `generations` is one registry read and one listing, and it does not open the objects, so `known` is the row's word
  and its checksum is not compared. It lists the bucket whether or not the segment has a registry row, so it also finds
  the objects a purged row left behind. It shows what the bucket holds, not what the segment has ever been, since
  collection deletes superseded objects. Every generation of a row with no usable `knownGens` is `known: false`; the
  current generation of a row with one is always `known: true`.
- A rollback deletes nothing, so a generation it rolled back from stays in the bucket until something collects it
  (see "What happens to the generations above the new pointer" below), and `seg.pinAt` can reopen it, with its
  fingerprint, once a later load has moved the pointer past it. It is fenced on the row it read, so a load that lands
  meanwhile is never undone: the rollback throws `WriteConflictError`, or, when its own swap got no answer, that
  `TransientError` (below), and records no move. A load that evicts the target from the row's record between the rollback's read and its
  swap is such a write. [Every collection and the erasure takes what it will delete out of the record before it deletes, or never deletes what
  the row names](correctness.md#every-delete-reads-the-row), so none of them races a rollback that is held to the record: a load removes what it evicts from the record in the publish,
  its pass that keeps by count skips every generation the row names when it re-reads the row, an erasure's rewrite leaves
  only the rewrite in it, and an erasure that rewrites nothing removes each generation it will delete from it in a write
  made before its first delete. A rollback that read the row before such a write loses its swap with
  `WriteConflictError`; one that reads it after is refused as unknown. What is left is a rollback that is not held to the
  record (`allowUnknown`, or a target below the pointer on a row with no usable record or below a full record's bound),
  which can still land on a generation a deleter is taking: the deleting call detects it, and the load throws
  `NotFoundError` when the pointer still names the missing object after a wait, which is the time a rollback that found
  its target gone takes to put the pointer back. Because an erasure takes a generation out of the record first, a
  rollback without `allowUnknown` cannot bring an erased generation back even when a delete failed, except through those
  two cases, until the erasure is re-run. Check
  `store.generations(ref)` before acting: while the pointer names a missing object, roll back to a generation in the
  bucket ([a rollback that races a collection](correctness.md#a-rollback-that-races-a-collection)).
- **A generation the row does not know** throws `ValidationError` before any request to storage, naming the ones it
  does know. That covers an object a crashed load left, one a refused load kept, one sealed under a key no row holds (such
  as the one the loser of two concurrent first loads leaves) and a load published after the point a registry was restored
  to. `allowUnknown: true` moves onto such an object anyway, and records it as known (over a usable record; a row with none
  stays without one).
- **A known generation whose object is not the one the row recorded** throws `IntegrityError` before the target is
  opened, with or without a keystore: another object was stored under the number, for example by a write that never
  published after the original was collected. It reports as another object, not as a failed decryption. What is compared
  is the footer's checksum: damage inside an object whose footer is intact, and an edit made in place to a cleartext
  object's metadata block that keeps the footer (another write of the same ids, whatever its metadata, carries its own
  write identity, so its footer differs), are not seen by it, and a read of the
  generation reports the first. `allowUnknown`
  moves onto it, and the row then records its checksum.
- **A generation that is not in the bucket** throws `NotFoundError` naming the ones that are, once the row knows it or
  `allowUnknown` is passed; an unknown one is refused first.
- **`allowUnknown` on an encrypted segment needs the segment's key**, outside the two cases below where the pointer alone
  decides, and there it only widens the call: the call lands key-less with the flag as it does without it. Otherwise, with no
  keystore, or one that holds none of the key's KEKs or one that does not unwrap the key, it throws `KeyUnavailableError`
  before it reads the target, since nothing vouches for the object and only opening it with the segment's key shows that it
  is not one sealed under another key. A key service that throws `TransientError` or times out reaches you as
  `TransientError` (a timeout as its `cause`), and nothing moves: run the rollback again once it answers. A known target
  needs no key. `allowUnknown` never overrides the checks that follow: a target of the wrong kind, a footer that names
  another generation, or an index or metadata that does not open is still refused, so no read of the result can fail.
- **Two cases are decided by the pointer alone**: a target below the pointer needs no flag and no checksum check, key-less
  included, and the event carries `unknown: true`. A target above the pointer needs `allowUnknown` in both.
  - **A row with no usable `knownGens`**: a registry of your own that drops the field, a row whose pointer you moved with
    `backend.registry.compareAndSwap` as a repair (a patch that moves the pointer without naming the record drops it), or a
    record that disagrees with its row. A rollback onto such a row writes no record, so it stays in this case until the next
    load writes one.
  - **A target below a full record's bound.** A record is full at 128 entries, leased ones included: a writer that lets an
    older generation go always leaves at least that many. It names the 128 most recently current generations, and those a
    live lease holds, while a destination that keeps every generation (an `*Into`, `materializeMany`) or a load with a `keep`
    of 127 or more keeps more than that in the bucket. The bound is the record's least recently current entry that no lease
    names (every lease entry counts, live or ended, since a rollback has no clock; a record whose every entry is leased is
    judged against its first entry). A leased entry stays for its lease however far the window has moved, so it does not
    mark where the record stopped remembering. Everything the record names is still checked. A rollback onto an old
    generation that no lease names makes it the least recently current entry, so it becomes the bound until the next publish
    drops it: the generations numbered between it and the rest need `allowUnknown` (and the key on an encrypted segment)
    until then. At a `keep` of 128 or more that collects by listing, an object a crashed load left in a freed number below the
    bound can be rolled onto with no check.
  - **A residue.** A generation that a publish with a smaller `keep` no longer names but that stays in the bucket (a lease
    spared it, or its delete failed), while the record is not full, needs `allowUnknown` (and the key on an encrypted
    segment) until a later listing collects it.
- A target that is not what the row says the segment is throws `IntegrityError` before the pointer moves: a cleartext
  object under an encrypted segment (a write that never published, from a store with no keystore, before the
  segment's first keyed load), or an encrypted one under a cleartext segment. Every read would refuse it. The check is
  one tail read of the target, which needs no key to tell which kind it is.
- The same read gives the target's id count and metadata, which the rollback writes into the row with the pointer (one
  tail read, and a range read as well when the target's index is longer than the tail read). An encrypted target is
  opened with the store's keystore for that. A store with no keystore, or one whose keystore cannot open the segment's
  key (it holds none of the key's KEKs, one it holds does not unwrap it, or it throws `TransientError` or times out as
  `AbortSignal.timeout()` and the AWS SDK report a timeout), still rolls the segment onto a known generation, and below the
  pointer in the two cases above, and leaves the row with no summary of the target; the next load writes one. Such a
  rollback opens nothing, and for a known generation its checksum vouches for the object. Any other failure of the
  keystore is thrown, and nothing moves: a keystore of your own should throw `TransientError` for a fault worth riding
  out. A target whose index or metadata does not open is refused, since no read could use it either.
- **After the swap, the rollback reads the target's footer once more**, whatever the target. If the object is gone (a
  collection that is not fenced on the row took it, or an erasure deleted one above the pointer) or is another object
  (a load took its number meanwhile), the pointer, the old summary and the old record are put back, the target
  leaves the record, and the rollback throws `NotFoundError`. That read takes the place of a listing of the bucket.
- A swap of the pointer that gets no answer (`TransientError`), or that meets a conflict, [is settled by reading the
  row](correctness.md#rollback-settles-its-swap).
  On a registry that reports write tokens (every shipped one does), the swap is the rollback's own when the row's
  pointer is at the target and its `pointerId` is the token of a swap this call sent (a resend reports a token of its
  own, and every one is kept). Whatever else was written to the row since (a lease, a retention or residency write, a
  ledger-only write) does not matter: the target is checked as after any swap, the pointer put back if the target went
  meanwhile, the move audited and reported. Otherwise the rollback throws: the `TransientError` after no answer, and
  after a conflict a `WriteConflictError` that says the rollback could not confirm its swap is the one the row shows,
  and the pointer may still move after no answer, since the write may yet land: run the rollback again, which finds the pointer where it
  is. A load or another writer that moved the pointer meanwhile is left standing. Another rollback's identical move is
  not taken for this one's, though it leaves the very row the swap would: its `pointerId` is its own token. A write that
  renews the `pointerId` over the rollback's landed swap (an erasure's renewal, or a write of the pointer back onto the
  target) reads as another writer's too, since the two cannot be told apart, and the rollback then throws and records no
  move: run it again, which finds the pointer where it is and reports a no-op. A registry that reports no tokens
  settles a swap that got no answer by the row the swap would leave: the row the rollback read, with the target as its
  pointer, the summary the swap wrote and the record it wrote (none, over a row with no usable record: a rollback
  starts no record, a load seeds one, so a load's write differs there), and nothing else changed but its leases and
  its pointerId. Some writes leave that very row, and cannot be told from the swap there. On a cleartext segment:
  another rollback onto the same target, whatever row it read, and a load that wrote, under the target's number, the
  very object the rollback read and recorded the record the rollback would (a load that keeps every generation, onto a
  row whose record the rollback carried). On an encrypted segment, the swap's sealed summary tells every other write
  apart, except when the rollback had no key at hand and wrote no summary: then another such rollback onto the same
  target cannot be told apart. The pointer is then where the rollback asked for it, and the rollback reports the move
  as its own. A conflict on such a registry is never settled as landed.
- A load keeps one generation below the one it publishes by default (`keep: 1`), so there is one to roll back to. Pass
  a larger `keep` on the loads of a segment you may want to roll further back.
- Each move emits `segment.rollback` to the `audit` sink you pass
  ([the audit trail](observability.md#audit-trail-security--compliance-events)), carrying `unknown: true` when the row
  did not vouch for the target (`allowUnknown`, or one of the two cases above), and this store drops its cached view of
  the segment. A rollback whose swap got no answer, on a registry that reports no tokens, and that takes another
  writer's identical move for its own (above) emits it too, so that one move is recorded twice.
- **Requests** (measured, memory driver, cleartext segment, index within the tail read): a known target is **4**: the
  row, the target's tail, the swap, and its footer once more. A target the row does not know is refused after **1**, the
  row. The current generation is **2**, the row and its footer. A target that is not in the bucket, with `allowUnknown`,
  is the row, the tail that finds it missing, and one listing to name what is there. An encrypted segment adds the keystore
  call, and a target whose index is longer than the tail read adds one range read.

**Why rollback is not forward-only.** Forward-only is right for a writer: a load whose ids came from upstream loses
nothing by being out-raced, and regressing would let a slow loader silently undo a fast one. It is wrong for an
operator who has looked at the segment and knows which generation they want. So rollback refuses rather than guesses.
A destroyed segment (crypto-shredded, destroyed in the clear or dropped) throws `ValidationError`, since no
generation resolves through a destroyed row, and rolling to the generation already current is a reported no-op once
one footer read finds its object in the bucket, and, when the row
knows it, with the checksum it recorded (another footer under the number throws `IntegrityError`, and so does a footer that fails its own checks: a no-op
reports no segment as fine over a corrupt current footer). When the object
is gone (a collection raced an earlier move), it throws `NotFoundError` naming the generations that are there, so
re-running a rollback to the generation you want never reports a missing object as fine.

**What happens to the generations above the new pointer.** They stay, which is what makes a rollback reversible. They
are then above `currentGen`, where collection never looks. They remain until one of three things happens, and until then `seg.pinAt` can reopen one of them, with its fingerprint, once a load has moved the pointer past it. Loads pass
them: each takes the next number up while no object holds it, the first whose number one of them holds numbers above
them all, and collection then keeps `keep` of what is below its pointer, the generation that load superseded first
([what a load keeps after a rollback](#what-a-load-keeps-after-a-rollback)). Or `dropSegment` deletes
them. Or an erasure deletes them: all of them when it rewrites, and, when the current generation does not hold the id,
only those that hold it and any no read of the segment can open, whatever the id. Rollback is audited as
`segment.rollback`, because every other pointer move can be reconstructed from "a load happened" and this one cannot.

### What a load keeps after a rollback

A load keeps the `keep` most recently current generations below the one it publishes. The row's ledger records the order
generations were made current, and a rollback carries it, moving the generation it restores to the end, so the
generation the next load supersedes is the one the rollback restored: with a `keep` of 1 or more it comes first, and it
is still there to roll back to if that load is bad too. Then come the ones made current before it, not the generations
the rollback moved away from, which are numbered above it but were current less recently.

That holds from every load after the rollback, not only the first: with a `keep` of 2 or more, the restored generation
stays in the window of each load after the first, ahead of the generations the rollback moved away from, until `keep`
newer generations have been made current. The generations the rollback left above the pointer stay known and are never
collected while the pointer is below them; a load that takes a free number under them leaves them where they are, and
they take no place in its `keep`. A pin taken on the restored generation reads it until a load collects it, unless the
pin is leased ([hold a generation for a job](reading.md#hold-a-generation-for-a-job-a-lease)).

With generations 0 to 3 in the bucket and the pointer rolled back from 3 to 1, the next load finds 2 taken and
publishes 4, and the loads after it publish 5 and 6:

| `keep` | the bucket after the first load | after the next | after the one after | why |
|---|---|---|---|---|
| `0` | 4 | 5 | 6 | nothing below the new pointer is kept |
| `1` | 1, 4 | 4, 5 | 5, 6 | the first keeps 1, which it superseded; the next keeps 4, which it superseded |
| `2` | 1, 3, 4 | 1, 4, 5 | 4, 5, 6 | the first keeps 1, then 3, which was current before the rollback; the next keeps the two most recently current, 1 and 4, and lets 3 go; the one after keeps 4 and 5 |

At `keep: 2` the restored 1 outlives 3, which the rollback moved away from, and goes after two more loads. Each load
writes the order into the ledger, so every one after the first collects by name. Where the superseded generation's
object has gone from the bucket (a lifecycle rule took it), the load keeps the newest `keep` that are there: a pass
that listed to take a number counts instead of keeping only what the ledger names.

## Write a result into another segment: the `*Into` verbs

The three combines each have a twin that writes the result as a **new generation of a destination segment** instead
of streaming it to you: `intersectInto`, `unionInto`, `andNotInto`.

<!-- typecheck: store -->
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

  <!-- typecheck-skip: a fragment: the page leaves `audience`, `dest`, `eligible` to the reader -->
  ```ts
  const res = await audience.intersectInto(dest, [eligible]);
  if (!res.published) {
    // res.reason: 'empty' | 'min-cardinality' | 'min-retained' | 'max-growth'
    // res.cardinalityBefore: what dest still holds
  }
  ```

  An empty result into a destination that was never loaded still publishes: there is nothing to protect. Pass
  `allowEmpty: true` when emptying the destination is the point, and `guard: { minCardinality, minRetained, maxGrowth }` for the
  same bounds `load()` takes, judged against what the destination held. [A refusal is reported, not
  thrown](correctness.md#refusal-is-reported-not-thrown); a lost race still throws `WriteConflictError`, and a rollback
  onto the object the refusal deleted throws `NotFoundError`, as a load's does ([what throws
  instead](correctness.md#what-throws-instead)). A refused call also emits `segment.load-refused` to
  `audit`, since a materialization is a load.

A `WriteConflictError` from an `*Into` means the destination changed underneath the call, and it does not by itself
mean nothing was published. The same error covers a pointer that moved, a row rewritten by something that is not a
supersession at all (a `setRetention`), and a purge. Re-read
the destination and decide; do not treat it as "the write did not happen". A call that involves a released or lapsed
lease is refused earlier and harder, with `LeaseExpiredError`. An `*Into` publishes with the fences a load does: see
[which fence a publish carries](correctness.md#which-fence).

**The destination cannot also be a source.** An `*Into` whose `dest` is the segment it is called on, one of its operands
or one of its excludes is refused with `ValidationError`, before any request, and names the verb and the segment. The call
reads its sources at the generation this store last resolved, which can be up to `cache.genTtlMs` old, and publishes
fenced on the destination's row as it stands: with the destination also a source, another process's newer load of it
would be replaced by a result built from the one before, and no conflict would be raised. A segment is the same segment
however its handle was made: a second handle, a pin of it and the same name in the same namespace all count. `materializeMany` applies
the same rule to each `dest`, and `store.load` refuses ids that a stream of this library read from the segment it is
loading (`store.load(x, x.intersect([y]))`), for the same reason. That check covers a stream of the same store, or of a
store built over the same registry driver object; a copy between two stores over different backends loads as it always
did. Two separate store instances built over the same bucket cannot be told apart, so it does not cover them, and the
advice below applies there.

**This release has no fenced in-place update of a segment from its own content.** Write the result into a new segment and
point readers at it, for example a dated target or a pair of segments you alternate between. A load of ids derived from
the segment it writes, in two steps (`x.intersectInto(tmp, …)` then `store.load(x, tmp.iterate())`) or through a stream of
your own that wraps a read of `x`, is not refused and is **unfenced**: it publishes over whatever `x` is by then, so it is
safe only where nothing else writes `x`. A single writer that knows no other writer exists may update in place that way.

**`intersectInto(dest, [])` is refused.** An intersection over nothing has no meaning, and a list built in a
loop that came out empty would otherwise turn a filter into no filter. A union or an andNot with nothing is the segment
itself, so `unionInto(dest, [])` and `andNotInto(dest, [])` publish its ids. To copy a segment, or a pin of it, into a
segment of its own, use `materializeMany` with the segment as its one operand. It reads each chunk once, at one instant,
where a combine that names the segment twice reads it twice and, on a live segment, can write a chunk that holds two
generations:

<!-- typecheck-skip: a fragment, `src` and `dest` are segments the reader already holds -->
```ts
// src and dest are segments of this store. `keep` is how many earlier generations of dest the call keeps.
await store.materializeMany({
  operands: { src },
  outputs: [{ dest, expr: { or: ['src'] } }],
  keep: 2,
});
```

To suppress the result of an intersection, pass `exclude` to `intersectInto` instead of writing a temporary segment and
then calling `andNotInto`. The suppression folds into the same chunk-aligned pass, and each exclude is read only where
the intersection survived.

**An operand that names a segment which does not exist is refused**, by every combine, streamed or not.
`store.segment('global-opt-out')` and `store.segment('global-opt-out', { namespace: 'suppression' })` are different
segments, and unchecked, the first would resolve to nothing and suppress nobody, returning the full audience with no
error. The dangerous direction is the quiet one: a mistyped include collapses an intersect to nothing and you notice,
while a mistyped exclude removes a safeguard and you do not. Both throw a `ValidationError` naming the segment. A
segment with a registry row that is not a tombstone is accepted even when it holds no ids, because somebody created it
deliberately: a row minted by `setRetention` before its first load, or a segment loaded empty. A name with no registry
row is refused, and so is a `destroyed` tombstone (a segment dropped, retired, crypto-shredded or destroyed in
the clear). `store.exists()` answers `false` for a row minted ahead of its first load, which a combine still accepts.
Pass
`allowAbsentOperands: true` to combine against a name that may not exist yet; it then reads as empty.

To write many results over the same operands, see [many outputs from one pass](#many-outputs-from-one-pass-materializemany).

## Many outputs from one pass: `materializeMany`

A refresh that writes hundreds of segments, each a different `and` / `or` / `andNot` over the same stored operands,
costs a lot as `*Into` calls: each one reads its operands again, and a nested expression needs a scratch segment per
inner group, a published generation each. `store.materializeMany` computes the outputs together. It reads each operand's
chunks once per group of outputs, for every output of the group that uses them (one group when the outputs fit the
memory budget, more when they do not), evaluates every output chunk by chunk, and publishes each as the `*Into` it
replaces would, to a `dest` of its own. An operand is a name: one segment given under two names is read twice, so name
each segment once and use that name in every output. Every operand and every `dest` must be a segment made by the
store the call runs on, as for `intersect`, `union`, `andNot` and the `*Into` verbs: a segment of another store, of a
second store object over the same backend, or of another installed copy of `@cloudbitmaps/roaring` is refused with a
`ValidationError` before any request. Open each with this store's `segment()`.

<!-- typecheck: store -->
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
plan exceeds, the last two before any chunk is read. Each output's generation holds, chunk for chunk, what the same ids would
load, since every chunk goes through the codec's canonical encoding before it is written; the footer of each carries its
own write identity.

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
generations of one operand, which also breaks the call's pruning. Unlike a combine, it does not list an operand's chunk
keys again when the operand moves: it reads the keys each index listed when the call began, so a chunk a load adds to
an operand during the call is not read. **With `pin: false` the re-check below does not run**: an
opt-out list can move during the call and the outputs that subtract it are published; `stats.operands` still says, from
one registry read at the end, that it moved.

**Every pinned operand an output subtracts is re-checked.** A suppression list that moved during a long call is the
dangerous staleness. An output subtracts an operand when it is in its `exclude`, or under any entry of an `andNot` after
the first, at any depth, so `{ andNot: ['us', 'opt-out'] }` and `exclude: ['opt-out']` are guarded alike. Immediately
before the publishes the call re-reads the registry row of every pinned operand any output of the group subtracts, and
compares what it finds with what was pinned: the generation, the row's incarnation and, where both reads carry one, the fingerprint of the generation's
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
| 256 MiB, the default | 78 | 18,870 | 4,815,000 | 201 MiB |
| 2 GiB | 6 | 3,570 | 900,000 | 1,472 MiB |

so at that size the default makes 4,815,000 chunk reads in 78 groups, about 32 times the 150,000 that one read of every chunk of every operand (100 operands of 1,500 chunks) makes, and 5.3 times the 2 GiB call's; a larger `maxBufferedBytes` is the lever.
The groups, and with them the range and chunk reads, depend on when each publish settles, since a group's buffers are
released only as its publishes settle: a publish that makes one more request, or a store with other latencies, can close
a group at another output. These figures are of this engine over the in-memory backend, not a property of the shape alone.
Planning sizes groups from the index, which cannot know how much two operands overlap, so an `and` of two large operands is
priced at the smaller and is often far smaller in fact; the high water mark above shows how much of the budget a call used.

**Reads are chunk-skipping, and bypass the chunk cache.** Each output reads an operand only at the chunks that can change
its result: an `and` at the keys all its operands hold, an `or` at any, an `andNot` at its left side's keys, and a
subtrahend only where the left side can overlap it, so a long opt-out list costs reads in proportion to the audience.
`stats.chunks.pruned` counts the chunks skipped. The pass reads through the storage source and never writes the decoded
chunk cache, so a batch neither evicts another reader's hot chunks nor is served from them. Every chunk is decoded
through the checks on untrusted bytes. A key an operand's index lists whose bytes are missing is an error for the outputs
that read that operand, never an empty chunk: an exclude would otherwise subtract nothing.

**Leases.** A handle anywhere in the call, an operand or a `dest`, whose lease has lapsed or was released is refused
before any request, as the `*Into` verbs refuse one. A leased operand's lease is checked before each chunk key is read:
a lapse fails only the outputs that read that operand, with `LeaseExpiredError`, and never reads empty. Each `dest`'s
lease is checked again just before its publish.

**Requests of a refresh-shaped call.** Counted in memory by `bench/materialize-many-counts.cjs`, which wraps the storage
driver and the registry of the in-memory backend and counts every call they are asked, not measured on S3 and with no
time recorded: 100 stored operands of 200,000 ids each, 1,000 outputs that are trees of one or two levels of
`and` / `or` / `andNot`, each with the same opt-out list excluded, every `dest` already holding a generation, `keep: 12`.
The counts are in `bench/materialize-many-counts.json`, and a test holds these figures to it; CI recounts a smaller shape
(20 operands, 100 outputs) with `pnpm bench:materialize-many-counts:check`, and this one is committed and recounted on
demand with `node bench/materialize-many-counts.cjs --check --all`.

| | range reads | tail reads | row reads | **GET-class** | **PUT-class** | scratch segments |
|---|---|---|---|---|---|---|
| 1,000 `*Into` calls, nested groups through scratch segments | 127,458 | 2,736 | 4,220 | **134,414** | **3,404** | 818 |
| one `materializeMany`, default 256 MiB (6 groups) | 589 | 1,100 | 2,043 | **3,732** | **1,768** | 0 |

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
that has a generation and three for one that has none, and two more when the guard refuses it (its reclaim reads the row
before it deletes its object, and then the row once more after the delete, or, for a destination with no row, the
object's footer before it). A test holds that recipe to a
recording driver over pinned and live operands, new and existing destinations, refused and published outputs and unused
operands. Not known to the call: a multipart upload's extra requests, a listing, and what a publish that threw sent.
In the counted call above `attributed.put` equals the drivers' PUT-class count and `attributed.get` is a small part of the
GET-class count; the counts are side by side in the JSON.

**The budget.** `budget` counts chunk reads over all the groups, re-reads included. A call that passes none gets, when the store
was built with a `budget` of its own, that one, so a store ceiling below the plan throws `BudgetExceededError` before any chunk
is read, as it does for every other operation, and it can refuse a realistic call: the `target` shape above plans
4,815,000 chunk reads at the default memory budget and 900,000 at 2 GiB, against a library default of
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

<!-- typecheck-skip: a fragment: the page leaves `countsFromTheWarehouse`, `records` to the reader -->
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

An output names a fed operand as it names a stored one, and one name is not both. The call's outputs hold, chunk for chunk, what the
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
operand is a `ValidationError`. The counts are the producer's own: a producer whose records and counts both come from the
same failed source agrees with itself, and the call cannot tell.

**Fed outputs are atomic.** A fed output (one that names a fed operand) is published only after the whole feed has been read and
every end-of-feed check passed. A bad record, an iterator that throws, a count that does not match, an empty name, the budget
passed while the feed is read, or an erasure before the publishes begin refuses **every fed output** and publishes none of them,
and the iterator is told to stop; the call does not throw, each `run.outputs[i]` of a fed output carries the error
(`ValidationError` for the feed, the error the iterator threw as it was, `BudgetExceededError`, `StaleOperandError`). Once the
feed has been read and checked, each fed output publishes on its own, as any output does: an erasure is checked again before each
publish, so one that lands while the publishes run refuses every fed output not yet published and leaves those already published,
and a fed output whose object would not fit the budget at its publish is refused alone, with `BudgetExceededError`, while the
others publish. Outputs that name only stored operands are planned and published as a call without a feed plans and publishes them, and are not affected.

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

<a id="operands-held-in-memory-storememory"></a>

### A set you hold: feed it

A few conditions, or a suppression list the caller already holds as a bitmap, go into the call as a feed. Each record is
one chunk key (`id >>> 16`) and the ids a name holds there, in ascending key order; a key may arrive as several records,
each naming an operand once. This walks the sets you hold, by chunk key, and yields them in that order:

<!-- typecheck-skip: a fragment: the page leaves `lapsed`, `vip` to the reader -->
```ts
import type { RoaringBitmap32 } from 'roaring';

/** The chunks of one set: each key with its ids, ascending. */
function* chunksOf(bm: RoaringBitmap32): Generator<{ key: number; ids: Uint32Array }> {
  let key = -1;
  let ids: number[] = [];
  for (const id of bm) {
    if (id >>> 16 !== key && ids.length > 0) {
      yield { key, ids: Uint32Array.from(ids) };
      ids = [];
    }
    key = id >>> 16;
    ids.push(id);
  }
  if (ids.length > 0) yield { key, ids: Uint32Array.from(ids) };
}

/** A feed of the sets you hold, by operand name: one record per set and key, in ascending key order. */
async function* feedOf(sets: Record<string, RoaringBitmap32>) {
  const heads = Object.entries(sets).map(([name, bm]) => {
    const it = chunksOf(bm);
    return { name, it, next: it.next() };
  });
  for (;;) {
    const live = heads.filter((h) => !h.next.done);
    if (live.length === 0) return;
    const key = Math.min(...live.map((h) => (h.next.value as { key: number }).key));
    for (const h of live) {
      const chunk = h.next.value as { key: number; ids: Uint32Array };
      if (chunk.key !== key) continue;
      yield { key, operands: { [h.name]: chunk.ids } };
      h.next = h.it.next();
    }
  }
}

const held = { vip, lapsed }; // RoaringBitmap32s you hold
await store.materializeMany({
  operands: { engaged: store.segment('cond-engaged') },
  feed: {
    names: Object.keys(held),
    records: feedOf(held),
    counts: Object.fromEntries(Object.entries(held).map(([n, bm]) => [n, bm.size])),
  },
  maxBufferedBytes: 256 * 1024 * 1024,
  mayBeEmpty: ['lapsed'], // a set that may hold no id is named here, at the call's top level
  outputs: [{ dest: store.segment('send-1'), expr: { and: ['vip', 'engaged'] }, exclude: ['lapsed'] }],
  keep: 12,
});
```

The outputs hold, chunk for chunk, what the same sets stored would publish. Everything said of a feed above holds: every record
is checked, a fed call runs as one group and needs `maxBufferedBytes`, a set that holds no id is refused unless its name is
in `mayBeEmpty`, and an erasure that this store runs while the call runs refuses it. The sets are your copy, which no
erasure reaches: build them from the source after any erasure.

**A small set that narrows a large stored one: load it instead.** A fed operand names no chunk keys before the pass, so
an `and` of a fed set with a stored segment reads every chunk of the stored one, even where the fed set holds no id.
When a set you hold is small and the stored operand it narrows is large, load the set as a segment of its own and name
it as a stored operand: the call then reads only the chunks the two share, at the cost of that load. Drop it with
`dropSegment` when the refresh is done.

### Look before you publish: a dry run

`dryRun: true` computes every output exactly as the call would, judges each against its `dest` as its publish would be,
and writes nothing: no object, no pointer, no audit event. Use it to look at a whole refresh before any of it is live,
for instance to hold a landing in which a third of the segments moved more than usual.

<!-- typecheck-skip: a fragment: the page leaves `operands`, `outputs` to the reader -->
```ts
const review = await store.materializeMany({ operands, outputs, keep: 12, dryRun: true });
for (const [i, o] of review.outputs.entries()) {
  if ('error' in o) continue; // what would fail its publish
  // o.cardinality: the ids it would hold · o.cardinalityBefore: what dest holds now · o.wouldRefuse: the bound that would refuse it
}
```

- **What it reports.** Each output is `{ dryRun: true, published: false, cardinality, cardinalityBefore, wouldRefuse? }`,
  or `{ published: false, error }` for what would fail its publish: a `dest` whose lease has ended, a destroyed one, a
  moved exclude, an erasure, a damaged operand. `cardinalityBefore` is always read, `null` when `dest` has no current generation, and
  `wouldRefuse` is the `reason` a publish would give now, absent when it would publish. `published` is `false`, so code
  that branches on it never takes a dry run for a publish.
- **Its type.** `dryRun: true` is typed as a dry run's result and `false` or absent as a publish's, so TypeScript knows
  which it gets. A `dryRun` held in a variable, a `boolean` or an optional one, is typed as either
  (`MaterializeManyRun | MaterializeManyDryRun`), and the flag you passed says which:
  `const run = await store.materializeMany({ ...options, dryRun: flag })`. Each output's result tells itself apart:
  `'dryRun' in outcome` is true only of a dry run's.
- **What it costs.** The operand reads of the publishing call, and for each output the reads a publish's own guard
  makes: one registry read for its `dest`'s size, or two where the row has no usable summary. No write, so no more than
  the publish. `stats.requests.publishes` is `0`, and `stats.requests.attributed.get` counts the reads of each `dest`. It
  holds the memory the publish would, so it is admitted, deferred and refused for memory where the publish would be, and
  it reports to the metrics sink as the same `materializeMany` op.
- **What it holds for.** Now only: a publish made later reads its operands and judges each `dest` as they are then.

#### Publish what you reviewed

A dry run decides nothing by itself. Publish the outputs you accept by calling again without `dryRun`. The second call
is an ordinary one: every guard and every race check runs, judged against each `dest` as it is then.

- **Stored operands:** pass both calls the same handles, pinned with a lease (`pin({ leaseUntil })`), so both read the
  same generations and the publish writes the ids the dry run counted, whatever loads land between the calls. An erasure
  between the calls deletes every generation that held the erased id, a leased one included, so each output that reads
  it fails with `NotFoundError` and publishes nothing, while the others publish. Without a pin, an operand that moved
  between the calls is read as it is at the publish; each call's `stats.operands` says which generation it read.
- **A feed:** replay the same records. **A replayed feed is your memory, which no erasure reaches**: a fed call is
  refused only for an erasure this store runs while that call runs. If an erasure has run since the records were made,
  rebuild them from the source rather than replay them. Or publish through candidates: write each accepted output to a
  scratch segment of its own, which `eraseSubject` sweeps like any other, then publish each candidate to its `dest` in a
  second call whose output is `expr: '<candidate>'`, and drop the candidates.
- **The same ids give the same chunks.** Each write carries its own write identity in the footer (and an encrypted one
  seals with a fresh nonce), so the objects of the two calls are never the same bytes.

#### Recipes over a dry run

- **A growth ceiling with an absolute floor.** Set each output's `guard.maxGrowth` in the publishing call from the dry
  run's `cardinalityBefore`: `before ? Math.max(1.5, 1 + 1000 / before) : 0` refuses only above both `before × 1.5` and
  `before + 1000` ([the two ratio bounds](correctness.md#when-a-load-is-refused)).
- **The overlap with what is live.** A key shift keeps the size, so compare members. One call cannot read its own
  destination, so count the overlap in a second dry run that reads each `dest` as an operand:

  <!-- typecheck-skip: a fragment: the page leaves `operands`, `outputs` to the reader -->
  ```ts
  const overlap = await store.materializeMany({
    operands: { ...operands, ...Object.fromEntries(outputs.map((o, i) => [`live-${i}`, o.dest])) },
    outputs: outputs.map((o, i) => ({
      dest: store.segment(`overlap-${i}`), // judged, never written
      expr: { and: [o.expr, `live-${i}`] },
      allowEmpty: true,
    })),
    allowAbsentOperands: true, // a dest with no generation yet reads as empty: its overlap is 0
    keep: 1,
    dryRun: true,
  });
  // overlap.outputs[i].cardinality: how many of dest i's current ids output i keeps
  ```

  Hold the publish of an output whose overlap is under your share of its `cardinalityBefore`. It reads the operands a
  second time. An output over fed operands needs the feed in this call too: pass its records again, with the
  `feed`, `maxBufferedBytes` and `mayBeEmpty` the first call had.

## How it stays correct

A load [takes the next generation number itself](correctness.md#numbering-is-the-loads), [writes its object first, and
only once the object is durable moves the pointer](correctness.md#publish-is-forward-only), by a compare-and-swap that
never moves it backwards and [is fenced on the row the load read](correctness.md#which-fence). So [a crash never moves
the pointer](correctness.md#crash-never-moves-the-pointer), [a rerun is a newer identical generation, and of two loads
racing on one segment at most one lands](correctness.md#publish-is-forward-only). A load that dies between its write and
its publish leaves an orphan, which [a later load's collection removes](correctness.md#orphan-collected-later). A load's
collection [deletes only below the pointer on an active segment, keeps the window the row
records](correctness.md#what-collection-does), [spares a generation a live lease
holds](correctness.md#lease-read-from-the-row), and [re-proves the row before every
delete](correctness.md#collection-re-proves-the-row). The whole mechanism is in [How a load stays
correct](correctness.md#how-a-load-stays-correct).

### A rollback that races a collection

[Every loop that deletes generations reads the segment's row just before each delete, and a rollback held to the row's
`knownGens` is kept out of all of them](correctness.md#every-delete-reads-the-row). One that is not (`allowUnknown`, or
a target the pointer alone decides) can land on a generation in the round trip between that read and the delete. The
deleting call then [finds the pointer on a generation it deleted](correctness.md#deleting-call-detects) and, [once its
reads of the row over the next 1.75 s all still find it there](correctness.md#rollback-check-gets-time), throws
`NotFoundError` naming it rather than answer; [it repairs nothing](correctness.md#rollback-race-limits). One delete is
not held to this, [a refused erasure rewrite's delete of its own object](correctness.md#deleting-call-detects), which
only `checkConsistency()` finds. [Look with `store.generations(ref)` or `checkConsistency()` before
acting](correctness.md#rollback-race-what-to-do): [a rollback that races a
collection](correctness.md#a-rollback-that-races-a-collection) says what each delete reports, what to do, and what the
check costs.
