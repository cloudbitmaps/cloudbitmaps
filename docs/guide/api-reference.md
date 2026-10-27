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
an application uses, as the next paragraph says. To price a store, add `@cloudbitmaps/tools`, the cost model, which
reads nothing of a store and needs none to run:

```
@cloudbitmaps/roaring         the store + memory/localfs backends + the errors, helpers and types an application uses, and RoaringBitmap
@cloudbitmaps/s3              S3Storage                                           (dep: @aws-sdk/client-s3)
@cloudbitmaps/gcs             GcsStorage                                          (dep: @google-cloud/storage)
@cloudbitmaps/azure-blob      AzureBlobStorage                                    (dep: @azure/storage-blob)
@cloudbitmaps/tools           estimateCost, groundedReport, the price lists       (offline; dep: @cloudbitmaps/core)
@cloudbitmaps/core            the internal engine; its main entry is outside the stability promise
@cloudbitmaps/core/driver-kit the driver contracts: the ports, their record types, a driver's helpers
@cloudbitmaps/core/node       internal: the backends and keystore that need a Node builtin (the flavor re-exports them)
CLI (binary):                 export-segments
```

Each cloud SDK is a **real dependency** of its backend package, not an optional peer: installing
`@cloudbitmaps/s3` installs `@aws-sdk/client-s3`, and no install carries an SDK for a service you do not use.

