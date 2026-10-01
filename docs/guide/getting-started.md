# Getting started

> **Status: `0.10.0` — pre-1.0.** Everything below is real and tested: it is what the engine actually
> exposes, covered by the test suite. The API may still change before `1.0`. CloudBitmaps is a **loaded store**:
> a segment is a series of write-once `.crbm` generations in object storage — **in-memory**, **local-filesystem**,
> **S3-compatible**, **GCS** or **Azure Blob** — behind one **registry** pointer (memory / LocalFs / S3 /
> GCS / Azure Blob). You compute a set upstream, **load** it as a generation, and read it — `has`, `count`, `iterate`
> and chunk-skipping `intersect` — from anywhere, with **automatic retry/backoff on reads**, **encryption-at-rest +
> crypto-shred**, retention, GDPR erasure, cost reporting and observability around it.

> **Two packages to install: a codec and a storage.** Every import below is the real specifier. The codec is
> `@cloudbitmaps/roaring`, the *roaring flavor* of the `@cloudbitmaps` family — the roaring codec +
> the `CloudRoaring` facade. The storage you use is the second package — `@cloudbitmaps/s3`,
> `@cloudbitmaps/gcs` or `@cloudbitmaps/azure-blob` — which depends on its cloud SDK for real, so installing
> it is the whole step. Both depend on **`@cloudbitmaps/core`**, the codec-agnostic engine, which arrives
> **transitively**: you never install or name it. Every package needs **Node 22.12 or later**, and ships as ES
> modules only: `import` it, or `require()` it through Node's `require(esm)`.

> **Every export at a glance:** for the complete list of everything you can import and call (across
> `@cloudbitmaps/roaring` and the `s3` / `gcs` / `azure-blob` driver packages), see the
> **[API Reference](api-reference.md)** — it's kept in sync with the code by CI. This guide is the narrated
> walkthrough of that same surface.

## The whole surface, in three steps

```
  ┌─ STEP 1 ── pick a backend ────────────────────────────────────────────┐
  │  MemoryStorage()          LocalFsStorage(root)                        │
  │  S3Storage({ bucket, prefix })   GcsStorage(…)   AzureBlobStorage(…)  │
  │                                                                       │
  │  One object. It derives BOTH halves — where the generations go, and   │
  │  where the pointer that says which one is current goes — from one     │
  │  bucket and one prefix.                                               │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
  ┌─ STEP 2 ── build a store ─────────────────────────────────────────────┐
  │  new CloudRoaring({                                                   │
  │    storage,                          ← the ONLY required option       │
  │    cache?, encryption?, retry?, metrics?, budget?, seams?             │
  │  })                                                                   │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
  ┌─ STEP 3 ── call verbs ────────────────────────────────────────────────┐
  │                                                                       │
  │  on the STORE                      on a SEGMENT                       │
  │  ─────────────                     ──────────────                     │
  │  load(ref, ids)      ← the write   has(id)      count()   iterate()   │
  │  segment(name, opts)               intersect()  union()   andNot()    │
  │  exists()  segments()              intersectInto() unionInto()        │
  │  generations() rollback()          andNotInto()                       │
  │  dropSegment() retireExpired()     pin()        ← one fixed instant   │
  │  setRetention() getRetention()     costReport()                       │
  │  clearRetention()                                                     │
  │  eraseSubject() subjectReport()    ← GDPR Art. 17 / Art. 15           │
  │  checkConsistency() exportSegments()                                  │
  │  invalidate()  ← forget what this store cached about a segment        │
  └───────────────────────────────────────────────────────────────────────┘
```

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'prod' }) });

const r = await store.load({ segment: 'vips' }, idsFromWarehouse());
if (!r.published) console.warn({ reason: r.reason, had: r.cardinalityBefore });
await store.load({ segment: 'engaged' }, engagedFromWarehouse()); // an operand has to exist: load it first

