# CloudBitmaps

[![npm](https://img.shields.io/npm/v/@cloudbitmaps/roaring?logo=npm&label=%40cloudbitmaps%2Froaring)](https://www.npmjs.com/package/@cloudbitmaps/roaring)
[![CI](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/@cloudbitmaps/roaring)](https://nodejs.org)

> Take the [Roaring Bitmap](https://roaringbitmap.org/) — the compressed-bitmap data structure behind
> Lucene, ClickHouse, Druid, and Spark — and make it **distributed, durable, and cloud-scale**. Sets too big
> for one machine's RAM live as immutable generations in one object-storage bucket, and you read them —
> `has`, `count`, `iterate`, `intersect` — from anywhere, including a stateless function with no cache to
> warm. Data enters by **loading a new generation**, never by mutating a stored one.

> Pre-1.0 on purpose — `1.0` is earned by real-cloud
> cost calibration, real adoption, and freezing the `.crbm` on-disk format, so until then the public API
> and the on-disk format stay evolvable. Everything under *Works today* is implemented and covered by
> tests — unit, property-vs-oracle, a deterministic fault-injecting simulator, conformance suites run
> against real backends (or a faithful emulator), coverage-guided fuzzing of the untrusted-`.crbm`
> boundary, and mutation testing of the highest-risk core modules. What's proven to what degree — and
> what isn't — is set out in the [validated envelope](docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt).
> **Works today:** the loaded store over **in-memory** and **local-filesystem** storage, with every cloud driver
> in its own package — **object storage** on **S3-compatible** (`@cloudbitmaps/s3`), **GCS**
> (`@cloudbitmaps/gcs`), and **Azure Blob** (`@cloudbitmaps/azure-blob`); a **segment registry** on each of those same three clouds
> (plus memory / LocalFs), so a deployment can run on **one bucket alone**. `store.load` (write one immutable
> generation from an array, a Set or an async cursor, then publish it forward-only) · `has` / `count` /
> `iterate` / **`intersect` (chunk-skipping)** / `union` / `andNot`, all with `exclude` suppression folded into
> the same pass · `intersectInto` / `unionInto` / `andNotInto`, which publish a new generation of their
> destination · the `.crbm` archive format · a bounded, generation-keyed cache · **automatic retry with
> backoff** that rides out transient cloud faults · registry-resolved generation pointers (no per-read scan)
> with a short refresh TTL · generation GC that never touches the current generation · **subject erasure by
> generation rewrite** (the bit is physically gone from the bucket when the call returns) · `dropSegment`,
> retention policies and a `retireExpired` sweep you schedule · **encryption-at-rest** (opt-in AES-256-GCM,
> bring-your-own-key, **no required cloud dependency**) with **crypto-shred** erasure · an optional
> **observability metrics sink** (`IMetricsSink` — storage/cache/retry/intersect/op events, no-op by default, no
> telemetry dependency) · a **cost estimator** (`estimateCost` planning + grounded `costReport` from real
> segment sizes, with a pluggable pricing profile and an honest win/lose verdict) · and an optional **audit
> sink** (`IAuditSink` — publish / rewrite / dispose / crypto-shred events for an append-only audit log or SIEM,
> a truthful GDPR Art. 30 erasure trail).
> **Pre-1.0.** The public API and the `.crbm` on-disk format may still change before `1.0` — that version
> is earned by real-cloud cost calibration, real adoption, and a format freeze, not by a date.

## Why it exists

A Roaring Bitmap is a brilliant way to hold a huge set of integer IDs — *"which of my 1.2 billion customer
IDs are in the `high-value-shoppers` segment?"* — in very little space, with microsecond membership tests
and set operations. But the established libraries (the C/Java/Go implementations and the `roaring`
Node bindings) are **local, in-process data structures**: a bitmap is bounded by one machine's RAM and
disappears when the process dies.

So today, if you want big bitmap-backed **audience segments** or **membership/feature-flag sets** that are
shared across services and survive restarts, you reach for something like an always-on Redis cluster —
which is fast, but **expensive to keep running** and **forgets everything on restart** unless you bolt on
persistence. You're paying for RAM, 24/7, to hold sets that are mostly read.

**CloudBitmaps** keeps the bitmap engine and the developer experience, but puts the *storage* in one
pluggable, cloud-native place: immutable generations, cheap and durable at rest (cents/month in object
storage), with a RAM cache in front of them — able to answer set queries over enormous bitmaps from small,
stateless functions, and costing nothing while nobody is asking.

## Your data stays yours

A fair question before you build on any storage library: *if I put billions of IDs across thousands of
segments into this and the library breaks, am I stuck?* Short answer — **no** — and here's why, by construction:

- **It's a library, not a service.** Your data lives in **your** bucket, **your** account, **your**
  filesystem — accounts and stores you own. CloudBitmaps never sees or holds it (you're the data controller;
  see [`PRIVACY.md`](PRIVACY.md)). If the project vanished tomorrow, nothing is deleted or held hostage — the
  objects are still in your bucket.
- **The durable tier is an open, standard format.** Storage `.crbm` objects are a **documented container**
  (format spec — a footer index + CRC32C, nothing proprietary) wrapping
  **standard portable RoaringBitmap serialization** — the exact bytes every roaring library (Java, Go, Python,
  C++, Rust, C#) already reads. "Get my data out" = read the index, hand each chunk payload to any roaring
  library. The escape hatch is the format itself.
- **Immutable + versioned + checksummed — a bug can't quietly eat your data.** Storage objects are write-once and
  generation-numbered; the registry's `currentGen` pointer is the only thing that makes one "live." The worst a
  bad load can do is write a *new* bad generation — the previous one is intact, and you roll the pointer
  back. Every chunk, index and footer carries a **CRC32C that is verified before the bytes reach the
  deserializer**, so corruption is **detected and rejected, never served as a wrong answer**. A write also
  returns the object's **SHA-256** for you to record if you want an end-to-end check of your own — but be
  clear on the scope: that digest is *not* stored by the library and *not* re-checked on read. The read-path
  integrity guarantee is the CRC32C.
- **A one-command exit.** `store.exportSegments(sink)` (and the `export-segments` CLI) dumps every registered
  segment's current generation to a portable file — `roaring` (loadable by any roaring library) or `ndjson`
  (zero-dependency) — so leaving is a command, not a research project (and it's a building block for a
  data-portability request). A segment it can't read is recorded in the manifest's `failed[]` and the run
  continues, so one bad segment never blocks the dump.

**Honest caveats.** If you'd rather migrate by copying the **raw storage** than by running `exportSegments`,
the `.crbm` objects are readable with any roaring library but the **registry** rows are in CloudBitmaps' own
(documented) schema, not a universal interchange format — so that route means reading each segment's current
generation number out of the registry (or taking the highest generation present) and then reading the objects.
`exportSegments` enumerates the registry, which every published generation writes to, so it is complete by
construction for any segment you loaded through a store with a registry wired. And the real risks of a young
library are
**operational** (a bug affects live ops — recoverable, since the bytes are immutable and yours) and **maturity**
(single-maintainer, pre-1.0); we document the
case against adopting it too. Contrast the
alternatives: pure roaring libraries have zero lock-in *because they don't manage storage at all* (you persist
the bytes; same format as ours); bitmap **databases/services** (FeatureBase/Pilosa, ClickHouse, Doris, Redis)
manage storage for you but keep your data in *their* engine, exited via *their* export. CloudBitmaps is the
unusual middle — a library orchestrating *your own* cloud storage.

## How it works

**Key routing.** Every 32-bit ID is split into a **16-bit chunk key** (the top half) and a **16-bit
remainder** (the bottom half). Each chunk is itself a small Roaring bitmap holding up to 65,536 members.
This is the unit of storage and transfer — you never read a whole segment to test one ID, and a load groups
its ids by chunk first (10,000 IDs spanning 12 chunks become **12 chunks in one object**, not 10,000 writes).

**Two tiers and one pointer, behind pluggable drivers.** The engine is storage-agnostic — it talks to
driver *interfaces*, never a specific cloud SDK — so the same code runs on local files, AWS, GCP, Azure, or
MinIO:

```text
  load(ids) ─► group by chunk ─► write ONE immutable .crbm object ─► publish the pointer
                                   (segment.<gen>.crbm, write-once)     (registry CAS, forward-only)

  has(id)   ─► CACHE? (RAM + bounded LRU) ─► STORAGE (single-chunk byte-range read)
  count()   ─► the object's footer index (0 payload reads)
  intersect(A,B) ─► align chunk indexes ─► fetch only the chunks present in BOTH ─► stream IDs
```

- **Cache** — a bounded in-RAM LRU of decoded chunks, keyed by generation (a hard memory ceiling; performance
  only, never truth). A new generation misses the cache rather than serving stale bytes.
- **Storage** — the durable base: immutable, generation-keyed `.crbm` archive objects in object storage (S3,
  etc.), with a footer index that makes `count()` and single-chunk reads cheap.
- **The registry** — one small row per segment saying which generation is current (plus its wrapped data key
  and its retention policy). It is the only thing a write mutates, and it moves by compare-and-swap.

**Data enters by loading a generation, never by mutating one.** `store.load(ref, ids)` streams your ids —
an array, a Set, or an async cursor straight out of Athena/BigQuery/Postgres — into a single write-once object,
checks the result is plausible, advances the pointer, and collects what the move superseded. That makes the write path trivially safe in the ways that usually hurt: a crash
before the publish leaves the previous generation authoritative, a rerun is idempotent, two loaders racing the
same generation number means one of them gets a `WriteConflictError` rather than a torn segment, and there is
no such thing as a partially-visible load. The same protocol backs the derived writes — `intersectInto`,
`unionInto` and `andNotInto` publish a new generation of their destination — so there is exactly one way data
becomes visible.

**The crown jewel: serverless, chunk-skipping intersection.** To find the IDs in *both* of two billion-ID
segments, CloudBitmaps reads only the two small chunk **index maps**, aligns their 16-bit keys, and fetches
**only the chunks present in both** — so two 100 MB segments overlapping in 5% of chunks transfer ~10 MB, not
200 MB, and the whole thing runs inside a 128 MB Lambda. Suppression composes into the same pass: an `exclude`
operand is read *only at the keys that survived*, so subtracting a 61,000-chunk global opt-out list from a
40-chunk audience costs at most 40 reads, not 61,000. This is the capability no embeddable OSS bitmap library
offers off the shelf.

**Erasure is a rewrite, and it is physical.** `eraseSubject(id)` finds every segment the id is in, streams that
segment's current generation through a fresh one with the single bit cleared, publishes it, and then deletes the
generation that held the bit — so when the call returns the id is **gone from the bucket**, not merely masked.
Constant memory (one chunk in flight), and the audit sink gets a `segment.rewrite` receipt naming both
generations. `dropSegment` retires a whole segment (tombstone, then sweep the objects); `retireExpired` does the
same for everything whose retention policy has passed. Superseded generations are collected by
`gcOrphanGenerations`, which never touches the current one.

**Encrypted at rest, with real erasure.** Turn on encryption by passing a **keystore** — the storage `.crbm`
objects (payloads *and* index) are **AES-256-GCM**-encrypted, so a leaked bucket reveals neither ids nor
cardinality. It's **bring-your-own-key with no required cloud dependency**: you supply 32-byte keys; a
per-segment data key is wrapped under yours and kept in the registry (KMS/Vault adapters can drop in later via
the `IKeystore` seam). **Crypto-shred** (`destroySegment` / `eraseNamespace`) deletes that key, making the
encrypted bytes permanently unrecoverable *everywhere, including backups* — GDPR erasure that doesn't depend on
reaching every copy. Rotate keys without re-encrypting data, and wrap under an offline **recovery key** so a
lost key isn't fatal.

**Resilient by default — a blip never loses data.** Cloud storage throttles, returns 5xx, and drops
connections; CloudBitmaps treats that as normal. Every storage call automatically **retries transient faults**
(throttle / 5xx / dropped connection / request timeout) with bounded exponential backoff + full jitter — on by
default, tunable, or `retry: false` to defer to your client's own retry. Retries are **safe by construction**:
generations are write-once, so a timed-out-but-committed object write is detected as a conflict rather than
duplicated; the pointer moves only forward, so a retried publish can never regress a segment; and all tier
bytes are checksum-verified (and AEAD-authenticated when encrypted) before use, so corruption is rejected
rather than returned as a wrong answer. Set a request timeout on your injected storage client (it's
retried as transient); see the [getting-started guide](docs/guide/getting-started.md) for tuning.

## What it costs — measured on real AWS

Most libraries in this space quote a model. This one has a bill. Run `2026-09-23-94416` drove the published
packages against a real AWS account in `us-east-1`, with the pointer in the same bucket as the data — the
topology that ships: 12 loads and 40 cold intersects, every one exact. What each costs:

| Operation | Measured cost | | Always-on Redis-HA |
|---|---|---|---|
| Cold `intersect` of two 500,000-id segments sharing 100 of 1,999 chunks: 204 GETs | **$81.60 / million** | | **$346 / month**, standing |
| Loading a segment: the write and the publish, pointer included | **$11.20 / million** | | whether you send traffic or not |
| `count()` on a published segment (an older run; the pointer is **not** in this figure) | **$0.14 / million** | | |
| 1.2 GiB of segments at rest, no traffic | **$0.03 / month** | | |

Each intersect fetched 100 of the 1,999 chunks per segment — the ones the two share — and never requested the
rest: chunk-skipping, on real S3. The `count()` figure comes from an older run, `2026-07-25-60291`, which kept the
pointer in a NoSQL table the library no longer ships, so it is the object-store half of that shape. The
[run's report](bench/calibration/2026-09-23-94416.md) explains every figure, and the
[benchmarks page](docs/benchmarks.md) states exactly what each run did and did not measure.

Request counts are read off the AWS SDK layer, command by command — not estimated from sizes, and not taken
from the library's own metrics, which cannot see a PUT. The older run also measured the things a cost model can
only assume: **zero retry billing** (HTTP
attempts equalled commands), **zero LIST calls** on the read path (LIST bills at 12.5× a GET — a stray
list-per-read is this design's classic cost blowup), and **23 S3 GETs serving 2,000 reads** as the bounded
cache did its job.

The older run also exercised an incremental-write path that **no longer exists** (see *Status* below), so its
write-side line items and its grand total are not quoted here. The loaded store's in-region latency and load
throughput are the next benchmark pass; the benchmarks page keeps the list of
[what is still owed](docs/benchmarks.md#what-is-still-owed).

**On latency, the honest version:** both runs were driven from outside the region — the newer one's client sat
83 ms of internet from it, measured rather than inferred — so their timings are network transit. They calibrate
**cost**, not in-region latency, and we don't publish an in-region latency figure until an in-region run happens.
Full numbers, method, and an explicit list of what each run does *not* establish:
**[benchmarks](docs/benchmarks.md#real-cloud-calibration--aws)**.

## Install & entry points

```bash
pnpm add @cloudbitmaps/roaring   # the codec + engine + in-memory & local drivers (one third-party dep: roaring)
pnpm add @cloudbitmaps/s3        # the storage you actually have — or @cloudbitmaps/gcs, or @cloudbitmaps/azure-blob
# npm i @cloudbitmaps/roaring @cloudbitmaps/s3   # the same two packages, with npm
```

> **On pnpm 10+, allow the one build script.** pnpm 10 skips dependency build scripts by default, so
> the `roaring` native addon never downloads and the package throws at `import` — while the install
> itself prints a warning and **exits 0**. Add this to your `package.json`, then install:
>
> ```json
> { "pnpm": { "onlyBuiltDependencies": ["roaring"] } }
> ```
>
> pnpm 9 and npm run it already. [Full symptoms and fixes](docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

> **ESM-only, Node ≥ 22.12.** These packages ship as ES modules; there is no CommonJS bundle. `import` is
> unaffected, and so is bundling — verified with esbuild, webpack, rollup and Vite, emitting CommonJS as well
> as ESM.
>
> A CommonJS codebase can load it too: `require('@cloudbitmaps/roaring')` works through Node's `require(esm)`,
> which is why the floor is 22.12 and not 22 (22.11 throws `ERR_REQUIRE_ESM`). On 22.12 exactly you will also
> see an `ExperimentalWarning` about loading ES modules from `require()`; it is gone by Node 24.
>
> Two things to know before you upgrade:
>
> - **A loader that is not Node's own does not get `require(esm)`**, on any Node version. Two you are likely
>   to meet:
>   - **Jest**, in its default configuration — `require('@cloudbitmaps/roaring')` in a test fails with
>     `Must use import to load ES Module`. Use Jest's ESM support (`--experimental-vm-modules`), or `import`
>     the package instead of requiring it.
>   - **Yarn PnP** (`nodeLinker: pnp`) — its runtime implements `require` itself and throws
>     `ERR_REQUIRE_ESM`. Unlike the Node-version case this does not go away on Node 24; `import` the package,
>     or use `nodeLinker: node-modules`.
> - **On TypeScript**, a `.ts` file in a CommonJS package needs `"module": "nodenext"` or `"node20"`.
>   `node16` and `node18` do not know about `require(esm)` and report `TS1479` on the import. A project on
>   `moduleResolution: bundler` is unaffected.

**You install two packages: a codec and a storage.** `@cloudbitmaps/roaring` is the *flavor* — the roaring
codec + the `CloudRoaring` facade. `@cloudbitmaps/s3` is the *storage* — one package per service, which
depends on its cloud SDK **for real**, so installing it is all you do. Both depend on
**`@cloudbitmaps/core`**, the codec-agnostic engine; core arrives **transitively**, you never install it, and
it has **zero runtime dependencies and no cloud SDK in it at all**.

Nothing here is an optional peer. There is no second install step to forget, no "install the peer" error, and
no SDK for a service you do not use.

| Install | Gives you | Pulls |
|---|---|---|
| `@cloudbitmaps/roaring` | `CloudRoaring` + the in-memory and local-filesystem drivers, loading, erasure, crypto, cost/metrics/audit seams, errors | `roaring`, `@cloudbitmaps/core` |
| `@cloudbitmaps/s3` | `S3Storage` — and `S3StorageDriver` / `S3RegistryDriver` if you want the halves separately. S3 and every S3-compatible service: R2, MinIO, Ceph, Wasabi, B2 | `@aws-sdk/client-s3`, core |
| `@cloudbitmaps/gcs` | `GcsStorage`, `GcsStorageDriver`, `GcsRegistryDriver` | `@google-cloud/storage`, core |
| `@cloudbitmaps/azure-blob` | `AzureBlobStorage`, `AzureBlobStorageDriver`, `AzureBlobRegistryDriver` | `@azure/storage-blob`, core |
| `export-segments` (CLI bin, in the flavor) | eject every segment to portable files (`roaring` \| `ndjson`) — your exit path | — |

**Why by service rather than by cloud.** An `@cloudbitmaps/aws` would have to depend on both the S3 SDK and
the DynamoDB SDK, and "azure" is ambiguous across Blob, Table, Files and Data Lake. `s3` rather than `aws-s3`
because S3 is a protocol as much as a product — the same package serves R2 and MinIO.

> **Alpine / musl:** `roaring` — `@cloudbitmaps/roaring`'s one third-party dep — ships prebuilt binaries for common **glibc**
> targets (incl. Amazon Linux, which CI proves each run). It has **no musl prebuilt**, so on an Alpine base image
> it compiles from source at install — add a toolchain first (`apk add --no-cache build-base python3`), or use a
> glibc image (`node:22-slim`). This is a `roaring` install-time requirement, not a runtime dependency of
> CloudBitmaps.

## Quick taste (works today)

The in-memory drivers need zero setup — ideal for a first look or a test:

```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

// One object carries both halves: where the generations go, and where the pointer goes.
const store = new CloudRoaring({ storage: new MemoryStorage() });

// A load is how data gets in: one immutable object, then the pointer moves to it.
await store.load({ segment: 'high-value-shoppers' }, [5, 99_999, 1_234_567_890, 2_000_000_000]);

const seg = store.segment('high-value-shoppers');

await seg.has(1_234_567_890); // → true  (one chunk, from the cache after the first read)
await seg.count(); // → 4     (summed from the object's index — no payload reads)
for await (const id of seg.iterate()) {
  /* ascending IDs */
}

// Chunk-skipping intersection: only the chunks present in both are ever fetched.
const optedOut = store.segment('opted-out');
for await (const id of seg.intersect([store.segment('eu-residents')], { exclude: [optedOut] })) {
  /* the audience to send to */
}
```

Swap `MemoryStorage` for `LocalFsStorage('./.cloudbitmaps')` (one root; the generations and the pointer land
straight in — the store wraps the storage driver in its `.crbm` reader for you) and the same code persists to disk
and survives a restart — see the **[getting-started guide](docs/guide/getting-started.md)** for that and the
full operation reference.

For the cloud, you pass **one backend** — e.g. everything on **S3 alone** (storage objects and
the registry in one bucket; no other service):

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

// Bucket stated once, for both the generations and the pointer. Builds its own client from the
// ambient credential chain; pass `client`, or `endpoint` + `pathStyle` + `credentials`, when you need to.
const store = new CloudRoaring({
  storage: new S3Storage({ bucket: 'bitmaps', region: 'us-east-1' }),
});
```

## Choosing drivers

**Normally you pick a backend, not drivers.** One class names the location once and carries both halves, so
the mismatch that silently answers "empty" — generations at one prefix, the pointer at another — cannot be
written:

| Backend | from | example |
|---|---|---|
| `MemoryStorage` | `@cloudbitmaps/roaring` | `new MemoryStorage()` |
| `LocalFsStorage` | `@cloudbitmaps/roaring` | `new LocalFsStorage('/var/lib/cloudbitmaps')` |
| `S3Storage` | `@cloudbitmaps/s3` | `new S3Storage({ bucket, prefix })` |
| `GcsStorage` | `@cloudbitmaps/gcs` | `new GcsStorage({ bucket, prefix })` |
| `AzureBlobStorage` | `@cloudbitmaps/azure-blob` | `new AzureBlobStorage({ connectionString, container })` |

Underneath, each seam is still an independent, swappable driver — all pass the same conformance suite, so the
same application code runs on any mix. Reach for these directly only when a backend cannot express your
deployment (a registry in a database you already run, say):

| Seam | in-memory | local filesystem | cloud |
|---|---|---|---|
| **Storage** (the durable base) | `MemoryStorageDriver` · `MemoryStorageChunkSource` | `LocalFsStorageDriver` | `S3StorageDriver` · `GcsStorageDriver` · `AzureBlobStorageDriver` |
| **Registry** (current-gen pointer) | `MemoryRegistryDriver` | `LocalFsRegistryDriver` | `S3RegistryDriver` · `GcsRegistryDriver` · `AzureBlobRegistryDriver` |
| **Keystore** (optional encryption) | `InProcessKeystore` (BYOK) | ← same | ← same (KMS/Vault adapters are a future package) |

Mix freely: storage objects and the registry in **one bucket** is the whole deployment, on any of the three
clouds — which is exactly what a backend builds for you. To put the registry somewhere else entirely, behind
the `IRegistryDriver` interface, build the backend deliberately with
`createBackend({ storage, registry })`. A plain object literal is refused — it was also how halves from two
unrelated stores got paired by accident, which reads as an empty segment rather than an error. `createBackend`
cannot check that your two halves agree either; calling it is you taking that on.

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
  └───────────────────────────────────────────────────────────────────────┘
```

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'prod' }) });

const r = await store.load({ segment: 'vips' }, idsFromWarehouse());
if (!r.published) logger.warn({ reason: r.reason, had: r.cardinalityBefore });

for await (const id of store.segment('vips').intersect([store.segment('engaged')])) {
  /* the audience */
}
```

**You never name a registry, a generation number or a driver.** They exist and are exported, but a store, a
backend and the verbs above are the whole surface — everything below here is detail.

### The config object

**One config object, and one required key** — a backend carries both halves, so there is nothing else to wire
(`storage` also accepts a raw `IStorageDriver` for a cleartext read-only store, or a pre-built
`StorageChunkSource` for advanced reader options):

```ts
new CloudRoaring({
  storage,      // required — S3Storage | GcsStorage | AzureBlobStorage | LocalFsStorage | MemoryStorage
  cache,        // optional — { maxChunks, ttlMs, genTtlMs, readerMax, readerMaxBytes }
  encryption,   // optional — { keystore, required }; the wrapped DEKs live in the backend's registry
  retry,        // optional — a PARTIAL RetryPolicy plus { onRetry }, or `false` to disable
  metrics, budget,
  seams,        // optional — { clock, rng }; determinism, for tests and replayable jobs
});
```

**Per-segment ops** — `store.segment(name, { namespace?, expiresAt? })`:

| Method | Does |
|---|---|
| `has` · `count` · `iterate` | read one chunk / the index / the whole set. `count` is **0 payload reads** — it sums the `.crbm` index |
| `intersect(others, { exclude? })` | chunk-skipping set intersection, streamed. `exclude` subtracts suppression segments **in the same pass** — no intermediate segment |
| `union(others, { exclude? })` | set union, streamed. The one composite with **no** chunk-skipping — every chunk of every operand is read |
| `andNot(excludes)` | set difference. Reads all of `this`, but each suppression list **only where it overlaps** |
| `intersectInto(dest, …)` · `unionInto(dest, …)` · `andNotInto(dest, …)` | materialise the result as a **new generation of `dest`** (write-once, published forward-only) and report what was written |
| `costReport({ workload, pricing })` | grounded cost from the segment's real `.crbm` size |

**Store admin** (reuse the store's own drivers; need the store built with a backend):

| Method | Does |
|---|---|
| `store.dropSegment(ref, { confirmSegment, dryRun? })` | retire a segment and reclaim its storage — tombstone, then every Storage generation. `dryRun` previews |
| `store.setRetention(ref, { expiresAt })` · `getRetention` · `clearRetention` | record **when a segment becomes eligible for retirement** (an absolute instant you set — per segment, never per id) |
| `store.retireExpired({ namespace?, limit?, dryRun? })` | the **retention sweep**: retire everything whose expiry has passed, through `dropSegment`. A call you schedule, not a daemon — bounded, previewable, returns a per-segment ledger |
| `store.eraseSubject(id, { namespace })` | GDPR Art. 17 — rewrite every segment holding the id without it, so the bit is **physically gone** on return, and hand back an erasure ledger |
| `store.subjectReport(id, { namespace })` | GDPR Art. 15 — which segments an id is in |
| `store.checkConsistency()` | after a restore: every pointer's `.crbm` is actually present |
| `store.exportSegments(sink, { format })` | eject every segment to `roaring`/`ndjson` via an injected sink (your exit path) |
| `CloudRoaring.estimateCost(input)` | planning estimate (static, no data) |

**Lower-level free functions.** Everything above is also exported as a standalone function taking explicit
deps — `bulkLoadCrbmGeneration` (write one generation), `nextGeneration` / `gcOrphanGenerations` (generation
bookkeeping), `eraseIdFromSegment`, `destroySegment` / `eraseNamespace`, `dropSegment`,
`setSegmentRetention` / `getSegmentRetention` / `clearSegmentRetention`, and `retireExpired` (the sweep).
Nothing here schedules itself — run the sweep from a cron, a Lambda on a timer, or a `CronJob`.

**Prefer the store's own methods.** Building a store is free — no I/O, no connection — so a scheduled job has
no reason to compose a write path by hand, and composing is where steps get dropped: `store.load` runs the
empty guard *and* collects what the publish superseded, and a bare `bulkLoadCrbmGeneration` does neither.
Reach for these only when you have no store to hold — most often a read-only store built on a pre-built
`StorageChunkSource`, where the lifecycle helpers throw by design.

### What this is not

Worth knowing before you port anything, because the write model is where this differs most from what you may be
replacing:

- **It is not a mutable per-id store.** There is no `add`, no `remove`, no `SETBIT` equivalent. A segment changes
  only by getting a **new generation**: you compute the set (a warehouse query, a batch job, a `*Into` combine)
  and load it. If your set is defined by a query, run the query and load the result. If it is defined by events
  arriving one at a time, accumulate them where they arrive — Redis is genuinely good at that — and load the set
  on a cadence. Removing *one* id everywhere is a compliance operation (`eraseSubject`, a generation rewrite),
  not a hot-path verb.
- **It is not an addressable bit buffer.** `BITPOS`, `BITFIELD`, byte-range `BITCOUNT` and `BITOP NOT` have no
  equivalent. This is a *set of ids* — and `NOT` in particular has nothing to complement against, because there
  is no bounded universe here, only the `u32` id space. A `.crbm` object is not a flat bit array, so anything
  that reads your Redis bitmap's raw bytes will not read ours.
- **It is not a low-latency write path**, and a load is not a request-handler operation. A load is a batch job:
  bounded memory and cooperative (it streams to a multipart upload and yields the event loop), but it is
  I/O-heavy and it rewrites a whole segment. Schedule it.

Everything reached through bitmap *operations* transfers one-for-one — `GETBIT`→`has`, `BITCOUNT`→`count`,
`BITOP AND/OR/DIFF`→`intersect`/`union`/`andNot` — and `intersect` does something Redis cannot do at any price:
skip the chunks that cannot contribute. The full command-by-command mapping, including what has no equivalent,
is in the [getting-started guide](docs/guide/getting-started.md#coming-from-redis-bitmaps).

**If freshness is what you need**, the shape that fits this design is a shorter load cadence, not a per-id
write: object storage is immutable-object storage, so REPLACE is the native verb. A live layer, if there is
demand for one, would be built as immutable **delta generations** on the same bucket rather than as a mutable
tier.

### How data gets in

One call, three input shapes, and it bills **per object, not per id**:

```ts
// From memory, from a Set, or straight off a cursor — the ids never all sit in RAM as JS numbers.
const result = await store.load({ segment: 'audience' }, athenaCursor());
if (!result.published) {
  // A refusal is a normal outcome, not a throw — an upstream query that returned too little is caught here
  // rather than landing as a silent wipe of a live audience.
  logger.warn({ reason: result.reason, had: result.cardinalityBefore }, 'audience load refused');
}
```

The generation number is picked for you, from the highest the registry and the bucket know. Peak memory is the segment's compressed size (~2 MB for a million ids), not the id list: ids are
folded into per-chunk bitmaps as they arrive and the object streams out in 8 MiB parts. Re-running after a crash
is safe — a crash before the publish leaves the previous generation authoritative — and two loaders racing the
same generation number means one gets a `WriteConflictError`, never a torn segment.

The one way to make this expensive is to materialise the ids yourself first (`const ids = [...]` over ten
million rows) before handing them over; pass the cursor instead. Full signatures and per-backend setup are in
the **[getting-started guide](docs/guide/getting-started.md)**.

## When to reach for it

- **You have large ID sets** (audience segments, membership/eligibility, feature-flag cohorts, "seen"
  sets) that you want **durable and cheap at rest**, not pinned in always-on RAM.
- **You need fast membership + set algebra** (union/intersection/difference) over those sets — including
  intersecting very large sets from stateless/serverless workers.
- **You want to own your storage** (your bucket, your costs, your residency) rather than a managed
  bitmap service, and to keep a clean, embeddable API.

**Why the shape works at segmentation scale.** Per-operation latency is the wrong lens for a workload with
millions of users per segment, because the operations that govern it don't scale with N:

- **Building or refreshing a segment** is one bulk-load → **a single (or multipart) S3 PUT**, bounded by the
  bitmap's compressed bytes rather than by the number of users in it.
- **`count()` is free** — 0 payload reads on a published segment, summed from the `.crbm` index. Counting a
  ten-million-user audience costs the same as counting a thousand.
- **Membership checks come from RAM** once warm — measured at 23 S3 GETs across 2,000 reads.
- **Intersections skip** — two 2,000,000-id segments intersect by fetching only the shared chunks (100 of 2,000
  each, 24.6 ms). This is the case an always-on RAM store pays for by keeping both bitmaps resident.

It is **not** a general database, a full-text index, or a replacement for Redis as a low-latency cache —
it's a specialized engine for big, durable, cloud-resident bitmaps. A single membership check that misses the
cache costs a **ranged GET against object storage**, where an in-process RAM store costs a memory read —
so if you need a sub-millisecond p99 on a working set that fits a bounded cache, that's the right tool and
this isn't. (We deliberately publish no in-region latency *figure* until an in-region run measures one — see
[benchmarks](docs/benchmarks.md#what-is-still-owed).) Honest cost/performance
trade-offs (and where Redis or a columnar store wins instead) are documented as part of the design, not buried.

**Already using Redis bitmaps?** That paragraph is about Redis as a *cache*; this is about `SETBIT`-on-one-giant-key
as a *data model*, which is a different question. The **read** operations carry over one-for-one — `GETBIT` →
`has`, `BITCOUNT` → `count`, `BITOP AND`/`OR`/`DIFF` → `intersect`/`union`/`andNot` — and you are not giving up
the bitmap: past **4,096 ids** in a 65,536-id chunk (6.25% of it) Roaring stores that chunk *as* a flat bit
array, byte for byte what you have now. What does **not** carry over is the **write** model — there is no
per-id write here at all — and the raw bytes: a `.crbm` is not a flat bit array. See
[*What this is not*](#what-this-is-not) above, and the full command mapping in the
[guide](docs/guide/getting-started.md#coming-from-redis-bitmaps).

## Status & where it's headed

Built in phases, each shipped behind tests and an adversarial review:

- **M1 — local end-to-end** *(complete)*: the core engine + `.crbm` format + local-filesystem drivers +
  a shared driver conformance suite + a deterministic, seed-replayable concurrency simulator. No cloud needed.
- **M2 — Topology-A (the showcase)** *(complete)*: the S3 storage driver, bulk load, and the chunk-skipping
  intersection engine — the first shippable, the centerpiece.
- **M3 — durability & compliance** *(complete)*: the segment registry, forward-only publishing, and
  **encryption-at-rest + crypto-shred**. (A live write tier shipped in this milestone too and has since been
  removed — see *Where it is headed*.)
- **M4 — production-grade** *(complete)*: an observability metrics sink, an honest cost estimator, a
  **benchmark-as-test** harness that turns the cost/perf claims into build-breaking CI assertions, a
  **free `count()`** (0 payload reads on a published segment), an **audit sink** (`IAuditSink` — a truthful
  GDPR Art. 30 erasure trail), and the **compliance & governance** layer — [`PRIVACY.md`](PRIVACY.md),
  **subject access & erasure** (`subjectReport` / `eraseSubject` with a physical-deletion guarantee), and
  legal-hold guidance — have all landed. See the [benchmarks & crossover chart](docs/benchmarks.md) and the
  [dashboards guide](docs/guide/dashboards.md).
- **M5**: a hardened, benchmarked, trademarked **v1.0** public launch.

Beyond the milestones, the pre-1.0 **hardening backlog** is complete and the testing frontier now runs five
disciplines (soak · mutation · fuzz · DR · security) plus a hard RSS ceiling under a cgroup limit. Three went
with the write path they exercised — the stress, load/tail-latency and chaos harnesses all drove per-id writes
against an emulator, so they are **withdrawn rather than counted**, and the loaded-store equivalents are on the
owed list in [`docs/benchmarks.md`](docs/benchmarks.md). The production-readiness re-assessment
lands at **ready within a validated envelope** (read-mostly / large-fleet / single-tenant / single-region; the
scale/tenancy deferrals are tracked openly). **Additional storage drivers**: **GCS + Azure
Blob storage drivers shipped** (the object-store story is complete on AWS + GCP + Azure); the live write tier that
shipped alongside them in `0.9.x` was removed ahead of `1.0` as the library re-centres on write-once
generations (see the `CHANGELOG`). Security and supply-chain hardening is in place: npm build
provenance on every release, SHA-pinned Actions, a hard cgroup-RSS ceiling in CI, a native OS matrix, a
prebuilt Lambda layer, and continuous coverage-guided fuzzing.

**Where it is headed (September 2026).** The **loaded store** is the library. Compute a set upstream — a
warehouse query, a nightly job — load it as one immutable generation into your bucket, and then `has`, `count`
and chunk-skipping `intersect` it from anywhere: one bucket, no background process, nothing of ours in your
request path, and no bill while nobody is asking. `1.0`'s scope is that shape — settled, not still being
decided.

That shape is a choice, not a remainder. Every roaring-based engine that needs freshness meets it by
micro-batching into immutable segments, never by mutating a stored bitmap per call — so immutability is the
design, and the write-once generation is what makes a read cheap enough to serve from a stateless function.
Hot-path **reads** are ours; hot-path **writes** belong in RAM, and Redis does that well. A per-call
`add`/`remove` tier shipped in `0.9.x` and was retired ahead of `1.0` for exactly this reason; it is archived at
the git tag `archive/live-warm-tier`, and `0.9.x` stays on npm for anyone still on it. If per-call freshness
returns, it will arrive as immutable delta generations on the same bucket.

Shipped on the loaded store: a single-call `load()` with a guard against an upstream query that returned too
little, a `rollback()`, `exists()` and `segments()` so the registry answers "what do I have?" instead of you
keeping a list beside it, a **snapshot handle** so a long export or reconciliation reads one instant rather
than whichever generations were current as it ran, and a curated public surface. The loaded store's own
benchmarks of in-region latency and load throughput are **owed, not shipped**; the benchmarks page lists
[what is still owed](docs/benchmarks.md#what-is-still-owed). What the [benchmarks page](docs/benchmarks.md) does
quote from the cloud is cost: the single-bucket bill of the September 2026 calibration run, pointer included, and
the S3-side figures of the July 2026 run — both driven from outside the region, so neither carries a latency. Its
crossover chart is modelled, its at-scale table is a local-disk run, and its RSS ceiling comes from a local
container under a hard memory limit — and it labels each as such. The
public roadmap tracks all of it: [`docs/ROADMAP.md`](docs/ROADMAP.md).

The library ships as the **`@cloudbitmaps`** family — one shared engine, pluggable codecs, pluggable
storage. The repo is a pnpm workspace of five packages on two axes: `@cloudbitmaps/core` (the codec-agnostic
engine, the `.crbm` format, the driver ports, and the SDK-free memory and local-filesystem drivers — zero
runtime dependencies), the **codec** axis `@cloudbitmaps/roaring` (the roaring codec, the `CloudRoaring`
facade, and the `export-segments` CLI), and the **storage** axis `@cloudbitmaps/s3` · `/gcs` · `/azure-blob`,
one package per service. You install one of each axis; core arrives as their dependency.

## Documentation

- **[Usage walkthrough](https://cloudbitmaps.pages.dev/usage.html)** — how you actually use it, end to end:
  the mental model, local → cloud wiring, the operations, the real flows (load, match, campaign targeting,
  retention, encryption), and where cost + observability fit.
- **[Getting started](docs/guide/getting-started.md)** — the exhaustive, per-tier reference with every signature.
- **[API reference](docs/guide/api-reference.md)** — the complete callable surface, every export with its
  shape, kept in sync with the code by CI. Writing a storage driver? It documents
  [`@cloudbitmaps/core/driver-kit`](docs/guide/api-reference.md#cloudbitmapscoredriver-kit), the declared
  contract a driver package builds against.
- **[Migrating from 0.9.x](MIGRATING.md)** — eight changes. The live tier's removal touches every `0.9.x`
  deployment; a DynamoDB registry needs work **before** you upgrade; and two of the eight — the `*Into`
  verbs now replacing rather than appending, and the renamed metric/result/path strings — change
  behaviour without raising anything.
- **[Benchmarks](docs/benchmarks.md)** — the CloudBitmaps-vs-flat-Redis crossover chart + the gated cost/perf anchors.
- **[Privacy & shared responsibility](PRIVACY.md)** — the trust boundary (you are the controller; nothing is sent to us), the erasure/retention/residency contracts, and a DPIA + Art. 30 template.
- **[Roadmap](docs/ROADMAP.md)** — what's shipped, the **validated envelope** (what's proven and what isn't), what stands between here and `1.0`, and what we've deliberately said no to.
- **[Changelog](CHANGELOG.md)** — what's changed (newest first; everything under `[Unreleased]` until v1.0).
- **[Contributing](CONTRIBUTING.md)** — the gate every change runs, the adversarial-review step, and the code style.

## Building & contributing

A fresh clone passes the full gate with no manual setup. You need **Node ≥ 22.12** (`.nvmrc` pins the major,
22, which resolves to a release well past the floor) and **pnpm 9**; Docker is needed only for the integration
lane.

```bash
pnpm install
pnpm lint && pnpm lint:arch && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm test:integration   # spins up every backend via `docker compose` — no cloud account needed
```

**[`CONTRIBUTING.md`](CONTRIBUTING.md)** is the canonical record of how we work — branching & merge
conventions, the per-phase build-with-tests + adversarial-review process, the documentation map, and code
style. ([`CLAUDE.md`](CLAUDE.md) is the AI-agent operating manual; it embeds the engineering principles +
hard correctness invariants and defers to `CONTRIBUTING.md` for the process.)

## License

**Apache-2.0.** The unscoped `cloud-roaring` name is reserved on npm (a `0.0.0` placeholder) and the
`@cloudbitmaps` scope is where the packages publish; the name is trademarked at the public launch.
