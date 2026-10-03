# API Reference — the complete surface

The single source of truth for **everything a user can import and call** across all entry points. Organized
user-first: the everyday surface at the top, the occasional operations next, the driver-author plumbing last, and
a flat **[Complete export index](#complete-export-index)** at the end that names every export.

> **Kept in sync by CI.** [`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts)
> derives the list of entry points from every package's own `exports` map — so each package in the workspace and
> each subpath it declares is covered, with no list to keep up to date — extracts every exported name from each,
> and fails the build if any is missing from this page. So a new export **cannot** merge without being documented
> here, and a name the export index lists that no package exports fails it too.

---

## Mental model: three nouns, one way in

```
a STORE  ──has many──▶  SEGMENTS  ──each is──▶  write-once GENERATIONS (.crbm objects) behind ONE registry pointer
CloudRoaring            store.segment('name')    <segment>.<gen>.crbm  ·  registry row: { currentGen }
```

A segment holds **IDs** (`u32` integers, `[0, 2³²)`). Data enters a segment **only as a new generation**: a load
(`store.load`) writes one immutable object and then publishes it — a forward-only compare-and-swap of
the pointer. Every other write in the library is a load in disguise: the `*Into` verbs write a new generation of
their destination, and a subject erasure rewrites the current generation without one id. Reads (`has` / `count` /
`iterate` / `intersect` / `union` / `andNot`) resolve the current generation once and read whole, checksum-verified
chunks from it. There is no `add`, no `remove`, and no mutable tier.

## Entry points

You install **two packages** — a codec and a storage — and `@cloudbitmaps/core` arrives as a dependency of
both. Each package is its own entry point, and `@cloudbitmaps/roaring` re-exports, by name, the part of core that
an application uses, as the next paragraph says:

```
@cloudbitmaps/roaring         the store + memory/localfs backends + the errors, helpers and types an application uses
@cloudbitmaps/s3              S3Storage                                           (dep: @aws-sdk/client-s3)
@cloudbitmaps/gcs             GcsStorage                                          (dep: @google-cloud/storage)
@cloudbitmaps/azure-blob      AzureBlobStorage                                    (dep: @azure/storage-blob)
@cloudbitmaps/core            the engine, the standalone forms of the store's methods,  (flavor and driver authors only)
                              the retry and budget internals
@cloudbitmaps/core/driver-kit the declared contract for writing a driver package   (driver authors only)
CLI (binary):                 export-segments
```

Each cloud SDK is a **real dependency** of its backend package, not an optional peer: installing
`@cloudbitmaps/s3` installs `@aws-sdk/client-s3`, and no install carries an SDK for a service you do not use.

**Where the code actually lives.** The flavor package is the roaring codec (internal, not exported),
the `CloudRoaring` facade, and the `export-segments` CLI; its main barrel re-exports, by name, the store's
types, the errors, the backends' shared types and the constants and helpers an application calls, which is why an
application never needs to name core. What it leaves on core is the engine, the standalone forms of the store's
methods and the retry and budget internals, for a flavor or driver author. The storage packages are codec-agnostic — they move
opaque payload bytes — so one package per storage **service** serves every codec, which is what makes adding
a codec cost nothing on the storage axis. A driver author builds against
[`@cloudbitmaps/core/driver-kit`](#cloudbitmapscoredriver-kit), and a flavor never re-exports a driver
package: doing so would put that SDK back into every install.

---

## The everyday surface (what you'll call)

### Build a store — `new CloudRoaring(options)`

`storage` is the **only option a store needs**. Pass a backend and you are done: it carries the pointer, which is
what gives one-read generation resolution, encrypted segments, the `*Into` verbs and every lifecycle helper.
Everything else is optional tuning with sensible defaults — see [`CloudRoaringOptions`](#construction--result-types).

**You pick a backend.** A `StorageBackend` carries both the generations and the
pointer — configured from one bucket and one prefix, which is what makes them impossible to mismatch:

| Backend | Import | Construct |
|---|---|---|
| `MemoryStorage` (`MemoryStorageOptions`) | `@cloudbitmaps/roaring` | `new MemoryStorage({ now? }?)` |
| `LocalFsStorage` (`LocalFsStorageOptions`) | `@cloudbitmaps/roaring` | `new LocalFsStorage('/var/lib/cloudbitmaps', { now? }?)` — generations under `<root>/storage`, pointers under `<root>/registry`, which is also the layout `export-segments` expects. A root is for one process: instances in a process share a lock per row, two processes on one root are not fenced |
| `S3Storage` | `@cloudbitmaps/s3` | `new S3Storage({ bucket, prefix?, client?, region?, endpoint?, pathStyle?, credentials?, maxObjectBytes?, partBytes?, readTimeoutMs?, conditionalDelete?, now? })` — `client` or the four settings that build one, and both is refused |
| `GcsStorage` | `@cloudbitmaps/gcs` | `new GcsStorage({ bucket, prefix?, client?, projectId?, apiEndpoint?, maxObjectBytes?, simpleUploadThresholdBytes?, readTimeoutMs?, conditionalDelete?, now? })` — `client` or the two settings that build one, and both is refused |
| `AzureBlobStorage` | `@cloudbitmaps/azure-blob` | `new AzureBlobStorage({ containerClient, prefix?, maxObjectBytes?, blockBytes?, readTimeoutMs?, conditionalDelete?, now? })` or `({ connectionString, container, prefix?, maxObjectBytes?, blockBytes?, readTimeoutMs?, conditionalDelete?, now? })` — one or the other, and both is refused |

**A backend comes from one of these five classes, or from a class of your own that calls `brandAsBackend` from the driver kit
([driver kit](#driver-kit--what-you-need-to-implement-a-driver)).** A plain `{ storage, registry }` object is
refused — it is also the shape of the deps of core's standalone functions, so accepting it would let a store be built from
a storage and a registry belonging to two *unrelated* stores, which would construct happily and then read as **empty** because
the pointer it consulted lived where nothing had been written.

**The size settings are backend options.** They size the backend's uploads and are validated where the backend
is built:

| Backend | Option | Default | What it does |
|---|---|---|---|
| `S3Storage` | `partBytes` | 8 MiB; a smaller value is raised to S3's 5 MiB minimum | multipart part size, and so the peak write memory; a positive safe integer |
| `S3Storage` | `maxObjectBytes` | `partBytes` × 10,000 (about 80 GiB at the default) | the largest object the backend will write and advertise; raise it and `partBytes` grows so the 10,000-part limit still covers it, up to S3's 5 TiB; a positive safe integer |
| `S3Storage` | `readTimeoutMs` | `0`: no timeout | how long each `GetObject` and `HeadObject`, the SDK's own retries of it included, may take, the response body included, before it is aborted and throws `TransientError` for the store's read retry; an integer from 0 to 2,147,483,647 |
| `GcsStorage` | `simpleUploadThresholdBytes` | 8 MiB | an object up to this size is one simple request; a larger one is a resumable stream; a positive safe integer |
| `GcsStorage` | `maxObjectBytes` | 5 TiB, GCS's per-object maximum | the largest object the backend will write and advertise; set it lower to fail fast on a runaway write; a positive safe integer |
| `GcsStorage` | `readTimeoutMs` | `0`: no timeout | how long one read (a tail with its metadata fallback, a range, a registry row) may take, every attempt and the body included, before it throws `TransientError` for the store's read retry; see [`@cloudbitmaps/gcs`](#cloudbitmapsgcs); a non-negative safe integer no larger than 2,147,483,647 |
| `AzureBlobStorage` | `blockBytes` | 8 MiB | staged block size, and so the peak write memory; a positive safe integer |
| `AzureBlobStorage` | `maxObjectBytes` | `blockBytes` × 50,000 (about 400 GiB at the default) | the largest blob the backend will write and advertise; raise it and `blockBytes` grows so the 50,000-block limit still covers it; a positive safe integer |
| `AzureBlobStorage` | `readTimeoutMs` | `0`: no timeout | how long each read request (a range read, a tail read's properties and its download, each on its own, a registry row's read) may take, the response body included, before it is aborted and throws `TransientError` for the store's read retry; an integer from 0 to 2,147,483,647 |

**Each cloud backend says whether its registry removes a deleted row for good: `conditionalDelete`.** On, a row the
registry deletes, the retention sweep's purge of a tombstone included, is removed from the bucket by a delete the
service applies only to the version the registry read: `DeleteObject` with `If-Match` on S3, a delete with
`ifGenerationMatch` on GCS, Delete Blob with `ifMatch` on Azure Blob. A precondition that no longer holds is a
`WriteConflictError`, and the registry re-reads. Off, every delete leaves a tombstone in the row's place, which every
full listing reads. A row written by a release before 0.12 is tombstoned either way. `backend.registry.capabilities()`
reports which (`conditionalDelete: true` or `false`). A value that is not a boolean is refused with `ValidationError`.
The registry needs delete permission on its prefix for it.

| Backend | Default | Why |
|---|---|---|
| `S3Storage` | `true` when the host the client resolves is an AWS S3 host; `false` for any other host, or one that cannot be resolved | AWS documents `If-Match` on `DeleteObject` for general purpose and directory buckets. An S3-compatible store may accept the header and ignore it, and MinIO does, so a client that sends to one keeps tombstones until you set `true`. The host is the one the SDK resolves for a request, so an endpoint set by `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config file counts as a constructor `endpoint` does; an AWS regional, FIPS, dual-stack or VPC interface host is AWS |
| `GcsStorage` | `true` on the public endpoint; `false` with a custom `apiEndpoint` | GCS applies `ifGenerationMatch` on a delete; fake-gcs-server ignores it |
| `AzureBlobStorage` | `true` | Azure Blob applies `If-Match` on Delete Blob, and Azurite does too |

**The S3 default is read from the client, once, before the registry's first request.** The registry serialises the
requests it will send through a second client built from the first one's configuration, without sending anything,
and reads back the host and the headers: the SDK's own resolution of the region, the environment, the shared config
file and the endpoint options, with none of the middleware, logging or credentials you gave your client in play (a
request counter of yours counts no probe, and a class-level mock of `S3Client.send` records none). A middleware of yours that changes where a request goes is not seen. Until that first read or listing, `capabilities().conditionalDelete` reads `false` unless you set the option,
and a client that cannot be resolved then (no region) keeps tombstoning for the life of the registry.
It also checks that the SDK sends the preconditions the registry relies on: an `@aws-sdk/client-s3` whose model lacks a
member drops it from the request without a word. A `DeleteObject` that would go out without `If-Match` keeps the row
tombstoned, whatever `conditionalDelete` says, and a `PutObject` that would go out without `If-None-Match` (a create) or
`If-Match` (a compare-and-swap) is refused with `ValidationError` before anything is sent, since it would overwrite
instead of failing. Set `conditionalDelete: true` or `false` to override the host; it never overrides the SDK.

Whether real S3 and real GCS refuse a stale precondition on a delete is checked by a probe against real buckets
(`tests/integration/real-cloud-conditional-delete.test.ts`), which the integration lane, on emulators that ignore it,
cannot replace.

**`S3Storage` can time its reads.** `readTimeoutMs` (`0`, the default, sets no timeout; an integer from 0 to
2,147,483,647) is how long each `GetObject` and `HeadObject` either half sends may take, the response body included,
before it is aborted and throws `TransientError` for the store's read retry. The clock starts when the read is handed
to the SDK, so waiting for a socket and fetching credentials count. Writes and listings are not timed, and a `client`
you pass gets the timeout without being changed ([why](production.md#reliability-retries-backoff--timeouts)).

**`AzureBlobStorage` can time its reads.** `readTimeoutMs` (default `0`, no timeout; an integer from 0 to
2,147,483,647) is how long each read request either half sends may take, the response body included, before it is
aborted and throws `TransientError` for the store's read retry: a range read, a tail read's properties and its ranged
download, each on its own, and a registry row's read. The clock starts at the call into the SDK. Writes, deletes and
listings are not timed ([why](production.md#reliability-retries-backoff--timeouts)).

Each cloud backend builds its own SDK client unless you pass one. Every backend exposes its storage and registry as `.storage`
and `.registry`, and accepts an injected `now` for deterministic tests. The three cloud backends refuse an option
key they do not take, by name, as the store does.

> **`backend.storage` is not a backend.** It is the storage alone, without the registry: a raw `IStorageDriver`. Passed as `storage`,
> it builds a store with no pointer: cleartext and read-only, as the raw-driver paragraph below describes. Pass
> the backend itself.

The **keystore** (optional encryption) is separate from the backend: `InProcessKeystore` (BYOK), passed as
`encryption.keystore`.

Pass a **raw** `IStorageDriver` as `storage` and the store builds the `.crbm` reader (`CrbmStorageChunkSource`) over it with
**no registry** — generations then resolve by list-scan, so the store is **cleartext and read-only**; or pass a pre-built `StorageChunkSource` (a
`CrbmStorageChunkSource` you configured yourself, or one of your own) and it is used as-is — an `encryption.keystore` or
`encryption.required: true` beside it is then rejected as a wiring mistake (configure them on the source). A store
built on a pre-built source is **read-only**: the `*Into` verbs and the lifecycle helpers need a backend and
throw `UnsupportedError`, and so do the calls that enumerate or read the registry (`exists`, `segments`,
`subjectReport`, `exportSegments`), since the store holds no registry of its own, even when the source you built
reads through one.

A storage that cannot serve range reads (none of the five backends above is one; a driver of your own might be) is
refused at construction with `CapabilityError`, and so is a keystore or `encryption.required: true` on a store built
on a bare `IStorageDriver` instead of a backend, which has no registry to hold wrapped keys.

### Get a segment — `store.segment(name, { namespace?, expiresAt? })` → `Segment`

`expiresAt` is an absolute epoch-**milliseconds** deadline, declared where the segment is named. Past it, every
read through **that handle** answers empty — `has` → `false`, `count` → `0`, `iterate` → nothing — as one integer
compare against the injected clock, with **no I/O, on every backend**. Set algebra stays coherent with it: an
expired operand makes an `intersect` empty and is dropped from a `union`. **An expired exclusion excludes nothing,
in every shape** — `andNot`, and `exclude` on `intersect` and `union`, the range read included: it is skipped
without being read, so an expired exclusion naming a segment that does not exist is not refused as an absent operand.
An `*Into` that involves an expired handle, an exclusion included, still throws `ValidationError`: it does not
publish a generation the exclusion did not shape.

It does **not** reclaim the bytes (`retireExpired` does, so `count()` reporting 0 while objects still exist is the
expected state in that window) and it does **not** apply to other handles — record the policy with
`setRetention` to make it durable, fleet-visible and reclaimable. A seconds-shaped value is refused at the
handle rather than silently making the segment permanently empty. `seg.expiresAt` reads it back.

A `Segment` has no public constructor: `store.segment(name)` and `seg.pin()` are the only ways to get one, because a
handle is wired to the store's engine, caches and write path. The class is exported for `instanceof` and to annotate
a variable, and `new Segment(…)` throws `ValidationError`.

### Load a generation — `store.load(ref, input, { allowEmpty?, guard?, keep?, metadata?, audit? })`

The whole write path in one call: take the next generation number, stream `input` into one immutable `.crbm`
object, check it is plausible, move the pointer, and collect what the move superseded, keeping the newest `keep`
generations below the new pointer (default `1`; a non-negative integer, and anything else — negative, fractional,
`NaN`, infinite — throws `ValidationError` before anything is written). The `*Into` verbs take
the same `keep`, validated the same way. Returns a
`LoadResult` — `{ generation, published, reason?, size, sha256, chunkCount, cardinality, cardinalityBefore,
collected }`. With a `keep` of 0 or 1, a load that found nothing above its pointer deletes by name the one generation
its publish pushed out of the window, and lists the segment only on every 16th generation; with a `keep` of 2 or more,
or when its check of its generation number met an object or its check of the current generation's object found it
gone, it lists on every load
([how it collects](loading.md#generations-and-keep)). `collected` names what the pass deleted, and a generation
deleted by name may have been gone already: a delete of an absent object succeeds and says nothing, so the list is not
a receipt that the generation was there. Memory is bounded by the **distinct set** being built, not by the input length — a batch job's shape,
not a request handler's — and the store's clock makes a long load yield the event loop. On a store built with a
keystore it writes encrypted: it mints the segment's DEK on its **first** generation, reuses it afterwards, and
never encrypts a segment whose existing generations are cleartext. `audit?` emits `segment.publish` for a generation
it lands and `segment.load-refused` for one it refuses.

**`metadata`** — a small record of your own, written with the generation: a flat object of string keys and string or
finite-number values, at most 1,024 bytes as canonical JSON (keys sorted by UTF-16 code unit, no whitespace) with no key
over 128 bytes. A record that breaks a rule is a `ValidationError` before the load makes a request, and `undefined` or
`{}` stores nothing. It is copied when you call, stored in the generation's object, and written to the segment's row, with
the generation's id count, by the same compare-and-swap that moves the pointer, so a reader that sees a generation as
current sees its metadata. It is immutable: a new generation is how it changes. A rollback puts the target's own back,
and an erasure rewrite carries it over unchanged without scanning it, so keep a subject's id out of it. Sealed under
the segment's key on an encrypted segment. `MaterializeOptions` takes it too, so each `*Into` verb does
([details](loading.md#metadata-what-a-generation-was-computed-from)). **Reading it back is not in this build.**

**The guard's size.** A guarded load takes the size of the current generation from the row's summary of it when the
row has a usable one, and opens no object for it; a row with none is read from the object's index, as before
([details](loading.md#where-the-guard-reads-the-size-of-the-current-generation)).

**Branch on `published`.** `false` is a normal outcome, not a throw, and `reason` says why. Either a guard refused
the result (`'empty'`, `'min-cardinality'` or `'min-retained'`), or another writer got there first (`'superseded'`).
There are two ways to get there first. Another load may have taken the same generation number, so this one wrote
nothing (`size: 0`). Or the segment's registry row changed while the load was writing: another load published, a
retention change, a rollback or an erasure wrote the row, or the row was deleted. A refused load deletes the object
it wrote while the row is unchanged, dropped or crypto-shredded, or gone once the object's footer proves it the
load's own, and leaves it in the bucket once another write has changed the
row: once a generation above it is current, collection counts it within `keep` like any other generation below the
pointer.
The `store.load` row lists the guards and what throws instead.

**`input` is a `LoadInput`: ids, or a whole bitmap.** Ids are any sync **or async** iterable of integers in
`[0, 2^32)`, unsorted, duplicates welcome. A bitmap is `{ serialized }`, one 32-bit bitmap in the portable Roaring
format, or `{ bitmap }`, any `PortableBitmap` (an object with `serialize('portable')`, such as `roaring`'s
`RoaringBitmap32`, and optionally `getSerializationSizeInBytes('portable')`, which lets a load refuse one over the cap
before serializing it), which is loaded as `{ serialized: bitmap.serialize('portable') }`, serialized once at the
call. A
bare `RoaringBitmap32` from the `roaring` this package uses, passed as ids, is loaded as `{ bitmap }`. Bitmap bytes are
capped at 537,403,396 bytes (more than any canonical 32-bit bitmap serializes to), must hold exactly one bitmap, and
are checked structurally and decoded by the safe deserializer before the first request; malformed or oversized
bytes, and bytes after the bitmap's end, throw `ValidationError` with nothing read or written. The chunks are then
cut from the bitmap's own containers, with no per-id work, and the generation is byte for byte the one the same ids
write. A `Uint8Array`, `Uint8ClampedArray` or `Buffer` passed as ids throws `ValidationError` when the load runs
(the type accepts one, since a byte array is an iterable of numbers): pass bytes as `{ serialized }`.
Anything that is none of these throws `ValidationError` too ([what a load accepts](loading.md#what-a-load-accepts)).

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.has(id)` → `Promise<boolean>` | membership: the cache, else **one** ranged GET of that id's chunk |
| `seg.count()` → `Promise<number>` | cardinality of the generation the handle reads: **one registry read when cold, none when warm, and no read of the object**, since the row records the generation's id count. A row with no summary it can use sends it to the `.crbm` index instead, with **zero payload reads**. It trusts the row's summary, or the index: neither is confirmed against the payloads, and a summary is held against the object whenever the object is opened ([What `count()` trusts](reading.md#what-count-trusts)). A segment whose pointer names a missing object counts the row's number, and a read of the object throws |
| `seg.stat()` → `Promise<SegmentStat>` | `{ generation, cardinality, metadata? }` from the one resolution that answers `count()`: the generation's number, its id count and the metadata it was loaded with (absent when it has none). One registry read when cold, none when warm or pinned. `{ generation: null, cardinality: 0 }` for a segment with no generation and for an expired handle ([details](reading.md#stat-the-generation-its-count-and-its-metadata)) |
| `seg.iterate({ after?, through? }?)` → `AsyncIterable<number>` | stream all ids, ascending, reading up to 8 chunks ahead (the window opens 1, 2, 4, 8 wide). With `after` / `through`, only the ids in `(after, through]` and the chunks the range overlaps ([paging](reading.md#page-through-a-segment)) |
| `seg.pin()` → `Promise<Segment>` | **hold this segment at the generation current right now**, for the life of the returned handle, so a long job describes one instant ([pins](reading.md#read-one-fixed-point-in-time)). A hold, not a lease: size `keep` past your longest pinned job. Needs a `.crbm` reader: any backend, a bare `IStorageDriver` or a pre-built `CrbmStorageChunkSource` |
| `seg.intersect([other, …], { after?, through?, concurrency?, budget?, exclude?, allowAbsentOperands? })` → `AsyncIterable<number>` | chunk-skipping intersection, streamed. `exclude` subtracts suppression segments **in the same pass**. `after` / `through` bound the result to `(after, through]` on every operand and every exclude, as on `iterate` |
| `seg.union([other, …], { after?, through?, concurrency?, budget?, exclude?, allowAbsentOperands? })` → `AsyncIterable<number>` | `this ∪ others`, streamed. The one composite with **no chunk-skipping** — every chunk of every operand is read, or every chunk inside the range when one is given |
| `seg.andNot([sup, …], { after?, through?, concurrency?, budget?, allowAbsentOperands? })` → `AsyncIterable<number>` | `this \ (sup…)`. Reads all of `this`, or all of it inside the range, but each exclude **only where it overlaps** |
| *every combine, streamed or `*Into`* | **refuses an operand that names no segment**, `this` and every `exclude` included, with `ValidationError`, unless you pass `allowAbsentOperands: true` ([why](reading.md#combine-segments-intersect-union-andnot)) |
| `seg.intersectInto(dest, [other, …], opts?)` · `seg.unionInto(dest, [other, …], opts?)` · `seg.andNotInto(dest, [sup, …], opts?)` → `Promise<MaterializeResult>` | materialize the result as a **new generation of `dest`**, superseding it ([the `*Into` verbs](loading.md#write-a-result-into-another-segment-the-into-verbs)). `opts` takes the combine's options, a range included, and `keep`, `allowEmpty`, `guard` and `metadata`. An empty result over a non-empty `dest` is refused (`published: false`); a lost race throws `WriteConflictError`. Collects nothing unless you pass `keep`. Needs a backend |
| `seg.costReport({ pricing?, workload? })` → `Promise<CostReport>` | grounded $ report from the segment's **real** `.crbm` size (no payload reads) |
| `seg.expiresAt` | the handle's deadline, if one was declared |
| `seg.pinnedAt` | on a handle from `pin()`, the `PinnedAt` it is held at; `undefined` on a live handle |
| `seg.key()` → `string` | an opaque string that names the handle's segment, namespace included: two handles of one segment have the same key. Use it as a `Map` key or a log field; its format is unspecified, so compare keys and never parse one |

That's the whole daily surface: **1 constructor + a backend + `store.load` + these verbs.**

**What each combine reads, and what a read costs.** `intersect` skips every chunk that cannot contribute, `andNot` reads
the suppression side only where it overlaps, and `union` reads everything. All three are charged against the same per-op
budget. [Reading in depth](reading.md#combine-segments-intersect-union-andnot) has the table, and why you pass `exclude`
instead of chaining.

**Read consistency.** Every read resolves the segment's current generation once, before it fans out, and every chunk it
reads is a whole, checksum-verified generation object. A long call can still describe two instants. To read one instant,
pin: `seg.pin()`. [How soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load) says what re-resolves a
segment mid-call and how the timed refresh behaves.

---

## Operations you call when you need them

### Store methods

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace? \| allNamespaces?, concurrency?, budget? })` → `Promise<SubjectReport>` | GDPR Art. 15 — which registered segments is this id in? Needs an explicit `namespace` or an `allNamespaces: true` ack, and throws `ValidationError` with neither. Needs a backend |
| `store.eraseSubject(id, { namespace? \| allNamespaces?, audit?, concurrency?, budget? })` → `Promise<EraseSubjectResult>` | GDPR Art. 17: for every registered segment the id is in, **rewrite the current generation without it** and delete every generation that held the bit, so it is gone from the bucket on return. Returns the erasure ledger, one entry per segment ([erasure](erasure.md)). Needs a `namespace` or `allNamespaces: true`, and a backend |
| `store.load(ref, input, { allowEmpty?, guard?, keep?, metadata?, audit? })` → `Promise<LoadResult>` | **replace this segment's contents** with `input` (ids, `{ serialized }` or `{ bitmap }`) as one new immutable generation: next number, write, check, move the pointer, collect. **Branch on `published`**: a refusal is a normal outcome, not a throw ([why a load is refused](loading.md#when-a-load-is-refused)). Needs a backend |
| `store.exists(ref)` → `Promise<boolean>` | whether a read of this segment would find anything, as **one registry point read**. Not the same as `count() > 0` ([details](loading.md#does-this-segment-exist)). Needs a backend |
| `store.segments({ namespace? })` → `AsyncIterable<SegmentInfo>` | every segment the registry holds, **streamed**, optionally scoped to one namespace. An admin call, not a request-path one ([details](loading.md#does-this-segment-exist)). Needs a backend |
| `store.generations(ref)` → `Promise<GenerationEntry[]>` | every generation still in the bucket, ascending, with the current one marked: the set `store.rollback` can choose from ([details](loading.md#roll-back-a-segment)). The current entry also carries `cardinality` and `metadata` from its row, with no further request (an encrypted segment's need a keystore that opens its key); the others carry only their number. Needs a backend |
| `store.rollback(ref, toGeneration, { audit?, allowForward? })` → `Promise<RollbackResult>` | **move the pointer back** to a generation still in the bucket: the one write that is not forward-only. Deletes nothing, and a target above the pointer needs `allowForward: true` ([rollback](loading.md#roll-back-a-segment)). Audited as `segment.rollback`. Needs a backend |
| `store.dropSegment(ref, { confirmSegment, dryRun?, audit? })` → `Promise<DropResult>` | **retire a segment and reclaim its storage**: tombstone first, then every storage generation. Branch on `dropped`, and check `generationsRemaining` ([retire a segment by hand](retention.md#retire-a-segment-by-hand-storedropsegment)). Needs a backend |
| `store.setRetention(ref, { expiresAt })` → `Promise<SetRetentionResult>` | **record when this segment becomes eligible for retirement**: one registry write, nothing deleted, nothing scheduled. `expiresAt` is an absolute epoch-millisecond instant you compute ([details](retention.md#record-when-a-segment-expires-storesetretention)). Needs a backend |
| `store.getRetention(ref)` → `Promise<RetentionPolicy \| null \| 'invalid'>` | the stored policy; `null` for none, `'invalid'` for a present-but-unusable `expiresAt` (a hand-edited row, a restore) so a malformed policy is visible rather than reading as "never expires". Needs a backend |
| `store.clearRetention(ref)` → `Promise<boolean>` | cancel the expiry; returns whether one was actually removed. A separate verb from setting one on purpose — "never expire" as a magic value passed to the setter is how a typo becomes a deletion. Needs a backend |
| `store.retireExpired({ namespace?, now?, limit?, dryRun?, scan?, lookbackBuckets?, shards?, totalShards?, maxScanSegments?, purgeTombstones?, tombstoneGraceMs?, audit? })` → `Promise<RetireExpiredResult>` | **the retention sweep**: retire every segment whose `expiresAt` has passed, each through `dropSegment`. A call you schedule, not a daemon; it returns a per-segment ledger, `purgeFaults`, the deletes the registry refused, and `firstPurgeFault`, the first one's reason; a refused purge is not charged to `limit`, and purging stops for the call after three refused in a row ([the sweep](retention.md#run-the-sweep-storeretireexpired)). Needs a backend |
| `store.checkConsistency({ namespace?, concurrency?, summaries? })` → `Promise<ConsistencyReport>` | DR: verify every registered segment's `currentGen` `.crbm` is present, to catch a torn cross-store restore. With `summaries: true` it also opens each current object (one tail read each) and reports `summary-mismatch` where the row's summary says another count or metadata than the object holds ([details](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic)). Holds at most 250,000 rows resident. Needs a backend |
| `store.invalidate(ref)` → `void` | **drop what this store derived about a segment**, so its next read resolves the current generation afresh. The store's own writes do this for themselves; call it for what they cannot see ([details](reading.md#how-soon-a-reader-sees-a-new-load)). No I/O |
| `store.exportSegments(sink, { format?, namespace?, ndjsonBatchBytes?, codec? })` → `Promise<ExportManifest>` | eject every registered segment's current generation to portable `roaring`/`ndjson` through your sink. `codec` builds the exported bitmaps for `'roaring'` and defaults to the roaring codec. Needs a backend |
| `CloudRoaring.estimateCost(input)` → `CostReport` | **static** — plan costs with no instance/data (sizing, what-if) |

### Standalone functions (imported, called directly)

These take a backend's `registry` rather than a store, and have no store method: a crypto-shred needs only a registry, so a job
that holds one can run it. Every other verb is a store method; the standalone forms of those are on
[`@cloudbitmaps/core`](#the-standalone-forms-of-the-stores-methods).

| Call | Does |
|---|---|
| `readRetentionPolicy(record.retention)` → `RetentionPolicy \| null \| 'invalid'` | parse a policy out of a row you **already hold** — a fleet sweep over `registry.list()`, where `store.getRetention` would cost a read per segment. The three-way answer is the point: `'invalid'` lets a sweep *report* a malformed row instead of silently reading it as "never expires" or aborting the whole ledger |
| `destroySegment(ref, { registry }, { confirmSegment, allowCleartext?, audit? })` → `Promise<DestroyResult>` | crypto-shred one whole segment: the key is deleted, so the bytes are unrecoverable everywhere, backups included, and the objects stay in the bucket. A cleartext segment has no key, so without `allowCleartext` the call changes nothing and returns `reason: 'cleartext'`. A free function over `backend.registry`, so it invalidates no store ([details](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)) |
| `eraseNamespace(namespace, { registry }, { confirmNamespace, allowCleartext?, audit?, maxScanSegments? })` → `Promise<{ destroyed: DestroyResult[] }>` | crypto-shred an entire namespace or tenant. It lists the namespace first and stops at `maxScanSegments` (default 250,000) with nothing erased. One `DestroyResult` per segment, with faults recorded rather than thrown, so **inspect it** ([details](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)) |
| `excludingReservedRows(listing)` | wraps a `registry.list()` stream and drops the bookkeeping rows (the due-index pointers). **Every unscoped fleet-wide enumeration must apply it** — `store.segments` and the sweep already do, so this is for a fleet pass you write yourself |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId, recoveryKeyId? })` | `encryption.keystore` (store) | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; omit the option for the no-op) | `metrics` | observability — `storage.get` / `cache` / `retry` / `intersect` / `op` events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; omit the option to record nothing) | `audit`, on each call that writes: `store.load`, the `*Into` verbs, `store.rollback`, `store.eraseSubject`, `store.dropSegment`, `destroySegment`, `eraseNamespace` and `store.retireExpired` | compliance trail — `segment.publish` / `segment.load-refused` / `segment.rollback` / `segment.rewrite` / `segment.erase` / `segment.dispose` / `namespace.erase` |

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `export-segments` | eject all registered segments from a local-filesystem store to a directory. Env: `CR_EXPORT_ROOT` (holds `storage/` + `registry/`), `CR_EXPORT_OUT`, `CR_EXPORT_FORMAT` (`roaring` \| `ndjson`), `CR_EXPORT_NAMESPACE` |

---

## Types in signatures

The option / result types the public methods above reference — you import these to annotate variables.

### Construction & result types

`CloudRoaringOptions` and its four groups — `CacheOptions` · `EncryptionOptions` · `RetryOptions` ·
`SeamOptions` (`metrics` and `budget` are flat options taking `IMetricsSink` / `BudgetOption` directly) · `SegmentOptions` ·
`SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `MaterializeResult` (`{ generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size, collected }` — what an `*Into` verb
wrote)

`CloudRoaringOptions`, in full — **one required key, four optional groups, and two flat options**:

| key | type | what it holds |
|---|---|---|
| `storage` **(required)** | `StorageBackend \| IStorageDriver \| StorageChunkSource` | where everything lives |
| `cache?` | `CacheOptions` | `maxChunks?` (decoded chunks held in RAM, default 1024) · `ttlMs?` · `genTtlMs?` (default 2000 ms; [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load); needs a backend) · `readerMax?` (open `.crbm` readers, default 1024) · `readerMaxBytes?` (their parsed indices and any metadata they hold, default 64 MiB) |
| `encryption?` | `EncryptionOptions` | `keystore?` · `required?` — both need a backend, since the wrapped DEK lives in the registry |
| `retry?` | `RetryOptions \| false` | a **partial** `RetryPolicy` (anything omitted keeps its `DEFAULT_RETRY_POLICY` value) plus `onRetry?`, for the transient retry of every read that answers a query, and of the reads a load's guard and an erasure make along the way; `false` turns it off. It does not govern writes: a write is retried only where that is safe, and not by this option ([Resilience](#resilience-the-store-wires-this-by-default)) |
| `metrics?` | `IMetricsSink` | typed metric events; defaults to a no-op |
| `budget?` | `BudgetOption` | `{ maxRequests }` or `false` |
| `seams?` | `SeamOptions` | `clock?` · `rng?` — determinism, for tests and replayable jobs |

**A key the store does not take is refused rather than ignored**, at the top level and inside each group, and the
error names each one and lists the keys the store or the group does take. A group's key written at the top level
(`keystore` for `encryption.keystore`) and a typo inside a group (`cache.maxChunk`) are both knobs whose absence
would be silent — a dropped `encryption.required` reads cleartext, a dropped `seams.clock` makes a deterministic
job non-deterministic — so being ignored would be worse than being rejected. `S3Storage`, `GcsStorage` and
`AzureBlobStorage` each refuse a key they do not take the same way, naming it and the keys they take: a client
goes in `client` (`containerClient` on Azure), so `GcsStorage` refuses `storage`, and each refuses another
backend's size setting, such as `S3Storage` refusing `blockBytes`. They refuse a setting beside a client the same way: a `client` carries its own
connection settings, so `S3Storage` refuses `region`, `endpoint`, `pathStyle` and `credentials` beside it, and
`GcsStorage` refuses `projectId` and `apiEndpoint`, each named. Configure them on the client, or drop `client`.

### Generation bookkeeping & erasure

`PinnedAt` (`{ generation, version, fingerprint? }` — what a pin holds for one segment; `fingerprint` names the object it pinned, so a replaced one is refused, and is optional only so that a pin built by hand still compiles, when nothing checks the object it reads; `generation: null` means the segment had none to pin and the handle reads empty, **not** that pinning is unsupported) · `PinnedObject` (`{ version, fingerprint? }` — what a pinned read of `CrbmStorageChunkSource` checks the generation's object against) · `EraseDeps` · `DestroyResult` · `DropResult`

### Retention

`RetentionPolicy` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` ·
`RetireEntry` · `MIN_EXPIRES_AT_MS` (the floor, 1,000,000,000,000 — 2001-09-09, on `expiresAt` **and** on the sweep's
`now`: anything smaller is almost certainly epoch *seconds*, which reads as already-expired)

### Export / eject

`ExportSink` · `ExportWriter` · `ExportFormat` · `ExportOptions` · `ExportedSegment` · `ExportFailure` ·
`ExportManifest`

### Cost & observability

`CostReport` · `PricingProfile` · `RedisSizing` · `RedisNodeType` · `Workload` · `SegmentSizing` · `EstimateInput` ·
`IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent`

The cost model has no per-id write term — data arrives as generations, and a generation is a load.
`PricingProfile` is `{ name, storage: { getPerMillion, putPerMillion, storagePerGiBMonth, requestsPerPointerRead?,
requestsPerSizedRead? }, redis }`, where `requestsPerPointerRead` is the requests one pointer read costs, 1 by default
and on S3, GCS and Azure Blob alike, and `requestsPerSizedRead` the requests one tail read costs, 1 by default, as on S3
and GCS, and 2 for Azure Blob, which takes no suffix range and reads the object's size first, so set it there; `redis` is either
`{ sizedToData: RedisSizing }`, the default's, which prices the cheapest cluster that holds the report's stored bytes,
or `{ monthlyUSD }`, one cluster whatever the data size — exactly one of the two, or it is refused. `RedisSizing` is `{ source, nodeTypes, replicasPerShard,
reservedMemoryFraction }`, and each `RedisNodeType` is `{ name, memoryGiB, ssdGiB?, hourlyUSD, maxShards? }`;
`Workload` is `{ readsPerSec?, intersectsPerSec?, cacheHitRate?, chunksPerIntersect?, operandsPerIntersect?,
loadsPerMonth?, requestsPerLoad?, hotSegments?, readerProcesses?, genTtlMs?, retirementsPerMonth?, purgesPerMonth?,
conditionalDelete? }`; `CostReport.monthlyUSD.byOp` is `{ reads, intersects, storage, loads, pointerRefresh, retention }`; `redisBaseline` is `{ basis: 'fixed', monthlyUSD }` or
`{ basis: 'sized-to-data', monthlyUSD, cluster: { nodeType, shards, nodes, dataTiering } }`, the Redis the verdict
compares against, with the last of `assumptions.notes` saying how it was priced; and
`redisCrossover.readsPerSec` is the sustained read rate at which pay-per-use passes it, net of storage and the pointer
refresh (≈329 reads/s against `ONE_REDIS_HA_CLUSTER` with a 0% cache-hit rate). What each term counts is in the
[guide](cost.md#what-each-term-counts), and what the verdict compares against
[beside it](cost.md#what-it-compares-against). `MetricOpName` is `'has' | 'count' | 'intersectInto' | 'unionInto' | 'andNotInto'`;
`MetricsSnapshot` is `{ storage, cache, retries: { transient }, intersect, ops }`.

### The storage interfaces (used to type `storage` / `registry`)

`IStorageDriver` · `IRegistryDriver` · `StorageChunkSource` · `SegmentRef` · `IKeystore` · `RetryPolicy` · `Clock` · `Rng`

### Read and combine options (used to type `iterate`, `intersect` / `union` / `andNot` and the `*Into` verbs)

`IdRange` (`{ after?, through? }` — the ids in `(after, through]`; `iterate` takes it, and every combine's options type extends it) · `BaseCombineOptions` (`{ after?, through?, concurrency?, budget?, allowAbsentOperands? }`) · `CombineOptions` (adds `exclude?: Segment[]`) · `MaterializeOptions` (adds, for the `*Into` verbs, which publish, `audit?`, `allowEmpty?`, `guard?` and `keep?`; the streaming verbs write nothing and emit nothing) · `AndNotIntoOptions` (`MaterializeOptions` without `exclude`)

---

## Advanced / driver-author surface

You **do not** import these to _use_ CloudBitmaps — only to **write a driver or a flavor**, or to build tooling
against the on-disk format. Each section says where its names import from. Most come from the
`@cloudbitmaps/roaring` barrel. The exceptions are the names that live only on `@cloudbitmaps/core`, listed in the
[flavor-author kit](#flavor-author-kit-cloudbitmapscore) and [the standalone forms of the store's
methods](#the-standalone-forms-of-the-stores-methods); the
[driver kit](#driver-kit--what-you-need-to-implement-a-driver), which is its own subpath,
`@cloudbitmaps/core/driver-kit`; and the cloud drivers' option types, which come from `@cloudbitmaps/s3`, `/gcs`
and `/azure-blob`.

### `.crbm` on-disk format

**`CRBM` stands for Chunked Remote BitMap** — chunked because 16-bit chunks are the data model, remote because
every structural choice exists for storage that is far away and billed per request (range-GET a single chunk,
`count()` straight from the footer index without reading payloads, a speculative tail read that collapses `open()`
to one GET), and bitmap because that is what a chunk holds.

The name is deliberately **not** tied to a codec. `.crbm` is the container for any flavor — the footer index, the
CRC32C checksums, the AES-GCM framing and the generation model are all codec-independent, and only the chunk
payload bytes would differ. Roaring is the one codec that ships.

**Format version.** Every object is format **1.0**: the preamble, the chunk payloads, the index and the fixed
104-byte footer. A reader refuses an unknown major version, and refuses an object whose footer sets a flag bit it does
not know. A generation written with metadata carries one **extension block** between the last payload and the index,
and its footer sets the `FLAG_EXTENSION` bit (`1 << 3`); with no metadata the writer emits the same bytes as before the
block existed, the flag clear. A reader before 0.12 does not know the bit, so it refuses an object with metadata.

- **Where the block is.** It is found from the index's offset alone: its last 12 bytes, just before the index, are
  its sections' length (u32), a CRC32C of the sections and that length (u32), and the magic `CRBX`. Payloads end
  where the block starts.
- **Sections.** At most 4 KiB in all, each a type (u8), a length (u32) and that many bytes, in strictly ascending
  type order; type 0 is not a type. A reader skips a type it does not know, so a section must be safe to ignore: a
  meaning every reader has to understand needs a footer flag bit of its own, which an older reader refuses.
- **Type 1, the metadata.** Its canonical JSON, at most 1 KiB: RFC 8785 (the JSON Canonicalization Scheme) for one
  flat object of string and finite-number values. Keys are sorted by UTF-16 code unit, strings are escaped as
  `JSON.stringify` escapes them, numbers are written as ECMAScript's `Number.prototype.toString` writes them (`-0` is
  `0`, `1e21` is `1e+21`, `5e-7` stays `5e-7`), and there is no whitespace. A language's ordinary JSON writer differs
  in places (Python writes `1e-07`; Go and Rust sort keys by code point), so
  [`tests/golden/metadata-canonical.json`](../../tests/golden/metadata-canonical.json) holds vectors to check a port
  against.
- **Encrypted.** The section is sealed like the index (AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, under
  `aadFor(ref, generation, 'metadata')`), so its content cannot be read or altered without the key; its length, like
  the index's, stays visible. That the block is there at all is not authenticated: the flag, the trailer and the
  section types are covered by CRCs, which take no key, so whoever can write the object can remove the block, and the
  object then reads as one with no metadata.
- **What a reader refuses**, with `IntegrityError`: a flag with no valid block; a block whose trailer, CRC, size or
  sections do not hold;
  metadata that breaks a rule or is not exactly its canonical form; a payload that runs into the block; and any
  object that is not encrypted when it is opened with a key. It reads the block with the index, from the tail or in
  the same range read, and makes one more read only when the tail ends inside the block.

| Symbol | What it does |
|---|---|
| `CrbmReader` / `CrbmReaderOptions` | read it (`tailBytes`, `maxPayloadBytes`, `maxIndexBytes`, `crypto`, and `lineage`, an opaque marker of the incarnation of the name the object belongs to, which the reader carries and never interprets, so a caller can tell one generation of a segment from the same generation number of a segment deleted and re-created); `reader.fingerprint` names the object by its size and footer checksum, and `CrbmReader.sameObject(blob, fingerprint)` says whether the object behind `blob` is that one, from one footer's worth with no key: another size is another object, and a footer that fails its own checks throws. A fingerprint is opaque: compare two for equality, and do not parse one. `reader.metadata` is the generation's metadata (`GenerationMetadata`, frozen), checked and, on an encrypted object, decrypted at open; `undefined` on a generation with none, every 1.0 object included. |
| `CrbmStorageChunkSource` / `CrbmStorageChunkSourceOptions` | the `.crbm` storage reader over an `IStorageDriver` (the store builds this from a raw driver for you); options add `registry`, `keystore`, `requireEncryption`, `clock`, `currentGenTtlMs`, `maxOpenSegments`, `maxOpenIndexBytes` |
| `BufferReader` · `BlobSink` · `BlobReader` | the in-memory `BlobReader` you hand to `CrbmReader.open`, plus the two interfaces themselves: `BlobSink` takes bytes (one method, `write`), `BlobReader` serves them (`getRange`, `getTail`) |

### Bitmap-codec seam

The engine is **codec-agnostic** behind these; roaring is the one codec that ships. You only touch them to plug in
a codec of your own — the `CloudRoaring` facade injects the roaring codec for you.

| Symbol | What it does |
|---|---|
| `CodecInterface` | the factory the engine builds bitmaps through (`empty` / `fromValues` / `safeDeserialize`). `safeDeserialize(bytes, maxBytes, { whole? })`: with `whole: true`, which a load passes for a caller's bytes, bytes after the bitmap's end are refused too; a stored chunk is read without it. A codec must honour `whole`: core cannot read the format and relies on the codec for that refusal, so a codec that ignores it loads two concatenated bitmaps as the first |
| `CodecBitmap` | the value type a codec produces — a `u32` set with set algebra + portable (de)serialization. Optional `maximum?()` lets the engine range-check a chunk payload in O(1); a codec that can't answer cheaply omits it and the check is skipped. Optional `optimize?()` re-encodes for storage, and must be canonical: afterwards `serialize()` depends on membership alone. Optional `encodeChunks?()` is flavor-author surface: the set as `EncodedChunk`s, ascending, each exactly the bytes `fromValues` of that chunk's low 16 bits, `optimize()` and `serialize()` give, which is how a bitmap load writes without touching an id. A codec without it loads a bitmap through its ids |
| `EncodedChunk` | `{ chunkKey, payload, cardinality }`: one chunk as a `.crbm` generation stores it, what `encodeChunks?()` yields |

### Flavor-author kit (`@cloudbitmaps/core`)

These are the pieces a **flavor** package (codec + facade) or a **driver** author composes — `@cloudbitmaps/core`'s
actual audience. An application never calls them: it uses the flavor's `CloudRoaring` facade, which wires all of
this for you. They import from **`@cloudbitmaps/core`** and are not on `@cloudbitmaps/roaring`.

| Symbol | What it does |
|---|---|
| `SegmentEngine` / `EngineDeps` | the codec-agnostic **read** engine over a `StorageChunkSource` (`has` / `count` / `stat` / `iterate` / `intersect` / `union` / `andNot`, plus `supportsStorageSize` / `segmentSize` for grounded cost) + its injected deps (**`codec` is required** — core has no default; `cache?`, `maxBitmapBytes?`, `clock?`, `metrics?`, `budget?`). Read-only by design — there are no `*Into` verbs here |
| `EngineCombineOptions` | the engine-level `{ after?, through?, concurrency?, budget?, exclude?: SegmentRef[], allowAbsentOperands? }` (the facade's `CombineOptions` maps `Segment` handles down to these refs) |
| `BoundedLru` | the count+byte-bounded LRU the facade uses for the chunk cache and the `.crbm` reader cache |
| `safeMetrics` / `NOOP_METRICS` | wrap a user `IMetricsSink` so a throwing sink can never break the data path, and the no-op sink that stands in when none is given |
| `segmentKey` | the canonical key string of a `SegmentRef`, namespace included — the cache and pin key the engine and the facade use. `seg.key()` is the handle's opaque form |
| `isStorageBackend` | test the brand a backend carries |
| `PinnedStorageChunkSource` | a `StorageChunkSource` view holding one segment at one generation and passing every other segment through to the live source — what `seg.pin()` is built on (`PinnedAt` and `PinnedObject`, its types, are on `@cloudbitmaps/roaring`) |
| `DEFAULT_BUDGET` | `{ maxRequests: 1_000_000 }`, the per-op request ceiling a store applies when `budget` is omitted |
| `withRetry` · `RetryDeps` | the retry primitive (4 attempts, 50 ms base, ×2, 2 s cap, full jitter by default, from `DEFAULT_RETRY_POLICY`, which is on `@cloudbitmaps/roaring`). It retries whatever `isTransientError` accepts unless you pass `RetryDeps.isRetryable` |
| `RetryingStorageChunkSource` · `RetryingOptions` | the read-source wrapper the store builds around the source it reads segment data through, a `StorageChunkSource` passed as `storage` included, so each of those reads retries transient faults. Do not wrap a source you then hand to the store, which multiplies each read's attempts; wrap one only for a source you read outside a store, such as under your own `SegmentEngine` |
| `splitId` | an id → its `(chunkKey, remainder)` bit routing, and a range check on the way: it throws `ValidationError` for anything that is not a u32, which is how a bad id fails fast |
| `mapWithConcurrency` | the bounded, order-preserving fan-out primitive (admin scans, the Storage sweep) |
| `resolveBudget` / `resolvePerOpBudget` / `checkBudget` | the denial-of-wallet budget plumbing: normalize a `BudgetOption` into a `Budget`, pick the one that applies to a given op, and enforce it against a **computed** unit count. `collectWithinBudget` is the streaming form; `checkBudget` is the O(1) one, and its `>` threshold is what makes a budget of N admit exactly N units |
| `collectWithinBudget` | drain an async iterable into an array, refusing **as soon as** the budget is exceeded rather than after — so resident memory is `O(budget)`, not `O(source)` |

### The standalone forms of the store's methods

On **`@cloudbitmaps/core`** only, for a flavor or driver author: each is the function a store method runs over the
store's own drivers, so an application calls the store method. Where one has a wired form it says which. The three
that build bitmaps (`loadSegment`, `eraseIdFromSegment` and `runExport`'s `'roaring'` format) take a `codec` and throw
`ValidationError` without one, because core has no default. The types they produce are on `@cloudbitmaps/roaring`,
because the store methods return them; the `*Deps` types (`LoadDeps`, `GenerationListDeps`, `RetentionDeps`,
`DropDeps`, `EraseIdDeps`) and `EraseIdResult` are on core too. Erasing is the store's `eraseSubject`, which runs
`eraseIdFromSegment` over every registered segment.

| Call | Does |
|---|---|
| `listGenerations(ref, { storage, registry, keystore? })` → `Promise<GenerationEntry[]>` | every generation still in the bucket, ascending, with the current one marked, whether or not the segment has a registry row. One registry read and one listing; it does not open the objects. The current entry carries the row's `cardinality` and `metadata`, a sealed summary opened with `keystore`. `store.generations` is the wired form |
| `segmentExists(ref, registry)` → `Promise<boolean>` | the unwired form of `store.exists` — one registry `get`; true only when a live, non-`destroyed` row has a `currentGen` |
| `listSegments(registry, { namespace? })` → `AsyncIterable<SegmentInfo>` | the unwired form of `store.segments`; validates `namespace`, and excludes internal bookkeeping rows on an unscoped scan |
| `rollbackSegment(ref, toGeneration, { storage, registry, keystore? }, { audit?, allowForward? })` → `Promise<RollbackResult>` | the unwired form of `store.rollback`, taking the drivers instead of a store. `keystore` lets the rollback open an encrypted target to seal its count and metadata into the row; without it, or when it cannot open the key, the segment still rolls back and the row has no summary. The target is verified after the swap, and the pointer is put back if it vanished or, for an `allowForward` target, was replaced ([how a rollback can fail half-way](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic)) |
| `loadSegment(ref, input, { storage, registry, codec?, keystore?, requireEncryption?, clock?, rng?, readRetry?, collectByListing? }, { allowEmpty?, guard?, keep?, metadata?, audit? })` → `Promise<LoadResult>` | the unwired form of `store.load`: replaces a segment's contents with `input`, the same `LoadInput` (`{ serialized }` and `{ bitmap }` decoded by the `codec`, and written through its `encodeChunks?()`), as one immutable generation. It refuses a byte array passed as ids, as `store.load` does; a bare `RoaringBitmap32` passed as ids is ids here, since core names no codec's class. It takes the drivers, plus a `codec`, `keystore` and `clock`, instead of a store. `readRetry` (a `RetryDeps` plus an optional `policy`) retries the guard's read of the current generation; without it that read is made once. The registry write is not governed by `readRetry`: when it gets no answer, the publish reads the row back and, if it is unchanged, sends a fresh compare-and-swap, at most three times, each after a wait on `clock`, a random time under 500 ms, then 1 s, then 2 s that `rng` spreads (the bound itself when neither `rng` nor `readRetry` has a source; with no `clock` it throws the registry's `TransientError` at once). A write-once object is sent again after a throttle by the S3 and GCS drivers. `collectByListing: true` makes the load collect by listing whatever `keep` is, where it would otherwise delete by name the one generation its publish pushed out of the window with a `keep` of 0 or 1; the `*Into` verbs set it, since their `keep` clears every generation below the new one beyond it. Options, results and refusal reasons are `store.load`'s ([loading](loading.md)) |
| `eraseIdFromSegment(ref, id, { storage, registry, codec?, keystore?, requireEncryption?, clock?, rng?, maxBitmapBytes?, readRetry? }, { audit? })` → `Promise<EraseIdResult>` | remove **one id** from one segment by rewriting its current generation without it: the step `store.eraseSubject` runs over every registered segment. `erased: true` means no generation holds the id; otherwise `reason` says why ([the result of erasing one segment](erasure.md#how-it-stays-correct)). `readRetry`, shaped as `loadSegment`'s, retries the reads the rewrite makes; without it each is made once. The rewrite's registry write is settled as a load's is, and `clock` and `rng` are what it waits on; the deletes are not retried |
| `dropSegment(ref, { registry, storage }, { confirmSegment, dryRun?, audit? })` → `Promise<DropResult>` | **dispose of a segment** — tombstone, then delete every Storage generation. Works on cleartext; also crypto-shreds an encrypted one. `store.dropSegment` is the wired form |
| `runConsistencyCheck({ storage, registry, keystore? }, { namespace?, concurrency?, maxScanSegments?, summaries? })` → `Promise<ConsistencyReport>` | the free function behind `store.checkConsistency` — run it over your own drivers, or over a backend's `storage` and `registry`. `maxScanSegments` (default 250,000) is how many registry rows one scan may hold resident; past it the call throws `BudgetExceededError` rather than report a partial scan |
| `setSegmentRetention(ref, { registry }, { expiresAt })` → `Promise<SetRetentionResult>` | the free function behind `store.setRetention` — for a scheduler/CLI that holds only a registry driver. `getSegmentRetention(ref, { registry })` / `clearSegmentRetention(ref, { registry })` are its read/cancel siblings |
| `retireExpired({ registry, storage }, { now, … })` → `Promise<RetireExpiredResult>` | the free function behind `store.retireExpired` — for a scheduled worker that wires its own drivers. `now` is explicit here (core takes its time from the caller) |
| `runExport(reader, registry, sink, { format?, namespace?, ndjsonBatchBytes?, codec? })` → `Promise<ExportManifest>` | the free function behind `store.exportSegments`; `codec` is required for the `'roaring'` format, and the store binds it |
| `estimateCost({ segments, workload?, pricing? })` → `CostReport` | the free function behind the static `CloudRoaring.estimateCost` |
| `groundedReport({ storageBytes, grounded?, workload?, pricing?, extraNotes? })` → `CostReport` | build a report from a **measured** byte total (backs `segment.costReport()`) |

### Driver kit — what you need to *implement* a driver

Imported from **`@cloudbitmaps/core/driver-kit`**, a subpath whose whole purpose is this: the declared contract
a storage-driver package builds against. `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob`
are built from nothing else, and a third-party driver has the same surface available. It is versioned public
API — an addition is something we support, a removal breaks every driver package including ours.

Application code never needs this. It is listed because it is public, and because an unimported surface is
exactly the kind that rots undocumented.

**The method signatures are the `.d.ts`, not this page.** `IStorageDriver` and `IRegistryDriver` are
TypeScript interfaces and their shipped declarations are the specification — implement them and the compiler
tells you what is missing. What this page adds is everything the types cannot say.

<details>
<summary><strong>A minimal storage backend, end to end</strong></summary>

The one non-obvious part is the **brand**. A store accepts a backend by brand, never by `instanceof`, so a
backend built in your package is recognised in ours. It takes two lines that have to agree: a **type-only
`declare` field** so the class satisfies `StorageBackend`, and a **runtime stamp** in the constructor, which
`brandAsBackend` applies non-enumerably so a spread cannot carry it off.

```ts
import {
  STORAGE_BACKEND,
  brandAsBackend,
  type IRegistryDriver,
  type IStorageDriver,
  type StorageBackend,
} from '@cloudbitmaps/core/driver-kit';

export class MyStorage implements StorageBackend {
  declare readonly [STORAGE_BACKEND]: true; // type-only: no value is emitted here
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(options: MyStorageOptions) {
    this.storage = new MyStorageDriver(options);
    this.registry = new MyRegistryDriver(options);
    brandAsBackend(this); // the runtime half — without it, `new CloudRoaring({ storage: this })` is refused
  }
}
```

**How to depend on core.** The drivers in this repository depend on it as a plain dependency, on a caret range of
the version they release with — the range `@cloudbitmaps/roaring` declares too, because all five packages release
in lockstep, so a consumer's tree resolves one copy. A driver released on its own schedule has no such guarantee:
a plain range of its own can resolve to a second copy beside the consumer's, which is the case described under
[Errors](#errors-typed--you-catch-these) where `instanceof` stops holding. A peer dependency, with a dev dependency
to build against, makes the consumer's copy the only one:

```jsonc
{
  "peerDependencies": { "@cloudbitmaps/core": "^<the minor you build against>" },
  "devDependencies": { "@cloudbitmaps/core": "^<the same>" }
}
```

**On correctness, be aware of what you cannot yet run.** The conformance suite the in-repo drivers are held
to (`packages/roaring/src/testing/conformance.ts`) is *not* exported as a public subpath, so a third-party
driver cannot execute it today. Until it is, the load-bearing behaviours to reproduce by hand are: a
conditional create that **refuses** rather than overwrites (hard invariant 2 — this is the one that silently
loses data if you get it wrong), ranged reads that return exactly the requested bytes, a compare-and-swap on
the pointer row that reports a lost race rather than clobbering, a delete that removes a row only while it is
the version the delete read, if you report `conditionalDelete: true`, and the four `currentGen: null` obligations
listed below.

</details>

**Pairing halves of your own.** An application gets both halves from one backend class, which builds them from one
bucket and one prefix so they cannot disagree. A driver author who wants a backend of halves of their own — a
backend's `.storage` wrapped for auditing, metrics or tenant scoping, or paired with a registry in a database you
already run — brands a plain object with the ports:

```ts
import { brandAsBackend } from '@cloudbitmaps/core/driver-kit';

const backend = brandAsBackend({ storage: auditing(inner.storage), registry: inner.registry });
const store = new CloudRoaring({ storage: backend });
```

`brandAsBackend` cannot check that the two halves agree: `IStorageDriver` and `IRegistryDriver` expose no location, so
nothing can compare one. Branding them is you taking that on.

| Symbol | What it does |
|---|---|
| `IStorageDriver` · `IRegistryDriver` | the two ports a driver implements — the object tier and the pointer row. A registry driver that does NOT extend `ObjectStoreRegistry` also needs `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord` and `RegistryPatch` to write its method signatures; those come from `@cloudbitmaps/core`'s main entry |
| `StorageBackend` · `StorageCaps` · `SegmentRef` · `GenKey` | the backend pair, a driver's declared capabilities, and the two key shapes |
| `brandAsBackend` · `STORAGE_BACKEND` | stamp the cross-package brand on a backend, and the symbol a backend class declares it with. A store accepts a backend by brand, never by `instanceof`, so a backend built in one package is recognised in another. It checks that `storage` has a `putImmutable` and `registry` a `compareAndSwap`, throwing `ValidationError` otherwise, or when the object is frozen or non-extensible, and returns the object it was given. It takes a class (`brandAsBackend(this)` in the constructor) or a plain `{ storage, registry }` object, which is how halves of your own are paired — see below |
| `Token` · `segmentKey` | **from `@cloudbitmaps/core`, not from `driver-kit`.** The opaque compare-and-swap token (unique per write, compared by equality only, ABA-safe across delete→recreate) and the canonical segment key-string helper. A driver package may import core's main entry for these |
| `ObjectStoreRegistry` | compare-and-swap over a plain object store. Every cloud registry driver is a thin adapter over this, which is why all three pass one conformance suite — the OCC semantics live here, not in the drivers |
| `ObjectRegistryStore` · `ObjectRow` | the minimal store a driver hands `ObjectStoreRegistry`, and the row it persists: `read`, a conditional `write` and `listKeys`, and optionally `delete(key, { version })`, a delete the backend applies only while the object is at exactly that version, with `conditionalDelete: true` to say the backend can be relied on to. With both, `ObjectStoreRegistry` removes a row born with an incarnation id rather than tombstoning it, and reports `conditionalDelete: true` in its `capabilities()` |
| `ObjectVersionRaced` · `MAX_ROW_BYTES` | the sentinel a store that reads a row in two calls throws when a write lands between them, which `ObjectStoreRegistry` answers by reading again (no shipped store raises it: each reads a row in one request), and the hard cap on a serialized row |
| `normalizeObjectPrefix` · `prefixPart` | prefix normalization, so `cr`, `cr/` and `/cr/` address the same place |
| `encodeNameForKey` · `namespaceKeyPart` | how a segment name and namespace become an object key |
| `encodeNameForPath` | percent-encode a name for use as a **filesystem path component**. Escapes everything `encodeNameForKey` does plus `:` (an NTFS alternate-data-stream separator on Windows), plus three hazards that are properties of the whole component: `.`/`..` traversal, Windows reserved device names (`CON`, `NUL`, `COM1`…, reserved with *or without* an extension), and a trailing dot or space, which Windows silently strips so two names would collide on one path. Use it if you write your own filesystem `ExportSink`, so your dump matches the drivers' layout. **If you decode these names back, require the encoding to round-trip** (`encodeNameForPath(decoded) === raw`) rather than trusting a decode — percent-decoding accepts spellings the encoder never emits (a lowercase escape, say), and without that check a planted entry can alias a real one |
| `namespacePathPart` | the physical namespace component of a **path**: the caller's namespace **encoded**, or the `_default` sentinel emitted **literally**. That asymmetry is load-bearing — encoding the sentinel too would send an absent namespace to `%5Fdefault`, exactly where a caller who names their namespace `_default` already goes, and the two would read each other's data. Use it rather than encoding `ns ?? '_default'` yourself. (`namespaceKeyPart` is the object-key twin) |
| `validateSegmentRef` | the name rules a driver applies to a ref, and nothing more: it takes a namespace in the reserved `cbm.due.` prefix, where the library's own due-index rows live. The refusal of that prefix is in the calls that take an application's ref or `namespace`, not here |
| `BlobSink` | the sink `putImmutable` hands the writer: the object's bytes arrive through its one method, `write`, and the driver commits them once the writer returns |
| the typed errors + predicates | `ValidationError` · `WriteConflictError` · `NotFoundError` · `IntegrityError` · `TransientError`, and `isValidationError` · `isWriteConflictError` · `isNotFoundError`. Throw the classes; classify with the predicates, which hold across package copies where `instanceof` does not |

**What a storage driver must do.** Callers rely on each of these, and the conformance suite holds every shipped
driver to them (`IStorageDriver`'s doc comment states the same list):

- `putImmutable` is write-once and reports a collision as `WriteConflictError`. `load` reads that error as a lost
  race for the generation number (`superseded`).
- A missing object makes `getRange` and `getTail` throw `NotFoundError`, never an empty or short result. Heal-forward,
  the erasure's holder probe and verify, and a pin's replaced-object check branch on it. A zero-length `getRange` may answer empty without
  reaching the backend, so it proves neither that the object exists nor that the offset is inside it.
- An out-of-range read, meaning a range past the end or a negative or non-integer offset or length, throws
  `ValidationError`, never a clamped or short read. `getTail` reports the object's true total size.
- `delete` is idempotent: deleting an absent key is a no-op.
- `list` is strongly consistent, read-after-delete: once `delete` resolves, the generation is no longer listed. The
  erasure's re-check for a generation still holding the id, `generationsRemaining`, the retention sweep's check that a
  tombstone's storage is gone, and rollback's post-move check prove a deletion or a presence by listing.
- Never replay a conditional write without telling the replay apart. A write that lands and loses its response, sent
  again, meets its own object and would report a collision. Send each write once, with the client's retry off for
  that request, or, when the precondition fails, read back an id you stored with the write and treat a match as
  success. The one write you may send again on purpose is a generation's object, after a response that says the
  service is refusing requests too fast (a throttle), and only if it carries such an id: a throttle is not a promise
  that the request was not applied. A lost response or a timeout is never grounds to send it again.
- Raise a transient fault as `TransientError`.

**What a registry driver must do.** `create` and `compareAndSwap` are atomic conditional writes that throw
`WriteConflictError` and change nothing when they lose; a token is not reused, `delete` then `create` included, but for a collision of probability 2^-128 per pair of incarnations;
reads are strongly consistent; `list` yields every existing row, `destroyed` tombstones included, with every field;
the replay rule above applies to `create` and `compareAndSwap`, which a driver never sends again on a throttle. The
store's publish reads the row after one that ended without an answer and recognises its own landed write by its
effect; when the row is unchanged it sends a **fresh** compare-and-swap from the version it read (at most three, after a
wait on the injected clock), so both writes must fence on that version, for real, and at most one of the two lands; a
transient fault is a `TransientError`; and
`delete` is idempotent, with one addition.

**`RegCaps.conditionalDelete` says what `delete` leaves behind.** `true`: a delete removes a row whose token carries an
incarnation id from the backend for good, and only while the row is still the exact version it read (by a precondition
the backend applies, or a lock every writer of the backend takes), so a full `list` no longer reads it. A row a
release before 0.12 wrote has a bare decimal token and is still tombstoned: a process on that release, re-creating
the name over nothing, would issue its counters again from 0. That protection ends once a 0.12 process re-creates the
name over the legacy tombstone, and matters only for a 0.11 process that outlived the upgrade's stop step. `false` or
absent: every delete leaves a tombstone. A
shipped registry reports it: the in-memory and local-filesystem ones `true`, the cloud ones as their backend's
`conditionalDelete` option says. It is optional and additive: a driver of your own that omits it is read as `false`.
The in-repo conformance suite's `registryDeleteConformance(label, make)` holds every shipped driver to what it declares;
`make` returns the driver and a `stored(ref)` probe of its backend, and optionally `plantRow(ref, text)`, which puts a
row as another writer left it.

**`delete(ref, expected?)` takes an optional expected token.** Without it, deleting an absent row is a no-op, as
before. With it, the delete is fenced like a compare-and-swap: it lands only while the row still carries that token,
and otherwise (another token, or no live row) throws `WriteConflictError` and leaves the row. The library passes the
token of the row it read when it decided to delete, so a delayed or replayed delete, or one racing a re-create,
cannot tombstone a row created after the decision: the retention sweep's tombstone purge does. A driver that extends
`ObjectStoreRegistry` gets this for free. **For a third-party registry driver this is an additive port change:** the
parameter is optional, so a driver that ignores it still compiles and keeps the unfenced behaviour, and callers
that do not pass it see no change. Implement it to make the library's deletes safe against a concurrent re-create;
the registry conformance suite's `delete` cases are the test.

**Registry rows are schema 2, and the record has an optional `summary`.** A shipped registry stamps every row it
writes `schemaVersion: 2` and reads rows stamped 1 or 2; a row stamped 1 may hold only the fields schema 1 had.
`summary` is the row's cached description of its current generation — its id count, and the metadata it was loaded
with — in the clear on a cleartext segment (`{ generation, cardinality, metadata? }`) or sealed under the segment's
data key on an encrypted one (`{ generation, sealed }`). It names the generation it describes, and it follows the
pointer and the keys: a patch that moves `currentGen`, or changes `wrappedDeks` so the summary's shape no longer
agrees, without mentioning `summary` drops the old one; and a patch or create that gives one must name the
`currentGen` the row will have and agree with its keys (sealed with wrapped keys, clear without), else
`ValidationError`. The registry stores a frozen copy of the summary it was called with, so changing your object after
the call changes nothing. Each shape is checked at both boundaries (`ValidationError` on a write, `IntegrityError`
naming the row on a read). A stored row whose summary disagrees with its keys, or names another generation than
`currentGen`, is still read, so one such row cannot stop every listing: whatever reads the summary must not use it
then. Nothing in this release writes one yet, and a row without one is correct. **The registry conformance suite
now requires a driver to persist it**: to round-trip it through `create`, `get`, `list` and `compareAndSwap`, keep it
across a patch that does not mention it, store it as it was when the write was called, and refuse a malformed one with
`ValidationError` on the write.

**A shipped registry's token is `<incarnation>.<counter>.<write>`.** The incarnation is 128 bits as 32 lowercase hex
digits, drawn when a row is created, so a re-created name never meets an earlier incarnation's token, even once the
earlier row is gone entirely. The counter advances on every write and carries on across a tombstone. The write part
is 64 bits as 16 lowercase hex digits, drawn for every write, so a row restored from a backup to an older counter is
never given a token it had before. Both random parts make it hold by chance rather than by construction: two
incarnations of one name draw the same incarnation id with probability 2^-128 for any pair (about n² / 2^129 among n of
them), and two writes at one counter, after a restore, the same write part with probability 2^-64. A row first written by a release before 0.12 keeps its bare decimal counter (`"7"`) until its first
write, which gives it `<counter>.<write>`; only a create starts an incarnation. Tokens stay opaque to the library,
which compares them only for equality. `ObjectStoreRegistry`'s constructor takes an optional fourth argument, an
`Entropy` source (`(length) => Uint8Array`), which defaults to the platform's Web Crypto: inject one only to make a
test replayable, never a seeded one in production, which hands every process the same ids. On a runtime with no Web
Crypto a shipped registry still reads, reports `canWrite: false` in its `capabilities()`, and refuses every write
that issues a token (a create, a compare-and-swap, a tombstone) with `UnsupportedError`; a delete that removes a row
issues none, and lands; a load and an erasure rewrite check `canWrite` before their first request, so they refuse
before writing an object. A registry of your own may report `canWrite: false` the same way.

**`currentGen` is nullable, and `null` is a value — not a missing field.** A `RegistryRecord` with
`currentGen: null` says *this segment exists and has no Storage generation yet*: the row `setRetention` mints when a
policy is recorded **before the first load**, so fleet-wide operations — `checkConsistency`, `eraseNamespace`,
the retention sweep — can see the segment at all. Resolution maps it onto the same path a segment with no row
takes (every read answers empty), and the first publish advances the pointer onto it. An `IRegistryDriver` must
therefore:

- round-trip `null` through `create`, `compareAndSwap`, `get` **and** `list` — serialization is where it gets
  silently dropped (`JSON.stringify` keeps `null` but omits `undefined`) or coerced to `0`, which is the
  forbidden `missing-storage-generation` state;
- apply a patch that sets `currentGen: null`, and leave the stored value alone when a patch omits the field. The
  trap is merging with `patch.currentGen ?? previous`, which treats a deliberate `null` as absent and silently
  keeps pointing at the old generation — use an own-property check (`'currentGen' in patch`);
- keep `status: 'active'` meaningful for such a row: a null pointer is a **live** segment, not a tombstone;
- yield `destroyed` tombstones from `list()` — the sweep can only purge a row it can see.

**How the store treats your driver's errors.** Throw `TransientError` for your backend's retryable faults: the
store's read retry rides them out, and a write's caller can tell them from a deterministic failure. A registry's `get`
is held to the same rule. A pointer refresh rides out only a `TransientError`, so a custom registry that throws a
plain `Error` for an outage makes the read that meets it fail. The store wraps the source it reads through, a
`StorageChunkSource` you pass as `storage` included, so do not wrap one before handing it over: that multiplies each
read's attempts. A call of your own is yours to retry: loop over it, and back off before the next attempt when
`isTransientError(err)` is true.

### Resilience (the store wires this by default)

| Symbol | What it does |
|---|---|
| `DEFAULT_RETRY_POLICY` · `RetryPolicy` | the defaults (4 attempts, 50 ms base, ×2, 2 s cap, full jitter) the store's `retry` option overrides a field at a time. The retry primitive, `withRetry`, and the read-source wrapper the store builds, `RetryingStorageChunkSource`, are on `@cloudbitmaps/core`: see the [flavor-author kit](#flavor-author-kit-cloudbitmapscore) |

No write goes through the read retry. A conditional put or compare-and-swap that lands and then loses its response
would, replayed blindly, find its own write already there and report it as a conflict, so a fault the drivers and the
publish do not settle reaches the caller as a `TransientError`. So does a fault on the store's direct registry and
bucket reads (`exists`, `segments`, `generations`, `getRetention`, and the registry scan `subjectReport`,
`exportSegments` and `checkConsistency` start from). A fault on one segment inside `checkConsistency` is recorded in
`report.errored`, not thrown. To retry a write that reached you, re-run the call.
A load settles one outcome itself: when its registry write ends without an answer, it reads the row, reports a write
that landed as `published: true`, sends a fresh compare-and-swap (at most three) when the row is unchanged, and
otherwise throws the registry's `TransientError` and deletes nothing.
[Reliability](production.md#reliability-retries-backoff--timeouts) says how, and how to tell whether an attempt landed.

### Crypto seams

| Symbol | What it does |
|---|---|
| `NodeAead` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `aadFor` | the AES-256-GCM implementation + the crypto interfaces the `.crbm` reader/writer use. An **`Aead` implementation is handed** the associated data and never builds it. A **`CrbmCrypto` caller does** — it is the `{ aead, aadFor }` pair that `CrbmReader.open` takes, so tooling reading an *encrypted* archive builds one with `aadFor(ref, generation, scope)`, which binds each chunk, the index and the metadata section (scope `'metadata'`) to `(segment, generation)` |
| `EraseDeps` | `{ registry }` — deps for the free-function crypto-shred (`destroySegment` / `eraseNamespace`) |

### Low-level ports & capabilities (driver-author typing)

`StorageCaps` · `RegCaps` · `ChunkRef` · `GenKey` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` ·
`RegistryStatus` (`'active' | 'destroyed'`) · `GovernanceMeta` · `SegmentSize` · `RegistrySummary`
(`ClearRegistrySummary` `{ generation, cardinality, metadata? }` or `SealedRegistrySummary` `{ generation, sealed }`,
the row's cached description of its current generation) · `GenerationMetadata` (string keys, string or finite-number
values, at most 1 KiB as canonical JSON) · `GenerationSummary` (`{ generation, cardinality, metadata? }`, what a
`StorageChunkSource`'s optional `summary()` answers for a segment's current generation)

---

## Errors (typed — you `catch` these)

Every error the library's API throws extends `CloudRoaringError`, and each one tells you which of three things to
do: **fix your call**, **retry**, or **investigate the data**. The one exception is the `export-segments` CLI, which
reports a missing or invalid environment variable with a plain `Error` and exits non-zero.

| Error | Fires when | What to do | Retry? |
|---|---|---|---|
| `ValidationError` | your input is malformed — a bad id, an illegal segment name, an out-of-range option. Raised **before any storage call** | fix the call | no — deterministic |
| `WriteConflictError` | a write-once generation number was claimed twice, a registry compare-and-swap lost every retry, or generation collection found the segment re-created underneath it (the name now belongs to a different segment) | re-read the pointer and re-derive: re-run the operation (a load takes a fresh generation number) | no — but the *operation* is safe to re-run |
| `IntegrityError` | bytes from storage are corrupt, oversized, fail a checksum, or fail AEAD authentication; or a registry row is not one the library wrote — not valid JSON, an envelope or record field it does not declare, no `schemaVersion`, a `status` other than `active` or `destroyed` | **investigate** — this says "this data is corrupt", not "try again". It names the chunk, or the row's key. Re-loading the segment from source repairs a generation. A bad row fails its own `get` **and every `list()` that reaches it** — its namespace's, and every unscoped one — so it stops `segments()`, the sweeps, the subject scans and `checkConsistency` across the fleet until the object is restored to a valid row or deleted | no |
| `NotFoundError` | an object or row the caller named does not exist. Every backend, the in-memory one included, throws it for a generation object that is not there; a registry `get` of a missing row returns `null` instead | usually the library handles it internally (a swept generation heals forward). Reaching you means the pointer names an object that is *permanently* absent — a torn restore. See [disaster recovery](disaster-recovery.md) | no |
| `UnsupportedError` | (a) the bytes are well-formed but this build cannot read them — an unknown `.crbm` major version, or a registry row with a `schemaVersion` newer than this build reads; or (b) this store's wiring cannot perform the operation, e.g. a lifecycle helper on a store built without a backend | wire the store with what the operation needs, or upgrade the library | no |
| `CapabilityError` | the storage you passed cannot meet a capability the store requires — a storage without range reads (one of your own; the five backends all serve them), or a keystore or `encryption.required: true` on a store built on a bare `IStorageDriver` instead of a backend, which has no registry. Raised **fail-fast at construction**, never mid-operation | pass a backend, or a storage that supports range reads | no |
| `BudgetExceededError` | the operation would exceed its per-op denial-of-wallet budget — too many backend requests for one call. Refused **before** fanning out. Carries the projected count and the limit, never data | narrow the operation, raise `budget`, or set `budget: false`. If it fires on a normal call, something is wider than you think | no — refused by policy, not by luck |
| `KeyUnavailableError` | an encrypted segment's DEK cannot be unwrapped: the keystore holds none of the KEKs its wrappings reference — never configured, rotated away without keeping the old key, or lost | restore the KEK. **Without it the data is unreadable**, which is what crypto-shred relies on | no |
| `TransientError` | a transient fault your backend classified (from its storage or registry) — throttling, a 5xx, a connection reset. The raw SDK error is preserved in `cause`, except on a read `readTimeoutMs` cut off, which has none and says `timed out after N ms` | from a read of segment data, the retry layer already retried it, and reaching you means it kept failing. From a write, it is a fault the drivers and the publish did not settle (a throttled S3 or GCS object is sent again, and a load settles an unanswered registry write by reading the row), and from a direct registry or bucket read it was not retried: re-run the call. For a `load`, once the first attempt has settled, the re-run publishes whether or not that attempt landed; to know whether it did, check `store.generations(ref)` rather than replay the request. One thrown by a load's registry write has deleted nothing, and its object may still be published. One thrown by the collection after the publish comes after a landed publish: the load is current, and only the removal of older generations did not finish ([Resilience](#resilience-the-store-wires-this-by-default), [what a throttled load leaves behind](loading.md#when-a-write-is-throttled-or-gets-no-answer), [what throws instead](loading.md#when-a-load-is-refused)) | **yes** — the only class the retry layer retries |

Two things worth knowing:

- **The retry layer retries `TransientError` and nothing else.** Retrying a `ValidationError`, `IntegrityError`,
  `NotFoundError` or `WriteConflictError` is pointless or wrong, so it never happens.
- **`TransientError.cause` is the raw SDK error** and may carry operational metadata (endpoint host, request
  ids, `$metadata`). The library's own `message` is identifier-only and safe to log; serializing the whole error
  *chain* includes that metadata.

**Bundle-safe predicates** — `isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
`isNotFoundError` · `isIntegrityError` · `isValidationError`.

**On an ordinary install, `instanceof` holds everywhere** — across `@cloudbitmaps/roaring`, the backend
packages and `@cloudbitmaps/core` itself. Every package is published with `@cloudbitmaps/core` left
**external** rather than bundled in, so your tree has one copy of the error classes and
`core.ValidationError` and the class `@cloudbitmaps/s3` throws are the same object. Catch them
however you normally would.

Reach for the predicates where that stops being true, which is not something the library can control:

- a bundler that inlines `@cloudbitmaps/core` into two separate outputs;
- two copies of core resolved side by side in one tree, which npm and pnpm will both do;
- an error crossing a `vm` realm or an iframe.

Each predicate matches a `Symbol.for` brand plus the runtime `name`, and a `Symbol.for` key is the same
symbol in every copy and every realm, where a class object is not. So the predicates hold in all three cases,
for copies of core that carry the same brand, as every package of one release does, and `instanceof` does not.
An error posted from a `worker_threads` worker is cloned into a plain `Error` that keeps its message but neither
its class nor its brand, so neither holds there: send the error's `name` with it if the receiver must tell errors
apart. The failure is silent — a `catch` that stops matching just falls through — which
is why library code that cannot see how it will be bundled should prefer them by default. `pnpm smoke`
asserts both halves on every build: that the shared copy really is shared, and that the predicates classify
an error thrown by one package and caught in another.

---

## Complete export index

Every export, by entry point. This section is the completeness anchor the sync test checks against: each entry's
names sit under that entry's heading, and a name listed under the wrong one fails it.

`@cloudbitmaps/roaring` exports, by name, what an application uses: the store's verbs and their types, the errors,
the backends' shared types, and the constants and helpers a user calls. `@cloudbitmaps/core`'s main entry exports
all of that too, plus what only a flavor or driver author needs, so its section lists only the names the flavor
does not re-export. A driver author told elsewhere on this page to import `Token`, `RegistryRecord` or
`segmentKey` from core will find each one there.

### `@cloudbitmaps/roaring` — values

`CloudRoaring` · `Segment` · `MemoryStorage` · `LocalFsStorage` · `CrbmStorageChunkSource` ·
`destroySegment` · `eraseNamespace` · `InProcessKeystore` · `NodeAead` · `aadFor` ·
`readRetentionPolicy` · `MIN_EXPIRES_AT_MS` ·
`excludingReservedRows` · `DEFAULT_RETRY_POLICY` ·
`CrbmReader` · `BufferReader` ·
`CountingMetricsSink` · `RecordingAuditSink` ·
`AWS_US_EAST_1_ONDEMAND` · `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND` · `ONE_REDIS_HA_CLUSTER` · `CloudRoaringError` ·
`ValidationError` · `WriteConflictError` · `IntegrityError` · `NotFoundError` · `UnsupportedError` ·
`CapabilityError` · `TransientError` · `KeyUnavailableError` · `BudgetExceededError` ·
`isCloudRoaringError` · `isWriteConflictError` · `isTransientError` · `isNotFoundError` · `isIntegrityError`
· `isValidationError`

### `@cloudbitmaps/roaring` — types

`CloudRoaringOptions` · `CacheOptions` · `EncryptionOptions` · `RetryOptions` · `SeamOptions` ·
`SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` · `EraseSubjectResult` ·
`MaterializeResult` · `MaterializeRefusal` · `BaseCombineOptions` · `CombineOptions` · `MaterializeOptions`
· `AndNotIntoOptions` · `IdRange` · `LoadInput` · `PortableBitmap` · `LoadOptions` · `LoadGuard`
· `LoadResult` · `LoadRefusal` · `GenerationEntry` · `RollbackResult` · `SegmentInfo` · `SegmentStat`
· `CrbmStorageChunkSourceOptions` ·
`MemoryStorageOptions` · `LocalFsStorageOptions` · `ExportFormat` · `ExportSink` · `ExportWriter` · `ExportOptions` ·
`ExportedSegment` · `ExportFailure` · `ExportManifest` · `IStorageDriver` · `IRegistryDriver` ·
`StorageBackend` · `StorageChunkSource` · `PinnedAt` · `PinnedObject` · `SegmentRef` · `ChunkRef` · `GenKey` · `StorageCaps`
· `RegCaps` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` · `RegistryStatus` · `GovernanceMeta`
· `RegistrySummary` · `ClearRegistrySummary` · `SealedRegistrySummary` · `GenerationMetadata`
· `SegmentSize` · `IKeystore` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` ·
`InProcessKeystoreOptions` · `EraseDeps` · `DestroyResult` · `DropResult` · `RetentionPolicy` ·
`SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` · `RetireEntry` ·
`RetryPolicy` · `CrbmReaderOptions` · `BlobReader` · `BlobSink` ·
`IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `PricingProfile` · `RedisSizing` ·
`RedisNodeType` · `CostReport` · `Workload` · `SegmentSizing` · `EstimateInput` · `IAuditSink` · `AuditEvent` · `Clock` ·
`Rng` · `Budget` · `BudgetOption` · `ConsistencyReport` · `ConsistencyIssue` · `ConsistencyErrorEntry` ·
`CodecInterface` · `CodecBitmap` · `EncodedChunk` · `Token`

### `@cloudbitmaps/core` — only on core

What a flavor or driver author imports from `@cloudbitmaps/core` and an application does not get from
`@cloudbitmaps/roaring`. The [flavor-author kit](#flavor-author-kit-cloudbitmapscore) and [the standalone forms of
the store's methods](#the-standalone-forms-of-the-stores-methods) say what each is for. Every other name in
`@cloudbitmaps/core`'s main entry is in the two `@cloudbitmaps/roaring` sections above.

Values: `SegmentEngine` · `BoundedLru` · `safeMetrics` · `NOOP_METRICS` · `groundedReport` · `splitId` ·
`mapWithConcurrency` · `resolveBudget` · `resolvePerOpBudget` · `checkBudget` · `collectWithinBudget` ·
`DEFAULT_BUDGET` · `segmentKey` · `isStorageBackend` · `PinnedStorageChunkSource` · `withRetry` ·
`RetryingStorageChunkSource` · `loadSegment` · `listGenerations` · `rollbackSegment` · `segmentExists` ·
`listSegments` · `eraseIdFromSegment` · `dropSegment` · `runConsistencyCheck` · `runExport` ·
`setSegmentRetention` · `getSegmentRetention` · `clearSegmentRetention` · `retireExpired` · `estimateCost`

Types: `EngineDeps` · `EngineCombineOptions` · `RetryDeps` · `RetryingOptions` · `LoadDeps` ·
`GenerationListDeps` · `GenerationSummary` · `EraseIdDeps` · `EraseIdResult` · `RetentionDeps` · `DropDeps` · `Entropy`

### `@cloudbitmaps/core/driver-kit`

The contract a storage-driver package builds against — see
[Driver kit](#driver-kit--what-you-need-to-implement-a-driver) for what each one is for. Application code does
not import these.

Ports and the backend brand: `IStorageDriver` · `IRegistryDriver` · `StorageBackend` · `StorageCaps` ·
`SegmentRef` · `GenKey` · `brandAsBackend` · `STORAGE_BACKEND`

Object-store registry: `ObjectStoreRegistry` · `ObjectRegistryStore` · `ObjectRow` · `ObjectVersionRaced` ·
`MAX_ROW_BYTES`

Keys, paths and prefixes: `normalizeObjectPrefix` · `prefixPart` · `encodeNameForKey` · `namespaceKeyPart` ·
`encodeNameForPath` · `namespacePathPart`

Boundary helpers and errors: `validateSegmentRef` · `BlobSink` · `ValidationError` · `WriteConflictError` ·
`NotFoundError` · `IntegrityError` · `TransientError` · `isValidationError` · `isWriteConflictError` ·
`isNotFoundError`

### `@cloudbitmaps/s3`

`S3Storage` · `S3StorageOptions` — the backend, both halves in one bucket.

Each conditional request the backend makes — the write-once `PutObject`, a multipart upload's `CompleteMultipartUpload`,
the registry's create, compare-and-swap and tombstone, and with `conditionalDelete` the registry's `DeleteObject` under
`If-Match` — is sent with the SDK's retry off for that request alone, whether
the client is one you passed or one `S3Storage` built. Every other request keeps the client's retry. The registry's
writes are sent once. A generation's object is sent again, at most three more times, after `503 SlowDown` (or any `503`)
and nothing else, waiting a random time under 500 ms, then 1 s, then 2 s: it carries a random id in its user metadata
(`x-amz-meta-cbwid`), and a precondition failure on a re-send, or an upload S3 no longer knows, reads it back, so an
object with its own id is a success and any other a `WriteConflictError`; with nothing stored, a `409` or an unknown
upload is an unknown outcome, a `TransientError`. A bare `429`, which AWS S3 does not send but some S3-compatible
services do, is not retried and is not classified transient: it surfaces as the SDK's own error, so a layer that keys on
`TransientError` will not retry it. A transient failure of a conditional write throws `TransientError`, and the write may
or may not have landed ([why](production.md#reliability-retries-backoff--timeouts)).

With `readTimeoutMs` set (it is off by default), each read the backend makes, every `GetObject` and `HeadObject` of a
generation or a pointer, is aborted if it has not finished, body included, after that many ms, and throws
`TransientError` with a message that names the request and says it timed out after that many ms. The timeout is per request, set through the request's abort signal, so the
SDK's own retries of that request fall inside it and nothing else the client sends is timed.

### `@cloudbitmaps/gcs`

`GcsStorage` · `GcsStorageOptions` — the backend, both halves in one bucket. It builds its own client, which
also sidesteps a confusing collision: `@google-cloud/storage` calls its client class `Storage`, which reads as
this library's word for the durable tier, so the backend takes it as `client`.

The client the backend builds sends each download once, because in `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0
and 8.1.0) a download the SDK retries after any status it retries (408, 429, 500, 502, 503 or 504) can crash the process with
`ERR_STREAM_UNABLE_TO_PIPE`. The driver retries a download itself, up to three more times with backoff, after
a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504, and after nothing else (not a missing credentials file or a TLS failure); what still fails is a `TransientError`. Its other requests keep
the SDK's retries. A `client` you pass is used as given, so build it with `retryOptions: { autoRetry: false }`, which also
turns off the SDK's retries of listings, metadata reads and resumable uploads on that client
([why](production.md#reliability-retries-backoff--timeouts)).

A client's `timeout` does not bound a download on 8.x; `readTimeoutMs` does, and it is off (`0`) unless set. It bounds
one read as a whole (a tail with the metadata read it falls back on for an empty object, a range, a registry row): one
deadline covers every attempt the driver makes and the backoff between them, from the call into the driver (a
credential fetch and any wait for a socket count) to the end of the body, and it counts time the process spends busy,
so a synchronous stretch longer than the timeout fails the reads in flight. When it passes, the read throws
`TransientError` naming the read and the timeout, no further attempt starts, and the store's read retry runs it again:
about 8.35 s in all at `2_000` with the default retry policy. Uploads, deletes, listings and the conditional writes are
not timed. The SDK cannot cancel a request whose response has not begun, so a read that times out before its server
answers leaves that connection open until the server answers or closes it: one per read, up to four per call through
the store's retry. A 404 whose error body arrives after the deadline is a `TransientError`, not `NotFoundError`. Every
download goes out on Node's global agent, not the SDK's shared one, so one the driver cuts off or refuses resets no
other request; that agent closes a connection idle for 5 seconds, and is shared with the process's other `http` and
`https` requests
([why](production.md#reliability-retries-backoff--timeouts)).

The registry lets a GCS deployment run on **one bucket
alone**: compare-and-swap rides GCS object preconditions (`ifGenerationMatch: 0` to create, `ifGenerationMatch:
<generation>` to swap), so no second service is needed to hold the `currentGen` pointer. The registry's writes, and
an object up to `simpleUploadThresholdBytes` (8 MiB by default), are each one request with no SDK retry around it, so a
transient failure throws `TransientError` and the write may or may not have landed. The registry's writes are sent
once. The object is sent again, at most three more times with the same waits as S3, after a `429` or `503` and nothing
else. A larger object is a resumable upload, a session of requests that the SDK retries within, under the client's
retry options. Every object carries a random id in its metadata, and a `412` on its commit that may be the write
meeting itself (a resumable upload's, or a single request's after a re-send) reads the stored object back, so an
object that carries its own id is a success and any other a `WriteConflictError`
([why](production.md#reliability-retries-backoff--timeouts)). With `conditionalDelete`, the registry removes a row with
a delete under `ifGenerationMatch`, which the SDK retries as it does any request with a precondition: a second copy can
remove nothing the first could not, and one that meets the first's landed delete is a 404, which the registry reads as
a lost race and re-reads.

### `@cloudbitmaps/azure-blob`

`AzureBlobStorage` · `AzureBlobStorageOptions` — the backend, both halves in one container. Give it a
`containerClient`, or a `connectionString` + `container` and it builds one.

Generations are write-once via `ifNoneMatch: '*'`. The registry lets an Azure deployment
run on **one container alone**: compare-and-swap rides blob conditions (`ifNoneMatch: '*'` to create,
`ifMatch: <etag>` to swap), so no second service is needed to hold the `currentGen` pointer. Every request goes
through the client's retry policy, the conditional writes included. Each conditional write carries a random id in
the blob's metadata, and a conflict reads the stored blob back, so a blob that carries its own id is a success and
any other a `WriteConflictError` ([why](production.md#reliability-retries-backoff--timeouts)). The client's policy sends
a write again after a `503 ServerBusy` or a `500 OperationTimedOut`, and a write that every try refused throws
`TransientError`. A load's fresh compare-and-swap after an unanswered row write goes through that policy too, so a registry
that never answers costs up to four times the policy's tries: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that schedule, not measured). The registry removes a
row with Delete Blob under `ifMatch`, unless `conditionalDelete` is `false`; a `412` or a `404` on it is a lost race,
and a `409` (a snapshot or a lease in the way) reaches the caller as the SDK raised it.

## Keeping this in sync

- The **sync test** ([`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts))
  derives its entry list from every package's own `exports` map — so each package and each subpath it declares
  is covered, with no list to maintain — and asserts each exported name appears (backtick-wrapped) under **its own
  entry's heading** in the **"Complete export index"** section — so **adding an export without documenting it
  breaks CI**. For core's main entry that is the names the flavor does not re-export. It runs in **both**
  directions: a name listed under an entry that does not export it, or that nothing exports any more, also fails,
  so a removed export cannot leave a stale entry behind. Two limits worth knowing rather than over-trusting:
  neither direction looks *above* that section, so the descriptive tables earlier on this page are guarded by
  neither; and the reverse direction only reads names joined by `·`, which is how every list in that index is
  written. It also fails if any barrel uses `export *`, so every export is named and the flavor's re-export of
  core is a list that grows on purpose.
- When you add/rename/remove a public export: update the relevant section **and** the
  [Complete export index](#complete-export-index) in the same change (this is part of the standard
  [keep-the-docs-current step](../../CONTRIBUTING.md#documentation--keeping-it-current)).
- This page catalogs the surface; the tutorial-style walkthrough with runnable snippets lives in the
  [getting-started guide](../guide/getting-started.md). For _why_ the surface is shaped this way, read the module
  headers — each one states the decision it encodes and what the alternative cost — and the
  [hard correctness invariants](../../AGENTS.md#hard-correctness-invariants), which are the protocol rules the
  shape follows from.