for await (const id of store.segment('vips').intersect([store.segment('engaged')])) {
  /* the audience */
}
```

**A store, a backend and the verbs above are the whole everyday surface.** The registry, the drivers and generation
numbers exist and are exported; the few free functions that take drivers (a crypto-shred) take
them from the backend, as `backend.registry` and `backend.storage`, so nothing is configured twice. Everything below
here is detail.

The rest of this guide walks each step in turn.

## What works today

| Capability | Status |
|---|---|
| **Load** a segment as an immutable generation from any id stream — array, generator, warehouse cursor (`store.load`) | ✅ |
| `has` / `count` / `iterate` — `count()` summed from the `.crbm` index with **zero payload reads** | ✅ |
| **`intersect()`** — chunk-skipping set intersection, streamed; `union()` / `andNot()`; `exclude` folds suppression into the same pass | ✅ |
| **`intersectInto` / `unionInto` / `andNotInto`** — materialize a result as a **new generation** of another segment | ✅ |
| In-memory drivers (zero setup) | ✅ |
| Persistent **local filesystem** drivers (survive restart) | ✅ |
| **S3-compatible** storage — AWS S3 / MinIO (`@cloudbitmaps/s3`), multipart for large generations | ✅ |
| **GCS + Azure Blob** storage (`@cloudbitmaps/gcs`, `@cloudbitmaps/azure-blob`) — write-once immutable generations | ✅ |
| `.crbm` archive read/write + a bounded cache | ✅ |
| **Automatic retry + backoff** for transient faults on every read that answers a query (on by default) | ✅ |
| **Segment registry** (memory / LocalFs / **S3** / **GCS** / **Azure Blob** — run on one bucket alone) — one strong read resolves the current generation, no per-read scan | ✅ |
| **Generation bookkeeping** — a load takes the next generation number itself and collects the objects it superseded (`keep`) | ✅ |
| **Encryption-at-rest** (AES-256-GCM, BYOK keystore) **+ crypto-shred** (`destroySegment` / `eraseNamespace`) | ✅ |
| **Observability** — optional metrics sink (`IMetricsSink`): `storage.get` / `cache` / `retry` / `intersect` / `op` events | ✅ |
| **Audit trail** — optional audit sink (`IAuditSink`): publish / load-refused / rollback / rewrite / erase / dispose / namespace-erase compliance events | ✅ |
| **Cost estimator** — `CloudRoaring.estimateCost()` (planning) + grounded `segment.costReport()` | ✅ |
| **Benchmark-as-test** — cost/perf claims are CI-gated; published [crossover chart](../benchmarks.md) | ✅ |
| **Subject access & erasure** (GDPR Art. 15/17: `subjectReport` / `eraseSubject` — a rewrite, physically gone on return) | ✅ |
| **Retention** — `setRetention` records a per-segment expiry; `retireExpired` is the sweep you schedule; `dropSegment` reclaims storage | ✅ |
| **Per-op request budget** — denial-of-wallet ceiling on `count` / `iterate` / the combines / subject scans (on by default) | ✅ |
| **Cross-store consistency check** (`checkConsistency()`) — [torn-restore](disaster-recovery.md) detection | ✅ |
| **Export / eject** (`exportSegments` + the `export-segments` CLI) — portable `roaring` / `ndjson` | ✅ |

### Choosing a registry

> **Every backend ships a registry.** `MemoryStorage`, `LocalFsStorage`, `S3Storage` (`@cloudbitmaps/s3`),
> `GcsStorage` (`@cloudbitmaps/gcs`) and `AzureBlobStorage` (`@cloudbitmaps/azure-blob`) each carry one. **Each
> object store can host its own pointer**, so one bucket or one container is the whole deployment — no second
> service, and for GCS and Azure no second *cloud*. All three ride the same primitive under different names:
> S3 `If-None-Match`/`If-Match`, GCS `ifGenerationMatch`, Azure `ifNoneMatch`/`ifMatch`.
> A backend always carries its registry. Only a bare storage driver has none, and a store built on one is
> **read-only and cleartext**: it list-scans the bucket for the highest generation. Encrypted segments, the `*Into`
> verbs and every lifecycle helper (`eraseSubject`, `dropSegment`, `setRetention`, `retireExpired`,
> `checkConsistency`, `exportSegments`) need the registry, so they need a backend. Full registry details are in
> [the segment registry](#the-segment-registry-resolving-the-current-generation).

## The simplest thing: in-memory

A `CloudRoaring` store is wired to one **backend** — the object that knows where the `.crbm` generations go and
where the pointer that says which one is current goes. That is the only required option. A `segment` is one
named bitmap, and data gets into it **by loading a generation**: `store.load(ref, ids)` writes one immutable
object and moves the pointer to it. `MemoryStorage` needs no setup — ideal for tests and a first look:

```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

// One object carries both halves — where the generations go, and where the pointer goes.
const store = new CloudRoaring({ storage: new MemoryStorage() });

