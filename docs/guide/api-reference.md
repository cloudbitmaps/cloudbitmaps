# API Reference — the complete surface

The single source of truth for **everything a user can import and call** across all entry points. Organized
user-first: the everyday surface at the top, the occasional operations next, the driver-author plumbing last, and
a flat **[Complete export index](#complete-export-index)** at the end that names every export.

> **Kept in sync by CI.** [`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts)
> derives the list of entry points from every package's own `exports` map — so each package in the workspace and
> each subpath it declares is covered, with no list to keep up to date — extracts every exported name from each,
> and fails the build if any is missing from this page. So a new export **cannot** merge without being documented
> here. (The guard is one-way — it catches undocumented _additions_, not stale entries for a _removed_ export;
> prune those in review.)

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
both. Each package is its own entry point; nothing is reachable through another:

```
@cloudbitmaps/roaring         the store + memory/localfs drivers + every function & type
@cloudbitmaps/s3              S3Storage, S3StorageDriver, S3RegistryDriver        (dep: @aws-sdk/client-s3)
@cloudbitmaps/gcs             GcsStorage, GcsStorageDriver, GcsRegistryDriver     (dep: @google-cloud/storage)
@cloudbitmaps/azure-blob      AzureBlobStorage, …StorageDriver, …RegistryDriver   (dep: @azure/storage-blob)
@cloudbitmaps/core/driver-kit the declared contract for writing a driver package   (driver authors only)
CLI (binary):                 export-segments
```

Each cloud SDK is a **real dependency** of its driver package, not an optional peer: installing
`@cloudbitmaps/s3` installs `@aws-sdk/client-s3`, and no install carries an SDK for a service you do not use.

**Where the code actually lives.** The flavor package is the roaring codec (`SafeBitmap` / `roaringCodec`),
the `CloudRoaring` facade, and the `export-segments` CLI; its main barrel re-exports `@cloudbitmaps/core`
wholesale, which is why an application never needs to name core. The drivers are codec-agnostic — they move
opaque payload bytes — so one package per storage **service** serves every codec, which is what makes adding
a codec cost nothing on the storage axis. A driver author builds against
[`@cloudbitmaps/core/driver-kit`](#cloudbitmapscoredriver-kit), and a flavor never re-exports a driver
package: doing so would put that SDK back into every install.

---

## The everyday surface (what you'll call)

### Build a store — `new CloudRoaring(options)`

`storage` is the **only option a store needs** — pass a backend and you are done; it already carries the pointer that gives one-read generation resolution, encrypted segments,
the `*Into` verbs and every lifecycle helper (recommended for anything beyond a first look). Everything else is
optional tuning with sensible defaults — see [`CloudRoaringOptions`](#construction--result-types).

**Normally you pick a backend, not drivers.** A `StorageBackend` carries both halves — the generations and the
pointer — configured from one bucket and one prefix, which is what makes them impossible to mismatch:

| Backend | Import | Construct |
|---|---|---|
| `MemoryStorage` (`MemoryStorageOptions`) | `@cloudbitmaps/roaring` | `new MemoryStorage()` |
| `LocalFsStorage` (`LocalFsStorageOptions`) | `@cloudbitmaps/roaring` | `new LocalFsStorage('/var/lib/cloudbitmaps')` — generations under `<root>/storage`, pointers under `<root>/registry`, which is also the layout `export-segments` expects |
| `S3Storage` | `@cloudbitmaps/s3` | `new S3Storage({ bucket, prefix?, client?, region?, endpoint?, pathStyle?, credentials?, now? })` |
| `GcsStorage` | `@cloudbitmaps/gcs` | `new GcsStorage({ bucket, prefix?, client?, projectId?, apiEndpoint? })` |
| `AzureBlobStorage` | `@cloudbitmaps/azure-blob` | `new AzureBlobStorage({ containerClient })` or `({ connectionString, container })` |

**A backend comes from one of these five classes, or from `createBackend`.** A plain `{ storage, registry }` object is
refused — it is also the shape of the free functions' deps, so before this it was possible to build a store
from halves belonging to two *unrelated* stores, which constructed happily and then read as **empty** because
the pointer it consulted lived where nothing had been written.

| function | what it is for |
|---|---|
| `createBackend({ storage, registry })` → `StorageBackend` | the deliberate door, for what a class cannot express: a driver wrapped for auditing/metrics/tenant-scoping, a registry in a database you already run, a fault-injecting double in a test. It validates each half, but **cannot** check that the two agree — the driver interfaces expose no location — so calling it is you taking that on. |
| `isStorageBackend(value)` → `value is StorageBackend` | checks the brand, not the shape |

Each builds its own SDK client unless you pass one, exposes both halves as `.storage` and `.registry`, and
accepts an injected `now` for deterministic tests.

The individual drivers remain exported for wiring a backend class does not cover — a different store for the
pointer than for the objects, or a decorator around one half. Combine them with `createBackend`; you cannot
write your own class implementing `StorageBackend`, because the brand is not exported:

| Slot | in-memory | local disk | cloud |
|---|---|---|---|
| **storage** (the `.crbm` generations) | `MemoryStorageDriver` · `MemoryStorageChunkSource` | `LocalFsStorageDriver` | `S3StorageDriver` · `GcsStorageDriver` · `AzureBlobStorageDriver` |
| **registry** (the `currentGen` pointer + wrapped keys) | `MemoryRegistryDriver` | `LocalFsRegistryDriver` | `S3RegistryDriver` · `GcsRegistryDriver` · `AzureBlobRegistryDriver` |
| **keystore** (optional encryption) | `InProcessKeystore` (BYOK) | ← same | ← same |

Pass a **raw** `IStorageDriver` as `storage` and the store builds the `.crbm` reader (`CrbmStorageChunkSource`) over it with
**no registry** — generations then resolve by list-scan, so the store is **cleartext and read-only**; or pass a pre-built `StorageChunkSource` (`MemoryStorageChunkSource`, or a
`CrbmStorageChunkSource` you configured yourself) and it is used as-is — a top-level `encryption` group is
then rejected as a wiring mistake (configure it on the source). A store built on a
pre-built source is **read-only**: the `*Into` verbs and the lifecycle helpers need the raw driver and throw
`UnsupportedError`.

### Get a segment — `store.segment(name, { namespace?, expiresAt? })` → `Segment`

`expiresAt` is an absolute epoch-**milliseconds** deadline, declared where the segment is named. Past it, every
read through **that handle** answers empty — `has` → `false`, `count` → `0`, `iterate` → nothing — as one integer
compare against the injected clock, with **no I/O, on every backend**. Set algebra stays coherent with it: an
expired operand makes an `intersect` empty, is dropped from a `union`, and excludes nothing in an `andNot`.

It does **not** reclaim the bytes (`retireExpired` does, so `count()` reporting 0 while objects still exist is the
expected state in that window) and it does **not** apply to other handles — record the policy with
`setRetention` to make it durable, fleet-visible and reclaimable. A seconds-shaped value is refused at the
handle rather than silently making the segment permanently empty. `seg.expiresAt` reads it back.

### Load a generation — `store.load(ref, ids, { allowEmpty?, guard?, keep?, audit? })`

The whole write path in one call. The lower-level `bulkLoadCrbmGeneration(storage, key, ids, { registry, … })`
writes a single object without the guard or the collect, and is listed under the free functions below.

**The write path.** Streams `ids` — any sync **or async** iterable, unsorted, duplicates welcome — into one
immutable `.crbm` object at `generation`, then publishes it through `registry` (forward-only). Returns a
`BulkLoadResult` — `{ size, sha256, chunkCount, cardinality, becameCurrent?, wrappedDeks? }`. Take the generation number from
`nextGeneration(ref, { storage, registry })`; a re-used number throws `WriteConflictError` (write-once), and a
publish that would move the pointer backwards is a no-op, so a rerun is safe and a crash before the publish never
moves the pointer. Options: `registry?` (publish; required for encryption), `keystore?` (write encrypted — mints
the segment's DEK on its **first** generation, reuses it afterwards, and never encrypts a segment whose existing
generations are cleartext), `requireEncryption?`, `audit?` (emits `segment.publish`), `codec?` and `clock?` (both
pre-bound by `@cloudbitmaps/roaring`; the clock is what makes a long load yield the event loop). Memory is bounded
by the **distinct set** being built, not by the input length — a batch job's shape, not a request handler's.

`becameCurrent` says whether this generation is now the segment's current one; it is absent when no `registry`
was wired, since there is then no pointer to move. **`false` means the object is durable and the load did not
take effect** — a concurrent writer published a higher generation first, so yours is an orphan no reader will
resolve. Branch on it if two writers can target one segment; the orphan is collected by
`gcOrphanGenerations`/the retention sweep.

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.has(id)` → `Promise<boolean>` | membership: the cache, else **one** ranged GET of that id's chunk |
| `seg.count()` → `Promise<number>` | exact cardinality, summed from the `.crbm` index — **zero payload reads** on a loaded segment |
| `seg.iterate()` → `AsyncIterable<number>` | stream all ids, ascending, one chunk at a time |
| `seg.pin()` → `Promise<Segment>` | **hold this segment at the generation current right now**, for the life of the returned handle — so a long export, reconciliation or send describes **one instant** instead of whichever generations happened to be current as it ran. An ordinary handle re-resolves on `cache.genTtlMs`; a pinned one does not. Only *this* segment is pinned: `snap.intersect([other])` reads `snap` at its pin and `other` live, so pin each segment to hold a whole query — and a pinned handle used as an operand is still read at its pin, never live. **A hold, not a lease**: nothing stops `gcOrphanGenerations` deleting the generation underneath you, and a pinned read deliberately does *not* heal forward (silently serving a different generation is what a pin exists to prevent), so it fails instead — size `keep` past your longest pinned job. The pinned reader lives in the same bounded LRU as every other, so a pin costs a generation number, not a retained index. A segment with no current generation pins nothing and reads empty. A pin taken before a crypto-shred stops reading when the shred lands: the row's `status` is re-checked every time the pinned reader opens. Needs the `.crbm` storage source (`UnsupportedError` otherwise) |
| `seg.intersect([other, …], { concurrency?, budget?, exclude? })` → `AsyncIterable<number>` | **the crown jewel** — chunk-skipping intersection, streamed. `exclude` subtracts suppression segments **in the same pass** |
| `seg.union([other, …], { concurrency?, budget?, exclude? })` → `AsyncIterable<number>` | `this ∪ others`, streamed. The one composite with **no chunk-skipping** — every chunk of every operand is read |
| `seg.andNot([sup, …], { concurrency?, budget? })` → `AsyncIterable<number>` | `this \ (sup…)`. Reads all of `this`, but each exclude **only where it overlaps** |
| `seg.intersectInto(dest, [other, …], opts?)` · `seg.unionInto(dest, [other, …], opts?)` · `seg.andNotInto(dest, [sup, …], opts?)` → `Promise<MaterializeResult>` | materialize the result as a **new generation of `dest`** — `dest`'s previous contents are superseded, not added to. Streaming, bounded memory, published forward-only, so readers of `dest` see the old generation or the new one, never a partial. **An empty result is refused rather than published over a NON-EMPTY destination** — `dest` keeps what it had, and the result carries `published: false` with `reason: 'empty'`. Into a destination that was never loaded it still publishes: there is nothing to protect. Pass `allowEmpty: true` when emptying `dest` is the point, and `guard: { minCardinality, minRetained }` for the same plausibility bounds `load()` takes, judged against what `dest` held. A refusal is reported, not thrown — branch on `published`. A call involving an expired handle is refused earlier and harder (`ValidationError`). Throws `WriteConflictError` if the destination changed underneath the call. **That does not by itself mean nothing was published** — the same error covers a pointer that moved, a row rewritten by something that is not a supersession at all (a `setRetention`), a purge, and the collection pass that runs after a successful publish. Re-read `dest` and decide; do not treat it as "the write did not happen". `opts.audit` emits `segment.publish` for the generation it lands, and `segment.load-refused` for one it refuses — a materialisation reports as the load it is. Unlike `load()` it **collects nothing** by default, so a `rollback` target survives it; pass `keep` to collect. Needs a backend |
| `seg.costReport({ pricing?, workload? })` → `Promise<CostReport>` | grounded $ report from the segment's **real** `.crbm` size (no payload reads) |
| `seg.expiresAt` | the handle's deadline, if one was declared |

That's the whole daily surface: **1 constructor + a storage driver + a registry + one load function + these verbs.**

**Which chunks each combine has to read** — this is the cost model, and it is a property of the set operation
rather than of the implementation:

| | chunks read | can skip? |
| --- | --- | --- |
| `intersect` | keys present in **every** operand | **yes** — the crown jewel |
| `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly — the suppression side |
| `union` | every chunk of **every** operand | no — an id in any operand belongs to the result |

All three are charged against the same per-op budget, so a wide union is refused rather than quietly billed.

> **To suppress the result of an intersection, do not chain.** `a.intersect([b], { exclude: [s] })` folds the
> subtraction into one pass; `intersectInto` a temp segment followed by `andNot` materializes an intermediate
> nobody wants — and reads `s` in full rather than only where it overlaps.

**Read consistency.** Every read op resolves the segment's current generation **once** and reads every chunk from
that generation. With a `registry` wired, a long-lived store re-resolves the pointer on a short TTL
(`cache.genTtlMs`, default 2000 ms), so after a load publishes, a reader may serve the previous generation for at most
that long, then converges; the cache is keyed by generation, so a new generation is never served from stale
decoded chunks.

---

## Operations you call when you need them

### Store methods

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace? \| allNamespaces?, concurrency?, budget? })` → `SubjectReport` | GDPR Art. 15 — which registered segments is this id in? (needs an explicit namespace or an `allNamespaces` ack) |
| `store.eraseSubject(id, { namespace? \| allNamespaces?, audit?, concurrency?, budget? })` → `EraseSubjectResult` | GDPR Art. 17 — for every registered segment the id is in, **rewrite the current generation without it**, publish fenced on the generation it streamed, and delete the generation that held the bit, so it is physically gone from the bucket on return. Returns the erasure ledger: one `SubjectErasureEntry` per segment the id was found in (`erased`, `fromGeneration`, `generation`, and a `note` — `'superseded'` when another writer moved the pointer mid-rewrite, meaning *this call* did not erase the id rather than that the id is still there, or `error: …` for an isolated fault; re-run either — including a fault that landed *after* that segment's rewrite published (a Storage `delete` fault, or a collect that could not prove the segment was still the same one), where the pointer has moved and the re-run searches the **superseded** generations too: usually `erased: true` against the generation it found the id in, nothing at all if a racing collector took that generation first (gone, but unreceipted), and — if the segment's row has since been purged — **not scanned at all**, leaving an orphan for `checkConsistency`/`gcOrphanGenerations`. An empty ledger is not by itself proof the id is gone). Emits `segment.rewrite` per rewrite when `audit` is passed. Do not load the segment while erasing from it. Needs a backend |
| `store.load(ref, ids, { allowEmpty?, guard?, keep?, audit? })` → `LoadResult` | **replace this segment's contents** with `ids`, as one new immutable generation — the whole write path in one call: next generation number → write the object → check it is plausible → move the pointer → collect what the move superseded (the step that gets left out when this is composed by hand). **Branch on `published`:** a refusal is a normal outcome, not a throw, and with the empty guard on by default this verb refuses more readily than any other — a discarded result is a load that silently did nothing. `guard: { minCardinality?, minRetained? }` plus the default refusal of an empty result over a non-empty segment (`allowEmpty` overrides) are what stop an upstream query that returned too little from landing as a shrink or a wipe; they run **between the write and the publish**, the only moment where the new content is known and the old one is still authoritative. `cardinalityBefore` says what the segment held, so a refusal is a diagnosis rather than a page. Note the `*Into` verbs **throw** on the same superseded condition instead. Two paths do throw here: a crypto-shredded segment (`ValidationError`) and a collection pass that could not prove the segment was unchanged (`WriteConflictError` — raisable *after* the publish landed, so a throw does not itself mean the load did not take effect). Needs a backend |
| `store.exists(ref)` → `boolean` | whether a read of this segment would find anything — the *"do I already have this?"* question, as **one registry point read**. There is no `create` in this library: `store.segment(name)` is a validated address that does no I/O, so naming a segment can never collide with an existing one; a segment starts existing when something is first loaded into it. **Not the same as `count() > 0`** — a segment loaded with no ids exists and counts zero, and telling "never loaded" from "loaded, and genuinely empty" is the distinction `count()` cannot make. `false` for a row minted ahead of the first load (`setRetention` does that) and for a `destroyed` tombstone, because a read answers empty in both. Two states answer `true` where a read still gives you nothing and neither is this call's job: a **torn restore** (a live pointer whose object was deleted) makes reads *throw* — `checkConsistency` is the call for that — and a handle with an expired `expiresAt` reads empty by a rule that lives on the handle. Not a lock: use `load`'s `guard`, or `expectFrom`/`expectToken`, if the answer must hold. Needs a registry |
| `store.segments({ namespace? })` → `AsyncIterable<SegmentInfo>` | every segment the registry holds, **streamed**, optionally scoped to one namespace — so you do not keep your own list of segment names beside the store, which is a second source of truth that drifts from this one the first time a load fails halfway. **An admin/discovery call, not a request-path one:** this is the registry's own enumeration — a paged LIST over the `registry/` prefix — so cost grows with the fleet rather than with what you are looking for. Scoping to a namespace narrows that LIST prefix, so it really is the difference between reading one tenant and reading all of them. Stopping the iteration stops the scan, **except** behind a driver that buffers to retry the `list` as a unit, which `RetryingRegistryDriver` does. Yields `destroyed` tombstones and rows whose `currentGen` is `null`, because a filtered enumeration that looks complete is worse than an honest one — filter yourself, or ask `store.exists` the narrower question. Internal bookkeeping rows are the one exclusion, and only on an unscoped scan. Needs a registry |
| `store.generations(ref)` → `GenerationEntry[]` | every generation still in the bucket, ascending, with the current one marked — what the bucket **holds**, not what the segment has ever been, since collection deletes superseded objects. The set `store.rollback` can choose from. One `list` call; it does not open the objects. Needs a backend |
| `store.rollback(ref, toGeneration, { audit? })` → `RollbackResult` | **move the pointer back** to a generation still in the bucket — the one write in the library that is not forward-only, and the only one no automatic path performs. Forward-only is right for a *writer* (a load whose ids came from upstream loses nothing by being out-raced, and regressing would let a slow loader silently undo a fast one) and wrong for an *operator* who has looked at the segment and knows which generation they want. Refuses rather than guesses: a generation not in the bucket throws `NotFoundError` **naming what is available**, a crypto-shredded segment throws `ValidationError` (every generation of it is unreadable), and rolling to the generation already current is a reported no-op. **Deletes nothing** — the generations above the new pointer stay, which is what makes the rollback itself reversible; they are then above `currentGen` where collection never looks, so they remain until a later load raises the pointer past them. Fenced on the row it read, so a concurrent load is refused (`WriteConflictError` — re-read and retry) rather than undone. A target *above* the pointer needs `{ allowForward: true }`: that is where objects live which were never published, such as a load that wrote its object and died before the publish. Audited as `segment.rollback`, because every other pointer move can be reconstructed from "a load happened" and this one cannot. Needs a backend |
| `store.dropSegment(ref, { confirmSegment, dryRun?, audit? })` → `DropResult` | **retire a segment and reclaim its storage** — registry tombstone first, then every Storage generation (swept up to three passes; **check `generationsRemaining`** — non-empty means bytes survived and the drop should be re-run). Branch on `dropped`; `reason` is `'already'` if it was already a tombstone (a re-drop still re-sweeps Storage), `'absent'` only when **nothing existed** — the one worth alerting on. On an encrypted segment it also drops the DEK (`cryptoShredded: true`). `dryRun` previews `wouldDelete` / `wouldCryptoShred` without touching anything. Reads become empty within `cache.genTtlMs` for a reader that has a clock and a registry. Needs a backend |
| `store.setRetention(ref, { expiresAt })` → `SetRetentionResult` | **record when this segment becomes eligible for retirement** — one registry write, nothing deleted, nothing scheduled. `expiresAt` is an absolute epoch-**ms you compute** (a duration the library derived would be anchored to `updatedAt`/`currentGen`, both of which every load rewrites, so a busy segment would never expire). Works **before the first load**: it mints the registry row (`createdRow: true`) with `currentGen: null` — no Storage generation — so the segment is enumerable by the sweep and the first publish lands on that row. `indexed` says whether the due-index pointer was written (false is a degradation: the fleet scan still retires it). Rejects a value below `MIN_EXPIRES_AT_MS` (almost certainly epoch *seconds*) and refuses a crypto-shredded segment |
| `store.getRetention(ref)` → `RetentionPolicy \| null \| 'invalid'` | the stored policy; `null` for none, `'invalid'` for a present-but-unusable `expiresAt` (a hand-edited row, a restore) so a malformed policy is visible rather than reading as "never expires" |
| `store.clearRetention(ref)` → `boolean` | cancel the expiry; returns whether one was actually removed. A separate verb from setting one on purpose — "never expire" as a magic value passed to the setter is how a typo becomes a deletion |
| `store.retireExpired({ namespace?, now?, limit?, dryRun?, scan?, lookbackBuckets?, shards?, totalShards?, maxScanSegments?, purgeTombstones?, tombstoneGraceMs?, audit? })` → `RetireExpiredResult` | **the retention sweep** — retire every segment whose `expiresAt` has passed, each through `dropSegment` (one implementation of the registry → Storage ordering, not two). **A call, not a daemon**: you schedule it (EventBridge, CronJob, cron, a queue job). Returns a per-segment ledger; a per-segment *fault* is an `entries` row rather than a throw, though a bad argument throws `ValidationError` and a fleet past `maxScanSegments` (default 250,000) throws `BudgetExceededError`. `limit` (default 100) caps **attempts**, so a partial outage cannot march through the fleet; `limited: true` means more are eligible, re-run. `dryRun` is the real preview (`confirmSegment` is vacuous in a loop) and reports `wouldRetire`, leaving `retired` at 0. **`scan: 'index'`** reads only the due buckets of the due index — cost tracks what is *expiring*, not the fleet — re-reading each live row before acting; it is the **fast half of a pair**, so run the default `'fleet'` periodically as the repair pass (`lookbackBuckets`, default 7, is how many past days a fast scan also reads). `shards` / `totalShards` give each replica a disjoint slice by a stable hash of the segment key. Also deletes the tombstone rows **it stamped itself**, after `tombstoneGraceMs` (default 24 h) and only once Storage is provably empty (collecting a straggler generation first); a `destroyed` row it did not create — a GDPR crypto-shred — is never touched. Needs a backend |
| `store.checkConsistency({ namespace?, concurrency? })` → `ConsistencyReport` | DR: verify every segment's `currentGen` `.crbm` is present (catch a torn cross-store restore). Needs a backend |
| `store.exportSegments(sink, { format?, namespace?, ndjsonBatchBytes? })` → `ExportManifest` | eject every registered segment's current generation to portable `roaring`/`ndjson` through your sink. Needs a registry |
| `CloudRoaring.estimateCost(input)` → `CostReport` | **static** — plan costs with no instance/data (sizing, what-if) |

### Standalone functions (imported, called directly)

The out-of-process forms: a scheduled job or CLI wires its own drivers and calls these. Where a store method exists,
it is the same function over the store's own drivers.

| Call | Does |
|---|---|
| `bulkLoadCrbmGeneration(storage, key, ids, { registry?, keystore?, requireEncryption?, audit?, codec?, clock?, publish? })` → `BulkLoadResult` | **load** a generation from a (huge, unsorted, sync or async) id stream and publish it — see [above](#load-a-generation--storeloadref-ids--allowempty-guard-keep-audit) |
| `nextGeneration(ref, { storage, registry })` → `number` | the generation number a writer should take next: one above the highest the registry points at **or** that is present in Storage (a load that wrote its object and crashed before publishing leaves an object above `currentGen`; skipping past it keeps the retry trivial). A segment with no row and no objects starts at `0` |
| `gcOrphanGenerations(ref, { storage, registry }, { keep? })` → `number[]` | delete superseded generations — everything below `currentGen` except the newest `keep` (default 1) as a grace window for in-flight readers. Never touches `currentGen` or anything above it, and deletes nothing while `currentGen` is `null`. **Exception:** on a `destroyed` segment every generation is garbage and all are collected. The row is read before the listing and acted on after it, so both branches reconcile with a re-read: a tombstone must still be the same row (compared by **token** — a generation number is not an identity, and a re-created name can wear the very `currentGen` the tombstone held), and the ordinary branch takes the **lower** of the pointers read before and after, so a publish landing mid-listing still collects while a pointer that *regressed* — a purge-and-re-create, or a deliberate `rollback` — narrows the cutoff instead. **Throws `WriteConflictError` if the segment changed underneath the pass** (re-checked before every delete, since the deletes are a round trip each — so a refusal may already have deleted some of the objects it will now never report); re-run it. It still returns an empty array for the two cases that really are "nothing to collect" — no row at all, or no pointer yet — so an empty array is **not** a receipt: `eraseIdFromSegment` reads the list as the physical half of its erasure receipt, and verifies that the generation it needed is **gone from the bucket** rather than merely present in this list — a concurrent collector may have taken it first, which is the outcome rather than a failure. `keep` counts distinct generations, not listing entries. Nothing schedules this: the erasure rewrite calls it with `keep: 0`, the retention sweep calls it on tombstones, and a caller writing generations by hand collects on its own cadence. Returns the generations deleted |
| `publishGeneration(registry, key, { wrappedDeks?, expectFrom? })` → `boolean` | point `currentGen` at `key.generation`. **Forward-only and idempotent**: creates the row if absent, advances via CAS, returns `false` (a no-op) if a newer generation is already current, refuses a `destroyed` row. Separated from the object write so a caller publishes only after the object is durable. `expectFrom` makes it a **read-modify-write**: the publish lands only while `currentGen` is still exactly that number, and returns `false` otherwise — which is what a writer whose content was *derived* from a particular generation needs (the erasure rewrite), as against a load, whose ids come from upstream and lose nothing by winning. New key material is refused on an advance: a segment's encryption is decided at its first generation |
| `writeCrbmGeneration(driver, key, chunks, { crypto?, clock? })` → `{ size, sha256 }` | the lower-level seed primitive: write one generation from pre-grouped `{ chunkKey, bitmap }` entries (empty bitmaps skipped). Does **not** publish |
| `listGenerations(ref, { storage, registry })` → `GenerationEntry[]` | every generation still in the bucket, ascending, with the current one marked. One `list` call; it does not open the objects. `store.generations` is the wired form |
| `segmentExists(ref, registry)` → `boolean` | the unwired form of `store.exists` — one registry `get`; true only when a live, non-`destroyed` row has a `currentGen` |
| `listSegments(registry, { namespace? })` → `AsyncIterable<SegmentInfo>` | the unwired form of `store.segments`; validates `namespace`, and excludes internal bookkeeping rows on an unscoped scan |
| `rollbackSegment(ref, toGeneration, { storage, registry }, { audit?, allowForward? })` → `RollbackResult` | **move the pointer back** to a generation still in the bucket — the one write that is not forward-only, and the only one no automatic path performs. Throws `NotFoundError` for a target not in the bucket (naming what is), `ValidationError` for a crypto-shredded segment or an above-pointer target without `allowForward`, and `WriteConflictError` when the row moved under it (re-read and retry). The target is verified **after** the swap, not before: it sits inside generation collection's range until the pointer names it, and a collector never writes the row, so a pre-swap listing proves nothing — if it vanished in that window the pointer is put back and the call throws. `store.rollback` is the wired form |
| `loadSegment(ref, ids, { storage, registry, codec?, keystore?, requireEncryption?, clock? }, { allowEmpty?, guard?, keep?, audit? })` → `LoadResult` | **replace a segment's contents** with `ids`, as one immutable generation, and make it current — the whole write path in one call: next generation number → write the object → check it is plausible → move the pointer → collect what the move superseded. Composed by hand that last step is the one that gets left out, so segments accumulate superseded generations nobody notices and everybody pays for. **A load REPLACES**: whatever the stream holds is what the segment holds afterwards, so an upstream query returning fewer rows than usual is an unrequested shrink and an empty one is a wipe — both an ordinary successful write at the storage layer. `guard: { minCardinality?, minRetained? }` and the **default refusal of an empty result over a non-empty segment** (`allowEmpty` overrides) are what catch that, and they run **between the write and the publish** — the only moment where the new content is known and the old one is still authoritative. A refusal is a normal outcome, not a throw: `published: false` with `reason` (`'empty'` · `'min-cardinality'` · `'min-retained'` · `'superseded'`), in the same shape as a success, and the object written for a refused load is **deleted again** before returning, because it sits above `currentGen` where collection never looks and nothing else would reclaim it. Emits `segment.publish` on success and `segment.load-refused` on a refusal. `store.load` is the wired form |
| `eraseIdFromSegment(ref, id, { storage, registry, keystore?, requireEncryption?, codec?, clock?, maxBitmapBytes? }, { audit? })` → `EraseIdResult` | remove **one id** from one segment by rewriting its current generation without it (streamed, one chunk in flight), verifying the rewrite, publishing it fenced on the generation it streamed, and collecting the superseded generation (`keep: 0`). `erased: true` means the bit is physically gone on return; otherwise `reason` is `'absent'` · `'destroyed'` · `'no-generation'` · `'not-member'` · `'superseded'` (another writer moved the pointer off `fromGeneration` while the rewrite was in flight — a load, or another erasure. It means *this call* did not erase the id, not that the id is still there: re-run, and if a racing erasure of the same id got there first the re-run reports `'not-member'`. A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had just written; the reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` and one purged by the retention sweep reports `'absent'`. A `NotFoundError` is raised only when the pointer still names the missing object — the forbidden `missing-storage-generation` state, which no re-run fixes). `collected` lists the generations **this call** deleted — evidence for the physical half of an Art. 17 erasure, and what to keep if you are building a proof-of-deletion artifact. It can legitimately be **empty on a successful erasure**, when a concurrent collector removed the holding generation first: `erased: true` is a claim about the bucket, not about who emptied it. A publish that could not collect **throws** (`WriteConflictError` when the collect could not prove the segment was still the same one — re-created, or its row purged) rather than report `erased: true` over bytes still there, and a chunk holding an out-of-range value throws `IntegrityError` rather than being re-encoded into the new generation (a corrupt segment is reported as corrupt, not erased). `store.eraseSubject` runs this over every registered segment |
| `destroySegment(ref, { registry }, { confirmSegment, allowCleartext?, audit? })` → `DestroyResult` | crypto-shred one whole segment (key deleted → bytes unrecoverable everywhere, backups included); leaves the objects in the bucket, needs encryption unless `allowCleartext` |
| `eraseNamespace(namespace, { registry }, { confirmNamespace, allowCleartext?, audit? })` → `{ destroyed: DestroyResult[] }` | crypto-shred an entire namespace / tenant; per-segment faults land in the ledger (`reason: 'contended'` / `` `failed: …` ``) — **inspect it** |
| `dropSegment(ref, { registry, storage }, { confirmSegment, dryRun?, audit? })` → `DropResult` | **dispose of a segment** — tombstone, then delete every Storage generation. Works on cleartext; also crypto-shreds an encrypted one. `store.dropSegment` is the wired form |
| `runConsistencyCheck({ storage, registry }, { namespace?, concurrency? })` → `ConsistencyReport` | the free function behind `store.checkConsistency` — run it over your own drivers |
| `readRetentionPolicy(record.retention)` → `RetentionPolicy \| null \| 'invalid'` | parse a policy out of a row you **already hold** — a fleet sweep over `registry.list()`, where `getSegmentRetention` would cost a read per segment. The three-way answer is the point: `'invalid'` lets a sweep *report* a malformed row instead of silently reading it as "never expires" or aborting the whole ledger |
| `setSegmentRetention(ref, { registry }, { expiresAt })` → `SetRetentionResult` | the free function behind `store.setRetention` — for a scheduler/CLI that holds only a registry driver. `getSegmentRetention(ref, { registry })` / `clearSegmentRetention(ref, { registry })` are its read/cancel siblings |
| `retireExpired({ registry, storage }, { now, … })` → `RetireExpiredResult` | the free function behind `store.retireExpired` — for a scheduled worker that wires its own drivers. `now` is explicit here (core takes its time from the caller) |
| `runExport(reader, registry, sink, { format?, namespace?, ndjsonBatchBytes?, codec? })` → `ExportManifest` | the free function behind `store.exportSegments`; the flavor pre-binds the codec |
| `excludingReservedRows(listing)` | wraps a `registry.list()` stream and drops the bookkeeping rows (the due-index pointers). **Every unscoped fleet-wide enumeration must apply it** — `listSegments` and the sweep already do, so this is for a fleet pass you write yourself |
| `estimateCost({ segments, workload?, pricing? })` → `CostReport` | the free function behind the static `CloudRoaring.estimateCost` |
| `groundedReport({ storageBytes, grounded?, workload?, pricing?, extraNotes? })` → `CostReport` | build a report from a **measured** byte total (backs `segment.costReport()`) |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId, recoveryKeyId? })` | `keystore` (store, `bulkLoadCrbmGeneration`, `eraseIdFromSegment`) | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; `NOOP_METRICS` is the default) | `metrics` | observability — `storage.get` / `cache` / `retry` / `intersect` / `op` events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; omit the option to record nothing) | `audit` (on load / erasure / drop / sweep) | compliance trail — `segment.publish` / `segment.rewrite` / `segment.erase` / `segment.dispose` / `namespace.erase` |

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `export-segments` | eject all registered segments from a local-filesystem store to a directory. Env: `CR_EXPORT_ROOT` (holds `storage/` + `registry/`), `CR_EXPORT_OUT`, `CR_EXPORT_FORMAT` (`roaring` \| `ndjson`), `CR_EXPORT_NAMESPACE` |

---

## Types in signatures

The option / result types the public methods above reference — you import these to annotate variables.

### Construction & result types

`CloudRoaringOptions` and its six groups — `CacheOptions` · `EncryptionOptions` · `RetryOptions` ·
`SeamOptions` (`metrics` and `budget` take `IMetricsSink` / `BudgetOption` directly) · `SegmentOptions` ·
`SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `MaterializeResult` (`{ generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size, collected }` — what an `*Into` verb
wrote) · `BulkLoadResult` (`{ size, sha256, chunkCount, cardinality, becameCurrent?, wrappedDeks? }` — `becameCurrent` is absent with no `registry`, and `false` means the object is durable but a concurrent writer published a higher generation first, so the load did not take effect)

`CloudRoaringOptions`, in full — **one required key plus six optional groups**:

| key | type | what it holds |
|---|---|---|
| `storage` **(required)** | `StorageBackend \| IStorageDriver \| StorageChunkSource` | where everything lives |
| `cache?` | `CacheOptions` | `maxChunks?` (decoded chunks held in RAM, default 1024) · `ttlMs?` · `genTtlMs?` (default 2000 — the bound on read staleness after a publish; needs a backend) · `readerMax?` (open `.crbm` readers, default 1024) · `readerMaxBytes?` (their parsed indices, default 64 MiB) |
| `encryption?` | `EncryptionOptions` | `keystore?` · `required?` — both need a backend, since the wrapped DEK lives in the registry |
| `retry?` | `RetryOptions \| false` | a **partial** `RetryPolicy` (anything omitted keeps its `DEFAULT_RETRY_POLICY` value) plus `onRetry?`; `false` disables the transient-retry wrapper |
| `metrics?` | `IMetricsSink` | typed metric events; defaults to a no-op |
| `budget?` | `BudgetOption` | `{ maxRequests }` or `false` |
| `seams?` | `SeamOptions` | `clock?` · `rng?` — determinism, for tests and replayable jobs |

**The flat spellings are refused, not ignored.** `cacheMaxChunks`, `cacheTtlMs`, `storageGenTtlMs`,
`storageReaderCacheMax`, `storageReaderCacheMaxBytes`, `keystore`, `requireEncryption`, `onRetry`, `clock` and
`rng` each throw a `ValidationError` naming the group they moved into. Every one of them is a knob whose
absence is silent — a dropped `requireEncryption` reads cleartext, a dropped `clock` makes a deterministic job
non-deterministic — so being ignored would be worse than being rejected.

### Generation bookkeeping & erasure

`PinnedAt` (`{ generation, version }` — what a pin holds for one segment; `generation: null` means the segment had none to pin and the handle reads empty, **not** that pinning is unsupported) · `PinnedStorageChunkSource` (a `StorageChunkSource` view holding one segment at one generation and passing every other segment through to the live source — what `seg.pin()` is built on) · `GenerationDeps` (`{ storage, registry }` — what `nextGeneration` / `gcOrphanGenerations` take) · `EraseIdDeps` ·
`EraseIdResult` · `EraseDeps` · `DropDeps` · `DestroyResult` · `DropResult`

### Retention

`RetentionPolicy` · `RetentionDeps` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` ·
`RetireEntry`

### Export / eject

`ExportSink` · `ExportWriter` · `ExportFormat` · `ExportOptions` · `ExportedSegment` · `ExportFailure` ·
`ExportManifest`

### Cost & observability

`CostReport` · `PricingProfile` · `Workload` · `SegmentSizing` · `EstimateInput` · `IMetricsSink` · `MetricEvent` ·
`MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent` · `AuditEventKind`

The cost model has no per-id write term — data arrives as generations, and a generation is a load.
`PricingProfile` is `{ name, storage: { getPerMillion, putPerMillion, storagePerGiBMonth }, redis: { monthlyUSD } }`;
`Workload` is `{ readsPerSec?, intersectsPerSec?, cacheHitRate?, chunksPerIntersect?, loadsPerMonth?, requestsPerLoad? }`;
`CostReport.monthlyUSD.byOp` is `{ reads, intersects, storage, loads }`, and `redisCrossover.readsPerSec` is the
sustained read rate at which pay-per-use passes the flat baseline (≈329 reads/s at the default profile with a 0%
cache-hit rate). `MetricOpName` is `'has' | 'count' | 'intersectInto' | 'unionInto' | 'andNotInto'`;
`MetricsSnapshot` is `{ storage, cache, retries: { transient }, intersect, ops }`.

### The storage interfaces (used to type `storage` / `registry`)

`IStorageDriver` · `IRegistryDriver` · `StorageChunkSource` · `SegmentRef` · `IKeystore` · `RetryPolicy` · `Clock` · `Rng`

### Combine options (used to type `intersect` / `union` / `andNot` and the `*Into` verbs)

`BaseCombineOptions` (`{ concurrency?, budget?, audit? }` — `audit` is read only by the `*Into` verbs, which publish; the streaming verbs write nothing and emit nothing) · `CombineOptions` (adds `exclude?: Segment[]`)

---

## Advanced / driver-author surface

You **do not** import these to _use_ CloudBitmaps — only to **write a driver**, build tooling against the
on-disk format, or run out-of-process operations. This distinction is **docs-level by design**: a
separate `advanced` subpath split was considered and **deliberately not built** (marginal payoff, real cost,
net-new surface), so everything here still imports from the single
`@cloudbitmaps/roaring` barrel.

### `.crbm` on-disk format

**`CRBM` stands for Chunked Remote BitMap** — chunked because 16-bit chunks are the data model, remote because
every structural choice exists for storage that is far away and billed per request (range-GET a single chunk,
`count()` straight from the footer index without reading payloads, a speculative tail read that collapses `open()`
to one GET), and bitmap because that is what a chunk holds.

The name is deliberately **not** tied to a codec. `.crbm` is the shared container for every flavor — the footer
index, the CRC32C checksums, the AES-GCM framing and the generation model are all codec-independent, and only the
chunk payload bytes differ. A future `@cloudbitmaps/bitset` writes the same format.

| Symbol | What it does |
|---|---|
| `CrbmReader` / `CrbmReaderOptions` | read it (`tailBytes`, `maxPayloadBytes`, `maxIndexBytes`, `crypto`) |
| `CrbmStorageChunkSource` / `CrbmStorageChunkSourceOptions` | the `.crbm` storage reader over an `IStorageDriver` (the store builds this from a raw driver for you); options add `registry`, `keystore`, `requireEncryption`, `clock`, `currentGenTtlMs`, `maxOpenSegments`, `maxOpenIndexBytes` |
| `writeCrbmGeneration` · `publishGeneration` | lower-level load: write a generation from `SafeBitmap`s / advance the pointer |
| `BufferReader` · `BlobSink` · `BlobReader` | the in-memory `BlobReader` you hand to `CrbmReader.open`, plus the two interfaces themselves: `BlobSink` takes bytes (one method, `write`), `BlobReader` serves them (`getRange`, `getTail`) |
| `SafeBitmap` | size-capped wrapper over `RoaringBitmap32` (the roaring codec's `CodecBitmap`) |

### Bitmap-codec seam

The engine is **codec-agnostic** behind these; roaring is the flagship codec. You only touch them to plug in a
different codec (the `@cloudbitmaps/bitset` / `@cloudbitmaps/soaring` flavors) — the `CloudRoaring` facade injects
`roaringCodec` for you.

| Symbol | What it does |
|---|---|
| `CodecInterface` | the factory the engine builds bitmaps through (`empty` / `fromValues` / `safeDeserialize`) |
| `CodecBitmap` | the value type a codec produces — a `u32` set with set algebra + portable (de)serialization. Optional `maximum?()` lets the engine range-check a chunk payload in O(1); a codec that can't answer cheaply omits it and the check is skipped |
| `roaringCodec` | the flagship (roaring) `CodecInterface`, delegating to `SafeBitmap`; the facade's default |

### Flavor-author kit (`@cloudbitmaps/core`)

These are the pieces a **flavor** package (codec + facade) or a **driver** author composes — `@cloudbitmaps/core`'s
actual audience. An application never calls them: it uses the flavor's `CloudRoaring` facade, which wires all of
this for you. They are reachable from `@cloudbitmaps/roaring` too, because the flavor re-exports core wholesale.

| Symbol | What it does |
|---|---|
| `SegmentEngine` / `EngineDeps` | the codec-agnostic **read** engine over a `StorageChunkSource` (`has` / `count` / `iterate` / `intersect` / `union` / `andNot`, plus `supportsStorageSize` / `segmentSize` for grounded cost) + its injected deps (**`codec` is required** — core has no default; `cache?`, `maxBitmapBytes?`, `clock?`, `metrics?`, `budget?`). Read-only by design — there are no `*Into` verbs here |
| `EngineCombineOptions` | the engine-level `{ concurrency?, budget?, exclude?: SegmentRef[] }` (the facade's `CombineOptions` maps `Segment` handles down to these refs) |
| `BoundedLru` | the count+byte-bounded LRU the facade uses for the chunk cache and the `.crbm` reader cache |
| `safeMetrics` | wrap a user `IMetricsSink` so a throwing sink can never break the data path |
| `groundedReport` | build a `CostReport` from measured segment sizes (backs `segment.costReport()`) |
| `runExport` | the eject/export driver (**needs a `codec` for the `roaring` format**; the flavor binds it) |
| `splitId` | an id → its `(chunkKey, remainder)` bit routing, and a range check on the way: it throws `ValidationError` for anything that is not a u32, which is how a bad id fails fast |
| `mapWithConcurrency` | the bounded, order-preserving fan-out primitive (admin scans, the Storage sweep) |
| `resolveBudget` / `resolvePerOpBudget` / `checkBudget` | the denial-of-wallet budget plumbing: normalize a `BudgetOption` into a `Budget`, pick the one that applies to a given op, and enforce it against a **computed** unit count. `collectWithinBudget` is the streaming form; `checkBudget` is the O(1) one, and its `>` threshold is what makes a budget of N admit exactly N units |
| `MIN_EXPIRES_AT_MS` | floor (1,000,000,000,000 — 2001-09-09) on `expiresAt` **and** on the sweep's `now`: anything smaller is almost certainly epoch *seconds*, which reads as already-expired |
| `collectWithinBudget` | drain an async iterable into an array, refusing **as soon as** the budget is exceeded rather than after — so resident memory is `O(budget)`, not `O(source)` |
| `validateSegmentRef` | boundary validation of a `SegmentRef` (untrusted-input posture) |
| `encodeNameForPath` | percent-encode a name for use as a **filesystem path component**. Escapes everything `encodeNameForKey` does plus `:` (an NTFS alternate-data-stream separator on Windows), plus three hazards that are properties of the whole component: `.`/`..` traversal, Windows reserved device names (`CON`, `NUL`, `COM1`…, reserved with *or without* an extension), and a trailing dot or space, which Windows silently strips so two names would collide on one path. Use it if you write your own filesystem `ExportSink`, so your dump matches the drivers' layout. **If you decode these names back, require the encoding to round-trip** (`encodeNameForPath(decoded) === raw`) rather than trusting a decode — percent-decoding accepts spellings the encoder never emits (a lowercase escape, say), and without that check a planted entry can alias a real one |
| `namespacePathPart` | the physical namespace component of a **path**: the caller's namespace **encoded**, or the `_default` sentinel emitted **literally**. That asymmetry is load-bearing — encoding the sentinel too would send an absent namespace to `%5Fdefault`, exactly where a caller who names their namespace `_default` already goes, and the two would read each other's data. Use it rather than encoding `ns ?? '_default'` yourself. (`namespaceKeyPart`, the object-key twin, is on [`@cloudbitmaps/core/driver-kit`](#cloudbitmapscoredriver-kit) — it is a driver concern) |

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

Depend on core as a **peer** plus a dev dependency, not a plain dependency:

```jsonc
{
  "peerDependencies": { "@cloudbitmaps/core": "^<the minor you build against>" },
  "devDependencies": { "@cloudbitmaps/core": "^<the same>" }
}
```

A plain dependency lets your package pull in a *second* copy of core beside the consumer's, which is the
duplicate-major case described under [Errors](#errors-typed--you-catch-these) where `instanceof` stops
holding. A peer makes the
consumer's copy the only one.

**On correctness, be aware of what you cannot yet run.** The conformance suite the in-repo drivers are held
to (`packages/roaring/src/testing/conformance.ts`) is *not* exported as a public subpath, so a third-party
driver cannot execute it today. Until it is, the load-bearing behaviours to reproduce by hand are: a
conditional create that **refuses** rather than overwrites (hard invariant 2 — this is the one that silently
loses data if you get it wrong), ranged reads that return exactly the requested bytes, a compare-and-swap on
the pointer row that reports a lost race rather than clobbering, and the four `currentGen: null` obligations
listed below.

</details>

| Symbol | What it does |
|---|---|
| `IStorageDriver` · `IRegistryDriver` | the two ports a driver implements — the object tier and the pointer row. A registry driver that does NOT extend `ObjectStoreRegistry` also needs `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord` and `RegistryPatch` to write its method signatures; those come from `@cloudbitmaps/core`'s main entry |
| `StorageBackend` · `StorageCaps` · `SegmentRef` · `GenKey` | the backend pair, a driver's declared capabilities, and the two key shapes |
| `brandAsBackend` · `STORAGE_BACKEND` | stamp the cross-package brand on a backend class, and the symbol it uses. A store accepts a backend by brand, never by `instanceof`, so a backend built in one package is recognised in another |
| `Token` · `segmentKey` | **from `@cloudbitmaps/core`, not from `driver-kit`.** The opaque compare-and-swap token (unique per write, compared by equality only, ABA-safe across delete→recreate) and the canonical segment key-string helper. A driver package may import core's main entry for these |
| `ObjectStoreRegistry` | compare-and-swap over a plain object store. Every cloud registry driver is a thin adapter over this, which is why all three pass one conformance suite — the OCC semantics live here, not in the drivers |
| `ObjectRegistryStore` · `ObjectRow` | the minimal store a driver hands `ObjectStoreRegistry`, and the row it persists |
| `ObjectVersionRaced` · `MAX_ROW_BYTES` | the sentinel a lost compare-and-swap throws, and the hard cap on a serialized row |
| `registryPrefix` · `registryObjectKey` · `registryListPrefix` · `parseRegistryKey` | where a registry row lives, defined once here. Two drivers disagreeing about a row's key would be a silent incompatibility on the same bucket, so the layout has exactly one definition — all three drivers reach it through `ObjectStoreRegistry` |
| `normalizeObjectPrefix` · `prefixPart` | prefix normalization, so `cr`, `cr/` and `/cr/` address the same place |
| `encodeNameForKey` · `namespaceKeyPart` | how a segment name and namespace become an object key |
| `isSdkRetryable` · `isNetworkOrTimeout` · `isServerSide` · `httpStatus` · `errorName` | retry classification shared by the SDK-backed drivers — which failures are transient and worth another attempt |
| `validateSegmentRef` | boundary validation a driver applies to a caller-supplied ref |
| `BlobSink` | the sink a range read writes into |
| the typed errors + predicates | `ValidationError` · `WriteConflictError` · `NotFoundError` · `IntegrityError` · `TransientError`, and `isValidationError` · `isWriteConflictError` · `isNotFoundError`. Throw the classes; classify with the predicates, which hold across package copies where `instanceof` does not |

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

### Resilience (the store wires this by default)

| Symbol | What it does |
|---|---|
| `withRetry` · `DEFAULT_RETRY_POLICY` · `RetryDeps` | the retry primitive + defaults (4 attempts, 50 ms base, ×2, 2 s cap, full jitter). It retries whatever `isTransientError` accepts unless you pass `RetryDeps.isRetryable` |
| `RetryingStorageChunkSource` · `RetryingStorageDriver` · `RetryingRegistryDriver` · `RetryingOptions` | manual driver-wrapping decorators |

### Crypto seams

| Symbol | What it does |
|---|---|
| `NodeAead` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `aadFor` | the AES-256-GCM implementation + the crypto interfaces the `.crbm` reader/writer use. An **`Aead` implementation is handed** the associated data and never builds it. A **`CrbmCrypto` caller does** — it is the `{ aead, aadFor }` pair that `CrbmReader.open` and `writeCrbmGeneration` take, so tooling reading or writing an *encrypted* archive builds one with `aadFor(ref, generation, scope)`, which binds each chunk and the index to `(segment, generation)` |
| `EraseDeps` | `{ registry }` — deps for the free-function crypto-shred (`destroySegment` / `eraseNamespace`) |
| `DropDeps` | `EraseDeps` plus `storage` — `dropSegment` deletes the objects, so it needs the storage driver |

### Low-level ports & capabilities (driver-author typing)

`StorageCaps` · `RegCaps` · `ChunkRef` · `GenKey` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` ·
`RegistryStatus` (`'active' | 'compacting' | 'erasing' | 'destroyed'` — the middle two are reserved and set by no
writer in this build) · `GovernanceMeta` · `SegmentSize`

### Driver option types (one per driver package)

`MemoryRegistryDriverOptions` · `LocalFsRegistryDriverOptions` · `InProcessKeystoreOptions` ·
`S3StorageDriverOptions` · `S3RegistryDriverOptions` ·
`GcsStorageDriverOptions` · `GcsRegistryDriverOptions` · `AzureBlobStorageDriverOptions` ·
`AzureBlobRegistryDriverOptions`

---

## Errors (typed — you `catch` these)

Every error this library throws extends `CloudRoaringError`, and each one tells you which of three things to do:
**fix your call**, **retry**, or **investigate the data**. Nothing throws a bare `Error`.

| Error | Fires when | What to do | Retry? |
|---|---|---|---|
| `ValidationError` | your input is malformed — a bad id, an illegal segment name, an out-of-range option. Raised **before any storage call** | fix the call | no — deterministic |
| `WriteConflictError` | a write-once generation number was claimed twice, a registry compare-and-swap lost every retry, or generation collection found the segment re-created underneath it (the name now belongs to a different segment) | re-read the pointer and re-derive: take a fresh `nextGeneration`, or re-run the operation | no — but the *operation* is safe to re-run |
| `IntegrityError` | bytes from storage are corrupt, oversized, fail a checksum, or fail AEAD authentication | **investigate** — this says "this segment is corrupt", not "try again". Names the chunk. Re-loading the segment from source is the repair | no |
| `NotFoundError` | an object or row the caller named does not exist. Thrown by the persistent drivers; the in-memory drivers return `null` instead | usually the library handles it internally (a swept generation heals forward). Reaching you means the pointer names an object that is *permanently* absent — a torn restore. See [disaster recovery](disaster-recovery.md) | no |
| `UnsupportedError` | (a) the bytes are well-formed but this build cannot read them — an unknown `.crbm` major version; or (b) this store's wiring cannot perform the operation, e.g. a lifecycle helper on a store built without a backend | wire the store with what the operation needs, or upgrade the library | no |
| `CapabilityError` | a driver cannot meet a capability the topology requires — e.g. a Storage driver without range reads. Raised **fail-fast at wiring time**, never mid-operation | use a driver that supports it | no |
| `BudgetExceededError` | the operation would exceed its per-op denial-of-wallet budget — too many backend requests for one call. Refused **before** fanning out (hard invariant 6). Carries the projected count and the limit, never data | narrow the operation, raise `budget`, or set `budget: false`. If it fires on a normal call, something is wider than you think | no — refused by policy, not by luck |
| `KeyUnavailableError` | an encrypted segment's DEK cannot be unwrapped: the keystore holds none of the KEKs its wrappings reference — never configured, rotated away without keeping the old key, or lost | restore the KEK. **Without it the data is unreadable**, which is what crypto-shred relies on | no |
| `TransientError` | a driver-classified transient fault — throttling, a 5xx, a connection reset. The raw SDK error is preserved in `cause` | the retry layer already retried it; reaching you means it kept failing | **yes** — the only class the retry layer retries |
| `TimeoutError` | a single attempt exceeded its time budget. Subclass of `TransientError` | as above. Setting a request timeout on your injected client is the recommended way to bound a hang | yes |

Two things worth knowing:

- **The retry layer retries `TransientError` and nothing else.** Retrying a `ValidationError`, `IntegrityError`,
  `NotFoundError` or `WriteConflictError` is pointless or wrong, so it never happens.
- **`TransientError.cause` is the raw SDK error** and may carry operational metadata (endpoint host, request
  ids, `$metadata`). The library's own `message` is identifier-only and safe to log; serializing the whole error
  *chain* includes that metadata.

**Bundle-safe predicates** — `isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
`isNotFoundError` · `isIntegrityError` · `isValidationError`.

**On an ordinary install, `instanceof` holds everywhere** — across `@cloudbitmaps/roaring`, the driver
packages and `@cloudbitmaps/core` itself. Every package is published with `@cloudbitmaps/core` left
**external** rather than bundled in, so your tree has one copy of the error classes and
`core.ValidationError` and the class an `@cloudbitmaps/s3` driver throws are the same object. Catch them
however you normally would.

Reach for the predicates where that stops being true, which is not something the library can control:

- a bundler that inlines `@cloudbitmaps/core` into two separate outputs;
- two major versions of core resolved side by side in one tree, which npm and pnpm will both do;
- an error crossing a `worker_threads` worker, a `vm` realm, or an iframe.

Each predicate matches a `Symbol.for` brand plus the runtime `name`, and a `Symbol.for` key is the same
symbol in every copy and every realm, where a class object is not. So the predicates hold in all three cases
and `instanceof` does not. The failure is silent — a `catch` that stops matching just falls through — which
is why library code that cannot see how it will be bundled should prefer them by default. `pnpm smoke`
asserts both halves on every build: that the shared copy really is shared, and that the predicates classify
an error thrown by one package and caught in another.

---

## Complete export index

Every export, by entry point. This section is the completeness anchor the sync test checks against.

`@cloudbitmaps/core`'s **main** entry has no section of its own, deliberately: the flavor re-exports it
wholesale, so every name below the two `@cloudbitmaps/roaring` headings is also a name on
`@cloudbitmaps/core`. A driver author told elsewhere on this page to import `Token`, `RegistryRecord`
or `segmentKey` from core will find each one there.

### `@cloudbitmaps/roaring` — values

`CloudRoaring` · `Segment` · `MemoryStorage` · `LocalFsStorage` · `createBackend` · `isStorageBackend` ·
`MemoryStorageDriver` · `MemoryRegistryDriver` · `MemoryStorageChunkSource` · `PinnedStorageChunkSource` ·
`LocalFsStorageDriver` · `LocalFsRegistryDriver` · `bulkLoadCrbmGeneration` · `writeCrbmGeneration` ·
`publishGeneration` · `CrbmStorageChunkSource` · `nextGeneration` · `gcOrphanGenerations` · `loadSegment` ·
`listGenerations` · `rollbackSegment` · `segmentExists` · `listSegments` · `eraseIdFromSegment` ·
`destroySegment` · `dropSegment` · `eraseNamespace` · `InProcessKeystore` · `NodeAead` · `aadFor` · `SafeBitmap` ·
`roaringCodec` · `withRetry` · `SegmentEngine` · `BoundedLru` · `safeMetrics` · `groundedReport` ·
`runExport` · `splitId` · `mapWithConcurrency` · `resolveBudget` · `resolvePerOpBudget` · `checkBudget` ·
`collectWithinBudget` · `validateSegmentRef` · `segmentKey` · `encodeNameForPath` · `namespacePathPart` ·
`setSegmentRetention` · `getSegmentRetention` · `readRetentionPolicy` · `clearSegmentRetention` ·
`MIN_EXPIRES_AT_MS` ·
`retireExpired` · `excludingReservedRows` · `DEFAULT_RETRY_POLICY` · `RetryingStorageDriver` ·
`RetryingRegistryDriver` · `RetryingStorageChunkSource` · `CrbmReader` · `BufferReader` ·
`CountingMetricsSink` · `NOOP_METRICS` · `RecordingAuditSink` · `estimateCost` · `DEFAULT_PRICING` ·
`AWS_US_EAST_1_ONDEMAND` · `runConsistencyCheck` · `DEFAULT_BUDGET` · `CloudRoaringError` ·
`ValidationError` · `WriteConflictError` · `IntegrityError` · `NotFoundError` · `UnsupportedError` ·
`CapabilityError` · `TransientError` · `TimeoutError` · `KeyUnavailableError` · `BudgetExceededError` ·
`isCloudRoaringError` · `isWriteConflictError` · `isTransientError` · `isNotFoundError` · `isIntegrityError`
· `isValidationError` · `VERSION`

### `@cloudbitmaps/roaring` — types

`CloudRoaringOptions` · `CacheOptions` · `EncryptionOptions` · `RetryOptions` · `SeamOptions` ·
`SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` · `EraseSubjectResult` ·
`MaterializeResult` · `MaterializeRefusal` · `BaseCombineOptions` · `CombineOptions` · `MaterializeOptions`
· `AndNotIntoOptions` · `EngineCombineOptions` · `BulkLoadResult` · `LoadDeps` · `LoadOptions` · `LoadGuard`
· `LoadResult` · `LoadRefusal` · `GenerationListDeps` · `GenerationEntry` · `RollbackResult` · `SegmentInfo`
· `CrbmStorageChunkSourceOptions` · `GenerationDeps` · `EraseIdDeps` · `EraseIdResult` ·
`MemoryStorageOptions` · `LocalFsStorageOptions` · `MemoryRegistryDriverOptions` ·
`LocalFsRegistryDriverOptions` · `ExportFormat` · `ExportSink` · `ExportWriter` · `ExportOptions` ·
`ExportedSegment` · `ExportFailure` · `ExportManifest` · `IStorageDriver` · `IRegistryDriver` ·
`StorageBackend` · `StorageChunkSource` · `PinnedAt` · `SegmentRef` · `ChunkRef` · `GenKey` · `StorageCaps`
· `RegCaps` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` · `RegistryStatus` · `GovernanceMeta`
· `SegmentSize` · `IKeystore` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` ·
`InProcessKeystoreOptions` · `EraseDeps` · `DropDeps` · `DestroyResult` · `DropResult` · `RetentionPolicy` ·
`RetentionDeps` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` · `RetireEntry` ·
`RetryPolicy` · `RetryDeps` · `RetryingOptions` · `CrbmReaderOptions` · `BlobReader` · `BlobSink` ·
`IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `PricingProfile` · `CostReport` ·
`Workload` · `SegmentSizing` · `EstimateInput` · `IAuditSink` · `AuditEvent` · `AuditEventKind` · `Clock` ·
`Rng` · `Budget` · `BudgetOption` · `ConsistencyReport` · `ConsistencyIssue` · `ConsistencyErrorEntry` ·
`CodecInterface` · `CodecBitmap` · `EngineDeps` · `Token`

### `@cloudbitmaps/core/driver-kit`

The contract a storage-driver package builds against — see
[Driver kit](#driver-kit--what-you-need-to-implement-a-driver) for what each one is for. Application code does
not import these.

Ports and the backend brand: `IStorageDriver` · `IRegistryDriver` · `StorageBackend` · `StorageCaps` ·
`SegmentRef` · `GenKey` · `brandAsBackend` · `STORAGE_BACKEND`

Object-store registry: `ObjectStoreRegistry` · `ObjectRegistryStore` · `ObjectRow` · `ObjectVersionRaced` ·
`MAX_ROW_BYTES`

Keys and prefixes: `registryPrefix` · `registryObjectKey` · `registryListPrefix` · `parseRegistryKey` ·
`normalizeObjectPrefix` · `prefixPart` · `encodeNameForKey` · `namespaceKeyPart`

Retry classification: `isSdkRetryable` · `isNetworkOrTimeout` · `isServerSide` · `httpStatus` · `errorName`

Boundary helpers and errors: `validateSegmentRef` · `BlobSink` · `ValidationError` · `WriteConflictError` ·
`NotFoundError` · `IntegrityError` · `TransientError` · `isValidationError` · `isWriteConflictError` ·
`isNotFoundError`

### `@cloudbitmaps/s3`

`S3Storage` · `S3StorageOptions` — the backend, both halves in one bucket.

`S3StorageDriver` · `S3RegistryDriver` · `S3StorageDriverOptions` · `S3RegistryDriverOptions` — the halves.

### `@cloudbitmaps/gcs`

`GcsStorage` · `GcsStorageOptions` — the backend, both halves in one bucket. It builds its own client, which
also sidesteps a confusing collision: `@google-cloud/storage` calls its client class `Storage`, so the
lower-level driver option that takes it is `storage` too.

`GcsStorageDriver` · `GcsRegistryDriver` · `GcsStorageDriverOptions` · `GcsRegistryDriverOptions` — the halves.
The registry lets a GCS deployment run on **one bucket
alone**: compare-and-swap rides GCS object preconditions (`ifGenerationMatch: 0` to create, `ifGenerationMatch:
<generation>` to swap), so no second service is needed to hold the `currentGen` pointer.

### `@cloudbitmaps/azure-blob`

`AzureBlobStorage` · `AzureBlobStorageOptions` — the backend, both halves in one container. Give it a
`containerClient`, or a `connectionString` + `container` and it builds one.

`AzureBlobStorageDriver` · `AzureBlobRegistryDriver` · `AzureBlobStorageDriverOptions` ·
`AzureBlobRegistryDriverOptions` — the halves. Inject a
container-scoped `ContainerClient`; write-once via `ifNoneMatch: '*'`. The registry lets an Azure deployment
run on **one container alone**: compare-and-swap rides blob conditions (`ifNoneMatch: '*'` to create,
`ifMatch: <etag>` to swap), so no second service is needed to hold the `currentGen` pointer.

## Keeping this in sync

- The **sync test** ([`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts))
  derives its entry list from every package's own `exports` map — so each package and each subpath it declares
  is covered, with no list to maintain — and asserts each
  exported name appears (backtick-wrapped) in the **"Complete export index"** section — so **adding an export
  without documenting it breaks CI**. It runs in **both** directions: a name listed in that index that nothing
  exports any more also fails, so a removed export cannot leave a stale entry behind. Two limits worth knowing
  rather than over-trusting: both directions are scoped to that one section, so the descriptive tables earlier
  on this page are guarded by neither; and the reverse direction only reads names joined by `·`, which is how
  every list in that section is written. It also fails if a barrel introduces an `export *` (which would let names slip past the guard),
  keeping every export explicit; the one allowed exception is the flavor's main barrel re-exporting core's,
  because core's barrel is parsed too.
- When you add/rename/remove a public export: update the relevant section **and** the
  [Complete export index](#complete-export-index) in the same change (this is part of the standard
  [keep-the-docs-current step](../../CONTRIBUTING.md#documentation--keeping-it-current)).
- This page catalogs the surface; the tutorial-style walkthrough with runnable snippets lives in the
  [getting-started guide](../guide/getting-started.md). For _why_ the surface is shaped this way, read the module
  headers — each one states the decision it encodes and what the alternative cost — and the
  [hard correctness invariants](../../CLAUDE.md#hard-correctness-invariants), which are the protocol rules the
  shape follows from.