**Where the code actually lives.** The flavor package is the roaring codec (internal; `RoaringBitmap` is its public shell),
the `CloudRoaring` facade, and the `export-segments` CLI; its main barrel re-exports, by name, the types the
store's signatures name, the backends, the errors and the helpers an application calls. What it leaves on core is
the engine, whose main entry and `/node` subpath are internal: the packages here import it, and it is not part of the public API. The
driver contracts the store's signatures stop at (`IStorageDriver`, `IRegistryDriver`, `StorageBackend`,
`StorageChunkSource`, `IKeystore` and the registry's record types) have one home, `@cloudbitmaps/core/driver-kit`,
and the flavor does not re-export them: an application that has to name one imports it from there, or derives it
([the storage interfaces](#the-storage-interfaces-used-to-type-storage--registry)). The storage packages are codec-agnostic — they move
opaque payload bytes — so one package per storage **service** serves every codec, which is what makes adding
a codec cost nothing on the storage axis. A driver author builds against
[`@cloudbitmaps/core/driver-kit`](#cloudbitmapscoredriver-kit), and a flavor never re-exports a driver
package: doing so would put that SDK back into every install.

---

## The everyday surface (what you'll call)

**Every call checks its options.** An options bag that is not an object, a key the call does not take, and a switch
(`dryRun`, `allowEmpty`, `purgeTombstones` and the like) that is not a boolean throw `ValidationError` naming what is
wrong, before anything is read or written, so a misspelt key or a scope passed as a bare string never silently widens
what a call does. The keys checked are the bag's own: a key it inherits through a prototype (a bag made with
`Object.create`, or a class instance whose options are getters) is not checked, so pass options as an object literal
or a spread to have every key checked. `store.segment` is stricter: it refuses a class instance or an object built on
another outright. A key whose value is `undefined` reads as absent, so a spread of options keeps working. A `null`
throws where a number, a switch or a name is taken (`concurrency`, `keep`, `budget`, `now`, `dryRun`, `namespace`,
`limit` and the like), since it would otherwise read as the default; it still reads as absent for a sink or an object:
`audit`, `guard`, `exclude`, `metrics`, a backend's `client` or `containerClient`, and the cost model's `workload`, its
fields and a segment's `count`. A bag of `undefined` or `null` is no options on the calls that take them last;
`new MemoryStorage(null)` and `new LocalFsStorage(dir, null)` refuse it. The same checks hold for the keys inside
`guard` and `budget`, for `store.segment`'s options, for the free functions that take an options bag (`destroySegment`,
`eraseNamespace`, and the `{ registry }` they are given), and for the constructors and the backends, where a value of
the wrong type, an empty string where a name or an endpoint is taken, and a key the constructor does not take are each
refused when it is built.

### Build a store — `new CloudRoaring(options)`

`storage` is the **only option a store needs**. Pass a backend and you are done: it carries the pointer, which is
what gives one-read generation resolution, encrypted segments, the `*Into` verbs and every lifecycle helper.
Everything else is optional tuning with sensible defaults — see [`CloudRoaringOptions`](#construction--result-types).

**You pick a backend.** A `StorageBackend` carries both the generations and the
pointer — configured from one bucket and one prefix, which is what makes them impossible to mismatch:

| Backend | Import | Construct |
|---|---|---|
| `MemoryStorage` (`MemoryStorageOptions`) | `@cloudbitmaps/roaring` | `new MemoryStorage({ now? }?)`; an option key it does not take, or a `now` that is not a function, throws `ValidationError` |
| `LocalFsStorage` (`LocalFsStorageOptions`) | `@cloudbitmaps/roaring` | `new LocalFsStorage('/var/lib/cloudbitmaps', { now? }?)`: a root that is not a non-empty string, an option key it does not take, or a `now` that is not a function throws `ValidationError`, and nothing is created. Generations under `<root>/storage`, pointers under `<root>/registry`, which is also the layout `export-segments` expects. It creates files `0600` and directories `0700` from the root down (a missing parent of the root is created with the default mode); an existing directory keeps its mode, and a registry row is always rewritten `0600`. A root is for one process: instances in a process share a lock per row, two processes on one root are not fenced. Names that differ only by case stay distinct on a case-insensitive filesystem: see [Keep it on disk](getting-started.md#keep-it-on-disk) |
| `S3Storage` | `@cloudbitmaps/s3` | `new S3Storage({ bucket, prefix?, client?, region?, endpoint?, pathStyle?, credentials?, maxSockets?, maxObjectBytes?, partBytes?, readTimeoutMs?, conditionalDelete?, now? })` — `client` or the five settings that build one, and both is refused; `region` is a non-empty string, and `prefix` on any of the three backends a string |
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
| `S3Storage` | `maxSockets` | 128 (the AWS SDK's own default is 50) | most sockets the client the backend builds opens at once, for `https` and for a plain-`http` endpoint; only the limit differs from the SDK's own client: its request handler, defaults-mode timeouts, keep-alive and retry are the SDK's; a positive safe integer; refused beside `client`, which carries its own |
| `S3Storage` | `partBytes` | 8 MiB; a smaller value is raised to S3's 5 MiB minimum | multipart part size, and so the peak write memory; a positive safe integer of at most 5 GiB, S3's part limit: a larger one throws `ValidationError` |
| `S3Storage` | `maxObjectBytes` | `partBytes` × 10,000 (about 78 GiB at the default) | the largest object the backend will write and advertise; raise it and `partBytes` grows so the 10,000-part limit still covers it, up to S3's 5 TiB, and a larger value throws `ValidationError`; a positive safe integer |
| `S3Storage` | `readTimeoutMs` | `0`: no timeout | how long each `GetObject` and `HeadObject`, the SDK's own retries of it included, may take, the response body included, before it is aborted and throws `TransientError` for the store's read retry; an integer from 0 to 2,147,483,647 |
| `GcsStorage` | `simpleUploadThresholdBytes` | 8 MiB | an object up to this size is one simple request; a larger one is a resumable stream; a positive safe integer |
| `GcsStorage` | `maxObjectBytes` | 5 TiB, GCS's per-object maximum | the largest object the backend will write and advertise; set it lower to fail fast on a runaway write; a positive safe integer of at most 5 TiB: a larger one throws `ValidationError` |
| `GcsStorage` | `readTimeoutMs` | `0`: no timeout | how long one read (a tail with its metadata fallback, a range, a registry row) may take, every attempt and the body included, before it throws `TransientError` for the store's read retry; see [`@cloudbitmaps/gcs`](#cloudbitmapsgcs); a non-negative safe integer no larger than 2,147,483,647 |
| `AzureBlobStorage` | `blockBytes` | 8 MiB | staged block size, and so the peak write memory; a positive safe integer of at most 4,000 MiB, Azure's block limit: a larger one throws `ValidationError` |
| `AzureBlobStorage` | `maxObjectBytes` | `blockBytes` × 50,000 (about 390 GiB at the default) | the largest blob the backend will write and advertise; raise it and `blockBytes` grows so the 50,000-block limit still covers it, up to 50,000 blocks of 4,000 MiB (about 190.7 TiB), and a larger value throws `ValidationError`; a positive safe integer |
| `AzureBlobStorage` | `readTimeoutMs` | `0`: no timeout | how long each read request (a range read, a tail read's properties and its download, each on its own, a registry row's read) may take, the response body included, before it is aborted and throws `TransientError` for the store's read retry; an integer from 0 to 2,147,483,647 |

**Each cloud backend says whether its registry removes a deleted row for good: `conditionalDelete`.** On, a row the
registry deletes, the retention sweep's purge of a tombstone included, is removed from the bucket by a delete the
service applies only to the version the registry read: `DeleteObject` with `If-Match` on S3, a delete with
`ifGenerationMatch` on GCS, Delete Blob with `ifMatch` on Azure Blob. A precondition that no longer holds is a
`WriteConflictError`, and the registry re-reads. Off, every delete leaves a tombstone in the row's place, which every
full listing reads. `backend.registry.capabilities()`
reports which (`conditionalDelete: true` or `false`). A value that is not a boolean is refused with `ValidationError`.
The registry needs delete permission on its prefix for it.

**The same option covers the storage half.** Where it is on, a delete the storage driver is given a version for
(`delete(key, { ifVersion })`, the version a tail read of the object reported) is sent under that precondition, so it
removes the object only while it is the one that was read, and `backend.storage.capabilities().conditionalDelete`
reports `true`; off, the version is ignored and the delete removes whatever is under the key. An erasure's delete of a
holder by name (above the pointer, on a segment with no generation yet, or one it cannot search), a refused rewrite's
delete of its own object above the winner's pointer, and a refused load's delete of the object whose footer matched
what it wrote, are the ones the library sends that way, so a load that took the number since keeps its generation (within the
limits in [a number taken again during an erasure](correctness.md#how-an-erasure-stays-correct)). A precondition that no longer holds is a
`WriteConflictError` while an object is under the key, and an absent object is a no-op whichever of `404` or `412` the
service answers for it. The S3 storage half reads its default from the client as the registry does, on its first
conditional delete: `capabilities().conditionalDelete` reads `false` until then unless you set the option, and stays
`false` when the client cannot be resolved then (no region), in which case its deletes are unconditional.

| Backend | Default | Why |
|---|---|---|
| `S3Storage` | `true` when the host the client resolves is an AWS S3 host; `false` for any other host, or one that cannot be resolved | AWS documents `If-Match` on `DeleteObject` for general purpose and directory buckets. An S3-compatible store may accept the header and ignore it, and MinIO does, so a client that sends to one keeps tombstones until you set `true`. The host is the one the SDK resolves for a request, so an endpoint set by `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config file counts as a constructor `endpoint` does; an AWS regional, FIPS, dual-stack or VPC interface host is AWS, as is an access point's, a multi-region access point's, an Object Lambda's, an Outpost's and a directory bucket's; another AWS service's host whose name starts with `s3` (a load balancer, an API Gateway, a website endpoint) is not |
| `GcsStorage` | `false`, on the public endpoint too; `true` removes rows for good | Whether real GCS applies `ifGenerationMatch` to a delete has not been verified by a run against the service, and fake-gcs-server accepts it and ignores it, so CI cannot show it |
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
and `.registry`, and accepts an injected `now` for deterministic tests. Every backend refuses an option
key it does not take, by name, as the store does.

> **`backend.storage` is not a backend.** It is the storage alone, without the registry: a raw `IStorageDriver`. Passed as `storage`,
> it builds a store with no pointer: cleartext and read-only, as the raw-driver paragraph below describes. Pass
> the backend itself.

The **keystore** (optional encryption) is separate from the backend: `InProcessKeystore` (BYOK), passed as
`encryption.keystore`.

Pass a **raw** `IStorageDriver` as `storage` and the store builds its `.crbm` reader over it with
**no registry** — generations then resolve by list-scan, so the store is **cleartext and read-only**; or pass a
`StorageChunkSource` of your own, a read source, and it is used as-is — an `encryption.keystore` or
`encryption.required: true` beside it is then rejected as a wiring mistake (a source of your own reads an encrypted
segment by itself, if it must; to have the store decrypt, pass a backend). Both ports
are exported by `@cloudbitmaps/core/driver-kit`. A store
built on a pre-built source is **read-only**: the `*Into` verbs and the lifecycle helpers need a backend and
throw `UnsupportedError`, and so do the calls that enumerate or read the registry (`exists`, `segments`,
`subjectReport`, `exportSegments`), since the store holds no registry of its own, even when the source you built
reads through one.

A storage that cannot serve range reads (none of the five backends above is one; a driver of your own might be) is
refused at construction with `CapabilityError`, and so is a keystore or `encryption.required: true` on a store built
on a bare `IStorageDriver` instead of a backend, which has no registry to hold wrapped keys.

### Get a segment — `store.segment(name, { namespace? })` → `Segment`

The options are a plain object holding `{ namespace }` alone: any other own key with a value (enumerable or not),
options that are not an object, and a class instance or an object built on another throw `ValidationError` naming
what is wrong, so a misspelt `namespace` never addresses the default namespace. A handle
carries no deadline: `expiresAt` among its options throws `ValidationError`. A set that stops being served
after a deadline is checked where it is read, or recorded with `setRetention` and retired by `retireExpired`
([a deadline on a set](retention.md#a-deadline-on-a-set)).

A `Segment` has no public constructor: `store.segment(name)` and `seg.pin()` are the only ways to get one, because a
handle is wired to the store's engine, caches and write path. The class is exported for `instanceof` and to annotate
a variable, and `new Segment(…)` throws `ValidationError`.

### Load a generation — `store.load(ref, input, { allowEmpty?, guard?, keep?, metadata?, audit?, sorted? })`

The whole write path in one call: take the next generation number, stream `input` into one immutable `.crbm`
object, check it is plausible, move the pointer, and collect what the move superseded, keeping `keep` generations
below the new pointer, the most recently current of them, so the one it superseded comes first (default `1`; a non-negative integer,
and anything else — negative, fractional, `NaN`, infinite — throws `ValidationError` before anything is written). After
a rollback the one it superseded is the generation the rollback restored, and it stays in the window of every load after
that, ahead of the generations the rollback moved away from
([what a load keeps after a rollback](loading.md#what-a-load-keeps-after-a-rollback)). The `*Into` verbs take
the same `keep`, validated the same way. Returns a
`LoadResult` — `{ generation, published, reason?, size, sha256, chunkCount, cardinality, cardinalityBefore,
collected }`. The segment's row records the generations a load keeps (up to 127), so at any `keep` up to 64 a load that
found nothing above its pointer deletes by name the generations its publish pushed out of the window, and lists the
segment only on every 16th generation; with a `keep` above 64, on a row with no usable ledger, or when its check of its
generation number met an object or its check of the current generation's object found it gone, it lists
([how it collects](loading.md#generations-and-keep)). `collected` names what the pass deleted, and a generation
deleted by name may have been gone already: a delete of an absent object succeeds and says nothing, so the list is not
a receipt that the generation was there. A collection that deleted anything reads the row once more after its last
delete, and a rollback that moved the pointer onto a generation the load deleted, its own refused object included,
makes the load throw `NotFoundError` saying so when the row still names that missing object on reads at once and after
waits of up to 1.75 s in all on the store's clock: after the publish, that the load took effect at its generation;
after a refusal, which refusal it was, once a refusal the load answers is audited (one its publish raises as an error
sends no event). Check `store.generations(ref)` before acting on it ([a rollback that races a
collection](correctness.md#a-rollback-that-races-a-collection)). Memory is bounded by the **distinct set** being built, not by the input length — a batch job's shape,
not a request handler's — and the store's clock makes a long load yield the event loop. On a store built with a
keystore it writes encrypted: it mints the segment's DEK on its **first** generation, reuses it afterwards, and
never encrypts a segment whose existing generations are cleartext. `audit?` emits `segment.publish` for a generation
it lands and `segment.load-refused` for one it refuses. `guard?` is `{ minCardinality?, minRetained?, maxGrowth? }`:
a fewest number of ids, a floor and a ceiling on the new size as a multiple of the current one, each refused with its
own `reason`, and an invalid one is a `ValidationError` before any request
([details](correctness.md#when-a-load-is-refused)).

**`metadata`** — a small record of your own, written with the generation: a flat object of string keys and string or
finite-number values, at most 1,024 bytes as canonical JSON (keys sorted by UTF-16 code unit, no whitespace) with no key
over 128 bytes. A record that breaks a rule is a `ValidationError` before the load makes a request, and `undefined` or
`{}` stores nothing. It is copied when you call, stored in the generation's object, and written to the segment's row, with
the generation's id count, by the same compare-and-swap that moves the pointer, so a reader that sees a generation as
current sees its metadata. It is immutable: a new generation is how it changes. A rollback puts the target's own back,
and an erasure rewrite carries it over unchanged without scanning it, so keep a subject's id out of it. Sealed under
the segment's key on an encrypted segment. Each `*Into` verb takes it too, in its options
([details](loading.md#metadata-what-a-generation-was-computed-from)). `seg.stat()` and the current entry of
`store.generations()` read it back, with the generation's id count.

**The guard's size.** A guarded load takes the size of the current generation from the row's summary of it when the
row has a usable one, and opens no object for it; a row with none is read from the object's index
([details](loading.md#where-the-guard-reads-the-size-of-the-current-generation)).

**Branch on `published`.** `false` is a normal outcome, not a throw, and `reason` says why. Either a guard refused
the result (`'empty'`, `'min-cardinality'`, `'min-retained'` or `'max-growth'`), or another writer got there first (`'superseded'`).
There are two ways to get there first. Another load may have taken the same generation number, so this one wrote
nothing (`size: 0`). Or the segment's registry row changed while the load was writing: another load published, a
retention change, a rollback or an erasure wrote the row, or the row was deleted. A refused load deletes the object
it wrote while the row is unchanged, changed only in its leases, or destroyed (crypto-shredded, destroyed in the clear
or dropped), and, once one read of the object's footer matches what the load wrote, when the row is gone or, for a
cleartext object, has key material. Once another write has otherwise changed the row, it leaves the object in the
bucket, an orphan: a load's listing deletes it once a generation above it is current, unless the row's window names it,
and can keep it in its window where the row has none. Until it goes, `rollback` refuses it unless `allowUnknown` is
passed, since the row never recorded it, and with the override a rollback onto it publishes what no load published ([an
orphan is collected later](correctness.md#how-a-load-stays-correct)).
The `store.load` row lists the guards and what throws instead.

**`input` is a `LoadInput`: ids, or a whole bitmap.** Ids are any sync **or async** iterable of integers in
`[0, 2^32)`, unsorted, duplicates welcome. A bitmap is `{ serialized }`, one 32-bit bitmap in the portable Roaring
format, or `{ bitmap }`, any `PortableBitmap` (an object with `serialize('portable')`, such as `roaring`'s
`RoaringBitmap32`, and optionally `getSerializationSizeInBytes('portable')`, which lets a load refuse one over the cap
before serializing it), which is loaded as `{ serialized: bitmap.serialize('portable') }`, serialized once at the
call. An iterable with a `serialize` method (a `RoaringBitmap32` from the `roaring` package, another copy's bitmap, or a `RoaringBitmap`) passed
as ids is loaded as `{ bitmap }` and not iterated; a byte array is refused as ids even with a `serialize` of its own. Bitmap bytes are capped at 537,403,396 bytes (more than any canonical 32-bit bitmap
serializes to), must hold exactly one bitmap, and
are checked structurally and decoded by the safe deserializer before the first request; malformed or oversized
bytes, and bytes after the bitmap's end, throw `ValidationError` with nothing read or written. The chunks are then
cut from the bitmap's own containers, with no per-id work, and the generation holds chunk for chunk what the same ids
write. A `Uint8Array`, `Uint8ClampedArray` or `Buffer` passed as ids throws `ValidationError` when the load runs
(the type accepts one, since a byte array is an iterable of numbers): pass bytes as `{ serialized }`. One that carries a
`serialize` method of its own is a bitmap instead, and loads as what its `serialize('portable')` returns.
Anything that is none of these throws `ValidationError` too ([what a load accepts](loading.md#what-a-load-accepts)).

**`sorted: true` writes ascending ids one chunk at a time.** For ids that already ascend, the load writes each chunk
while the object uploads instead of holding the generation in memory first, so it holds one chunk and the writer's
index (up to about 7 MiB, about 8 MiB for an encrypted segment, derived, at the 65,536 chunks a segment can have),
whatever the segment's size, and writes the same object an unsorted load of the same ids writes. A repeat is skipped; an
id lower than the one before throws `ValidationError` naming its position. The row, the number and the key are settled
before the first id is read. An error the ids raise reaches the caller as the very object raised, never seen by the
storage driver, and a storage driver that runs its write again gets `IntegrityError`. With `{ serialized }`, `{ bitmap
}`, a `RoaringBitmap` or any other iterable with a `serialize` method, and as a value that is not a boolean, it throws `ValidationError` before any
request; the `*Into` verbs do not take it
([ids that already ascend](loading.md#what-a-load-accepts)).

### Build and combine bitmaps by themselves — `RoaringBitmap`

`RoaringBitmap` is a mutable set of integers from 0 to 4,294,967,295 (unsigned 32-bit ids), in TypeScript on typed
arrays, with no native addon. It is the codec's own bitmap behind a checked shell, and it writes and reads the portable
Roaring bytes a store loads and holds. Import it from `@cloudbitmaps/roaring`, with the store (the package's main entry also loads the store's in-process
backends and their Node builtins). It is not designed for subclassing, and it is synchronous: a large `deserialize`, `toArray` or combine holds the event loop for its duration
([where to run it](production.md#what-blocks-the-event-loop-and-where-to-run-it)).

<!-- typecheck-skip: a fragment: `ids` and `bytes` are the reader's -->
```ts
const empty = new RoaringBitmap();
const fromList = new RoaringBitmap([1, 5, 70_000]);        // any iterable of ids
const fromTyped = new RoaringBitmap(new Uint32Array(ids)); // never changed or kept
const fromBytes = RoaringBitmap.deserialize(bytes);        // portable bytes: capped, checked, one whole bitmap
```

| Call | Does | Cost |
|---|---|---|
| `new RoaringBitmap(values?)` | the empty bitmap, or one of an iterable of ids, a `Uint32Array` (read in place when it already ascends, else sorted on a copy; a `SharedArrayBuffer`-backed one is copied first) or another `RoaringBitmap` (a copy-on-write `clone()`) | linear in the ids |
| `RoaringBitmap.deserialize(bytes, { maxBytes? }?)` | decodes portable bytes you hold: [below](#decode-portable-bytes--roaringbitmapdeserializebytes) | linear in the bytes |
| `bm.size`, `bm.isEmpty` | how many ids it holds; whether it holds none | constant |
| `bm.has(id)` | membership | one container lookup |
| `bm.minimum()`, `bm.maximum()` | the smallest and the largest id, or `undefined` when it is empty | constant per container |
| `bm.add(id)` → `this` | adds one id | one container lookup, plus a copy of the container the first time it is written after a clone |
| `bm.addMany(values)` → `this` | adds every id of an iterable, a `Uint32Array` or a `RoaringBitmap`; nothing is added if any id is refused; a run container the ids land in stays a run container while the run form is the smaller one (its run list is edited, never expanded to words), and becomes an array or a bitset when it is not, as it does when more than 4,096 ids land in one chunk | linear in the ids |
| `bm.remove(id)` → `boolean` | removes one id; whether it was there | as `add` |
| `bm.removeMany(values)` → `this` | removes every id of an iterable, a `Uint32Array` or a `RoaringBitmap`; nothing is removed if any id is refused | linear in the ids |
| `bm.clear()` | removes every id | constant |
| `bm.clone()` | a copy, copy-on-write: it costs the key list and one flag per container, not the ids | O(containers) |
| `bm.andInPlace(other)`, `bm.orInPlace(other)`, `bm.andNotInPlace(other)` → `this` | keeps the ids both hold, adds the ids `other` holds, or removes them; `other` is not changed and may be `bm` itself | linear in the containers of the two |
| `bm.xorInPlace(other)` → `this` | keeps the ids exactly one of the two holds; `other` is not changed and may be `bm` itself (the result is then empty). One pass over each pair of containers that share a key | linear in the containers of the two |
| `RoaringBitmap.and(a, b)`, `RoaringBitmap.or(a, b)`, `RoaringBitmap.xor(a, b)`, `RoaringBitmap.andNot(a, b)` → `RoaringBitmap` | a new bitmap of the ids both hold, either holds, exactly one holds, or `a` holds and `b` lacks. Neither operand's ids change, and the result owns its storage: a change to it never reaches an operand and the reverse. `a` and `b` may be the same bitmap | linear in the containers of the two; `or`, `xor` and `andNot` flag, copy-on-write, each container only `a` holds that the result keeps by reference (below) |
| `RoaringBitmap.orMany(bitmaps)` → `RoaringBitmap` | a new bitmap of the union of an iterable of bitmaps (the empty set for none), built in containers of its own: nothing is flagged and no operand changes. Every element is checked before any is combined | linear in the containers of all of them |
| `bm.andCardinality(other)`, `bm.orCardinality(other)`, `bm.xorCardinality(other)`, `bm.andNotCardinality(other)` → `number` | how many ids both hold, either holds, exactly one holds, or `bm` holds and `other` lacks, answered without a result bitmap you can keep. Neither bitmap changes, and `other` may be `bm` itself | no cost stated |
| `bm.intersects(other)` → `boolean` | whether the two share an id; equal to `andCardinality(other) > 0` | no cost stated |
| `bm.isSubset(other)` → `boolean` | whether every id of `bm` is in `other`; an empty bitmap is a subset of every bitmap, itself included. Unlike `roaring`, a value that is not a bitmap is a `ValidationError`, not `false` | no cost stated |
| `bm.isEqual(other)` → `boolean` | whether the two hold exactly the same ids: by membership, not by container kinds or serialized bytes, so a bitmap with run containers equals the same ids held as arrays | compares the two containers of each key by their stored values and stops at the first difference; only two containers of different kinds that hold the same number of ids are compared by counting the ids they share |
| `[Symbol.iterator]()` | the ids, ascending, each once (a promise) | lazy |
| `bm.toArray()`, `bm.toUint32Array()` | the ids as a new ascending array the caller owns (`toUint32Array` never returns a view of the bitmap's storage); a bitmap too large to allocate throws the runtime's `RangeError` | `size` times 8 bytes (array) or 4 bytes (typed) |
| `bm.serialize(format?)` → `Uint8Array` | the portable bytes, in a new array; `'portable'` is the only format, and any other argument throws `ValidationError`. A bitmap holds run containers after a write into one that stayed the smaller form, so without `runOptimize()` first it can write a run container where an earlier version wrote an array or a bitset: a valid encoding of the same set, and only `runOptimize()` makes the bytes depend on the set alone | linear in the containers |
| `bm.runOptimize()` → `boolean` | re-encodes each container in its smallest form (a run container only where strictly smaller than the plain one), so `serialize()` afterwards depends on the set alone (before it, the bytes also depend on which containers earlier writes left as runs); returns whether the bitmap has at least one run container afterwards, not whether anything changed | linear in the containers |

**Every id argument is checked.** `has`, `add`, `addMany`, `remove`, `removeMany` and the constructor throw
`ValidationError` for a value that is not an integer from 0 to 4,294,967,295 (a fraction, `NaN`, a string, `null`, a
negative, one too large), the same answer `seg.has` gives. The message names what is wrong with the value and never
repeats it, because an id that is refused is often an identifier that was never meant to be one and applications log
error messages. The bitmap is unchanged after a refused call: the check runs before any container is touched. `add` and
`remove` take exactly one id, and a second argument throws `ValidationError` naming `addMany` or `removeMany`, so a call
moved from a variadic form fails loudly rather than dropping the second id. The constructor and `addMany` read an
iterable of ids once; a `Uint8Array`, `Uint8ClampedArray` or `Buffer` passed as ids throws `ValidationError`
(each byte would be read as an id; call `RoaringBitmap.deserialize` for bytes), and so does anything that is not an
iterable, a string included. An operand of `andInPlace`, `orInPlace`, `andNotInPlace`, `xorInPlace`, a static combine, `andCardinality`,
`orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`, `isSubset` or `isEqual`, and each element of `orMany`, must be
a `RoaringBitmap` of this copy of the package, or `ValidationError`.

**Counting and comparing.** `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality` and `intersects` answer
from the containers of the two bitmaps with the codec's counting kernels, without building the combination: the answer is
the one `roaring` gives, neither bitmap changes and nothing is kept. The kernels ship because the count bench's record
(`bench/count-kernels-results.json`, four passes, in #449) has the count's median below the build's on every data set, and
its gate prints `RESULT kept`. `isSubset` and `isEqual` compare by membership. Each is held to the `roaring` package's answer and to the identities `andCardinality(a, b) == and(a, b).size`,
`intersects(a, b) == (andCardinality(a, b) > 0)` and `isSubset(a, b) == andNot(a, b).isEmpty`. No speed figure is stated here.

**Copy-on-write.** `clone()` shares every container between the copy and the original until one side writes it, and the
first write to a shared container copies it once. The flag is never cleared, so a bitmap that was ever cloned pays that
one copy per container it writes, even after the clone is dropped: the right trade for snapshot-and-continue, and
`clone()` is not free to call in a loop on a bitmap you keep writing.

The static combines are built to avoid that cost: they do not clone `a` and combine in place. `RoaringBitmap.and` builds
its result from new containers and flags nothing, so `snap = RoaringBitmap.and(acc, filter); acc.addMany(batch)` in a loop
pays no copy for the snapshot. `or`, `xor` and `andNot` keep, by reference, a container only `a` holds, and flag it, so the
next write to that container, on `a` or on the result, copies it once; a container both operands hold is combined into a
new one, and a container only `b` holds is copied into the result. The ids of an operand never change.

**Iterating while changing is unsupported.** An iteration of an unchanged bitmap yields every id once, ascending. If the
bitmap changes during the walk the iterator neither throws nor reads outside the bitmap's storage, and what it yields is
unspecified: collect first with `toUint32Array()`, or iterate a `clone()`.

**`JSON.stringify(bm)` gives `"{}"`.** There is no `toJSON`, so a structured logger that serializes `{ segment, bitmap }`
does not write every id into a log. Write `JSON.stringify([...bitmap])` or `bitmap.toArray()` when you mean the ids. Do
not pass a `RoaringBitmap` to a method of the `roaring` package from npm: it is not a `RoaringBitmap32`, so the predicates
and counts (`intersects`, `andCardinality`, `isSubset` and the like) answer wrongly without throwing in JavaScript
(TypeScript refuses the call), the static `RoaringBitmap32.and`, `or`, `xor`, `andNot` and `orMany` throw, and the constructor and the
in-place operations (`orInPlace`, `addMany` and the like) read it as ids. To use one of that package's operations, decode
the bitmap's `serialize()` bytes with it.

**Where it differs from the `roaring` package from npm.** Each difference is deliberate:

| | `roaring` | `RoaringBitmap` |
|---|---|---|
| `add`, `remove` | variadic | exactly one id; a second argument is a `ValidationError` naming `addMany` or `removeMany` |
| a value that is not an id | `add` accepts `string`, `number`, `null` and `undefined` | every id argument throws a `ValidationError` with a value-free message |
| `minimum()`, `maximum()` of an empty set | `0xFFFFFFFF` and `0`, which are real ids | `undefined` |
| `deserialize` | `(buffer, format)`, a `Buffer`, the format required; it checks only its own reads | `(bytes, { maxBytes? })`, a `Uint8Array`; a format argument and an empty buffer are refused; the bytes are capped and checked |
| `serialize` | returns a `Buffer`, the format required | returns a `Uint8Array`; `'portable'` is optional |
| `runOptimize()` | true if a run container exists | the same meaning (it also demotes runs that are not smaller) |
| `toJSON` | present | absent |
| the combines that return a new bitmap | statics `and`, `or`, `xor`, `andNot`, `orMany` and `xorMany` | the same statics except `xorMany`, with the argument rules of the in-place forms (a non-bitmap is a `ValidationError`) |
| `isSubset` of a value that is not a bitmap | documented to answer `false` | a `ValidationError`; so is every other count and comparison |

**Not provided.** Ranges, `rank`, `select`, frozen views, Array-style helpers, `toSet`, `getSerializationSizeInBytes`
and 64-bit ids are left out, and so are `xorMany` and `delete`.

**Against the `roaring` package.** What each operation of the class costs next to the pinned `roaring` package (CRoaring
through its binding, a development dependency the tests hold the codec to; the store does not run it) on the same data,
and next to the call of the TypeScript codec that the store does run, one data set a column. A store hides these costs
behind network reads; a loop over in-memory bitmaps does not, so the table prints every cell, losses included. The
figures are the record in [`bench/bitmap-api-results.json`](../../bench/bitmap-api-results.json), measured by
[`bench/bitmap-api.cjs`](../../bench/bitmap-api.cjs); this region is generated from it.

<!-- BITMAP_API:TABLE:START -->

**Measured** on Apple M3 Pro (11 cores), darwin arm64, Node v24.22.1, commit `3be54a7e` (dirty tree), `roaring` 2.7.0, 31 rounds a figure, pass 2, started 2026-10-27. Each figure is the median over the rounds of the class's time divided by the `roaring` package's in the same round, so 2.00 means twice as slow and 0.50 half the time. One subject per process, rotated orders, an A/A control per cell, wall-clock on one machine; the kept rounds ended at a load of at most 5.96 and 448 rounds were set aside at 6 or more and taken again (at most 7 of any one figure, on 96 figures). Recorded, never asserted.

| Against `roaring` (class time / native time) | Group | dense | sparse | runs | mixed | spread8k |
|---|---|---:|---:|---:|---:|---:|
| `build array` | build | 2.15 | 1.23 | 2.39 | 2.40 | 0.59 * |
| `build Uint32Array` | build | 1.66 | 0.93 | 1.64 | 1.64 | 0.37 |
| `build addMany` | build | 1.66 | 0.95 | 1.64 | 1.64 | 0.38 |
| `build add per id` | build | 1.08 | 2.41 | 1.12 | 1.10 | 1.73 |
| `has` | has | 0.33 | 0.82 | 0.79 | 0.62 | 0.65 |
| `and returning` | combine returning | 2.90 * | 0.46 | 2.51 * | 1.35 | 0.90 |
| `or returning` | combine returning | 2.62 * | 1.94 | 2.22 | 1.85 * | 1.72 |
| `xor returning` | combine returning | 2.40 | 1.59 | 1.84 | 1.50 | 2.21 |
| `andNot returning` | combine returning | 2.68 * | 0.49 | 2.55 | 2.03 | 1.86 |
| `and in place` | combine in place | 3.30 | 0.46 | 2.09 | 2.13 * | 0.87 |
| `or in place` | combine in place | 3.14 | 1.97 | 1.78 | 2.02 * | 1.06 |
| `xor in place` | combine in place | 2.47 * | 1.61 | 1.80 | 1.79 | 1.26 |
| `andNot in place` | combine in place | 2.46 | 0.50 | 2.19 | 2.79 | 1.75 |
| `serialize` | serialize | 0.25 * | 0.29 * | 0.47 * | 0.32 * | 2.68 |
| `deserialize` | serialize | 2.83 | 5.50 | 5.29 | 4.26 | 4.55 |
| `runOptimize` | serialize | 0.41 | 2.40 | 0.06 | 0.70 | 0.32 |
| `iterate` | export | 1.12 | 1.40 | 1.06 | 1.10 | 1.04 |
| `toUint32Array` | export | 1.72 * | 2.02 | 4.71 | 2.34 | 3.17 |
| `toArray` | export | 0.52 * | 0.44 | 0.54 * | 0.50 | 0.48 |
| `orMany 8` | orMany | 5.79 | 1.14 | 5.75 | 2.50 | 1.28 |
| `orMany 64` | orMany | 22.82 | 0.92 | 6.96 | 2.40 | 0.89 |
| `clone` | clone | 0.00 | 0.01 | 0.01 | 0.00 | 0.06 |
| `clone then write` | clone | 1.66 | 2.86 | 4.46 | 1.62 * | 0.76 |
| `andCardinality` | count | 8.66 | 0.41 | 1.76 * | 2.06 | 1.57 |
| `orCardinality` | count | 7.88 | 0.41 | 1.73 * | 2.14 | 1.56 |
| `isSubset` | compare | 3.11 | 0.39 | 3.67 | 0.07 | 1.61 |
| `isEqual` | compare | 8.09 | 16.89 | 19.44 | 10.19 | 8.12 |
| `intersects overlapping` | count | 0.67 | 7.62 | 0.57 | 0.66 | 2.25 |
| `intersects disjoint` | count | 3.18 | 0.41 | 3.06 | 2.05 | 1.45 |
| `write after or` | write after combine | 12.43 * | 4.98 | 8.32 | 6.55 * | 1.16 |
| `write after xor` | write after combine | 12.62 * | 5.23 | 9.82 * | 6.57 | 1.13 |
| `write after andNot` | write after combine | 14.32 * | 5.87 | 10.03 * | 6.84 | 1.14 |

| The shell against the codec's own call (class time / codec time) | Group | dense | sparse | runs | mixed | spread8k |
|---|---|---:|---:|---:|---:|---:|
| `build array` | build | 1.01 | 1.07 | 1.00 | 1.00 | 1.09 * |
| `build Uint32Array` | build | 1.01 | 1.01 | 1.00 | 1.00 | 1.05 |
| `build addMany` | build | 1.01 | 1.01 | 1.00 | 1.00 | 1.07 |
| `build add per id` | build | 1.09 | 1.00 | 1.08 | 1.07 | 1.03 |
| `has` | has | 1.13 | 1.02 | 1.02 | 1.06 | 0.89 |
| `and returning` | combine returning | 1.63 * | 1.02 | 0.92 * | 1.04 | 1.05 |
| `or returning` | combine returning | 1.57 * | 1.00 | 1.03 | 1.13 * | 1.13 |
| `xor returning` | combine returning | 1.27 | 1.01 | 1.01 | 0.97 | 1.22 |
| `andNot returning` | combine returning | 1.62 * | 1.02 | 0.98 | 0.85 | 1.20 |
| `and in place` | combine in place | 1.29 | 1.03 | 0.94 | 1.12 * | 1.06 |
| `or in place` | combine in place | 1.34 | 1.02 | 1.02 | 1.12 * | 1.12 |
| `andNot in place` | combine in place | 1.07 | 1.01 | 1.01 | 0.82 | 1.07 |
| `serialize` | serialize | 1.10 * | 1.06 * | 1.06 * | 1.05 * | 1.06 |
| `deserialize` | serialize | 1.61 | 1.14 | 1.14 | 1.26 | 2.35 |
| `runOptimize` | serialize | 1.25 | 0.84 | 1.25 | 1.06 | 1.14 |
| `iterate` | export | 0.99 | 1.10 | 1.00 | 1.05 | 1.26 |
| `toUint32Array` | export | 1.08 * | 0.99 | 0.99 | 0.96 | 0.96 |
| `toArray` | export | 1.01 * | 0.99 | 1.01 * | 1.00 | 1.00 |
| `clone` | clone | 1.08 | 1.01 | 1.05 | 1.05 | 1.43 |
| `clone then write` | clone | 1.32 | 1.03 | 1.10 | 1.15 * | 1.01 |
| `andCardinality` | count | 0.57 | 0.92 | 0.70 * | 0.65 | 0.97 |
| `orCardinality` | count | 0.61 | 0.21 | 0.51 * | 0.34 | 0.65 |
| `write after or` | write after combine | 2.67 * | 1.07 | 1.45 | 1.20 * | 1.09 |
| `write after xor` | write after combine | 3.02 * | 1.07 | 1.43 * | 1.18 | 1.07 |
| `write after andNot` | write after combine | 3.34 * | 1.05 | 1.38 * | 1.17 | 1.08 |

| The first call in a fresh process (`mixed`) | Class / native | Class / codec |
|---|---:|---:|
| `first deserialize` | 13.04 * | 1.19 * |
| `first build` | 2.35 | 1.01 |
| `first and` | 7.09 | 1.00 |

| `store.load(ref, { bitmap })` | Load (ms) | `serialize` (ms) | `deserialize` (ms) | Round trip, share of a load |
|---|---:|---:|---:|---:|
| dense | 1.02 | 0.028 | 0.141 | 16.1% |
| sparse | 2.34 | 0.044 | 0.427 | 20.2% |
| runs | 0.822 | 0.022 | 0.132 | 19.1% |
| mixed | 1.75 | 0.046 | 0.275 | 18.4% |
| spread8k | 13.5 | 0.418 | 2.00 | 18.3% |

\* The A/A control of this cell differed from the class by more than 2%, so the figure is not resolved.

Close to native (within 3 times native on every cell of the group, every control in band): has.
Not called close to native: build (worst 2.41 times, sparse build add per id; 1 cell(s) with a control out of band); combine returning (worst 2.90 times, dense and returning; 5 cell(s) with a control out of band); combine in place (worst 3.30 times, dense and in place; 3 cell(s) with a control out of band); serialize (worst 5.50 times, sparse deserialize; 4 cell(s) with a control out of band); export (worst 4.71 times, runs toUint32Array; 3 cell(s) with a control out of band); orMany (worst 22.82 times, dense orMany 64); clone (worst 4.46 times, runs clone then write; 1 cell(s) with a control out of band); count (worst 8.66 times, dense andCardinality; 2 cell(s) with a control out of band); compare (worst 19.44 times, runs isEqual); write after combine (worst 14.32 times, dense write after andNot; 6 cell(s) with a control out of band); cold (worst 13.04 times, cold first deserialize; 1 cell(s) with a control out of band).
More than 10 times native on some data set, so not shipped unless the maintainer decides otherwise having seen this table: `RoaringBitmap.orMany` (22.82 times, dense orMany 64); `isEqual` (19.44 times, runs isEqual); `RoaringBitmap.andNot` (14.32 times, dense write after andNot); `RoaringBitmap.deserialize` (13.04 times, cold first deserialize); `RoaringBitmap.xor` (12.62 times, dense write after xor); `RoaringBitmap.or` (12.43 times, dense write after or).

The class answered `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality` and `intersects` by the count kernels in this pass; the count kernels' own bench (`bench/count-kernels.cjs`) kept them: `andCardinality` took less time than building and counting on every operand-pair group it judges. The codec column of `andCardinality` and `orCardinality` is build-then-count, so a class figure below 1.00 there is a count that cost less than building the result and counting it on that data set.

Notes on rows that are not a like-for-like call:

- `deserialize` and `first deserialize`: the class caps the size and checks the layout of the bytes before it decodes them; the `roaring` package's decode is called with no validating option, so these rows compare the class with its check against native without one.
- `clone` and `clone then write`: the class's clone shares the containers and copies one on the first write that reaches it; native's clone copies everything at once. These rows are that policy difference, not two copies of the same work.
- `write after or`, `write after xor` and `write after andNot`: only the first operand's next write is timed, on an operand decoded fresh for each repetition, after a returning combine that flagged the containers it keeps by reference. The codec has no such flag, so its figure is the same write on an unflagged bitmap.
- `intersects overlapping` answers `true` at the first id the two bitmaps share: the codec walks the two key lists in order, compares the two containers of each key both hold, and returns at the first pair that has a value in common (a pair with none is passed over), so it times how fast each subject finds a first hit; `intersects disjoint` answers `false` after walking every key. `isSubset` and `isEqual` answer `true`, which is the full scan.
- `serialize` is held to identical bytes on every subject; every other answer is held to the same value.

<!-- BITMAP_API:TABLE:END -->

**A load reads your bitmap and never changes it.** `store.load(ref, bitmap)` and `store.load(ref, { bitmap })` serialize
it once, check and decode those bytes as any `{ serialized }` load does, and keep no reference to it. A bitmap decoded
from bytes another writer made keeps its run containers as they were, and one that serializes above the size cap is
refused by a load: call `runOptimize()` first.

### Decode portable bytes — `RoaringBitmap.deserialize(bytes)`

`RoaringBitmap.deserialize(bytes: Uint8Array, options?: RoaringBitmapDeserializeOptions): RoaringBitmap` decodes portable
Roaring bytes you hold (a Node `Buffer` is one) through the check a `{ serialized }` load makes first: the
537,403,396-byte cap, the structural check, exactly one bitmap (bytes after its last container are refused), and only then
the decoder. Use it for bytes that crossed a process boundary, in place of `RoaringBitmap32.deserialize`, which checks
nothing but its own reads. It is the one door for bytes: `new RoaringBitmap(bytes)` refuses them.

`{ maxBytes }` lowers the cap for a service that knows its inputs are small: bytes over it are refused before any is read.
A `maxBytes` above 537,403,396, or one that is not a non-negative integer, is refused, never honoured: there is no
trusting variant. The input is copied once before it is checked, so a buffer another thread is writing cannot pass the
check and then change, and the result keeps nothing of that copy: each container owns its storage, so a large input that
is decoded and then reduced with `andInPlace` can be freed.

It throws `ValidationError`, never `IntegrityError` (that is for a stored object that is damaged), for:

| Input | Message says |
|---|---|
| not a `Uint8Array` | the argument must be one |
| a zero-length or detached `Uint8Array` | an empty buffer is not a bitmap; `new RoaringBitmap()` is the empty set (a transport that lost the bytes does not become "no ids"; a bitmap with no ids has real bytes) |
| over 537,403,396 bytes, or over `maxBytes` | the size and the limit |
| not exactly one well-formed bitmap | the structural reason, with no container key or id in it |
| a second argument that is not `undefined` or an object whose only key is `maxBytes` | `deserialize` takes no format argument (the format is always portable), as a migrated call such as `deserialize(bytes, 'portable')` passes |
| a `maxBytes` that is not an integer from 0 to the cap | the rule |

<!-- typecheck-skip: a fragment: `bytes` and `ids` are the reader's -->
```ts
const checked = RoaringBitmap.deserialize(bytes); // ValidationError if malformed
checked.andInPlace(new RoaringBitmap(ids));       // the result is mutable
await store.load(ref, checked);                   // read, never changed or kept
```

The result is a mutable `RoaringBitmap`: code that shared one decoded bitmap between callers and relied on it not
changing hands out `has`, or a `clone()`, instead. [The parts recipe](loading.md#parts-of-one-segment-built-separately)
uses this. See also [using it by itself](roaring-codec.md#using-it-by-itself).

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.has(id)` → `Promise<boolean>` | membership: the cache, else **one** ranged GET of that id's chunk, once the segment's pointer and index are read (a first read of the segment makes those two first) |
| `seg.count()` → `Promise<number>` | cardinality of the generation the handle reads: **one registry read when cold, none when warm, and no read of the object**, since the row records the generation's id count. A row with no summary it can use sends it to the `.crbm` index instead, with **zero payload reads**. It trusts the row's summary, or the index: neither is confirmed against the payloads, and a summary is held against the object whenever the object is opened ([What `count()` trusts](reading.md#what-count-trusts)). A segment whose pointer names a missing object counts the row's number, and a read of the object throws |
| `seg.stat()` → `Promise<SegmentStat>` | `{ generation, cardinality, metadata?, sizeBytes }`, all four from one resolution of the generation the handle reads: its number, its id count, the metadata it was loaded with (absent when it has none), and `sizeBytes`, the bytes of its object in storage. They come from the row's summary, whose fingerprint carries the object's size: one registry read when cold, as a `count()` makes, and none while the segment is resolved; on an encrypted segment the key is unwrapped to open the summary, as for a count. A row with no summary it can use is answered from the object's footer and index instead (no payload read): a tail read more when cold, and a range read too for an index longer than the tail. A pinned handle answers from the object it pinned, which is open. `{ generation: null, cardinality: 0, sizeBytes: null }` for a segment with no generation; `sizeBytes: null` on a store whose source cannot report one. Answered from the row, a `stat()` reports the row's figures even when the object under its number is missing or another one, which every read of the object refuses and `checkConsistency` finds. `sizeBytes` is what [`groundedReport`](#offline-tools--cloudbitmapstools) prices storage from ([details](reading.md#stat-the-generation-its-count-its-metadata-and-its-size)) |
| `seg.iterate({ after?, through? }?)` → `IdStream` | stream all ids, ascending, reading ahead as ranges of the object (the window opens 1, 2, 4 and on up to 32 range requests wide). With `after` / `through`, only the ids in `(after, through]` and the chunks the range overlaps ([paging](reading.md#page-through-a-segment)) |
| `seg.everyNth(n, { after?, through? }?)` → `IdIterator` | **pinned handles only.** The ids at 1-based ranks `n`, `2n`, `3n` …, counted over the ids in `(after, through]`, ascending; a last partial window yields nothing. Reads the chunks that hold a boundary, each once, through `iterate`'s stream, window and budget; a range that cuts its first (or last) chunk reads that chunk too ([details](reading.md#every-nth-id-of-a-pin-everynth)). A live handle throws `UnsupportedError`, a bad `n` or bound `ValidationError`, and a chunk that is read and whose size disagrees with the index `IntegrityError`, each when first read. Chunks not read are trusted to their index counts, as `count()` trusts them. On a leased handle (`pin({ leaseUntil })`, `pinAt(at, { leaseUntil })`) it throws `LeaseExpiredError` past the lease: before its first pull, even when no rank falls in its range, and at each chunk ([leases](reading.md#hold-a-generation-for-a-job-a-lease)) |
| `IdStream` (what `iterate`, `intersect`, `union` and `andNot` return) | an `IdIterator` (an `AsyncIterableIterator<number>` with `return(value?)` and `throw(err)` typed): `for await` it for one id at a time, or drive it by hand with `next()`, `return()` and `throw()`, as a generator is driven. A handle that holds a lease returns the same shape. `.batches()` → `AsyncIterable<Uint32Array>` yields the same ids one chunk at a time, ascending, an array per non-empty chunk (at most 65,536 ids, 256 KiB) that is yours to keep ([batches](reading.md#read-a-chunk-at-a-time-batches)). The per-id stream is single-use; `batches()` starts its own read when called ([details](reading.md#read-a-chunk-at-a-time-batches)) |
| `seg.pin(options?)` → `Promise<Segment>` | **hold this segment at the generation current right now**, for the life of the returned handle, so a long job describes one instant ([pins](reading.md#read-one-fixed-point-in-time)). A hold, which a lease makes a bounded one: pass `{ leaseUntil }` (epoch milliseconds, at most 14 days out) to keep the generation out of a load's collection until then ([leases](reading.md#hold-a-generation-for-a-job-a-lease)); without one, size `keep` past your longest pinned job. Needs a `.crbm` reader, which the store builds over any backend or a bare `IStorageDriver`; a `StorageChunkSource` of your own throws `UnsupportedError` |
| `seg.pinAt({ generation, fingerprint }, options?)` → `Promise<Segment>` | **reopen a generation an earlier pin named**, as a pinned handle like the one `pin()` returns (identify it by `generation` and `fingerprint`; its `pinnedAt.version` can differ): pass that pin's `pinnedAt` as it is once `generation` is not `null`, or `{ generation, fingerprint }` from it. `pinAt` does not read `version`. A pin of a segment that had no generation (`pinnedAt.generation === null`) has nothing to reopen and throws `ValidationError`. The fingerprint is required, since a generation number is taken again after a purge and re-create: a bare number, a malformed fingerprint or an unknown key throws `ValidationError`. A generation that is gone (collected or purged) or on a destroyed segment, above the row's pointer (a rollback deletes nothing, so once a later load moves the pointer past a generation it rolled back from, that one can be reopened while its object is stored), or another object than the fingerprint names throws `NotFoundError`, and the call never reads empty. One row read and one tail read with a registry, plus one conditional write to the row when leased, and the tail read alone without one. It holds nothing unless you lease it: pass `{ leaseUntil }` as `options` (the same as `pin()`'s: epoch milliseconds, at most 14 days out; an unknown key in `options`, as in the first argument, throws `ValidationError`) and the lease is written before the object is verified and released if the verify fails. For a generation below the pointer, a collector that read the row before the lease landed can still delete it inside its own round trip, and the handle then fails with `NotFoundError`. Without a lease a later collection can delete the generation, so size `keep` on every writer ([pins](reading.md#reopen-a-pinned-generation-pinat), [leases](reading.md#hold-a-generation-for-a-job-a-lease)). Encrypted segments work as with `pin()` |
| `seg.intersect([other, …], { after?, through?, concurrency?, budget?, exclude?, allowAbsentOperands? })` → `IdStream` | chunk-skipping intersection, streamed. `[other, …]` must name at least one segment: an empty list throws `ValidationError` when first read (an intersection over nothing has no meaning; to read every id of one segment, use `iterate()`). Each operand's chunks are read as coalesced ranges: chunks within 256 KiB of each other come in one request, up to 1 MiB. `concurrency` is the range requests held ahead per operand (32 by default; the window opens 4 wide and widens as ranges are taken); on a source that reads chunk by chunk it is the chunk keys in flight (opening 8 wide). `exclude` subtracts suppression segments **in the same pass**. `after` / `through` bound the result to `(after, through]` on every operand and every exclude, as on `iterate` |
| `seg.union([other, …], { after?, through?, concurrency?, budget?, exclude?, allowAbsentOperands? })` → `IdStream` | `this ∪ others`, streamed. An empty `[other, …]` reads `this` itself. The one composite with **no chunk-skipping** — every chunk of every operand is read, or every chunk inside the range when one is given |
| `seg.andNot([sup, …], { after?, through?, concurrency?, budget?, allowAbsentOperands? })` → `IdStream` | `this \ (sup…)`. Reads all of `this`, or all of it inside the range, but each exclude **only where it overlaps** |
| *every combine, streamed or `*Into`* | **refuses an operand that names no segment, or one dropped, retired, crypto-shredded or destroyed in the clear**, `this` and every `exclude` included, with `ValidationError`, unless you pass `allowAbsentOperands: true` ([why](reading.md#combine-segments-intersect-union-andnot)); it also refuses, with `ValidationError` before any request, an operand, an `exclude` or a destination that this store did not make: a segment of another store, of a second store object over the same backend, or of another installed copy of `@cloudbitmaps/roaring`, which always belongs to another store ([as reading explains](reading.md#combine-segments-intersect-union-andnot)); `materializeMany` applies the same rule to every operand and every `dest`. Every read and combine here takes one options type, `CombineOptions`, and each takes the fields its row lists: a field it does not take, such as a write option (`audit`, `allowEmpty`, `guard`, `metadata`, `keep`) on a streaming combine or `exclude` on `andNot` or `andNotInto`, type-checks and is refused with a `ValidationError` naming it, before any request |
| `seg.intersectInto(dest, [other, …], opts?)` · `seg.unionInto(dest, [other, …], opts?)` · `seg.andNotInto(dest, [sup, …], opts?)` → `Promise<MaterializeResult>` | materialize the result as a **new generation of `dest`**, superseding it ([the `*Into` verbs](loading.md#write-a-result-into-another-segment-the-into-verbs)). `opts` is a `CombineOptions`: the combine's options, a range included, and `audit`, `keep`, `allowEmpty`, `guard` and `metadata`; `andNotInto` takes every one but `exclude`, since `[sup, …]` is its subtraction. A `dest` that is also `this`, an operand or an exclude, and an empty operand list for `intersectInto`, are refused with `ValidationError` before any request ([the destination cannot be a source](loading.md#write-a-result-into-another-segment-the-into-verbs): this release has no fenced in-place update, so write into a new segment and point readers at it; to copy, use `materializeMany` with one operand). An empty list for `unionInto` and `andNotInto` publishes `this`. An empty result over a non-empty `dest` is refused (`published: false`); a lost race throws `WriteConflictError`. Collects nothing unless you pass `keep`. Needs a backend |
| `seg.pinnedAt` | on a handle from `pin()` or `pinAt()`, the `PinnedAt` it is held at; `undefined` on a live handle. A `PinnedAt` is `{ generation: number; version: string; fingerprint: string }` for a pin of a generation and `{ generation: null; version: null; fingerprint: null }` for a pin of a segment that had none, so a check of `generation` narrows all three fields. Its `version` is the generation with the row's `pointerId`, so it is the same across a lease or a policy write, and two pins of one generation, leased or not, share one open |
| `seg.lease` | on a handle from `pin({ leaseUntil })`, the `Lease` it holds, `{ holder, until }` (`until` in epoch milliseconds); `undefined` otherwise |
| `seg.release()` → `Promise<void>` | end this handle's lease now, so a load's collection may take its generation. Idempotent: a handle with no lease, one already released, and one whose lease has ended make no request; otherwise one registry read and one write. Every read of the handle after it, and after the lease's own end, throws `LeaseExpiredError` |
| `seg.key()` → `string` | an opaque string that names the handle's segment, namespace included: two handles of one segment have the same key. Use it as a `Map` key or a log field; its format is unspecified, so compare keys and never parse one |

That's the whole daily surface: **1 constructor + a backend + `store.load` + these verbs.**

**What each combine reads, and what a read costs.** `intersect` skips every chunk that cannot contribute, `andNot` reads
the suppression side only where it overlaps, and `union` reads everything. All three are charged against the same per-op
budget. [Reading in depth](reading.md#combine-segments-intersect-union-andnot) has the table, and why you pass `exclude`
instead of chaining.

**Read consistency.** Every read resolves the segment's current generation once, before it fans out, and every chunk it
reads is a whole, checksum-verified generation object. A long call can still describe two instants, and an `iterate` or a
combine that meets a move lists the chunk keys of the generation it moved to and reads on from there
([a running read plans its keys again](reading.md#a-running-read-plans-its-keys-again-after-a-move)). To read one instant,
pin: `seg.pin()`. [How soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load) says what re-resolves a
segment mid-call and how the timed refresh behaves.

---

## Operations you call when you need them

### Store methods

A segment ref (the `ref` of `load`, `exists`, `generations`, `rollback`, `dropSegment`, `setRetention`, `getRetention`,
`clearRetention`, `invalidate` and the standalone `destroySegment`) is an object holding `{ segment, namespace? }`. Any
other own enumerable key, one whose value is `undefined` included, throws `ValidationError`, naming it and the keys a
ref takes, so a misspelt `namespace` never addresses the segment of that name in the default namespace. The one
exception is a row from `store.segments()`, whose `currentGen` and `status` a ref also takes so a listing row can be
passed straight back; they are read for nothing, and the call acts on the segment as the registry has it now. A segment
handle, an array and the result rows of other calls (a `checkConsistency` issue, an `eraseSubject` or `retireExpired`
ledger entry, an export manifest entry, an audit event) are not refs: build `{ segment, namespace }` from them. The
driver ports refuse the same way (see the driver kit below).

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace \| allNamespaces: true, concurrency?, budget? })` → `Promise<SubjectReport>` | GDPR Art. 15 — which registered segments is this id in, and which destroyed segments' leftover objects still hold it (`tombstones`)? Needs an explicit `namespace` or an `allNamespaces: true` ack, and throws `ValidationError` with neither or with both (the types refuse the pair too). A segment loaded with no `namespace` is reached only by `allNamespaces: true`: `'_default'`, the label the export tool and the disaster-recovery samples print, and the bucket's object keys use, for those segments, is an ordinary namespace name here, and scans a namespace of that name, not them. `concurrency` (default 8) is how many segments are scanned at once. Needs a backend |
| `store.eraseSubject(id, { namespace \| allNamespaces: true, audit?, concurrency?, budget? })` → `Promise<EraseSubjectResult>` | GDPR Art. 17: for every registered segment the id is in, **[rewrite the current generation without it](correctness.md#erasure-is-a-rewrite)** and [delete every generation that held the bit](correctness.md#every-holder-goes), so for each segment its ledger reports `erased: true` the bit is gone from the bucket on return (noncurrent versions, replicas and backups keep the old object until their own lifecycle removes it). It does not reach the uploaded part of a write that failed or was killed, which no listing shows. Returns the erasure ledger, one entry per segment the id was found in, or one whose erasure failed with an `error: ...` note; an entry with `erased: false` carries a `note` and is re-run ([erasure](erasure.md)). `concurrency` (default 8) is how many segments are erased at once. Needs a `namespace` or `allNamespaces: true`, not both (both, or neither, throws `ValidationError`; the types refuse the pair too), and a backend. A segment loaded with no `namespace` is reached only by `allNamespaces: true`: `'_default'`, the label the export tool and the disaster-recovery samples print, and the bucket's object keys use, for those segments, is an ordinary namespace name here, and scans a namespace of that name, not them. |
| `store.load(ref, input, { allowEmpty?, guard?, keep?, metadata?, audit?, sorted? })` → `Promise<LoadResult>` | **replace this segment's contents** with `input` (ids, `{ serialized }` or `{ bitmap }`) as one new immutable generation: next number, write, check, move the pointer, collect; `sorted: true` writes ascending ids one chunk at a time. **Branch on `published`**: a refusal is a normal outcome, not a throw ([why a load is refused](correctness.md#refusal-is-reported-not-thrown)). An `input` that is a stream of this library (`iterate`, `everyNth`, `intersect`, `union`, `andNot`, as returned) that read this same segment, in this store or one built over the same registry driver, throws `ValidationError`: a load of ids derived from the segment it writes is unfenced ([no fenced in-place update](loading.md#write-a-result-into-another-segment-the-into-verbs)); a copy from a store over another backend loads as any ids. Needs a backend |
| `store.materializeMany({ operands, outputs, keep, feed?, mayBeEmpty?, after?, through?, pin?, maxBufferedBytes?, budget?, publishConcurrency?, concurrency?, allowAbsentOperands?, dryRun? })` → `Promise<MaterializeManyRun>`, or `Promise<MaterializeManyDryRun>` with `dryRun: true` | **many `*Into` outputs from one chunk-ordered pass**: `operands` names stored segments, each of `outputs` is `{ dest, expr, exclude?, guard?, allowEmpty?, metadata?, audit?, keep? }` with `expr` an `Expr` (`string \| { and: Expr[] } \| { or: Expr[] } \| { andNot: Expr[] }`), and `keep` is required. `pin` defaults to `true`, `concurrency` (the range requests held ahead per operand) to 1 and `publishConcurrency` to 8. `run.outputs[i]` is what output `i`'s `*Into` would have returned (`MaterializeResult`) or `{ published: false, error }`, index-aligned; `run.stats` has the groups, requests (`rangeReads`, `chunkReads`, `registryReads`, `opens`, `publishes` and `attributed: { get, put }`, a lower bound), the budget used, memory, `maxRangesInFlight` (the most range requests in flight at once), `feed` (`{ records, keys, ids }`: what a feed delivered, when the call had one) and every operand's pinned, start and end generation and whether it moved. **`dryRun: true`** computes and judges every output as its publish would and writes nothing: each result is `{ dryRun: true, published: false, cardinality, cardinalityBefore, wouldRefuse? }` or `{ published: false, error }`, reading what the publishing call reads, without the writes ([a dry run](loading.md#look-before-you-publish-a-dry-run)). `dryRun: true` is typed as a dry run and `false` or absent as a publish; a `dryRun` held in a variable, a `boolean` or an optional one, is typed as either, and the flag says which. Every stored operand is pinned for the call by default (one generation per operand, not one instant), every pinned operand an output subtracts (its `exclude`, or after the first entry of an `andNot`) is re-checked, and one that was replaced gets its outputs `StaleOperandError`, and `maxBufferedBytes` (default 256 MiB) counts resident bytes, plan included, regrouping (and reading the operands again) when outputs do not fit; process memory is more than the count ([how much](loading.md#many-outputs-from-one-pass-materializemany)). `feed: { names, records, counts }` adds operands that arrive as records in chunk-key order (`records` is an `AsyncIterable<{ key, operands: Record<string, Uint32Array> }>`, `counts` required): every record is checked before the pass sees it, a bad feed refuses every fed output and publishes none, a fed call runs as one group and **requires `maxBufferedBytes`**, `mayBeEmpty` lists the fed names allowed to be empty, and an erasure in this store refuses a fed call with `StaleOperandError` (`reason: 'erased'`); the call waits as long as the producer takes, so an iterator or `counts` that never settles hangs it, stored-only outputs too, and an iterator's slow `return()` delays it, and a feed no output names is never read ([the feed](loading.md#operands-that-arrive-as-records-a-feed)). A set you hold is fed ([a set you hold](loading.md#a-set-you-hold-feed-it)). Throws `ValidationError` for bad input before any request ([details](loading.md#many-outputs-from-one-pass-materializemany)). Needs a backend |
| `store.exists(ref)` → `Promise<boolean>` | whether a read of this segment would find anything, as **one registry point read**. Not the same as `count() > 0` ([details](loading.md#does-this-segment-exist)). Needs a backend |
| `store.segments({ namespace? })` → `AsyncIterable<SegmentInfo>` | every segment the registry holds, **streamed**, optionally scoped to one namespace. An admin call, not a request-path one ([details](loading.md#does-this-segment-exist)). Needs a backend |
| `store.generations(ref)` → `Promise<GenerationEntry[]>` | every generation still in the bucket, ascending, with the current one marked (none is current on a destroyed segment): the set `store.rollback` can choose from ([details](loading.md#roll-back-a-segment)). The current entry also carries `cardinality` and `metadata` from its row, with no further request (an encrypted segment's need a keystore that opens its key); the others carry only their number. Every entry carries `known`: whether the row's record of the generations it published (`knownGens`) names it. A known generation needs no `allowUnknown`; an unknown one does, except below the pointer in the two cases the pointer alone decides (a row with no usable record, a target below a full one's bound). The row's word, with no object opened. Needs a backend |
| `store.rollback(ref, toGeneration, { audit?, allowUnknown? })` → `Promise<RollbackResult>` | **move the pointer** to a generation still in the bucket that the row knows it published, backwards or forward onto one an earlier rollback left: the one write that is not forward-only. A generation the row does not know throws `ValidationError` before any request to storage, and one whose object is not the one the row recorded (its footer checksum differs) throws `IntegrityError`, with or without a key; `allowUnknown: true` moves onto either anyway, needs the key on an encrypted segment (outside the two cases the pointer alone decides), and is audited with `unknown: true`. Two cases are decided by the pointer alone: a row with no usable `knownGens`, and a target below a full one's bound (its least recently current entry no lease names); a target below the pointer needs no flag and no key there. A generation a publish with a smaller `keep` no longer names but that stays in the bucket needs `allowUnknown`. A swap that met a conflict or got no answer is [settled by the row](correctness.md#rollback-settles-its-swap), on a registry that reports write tokens by the row's `pointerId` being the token of a swap the call sent, and is then checked, audited and reported as one that answered; one whose row does not show it (the pointer has moved past, or is at the target over another write's token, or, on a registry that reports no tokens, any conflict) throws `WriteConflictError` (after a conflict) or `TransientError` (after no answer), audits nothing and deletes nothing. The move back after a target that went is settled the same way, by the row's `pointerId` being the token of the move back, on a registry that reports tokens: the call throws `NotFoundError` either way, saying the pointer was put back or, when the row cannot show it (the read-back failed too, another write moved the row, the move back never landed and may yet, or the registry reports no tokens), that it may still name the target ([settled](correctness.md#settle-rollback)); it is never audited. Deletes nothing ([rollback](loading.md#roll-back-a-segment)). Audited as `segment.rollback`. Needs a backend |
| `store.dropSegment(ref, { confirmSegment, dryRun?, audit? })` → `Promise<DropResult>` | **retire a segment and reclaim its storage**: tombstone first, then every storage generation. Branch on `dropped`, and check `generationsRemaining` ([retire a segment by hand](retention.md#retire-a-segment-by-hand-storedropsegment)). Needs a backend |
| `store.setRetention(ref, { expiresAt })` → `Promise<SetRetentionResult>` | **record when this segment becomes eligible for retirement**: one policy write plus a best-effort write of its due-index pointer (and removal of the old one when the expiry day moves), no data deleted, nothing scheduled. `expiresAt` is an absolute epoch-millisecond instant you compute ([details](retention.md#record-when-a-segment-expires-storesetretention)). Needs a backend |
| `store.getRetention(ref)` → `Promise<RetentionPolicy \| null \| 'invalid'>` | the stored policy; `null` for none, `'invalid'` for a present-but-unusable `expiresAt` (a hand-edited row, a restore) so a malformed policy is visible rather than reading as "never expires". Needs a backend |
| `store.clearRetention(ref)` → `Promise<boolean>` | cancel the expiry; returns whether this call removed one (`false` also when a write that got no answer cannot be shown to be this call's: [details](retention.md#when-clearretention-answers-false)). A separate verb from setting one on purpose — "never expire" as a magic value passed to the setter is how a typo becomes a deletion. Needs a backend |
| `store.retireExpired({ namespace?, now?, limit?, dryRun?, scan?, lookbackBuckets?, shards?, totalShards?, maxScanSegments?, purgeTombstones?, tombstoneGraceMs?, audit? })` → `Promise<RetireExpiredResult>` | **the retention sweep**: retire every segment whose `expiresAt` has passed, each through `dropSegment`. Defaults: `limit` 100, `scan: 'fleet'`, `lookbackBuckets` 7. A `scan` other than `'fleet'` or `'index'`, a `lookbackBuckets` that is not an integer from 0 to 3,660 (on either scan), a `null` for `limit`, `tombstoneGraceMs` or `now`, a `totalShards` that is not a positive integer (even without `shards`), and `shards` that is empty or lists a number twice throw `ValidationError` before anything is listed. Further defaults: `purgeTombstones: true`, `tombstoneGraceMs` 86,400,000 (24 h; at least 3,600,000, one hour, or `ValidationError`: a shorter grace could purge a tombstone before a first load's create, sent again after it got no answer, arrived). A call you schedule, not a daemon; it returns a per-segment ledger, `purgeFaults`, the deletes the registry refused, and `firstPurgeFault`, the first one's reason; a refused purge is not charged to `limit`, and purging stops for the call after three refused in a row ([the sweep](retention.md#run-the-sweep-storeretireexpired)). Needs a backend |
| `store.checkConsistency({ namespace?, concurrency?, maxScanSegments?, summaries?, generations? })` → `Promise<ConsistencyReport>` | DR: verify every registered segment's `currentGen` `.crbm` is present, to catch a torn cross-store restore. With `summaries: true` it also opens each current object (one tail read each, sized from the summary) and reports `summary-mismatch` where the row's summary names another object by its fingerprint, or says another count, metadata or `tailBytes` than the object holds. With `generations: true` it also holds every generation the row's ledger of known generations (`knownGens`) names, the current one included, against its object, by the footer checksum the ledger records (one 104-byte footer read each, with no key), and reports `known-generation-mismatch`, with the `generation`, where the object under that number is not the one the row recorded: another object, or bytes that are not a `.crbm`, found by the footer's checksum (damage inside an object whose footer is intact, and a metadata change that keeps the footer's bytes, are not: a read of the generation reports the first). A segment adds at most 1 plus its ledger's length entries. A footer that fails its own checks is a mismatch, a driver's size that is not a byte count is an error of the segment; a named generation that is no longer in the bucket is not reported, and a row with a pointer whose ledger cannot be used is counted in `generationsUnchecked` ([details](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic)). `concurrency` (default 8) is how many segments it checks at once. Holds at most `maxScanSegments` registry rows resident (default 250,000) and throws `BudgetExceededError` with `option: 'maxScanSegments'` past it: narrow the scan with `namespace`, or raise the limit. Needs a backend |
| `store.preflight()` → `Promise<PreflightResult>` | **first-run check of the store's storage and registry**, run once before the first load: it reads the probe's registry row (which must be absent), writes one small probe object, writes the same key again (which must be refused), reads it back, lists it, deletes its own object (by version where the driver applies one) and asks the backend for its lifecycle verdict. Resolves to `{ ok, checks }`: `checks` always holds the seven checks `registry`, `write`, `write-once`, `read`, `list`, `delete`, `lifecycle` in that order, each `{ name, status: 'ok' \| 'problem' \| 'unchecked', detail }`, and `ok` is true when none is a `problem`. A finding never throws: a failed step, a transient fault included, is a `problem` whose `detail` says to run it again for a transient fault, except the lifecycle step, whose failures, its timeout included, are `unchecked`; the checks that need a failed step are `unchecked`. The lifecycle check is `unchecked` for a backend without `checkLifecycle()` (a third-party one, a `brandAsBackend` wrapper that does not forward it), for Azure Blob (it has the method and always answers `unchecked`), for an identity without the optional lifecycle permission, and when it has not answered in 30 seconds of the store's clock. Takes no options; about seven requests (eight on Azure Blob and, with a second listing that checks the bucket exists, on a first run on GCS). Not checked: a read after a delete, the registry's `If-Match`, the multipart abort permission, versioning, backups, the keystore and an S3 SDK from 3.641.0 to 3.699.0 ([the full list](production.md#what-preflight-does-not-check)). A probe left by a run that was cut off is named, never deleted. Throws `UnsupportedError` only for a store with no backend ([details](production.md#check-the-setup-with-storepreflight)) |
| `store.invalidate(ref)` → `void` | **drop what this store derived about a segment**, so its next read resolves the current generation afresh. The store's own writes do this for themselves; call it for what they cannot see ([details](reading.md#how-soon-a-reader-sees-a-new-load)). It also drops the segment's open chunk reads: callers already waiting on one still get its answer, and a dropped read is not written to the cache. No I/O |
| `store.exportSegments(sink, { format?, namespace?, ndjsonBatchBytes? })` → `Promise<ExportManifest>` | eject every registered segment's current generation to portable `roaring`/`ndjson` through your sink, each segment pinned for its export, so one file is one generation (one registry read per segment on a warm store). The store's own roaring codec builds the `'roaring'` bitmaps. `format` is `'roaring'` (the default) or `'ndjson'`; `ndjsonBatchBytes` (default 64 KiB, a whole number of at least 1) is how much ndjson text is gathered before each write to the sink. Needs a backend |

### Standalone functions (imported, called directly)

These take a backend's `registry` rather than a store, and have no store method: a crypto-shred needs only a registry, so a job
that holds one can run it. Every other verb is a store method.

| Call | Does |
|---|---|
| `readRetentionPolicy(record.retention)` → `RetentionPolicy \| null \| 'invalid'` | parse a policy out of a row you **already hold** — a fleet sweep over `registry.list()`, where `store.getRetention` would cost a read per segment. The three-way answer is the point: `'invalid'` lets a sweep *report* a malformed row instead of silently reading it as "never expires" or aborting the whole ledger |
| `destroySegment(ref, { registry }, { confirmSegment, allowCleartext?, audit? })` → `Promise<DestroyResult>` | crypto-shred one whole segment: one compare-and-swap removes its wrapped key from the segment's current registry row, and the objects stay in the bucket. Every copy of the objects, backups and WORM copies included, is unreadable once no retained copy of that row holds the wrapped key (noncurrent versions, backups and point-in-time copies of the row), or once every KEK that wrapped it is destroyed; until then a registry restore to a point before the shred undoes it ([encryption & DR](disaster-recovery.md#encryption--dr)). A cleartext segment has no key, so without `allowCleartext` the call changes nothing and returns `reason: 'cleartext'`, and with it the call writes the tombstone and leaves the objects readable in the bucket. A free function over `backend.registry`, so it invalidates no store ([details](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)) |
| `eraseNamespace(namespace, { registry }, { confirmNamespace, allowCleartext?, audit?, maxScanSegments? })` → `Promise<{ destroyed: DestroyResult[] }>` | crypto-shred an entire namespace or tenant. It lists the namespace first and stops at `maxScanSegments` (default 250,000) with nothing erased, then shreds eight segments at a time. One `DestroyResult` per segment, in the order the registry listed them (unspecified: match by `segment`), with faults recorded rather than thrown, so **inspect it** ([details](encryption.md#erase-a-segment-or-a-namespace-crypto-shred)) |
| `excludingReservedRows(listing)` | wraps a `registry.list()` stream and drops the bookkeeping rows (the due-index pointers). **Every unscoped fleet-wide enumeration must apply it** — `store.segments` and the sweep already do, so this is for a fleet pass you write yourself |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId, recoveryKeyId? })` (any other option, a non-object `keys` and a non-string key id throw `ValidationError`) | `encryption.keystore` (store) | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; omit the option for the no-op) | `metrics` | observability — `storage.get` / `cache` / `retry` / `intersect` / `op` / `advisory` events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; omit the option to record nothing) | `audit`, on each call that writes: `store.load`, the `*Into` verbs, `store.rollback`, `store.eraseSubject`, `store.dropSegment`, `destroySegment`, `eraseNamespace` and `store.retireExpired` | compliance trail — `segment.publish` / `segment.load-refused` / `segment.rollback` / `segment.rewrite` / `segment.collect` / `segment.erase` / `segment.tombstone` / `segment.dispose` / `namespace.erase`; each `segment.*` event carries the row's `incarnation` |

`segment.collect` is what `eraseSubject` emits when it deletes generations and rewrites none: an id held only outside the current generation, objects left under a tombstone, a first load's object on a segment with no generation yet, or only objects no read of the segment can open. `fromGeneration` is the newest generation it found holding the id and is absent when it found the id in none; `collected` lists the generations it deleted. A switch over `AuditEvent['kind']` handles it beside `segment.rewrite`.

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `export-segments` | eject all registered segments from a local-filesystem store to a directory. `--help` (or `-h`) prints the settings and exits 0, also after a leading `--`, which `pnpm run` forwards; any other argument exits 2. Env: `CR_EXPORT_ROOT` (required; holds `storage/` + `registry/`), `CR_EXPORT_OUT` (required), `CR_EXPORT_FORMAT` (`roaring` \| `ndjson`, `roaring` when unset or empty), `CR_EXPORT_NAMESPACE` (optional). It wires no keystore, so an encrypted segment is recorded in the manifest's `failed[]`: export an encrypted store with `store.exportSegments` from a store built with its keystore |

---

## Types in signatures

The option / result types the public methods above reference — you import these to annotate variables.

### Construction & result types

`CloudRoaringOptions` and its four groups — `CacheOptions` · `EncryptionOptions` · `RetryOptions` ·
`SeamOptions` (`metrics` and `budget` are flat options taking `IMetricsSink` / `BudgetOption` directly) · `SegmentOptions` ·
`SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `MaterializeResult` (`{ generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size, collected }` — what an `*Into` verb
wrote)

The fields of each result type are described with its call: `DropResult` in
[Retention](retention.md#retire-a-segment-by-hand-storedropsegment), `SetRetentionResult` in
[Retention](retention.md#record-when-a-segment-expires-storesetretention), `RetireExpiredResult` in
[Retention](retention.md#run-the-sweep-storeretireexpired), `ConsistencyReport` and `ConsistencyIssue` in
[Disaster recovery](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic), `PreflightResult` and
`PreflightCheck` in [Production](production.md#check-the-setup-with-storepreflight), `ExportManifest` in
[Export](export.md), and `EraseSubjectResult` and `SubjectReport` in [Erasure](erasure.md).

`CloudRoaringOptions`, in full — **one required key, four optional groups, and two flat options**:

| key | type | what it holds |
|---|---|---|
| `storage` **(required)** | `StorageBackend \| IStorageDriver \| StorageChunkSource` | where everything lives |
| `cache?` | `CacheOptions` | `maxChunks?` (decoded chunks held in RAM, an integer of at least 1, default 1024) · `ttlMs?` (the longest a decoded chunk is kept, in ms, counted from when it was cached and not renewed by a hit, a finite number above 0; off by default, so a chunk stays until the count bound evicts it; it is not how soon a reader sees a new load, which is `genTtlMs`) · `genTtlMs?` (default 2000 ms; [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load); needs a backend) · `readerMax?` (open `.crbm` readers, an integer of at least 1, default 1024; with a timed refresh, 8 × as many segments' resolutions are kept apart from them) · `readerMaxBytes?` (an integer of at least 1: their parsed indices, any metadata they hold, a fixed 3.75 KiB each for the objects around the index, and the chunk bytes a reader keeps of a small generation, default 64 MiB; a sixteenth of it bounds the resolutions) |
| `encryption?` | `EncryptionOptions` | `keystore?` · `required?` — both need a backend, since the wrapped DEK lives in the registry |
| `retry?` | `RetryOptions \| false` | a **partial** `RetryPolicy`: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `backoffFactor` and `jitter`. Anything omitted keeps its default (`maxAttempts` 4, `baseDelayMs` 50, `backoffFactor` 2, `jitter` `'full'`), except `maxDelayMs`, which is 2000 ms, or `baseDelayMs` when that is larger. The store checks the policy when it is built and throws `ValidationError` unless `maxAttempts` is a whole number of at least 1, `baseDelayMs` a finite number of at least 0, `maxDelayMs` a finite number of at least `baseDelayMs` (50 ms unless you set it), `backoffFactor` a finite number of at least 1, and `jitter` `'full'` or `'none'`. Plus `onRetry?`, for the transient retry of every read that answers a query, and of the reads a load's guard and an erasure make along the way; `false` turns it off. It does not govern writes: a write is retried only where that is safe, and not by this option ([Resilience](#resilience-the-store-wires-this-by-default)) |
| `metrics?` | `IMetricsSink` | typed metric events; defaults to a no-op |
| `budget?` | `BudgetOption` | `{ maxRequests }`, a whole number of at least 1 (default 1,000,000), or `false` |
| `seams?` | `SeamOptions` | `clock?` · `rng?` · `entropy?` — determinism, for tests and replayable jobs; `entropy` draws each written cleartext generation's write identity (Web Crypto by default; an encrypted generation draws none) |

**A key the store does not take is refused rather than ignored**, at the top level and inside each group, and the
error names each one and lists the keys the store or the group does take. A group's key written at the top level
(`keystore` for `encryption.keystore`) and a typo inside a group (`cache.maxChunk`) are both knobs whose absence
would be silent — a dropped `encryption.required` reads cleartext, a dropped `seams.clock` makes a deterministic
job non-deterministic — so being ignored would be worse than being rejected. `S3Storage`, `GcsStorage` and
`AzureBlobStorage` each refuse a key they do not take the same way, naming it and the keys they take: a client
goes in `client` (`containerClient` on Azure), so `GcsStorage` refuses `storage`, and each refuses another
backend's size setting, such as `S3Storage` refusing `blockBytes`. They refuse a setting beside a client the same way: a `client` carries its own
connection settings, so `S3Storage` refuses `region`, `endpoint`, `pathStyle`, `credentials` and `maxSockets` beside it, and
`GcsStorage` refuses `projectId` and `apiEndpoint`, each named. Configure them on the client, or drop `client`.

Batch combine types: `Expr` is an expression over a call's operands; `MaterializeManyOptions` and `MaterializeManyOutput` type its argument, `MaterializeManyFeed` and `MaterializeManyFeedRecord` the operands it is fed, `MaterializeManyRun` its result, `MaterializeManyOutcome` one output's result (a `MaterializeResult` or `{ published: false, error }`), and `MaterializeManyStats`, `MaterializeManyOperandStats` and `MaterializeManyOutputStats` its `stats` ([details](loading.md#many-outputs-from-one-pass-materializemany)).

### Generation bookkeeping & erasure

`PinnedAt` (`{ generation, version, fingerprint }` — what a pin holds for one segment; `version` is opaque, the generation with the row's `pointerId` it was resolved under; `fingerprint` names the object it pinned, so a replaced one is refused, and is required: it is `null` only when `generation` is `null`, `seg.pin()` always records it, and a pin of a generation built by hand without a string `version` and `fingerprint` throws `ValidationError`; `generation: null` means the segment had none to pin and the handle reads empty, **not** that pinning is unsupported) · `EraseDeps` · `DestroyResult` · `DropResult`

### Retention

`RetentionPolicy` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` ·
`RetireEntry`

`expiresAt` and the sweep's `now` have a floor, `1_000_000_000_000` epoch milliseconds (2001-09-09): anything smaller is
almost certainly epoch *seconds*, which reads as already-expired, so `setRetention` and `retireExpired` throw
`ValidationError` for it.

### Export / eject

`ExportSink` · `ExportWriter` · `ExportFormat` · `ExportOptions` · `ExportedSegment` · `ExportFailure` ·
`ExportSkipped` · `ExportManifest`

`ExportWriter.write` receives each NDJSON chunk as a plain `Uint8Array`, not a Node `Buffer`: a writer that wants text
decodes it with `new TextDecoder().decode(bytes)`.

### Observability

`IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent`

`MetricOpName` is `'has' | 'count' | 'intersectInto' | 'unionInto' | 'andNotInto' | 'materializeMany'`;
`MetricsSnapshot` is `{ storage, cache, retries: { transient }, intersect, ops }`.

### The storage interfaces (used to type `storage` / `registry`)

From `@cloudbitmaps/roaring`: `SegmentRef` · `RetryPolicy` · `Clock` · `Rng`.

From `@cloudbitmaps/core/driver-kit`, the one home of the driver contracts: `StorageBackend` · `IStorageDriver` ·
`IRegistryDriver` · `StorageChunkSource` · `IKeystore` · `TailRead` (what `getTail` answers:
`{ bytes, size, version? }`) · `StorageDeleteOptions` (`{ ifVersion? }`, what `delete` takes), and the registry's record
types ([below](#low-level-ports--capabilities-driver-author-typing)). The flavor's signatures name them and it does not
re-export them. Importing one makes `@cloudbitmaps/core` a direct dependency of yours: install it at the version of
`@cloudbitmaps/roaring` you install, so one copy serves both. Or derive the type from what the flavor exports, with no
dependency to add:

<!-- typecheck -->
```ts
import type { CloudRoaringOptions, EncryptionOptions, MemoryStorage } from '@cloudbitmaps/roaring';

type Storage = CloudRoaringOptions['storage']; // StorageBackend | IStorageDriver | StorageChunkSource
type StorageDriver = MemoryStorage['storage']; // IStorageDriver
type RegistryDriver = MemoryStorage['registry']; // IRegistryDriver
type Keystore = NonNullable<EncryptionOptions['keystore']>; // IKeystore
```

### Read and combine options (used to type `iterate`, `everyNth`, `intersect` / `union` / `andNot` and the `*Into` verbs)

`CombineOptions` (`{ after?, through?, concurrency?, budget?, allowAbsentOperands?, exclude?: Segment[], audit?, allowEmpty?, guard?, metadata?, keep? }`, every field optional) — one type for every read and combine, each taking the fields that apply to it:

| verb | takes |
|---|---|
| `iterate`, `everyNth` | `after`, `through`: their parameter is `Pick<CombineOptions, 'after' \| 'through'>`, which `MaterializeManyOptions` extends too |
| `intersect`, `union` | the range (the ids in `(after, through]`), `concurrency`, `budget`, `allowAbsentOperands`, `exclude` |
| `andNot` | the same but `exclude`: its `[sup, …]` is the subtraction |
| `intersectInto`, `unionInto` | every field |
| `andNotInto` | every field but `exclude` |

`audit`, `allowEmpty`, `guard`, `metadata` and `keep` decide what an `*Into` verb publishes; the streaming verbs write nothing and emit nothing. A field a verb does not take is refused with a `ValidationError` that names it, before any request, whether the object holds it as an own key, inherits it from a prototype or holds it in a getter: a streaming read fails when it is first read, and an `*Into` verb rejects.

---

## Offline tools — `@cloudbitmaps/tools`

```bash
pnpm add @cloudbitmaps/tools
```

The cost model, in a package of its own: offline tools that read and write no store and need nothing internal from
one. It depends on `@cloudbitmaps/core` alone, for `ValidationError`, which is what every refusal below throws. It is a
planning tool: the price lists are as old as the release that ships them, so pass your own for a decision that turns on
the price. The [cost guide](cost.md) is the whole model.

| Call | Does |
|---|---|
| `estimateCost({ segments, workload?, pricing? })` → `CostReport` | **plan**: price segments you describe (`{ sizeBytes }`, or `{ cardinality }` at 2 bytes an id, each with a `count`; a segment with neither is refused, so pass `sizeBytes: 0` for one that stores nothing, and `sizeBytes` wins when both are given) under a workload, with no store at all. `pricing` defaults to `AWS_US_EAST_1_ONDEMAND` |
| `groundedReport({ storageBytes, workload?, pricing? })` → `CostReport` | **ground**: price a measured byte total, such as the `sizeBytes` a segment's [`stat()`](#the-segment-verbs-the-90-of-daily-use) reports, `groundedReport({ storageBytes: (await seg.stat()).sizeBytes })`. `storageBytes: null`, which `stat()` answers for a segment with no generation and on a store that cannot report a size, prices storage at $0 with `assumptions.grounded: false` and a note saying nothing was measured. Sum several segments' sizes to price them together |
| `AWS_US_EAST_1_ONDEMAND` | the default `PricingProfile`: AWS us-east-1 on-demand object-storage prices, with Redis sized to the data from the catalogue below. Frozen; spread it to change a field |
| `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND` | the `RedisSizing` the default profile prices Redis from: ElastiCache for Redis OSS node prices from AWS's public price list (the version is in its `source`), every shard a primary and two replicas, 25% of each node's memory reserved |
| `ONE_REDIS_HA_CLUSTER` | `{ monthlyUSD: 346 }`: one ElastiCache HA cluster (a primary and two replicas of `cache.m7g.large`), the fixed Redis the benchmarks page charts. Pass it as `pricing.redis` to compare with it whatever the data size |

`CostReport` also carries `verdict` (`'win-big'`, `'win'` or `'lose-zone'`) and `rationale`, one sentence saying why.

`CostReport` · `PricingProfile` · `RedisSizing` · `RedisNodeType` · `Workload` · `SegmentSizing` · `EstimateInput`

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
conditionalDelete? }` (`cacheHitRate` is a fraction from 0 to 1, and `operandsPerIntersect` and `readerProcesses` are at least 1; a value outside that throws `ValidationError`); `CostReport.monthlyUSD.byOp` is `{ reads, intersects, storage, loads, pointerRefresh, retention }`; `redisBaseline` is `{ basis: 'fixed', monthlyUSD }` or
`{ basis: 'sized-to-data', monthlyUSD, cluster: { nodeType, shards, nodes, dataTiering } }`, the Redis the verdict
compares against, with the last of `assumptions.notes` saying how it was priced; and
`redisCrossover.readsPerSec` is the sustained read rate at which pay-per-use passes it, net of storage and the pointer
refresh (≈329 reads/s against `ONE_REDIS_HA_CLUSTER` with a 0% cache-hit rate). What each term counts is in the
[guide](cost.md#what-each-term-counts), and what the verdict compares against
[beside it](cost.md#what-it-compares-against). If your store sets `cache.genTtlMs`, pass it as `Workload.genTtlMs`; the model
prices the pointer refresh at the store's default, 2 s, otherwise.

---

## Advanced / driver-author surface

You **do not** import these to _use_ CloudBitmaps — only to **write a driver**, or to build tooling
against the on-disk format. Each section says where its names import from. The driver contracts come from the
[driver kit](#driver-kit--what-you-need-to-implement-a-driver), `@cloudbitmaps/core/driver-kit`, their one home;
the cloud drivers' option types come from `@cloudbitmaps/s3`, `/gcs` and `/azure-blob`; and the few the store's own
signatures name (`RetryPolicy`, `EraseDeps`) come from `@cloudbitmaps/roaring`. The main entry of `@cloudbitmaps/core`
and its `/node` subpath are internal: they are outside the stability promise and are not documented here, and neither are the `.crbm` reader, its
crypto pair and the codec seam it exports.

### `.crbm` on-disk format

**`CRBM` stands for Chunked Remote BitMap** — chunked because 16-bit chunks are the data model, remote because
every structural choice exists for storage that is far away and billed per request (range-GET a single chunk,
`count()` straight from the footer index without reading payloads, a speculative tail read that collapses `open()`
to one GET), and bitmap because that is what a chunk holds.

The name is deliberately **not** tied to a codec. `.crbm` is the container for any flavor — the footer index, the
CRC32C checksums, the AES-GCM framing and the generation model are all codec-independent, and only the chunk
payload bytes would differ. Roaring is the one codec that ships.

**The byte layout** of the object (the preamble, the chunk payloads, the index, the footer, the checksums and the
sealing) and the registry row that points at it are in [the format reference](../format.md); this section covers the
name, the version and the extension block.

**Format version.** Every object is format **1.0**: the preamble, the chunk payloads, the index and the fixed
104-byte footer. A reader refuses an unknown major version, and refuses an object whose footer sets a flag bit it does
not know. A generation written with metadata carries one **extension block** between the last payload and the index,
and its footer sets the `FLAG_EXTENSION` bit (`1 << 3`); with no metadata the writer emits no block and
leaves the flag clear.

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
- **Encrypted.** The section is sealed like the index (AES-256-GCM, `nonce ‖ ciphertext ‖ tag`, under the
  associated data of the metadata scope, [section 8 of the format reference](../format.md#8-encryption-at-rest)), so its content cannot be read or altered without the key; its length, like
  the index's, stays visible. That the block is there at all is not authenticated: the flag, the trailer and the
  section types are covered by CRCs, which take no key, so whoever can write the object can remove the block, and the
  object then reads as one with no metadata.
- **The write identity.** Bytes 40 to 51 of the footer, the `indexNonce` field, are random per write in every object.
  An encrypted generation keeps the AEAD nonce of its sealed index there, as it always has. A cleartext generation
  stores 12 bytes its writer drew from a random source, once, when it was constructed (so a source that returns the
  wrong shape fails before the first byte is uploaded), and the field is otherwise unused. The footer's CRC32C covers
  it, so the object's fingerprint (`<size>:<footer checksum>`) names one write, to the 32 bits of that checksum (two
  writes of the same ids share a fingerprint with probability about 2^-32): two loads of the same ids at the same generation number are two objects with two fingerprints, and a row's
  summary, a pin, a `knownGens` entry or a check that "this footer is mine" each name that write. A reader neither
  checks nor branches on the field for a cleartext object: an object whose field is all zero
  names no write, and reads exactly as any other, with the fingerprint its bytes give. The format version is still
  1.0, and a port writing objects fills the field with random bytes (never a constant, which makes its objects alike
  again) and leaves reading alone.
- **What a reader refuses**, with `IntegrityError`: a flag with no valid block; a block whose trailer, CRC, size or
  sections do not hold;
  metadata that breaks a rule or is not exactly its canonical form; a payload that runs into the block; and any
  object that is not encrypted when it is opened with a key. It reads the block with the index, from the tail or in
  the same range read, and makes one more read only when the tail ends inside the block.

**Reading an object yourself.** The reader the store uses is internal, so a tool of your own reads a `.crbm` from
[the format reference](../format.md), which specifies every byte, or reads a segment through the store or
`exportSegments`, which hand you ids or portable Roaring bytes.

### Bitmap-codec seam

The engine is **codec-agnostic** behind an internal seam; roaring is the one codec that ships, and there is no
supported way to add another from outside. The `CloudRoaring` facade binds the roaring codec for you, and no public
signature names the seam.

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

<!-- typecheck-skip: a fragment: the page leaves `MyRegistryDriver`, `MyStorageDriver`, `MyStorageOptions` to the reader -->
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

**How to depend on core.** The drivers in this repository depend on it at the exact version they release with (`workspace:*` in the source, published as `X.Y.Z`), as `@cloudbitmaps/roaring` does, so a consumer who installs one version of every `@cloudbitmaps/*` package resolves one copy; a tree holds two when the versions differ. A driver released on its own schedule has no such guarantee:
a plain range of its own can resolve to a second copy beside the consumer's, which is the case described under
[Errors](#errors-typed--you-catch-these) where `instanceof` stops holding. A peer dependency, with a dev dependency
to build against, makes the consumer's copy the only one:

```jsonc
{
  "peerDependencies": { "@cloudbitmaps/core": "^<the minor you build against>" },
  "devDependencies": { "@cloudbitmaps/core": "^<the same>" }
}
```

**On correctness, know what you cannot run.** The conformance suite the in-repo drivers are held to
(`packages/roaring/src/testing/conformance.ts`) is *not* exported as a public subpath, so a third-party driver cannot
execute it. The load-bearing behaviours to reproduce by hand are: a conditional create that **refuses** rather than
overwrites (hard invariant 2 — this is the one that silently loses data if you get it wrong), ranged reads that return
exactly the requested bytes, a compare-and-swap on the pointer row that reports a lost race rather than clobbering, a
delete that removes a row only while it is the version the delete read, if you report `conditionalDelete: true`, a
storage delete given `ifVersion` that removes only the object that version names, refuses another with
`WriteConflictError` and takes an absent one as a no-op, a ref or key with a field that is not a ref's (a misspelt
`namespace`), and a delete or write option that is not the port's or has the wrong type, refused with `ValidationError`
before anything is read or written (the in-repo drivers are held to this by the suite; `validateSegmentRef`,
`checkDeleteOptions` and `checkRegistryWriteOptions` do it), if your storage reports `conditionalDelete: true`, if you
report write tokens, a `create` and a `compareAndSwap` that call `onToken` before sending anything that can land, so
that one whose `onToken` throws leaves the row untouched, and the four `currentGen: null` obligations listed below.

</details>

**Pairing halves of your own.** An application gets both halves from one backend class, which builds them from one
bucket and one prefix so they cannot disagree. A driver author who wants a backend of halves of their own — a
backend's `.storage` wrapped for auditing, metrics or tenant scoping, or paired with a registry in a database you
already run — brands a plain object with the ports:

<!-- typecheck-skip: a fragment: the page leaves `CloudRoaring`, `auditing`, `inner` to the reader -->
```ts
import { brandAsBackend } from '@cloudbitmaps/core/driver-kit';

const backend = brandAsBackend({ storage: auditing(inner.storage), registry: inner.registry });
const store = new CloudRoaring({ storage: backend });
```

`brandAsBackend` cannot check that the two halves agree: `IStorageDriver` and `IRegistryDriver` expose no location, so
nothing can compare one. Branding them is you taking that on.

| Symbol | What it does |
|---|---|
| `IStorageDriver` · `IRegistryDriver` | the two ports a driver implements — the object tier and the pointer row. A registry driver that does NOT extend `ObjectStoreRegistry` also needs `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord`, `RegistryPatch` and `RegistryWriteOptions` to write its method signatures; `driver-kit` exports them, with every type a row's fields name, so a driver imports nothing from `@cloudbitmaps/core`'s main entry. A registry may set `reportsWriteTokens` and call the `onToken` of `RegistryWriteOptions` before each write it sends, so a publish can tell its own write from another writer's (above). |
| `StorageBackend` · `StorageCaps` · `SegmentRef` · `GenKey` | the backend pair, a driver's declared capabilities, and the two key shapes. A backend may also carry an optional `attachMetrics(sink)`: a store given a `metrics` sink calls it once, as it is built, so the backend can send that sink an `advisory` event about its own setup (the S3 backend's socket pool does). A backend without it is never told. It must not throw: an exception propagates from the store's constructor. A backend may also carry an optional `checkLifecycle()`, which resolves to a `LifecycleVerdict` and never rejects: it reads the bucket's lifecycle rules (S3 and GCS, one request plus the SDK's own retries, under `readTimeoutMs`) and says whether one would delete or archive what the store keeps. Azure Blob is always `unchecked` (its policy is on the management plane), `MemoryStorage` and `LocalFsStorage` are `ok`; a backend without the method offers no lifecycle check, and `store.preflight()` reads it as `unchecked`. See [check the lifecycle rules from code](production.md#check-the-lifecycle-rules-from-code) |
| `TailRead` · `StorageDeleteOptions` | what `getTail` answers (`{ bytes, size, version? }`, `version` being the object's as the backend names it: an ETag, a GCS object generation) and what `delete` takes (`{ ifVersion? }`); see `StorageCaps.conditionalDelete` below |
| `LifecycleVerdict` | what `checkLifecycle()` resolves to: `{ status: 'ok' \| 'problem' \| 'unchecked', detail: string }`. Act on `status`; `detail` is a sentence for a person and carries no credential. `ok` can still carry advice (a missing abort rule for incomplete S3 uploads); `problem` is a rule that would delete or archive current objects, or one the check cannot tell apart from it; `unchecked` is a check that could not be made (no permission, an error, or Azure Blob) |
| `IMetricsSink` · `MetricEvent` · `MetricOpName` | the sink `attachMetrics` receives, the event union it emits to, and the operation names an event carries |
| `Entropy` | `(length) => Uint8Array`, the randomness `ObjectStoreRegistry` draws its tokens from when one is injected (below) |
| `brandAsBackend` · `STORAGE_BACKEND` | stamp the cross-package brand on a backend, and the symbol a backend class declares it with. A store accepts a backend by brand, never by `instanceof`, so a backend built in one package is recognised in another. It checks that `storage` has a `putImmutable` and `registry` a `compareAndSwap`, throwing `ValidationError` otherwise, or when the object is frozen or non-extensible, and returns the object it was given. It takes a class (`brandAsBackend(this)` in the constructor) or a plain `{ storage, registry }` object, which is how halves of your own are paired — see below |
| `Token` | the opaque compare-and-swap token (unique per write with overwhelming probability, since it carries random parts; compared by equality only; ABA-safe across delete→recreate) |
| `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` · `RegistryWriteOptions` · `RegCaps` | the row a registry stores and returns, the row `create` takes, the patch `compareAndSwap` applies, the options both writes take (`held`, `onToken`, above), and what `capabilities()` reports; their fields' types (`RegistryStatus`, `RegistrySummary`, `KnownGeneration`, `LeaseEntry`, `GovernanceMeta`, `GenerationMetadata`, `WrappedDek`) are listed under [low-level ports](#low-level-ports--capabilities-driver-author-typing) |
| `StorageChunkSource` | the read-source port: a store takes one of your own as its `storage`, read-only. Its methods name `ChunkRef`, `ChunkRead`, `ReadChunksOptions`, `SegmentSize` and `GenerationSummary`, all exported here |
| `IKeystore` | the keystore port, what `encryption.keystore` takes: `createDek()` and `openDek(wrapped)`, naming `WrappedDek`, `Aead` and `AeadSealed`, all exported here |
| `RESOLVED_FIELDS` · `renewsPointer` · `renewPointer` · `pointerIdOf` | a row's `pointerId`, the token of the last write that named a field a read resolves through, at any value. `RESOLVED_FIELDS` are the five a read resolves through (`currentGen`, `status`, `wrappedDeks`, `keyId`, `summary`); `renewsPointer(patch)` says whether a compare-and-swap of that patch sets `pointerId` to the token it returns (it names one of them, by presence, at any value); `renewPointer(row)` is the patch that renews it and changes nothing a read resolves (`{ currentGen: row.currentGen }`); `pointerIdOf(row)` reads it and throws `UnsupportedError` for a row with none. A registry that builds its own records sets `pointerId` to the token of every create, and of every compare-and-swap for which `renewsPointer` is true, and keeps it on every other write. `ObjectStoreRegistry` already does |
| `ObjectStoreRegistry` | compare-and-swap over a plain object store. Every cloud registry driver is a thin adapter over this, which is why all three pass one conformance suite — the OCC semantics live here, not in the drivers |
| `ObjectRegistryStore` · `ObjectRow` | the minimal store a driver hands `ObjectStoreRegistry`, and the row it persists: `read`, a conditional `write` and `listKeys`, and optionally `delete(key, { version })`, a delete the backend applies only while the object is at exactly that version, with `conditionalDelete: true` to say the backend can be relied on to. With both, `ObjectStoreRegistry` removes a row rather than tombstoning it, and reports `conditionalDelete: true` in its `capabilities()`. |
| `ObjectVersionRaced` · `MAX_ROW_BYTES` | the sentinel a store that reads a row in two calls throws when a write lands between them, which `ObjectStoreRegistry` answers by reading again (no shipped store raises it: each reads a row in one request), and the hard cap on a serialized row |
| `normalizeObjectPrefix` · `prefixPart` | prefix normalization, so `cr`, `cr/` and `/cr/` address the same place |
| `encodeNameForKey` · `namespaceKeyPart` | how a segment name and namespace become an object key. With `storageObjectKey` and `segmentObjectPrefix` (below) they are all a driver needs to key a segment: core's `segmentKey`, an in-process map key, stays on core's internal entry and does not move to `driver-kit` |
| `encodeNameForPath` | percent-encode a name for use as a **filesystem path component**. Escapes everything `encodeNameForKey` does plus `:` (an NTFS alternate-data-stream separator on Windows), plus three hazards that are properties of the whole component: `.`/`..` traversal, Windows reserved device names (`CON`, `NUL`, `COM1`…, reserved with *or without* an extension), and a trailing dot or space, which Windows silently strips so two names would collide on one path. Use it if you write your own filesystem `ExportSink`, so your dump matches the drivers' layout. **If you decode these names back, require the encoding to round-trip** (`encodeNameForPath(decoded) === raw`) rather than trusting a decode — percent-decoding accepts spellings the encoder never emits (a lowercase escape, say), and without that check a planted entry can alias a real one |
| `namespacePathPart` | the physical namespace component of a **path**: the caller's namespace **encoded**, or the `_default` sentinel emitted **literally**. That asymmetry is load-bearing — encoding the sentinel too would send an absent namespace to `%5Fdefault`, exactly where a caller who names their namespace `_default` already goes, and the two would read each other's data. Use it rather than encoding `ns ?? '_default'` yourself. (`namespaceKeyPart` is the object-key twin) |
| `storageObjectKey` · `segmentObjectPrefix` · `parseGenerationFromKey` | the storage object layout every object-store driver shares, so a segment written through one reads identically through another on the same bucket. `storageObjectKey(prefix, key)` is one generation's key, `<prefix><ns>/segments/<segment>.<gen>.crbm`; `segmentObjectPrefix(prefix, ref)` is the prefix all of a segment's generations share, which its listing asks for; `parseGenerationFromKey(segmentPrefix, key)` reads a listed key back to its generation number, or `null` for a key that is not one of that segment's (a leading zero, another segment whose name shares the prefix, a number past the safe range). The first two validate the ref, and the generation, and throw `ValidationError` |
| `checkDeleteOptions(options)` · `checkRegistryWriteOptions(options)` | the per-call options of a driver port, each throwing `ValidationError` for a key the port does not take or a value of the wrong type, so a misspelt `ifVersion` is not an unconditional delete: a storage `delete` takes `{ ifVersion?: string }` (`checkDeleteOptions` returns it), a registry `create` and `compareAndSwap` take `{ held?, onToken? }`. Every shipped driver calls them |
| `refuseUnknownOptions` · `requirePositiveInt` · `requireBool` · `requireNonEmptyString` | constructor option checks, each throwing `ValidationError` naming the option. `refuseUnknownOptions(name, options, keys, hint?)` refuses an options value that is not an object, and one with an own enumerable key not in `keys`, naming each such key, then the keys it takes, then `hint` when given. `requirePositiveInt(name, value)` and `requireBool(name, value)` return the value, or `undefined` when it is absent, for your default, and refuse anything else: for a size, `0`, a fraction, `NaN`, a string or `null`; for a switch, a truthy string or a `1`. `requireNonEmptyString(name, value)` does the same for a name or an endpoint: it refuses an empty or whitespace-only string, `null` and anything that is not a string |
| `isTransportFault` · `toTransient` | fault classification. `isTransportFault(err)` is true when `err.code` is one of the codes Node gives a connection that failed or was cut off: `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`. It reads nothing else, so check your service's own statuses first. `toTransient(err, isTransient, message)` returns `err` as a `TransientError`, with `message(err)` as its message and `err` as its `cause`, when `isTransient(err)`, and `err` unchanged otherwise: the last step of a driver's error mapping. Scrub credentials from the error before it, since it becomes the cause |
| `concatBytes` | `concatBytes(parts)`: the chunks, in order, copied into one new `Uint8Array` that owns its bytes, so a part's buffer can be reused once it returns |
| `validateSegmentRef(ref)` | the name rules a driver applies to a ref (and that it is an object), and that it holds no other key than `segment`, `namespace`, a generation key's `generation`, a chunk ref's `chunkKey`, a `segments()` row's `currentGen` and `status`, and a registry row's own fields (`RegistryRecord`'s), so a row a driver listed can be passed back; a misspelt `namespace` throws instead of addressing the default namespace. It does nothing more: it takes a namespace in the reserved `cbm.due.` prefix, where the library's own due-index rows live. The refusal of that prefix is in the calls that take an application's ref or `namespace`, not here |
| `BlobSink` | the sink `putImmutable` hands the writer: the object's bytes arrive through its one method, `write`, and the driver commits them once the writer returns |
| the typed errors + `errorKind` | `ValidationError` · `WriteConflictError` · `NotFoundError` · `IntegrityError` · `TransientError`, the class they extend, `CloudRoaringError`, and `errorKind(err)` with its `ErrorKind` type. Throw the classes; classify with `errorKind`, which holds across package copies where `instanceof` does not |
| `unsettledConflict(message)` | a `WriteConflictError` for a registry `create` or `compareAndSwap` that may have landed before it met the conflict: throw it for every conflict of a write your backend's client may have sent more than once and that you cannot prove did not land: the read-back finds another writer's write over the row (a row is overwritten, so that writer may have swapped in over this write after it landed), or finds the row gone, or the compare-and-swap itself is answered that the row is gone. A plain `WriteConflictError` is for a conflict that proves the write was refused: a write sent once, or a check your driver made before sending anything. A registry that wraps another rethrows the conflict it was given, since a new one loses the mark. It is a `WriteConflictError` in every other way (`errorKind` names it `'WriteConflictError'`, `instanceof` holds on one copy of the package); a load's publish reads the row again as after any conflict, and a load refused after one that does not show its write carries `unanswered: true` on its `segment.load-refused` event. The mark is a registered `Symbol.for` brand, and is lost when the error is cloned or copied into a new one |

**What a storage driver must do.** Callers rely on each of these, and the conformance suite holds every shipped
driver to them (`IStorageDriver`'s doc comment states the same list):

- `putImmutable` is write-once and reports a collision as `WriteConflictError`, two concurrent writes of one key
  included: exactly one lands, and the object is its. `load` reads that error as a lost race for the generation number
  (`superseded`). A write whose writer fails stores nothing, and the key can be written after.
- Keys keep every name apart: one segment in two namespaces, two names an encoding could fold into one (`a/b` and
  `a_b`, `a:b` and `a%3Ab`), and a name that extends another (`s` and `s.1`) are separate objects, each listed and
  deleted alone. Generations are listed and deleted by number, never by a prefix of one (`1` is not `10`).
- A bucket or container that does not exist fails with an error that is neither `NotFoundError` nor
  `TransientError`. Read as the first, it answers every read as an empty segment, and a read re-resolves on it as on a
  miss it can heal; as the second, it is retried for nothing. The cloud drivers this library ships raise a
  `ValidationError` naming the bucket or container, with the service's error as its `cause`. The one exception: on S3 a
  zero-length tail (`getTail(key, 0)`) of a missing bucket reads as a missing object, because S3 sends no error code on a
  HEAD.
- A missing object makes `getRange` and `getTail` throw `NotFoundError`, never an empty or short result. Heal-forward,
  the erasure's holder probe and verify, and a pin's replaced-object check branch on it. A zero-length `getRange` may answer empty without
  reaching the backend, so it proves neither that the object exists nor that the offset is inside it. A deleted object is
  missing to the next read: once `delete` resolves, a `getTail` or a non-empty `getRange` of that key throws `NotFoundError`,
  with no stale answer from a cache or a replica. A rollback reads its target's footer once after moving the pointer and takes
  a read that succeeds as proof that the object is there.
- An out-of-range read, meaning a range past the end or a negative or non-integer offset or length, throws
  `ValidationError`, never a clamped or short read. `getTail` reports the object's true total size, and, where the
  driver has one, its `version`, from the same response as the bytes. A `getTail` length is a safe integer: zero or less
  answers an empty tail with the size, and one past the object's size the whole object. Any other length (`NaN`, a
  fraction, a negative one included, an infinity of either sign, a whole number past the safe range (2^53 or more, or
  -2^53 or less)) throws `ValidationError` before anything is read.
- A registry write whose `keyId` is not a non-empty string, or absent, throws `ValidationError` and stores nothing.
- `delete` is idempotent: deleting an absent key is a no-op, with or without `ifVersion`.
- `delete` with `ifVersion` does what `StorageCaps.conditionalDelete` says: with `true`, it removes the object only
  while it is the one that version names, by a check the backend applies in the same step as the removal, and for
  another object throws `WriteConflictError` and leaves it; with `false` or absent, it ignores the version. A read
  followed by a delete is two steps, and does not qualify. A conditional delete may be sent again after a lost
  response: a copy that meets its own landed delete finds nothing, which is its success, so a service that answers a
  failed precondition for a key with no object is looked at again before the driver reports a conflict.
- A driver that wraps another forwards `ifVersion` and the `version` of a tail read, or reports
  `conditionalDelete: false`: a wrapper that hands `delete` the key alone, and reports the inner driver's capability,
  makes every conditional delete through it unconditional without a word.
- `list` is strongly consistent, read-after-delete: once `delete` resolves, the generation is no longer listed. The
  erasure's re-check for a generation still holding the id, `generationsRemaining`, the retention sweep's check that a
  tombstone's storage is gone prove a deletion or a presence by listing.
- `list` yields every generation, however many pages the service splits the listing into. One that stops after its
  first page drops generations from every collection and every check above.
- Never replay a conditional write without telling the replay apart. A write that lands and loses its response, sent
  again, meets its own object and would report a collision. Send each write once, with the client's retry off for
  that request, or, when the precondition fails, read back an id you stored with the write and treat a match as
  success. The one write you may send again on purpose is a generation's object, after a response that says the
  service is refusing requests too fast (a throttle), and only if it carries such an id: a throttle is not a promise
  that the request was not applied. A lost response or a timeout is never grounds to send it again.
- Raise a transient fault as `TransientError`.

**A driver that runs `write` again.** `putImmutable` calls `write` once, and the shipped drivers send a throttled part,
block or object again rather than run it twice. A driver that does run it again after a failed attempt, which the port
allows, commits only the last run's bytes. A load of ids, of a bitmap or of a combine's chunks holds its chunks in
memory, so each run writes the whole object again (under a write identity of its own), and the load records the run
that was committed. A write that streams its chunks, a load with `sorted: true` and an erasure's rewrite, reads them
once: its second run throws `IntegrityError` before it writes a byte, the driver commits nothing, and the call throws
that error, with the first run's error as its `cause`.

**What a registry driver must do.** `create` and `compareAndSwap` are atomic conditional writes that throw
`WriteConflictError` and change nothing when they lose; a token is not reused, `delete` then `create` included, but for
a collision of probability 2^-128 per pair of incarnations; reads are strongly consistent; a row is keyed by its
namespace and segment together, so one segment name in two namespaces is two rows; `list` yields every existing row,
`destroyed` tombstones included, with every field, however many pages the service splits the listing into; a bucket or
container that does not exist fails a read, a listing and a write with an error that is neither `NotFoundError` nor
`TransientError`, never a `null` read (the cloud drivers this library ships raise a `ValidationError` naming the bucket
or container, with the service's error as its `cause`); the replay rule above applies to `create` and `compareAndSwap`,
which a driver never sends again on a throttle. The store's publish reads the row after one that ended without an answer
and recognises its own landed write by its effect; when the row is unchanged it sends a **fresh** compare-and-swap from
the version it read (at most three, after a wait on the injected clock), so both writes must fence on that version, for
real, and at most one of the two lands; a transient fault is a `TransientError`; a driver whose client may have sent a
write more than once raises every conflict it cannot prove the write did not land before (another writer's write on the
read-back, a compare-and-swap that finds the row gone, a read-back that finds nothing) with `unsettledConflict`, so a
load refused after it reports `unanswered: true`; a conflict that proves it (a write sent once, a check made before
sending) is a plain `WriteConflictError`. A registry that wraps another rethrows the conflict it was given, unchanged.
The conformance suite does not test the mark. `delete` is idempotent, with one addition.

**`create` and `compareAndSwap` take an optional third or fourth argument, `options?: RegistryWriteOptions`.**
`{ held?: RegistryRecord | null }` is the row the caller read and is writing against: the record this registry's `get`
returned (`null`: the caller found no row). A driver that would read the row to learn the version its conditional write
is fenced on may use the one it observed then, and send the write at once.
`ObjectStoreRegistry` does, so the S3, GCS and Azure Blob registries do; the in-memory and local-filesystem registries
read no more for it, since their row is read in process. It is a hint and never the fence: the write is still
conditioned on the store's own version of the row, so a `held` row that has changed since fails the write with
`WriteConflictError`, exactly as a lost race does. A driver that does not recognise the record (a copy, one it did not
return, one of another row), or whose `held` and `expected` token disagree, reads the row as it does without a hint,
and a write that gets no answer is settled by reading the row, never by `held`. A driver that ignores the option reads
the row, which is correct.

**`StorageCaps.conditionalDelete` says what a storage delete given a version does.** `true`: `getTail` reports a
`version` for every object it reads, and `delete(key, { ifVersion })` removes the object only while it is the one that
version names, refusing another with `WriteConflictError`, so a delete decided from one read and delayed cannot
remove an object stored under the key since: a generation number can be taken again once its object is deleted. An
erasure passes the version of the read that made an object a holder whenever it deletes that object by name (a holder
above the pointer or on a segment with no generation yet, or an object it cannot search), a refused rewrite the version
of the footer read that matched its object above the winner's pointer, in a delete it sends only once a renewal of the
row made after that read has landed, and a refused load the version of the footer read that matched its object to what
it wrote. `false` or absent: the version is ignored. A driver that learns this
from its client may report `false` until its first delete given `ifVersion`; what the delete does is what it states,
and the S3 driver is one. The in-memory driver reports `true`, the local-filesystem one `false`, the cloud ones as their
backend's `conditionalDelete` option says. A version names the object, not the key, except where the backend computes it
from the bytes, as an S3 ETag of an object stored without SSE-KMS or SSE-C is: two objects with the same bytes, each
stored whole in one request, or each in parts of the same sizes, share one there. It is optional and additive: a driver
of your own that omits it is read as `false`, and keeps deleting unconditionally. A driver that wraps another forwards
`ifVersion` and the `version` of a tail read, or reports `conditionalDelete: false`. In this repository
`tests/arch/storage-delete-forwarding.test.ts` checks the first half, that a storage wrapper's `delete` takes and
forwards the options, for the wrapper shapes it recognises; its header lists the shapes it does not see, and nothing
checks that a wrapper hands on the tail read's `version`. The in-repo conformance suite's `conditional delete` case holds a driver to what it reports, and
`storageDriverConformance`'s `conditionalDelete` option states at the call site what that must be.

**`RegCaps.conditionalDelete` says what `delete` leaves behind.** `true`: a delete removes the row from the backend for
good, and only while the row is still the exact version it read (by a precondition the backend applies, or a lock every
writer of the backend takes), so a full `list` no longer reads it. `false` or absent: every delete leaves a tombstone. A
shipped registry reports it: the in-memory and local-filesystem ones `true`, the cloud ones as their backend's
`conditionalDelete` option says. It is optional and additive: a driver of your own that omits it is read as `false`.
The in-repo conformance suite's `registryDeleteConformance(label, make)` holds every shipped driver to what it declares;
`make` returns the driver and a `stored(ref)` probe of its backend, and optionally `plantRow(ref, text)`, which puts a
row as another writer left it.

**`delete(ref, expected?)` takes an optional expected token.** Without it, deleting an absent row is a no-op. With it, the delete is fenced like a compare-and-swap: it lands only while the row still carries that token,
and otherwise (another token, or no live row) throws `WriteConflictError` and leaves the row. The library passes the
token of the row it read when it decided to delete, so a delayed or replayed delete, or one racing a re-create,
cannot tombstone a row created after the decision: the retention sweep's tombstone purge does. A driver that extends
`ObjectStoreRegistry` gets this for free. **For a third-party registry driver the parameter is optional:** a driver that ignores it keeps the unfenced
behaviour. Implement it to make the library's deletes safe against a concurrent re-create;
the registry conformance suite's `delete` cases are the test.

**Registry rows are schema 5: every row carries `pointerId`, its `summary` names the object it describes, and its `knownGens` ledger names the generations it knows, each with its footer checksum.** A
shipped registry stamps every row it writes `schemaVersion: 5` and reads rows stamped 5 and nothing else. A row stamped
1 to 4 is refused with `UnsupportedError` naming the row: by `get`, by every
`list()` that reaches it, and by every write, which reads the row first, so no write changes it. A stamp above 5 is
refused the same way. The library cannot read, change or delete such a row; the [CHANGELOG](../../CHANGELOG.md)'s Breaking entry for registry schema 5 gives the steps that move a bucket of them to a new prefix.

`pointerId` is the token of the most recent write that named a field a read resolves through: the row's `create`, or a
`compareAndSwap` whose patch names `currentGen`, `status`, `wrappedDeks`, `keyId` or `summary` (the resolved fields), by
presence and at any value, the value the field already has included. A patch that names only `leases`, `retention`,
`residency` or `knownGens` leaves it. A reader keys what it caches on the generation with it (its readers, its decoded
chunks, a pin's version), so a lease or a policy write leaves a warm reader as it was, and a write that names a
resolved field never does. The registry sets it, from the token it gives the write: a writer whose write renewed
it knows its new value without reading the row, since it is the token the write returned. A new record or a patch that
names `pointerId` or `token` is refused with `ValidationError`. A stored row's `pointerId` is held to what a shipped
registry can have written: the token's form, the row's own incarnation, and a counter no higher than the token's, else
`IntegrityError` naming the row. A row a registry of your own returns without one fails every read of the segment with
`UnsupportedError`. The rule is exported for a registry that builds its own records:
`@cloudbitmaps/core/driver-kit`'s `RESOLVED_FIELDS`, `renewsPointer(patch)`, `renewPointer(row)` and `pointerIdOf(row)`
([driver kit](#driver-kit--what-you-need-to-implement-a-driver)).

`summary` is the row's cached description of its current generation: its id count, the fingerprint of its object (its
size in bytes and its footer checksum, `<size>:<checksum>` as `pinnedAt.fingerprint` spells it) and the metadata it was
loaded with, and `tailBytes`, the bytes from the end of the object's last chunk payload to its end (its extension block, index
and footer), which a cold open of a cleartext generation sizes its tail read from, so the open takes the whole index in one request however wide it is (an encrypted generation's open does not use it: its summary is sealed, and the key is asked for beside the tail read). It is in the clear on a cleartext segment (`{ generation, cardinality, fingerprint, tailBytes, metadata? }`) and sealed
under the segment's data key on an encrypted one (`{ generation, sealed }`: the count, the size, the checksum and
`tailBytes` fixed-width, then the metadata; at least 52 bytes), so the row shows none of them. `tailBytes` is an integer from 104, a
footer, to the object's size less its 8-byte preamble, and at most 8,392,820, the most one open reads, else `ValidationError` on a write and
`IntegrityError` on a read. A reader accepts bytes between an object's index and its footer, so an object this library
did not write can report a larger tail: a rollback onto it writes no summary, and the row is correct without one. Every write that writes a summary writes its object's
fingerprint: a load, the `*Into` verbs, `materializeMany`, an erasure's rewrite and a rollback, which writes its
target's. A reader holds every object it opens for the row's generation to that fingerprint, from the footer, before
it reads the index: another object under the number is refused as a move (the read resolves the row again, and does
not serve it). The open is also held to the summary's id count, metadata and `tailBytes`: a disagreement stops the store using that summary again. A row with no summary it can use is not checked, and a reader already open is not checked again until
the row changes, it is evicted or it is invalidated ([what the check does not cover](reading.md#how-soon-a-reader-sees-a-new-load)). `stat()` reports the size from it. It names the generation it describes, and it follows the pointer and the
keys: a patch that changes the value of `currentGen`, or changes `wrappedDeks` so the summary's shape no longer agrees,
without mentioning `summary` drops the old one, and a patch that names `currentGen` at the value it has keeps it; a
patch or create that gives one must name the `currentGen` the row will have and agree with its keys (sealed with
wrapped keys, clear without), else `ValidationError`. The registry stores a frozen copy of the summary it was called
with, so changing your object after the call changes nothing. Each shape is checked at both boundaries
(`ValidationError` on a write, `IntegrityError` naming the row on a read). A stored row whose summary disagrees with its
keys, or names another generation than `currentGen`, is still read, so one such row cannot stop every listing: whatever
reads the summary must not use it then. A row without a summary is correct (a rollback whose target is encrypted and
whose key is not at hand writes none), and a reader then opens the generation for what it would have said. **The
registry conformance suite requires a driver** to set and keep `pointerId` by the rule above, to persist the summary
(round-trip it through `create`, `get`, `list` and `compareAndSwap`, keep it across a patch that does not mention it or
that names the pointer at its own value, store it as it was when the write was called, and refuse a malformed one,
one without a fingerprint included, with `ValidationError` on the write), and, for a registry that persists rows, to
refuse a row stamped with an earlier schema on every read and write.

**`knownGens` is the ledger of the generations a row knows and has not decided to delete**: the ones it made current and,
when a publish over a row with no usable ledger seeds one, the ones a count by `keep` keeps in the bucket, which can include an
object no load published (an orphan or a stray). An entry says the library knows the generation and its footer checksum, not that a
load published it. Each is `{ generation,
footerCrc }`: a non-negative safe integer and the CRC32C its object's footer stores (an integer from 0 to 2^32 - 1), in the order the
generations were made current, oldest first and the current one last. A generation appears once, at its most recent
time current: a rollback onto it moves it to the end. The entries before the last are the window a load keeps below the
pointer, the generations a live lease holds, and what a rollback left; those numbered above `currentGen` are what a
rollback left. A load draws its window from the entries numbered below its new generation: the `keep` most recently
current of them (up to 127; it collects the ones that fall out of it by name when `keep` is at most 64), the entries a live
lease holds, whatever `keep` says, and, carried and never collected, the entries numbered above the new generation. A row
whose ledger is absent makes the next load list the bucket, keep what a count by `keep` keeps (the generation it
superseded first, then the newest by number), and write that window, with the leased generations it lists, as the ledger's
entries before the new generation. A usable ledger is never written again from the bucket: over one that names more than 64
below the pointer that no live lease holds (a run of publishes with a `keep` above 64 carries up to 127), a load with a
`keep` of 64 or less writes the window it draws from the ledger's order, the leased entries and the entries a rollback
left above its number, and collects by listing, the ledger's names first. A rollback moves only onto an entry, and only when its object's footer checksum is the one the entry records (or
with `allowUnknown`, which records the target and the checksum it read); it carries the ledger it found and moves its
target to the end, and writes none over a row that had none. A load writes at most 192 entries and a row is read with up to 384; a writer keeps an
entry that nothing protects only while the ledger holds fewer than 128, and never drops the new generation, its window
or a generation a live lease holds.
It is in the clear on every row, an encrypted one included: a footer checksum of an encrypted object covers a random nonce
and says nothing of its count or size. The entries above the pointer show anyone who reads the registry that a rollback
happened, and from which generation.

Each rule is checked at both boundaries (`ValidationError` on a write, `IntegrityError` naming the row on a read): an
array of entries with exactly those two fields, no generation repeated. A write is also refused when the list is empty,
when the row has no pointer, when its last entry is not the `currentGen` the row will have, and when, beside a clear
`summary` that describes that generation, its last entry's checksum is not the one the summary's fingerprint carries (a
registry cannot compare a sealed summary's; the library takes both from one object). A stored ledger that is well formed
but disagrees with its row (its last entry is not the pointer, its checksum is not a clear summary's, it sits on a row with no
pointer or a `destroyed` one) is read and not used, as a summary that names another generation is. The registry stores a
frozen copy, **in the order given**: a registry that sorts the list loses which generations were most recently current
with no error, and a registry that does not store the field at all makes every publish seed the ledger (one listing and
up to `min(keep, 127)` footer reads, eight at a time, before each load's write). It follows the pointer as `summary` does: a patch that moves `currentGen` without mentioning `knownGens`
drops it, a patch that leaves the pointer keeps it, and a patch that names it sets it, checked against the row it makes. A
registry of your own must store and return the field in the order given, and drop it on a patch that moves the pointer
without it. One that drops the field is correct and makes every load list; a rollback below its pointer is then decided by the pointer
alone (no flag, key-less allowed, audited `unknown: true`), a rollback above it needs
`allowUnknown`, and none of the ledger's checks apply. The conformance suite holds a driver to all of
this.

**`leases` is the holds on a segment's generations**, each `{ holder, generation, until }`: 16 lowercase hex digits naming
the holder, the generation held, and an epoch-millisecond instant. A load's collection spares the generation of an entry
that has not ended, and an entry has ended 60 seconds after `until`. Unlike `knownGens` it does not follow
the pointer: a patch that moves `currentGen` leaves it, and only a patch that names it, or the row going away, changes it.
A writer writes at most 64 entries and a reader accepts 256; an empty list is stored as none; an entry carries no field
beyond those three, and a stored row that carries one, a holder that is not 16 lowercase hex digits, a duplicate holder or
a number that is not a non-negative safe integer is refused with `IntegrityError`. `NewRegistryRecord` has no `leases`: a
new row has no holder.

**A shipped registry's token is `<incarnation>.<counter>.<write>`.** The incarnation is 128 bits as 32 lowercase hex
digits, drawn when a row is created, so a re-created name never meets an earlier incarnation's token, even once the
earlier row is gone entirely. The counter advances on every write and carries on across a tombstone. The write part
is 64 bits as 16 lowercase hex digits, drawn for every write, so a row restored from a backup to an older counter is
never given a token it had before. Both random parts make it hold with overwhelming probability rather than by construction: two
incarnations of one name draw the same incarnation id with probability 2^-128 for any pair (about n² / 2^129 among n of
them), and two writes at one counter, after a restore, the same write part with probability 2^-64. Only a create starts
an incarnation, and a stored token in any other form is refused with `IntegrityError` naming the row. Tokens stay opaque to the library,
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
takes (a direct read answers empty), and the first publish advances the pointer onto it. An `IRegistryDriver` must
therefore:

- round-trip `null` through `create`, `compareAndSwap`, `get` **and** `list` — serialization is where it gets
  silently dropped (`JSON.stringify` keeps `null` but omits `undefined`) or coerced to `0`, which is the
  forbidden `missing-storage-generation` state;
- apply a patch that sets `currentGen: null`, and leave the stored value alone when a patch omits the field. The
  trap is merging with `patch.currentGen ?? previous`, which treats a deliberate `null` as absent and silently
  keeps pointing at the old generation — use an own-property check (`'currentGen' in patch`);
- keep `status: 'active'` meaningful for such a row: a null pointer is a **live** segment, not a tombstone;
- yield `destroyed` tombstones from `list()` — the sweep can only purge a row it can see.

**A registry can tell a writer which row writes are its own.** A load, an erasure's rewrite and every other publish that
meets a conflict, or a write that got no answer, has to decide whether its own write landed, and the row's `pointerId`
(the token of the write that last set the pointer) answers it, if the writer knows the tokens of the writes it sent. A
registry that reports them says so with `reportsWriteTokens: true` on the driver (a getter or a field), and calls the
`onToken` function of the `RegistryWriteOptions` it is handed, once for each `create` and `compareAndSwap` it sends,
with the token that write carries, **before it sends the request**: a write that gets no answer may still land, and its
token has to be known by then. A publish relies on the report coming first, both ways. A write that faults after its
report may have landed, and [is settled by reading the row](correctness.md#row-write-settled). A `TransientError` before
any report is taken for a fault before sending, such as the driver's own read of the row: the publish throws it at once,
with no read of the row and no fresh write. So nothing that can land is sent before the report, a client's own resend
included. A write sent again with a new token reports it; one that repeats the same body repeats the token already
reported. The token reported is the one the write records, so a write that lands leaves the row's `token` equal to it,
and its `pointerId` too when the write names a resolved field; a write that does not land leaves no row carrying it.
**The token is unique to that write attempt, also against another writer racing the same version**: a version counter
alone is not enough, since a loser's write would then pass for the winner's. The writer counts a write as its own if and
only if the row's `pointerId` is one of the tokens it was told, which is equality only, so it needs no read of the
object and cannot mistake another writer's write of the same ids for its own. A `pointerId` that is not one is another
writer's write, or the writer's own write that landed and was then followed, before the writer read the row again, by a
write that renews the row's `pointerId` over it: an erasure's renewal, or a rollback back onto the generation after a
publish or another rollback moved the pointer off it. The writer [cannot tell the two
apart](correctness.md#superseded-over-own-generation), reports none published though its generation may be current, and
deletes nothing, and a re-run publishes, or erases. `ObjectStoreRegistry` (so the S3, GCS and Azure Blob registries),
the in-memory registry and the local-filesystem registry report; the registry conformance suite holds a registry that
sets the flag to the cases above, among them N writers racing one write with one body, which must report tokens no loser
shares with the row. **A registry that wraps or extends another and overrides `create` or `compareAndSwap` either passes
`options` through to the write it forwards, or sets `reportsWriteTokens` to `false`.** One that does neither reads a
write of its own that landed and then met a conflict as not its own (`superseded`), and takes every `TransientError` of
its writes, a throttle and a lost answer alike, for a fault before sending: the publish throws it at once, with no read
of the row and no fresh write. Either way it deletes nothing. A registry that sets the flag to `false`, or leaves it
off, is settled by the object: the publish reads the footer of the object under the pointer, which carries the write
identity its writer drew, so another load's object under the number, of the same ids or not, does not pass for the
publish's own (an object whose identity field is all zero is the exception).

**How the store treats your driver's errors.** Throw `TransientError` for your backend's retryable faults: the
store's read retry rides them out, and a write's caller can tell them from a deterministic failure. A registry's `get`
is held to the same rule. A pointer refresh rides out only a `TransientError`, so a custom registry that throws a
plain `Error` for an outage makes the read that meets it fail. The store wraps the source it reads through, a
`StorageChunkSource` you pass as `storage` included, so do not wrap one before handing it over: that multiplies each
read's attempts. A call of your own is yours to retry: loop over it, and back off before the next attempt when
`errorKind(err) === 'TransientError'`.

### Resilience (the store wires this by default)

| Symbol | What it does |
|---|---|
| `RetryPolicy` | from `@cloudbitmaps/roaring`: the five fields the store's `retry` option overrides a field at a time. The defaults are 4 attempts, a 50 ms base delay, ×2, a 2 s cap and full jitter. The retry primitive, `withRetry`, the default policy and the read-source wrapper the store builds, `RetryingStorageChunkSource`, are internal to the engine |

The search `subjectReport` and `eraseSubject` make under a destroyed segment, its listing included, is under the read retry. No write goes through the read retry. A conditional put or compare-and-swap that lands and then loses its response
would, replayed blindly, find its own write already there and report it as a conflict, so a fault the drivers and the
publish do not settle reaches the caller as a `TransientError`. So does a fault on the store's direct registry and
bucket reads (`exists`, `segments`, `generations`, `getRetention`, and the registry scan `subjectReport`,
`exportSegments` and `checkConsistency` start from). A fault on one segment inside `checkConsistency` is recorded in
`report.errored`, not thrown. To retry a write that reached you, re-run the call.
A load settles one outcome itself: when its registry write ends without an answer, it reads the row, reports a write
that landed as `published: true`, sends a fresh compare-and-swap (at most three) when the row is unchanged, and
otherwise throws the registry's `TransientError` and deletes nothing. The lifecycle helpers read back their row or object too and report a write that landed as landed
([what each settles](correctness.md#settle-by-read-back)); a rollback's swap, after a conflict that changed only
the row's leases, is sent again, and after no answer it is not.
[Reliability](production.md#reliability-retries-backoff--timeouts) says how, and how to tell whether an attempt landed.

### Crypto seams

| Symbol | What it does |
|---|---|
| `Aead` · `AeadSealed` · `WrappedDek` | from `@cloudbitmaps/core/driver-kit`: the cipher a keystore hands back for a segment's key, what it seals, and the wrapped key a registry row stores. An **`Aead` implementation is handed** the associated data and never builds it; the AES-256-GCM implementation the store uses and the associated-data layout are internal, and [the format reference](../format.md#8-encryption-at-rest) specifies the layout for a reader of your own |
| `EraseDeps` | from `@cloudbitmaps/roaring`: `{ registry }` — deps for the free-function crypto-shred (`destroySegment` / `eraseNamespace`) |

### Low-level ports & capabilities (driver-author typing)

From `@cloudbitmaps/core/driver-kit`: `StorageCaps` (`conditionalDelete?` included, see the [driver kit](#driver-kit--what-you-need-to-implement-a-driver)) ·
`TailRead` · `StorageDeleteOptions` · `RegCaps` · `ChunkRef` · `GenKey` · `RegistryRecord` (every row carries `token` and `pointerId`; see the
[driver kit](#driver-kit--what-you-need-to-implement-a-driver)) · `NewRegistryRecord` · `RegistryPatch` · `RegistryWriteOptions` ·
`RegistryStatus` (`'active' | 'destroyed'`) · `GovernanceMeta` · `SegmentSize` · `RegistrySummary`
(`ClearRegistrySummary` `{ generation, cardinality, fingerprint, tailBytes, metadata? }` or `SealedRegistrySummary`
`{ generation, sealed }`, the row's cached description of its current generation and the object it names) · `KnownGeneration` (`{ generation, footerCrc }`, one entry of a row's `knownGens` ledger) · `GenerationMetadata` (string keys, string or finite-number
values, at most 1 KiB as canonical JSON) · `GenerationSummary` (`{ generation, cardinality, metadata? }`, what a
`StorageChunkSource`'s optional `summary()` answers for a segment's current generation, and, with the object's
`sizeBytes` from the same resolution, what its optional `stat()` answers) · `ChunkRead` (`{ key, bytes, version }`, one chunk of the stream the optional `getChunks(ref, keys, options?)` answers: the key, its bytes or `null`, and the version of the generation it was read from) · `ReadChunksOptions` (`{ retry?, concurrency?, ramp?, onRequest? }`: `onRequest` is called once for every range request the stream sends, when it settles, including one a consumer that stopped left in flight and one that failed (with 0 bytes), with the bytes it moved (the gaps between chunks included) and its milliseconds, and an error it throws is ignored, so a caller can count what it is billed for; `retry` is a runner for each storage request the call makes, so a caller that retries repeats the one request that failed; `concurrency` is how many range requests the stream holds ahead of its consumer, 32 by default; `ramp` opens that window 1, 2, 4 … wide, or, given a number, that many wide and doubling from there). A source that implements `getChunks` reads several chunks of one segment from one generation in fewer requests, as a stream in key order (ascending, a key may repeat); one that omits it is read chunk by chunk. Nothing is resolved or read until the first chunk is asked for. However many keys the stream is given, it holds at most `concurrency` ranges at once, in flight or landed and not yet taken, each at most 1 MiB (one chunk, at most the payload cap, when it is larger), and a consumer that stops early stops the reads: the requests already in flight finish and are dropped, and are not retried. A stream that fails raises at once and sends nothing further; the requests it left in flight finish in the background and never raise. One stream reads one generation; if that generation is swept or its object replaced while the stream runs, the `.crbm` source waits for those requests, so a heal never opens a second window beside them, then re-resolves the segment and carries on with the keys not yet yielded, and each chunk says which version it came from. A request that never answers delays a heal, as it would hang a read of one chunk, until the driver's read timeout (if it has one) ends it; it never delays an error. A plain chunk may be a view into a buffer of up to 1 MiB shared with its neighbours, and a key asked twice gets the same view, so do not write to it, and copy a chunk to keep it

---

## Errors (typed — you `catch` these)

Every error the library's API throws extends `CloudRoaringError`, and each one tells you which of three things to
do: **fix your call**, **retry**, or **investigate the data**. That includes the `export-segments` CLI, which reports a
missing or invalid environment variable with a `ValidationError` naming the variable and exits non-zero.

| Error | Fires when | What to do | Retry? |
|---|---|---|---|
| `ValidationError` | your input is malformed — a bad id, an illegal segment name, an out-of-range option; or a bucket or container that does not exist, which the cloud drivers report with it (S3 excepted for a zero-length tail), naming the bucket and keeping the service's error as its `cause`; a load, or an `*Into` or `materializeMany` onto a cleartext segment, on a store built with `encryption: { required: true }` (a message that begins `requireEncryption:`). Most are raised **before any storage call**; an out-of-range read and a missing bucket are found by the call itself | fix the call (for a missing bucket: the name, and the region, endpoint, project or account of the client) | no — deterministic |
| `WriteConflictError` | a write-once generation number was claimed twice, a registry compare-and-swap lost every retry, or generation collection found the segment re-created underneath it (the name now belongs to a different segment) | re-read the pointer and re-derive: re-run the operation (a load takes a fresh generation number) | no — but the *operation* is safe to re-run |
| `IntegrityError` | bytes from storage are corrupt, oversized, fail a checksum, or fail AEAD authentication; or a registry row is not one the library wrote — not valid JSON, an envelope or record field it does not declare, no `schemaVersion`, a `status` other than `active` or `destroyed`, a token or a `pointerId` in no form a shipped registry writes (or a `pointerId` of another incarnation than the row's token, or written after it), a summary without the fingerprint of its object or its `tailBytes`, a malformed `knownGens`, or a segment or namespace other than the one whose key or file it sits under (a row copied to another name) | **investigate** — this says "this data is corrupt", not "try again". It names the chunk, or the row's key. Re-loading the segment from source repairs a generation. A bad row fails its own `get` **and every `list()` that reaches it** — its namespace's, and every unscoped one — so it stops `segments()`, the sweeps, the subject scans and `checkConsistency` across the fleet until the object is restored to a valid row or deleted | no |
| `NotFoundError` | an object or row the caller named does not exist. Every backend, the in-memory one included, throws it for a generation object that is not there; a registry `get` of a missing row returns `null` instead. A read also throws it for an object under the generation's number that is another object than the row's summary names: it is refused as a missing one is, and not served | usually the library handles it internally (a swept generation, or a number taken again, heals forward). Reaching you means the pointer names an object that is *permanently* absent, or one the row does not name — a torn restore. `checkConsistency({ summaries: true })` finds both. See [disaster recovery](disaster-recovery.md). A load, an erasure or a collection also raises it when another writer, a rollback as a rule, moved the pointer onto a generation the call had just deleted, and the row still named it, with no object under it, when the call read it again after a wait: the message names the generation. Check `store.generations(ref)` or `checkConsistency()` first: a rollback that found its target gone puts the pointer back itself, and only while the pointer still names a missing object is a rollback to a generation still in the bucket the fix ([a rollback that races a collection](correctness.md#a-rollback-that-races-a-collection)) | no |
| `UnsupportedError` | (a) the bytes are well-formed but this build cannot read them — an unknown `.crbm` major version, or a registry row with a `schemaVersion` other than 5 (a row stamped 1 to 4 is refused, as one stamped above 5 is); or (b) this store's wiring cannot perform the operation, e.g. a lifecycle helper on a store built without a backend, or a registry of your own that returns rows without a `pointerId` | wire the store with what the operation needs, or upgrade the library; for a row of an earlier schema, move the bucket's segments to a new prefix as the [CHANGELOG](../../CHANGELOG.md) says | no |
| `StaleOperandError` | an operand a `materializeMany` call relied on changed while it ran: an operand an output subtracts changed before the publishes: its row or its object is no longer the pinned one (another generation, the name deleted and created again, or the number taken again by other bytes), `reason: 'moved'`; or an erasure ran in the store after a call with a feed began, `reason: 'erased'`. Carries `code: 'stale-operand'`, `operand` (its name in the call) and `reason` | run the call again against the current operand, or, for `'erased'`, with a feed read after the erasure | no — deterministic; the outputs that excluded it, or that were fed, were not published |
| `CapabilityError` | the storage you passed cannot meet a capability the store requires — a storage without range reads (one of your own; the five backends all serve them), or a keystore or `encryption.required: true` on a store built on a bare `IStorageDriver` instead of a backend, which has no registry. Raised **fail-fast at construction**, never mid-operation | pass a backend, or a storage that supports range reads | no |
| `BudgetExceededError` | the operation would pass one of its per-call limits: the request budget (`budget`, the denial-of-wallet cap on backend requests for one call), `maxBufferedBytes`, the memory ceiling of `materializeMany`, or `maxScanSegments`, the registry rows a scan may hold resident. It is refused before fanning out, except where a call grows past a limit part way: an `iterate` or a combine that plans again after a segment moved throws it at that key, and a `materializeMany` that refuses a regrouped run, or a pass that buffers more than `maxBufferedBytes`, gives it as those outputs' results, after earlier groups published. `subjectReport` can also throw it while it opens a destroyed segment's objects. `eraseSubject` throws it only from its scan: a segment that runs the budget out while its generations are opened is listed in the ledger with `erased: false` and an `error:` note, and the call carries on. It carries an option name and two numbers, and no data: `option`, the option to raise (`'budget.maxRequests'`, `'maxBufferedBytes'` or `'maxScanSegments'`); `limit`, the bound in force; and `spent`, what the call had reached, which means a different thing for each option. For `'budget.maxRequests'` it is the requests a plan needs, which raising the budget to it lets through; an enumeration stopped at the bound (`subjectReport`, `eraseSubject`'s scan), and a `subjectReport` refused while it searches a destroyed segment, report `limit + 1`, a lower bound, so raising the budget to it can be refused again. For `'maxBufferedBytes'` it is a lower bound: what the call held plus what it asked for when refused, so raising the limit to it can be refused again; only the per-output refusal, whose message says "raise maxBufferedBytes to at least N", names a figure that lets that output through. For `'maxScanSegments'` it is `limit + 1`, a lower bound: the scan stops at the first row past the bound (for the retention sweep's due-index scan, the first pointer, unread, which may be stale). Its message states the same limit, and "more than" it for an abandoned scan | narrow the operation; for a request count, raise `budget` or set `budget: false`, and for `maxBufferedBytes` or `maxScanSegments`, raise that option, which `budget: false` does not lift (`store.checkConsistency` takes `maxScanSegments`, like `retireExpired`, or narrow it with `namespace`). For an `eraseSubject` ledger entry with a budget note, run it again with a higher `budget`. If it fires on a normal call, something is wider than you think | no — refused by policy, not by luck |
| `KeyUnavailableError` | an encrypted segment's DEK cannot be unwrapped: the keystore holds none of the KEKs its wrappings reference — never configured, rotated away without keeping the old key, or lost. A `rollback` above the pointer of an encrypted segment also throws it when it has no key to open its target (no keystore, or one that holds none of the key's KEKs or one that does not unwrap it: the message says which), and moves nothing; a key service that did not answer in time reaches you as `TransientError` instead, a timeout as its `cause`. It is also thrown, with a message that begins `requireEncryption:`, by a read of a cleartext segment on a store built with `encryption: { required: true }`: `has`, `count`, `iterate`, `stat`, `pin`, an `intersect` or an `*Into` or `materializeMany` operand, and `subjectReport`, and `eraseSubject` records it in a ledger note | restore the KEK. **Without it the data is unreadable**, which is what crypto-shred relies on. For the rollback, run it on a store whose keystore opens the segment's key. For `requireEncryption:`, there is no key to restore: encrypt the segment (load it again through a keystore into a new segment) or read it from a store built without `required` | no |
| `LeaseExpiredError` | a read of a leased pin came after its lease ended, by `leaseUntil` or by `release()`: at every read site of the handle, including a leased handle used as an operand or an `exclude` of a combine, or as the target of an `*Into`. It carries `until` and `reason` (`'expired'` or `'released'`), and is thrown whether or not the object is still stored: a leased handle never reads empty | take a new lease (a new `pin({ leaseUntil })`) for work that outlasts it | no |
| `LeaseLimitError` | the segment already has 64 live leases, the most one row records; nothing was written | release a lease, wait for one to end, or take one lease per job and share its handle | no |
| `TransientError` | a transient fault your backend classified (from its storage or registry) — throttling, a 5xx, a connection reset. The raw SDK error is preserved in `cause`, except on a read `readTimeoutMs` cut off, which has none and says `timed out after N ms` | from a read of segment data, the retry layer already retried it, and reaching you means it kept failing. From a write, it is a fault the drivers and the call did not settle; it may still have landed when the read-back failed too, a delete landed after its check, or the registry reports no write tokens (a [throttled S3 or GCS object](correctness.md#object-write-resent) is sent again, and every write settles an unanswered registry write or delete by reading back its row or its object: [what each settles](correctness.md#settle-by-read-back)), and from a direct registry or bucket read it was not retried: re-run the call. For a `load`, once the first attempt has settled, the re-run publishes whether or not that attempt landed; to know whether it did, check `store.generations(ref)` rather than replay the request. One thrown by a load's registry write has deleted nothing, and its object may still be published. One thrown by the collection after the publish comes after a landed publish: the load is current, and only the removal of older generations did not finish ([Resilience](#resilience-the-store-wires-this-by-default), [what a throttled load leaves behind](correctness.md#when-a-write-is-throttled-or-gets-no-answer), [what throws instead](correctness.md#when-a-load-is-refused)) | **yes** — the only class the retry layer retries |

Two things worth knowing:

- **The retry layer retries `TransientError` and nothing else.** Retrying a `ValidationError`, `IntegrityError`,
  `NotFoundError` or `WriteConflictError` is pointless or wrong, so it never happens.
- **`TransientError.cause` is the raw SDK error** and may carry operational metadata (endpoint host, request
  ids, `$metadata`). The library's own `message` is identifier-only and safe to log; serializing the whole error
  *chain* includes that metadata.

**`errorKind(err)`** names which error class `err` is, or returns `undefined` when it is none of ours. It returns an
`ErrorKind`, the class's name: `'CloudRoaringError'` · `'ValidationError'` · `'WriteConflictError'` ·
`'IntegrityError'` · `'NotFoundError'` · `'TransientError'` · `'UnsupportedError'` · `'CapabilityError'` ·
`'BudgetExceededError'` · `'KeyUnavailableError'` · `'LeaseExpiredError'` · `'LeaseLimitError'` ·
`'StaleOperandError'`. Test for one with `errorKind(err) === 'ValidationError'`, and for any of ours with
`errorKind(err) !== undefined`. An application's subclass of one (`class TenantRefused extends ValidationError`)
returns `'CloudRoaringError'`, since the kind is the library's own class by its name; a subclass of `TransientError`
returns `'TransientError'`, which is matched by brand. An error cloned out of a worker has lost its brand and returns
`undefined`. What it gives up against `instanceof` is type narrowing: `errorKind` returns a name, not a type guard, so
narrow with `instanceof` on an ordinary install, or with a cast after the check. It is exported from
`@cloudbitmaps/roaring` and from `@cloudbitmaps/core/driver-kit`.

**On an ordinary install, `instanceof` holds everywhere** — across `@cloudbitmaps/roaring`, the backend
packages and `@cloudbitmaps/core` itself. Every package is published with `@cloudbitmaps/core` left
**external** rather than bundled in, so your tree has one copy of the error classes and
`core.ValidationError` and the class `@cloudbitmaps/s3` throws are the same object. Catch them
however you normally would.

Reach for `errorKind` where that stops being true, which is not something the library can control:

- a bundler that inlines `@cloudbitmaps/core` into two separate outputs;
- two copies of core resolved side by side in one tree, which npm and pnpm will both do;
- an error crossing a `vm` realm or an iframe.

`errorKind` reads a `Symbol.for` brand plus the runtime `name`, and a `Symbol.for` key is the same
symbol in every copy and every realm, where a class object is not. So it holds in all three cases,
for copies of core that carry the same brand, as every package of one release does, and `instanceof` does not.
An error posted from a `worker_threads` worker is cloned into a plain `Error` that keeps its message but neither
its class nor its brand, so neither holds there: send the error's `name` with it if the receiver must tell errors
apart. The failure is silent — a `catch` that stops matching just falls through — which
is why library code that cannot see how it will be bundled should prefer it by default. `pnpm smoke`
asserts both halves on every build: that the shared copy really is shared, and that `errorKind`, from the flavor and
from driver-kit, classifies an error thrown by one package and caught in another.

---

## Complete export index

Every export, by entry point. This section is the completeness anchor the sync test checks against: each entry's
names sit under that entry's heading, and a name listed under the wrong one fails it.

`@cloudbitmaps/roaring` exports, by name, what an application uses: the store, its backends, the types its signatures
name, the errors and the helpers a user calls, and nothing else. The main entry of `@cloudbitmaps/core` and its `/node` subpath are internal, outside the stability promise, and are not indexed here; the
driver contracts, the ports the store's signatures stop at among them, are under `@cloudbitmaps/core/driver-kit`, their one home.

### `@cloudbitmaps/roaring` — values

`CloudRoaring` · `Segment` · `RoaringBitmap` · `MemoryStorage` · `LocalFsStorage` ·
`destroySegment` · `eraseNamespace` · `InProcessKeystore` · `readRetentionPolicy` · `excludingReservedRows` ·
`CountingMetricsSink` · `RecordingAuditSink` · `CloudRoaringError` ·
`ValidationError` · `WriteConflictError` · `IntegrityError` · `NotFoundError` · `UnsupportedError` ·
`CapabilityError` · `TransientError` · `KeyUnavailableError` · `BudgetExceededError` ·
`LeaseExpiredError` · `LeaseLimitError` · `StaleOperandError` · `errorKind`

### `@cloudbitmaps/roaring` — types

`CloudRoaringOptions` · `CacheOptions` · `EncryptionOptions` · `RetryOptions` · `SeamOptions` ·
`SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` · `EraseSubjectResult` ·
`MaterializeResult` · `MaterializeRefusal` · `Expr` · `MaterializeManyOptions` · `MaterializeManyDryRunOptions` · `MaterializeManyDryRun` · `MaterializeDryRunResult` · `MaterializeManyDryRunOutcome` · `MaterializeManyOutput` · `MaterializeManyFeed` · `MaterializeManyFeedRecord` · `MaterializeManyOutcome` · `MaterializeManyRun` · `MaterializeManyStats` · `MaterializeManyOperandStats` · `MaterializeManyOutputStats` · `CombineOptions`
· `IdIterator` · `IdStream` · `LoadInput` · `PortableBitmap` · `RoaringBitmapDeserializeOptions` · `LoadOptions` · `LoadGuard`
· `LoadResult` · `LoadRefusal` · `GenerationEntry` · `GenerationMetadata` · `RollbackResult` · `SegmentInfo` · `SegmentStat` · `PinAt`
· `PinOptions` · `Lease` · `PinnedAt` · `SegmentRef` ·
`MemoryStorageOptions` · `LocalFsStorageOptions` · `ExportFormat` · `ExportSink` · `ExportWriter` · `ExportOptions` ·
`ExportedSegment` · `ExportFailure` · `ExportSkipped` · `ExportManifest` ·
`InProcessKeystoreOptions` · `EraseDeps` · `DestroyResult` · `DropResult` · `RetentionPolicy` ·
`SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` · `RetireEntry` · `RetryPolicy` ·
`IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent` · `Clock` ·
`Rng` · `Entropy` · `Budget` · `BudgetOption` · `ErrorKind` · `ConsistencyReport` · `ConsistencyIssue` · `ConsistencyErrorEntry` · `PreflightResult` · `PreflightCheck`

### `@cloudbitmaps/core/driver-kit`

The contract a storage-driver package builds against — see
[Driver kit](#driver-kit--what-you-need-to-implement-a-driver) for what each one is for. Application code does
not import these.

Ports and the backend brand: `IStorageDriver` · `IRegistryDriver` · `StorageBackend` · `StorageCaps` ·
`TailRead` · `StorageDeleteOptions` · `SegmentRef` · `GenKey` · `LifecycleVerdict` · `brandAsBackend` ·
`STORAGE_BACKEND`

The registry row and its writes: `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` · `RegistryWriteOptions` ·
`RegCaps` · `Token` · `RegistryStatus` · `RegistrySummary` · `ClearRegistrySummary` · `SealedRegistrySummary` ·
`KnownGeneration` · `LeaseEntry` · `GovernanceMeta` · `GenerationMetadata`

The read-source port: `StorageChunkSource` · `ChunkRef` · `ChunkRead` · `ReadChunksOptions` · `SegmentSize` ·
`GenerationSummary`

The keystore port: `IKeystore` · `WrappedDek` · `Aead` · `AeadSealed`

Seams: `Entropy`

Metrics: `IMetricsSink` · `MetricEvent` · `MetricOpName`

A row's `pointerId`: `RESOLVED_FIELDS` · `renewsPointer` · `renewPointer` · `pointerIdOf`

Object-store registry: `ObjectStoreRegistry` · `ObjectRegistryStore` · `ObjectRow` · `ObjectVersionRaced` ·
`MAX_ROW_BYTES`

Keys, paths and prefixes: `normalizeObjectPrefix` · `prefixPart` · `encodeNameForKey` · `namespaceKeyPart` ·
`encodeNameForPath` · `namespacePathPart` · `storageObjectKey` · `segmentObjectPrefix` · `parseGenerationFromKey`

Driver helpers: `checkDeleteOptions` · `checkRegistryWriteOptions` · `refuseUnknownOptions` · `requirePositiveInt` · `requireBool` · `requireNonEmptyString` · `isTransportFault` · `toTransient` ·
`concatBytes`

Boundary helpers and errors: `validateSegmentRef` · `BlobSink` · `CloudRoaringError` · `ValidationError` ·
`WriteConflictError` · `NotFoundError` · `IntegrityError` · `TransientError` · `unsettledConflict` · `errorKind` ·
`ErrorKind`

### `@cloudbitmaps/s3`

`S3Storage` · `S3StorageOptions` — the backend, both halves in one bucket.

Each of these conditional requests — the write-once `PutObject`, a multipart upload's `CompleteMultipartUpload`,
the registry's create, compare-and-swap and tombstone, and with `conditionalDelete` the registry's `DeleteObject` under
`If-Match` — is [sent with the SDK's retry off for that request alone](correctness.md#sdk-retry), whether
the client is one you passed or one `S3Storage` built. Every other request keeps the client's retry, the storage half's conditional `DeleteObject` (below) included. The registry's
writes are sent once. A generation's object is sent again, at most three more times, after `503 SlowDown` (or any `503`) or
a bare `429` (AWS S3 does not send one; some S3-compatible services do) and nothing else, waiting a random time under 500 ms, then 1 s, then 2 s ([why that is safe](correctness.md#object-write-resent)): it carries a random id in its user metadata
(`x-amz-meta-cbwid`), and a precondition failure on a re-send, or an upload S3 no longer knows, reads it back, so an
object with its own id is a success and any other a `WriteConflictError`; with nothing stored, a `409` or an unknown
upload is an unknown outcome, a `TransientError`. A transient failure of a conditional write throws `TransientError`, and the write may
or may not have landed ([why](production.md#reliability-retries-backoff--timeouts)). The storage half's `DeleteObject` under `If-Match`, which with `conditionalDelete` deletes an erasure's holder only
while it is the object the erasure read, keeps the client's retry: a copy that meets its own landed delete finds
nothing, which is its success (a `412` on it is looked at with a `HeadObject` before it is called a conflict), and one
that meets an object stored since is refused.

With `readTimeoutMs` set (it is off by default), each read the backend makes, every `GetObject` and `HeadObject` of a
generation or a pointer, is aborted if it has not finished, body included, after that many ms, and throws
`TransientError` with a message that names the request and says it timed out after that many ms. The timeout is per request, set through the request's abort signal, so the
SDK's own retries of that request fall inside it and nothing else the client sends is timed.

### `@cloudbitmaps/gcs`

`GcsStorage` · `GcsStorageOptions` — the backend, both halves in one bucket. It builds its own client, which
also sidesteps a confusing collision: `@google-cloud/storage` calls its client class `Storage`, which reads as
this library's word for the durable tier, so the backend takes it as `client`.

The client the backend builds sends each download once, because in `@google-cloud/storage` 8.x (checked on 8.1.0) and 7.x
(checked on 7.22.0, outside the driver's range) a download the SDK retries after any status it retries (408, 429, 500, 502, 503 or 504) can crash the
process with `ERR_STREAM_UNABLE_TO_PIPE`. The driver retries a download itself, up to three more times with backoff,
after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504,
and after nothing else (not a missing credentials file or a TLS failure); what still fails is a `TransientError`. Its
listings, deletes, resumable uploads and the metadata read that settles a write keep its retry settings (under which the
SDK sends a delete with no precondition once); a single-request conditional write is sent without them. A client you
pass as `client` keeps its own retries for those requests: its downloads go through a twin of it, built from its own
class with the same credentials object, endpoint, project, user agent, timeout, checksum generator and interceptors and
the SDK's retries off ([why](production.md#reliability-retries-backoff--timeouts)). A `Storage` client is always used
through its twin, which must have taken the settings that decide where and how a download goes: the same credentials
object, URL and endpoint, and retry settings of its own, which are then turned off over any its class set. The backend
refuses, when it is built, a client whose twin would not (a subclass that builds from options of its own), one whose
class overrides `bucket` (as a test double built on `Storage` does), and one whose `bucket` is replaced on the instance
(as by a test stub). Stub `Storage.prototype` (or `Bucket.prototype`, `File.prototype`) instead, which reaches the twin;
a stub on the client's instance does not. A test double that is not a `Storage` client is used as it is when it has
`retryOptions: { autoRetry: false }`, and refused without it; with the SDK's module mocked, pass the mock as `client`.
What is set on a client after the backend was built, other than an interceptor, is not carried to the twin.

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
a delete under `ifGenerationMatch`, which [the SDK retries as it does any request with a precondition](correctness.md#sdk-retry): a second copy can
remove nothing the first could not, and one that meets the first's landed delete is a 404, which the registry reads as
a lost race and re-reads. With it the storage half deletes an erasure's holder under `ifGenerationMatch` too, the
generation its tail read reported, and there a `404` is an absent object, a no-op, and a `412` is a conflict only while
the metadata still shows an object.

### `@cloudbitmaps/azure-blob`

`AzureBlobStorage` · `AzureBlobStorageOptions` — the backend, both halves in one container. Give it a
`containerClient`, or a `connectionString` + `container` and it builds one. A `connectionString` that is empty, not a
string or not one the Azure SDK can parse throws `ValidationError`, whose message never holds the string, since it
carries the account key.

Generations are write-once via `ifNoneMatch: '*'`. The registry lets an Azure deployment
run on **one container alone**: compare-and-swap rides blob conditions (`ifNoneMatch: '*'` to create,
`ifMatch: <etag>` to swap), so no second service is needed to hold the `currentGen` pointer. Every request goes
through the client's retry policy, the conditional writes included. Each conditional write carries a random id in
the blob's metadata, and a conflict reads the stored blob back, so a blob that carries its own id is a success and
any other a `WriteConflictError`; for a registry row that read-back is not definitive, since a writer that swapped in over
a write that landed makes it report a conflict, and a load or a rollback reads the row again
([why](production.md#reliability-retries-backoff--timeouts)). The client's policy sends
a write again after a `503 ServerBusy` or a `500 OperationTimedOut`, and a write that every try refused throws
`TransientError`. A load's fresh compare-and-swap after an unanswered row write goes through that policy too, so a registry
that never answers costs up to four times the policy's tries: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that schedule, not measured). The registry removes a
row with Delete Blob under `ifMatch`, unless `conditionalDelete` is `false`; a `412` or a `404` on it is a lost race,
and a `409` (a snapshot or a lease in the way) reaches the caller as the SDK raised it. The storage half deletes an
erasure's holder under `ifMatch` too, with the ETag its tail read reported, unless `conditionalDelete` is `false`:
there a `404` is an absent blob, a no-op, a `412` is a conflict only while the properties still show a blob, and a `409`
reaches the caller as the SDK raised it.

### `@cloudbitmaps/tools`

The cost model ([offline tools](#offline-tools--cloudbitmapstools)).

Values: `estimateCost` · `groundedReport` · `AWS_US_EAST_1_ONDEMAND` · `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND` · `ONE_REDIS_HA_CLUSTER`

Types: `CostReport` · `PricingProfile` · `RedisSizing` · `RedisNodeType` · `Workload` · `SegmentSizing` · `EstimateInput`

## Keeping this in sync

- The **sync test** ([`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts))
  derives its entry list from every package's own `exports` map — so each package and each subpath it declares
  is covered, with no list to maintain — and asserts each exported name appears (backtick-wrapped) under **its own
  entry's heading** in the **"Complete export index"** section — so **adding an export without documenting it
  breaks CI**. Core's main entry and `/node` are internal and are skipped. It runs in **both**
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