// Load a generation: any sync or async iterable of ids — an array here, a warehouse cursor in the loading guide.
await store.load({ segment: 'high-value-shoppers' }, [5, 99_999, 1_234_567_890, 2_000_000_000]);

// Read it.
const vips = store.segment('high-value-shoppers');
await vips.has(1_234_567_890); // → true
await vips.count(); // → 4, summed from the index — no chunk is fetched
for await (const id of vips.iterate()) {
  // ascending ids
}
```

IDs are integers in `[0, 2³²)`. Each is split into a 16-bit chunk key + a 16-bit remainder, and a chunk is the unit
of storage and transfer: `has()` fetches one chunk (or answers from the cache), `count()` fetches none, and
`intersect()` fetches only the chunks two segments could share.

**There is no `add` or `remove` on a segment.** A segment changes by getting a *new generation* — the next load
supersedes the previous one, an `*Into` verb writes a new generation of its destination ([the `*Into` verbs](loading.md#materializing-the-into-verbs)),
and a GDPR erasure rewrites the current generation without one id ([erasure](erasure.md#subject-access--erasure-gdpr-art-15--17)).
A segment that has never been loaded reads as empty — `has(x) → false`, `count() → 0`, `iterate() → []` — without
throwing, so there is nothing to create before the first load.

## Persistent: the local filesystem

Same API, but state lives on disk and survives a restart. Pass a `LocalFsStorage` backend as `storage` — it
names one root and derives both halves from it, so you wire the location exactly once:

```ts
import { CloudRoaring, LocalFsStorage } from '@cloudbitmaps/roaring';

// One root: generations under `./.cloudbitmaps/storage`, pointers under `./.cloudbitmaps/registry`.
const backend = new LocalFsStorage('./.cloudbitmaps');
const store = new CloudRoaring({ storage: backend, cache: { maxChunks: 1024 } }); // optional cache ceiling

await store.load({ segment: 'active-this-week' }, activeUserIds);
// ...a fresh process pointed at the same dirs reads the same generation — the object and the pointer are durable.
```

> **A root is for one process.** Every instance in a process that names the same root shares one lock per
> registry row, however the root is spelled (a relative path, a symlink), so a store and a CLI call in that
> process cannot both advance one row from the same token. Two processes on one root are **not** fenced from each
> other: the pointer's compare-and-swap is a read-then-rename, and it is only serialized inside the process. Give
> each process its own root, or use an object-store backend, whose registry is fenced by the store itself.

> **The `storage` option takes three shapes, and you want the first.** A **backend** (`MemoryStorage`,
> `LocalFsStorage`, `S3Storage`, `GcsStorage`, `AzureBlobStorage`) carries both halves — the generations and
> the pointer — from one bucket and one prefix, and is the whole wiring. Below it, a **raw `IStorageDriver`**
> still works, but it has no pointer, so generations resolve by list-scan: **cleartext and read-only**. Or pass
> an already-built **`StorageChunkSource`** — a `CrbmStorageChunkSource` you configured with advanced reader
> options (`tailBytes`, size caps), or one of your own. On
> that path, configure the registry and keystore **on the source itself**: the store has no `registry` option, and
> an `encryption.keystore` or `encryption.required: true` beside a pre-built source is rejected as a wiring mistake.
> The store is then **read-only**: the `*Into` verbs and the lifecycle helpers need the raw driver to write through,
> and they, like `exists`, `segments`, `subjectReport` and `exportSegments`, throw `UnsupportedError`.
>
> **`backend.storage` is only the storage half** — a raw driver — so passing it as `storage` constructs without
> complaint and builds the read-only, cleartext store above rather than a backend's; pass the backend itself. Two
> wirings are refused at construction, with `CapabilityError`: a driver that cannot serve range reads, and a
> keystore or `encryption.required: true` on a bare driver, which has no registry to hold wrapped keys.

**A key the store does not take is refused, not ignored.** `new CloudRoaring({ … })` throws `ValidationError` for
any option it does not take, at the top level or inside a group (`cache.maxChunk`, a `keystore` beside
`encryption`), naming each one and the keys it does take; a `registry` key is refused the same way, because a
backend carries it. `S3Storage`, `GcsStorage` and `AzureBlobStorage` refuse an unknown key the same way, so a typo
in a client or endpoint option cannot quietly build a client against the default endpoint.

## Loading a segment

Loading is covered in [Loading in depth](loading.md).

## Storage on S3 (or any S3-compatible store)

> **If you construct the SDK client yourself, declare the SDK in your own `package.json` too.** The driver
> package depends on it, so it is in your tree — but importing a package you did not declare is not
> guaranteed to resolve, and pnpm refuses it by default. You only need this if *your* code names
> `@aws-sdk/client-s3`, as the snippets below do.

The S3 storage driver is its own package, **`@cloudbitmaps/s3`**, which depends on `@aws-sdk/client-s3` for
real — so `pnpm add @cloudbitmaps/s3` is the whole step, and nothing pulls that SDK unless you install it.
You can inject your own `S3Client`, so the driver works against AWS S3, MinIO, or any compatible backend just
by how you configure the client:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

// Bucket and prefix stated ONCE, for both halves. It builds its own client from the ambient credential
// chain; pass `client` for one the SDK cannot infer, or `endpoint` + `pathStyle` + `credentials` for MinIO/R2
// (a `client` carries its own, so giving both is refused).
const backend = new S3Storage({ bucket: 'my-bitmaps', prefix: 'cloudbitmaps', region: 'us-east-1' });

const store = new CloudRoaring({ storage: backend });

// Load a generation straight to S3, then read it through the engine:
await store.load({ segment: 'active-this-week' }, ids);
await store.segment('active-this-week').count(); // read from the .crbm index on S3 — no payload GET
```

It's the same `IStorageDriver` contract as the local-filesystem driver (it passes the identical conformance
suite), so everything above — reads, `count`, `iterate`, `intersect`, generation pinning — works unchanged.
Generations are **write-once** (a conditional `If-None-Match:*` PUT; requires a backend that honors it — AWS
S3 or recent MinIO). Large objects upload via **S3 multipart automatically** — write memory stays
~one part (default 8 MiB), and the object ceiling defaults to ≈80 GiB (10,000 parts), with write-once preserved
(conditional `CompleteMultipartUpload`).

The ceiling grows up to S3's 5 TiB through `partBytes` and `maxObjectBytes`, which are options of `S3Storage`:

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({
    bucket: 'my-bitmaps',
    prefix: 'cloudbitmaps',
    partBytes: 64 * 1024 * 1024, // 10,000 parts of 64 MiB ≈ 625 GiB
  }),
});
```

A write holds about one part in memory, so a larger part costs the writer that much more.

## The segment registry (resolving the current generation)

Each segment is a series of immutable, generation-numbered `.crbm` objects; reads need to know **which
generation is current**. Without a registry, the store finds it by *listing* every generation and taking the
max — one storage scan per segment, cleartext only, and read-only. The **registry** replaces that with a single
authoritative record (`currentGen`) read once, and it is what every write publishes through:

```ts
import { CloudRoaring, LocalFsStorage } from '@cloudbitmaps/roaring';

const backend = new LocalFsStorage('./.cloudbitmaps');
const store = new CloudRoaring({ storage: backend });

// Write the object AND move the pointer, in one call:
await store.load({ segment: 'active' }, [1, 2, 3]);

// The backend carries the pointer, so the store resolves currentGen with one read (no list-scan):
await store.segment('active').count(); // → 3, generation resolved from the registry
```

**The registry half** is a pluggable seam (`IRegistryDriver`), independent of the storage half. There is no
`registry` option on the store, and **you choose one by choosing a backend**: each brings its own, in the same
bucket as the generations. A plain `{ storage, registry }` object is refused.

| Backend | Import | Its registry lives |
| --- | --- | --- |
| `MemoryStorage` | `@cloudbitmaps/roaring` | in process: tests / dev |
| `LocalFsStorage` | `@cloudbitmaps/roaring` | under the root's `registry` directory: single node / on-prem, one process on one root; two processes on a root are not fenced |
| `S3Storage` | `@cloudbitmaps/s3` | **in the same bucket as your storage data — one store, no second service** |
| `GcsStorage` | `@cloudbitmaps/gcs` | the same, on Google Cloud Storage |
| `AzureBlobStorage` | `@cloudbitmaps/azure-blob` | the same, on Azure Blob Storage |

The **S3 backend's registry** keeps the current-generation pointer as a tiny object in the *same bucket* as your
Storage data, using S3's conditional writes (`If-Match`) for the atomic generation swap — so a deployment runs on
**S3 only**:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const s3 = new S3Client({ region: 'us-east-1' }); // or let S3Storage build one
const backend = new S3Storage({ bucket: 'my-bitmaps', client: s3 }); // one bucket, no second service
const store = new CloudRoaring({ storage: backend });
```

> **The registry reads only rows the library wrote.** Each persisted row is a small JSON object under `registry/`, and one
> that does not parse as the library's own — hand-edited, written by another tool, a field it does not declare, no
> `schemaVersion`, a `status` other than `active` or `destroyed` — fails with `IntegrityError` naming the object's
> key. It fails its own `get` **and every `list()` that reaches it**: its namespace's, and every unscoped one. So one
> bad object stops `segments()`, the retention sweep, the subject scans and `checkConsistency()` across the fleet,
> rather than letting them skip a segment whose generations would then look unreferenced. Restore the object to a
> valid row, or delete it, and enumeration resumes. A row from a newer build, with a higher `schemaVersion`, is
> refused with `UnsupportedError`.

The record also carries `status` (`active`, or the `destroyed` tombstone a crypto-shred or drop leaves), the
wrapped data-key(s) of an encrypted segment (see encryption), and the `retention` policy (see retention). `currentGen` can be
**`null`** — a row `setRetention` minted before the first load — which reads exactly like a segment with no row
and takes the first publish. A load is how a generation is published, and the pointer only moves forward.

## Production wiring for the cloud drivers

The S3 sections above wired S3. The two remaining clouds — GCS and Azure Blob — follow the same shape: the backend builds its own
client, or takes one you built. Each hosts **both** the storage tier and the registry, so either one is a complete
deployment on its own (see [Choosing a registry](#choosing-a-registry)). Each backend refuses an option key it does
not take, by name, and the error lists the keys it does take.

### GCS — storage + registry (`@cloudbitmaps/gcs`)

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { GcsStorage } from '@cloudbitmaps/gcs';

// Builds its own client from ADC; pass `apiEndpoint` to point at fake-gcs-server locally, or `client` for your own
// (which carries its own, so giving both is refused).
const backend = new GcsStorage({ bucket: 'my-bitmaps', prefix: 'cloudbitmaps' });
const store = new CloudRoaring({ storage: backend }); // one bucket is the whole deployment
```

> **Checklist.** `@google-cloud/storage` is a real dependency of `@cloudbitmaps/gcs`, not a peer — installing
> the package installs it. Generations are write-once via `ifGenerationMatch: 0` (both the
> simple and resumable upload paths), and the registry swaps the pointer with `ifGenerationMatch: <generation>`.
> A client you built yourself goes in `client`. `@google-cloud/storage` names its client class `Storage`, which reads
> as this library's word for the durable tier, so `GcsStorage` refuses `storage` as a key: in `CloudRoaring`'s
> options, `storage` is the backend.

### Azure Blob — storage + registry (`@cloudbitmaps/azure-blob`)

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';

// Give it a container client, or a connection string + container name and it builds one.
const backend = new AzureBlobStorage({
  connectionString: process.env.AZURE_CONN,
  container: 'bitmaps',
  prefix: 'cloudbitmaps',
});
const store = new CloudRoaring({ storage: backend }); // one container is the whole deployment
```

> **Checklist.** `@azure/storage-blob` is a real dependency of `@cloudbitmaps/azure-blob`, not a peer.
> Give it a connection string and a container name, as above, or a container-scoped `ContainerClient` as
> `containerClient` — one or the other, since both is refused. Generations are
> write-once via `If-None-Match: '*'`, and the registry swaps the pointer with `If-Match: <etag>`.

Per-backend DR/backup guidance (RPO/RTO, point-in-time recovery, what to snapshot) lives in the
[disaster-recovery runbook](disaster-recovery.md).

<a id="6-reliability-retries-backoff--timeouts"></a>

Reliability, retries, backoff and timeouts: see [Before production](production.md#reliability-retries-backoff--timeouts).

<a id="135-retention-ttl-and-pruning--what-exists-and-what-doesnt"></a>

Retention, TTL and pruning: see [Retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt).

## The operations

| Method | Returns | Notes |
|---|---|---|
| `has(id)` | `Promise<boolean>` | `ValidationError` if `id ∉ [0, 2³²)`. The cache, else **one** ranged GET of that id's chunk — never budgeted |
| `count()` | `Promise<number>` | exact cardinality, summed from the `.crbm` index with **zero payload reads** on a loaded segment; `budget`-guarded on a source without an index ([the per-op budget](production.md#cost-ceiling-the-per-op-fan-out-budget)) |
| `iterate({ after?, through? }?)` | `AsyncIterable<number>` | ascending, one chunk at a time; `budget`-guarded. With a range, only the ids in `(after, through]` and the chunks it overlaps ([Page through a segment](reading.md#page-through-a-segment)) |
| `intersect(others, { after?, through?, exclude?, concurrency?, budget? })` | `AsyncIterable<number>` | ascending; chunk-skipping. `exclude` subtracts suppression segments **in the same pass** |
| `union(others, { after?, through?, exclude?, concurrency?, budget? })` | `AsyncIterable<number>` | ascending. The one composite with **no** chunk-skipping — every chunk of every operand is read |
| `andNot(excludes, { after?, through?, concurrency?, budget? })` | `AsyncIterable<number>` | ascending. Reads all of `this`; each suppression list **only where it overlaps** |
| `intersectInto` / `unionInto` / `andNotInto` `(dest, …)` | `Promise<MaterializeResult>` | write the result as a **new generation of `dest`** (superseding it, and with a range, holding only the ids inside it) — `{ generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size, collected }`. Needs a backend |
| `costReport({ workload?, pricing? })` | `Promise<CostReport>` | grounded $ report from this segment's real `.crbm` size ([cost](cost.md#cost-estimate-it-then-ground-it)) |

There is no per-id write on a segment: data enters as a generation — `store.load`
([loading](loading.md#loading-a-segment)) or an `*Into` verb — and leaves the same way (`eraseSubject`, `dropSegment`).

**Every combine refuses an operand that names no segment** — `this`, every other operand and every `exclude` —
with `ValidationError` naming it: one that holds no chunks and has no registry row. A mistyped exclude would
otherwise suppress nobody. Pass `allowAbsentOperands: true` in the combine's options to read such a name as empty
([the `*Into` verbs](loading.md#materializing-the-into-verbs) has the rule).

**What each combine has to read** — a property of the set operation, not of the implementation:

| | chunks read | can skip? |
| --- | --- | --- |
| `intersect` | keys present in **every** operand | yes — the crown jewel |
| `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly |
| `union` | every chunk of **every** operand | no |

All three are charged against the same per-op budget, so a wide `union` is refused rather than quietly billed.
To suppress the result of an intersection, pass `exclude` rather than chaining — chaining materializes an
intermediate segment and reads the suppression list in full.

Failures are **typed errors** (`ValidationError`, `WriteConflictError`, `IntegrityError`, `UnsupportedError`, …),
never thrown strings — so callers can branch on *why* something failed.

### Coming from Redis bitmaps?

**This is a durable, cloud-native home for *set-shaped* data** — audiences, suppression lists, membership,
eligibility — where the sets are large, mostly read, have to survive a restart, and are **computed in batches**
upstream. It does that without an always-on cluster or a VPC for your functions.

**It is not a drop-in replacement, and the difference is the write model.** Redis mutates one bit in place per
call; here a segment changes only by getting a **new generation** — you compute the set, load it, and read it.
There is no per-id write at all, so a `SETBIT` loop has nothing to port to: if your set is defined by a query,
run the query and load the result; if it is defined by events arriving one at a time, accumulate them in the
system that receives them (Redis does that well) and load the set on a cadence.

The *read* side carries over one-for-one:

| Redis | Here | Difference |
|---|---|---|
| `GETBIT key id` | `has(id)` | none in meaning — an id is a bit offset, both `u32` |
| `BITCOUNT key` | `count()` | exact, and served from the index without fetching payloads |
| `BITOP AND dst a b` | `a.intersect([b])` / `a.intersectInto(dst, [b])` | streams, and skips chunks that cannot contribute; `dst` becomes a new generation |
| `BITOP OR dst a b` | `a.union([b])` / `unionInto` | none in meaning |
| `BITOP DIFF dst a b` (Redis 8.2+) | `a.andNot([b])` / `andNotInto` | none in meaning; reads `b` only where it overlaps `a` |
| `BITOP ANDOR dst x y1 y2` (Redis 8.2+) | — | no single call; it is `x ∩ (y1 ∪ y2)` — `unionInto` a temp, then `intersect` |
| `BITOP XOR` | — | no single call; compose as `(a ∪ b) \ (a ∩ b)` |
| `BITOP NOT` · `BITOP ONE` | — | no equivalent |
| `SETBIT key id 1` / `SETBIT key id 0` | — | **no per-id write.** Build the set upstream and `store.load()` it; remove one id everywhere with `eraseSubject` (a rewrite, for compliance — not a hot-path verb) |
| `EXPIRE key seconds` | `store.setRetention(ref, { expiresAt })` + `store.retireExpired()` | per **segment**, never per id (a bitmap stores ids, not timestamps), and the sweep is **yours to schedule** — this library starts no timer, so it behaves the same in a Lambda and a server. [retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt) |

You are not giving up the bitmap: each 65,536-id chunk is stored in whichever of Roaring's three encodings is
smallest for that chunk. Past **4,096 ids** in a chunk (6.25% of it) a flat bit array — a bit per id, as your
Redis bitmap holds it — beats a sorted list of ids, unless the ids form runs, where a run encoding is smaller
still: a contiguous range costs a few bytes a chunk. So the bit array is chosen per chunk instead of assumed for all of
them, and below that threshold you stop paying for the empty span.

**What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array, so anything that reads
your Redis bitmap's underlying string — a job that `GET`s the key and indexes into it, a byte-for-byte backup,
another service that already parses that layout — will not read ours. `BITFIELD`, `BITPOS`, and the byte-range
forms of `BITCOUNT` have no equivalent either: this is a set of ids, not an addressable bit buffer, and
`BITOP NOT` in particular has nothing to complement against, because there is no bounded universe here, only the
`u32` id space. Raw bit-position **import** (the migration direction off Redis) and export are not built; whether
they get built depends on someone saying they need them. Everything reached through bitmap *operations*
transfers today; everything reached through the bytes does not.

## Intersecting segments (the crown jewel)

`intersect` streams the ids present in **every** operand, ascending — and only ever downloads the Storage chunks
whose 16-bit key appears in *all* of them, so two huge segments that barely overlap transfer almost nothing:

```ts
// Every operand is a loaded segment: a combine refuses one that names no segment.
await store.load({ segment: 'high-value-shoppers' }, shopperIds);
await store.load({ segment: 'active-this-week' }, activeIds);
await store.load({ segment: 'opted-in' }, optedInIds);
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, optOutIds);

const shoppers = store.segment('high-value-shoppers');
const active = store.segment('active-this-week');

// stream the ids in BOTH segments
for await (const id of shoppers.intersect([active])) {
  /* … */
}

// more than two: ids in all three
for await (const id of shoppers.intersect([active, store.segment('opted-in')])) {
  /* … */
}

// minus a suppression list, in the same pass — the opt-out list is read only where the intersection survived
const optOut = store.segment('global-opt-out', { namespace: 'suppression' });
for await (const id of shoppers.intersect([active], { exclude: [optOut] })) {
  /* … */
}

// or materialize the result as a new generation of another segment
const res = await shoppers.intersectInto(store.segment('campaign-targets'), [active]);
res.cardinality; // how many ids the new generation holds
```

It holds only a bounded window of chunks in memory at a time (tune with `{ concurrency }`), so it runs over
enormous segments in a small/serverless process. `intersect` is commutative: `a.intersect([b])` ≡
`b.intersect([a])`. Each operand's generation is resolved once, up front, so a load publishing mid-call cannot
tear the result.

## Troubleshooting

### `Cannot find module './build/Release/roaring.node'` after a successful install

The install **exits 0** and the package is then unusable at runtime. Two ways to get here — and on **pnpm 10
the plain install is one of them**, with no flag of your own:

```
$ pnpm add @cloudbitmaps/roaring          # pnpm 10+: warns "Ignored build scripts: roaring", exits 0
$ npm i --ignore-scripts @cloudbitmaps/roaring    # any client, when you opt out of scripts
$ node -e "require('@cloudbitmaps/roaring')"
Error: Cannot find module './build/Release/roaring.node'
```

**pnpm 10 does not run dependency build scripts unless you allow them** — a deliberate supply-chain default, not
a bug — so it is the one client where the *documented* install command needs a second step. pnpm 9 runs them,
and so does npm unless you pass `--ignore-scripts`.

**Why.** The native dependency `roaring` publishes an npm tarball containing **no** compiled binary; it ships an
`install` script that downloads the right prebuilt binary for your platform from GitHub Releases. Skip install
scripts and that download never happens, so there is nothing for the addon loader to find. The client reports
success because the *install* did succeed — only the post-install step was skipped.

**Fixes, in order of preference:**

1. **Allow the install script for that one package** — narrow the exception rather than re-enabling scripts
   globally. On pnpm, put it in your own `package.json` so CI and teammates inherit it:

   ```json
   { "pnpm": { "onlyBuiltDependencies": ["roaring"] } }
   ```

   `pnpm approve-builds` does the same thing interactively. On npm, scope an install to it.
2. **Then re-run the skipped step** — `pnpm rebuild roaring`, or `npm rebuild roaring` on npm. On pnpm the
   allowlist above has to be in place **first**: `pnpm rebuild roaring` without it is a **silent no-op** — it
   prints nothing, exits 0, and leaves the package just as broken, because rebuilding still runs a build script
   and pnpm still will not. (`npm rebuild roaring` does repair a pnpm-installed tree, if you have npm to hand.)
3. **Build from source** — `npm_config_build_from_source=true npm i` with a C/C++ toolchain present. Also the
   route on **Alpine/musl**, where no prebuilt binary is published at all.

**Check it at install time, not at 3am.** Because no client's exit code tells you about this, add a startup or CI
assertion that the addon actually loads — `node -e "require('@cloudbitmaps/roaring')"` — so a broken install
fails your pipeline instead of your first request.

### `DEP0169 DeprecationWarning: url.parse() behavior is not standardized`

You will see this on stderr the first time the package is loaded:

```
(node:1234) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors
  at node_modules/@mapbox/node-pre-gyp/lib/util/versioning.js:338
  at node_modules/roaring/index.js:32
```

**Nothing is wrong, and it is not CloudBitmaps code.** The chain is `@cloudbitmaps/roaring` → `roaring` (the
CRoaring binding, the only native code involved) → `@mapbox/node-pre-gyp`, which locates the prebuilt binary for
your platform. Finding it also computes the URL the binary *would* be downloaded from, using Node's legacy
`url.resolve()`; that URL is then discarded, because the binary is already installed. So the warning is emitted
for a computation whose result is never used.

Specifics, so you can decide whether to care:

- **Emitted once per process**, on **stderr**, and the process exits normally.
- **Building from source does not avoid it.** `roaring` calls node-pre-gyp's lookup first and only falls back to
  a locally-built binary if that throws `MODULE_NOT_FOUND`, so the lookup — and the warning — happens either way.
- **It is not a stale dependency.** `@mapbox/node-pre-gyp` is at its latest published version; there is no
  upgrade that removes this. The real fix is upstream in `roaring`, migrating to a resolver that reads the
  filesystem without constructing URLs. Nothing in CloudBitmaps calls `url.parse()`.
- **Security:** the inputs are `roaring`'s own `package.json` fields, not runtime or user-controlled data, and no
  network request happens at load. The vulnerability class that motivated this deprecation — trusting a host
  parsed out of untrusted input — does not apply here.

**The one case where it actually matters.** If you run Node with **`--throw-deprecation`**, warnings become
thrown errors and **your process will exit non-zero**. The import itself still succeeds — deprecation warnings
are emitted asynchronously, so the throw lands after the module has loaded — but the process dies. If you use
that flag, either drop it for the process that loads CloudBitmaps or allow this one deprecation.

**What not to do:** `--no-deprecation` silences *every* deprecation warning in your application, including ones
about your own code. Suppressing a whole diagnostic channel to hide one known-benign line is a bad trade.

## Where next

- [Roadmap](../ROADMAP.md) — what's shipped, the **validated envelope** (what's proven and what isn't), the
  path to `1.0`, and what we've deliberately said no to.
- [API Reference](api-reference.md) — every export, kept in sync with the code by CI.
- Writing your own storage driver? A shared **conformance suite** (`packages/roaring/src/testing/conformance.ts`) is the bar
  every driver in this repository passes. It is an internal helper, consumed in-repo through the `@/` alias and
  not exported as a public `./testing` package subpath, so a driver outside the repository cannot run it; the
  [driver kit](api-reference.md#driver-kit--what-you-need-to-implement-a-driver) lists the behaviours to reproduce
  by hand. The suite covers `IStorageDriver` (`storageDriverConformance`) as well as `IRegistryDriver` and
  `StorageChunkSource`.
