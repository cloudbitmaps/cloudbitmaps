# Getting started

> **Status: `0.9.0` — pre-1.0.** Everything below is real and tested: it is what the engine actually
> exposes, covered by the test suite. The API may still change before `1.0`. CloudBitmaps is a **loaded store**:
> a segment is a series of write-once `.crbm` generations in object storage — **in-memory**, **local-filesystem**,
> **S3-compatible**, **GCS** or **Azure Blob** — behind one **registry** pointer (memory / LocalFs / S3 /
> DynamoDB). You compute a set upstream, **load** it as a generation, and read it — `has`, `count`, `iterate`
> and chunk-skipping `intersect` — from anywhere, with **automatic retry/backoff**, **encryption-at-rest +
> crypto-shred**, retention, GDPR erasure, cost reporting and observability around it.

> **One package to install: `@cloudbitmaps/roaring`.** Every import below is the real specifier. It is the
> *roaring flavor* of the `@cloudbitmaps` family — the roaring codec +
> the `CloudRoaring` facade — and it depends on **`@cloudbitmaps/core`**, the codec-agnostic engine that holds
> every storage driver. Core arrives **transitively**: you never install or name it (each
> `@cloudbitmaps/roaring/<backend>` subpath re-exports core's driver of the same name, so
> `@cloudbitmaps/core/s3` is equivalent if you prefer it).

> **Every export at a glance:** for the complete list of everything you can import and call (across
> `@cloudbitmaps/roaring` and its `/s3`, `/gcs`, `/azure` and `/dynamodb` subpaths), see the
> **[API Reference](api-reference.md)** — it's kept in sync with the code by CI. This guide is the narrated
> walkthrough of that same surface.

## What works today

| Capability | Status |
|---|---|
| **Load** a segment as an immutable generation from any id stream — array, generator, warehouse cursor (`bulkLoadCrbmGeneration`) | ✅ |
| `has` / `count` / `iterate` — `count()` summed from the `.crbm` index with **zero payload reads** | ✅ |
| **`intersect()`** — chunk-skipping set intersection, streamed; `union()` / `andNot()`; `exclude` folds suppression into the same pass | ✅ |
| **`intersectInto` / `unionInto` / `andNotInto`** — materialize a result as a **new generation** of another segment | ✅ |
| In-memory drivers (zero setup) | ✅ |
| Persistent **local filesystem** drivers (survive restart) | ✅ |
| **S3-compatible** cold storage — AWS S3 / MinIO (`@cloudbitmaps/roaring/s3`), multipart for large generations | ✅ |
| **GCS + Azure Blob** cold storage (`@cloudbitmaps/roaring/gcs`, `@cloudbitmaps/roaring/azure`) — write-once immutable generations | ✅ |
| `.crbm` archive read/write + a bounded HOT cache | ✅ |
| **Automatic retry + backoff** for transient faults (on by default) | ✅ |
| **Segment registry** (memory / LocalFs / DynamoDB / **S3** — run on S3 alone) — one strong read resolves the current generation, no per-read scan | ✅ |
| **Generation bookkeeping** — `nextGeneration` for the number a writer takes next; `gcOrphanGenerations` to collect superseded objects | ✅ |
| **Encryption-at-rest** (AES-256-GCM, BYOK keystore) **+ crypto-shred** (`destroySegment` / `eraseNamespace`) | ✅ |
| **Observability** — optional metrics sink (`IMetricsSink`): `cold.get` / `cache` / `retry` / `intersect` / `op` events | ✅ |
| **Audit trail** — optional audit sink (`IAuditSink`): publish / rewrite / erase / dispose compliance events | ✅ |
| **Cost estimator** — `CloudRoaring.estimateCost()` (planning) + grounded `segment.costReport()` | ✅ |
| **Benchmark-as-test** — cost/perf claims are CI-gated; published [crossover chart](../benchmarks.md) | ✅ |
| **Subject access & erasure** (GDPR Art. 15/17: `subjectReport` / `eraseSubject` — a rewrite, physically gone on return) | ✅ |
| **Retention** — `setRetention` records a per-segment expiry; `retireExpired` is the sweep you schedule; `dropSegment` reclaims storage | ✅ |
| **Per-op request budget** — denial-of-wallet ceiling on `count` / `iterate` / the combines / subject scans (on by default) | ✅ |
| **Cross-store consistency check** (`checkConsistency()`) — [torn-restore](disaster-recovery.md) detection | ✅ |
| **Export / eject** (`exportSegments` + the `export-segments` CLI) — portable `roaring` / `ndjson` | ✅ |

### Choosing a registry

> **Four backends ship a registry** — `MemoryRegistryDriver`, `LocalFsRegistryDriver`, `S3RegistryDriver`
> (`@cloudbitmaps/roaring/s3`), and `DynamoDbRegistryDriver` (`@cloudbitmaps/roaring/dynamodb`). The GCS and
> Azure Blob drivers are **cold-only — neither ships a registry**, so pair them with an S3 or DynamoDB registry.
> A registry is **optional for a read-only, cleartext store** (the store then list-scans the bucket for the
> highest generation), and **required** for encrypted segments, the `*Into` verbs, and every lifecycle helper
> (`eraseSubject`, `dropSegment`, `setRetention`, `retireExpired`, `checkConsistency`, `exportSegments`). Full
> registry details are in [§5](#5-the-segment-registry-resolving-the-current-generation).

## 1. The simplest thing: in-memory

A `CloudRoaring` store is wired to a **cold** driver (where the `.crbm` generations live) — **the only required
option** — and, for anything beyond a first look, a **registry** (the pointer that says which generation is
current). A `segment` is one named bitmap. Data gets into a segment **by loading a generation**: you hand
`bulkLoadCrbmGeneration` the ids, it writes one immutable object and publishes it. The in-memory drivers need no
setup — ideal for tests and a first look:

```ts
import {
  CloudRoaring,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  nextGeneration,
} from '@cloudbitmaps/roaring';

const cold = new MemoryColdDriver();
const registry = new MemoryRegistryDriver();
const store = new CloudRoaring({ cold, registry });

// Load a generation: any sync or async iterable of ids — an array here, a warehouse cursor in §3.
const ref = { segment: 'high-value-shoppers' };
const generation = await nextGeneration(ref, { cold, registry }); // → 0 on a brand-new segment
await bulkLoadCrbmGeneration(cold, { ...ref, generation }, [5, 99_999, 1_234_567_890, 2_000_000_000], {
  registry,
});

// Read it.
const vips = store.segment('high-value-shoppers');
await vips.has(1_234_567_890); // → true
await vips.count(); // → 4, summed from the index — no chunk is fetched
for await (const id of vips.iterate()) {
  // ascending ids
}
```

IDs are integers in `[0, 2³²)`. Each is split into a 16-bit chunk key + a 16-bit remainder, and a chunk is the unit
of storage and transfer: `has()` fetches one chunk (or answers from the hot cache), `count()` fetches none, and
`intersect()` fetches only the chunks two segments could share.

**There is no `add` or `remove` on a segment.** A segment changes by getting a *new generation* — the next load
supersedes the previous one, an `*Into` verb writes a new generation of its destination ([§7](#7-materializing-the-into-verbs)),
and a GDPR erasure rewrites the current generation without one id ([§13](#13-subject-access--erasure-gdpr-art-15--17)).
A segment that has never been loaded reads as empty — `has(x) → false`, `count() → 0`, `iterate() → []` — without
throwing, so there is nothing to create before the first load.

## 2. Persistent: the local filesystem

Same API, but state lives on disk and survives a restart. Pass the **raw** `LocalFsColdDriver` as `cold` —
the store wraps it in the `.crbm` reader for you, so you wire each driver exactly once:

```ts
import {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  bulkLoadCrbmGeneration,
  nextGeneration,
} from '@cloudbitmaps/roaring';

const cold = new LocalFsColdDriver('./.cloudbitmaps/cold');
const registry = new LocalFsRegistryDriver('./.cloudbitmaps/registry');
const store = new CloudRoaring({ cold, registry, cacheMaxChunks: 1024 }); // optional HOT-cache ceiling

const ref = { segment: 'active-this-week' };
await bulkLoadCrbmGeneration(
  cold,
  { ...ref, generation: await nextGeneration(ref, { cold, registry }) },
  activeUserIds,
  { registry },
);
// ...a fresh process pointed at the same dirs reads the same generation — the object and the pointer are durable.
```

> **The `cold` option takes either shape.** Usually you pass a **raw `IColdDriver`** (`LocalFsColdDriver`,
> `S3ColdDriver`, `MemoryColdDriver`) and the store builds the `.crbm` cold source — reading the
> `registry` / `keystore` / `requireEncryption` you pass alongside in the same config (§5 registry, §9
> encryption). Or pass an already-built **`ColdChunkSource`** — a `MemoryColdChunkSource` seeded chunk by chunk
> in a test, or a `CrbmColdChunkSource` you configured with advanced reader options (`tailBytes`, size caps). On
> that path, configure the registry/keystore **on the source itself** — passing them at the top level is rejected
> as a wiring mistake — and the store is **read-only**: the `*Into` verbs and the lifecycle helpers need the raw
> driver to write through and throw `UnsupportedError`.

## 3. Loading a segment

Loading is **the** write path. `bulkLoadCrbmGeneration` consumes a stream of ids, routes each into its chunk's
bitmap, writes the whole set as one immutable `.crbm` object, and — when you pass a `registry` — publishes it so
readers see it. Five things to know:

**Any id source, any order, duplicates welcome.** The input is a sync *or* async iterable, consumed lazily and
deduplicated on insert. An array, a `Set`, a generator, a file stream, a warehouse cursor:

```ts
async function* activeUsers() {
  for await (const page of warehouse.paginate(query)) for (const row of page) yield row.user_id;
}
const ref = { namespace: 'audiences', segment: 'active-30d' };
const res = await bulkLoadCrbmGeneration(
  cold,
  { ...ref, generation: await nextGeneration(ref, { cold, registry }) },
  activeUsers(),
  { registry },
);
res; // { size, sha256, chunkCount, cardinality, becameCurrent } — the object written and what it holds
```

Memory is bounded by the **distinct set being built** — one compressed bitmap per non-empty chunk — not by the
input length, so a billion duplicate-heavy ids stream through holding only the distinct result. (The staging
buffer between input and bitmaps is capped at ~28 MB measured, whatever the key distribution.) It is `O(distinct
set)`, though, not window-bounded like `intersect`: a load holds the whole generation in RAM, which suits a batch
job and not a request handler — see [where to run it](#what-blocks-the-event-loop-and-where-to-run-it).

**Generation numbering: take it from `nextGeneration`.** Generations are write-once — reusing a number throws
`WriteConflictError` — and the number a writer should use next is one above the highest the registry points at
*or* that is present in the bucket, whichever is higher. `nextGeneration(ref, { cold, registry })` computes exactly
that (a brand-new segment starts at `0`). The two are both consulted on purpose: a load that wrote its object and
crashed before publishing leaves an object *above* `currentGen`, and a writer consulting only the pointer would pick
that same number and conflict on every retry.

**Publish is forward-only, so a rerun is safe.** The object is written first; only once it is durable does
`publishGeneration` advance the registry pointer — a compare-and-swap that never moves backwards. Run the same job
twice and the second load is simply a newer identical generation; run two loads concurrently and the higher number
wins while the other is left as an orphan below the pointer. A publish that finds a newer generation already
current is a no-op rather than an error.

**A crash never moves the pointer.** If the process dies mid-write, the object never completes (every cold driver
commits atomically — a rename, a conditional PUT, a multipart complete) and the pointer still names the previous
generation, which readers keep serving. If it dies between the write and the publish, the object is an orphan the
next `nextGeneration` skips past and `gcOrphanGenerations` collects ([§8](#8-generation-bookkeeping-what-a-load-leaves-behind)).
There is no half-loaded state a reader can observe: a read resolves one generation and reads whole,
checksum-verified chunks from it.

**An empty source writes an empty generation — and publishes it.** That is the correct result for a set that is
genuinely empty, and the wrong one for a warehouse query that returned nothing because it failed upstream. Guard
for that before you load: the library cannot tell the two apart (an empty guard with rollback is the next thing
on the roadmap, as part of a higher-level `load()`).

> **Do not load an empty segment "to create it".** A never-loaded segment already answers `count() → 0`,
> `has(x) → false`, `iterate() → []`; an empty load just costs an object and a registry row you then have to
> retire.

For a generation you already hold as bitmaps, the lower-level `writeCrbmGeneration(driver, key, chunks)` takes
`{ chunkKey, bitmap }` entries directly and does **not** publish — call `publishGeneration(registry, key)` after it.

### A load is a batch job, not a request handler

A load is I/O-heavy — it streams the object to the bucket (S3 multipart past one part) — and CPU-heavy in short
bursts (serializing ~62,000 chunks for a segment spread across the id space). It yields the event loop
periodically so it is a well-behaved neighbour, and its memory is bounded, but it still burns a core for a
fraction of a second and holds a whole generation in RAM. Run it from a job runner, a queue consumer, a scheduled
task or a short-lived container — the process that produced the set is usually the right one — and keep the
request path for what it is good at: `has`, `count`, `intersect`.

## 4. Cold on S3 (or any S3-compatible store)

The S3 cold driver lives at the **`@cloudbitmaps/roaring/s3`** subpath, so the AWS SDK is an **optional peer
dependency** — install it only when you use S3 (`npm i @aws-sdk/client-s3`); the main entry never pulls it.
You inject your own `S3Client`, so the driver works against AWS S3, MinIO, or any compatible backend just by
how you configure the client:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { CloudRoaring, bulkLoadCrbmGeneration, nextGeneration } from '@cloudbitmaps/roaring';
import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';

const client = new S3Client({ region: 'us-east-1' }); // or { endpoint, forcePathStyle: true } for MinIO
const cold = new S3ColdDriver({ client, bucket: 'my-bitmaps', prefix: 'cloudroaring' });
const registry = new S3RegistryDriver({ client, bucket: 'my-bitmaps', prefix: 'cloudroaring' }); // same bucket

// Load a generation straight to S3, then read it through the engine:
const ref = { segment: 'active-this-week' };
await bulkLoadCrbmGeneration(cold, { ...ref, generation: await nextGeneration(ref, { cold, registry }) }, ids, {
  registry,
});
const store = new CloudRoaring({ cold, registry }); // raw S3 driver, wrapped for you
await store.segment('active-this-week').count(); // read from the .crbm index on S3 — no payload GET
```

It's the same `IColdDriver` contract as the local-filesystem driver (it passes the identical conformance
suite), so everything above — reads, `count`, `iterate`, `intersect`, generation pinning — works unchanged.
Generations are **write-once** (a conditional `If-None-Match:*` PUT; requires a backend that honors it — AWS
S3 or recent MinIO). Large objects upload via **S3 multipart automatically** — write memory stays
~one part (default 8 MiB); the object ceiling defaults to ≈80 GiB and grows via `partBytes` / `maxObjectBytes`
up to S3's 5 TiB max, with write-once preserved (conditional `CompleteMultipartUpload`).

## 5. The segment registry (resolving the current generation)

Each segment is a series of immutable, generation-numbered `.crbm` objects; reads need to know **which
generation is current**. Without a registry, the store finds it by *listing* every generation and taking the
max — one storage scan per segment, cleartext only, and read-only. The **registry** replaces that with a single
authoritative record (`currentGen`) read once, and it is what every write publishes through:

```ts
import {
  CloudRoaring,
  bulkLoadCrbmGeneration,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
} from '@cloudbitmaps/roaring';

const cold = new LocalFsColdDriver('./.cloudbitmaps/cold');
const registry = new LocalFsRegistryDriver('./.cloudbitmaps/registry');

// Load a generation AND publish it to the registry in one call:
await bulkLoadCrbmGeneration(cold, { segment: 'active', generation: 0 }, [1, 2, 3], { registry });

// Pass the raw driver + registry — the store resolves currentGen via the registry (no list-scan):
const store = new CloudRoaring({ cold, registry });
await store.segment('active').count(); // → 3, generation resolved from the registry
```

**Read staleness after a publish is bounded.** With a registry wired, a long-running store re-resolves each
segment's current generation on a short TTL (`coldGenTtlMs`, default **2000 ms**), so reads are **bounded
eventually-consistent**: after a load publishes a new generation, a reader may serve the prior one for up to the
TTL, then converges — no restart needed. Tune it down for fresher reads, up to trade a little staleness for fewer
registry reads (`0` pins the first generation resolved for the store's lifetime). The hot cache is keyed by
generation, so a new generation is never served from stale decoded chunks. Within one read op — one `count`, one
`intersect` — the generation is resolved **once** and every chunk comes from it, so a load landing mid-call cannot
tear the result. Without a registry the generation is pinned for the source's lifetime (single-process/local use).

**Registry backends** — `registry` is a pluggable seam (`IRegistryDriver`), independent of your cold choice; pick
per deployment:

| Backend | Import | Use for |
| --- | --- | --- |
| `MemoryRegistryDriver` | `@cloudbitmaps/roaring` | tests / dev |
| `LocalFsRegistryDriver` | `@cloudbitmaps/roaring` | single node / on-prem |
| `S3RegistryDriver` | `@cloudbitmaps/roaring/s3` | **the same bucket as your cold data — one store, no second service** |
| `DynamoDbRegistryDriver` | `@cloudbitmaps/roaring/dynamodb` | many segments republished often (single-digit-ms pointer swaps vs an S3 GET+PUT); GCS / Azure cold |

The **`S3RegistryDriver`** keeps the current-generation pointer as a tiny object in the *same bucket* as your
Cold data, using S3's conditional writes (`If-Match`) for the atomic generation swap — so a deployment runs on
**S3 only**:

```ts
import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';

const cold = new S3ColdDriver({ client: s3, bucket: 'my-bitmaps' });
const registry = new S3RegistryDriver({ client: s3, bucket: 'my-bitmaps' }); // same bucket, no DynamoDB
const store = new CloudRoaring({ cold, registry });
```

> **S3 registry requirements:** the bucket backend must honor `If-Match` conditional writes (AWS S3; recent
> MinIO), the IAM principal needs **`s3:ListBucket`** (else a missing key returns `403` not `404`, and
> discovery can't list), and **don't put a lifecycle-expiration rule on the `registry/` prefix** (deleted rows are
> tombstoned for the pointer's ABA-safety). DynamoDB is the better fit when pointers move very frequently.

The **DynamoDB** registry is one item per segment in a single table (`PK = ns#…|seg#…`, `SK = reg#`) you provision
once with a `(PK, SK)` string key schema; an optional `keyPrefix` lets several logical stores share one table, and
DynamoDB-Local works for development:

```ts
import { DynamoDbRegistryDriver } from '@cloudbitmaps/roaring/dynamodb';
const registry = new DynamoDbRegistryDriver({ client: dynamo, tableName: 'cloudbitmaps' });
```

> **One lifecycle rule you should add:** **`AbortIncompleteMultipartUpload`**, on the bucket holding cold
> objects (a few days is plenty). A large generation is written as a multipart upload; the library aborts it on
> any error it survives to handle, but it cannot abort one whose process no longer exists — a killed container
> or an OOM leaves the parts behind. Those parts are **billed and invisible**: they never appear in an object
> listing, so nothing but the bill will tell you. This is the one case where cost can accumulate quietly, which
> matters more here than it would elsewhere, because a low idle bill is the point of the library.

The record also carries `status` (`active`, or the `destroyed` tombstone a crypto-shred or drop leaves), the
wrapped data-key(s) of an encrypted segment (§9), and the `retention` policy (§13.5). `currentGen` can be
**`null`** — a row `setRetention` minted before the first load — which reads exactly like a segment with no row
and takes the first publish. To publish a generation you wrote yourself, call
`publishGeneration(registry, { segment, generation })` (forward-only — it never regresses the pointer).

## Production wiring for the cloud drivers

§4–§5 wired S3 and the two cloud registries. The two remaining cloud **cold** drivers — GCS and Azure Blob —
follow the same shape: construct your own client, hand it to the driver. Both are **cold-only** (no registry): pair
them with an S3 or DynamoDB registry (see [Choosing a registry](#choosing-a-registry)).

### GCS cold (`@cloudbitmaps/roaring/gcs`)

```ts
import { Storage } from '@google-cloud/storage';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { GcsColdDriver } from '@cloudbitmaps/roaring/gcs';

const storage = new Storage(); // ADC; or { apiEndpoint } to point at fake-gcs-server locally
const cold = new GcsColdDriver({ storage, bucket: 'my-bitmaps', prefix: 'cloudroaring' });
const store = new CloudRoaring({ cold, registry }); // registry: S3 or DynamoDB, per §5
```

> **Checklist.** Peer `@google-cloud/storage`; generations are write-once via `ifGenerationMatch: 0` (both the
> simple and resumable upload paths). GCS ships **no registry** — pair with an S3 or DynamoDB registry.

### Azure Blob cold (`@cloudbitmaps/roaring/azure`)

```ts
import { BlobServiceClient } from '@azure/storage-blob';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { AzureBlobColdDriver } from '@cloudbitmaps/roaring/azure';

const containerClient = BlobServiceClient.fromConnectionString(process.env.AZURE_CONN)
  .getContainerClient('bitmaps');
const cold = new AzureBlobColdDriver({ containerClient, prefix: 'cloudroaring' });
const store = new CloudRoaring({ cold, registry }); // registry: S3 or DynamoDB, per §5
```

> **Checklist.** Peer `@azure/storage-blob`; inject a container-scoped `ContainerClient`; generations are
> write-once via `If-None-Match: '*'`. Azure ships **no registry** — pair with an S3 or DynamoDB registry.

Per-backend DR/backup guidance (RPO/RTO, point-in-time recovery, what to snapshot) lives in the
[disaster-recovery runbook](disaster-recovery.md).

## 6. Reliability: retries, backoff & timeouts

Cloud storage throttles, returns 5xx, and drops connections. CloudBitmaps handles that for you: **every cold
read automatically retries transient faults** (throttling, 5xx, dropped connections, request timeouts) with
bounded exponential backoff + full jitter. It's **on by default** — you don't have to do anything:

```ts
const store = new CloudRoaring({ cold, registry }); // retries already enabled
```

Tune it, or turn it off, per store:

```ts
const store = new CloudRoaring({
  cold,
  registry,
  // Tune the policy (these are the defaults):
  retry: { maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 2_000, backoffFactor: 2, jitter: 'full' },
  // …or `retry: false` to disable our wrappers entirely (e.g. your client already retries).
  onRetry: ({ attempt, delayMs, err }) => log.warn({ attempt, delayMs }, 'retrying transient fault'),
});
```

**What's retried vs not.** Only **transient** infrastructure faults are retried — surfaced as
`TransientError` (with `TimeoutError` a subclass). Deterministic errors are **never** retried (retrying them
can't help or would be wrong): `ValidationError` (bad input), `IntegrityError` (corrupt bytes),
`NotFoundError`, and `WriteConflictError` (a write-once generation number was reused, or the registry pointer
was contended past its own re-read-and-retry loop).

**Set a timeout on your client.** CloudBitmaps intentionally has no homegrown timeout (it would abandon
in-flight requests). Instead, give your injected S3/DynamoDB client a request timeout — the resulting timeout
is treated as transient and retried:

```ts
import { NodeHttpHandler } from '@smithy/node-http-handler';
const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ requestTimeout: 3_000, connectionTimeout: 1_000 }),
});
```

**Your data is safe across a retry.** Generations are write-once (no half-written object a reader could pick
up); the publish is a compare-and-swap that is idempotent and forward-only (a retried publish can never regress
the pointer or double-apply); and all bytes are checksum-verified before use. So a transient outage costs you
latency, not correctness. The lifecycle helpers (`eraseSubject`, `dropSegment`, `retireExpired`, …) run over the
raw drivers **without** the retry wrapper on purpose — a one-shot admin operation surfaces a transient fault to
its caller (as a ledger entry or a throw) rather than retrying under the hood.

> Writing your own driver? Throw `TransientError` for your backend's retryable faults and the shared retry
> layer handles the rest — or wrap any driver yourself with `RetryingColdChunkSource` / `RetryingColdDriver` /
> `RetryingRegistryDriver`. The low-level `withRetry(op, policy, { clock, rng })` primitive is exported too.

## 7. Materializing: the `*Into` verbs

The three combines each have a materializing twin — `intersectInto`, `unionInto`, `andNotInto` — that writes the
result as a **new generation of a destination segment** instead of streaming it to you:

```ts
const shoppers = store.segment('high-value-shoppers');
const active = store.segment('active-this-week');
const optedOut = store.segment('global-opt-out');

const res = await shoppers.intersectInto(store.segment('campaign-targets'), [active], {
  exclude: [optedOut],
});
res; // { generation, cardinality, chunkCount, size } — what was written
```

Three properties, all consequences of "a write is a load":

- **The destination is superseded, not added to.** `campaign-targets` now holds exactly this result; whatever it
  held before is the previous generation. Re-running a window into the same target each day is therefore correct
  — each run is a fresh generation — and there is no accumulating-window hazard.
- **Readers of the destination see the old generation or the new one, never a partial.** The result streams into
  one immutable object under a bounded memory window (`concurrency × operands × chunk`), and the pointer moves
  only once the object is durable.
- **It deletes nothing.** The destination's previous generation stays in the bucket until you collect it — see
  [§8](#8-generation-bookkeeping-what-a-load-leaves-behind).

An empty result publishes an empty generation. The verbs need the store built with a raw cold driver **and** a
registry (they publish through it) and throw `UnsupportedError` otherwise. To suppress the result of an
intersection, pass `exclude` to `intersectInto` rather than materializing a temp segment and then `andNotInto` —
the suppression folds into the same chunk-aligned pass and each exclude is read only where the intersection
survived.

## 8. Generation bookkeeping: what a load leaves behind

Cold objects are immutable and generation-keyed, so **every load, every `*Into`, every erasure rewrite leaves its
predecessor in the bucket**, still billed. Reads are unaffected — the pointer always names a live object — so the
only symptom of never collecting them is a storage bill that never goes down. Something has to delete them, and
in a library with no background process that something is a call you make:

```ts
import { gcOrphanGenerations } from '@cloudbitmaps/roaring';

// After a successful load: delete every generation below the current one, keeping the newest 1 as a grace window.
const deleted = await gcOrphanGenerations(ref, { cold, registry }, { keep: 1 });
```

What it does, precisely: deletes generations **strictly below `currentGen`**, keeping the most recent `keep` of
them (default `1`) so a read still fetching from the just-superseded generation need not re-resolve mid-call —
a window, not a lock, and [sized below](#sizing-keep). It never touches
the current generation or anything above it (a load that is mid-write), and it deletes nothing while
`currentGen` is `null` — an object under a pointer-less row is either a load about to publish or an orphan, and
the two cannot be told apart safely. The one exception: on a `destroyed` segment (a drop or crypto-shred tombstone)
**every** generation is garbage and all are collected, because no reader can resolve a tombstoned segment.

Who calls it today:

| Path | Collects? |
|---|---|
| your load job, after `bulkLoadCrbmGeneration` or an `*Into` | **you** — call `gcOrphanGenerations` on your own cadence (right after the load, or a nightly pass) |
| `eraseSubject` / `eraseIdFromSegment` | **yes**, with `keep: 0` — the whole point is that the generation holding the bit does not survive the call |
| `retireExpired` | **yes**, for tombstoned segments only — it collects a straggler generation before purging the tombstone row |
| `dropSegment` | deletes every generation of the segment it drops (and reports any it could not in `generationsRemaining`) |

**Read staleness, restated for the whole picture.** With a registry and a clock, a store notices a new
generation within `coldGenTtlMs` (default 2 s) and its hot cache is keyed by generation, so it never serves a
stale decoded chunk for a new generation. A `count()` is a single index read, so it is always internally
consistent. A **long** call is the one shape where the generation can move underneath you — a resolved snapshot
is re-checked once the TTL elapses, and the reader cache can evict an operand mid-call and force a fresh
resolve even sooner — so a long `intersect` across a publish may read its later chunks from the newer
generation: every chunk whole, immutable and checksum-verified, never torn, but the answer describing two
instants rather than one, with nothing in the result saying so. That is what a snapshot handle is for, and it
is [on the way to 1.0](../ROADMAP.md#on-the-way-to-10) rather than shipped.

### Sizing `keep`

`keep` is a **grace window**: a read fetches from the generation its snapshot names, and `keep` decides how
many publishes can land underneath before that object is gone. Three facts size it.

**A miss is a re-read, not a failure.** If the generation a read is on is swept, the Cold driver throws
`NotFoundError`; the cold source drops the stale snapshot, re-resolves `currentGen` and retries **once** —
covering both the fetch and the reopen, which are separate round trips and separately exposed. The call then
serves the newer, committed generation: a monotonic move forward, never a torn object. A second miss is
pathological (GC outrunning resolution) and propagates rather than fabricating an absent answer; the one case
that answers empty instead of throwing is a segment with no generation left to serve at all — dropped or
crypto-shredded, where reading empty is the documented outcome.

**The exposure window is the TTL, not the length of your call.** A snapshot is re-checked every
`coldGenTtlMs`, so at most `ceil(coldGenTtlMs ÷ gap between publishes)` publishes can land under any snapshot a
read actually uses — **one**, at the 2 s default, against any realistic publish cadence. A sixty-second
`intersect` does not need a sixty-second window. The exception is a source that never re-resolves — no clock
injected, no registry, or `coldGenTtlMs: 0` ("pin forever") — which holds one generation for its whole
lifetime; there no finite `keep` covers it, and the re-read above is the mechanism that keeps it correct.

**Each retained generation is a whole copy of the segment, billed.** `keep: 3` over a 40 GB segment holds
160 GB of object storage, not 40. That is the cost of a wide window, and the reason the default is `1`.

Which gives:

| your situation | `keep` |
|---|---|
| anything on a normal TTL — the common case | **`1`**, the default |
| publishes landing faster than `coldGenTtlMs` (a tight loader, or a raised TTL) | cover them: `ceil(coldGenTtlMs ÷ gap between publishes)` |
| a large segment where a rare re-read is cheaper than a second copy | `0` |
| a long job that must see **one** instant, not merely succeed | none of the above — see below |

**What no value of `keep` gives you is a single instant.** The generation hop above is caused by
*re-resolution*, not by collection: a read whose TTL elapses moves to the newer generation whether or not the
old one still exists. Retaining more copies changes nothing about it. A job that needs one instant (an export,
a reconciliation, a send that must match the count you reported) needs a snapshot handle.

There is deliberately **no time-based floor** on collection ("keep nothing younger than 24 h"). It would read
as a durability guarantee and would not be one: an ordinary read is already covered by the retry above, and a
job that must not change generations needs the snapshot handle, not a window wide enough to hope with. See
[Deliberately not planned](../ROADMAP.md#deliberately-not-planned).

## 9. Encryption at rest + crypto-shred

Encrypt the Cold `.crbm` objects so a leaked bucket reveals **neither ids nor cardinality** (payloads *and* the
chunk index are encrypted; the object's segment name + generation are still visible in its key, and its byte
size still implies a rough upper bound on size — no padding), and support **crypto-shred** — GDPR "right to
erasure" that works even on immutable/backed-up storage. Encryption is **opt-in**: pass a *keystore* and it's
on; omit it and everything stays cleartext.

You hold one root key — a **KEK** (32 bytes) — and bring it yourself (BYOK); there's **no required cloud
dependency**. Each segment gets its own random **DEK** that's wrapped under your KEK and stored in the registry;
the Cold chunks + index are AES-256-GCM-encrypted with the DEK, under an AAD bound to `(segment, generation)`.

```ts
import { CloudRoaring, InProcessKeystore, bulkLoadCrbmGeneration } from '@cloudbitmaps/roaring';
import { LocalFsColdDriver, LocalFsRegistryDriver } from '@cloudbitmaps/roaring';

// Your KEK(s) — load from your secrets manager; keyId-aware so you can rotate without re-encrypting data.
const keystore = new InProcessKeystore({
  keys: { '2026-06': loadKekFromSecrets() }, // each value is a 32-byte Uint8Array
  activeKeyId: '2026-06',
  // recoveryKeyId: 'offline-escrow',         // optional: also wrap under an offline recovery KEK
});

const cold = new LocalFsColdDriver('./.cloudroaring/cold');
const registry = new LocalFsRegistryDriver('./.cloudroaring/registry');

// Load encrypted (the DEK is minted + wrapped into the registry on the first publish; later loads reuse it):
await bulkLoadCrbmGeneration(cold, { segment: 'pii', generation: 0 }, ids, { registry, keystore });

// Read encrypted — pass the raw driver + registry + keystore; the store unwraps the DEK and decrypts transparently:
const store = new CloudRoaring({ cold, registry, keystore });
await store.segment('pii').count(); // works; without the keystore this throws KeyUnavailableError
```

Every later write to that segment reuses its DEK: a reload through `bulkLoadCrbmGeneration` (pass the keystore —
loading a cleartext generation onto an encrypted segment is refused with `KeyUnavailableError`, because that
would let a later crypto-shred over-attest), an `*Into` verb on a store wired with the keystore, and the erasure
rewrite. To enforce encryption everywhere, set `requireEncryption: true` (on the store config, on
`bulkLoadCrbmGeneration`, and on `eraseIdFromSegment`'s deps) — any cleartext write/read then throws.

**A segment's encryption is decided at its first generation, and cannot be switched later.** Wiring a keystore
does not retroactively encrypt a segment that already has a cleartext generation: that load stays cleartext, and
with `requireEncryption: true` it is refused with a `ValidationError` rather than silently downgraded. The reason
is that one segment cannot be half-encrypted — a reader pinned to a superseded cleartext generation would find
bytes its key cannot open, and `destroySegment` would attest that shredding one DEK made every copy unreadable
while the older cleartext objects stay readable from any of them. The same rule from the other side: publishing
an encrypted generation onto a segment whose row carries no key material is refused, because the only two silent
outcomes are an unreadable generation or an over-attesting audit trail.

So **to encrypt data that is already stored, load it into a new segment with the keystore wired and drop the old
one** (`dropSegment`, or `destroySegment` if the old segment was itself encrypted). This matters because a
keystore is wired on the *store*, so it is in scope for every segment that store touches — including the ones
you meant to leave cleartext.

### Crypto-shred (erase a segment / namespace)

```ts
import { destroySegment, eraseNamespace } from '@cloudbitmaps/roaring';

// Irreversible — you must name the exact segment as confirmation:
await destroySegment({ segment: 'pii' }, { registry }, { confirmSegment: 'pii' });
// or a whole namespace:
await eraseNamespace('tenant-42', { registry }, { confirmNamespace: 'tenant-42' });
```

This deletes the segment's wrapped DEK from the registry (a `destroyed` tombstone). The encrypted Cold objects
are left in place — but with the key gone they're **permanently unreadable, everywhere, including backups**. The
segment then reads as empty, and the tombstone is a fence: `bulkLoadCrbmGeneration` and `publishGeneration`
refuse a destroyed segment, so a load racing an erasure cannot resurrect it. To also reclaim the storage, use
`dropSegment` ([§13.5](#135-retention-ttl-and-pruning--what-exists-and-what-doesnt)), which crypto-shreds an
encrypted segment *and* deletes its objects.

### ⚠️ Read this before you turn on encryption — key management

- **The KEK is the one thing to back up.** It's 32 bytes — store it in your secrets manager (Vault, AWS Secrets
  Manager, 1Password, an HSM) with versioning, exactly like a database password. The encrypted data and the
  wrapped DEKs are useless without it.
- **If you lose every KEK for a segment, its at-rest bytes are gone — by design.** There is no backdoor (that's
  the whole point — a leaked bucket has no backdoor either). This is also what makes crypto-shred *work*.
- **But it's usually not catastrophic:** CloudBitmaps segments are almost always **derived data** (audience /
  membership sets built from your primary datastore), so a lost KEK means **reload the segment from source**
  (`bulkLoadCrbmGeneration`), not permanent business-data loss.
- **Rotate, don't lose.** Add a new KEK, point `activeKeyId` at it, and **keep the old KEK** — old segments keep
  decrypting with no data re-encryption. Use a **recovery KEK** (kept offline) so losing the active one isn't
  fatal.
- **KMS/Vault later.** The default is dependency-free in-process BYOK; the `IKeystore` interface lets a
  KMS/Vault adapter drop in later (a future phase) — encryption never forces a cloud dependency on you.

## 10. Observability: metrics

CloudBitmaps can report what it's doing — cold GETs and bytes, cache hit rate, retries, intersection efficiency,
and op latency — through an optional **metrics sink**. It's **off by default** (a no-op — emission is skipped
entirely when unused); pass one and the library pushes typed events to it:

```ts
import { CloudRoaring, CountingMetricsSink } from '@cloudbitmaps/roaring';

const metrics = new CountingMetricsSink(); // a ready-made tally sink
const store = new CloudRoaring({ cold, registry, metrics });

await store.segment('users').has(42);
console.log(metrics.snapshot());
// { cold: { gets, bytes, totalMs }, cache: { hits, misses }, retries: { transient },
//   intersect: { calls, fetchedChunks, skippedChunks }, ops: { has, count, intersectInto, unionInto, andNotInto } }
```

The library emits **vendor-neutral events** — five kinds — so it isn't coupled to any telemetry system; you map
the handful you care about:

| Event | Carries | Fired |
| --- | --- | --- |
| `cold.get` | `segment`, `namespace?`, `bytes`, `ms` | one chunk read from Cold (a hot-cache miss) |
| `cache` | `hit` | every hot-cache lookup |
| `retry` | `reason: 'transient'`, `attempt`, `delayMs` | before each transient-retry backoff wait |
| `intersect` | `op` (`intersect` / `union` / `andNot`), `operands`, `fetchedChunks`, `skippedChunks` | per combine — `skippedChunks` is the chunk-skipping saving (distinct keys never fetched) |
| `op` | `name` (`has` / `count` / `intersectInto` / `unionInto` / `andNotInto`), `ms` | per timed segment op |

A quick look in dev is one line:

```ts
const store = new CloudRoaring({ cold, registry, metrics: { onEvent: (e) => console.log(e) } });
```

**OpenTelemetry** (or Datadog, CloudWatch, …) is a ~12-line adapter you write — CloudBitmaps adds no telemetry
dependency of its own:

```ts
import { metrics as otel } from '@opentelemetry/api';
const meter = otel.getMeter('cloud-roaring');
const coldBytes = meter.createCounter('cloudroaring.cold.bytes');
const cacheHits = meter.createCounter('cloudroaring.cache.hits');

const store = new CloudRoaring({
  cold,
  registry,
  metrics: {
    onEvent(e) {
      if (e.kind === 'cold.get') coldBytes.add(e.bytes); // NB: see the label caveat below
      if (e.kind === 'cache' && e.hit) cacheHits.add(1);
      // …map the events you want to chart
    },
  },
});
```

Events carry **raw observations** (bytes, counts, ms); turning those into dollars is the cost estimator's job
(see [§11 below](#11-cost-estimate-it-then-ground-it)). Two things to keep in mind:

- **`onEvent` runs synchronously on the I/O path** — keep it cheap and non-blocking; offload batching or
  network calls to your own async queue.
- **`segment` / `namespace` are your own strings** — they may be PII and are unbounded-cardinality. Don't map
  them to per-series metric labels/tags unless your names are known low-cardinality and PII-free (aggregate,
  bucket, or scrub inside the sink instead). Events never contain bitmap contents or ids — only names, counts,
  bytes, and timings.

A sink that throws can never break a read — its exceptions are swallowed (best-effort).

## 11. Cost: estimate it, then ground it

CloudBitmaps can tell you what a workload *will* cost — and, uniquely, what your **real** segments *are*
costing — because the library owns the storage + cache, so it can ground estimates no external calculator can.
The model has four terms and no per-id write: object-store **GETs** for point reads and for intersection chunk
fetches, object-store **PUTs** for loads, and **storage**.

**Planning** (pure, no instance needed — sizing, sales, what-if):

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';

const report = CloudRoaring.estimateCost({
  segments: [{ sizeBytes: 1.2e9 }], // or { cardinality } / { count }
  workload: {
    readsPerSec: 200, // point reads; each cache miss is one GET
    cacheHitRate: 0.8, // hits are free
    intersectsPerSec: 1,
    chunksPerIntersect: 10, // the chunk-skipping survivors
    loadsPerMonth: 30, // one refresh a day…
    requestsPerLoad: 3, // …as a small multipart upload
  },
});
report.monthlyUSD.byOp; // { reads: ≈42, intersects: ≈10.5, storage: ≈0.03, loads: ≈0.0005 }
report.monthlyUSD.total; // ≈ 53 — vs $346 flat Redis-HA
report.verdict; // 'win' — 'win-big' | 'win' | 'lose-zone', never hides the lose case
report.redisCrossover.readsPerSec; // ≈ 1,646 sustained reads/s at THIS report's 80% cache-hit rate (≈ 329 at 0%)
```

**Grounded** (real sizes from the `.crbm` index — exact, no payload reads):

```ts
const report = await store.segment('active-us').costReport({
  workload: { readsPerSec: 200, cacheHitRate: 0.8 },
});
report.assumptions.grounded; // true — storage is this segment's real, measured size
```

Rates are a pluggable `PricingProfile` — `{ name, cold: { getPerMillion, putPerMillion, storagePerGiBMonth },
redis: { monthlyUSD } }`, default `aws-us-east-1-ondemand` from the fact-checked published pricing; override it
for your region/cloud. The report is honest: `verdict` always includes the lose-zone, and `assumptions.notes`
lists the model's simplifications (same-region egress free; request cost from your supplied workload rates —
deriving it from live metrics is a later refinement; and, when you leave `loadsPerMonth` unset, that **loads are
not modeled** — disclosed rather than silently under-counted).

### The read crossover

`redisCrossover.readsPerSec` is the sustained point-read rate at which pay-per-use GETs alone cost more than the
flat always-on baseline. It is not a ceiling on the library — it is a property of two inputs:

| Input | Default | Change it and |
| --- | --- | --- |
| `cacheHitRate` | `0` | Every read is billed. A working hot cache moves the crossover by the reciprocal of the miss rate — 80% hits is 5× the reads for the same bill; 100% is `Infinity` (it never crosses). |
| `pricing.cold.getPerMillion` | `$0.40` | Your region's or your committed rate; the formula is the spec, the rate is yours. |

Loads are cheap by construction: at $5/million PUT-class requests, a thousand 100-part multipart loads a month is
about $0.51. The term exists so the report can say so rather than assume it.

**See it plotted.** The [benchmarks page](../benchmarks.md) charts exactly where pay-per-use beats a flat
Redis-HA node — drawn from this same `estimateCost()` and turned into build-breaking CI assertions, so the
numbers can never drift ahead of reality.

## 12. Audit trail: security & compliance events

Separate from metrics — which reports *volume* (bytes, latency, hit rate) — the **audit sink** records the
handful of **compliance-relevant state changes** an auditor cares about: when a segment's data was published,
**rewritten**, or **erased**. It's the natural feed for an append-only audit log / SIEM, and doubles as your
GDPR Art. 30 "record of processing" for the erasure path. Like metrics, it's an injected `IAuditSink`, it's
**off by default** (a no-op), and a throwing sink can never break the operation it observes.

Unlike metrics, audit isn't a store-constructor option — the events fire from the **operations that write**
(a load, an `*Into` materialisation, an erasure, a drop, the retention sweep), which are separate entry points,
so you pass `audit` to each:

```ts
import { RecordingAuditSink, bulkLoadCrbmGeneration, destroySegment } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink(); // a ready-made in-memory recorder (or bring your own onEvent)

// A generation is published (the segment is encrypted — a keystore is wired, see §9):
await bulkLoadCrbmGeneration(cold, { segment: 'users', generation: 0 }, ids, { registry, keystore, audit });
// A subject erasure — a rewrite of the current generation without one id:
await store.eraseSubject(userId, { namespace: 'eu', audit });
// A GDPR crypto-shred — the key wrappings are dropped:
await destroySegment({ segment: 'users' }, { registry }, { confirmSegment: 'users', audit });

audit.snapshot();
// [ { kind: 'segment.publish', segment: 'users', generation: 0 },
//   { kind: 'segment.rewrite', namespace: 'eu', segment: '…', fromGeneration: 4, generation: 5 },
//   { kind: 'segment.erase',   segment: 'users' } ]
// (segment.erase fires only for an ENCRYPTED segment — a cleartext tombstone leaves the bytes readable.)
```

The events are **vendor-neutral** — five kinds, all carrying the segment/namespace name:

| Event | Fired when | Extra fields |
| --- | --- | --- |
| `segment.publish` | a load makes a generation the current one (needs a `registry`; not on a forward-only no-op) | `generation` |
| `segment.rewrite` | a generation derived from the segment itself became current in place of `fromGeneration` — today, an erasure rewrite (`eraseSubject` / `eraseIdFromSegment`), emitted at the publish, before the superseded generation is collected | `fromGeneration`, `generation` |
| `segment.erase` | a **genuine crypto-shred** — not the idempotent re-run, and not a cleartext tombstone (bytes stay readable) | — |
| `segment.dispose` | `dropSegment` tombstoned a segment and swept its storage — the weaker, storage-reclamation attestation; an encrypted drop emits **both** this and `segment.erase` | `generationsDeleted` |
| `namespace.erase` | `eraseNamespace` runs; also one `segment.erase` per segment actually shredded | `segmentsShredded` |

Same two caveats as metrics apply: **`onEvent` runs synchronously** on the operation (keep it cheap; offload
network writes to your own queue), and **`segment`/`namespace` are your own strings** — treat them as
potentially-PII when you forward them. Events never contain ids or bitmap contents.

> **Not yet emitted — KEK rotation.** Rotating the key-encryption key here is *operator-side keystore
> reconfiguration* (wrappings are key-id-tagged and need no data re-encryption), so there's no library call to
> hook a `kek.rotate` event onto. Audit key changes at your keystore/KMS layer; a future per-segment
> `rewrapSegment()` op would add a library-side rotation event.

For a worked example that routes metrics, cost, and audit to real dashboards, see the
[dashboards guide](./dashboards.md).

## 13. Subject access & erasure (GDPR Art. 15 / 17)

Two admin helpers answer "what do you hold about this person?" and "forget this person everywhere." Both scan
the **registered** segments (no reverse index — nothing taxes the hot path), so they're complete over what's
registered — every loaded segment has a row, so wire the registry the loads used — and cost `O(registered
segments)` per call. The scan fans out at a **bounded `concurrency`** (default 8; pass `{ concurrency }`) —
parallel enough to stay quick over a large fleet, bounded so it can't stampede your backend; `eraseSubject`
isolates a per-segment fault so one bad segment never aborts the ledger.

**Scope is explicit.** Ids live in one **global u32 space shared across namespaces**, so a namespace-less call is
a *fleet-wide* sweep over every tenant. To keep that from being the accidental default, both helpers require
either a `namespace` (scope to one tenant) **or** an explicit `{ allNamespaces: true }` acknowledgement — a call
with neither throws `ValidationError`.

```ts
// Art. 15 — which segments is this id in? (scope to one tenant)
const report = await store.subjectReport(userId, { namespace: 'eu' });
report.segments; // [{ segment, namespace }, …]   report.scannedSegments — the completeness denominator

// Art. 17 — remove the id everywhere, across all tenants (explicit fleet-wide ack)
const ledger = await store.eraseSubject(userId, { allNamespaces: true, audit });
ledger.erasedFrom; // [{ segment, namespace, erased: true, fromGeneration: 4, generation: 5 }, …]
```

**An erasure is a rewrite.** There is no per-id delete on an immutable object and no mutable tier to hold a
tombstone, so `eraseSubject` does what every other write in the library does: for each registered segment the id
is a member of, it streams the current generation through — every chunk copied, the one chunk holding the id
re-encoded with that bit cleared — verifies the new object, publishes it **fenced on the generation it streamed**, and then **deletes the
generation that held the bit** (`gcOrphanGenerations` with `keep: 0`). The bit is physically gone from the
bucket when the call returns, constant memory, one chunk in flight. Segments the id is not in are not listed.

Both helpers **reuse the store's own drivers** — no `registry`/deps to re-pass. `eraseSubject` needs the store
built with a raw cold driver + a `registry` (it writes generations); `subjectReport` needs only a `registry` (it
just enumerates + `has()`). A store missing what a helper needs throws `UnsupportedError` — a
pre-built-`ColdChunkSource` store can't run `eraseSubject`; use the `eraseIdFromSegment(ref, id, { cold, registry,
keystore? })` free function out-of-process instead. The returned `erasedFrom` list is your **erasure ledger**
(proof of deletion) — a return value only, so persist it or route it to your audit sink (a `segment.rewrite` event
is also emitted per rewrite when you pass `audit`).

**An `erased: false` entry means the id is still there**, and `note` says why:

- `'superseded'` — a load published a newer generation of that segment while the rewrite was in flight; the
  rewrite was written but not made current: the pointer moved off the generation it was derived from before
  the publish landed, so the fence refused it. Re-run against the new generation.
- `` `error: <message>` `` — an isolated per-segment fault. Three causes worth telling apart: a transient cold
  fault (re-run), a missing keystore for an encrypted segment (wire it), and an `IntegrityError` naming a chunk
  whose values are out of range — that segment is **corrupt**, the rewrite refused to copy the corruption into a
  new generation, and no erasure happened on it. The third needs investigating rather than re-running.

Re-running is safe and idempotent: a segment the id is no longer in is simply not listed. **One contract the
library cannot check: do not load the segment while erasing from it.** A load that lands *after* the rewrite
carries whatever its source held, and the library cannot know that source was meant to exclude the id — quiesce
loads of the affected segments for the duration, or fix the source first and load after. A load that lands
*during* the rewrite is caught (`'superseded'`).

**What a rewrite does not reach.** Backups, replicas and noncurrent object versions hold the old object until
their own lifecycle removes it. For an at-rest guarantee that survives those, encrypt and crypto-shred
(`destroySegment` / `eraseNamespace`, §9) — which is per segment: a per-**id** shred is infeasible because one DEK
covers the whole segment. See [`PRIVACY.md`](../../PRIVACY.md).

## 13.5 Retention, TTL and pruning — what exists and what doesn't

**Retention is per segment, and there is no per-`id` TTL.** Two separate statements, and the difference is the
whole shape of this section:

- **A segment can expire.** `store.setRetention(ref, { expiresAt })` records when it becomes eligible for
  retirement, and `store.retireExpired()` is the sweep that acts on it. Both are below.
- **An individual id cannot.** No `expireAfter`, no per-id age. That is a consequence of the data model, not a
  missing feature — a bitmap stores ids, not `(id, timestamp)` pairs — and it is explained next.
- **You schedule the sweep.** The *policy* is configuration; the *heartbeat* is yours, because this library starts
  no background timer (it has to behave identically in a Lambda, an edge isolate and a long-lived server). The
  hosting options are listed under [the sweep](#the-sweep--storeretireexpired).

If you arrived here asking "does it support TTL?", the answer is: **for a segment, yes; for an id, no, by design.**

### Why there is no per-id TTL

A bitmap stores **ids, not `(id, timestamp)` pairs.** Expiring individual ids means keeping a timestamp
per id — 4–8 bytes each — which destroys the compression the whole design exists for. A contiguous range of a
million ids is a few bytes as a Roaring run; the same million with per-id timestamps is megabytes, and worse
than a plain list. So per-id aging isn't deferred work, it's incompatible with the data model.

### The pattern that gives you the same outcome

Put time in the **name** instead of in the data, and let set algebra do the window. Use a **namespace per
family and the date as the segment** — not one long name — and load one bucket per day:

```ts
const bucket = (day: string) => store.segment(day, { namespace: 'active-daily' });

// Load today's bucket — a generation, from wherever today's ids come from.
const ref = { namespace: 'active-daily', segment: today };
await bulkLoadCrbmGeneration(cold, { ...ref, generation: await nextGeneration(ref, { cold, registry }) }, idsSeenToday, {
  registry,
});

// "Active in the last 7 days" — a union over the buckets you still keep.
const [head, ...rest] = last7Days.map(bucket);
for await (const id of head.union(rest)) { /* … */ }

// Retention = dropping whole buckets, not aging bits.
```

> **Names are validated: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`, for both the segment and the namespace.** So
> the tempting `active:2026-08-01` is **rejected** — no colons. Beyond legality, the namespace split is the
> better shape anyway: `registry.list('active-daily')` enumerates exactly that family's buckets, which is the
> list a retention sweep wants, and `eraseNamespace` can retire the whole family at once. One flat
> `active-2026-08-01` is legal too, but then finding "every daily bucket" means string-matching names.

`union` reads every chunk of every operand — it can't skip, and the guide says so in
[the operations table](#the-operations). If a 7-way union per read is too much, materialize the window with
`unionInto` — into a dated target, or into one rolling target; either is correct, because an `*Into` verb
**supersedes** its destination rather than adding to it, so a rolling `active-7d` re-materialized each day holds
exactly that day's window:

```ts
const window = store.segment('active-7d', { namespace: 'windows' });
await days[0].unionInto(window, days.slice(1)); // window's previous generation is superseded, not merged into
```

Loading a bucket a day is the natural shape for a "seen this period" set: today's bucket is a different, empty set
until you load it, and the union is your window. A genuine rolling window — *"seen in the last 4 hours"*, exactly
— is a smaller bucket, loaded more often; there is no per-id write to age individual ids out with.

### Pruning a segment today — and the honest limits

**`store.dropSegment` is the one you want for a rolling window** — or `retireExpired`, which calls it for you once
you have recorded a policy. Four levers exist, and they answer different questions:

| | what it does | when |
|---|---|---|
| **`store.retireExpired({ … })`** | enumerates the registry and retires every segment whose recorded `expiresAt` has passed, **through `dropSegment`**. Bounded, previewable, returns a per-segment ledger. You schedule it | **a policy-driven rolling window** — the usual answer, [below](#the-sweep--storeretireexpired) |
| **`store.dropSegment(ref, { confirmSegment })`** | tombstones the segment, then deletes its Cold generations (re-swept, with any residual reported in `generationsRemaining`). Works on a cleartext segment; on an encrypted one it *also* discards the DEK, so it is a strict superset there. Afterwards the segment **reads as empty** — see the caveat below | **retiring a bucket and reclaiming the storage** |
| `destroySegment(ref, { registry }, { confirmSegment })` | **crypto-shred**: discards the DEK so the Cold bytes are unreadable *everywhere including backups and WORM* — but leaves the objects in your bucket, still billed. **Requires encryption** (no key, nothing to shred) | erasure that must reach immutable copies |
| `gcOrphanGenerations(ref, { cold, registry }, { keep })` | deletes only **superseded** generations, keeping `keep` as a reader grace window | reclaiming what loads leave behind ([§8](#8-generation-bookkeeping-what-a-load-leaves-behind)), not live data |

Deleting an object does not reach a noncurrent version, a cross-region replica, or a PITR snapshot; discarding
the key does. So if your requirement is *"the data must become unreadable"* rather than *"stop paying for it"*,
encryption at rest (§9) is a prerequisite — and `dropSegment` on an encrypted segment gives you both at once.

### Retiring a bucket

`store.dropSegment` needs the store built with a **raw cold driver + a registry** (it has to enumerate and
delete generations, which a pre-built `ColdChunkSource` cannot do) — the same requirement as `eraseSubject` in
§13. Without it you get an `UnsupportedError`.

```ts
// The namespace is part of the identity. Omit it and you address a DIFFERENT segment, and the call is a
// silent no-op returning { dropped: false, reason: 'absent' } — no throw. Check `reason` in a sweep.
const ref = { namespace: 'active-daily', segment: oldDay };

// Look before you leap — reports the generations it WOULD delete, changes nothing.
const preview = await store.dropSegment(ref, { confirmSegment: ref.segment, dryRun: true });
// `wouldDelete` is unbounded — it lists every generation still in Cold, and a segment reloaded daily without a
// `gcOrphanGenerations` pass accumulates them. Log the count and a sample, not the whole array.
const gens = preview.wouldDelete ?? [];
console.log(`would delete ${gens.length} generation(s): ${gens.slice(0, 10).join(', ')}${gens.length > 10 ? ' …' : ''}`);

// Then do it.
const result = await store.dropSegment(ref, { confirmSegment: ref.segment });
// → { dropped: true, generationsDeleted: [0, 1], generationsRemaining: [], cryptoShredded: false }
```

**Reading the result.** Branch on `dropped`; use `reason` to understand *how*:

| `dropped` | `reason` | Meaning |
|---|---|---|
| `true` | `undefined` | An ordinary drop — tombstone written, Cold generations swept |
| `true` | `'already'` | Already tombstoned. **Not** a no-op: it re-sweeps Cold, so it is how a residual in `generationsRemaining` is collected |
| `false` | `'absent'` | **Nothing existed** — no row and no objects. The one case to alert on — usually a mistyped name or an omitted `namespace`, both of which address a *different* segment than you meant |

Then the whole retention job is a loop, and the dangerous part is inside the library — though if the cutoff is a
property of the *segment* rather than of your code, [`setRetention` + `retireExpired`](#recording-the-expiry-on-the-segment-itself)
is this loop with the decision moved to the writer and the bounds, preview and ledger already built:

```ts
for await (const rec of registry.list('active-daily')) {
  if (rec.segment >= cutoffDay) continue;              // ISO dates sort lexicographically
  const ref = { namespace: rec.namespace, segment: rec.segment };
  const res = await store.dropSegment(ref, { confirmSegment: ref.segment });
  // Non-empty means bytes survived — a load that was already writing when the tombstone landed finished its
  // object. The segment reads as empty either way, so this is a billing leak, not a correctness one; re-run
  // to collect it (the retention sweep also will, for a tombstoned segment).
  if (res.generationsRemaining.length > 0) {
    console.warn(`${ref.segment}: ${res.generationsRemaining.length} generation(s) not reclaimed`);
  }
}
```

**`confirmSegment` is a typo guard, not an authorization.** In the loop above the same value appears twice, so
it protects nothing — that is what `dryRun` is for. Run the sweep with `dryRun: true` first and log what it
would take; a retention bug you can read in a log is worth more than one you find in a bucket.

### Why the order inside it matters, and why you should not hand-roll it

`dropSegment` does registry → Cold, and each position is load-bearing:

1. **Registry first.** After the tombstone nothing resolves a generation, so no reader can reach for bytes about
   to disappear — and no writer can publish onto it: `bulkLoadCrbmGeneration` and `publishGeneration` both refuse
   a `destroyed` row, so a load racing the drop cannot resurrect the segment.
2. **Cold second, best-effort, and swept more than once.** Once the pointer is a tombstone the segment reads as
   empty and is *correct*, so a failure part-way through leaks **bytes, not correctness** — and re-running
   collects the remainder. The sweep repeats (up to three passes) because a load that was already writing its
   object when the tombstone landed still finishes the write: its publish is then refused, but the object
   survives and holds the complete set. **Check `generationsRemaining`** — non-empty means bytes are still there
   and the drop should be repeated. The retention sweep also collects them, since `gcOrphanGenerations` takes
   every generation of a tombstoned segment.

Two limits worth knowing before you automate it:

- **A drop is final for the name.** The tombstone fences every later load of that segment (refused with
  `ValidationError`), which is what makes step 2 converge. To reuse a name, let `retireExpired` purge the
  tombstone (below), or use a fresh dated name — which is the pattern anyway.
- **"Reads as empty" needs a clock.** The `coldGenTtlMs` bound applies to a reader whose cold source has a
  clock, a registry, *and* a positive TTL. Built without a clock, or with `coldGenTtlMs: 0` ("pin forever"), a
  reader holds its snapshot for its own lifetime and can answer `true` for a dropped segment indefinitely —
  restart it.

> ⚠️ **The tempting shortcut breaks reads: an object-store lifecycle rule alone.** It deletes the bytes while
> the registry still points at them, which is exactly the state
> [`checkConsistency()`](disaster-recovery.md) reports as **`missing-cold-generation`** — the torn-restore
> failure the DR guide says not to serve traffic on.
>
> **And it presents intermittently.** A read checks the hot LRU before Cold, so cached chunks answer correctly
> while uncached or evicted ones raise `NotFoundError`. It passes a warm-process test and starts failing after a
> restart or a deploy, looking like a transient cloud fault rather than a misconfiguration.
>
> A lifecycle rule is still a fine **backstop** for orphans left by a failed `dropSegment` — just set its
> expiry window comfortably longer than your retention window, so it can never get there first.

### Recording the expiry on the segment itself

The loop above works, and it hard-codes your retention rule in the sweeper: whoever writes the sweep has to know
that `active-daily` keeps 30 days and `dedup-wave` keeps 3. **`store.setRetention` moves that decision to the
writer**, who is the only one who actually knows what the segment means:

```ts
const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: today };

await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // before or after the load — either works
await bulkLoadCrbmGeneration(cold, { ...ref, generation: await nextGeneration(ref, { cold, registry }) }, idsSeenToday, {
  registry,
});
```

That is **one registry write, and nothing else happens.** Nothing is deleted, and no timer starts — the sweep
that acts on the policy is a separate call you schedule (below). Call it once when you create the bucket, not on
every load; it is idempotent, so re-running is harmless, but it is a write.

**Why an absolute instant rather than `retentionDays`.** A duration has to be measured from *something*, and
every anchor the library could use is wrong. `updatedAt` and `currentGen` are both rewritten by every load, so
"expire 30 days after the last write" would push a daily-reloaded bucket's expiry forward on every refresh — the
segment would stay alive precisely *because* it is being kept fresh. The writer computes the instant; the
library stores it verbatim and never moves it.

**It works before the first load.** A segment with no registry row yet gets one (the result says `createdRow:
true`) with **no Cold generation** (`currentGen: null`), so the policy is recorded ahead of the data and the
segment is already enumerable by the sweep; the first load then publishes onto that row. Reads are unaffected —
a pointer-less row resolves exactly like a segment with no row.

Two guards worth knowing:

- **`expiresAt` is epoch-milliseconds**, and a value that looks like epoch *seconds* is rejected rather than
  stored. `Date.now() / 1000 + 30 * 86400` is a natural thing to type and lands in **1970** — already expired —
  so without the check it would not be an error, it would be a deletion on the next sweep.
- **A past instant is legal** and means "eligible on the next sweep". Backfilling a policy onto buckets that
  already exist is a normal migration, and refusing it would make that awkward for no safety gain.

Reading and cancelling:

```ts
await store.getRetention(ref); // → { expiresAt } | null | 'invalid'
await store.clearRetention(ref); // → true if a policy was actually removed
```

`getRetention` returns the string `'invalid'` for a row whose `expiresAt` is present but unusable — a
hand-edited row, or one restored from a different schema. That is deliberately not folded into `null`: a
malformed policy reading as "never expires" on a segment someone believes is expiring is exactly the kind of
silence that costs a compliance commitment. And cancelling is its **own verb**, because "never expire" passed
into the setter as a magic value is how a typo becomes a deletion.

### The sweep — `store.retireExpired()`

A policy is inert until something acts on it. `retireExpired` enumerates the registry, selects the segments whose
`expiresAt` has passed, and retires each one **through `dropSegment`** — so the registry → Cold ordering, the
re-sweep for an object a load was still writing, and the `generationsRemaining` report all come from one
implementation instead of two.

```ts
const swept = await store.retireExpired({ namespace: 'active-daily' });
// → { scanned, eligible, retired, wouldRetire, tombstonesPurged, limited, dryRun, entries }
```

**It is a call, not a daemon.** Nothing in this library schedules itself, and that is a deliberate limit rather
than an unfinished feature: the same code has to behave identically in a Lambda, an edge isolate and a long-lived
server, and a timer that only works in one of those is worse than none. **You own the heartbeat.** Any of these is
a correct answer:

| Where you already run things | How to run the sweep |
|---|---|
| **AWS Lambda** | an EventBridge (CloudWatch Events) schedule → a handler that builds the store and calls `retireExpired` |
| **Kubernetes** | a `CronJob` |
| **ECS / Fargate** | a scheduled task |
| **A plain VM / container** | `cron` calling a one-shot script |
| **A job queue you already have** | a recurring job — the one that runs your loads is a natural home |

> ⚠️ **Run the sweep from ONE process, or shard it.** N replicas each running the full sweep would contend over
> the same segments. Either call `retireExpired` from a job that runs once (a `CronJob`), or give each replica a
> disjoint slice with `shards` / `totalShards` — a stable hash of the segment key, so a worker owns the same slice
> across restarts.

**Once a day is enough** for daily buckets — retention windows are measured in days, so an hourly sweep just
re-scans the same registry 24 times. Match the cadence to the granularity of your policies, not to how fast you
want the deletion to feel. On DynamoDB a fleet scan is a billed full-table `Scan`, and on S3 a `LIST` — the
default `'fleet'` scan costs what the fleet *holds*; `scan: 'index'` reads only the due buckets of the **due
index** and costs what is *expiring*. The index is a fast path, not the source of truth: each candidate's live
row is re-read before anything is decided, and a policy written before the index existed has no pointer, so run
the `'fleet'` scan periodically as the repair pass (`lookbackBuckets`, default 7, is how many past days a fast
scan also reads so a sweep that did not run leaves nothing stranded).

**Start with `dryRun`.** In a loop `dropSegment`'s `confirmSegment` guard protects nothing (it is the same
variable twice), so the sweep-level preview is the real safety net:

```ts
const preview = await store.retireExpired({ namespace: 'active-daily', dryRun: true });
// `wouldRetire`, not `retired` — `retired` counts actual deletions and is 0 in a dry run, deliberately, so a
// dashboard summing it can never report phantom deletions.
console.log(`would retire ${preview.wouldRetire} of ${preview.scanned} scanned`);
```

**Read the ledger.** A per-segment fault is an entry, never an exception — a throw from the middle of a fleet
sweep would leave you unable to say which segments were retired, having already retired some:

```ts
for (const e of swept.entries) {
  if (e.action === 'skipped') console.warn(`${e.segment}: ${e.reason}`);
  if (e.action === 'retired' && e.result.generationsRemaining.length > 0) {
    console.warn(`${e.segment}: storage not fully reclaimed — re-run`);
  }
}
if (swept.limited) scheduleAnotherPassSoon(); // more are still eligible
```

**Two bounds worth setting deliberately.** Retirements are **sequential** — several round trips each, so the
default `limit` of 100 is comfortably inside a Lambda; `limit` is therefore a *time* knob as much as a safety one,
and raising it by orders of magnitude after a backlog will time out mid-sweep (harmlessly — re-run). And
`maxScanSegments` (default 250,000) caps how many registry rows one sweep holds resident; past it the call throws
`BudgetExceededError` rather than half-sweeping, because a scan that cannot fit is not a partial result to be
mistaken for a complete one. Narrow with `namespace` before raising it.

Every `skipped` reason is worth an alert, for a different reason:

- **`invalid-policy`** — the row's `expiresAt` cannot be used. That segment is **not expiring**, and someone
  probably believes it is.
- **`limit`** — eligible, but this cycle's cap (default **100**) was spent; `limited: true` says the same at the
  top level. That cap is what stands between a bad `expiresAt` backfill (or clock skew) and a retired fleet, so it
  defers rather than drops — re-run to continue. The cap is charged on **attempts**, not successes, so a partial
  Cold outage cannot march through the fleet with the cap never engaging.
- **`policy-changed`** — the live row no longer says "expired": a `clearRetention`, a new `expiresAt`, or someone
  else's drop landed between the enumeration and this segment's turn. **Not an error** — the sweep re-reads the
  authoritative row immediately before every deletion, precisely so cancelling an expiry works on a sweep that is
  already running.
- **`tombstone-not-empty`** — see below.
- **`failed: …`** — that one segment's retirement threw. Note that `dropSegment` writes the tombstone *before* the
  Cold sweep, deliberately, so a fault there leaks **bytes, not correctness**; a fault *after* the tombstone landed
  is reported as `retired` with a `fault`, because that segment really is retired. Re-running collects the bytes.

**Tombstones are purged, narrowly.** A retired segment leaves a `destroyed` row behind, and one dead row per
retired daily bucket accumulates forever. The sweep deletes those rows too, but only when all three hold,
because deleting the row is what makes the name writable again:

1. the row carries the **sweep's own retirement stamp**. This is a positive marker `retireExpired` writes on the
   tombstones it creates, *not* an inference from "destroyed + an expired policy" — that inference was wrong, and
   dangerously so: a crypto-shred leaves `retention` untouched, so the ordinary ordering (set a 30-day policy, then
   a right-to-erasure request arrives mid-window and you `destroySegment`) produces a **GDPR tombstone carrying an
   expired policy**. Deleting that row would destroy the local attestation for an Art. 17 execution and un-fence
   the name. A marker cannot be forged that way, so a `destroyed` row the sweep did not create is never touched;
2. a **grace period** has passed since that stamp (default 24 h). While the row exists every writer refuses the
   segment, and that is what stops an in-flight load from resurrecting it;
3. Cold is provably empty for it. If Cold still holds a straggler generation — a load that was writing when the
   tombstone landed — the sweep **collects it first** (`gcOrphanGenerations` takes every generation of a destroyed
   row, and nothing else would ever call it for a tombstoned segment), then purges. Only if the storage still
   cannot be proven gone does the row stay, with `tombstone-not-empty`: without the row `gcOrphanGenerations` can
   no longer see the segment at all, and the objects would be billed forever.

Pass `purgeTombstones: false` to keep every tombstone — the right choice if something outside this library treats
the presence of a `destroyed` row as an attestation. (Two options rather than one `number | 'never'` on purpose:
`0` would have to mean "purge immediately" here while `coldGenTtlMs: 0` in this same library means "pin forever",
and one option whose zero is the opposite of another's is a trap for whoever tunes both.)

## 14. Export / eject your data

Your data isn't locked in. `store.exportSegments(sink, options)` dumps **every registered segment's current
generation** through an injected sink, using only public read APIs — so it's readable **without CloudBitmaps**.
Two formats:

- `roaring` (default) — one **portable RoaringBitmap32** per segment (`<segment>.roaring`), loadable by any
  roaring library (Java/Go/Python/Rust/C++/…).
- `ndjson` — newline-delimited ids per segment (`<segment>.ndjson`), zero dependencies to read, streamed.

The `export-segments` CLI wraps it with a filesystem sink (each file written to a unique `.part` temp then
atomically renamed; artifacts are owner-only `0o600`) and writes a self-describing `manifest.json` **last** (also
atomically) — so a directory with a `manifest.json` means the run **finished** (a crash leaves none → just
re-run). It exits non-zero if any segment couldn't be read (see _fault isolation_ below):

```bash
CR_EXPORT_ROOT=./.cloudroaring CR_EXPORT_OUT=./dump npx export-segments
# → dump/manifest.json + dump/<namespace|_default>/<segment>.roaring   (CR_EXPORT_FORMAT=ndjson for .ndjson)
# CR_EXPORT_NAMESPACE=eu             scope the dump to one namespace
# CR_EXPORT_ROOT holds the local-filesystem store: <root>/cold and <root>/registry
```

In-process (any store with a registry), with your own sink (an fs writer, an S3 upload, stdout, a test buffer):

```ts
import type { ExportSink } from '@cloudbitmaps/roaring';
const mySink: ExportSink = /* your sink: open(ref, ext) → { write, close, abort? } */;
const manifest = await store.exportSegments(mySink, {
  format: 'roaring', // or 'ndjson'
  namespace: 'eu', // optional: scope to one namespace
});
// manifest: { version, format, totalSegments, totalIds,
//             segments: [{ segment, namespace?, count, bytes }],
//             failed:   [{ segment, namespace?, error }] }   // segments that couldn't be read (see below)
// (the CLI's manifest.json also carries a `generatedAt` timestamp.)
```

Reading a `.roaring` file back needs **no CloudBitmaps** — any roaring library deserializes the portable format:

```ts
import { readFileSync } from 'node:fs';
import roaring from 'roaring';
const { RoaringBitmap32, DeserializationFormat } = roaring;
const ids = RoaringBitmap32.deserialize(readFileSync('dump/_default/vips.roaring'), DeserializationFormat.portable).toArray();
```

Notes: `exportSegments` needs a `registry` (throws `UnsupportedError` otherwise). Enumeration is the registry's
known set, and **every loaded segment has a row** — the publish writes it — so the registry is complete by
construction; a segment loaded *without* a registry is not exportable here (wire the registry the loads used).
Encrypted segments are **decrypted** transparently if the store has the keystore — so the export is **cleartext**
(protect it). Crypto-shredded segments are skipped.

**Fault isolation.** A segment that can't be read — a corrupt cold object, or an encrypted segment when the store
has no keystore (the CLI wires none, so it can't decrypt those) — is recorded in the manifest's `failed[]` and the
export **continues**; one bad segment never blocks the rest, and its partial output is discarded. So "a
`manifest.json` exists" means the run _finished_, not that every segment succeeded — always check `failed` (the CLI
also exits non-zero when it's non-empty).

Re-running overwrites the segments it re-exports but does **not** prune files for segments that have since
disappeared — export to a **fresh directory** for a clean dump. For a *current* dump, run against a freshly-built
store (a long-lived store may be up to `coldGenTtlMs` behind a publish — the CLI builds a fresh store per run);
for a *consistent* dump across segments, pause your loads or export from a quiet window. This is also a building
block for a **data-portability** response. See [`PRIVACY.md`](../../PRIVACY.md) and the README's "Your data stays
yours".

## 15. Cost ceiling: the per-op fan-out budget

On a shared/serverless backend, one pathological call — an `intersect` over two enormous barely-overlapping
segments, a wide `union`, or a fleet-wide `eraseSubject` — can quietly run up a large bill (a "denial-of-wallet").
CloudBitmaps caps the **number of backend calls a single operation may fan out to** (Cold chunk fetches, or
segments scanned) and refuses (throws `BudgetExceededError`) rather than running away:

```ts
import { CloudRoaring, BudgetExceededError } from '@cloudbitmaps/roaring';

// on by default — generous (1,000,000 units); set your own store-wide ceiling:
const store = new CloudRoaring({ cold, registry, budget: { maxRequests: 50_000 } });

try {
  for await (const id of store.segment('huge').intersect([store.segment('other')])) {
    /* … */
  }
} catch (e) {
  if (e instanceof BudgetExceededError) {
    /* the op would have fanned out past the ceiling — it was refused before doing the work */
  }
}
```

The store-level `budget` guards `count` / `iterate` / `intersect` / `union` / `andNot` / `subjectReport` /
`eraseSubject` — the operations whose cost scales with data size. The ops that take options — the combines,
`subjectReport`, `eraseSubject` — also accept a **per-op override** (a partial override inherits the store ceiling;
it never resets it to the generous default):

```ts
// tighten or lift the ceiling for a specific call:
await store.subjectReport(userId, { namespace: 'eu', budget: { maxRequests: 5_000 } });
for await (const _ of store.segment('a').intersect([store.segment('b')], { budget: false })) {
  /* trusted batch job — no ceiling for this call */
}
```

The ceiling is checked **once, before fan-out**, against the already-known work size, so it adds **nothing to the
hot path** (`has` is single-call and never budgeted). The units are the chunk reads the op will actually issue —
for an `intersect`, the surviving keys × the operands present at each, plus only those excludes that hold the
key, so a large suppression list is not charged for keys it cannot affect. Byte volume needs no separate limit:
every chunk read is size-capped by the safe deserializer, so bounding the fan-out transitively bounds bytes too.
`count` on a loaded segment is summed from the `.crbm` index with zero reads, so it only approaches the ceiling on
a source that can't serve cardinalities (the in-memory `MemoryColdChunkSource`). Leave it on; lower it on
untrusted/multi-tenant surfaces; raise it (or `budget: false`) for trusted bulk jobs.

## 16. Disaster recovery: check cross-store consistency

CloudBitmaps spans two independent stores — the **object store** (cold `.crbm` generations) and the **registry**
(which generation is current per segment). A restore that brings them back at **different points in time** can
leave the registry pointing at a cold generation that wasn't restored (its `currentGen` names a `.crbm` that
isn't there) — a torn restore that otherwise surfaces only as a failed read, much later. `checkConsistency()`
detects it up front:

```ts
const report = await store.checkConsistency();          // scan every registered segment
// { checked: 1284, inconsistent: [], errored: [] }      // healthy

if (report.inconsistent.length > 0) {
  // [{ segment, namespace?, currentGen, issue: 'missing-cold-generation' }, …]
  // → the registry is ahead of the object store: restore the missing generations,
  //   or roll the registry back to a generation that exists.
}
if (report.errored.length > 0) {
  // [{ segment, namespace?, error }, …] — couldn't be read this pass (a partial/transient object store
  // mid-restore is exactly when this runs). Not proof of a tear: re-run once the store is fully available.
}
```

Run it **after any restore** and as a periodic health check. It needs a raw cold driver + a `registry` (same
requirement as the other lifecycle helpers; throws `UnsupportedError` otherwise) and fans out at a bounded
`concurrency` (default 8). A single unreadable segment never aborts the scan — it lands in `errored` so you still
get the full picture; and each segment is checked against its authoritative **live** pointer (a strong read), not
the enumeration snapshot, so a concurrent load that advanced the generation during the scan isn't misreported as
a tear. See the [disaster-recovery runbook](disaster-recovery.md) for the full restore procedure, RPO/RTO
guidance, and why the registry must be point-in-time-recoverable alongside the object store.

## The operations

| Method | Returns | Notes |
|---|---|---|
| `has(id)` | `Promise<boolean>` | `ValidationError` if `id ∉ [0, 2³²)`. The hot cache, else **one** ranged GET of that id's chunk — never budgeted |
| `count()` | `Promise<number>` | exact cardinality, summed from the `.crbm` index with **zero payload reads** on a loaded segment; `budget`-guarded on a source without an index ([§15](#15-cost-ceiling-the-per-op-fan-out-budget)) |
| `iterate()` | `AsyncIterable<number>` | ascending, one chunk at a time; `budget`-guarded |
| `intersect(others, { exclude?, concurrency?, budget? })` | `AsyncIterable<number>` | ascending; chunk-skipping. `exclude` subtracts suppression segments **in the same pass** |
| `union(others, { exclude?, concurrency?, budget? })` | `AsyncIterable<number>` | ascending. The one composite with **no** chunk-skipping — every chunk of every operand is read |
| `andNot(excludes, { concurrency?, budget? })` | `AsyncIterable<number>` | ascending. Reads all of `this`; each suppression list **only where it overlaps** |
| `intersectInto` / `unionInto` / `andNotInto` `(dest, …)` | `Promise<MaterializeResult>` | write the result as a **new generation of `dest`** (superseding it) — `{ generation, cardinality, chunkCount, size }`. Needs a raw cold driver + registry |
| `costReport({ workload?, pricing? })` | `Promise<CostReport>` | grounded $ report from this segment's real `.crbm` size ([§11](#11-cost-estimate-it-then-ground-it)) |

There is no per-id write on a segment: data enters as a generation — `bulkLoadCrbmGeneration`
([§3](#3-loading-a-segment)) or an `*Into` verb — and leaves the same way (`eraseSubject`, `dropSegment`).

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
| `SETBIT key id 1` / `SETBIT key id 0` | — | **no per-id write.** Build the set upstream and `bulkLoadCrbmGeneration` it; remove one id everywhere with `eraseSubject` (a rewrite, for compliance — not a hot-path verb) |
| `EXPIRE key seconds` | `store.setRetention(ref, { expiresAt })` + `store.retireExpired()` | per **segment**, never per id (a bitmap stores ids, not timestamps), and the sweep is **yours to schedule** — this library starts no timer, so it behaves the same in a Lambda and a server. [§13.5](#135-retention-ttl-and-pruning--what-exists-and-what-doesnt) |

You are not giving up the bitmap: each 65,536-id chunk is stored in whichever of Roaring's three encodings is
smallest for that chunk, and past **4,096 ids** in a chunk (6.25% of it) the winner is a flat bit array — the same
bytes you have now, chosen per chunk instead of assumed for all of them. Below that threshold you stop paying for
the empty span.

**What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array, so anything that reads
your Redis bitmap's underlying string — a job that `GET`s the key and indexes into it, a byte-for-byte backup,
another service that already parses that layout — will not read ours. `BITFIELD`, `BITPOS`, and the byte-range
forms of `BITCOUNT` have no equivalent either: this is a set of ids, not an addressable bit buffer, and
`BITOP NOT` in particular has nothing to complement against, because there is no bounded universe here, only the
`u32` id space. Raw bit-position **import** (the migration direction off Redis) and export are not built; whether
they get built depends on someone saying they need them. Everything reached through bitmap *operations*
transfers today; everything reached through the bytes does not.

## Intersecting segments (the crown jewel)

`intersect` streams the ids present in **every** operand, ascending — and only ever downloads the Cold chunks
whose 16-bit key appears in *all* of them, so two huge segments that barely overlap transfer almost nothing:

```ts
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
for await (const id of shoppers.intersect([active], { exclude: [store.segment('global-opt-out')] })) {
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

## Deploying to AWS Lambda

CloudBitmaps' crown jewel is serverless chunk-skipping intersection, so Lambda is a first-class target — with
one thing to know. The bitmap math runs on **`roaring`, a native (C++) addon**, and it ships **no prebuilt
binary for the Lambda Node runtimes on Linux** (checked: `nodejs20`/`nodejs22`, arm64). So you can't just
`npm install` on the bare runtime — the addon must be **built for the target platform** (exactly like `sharp`
or `better-sqlite3`). This is a one-time build step, not a per-invocation cost.

Pick whichever you already use:

- **`sam build --use-container`** (or `--use-container` on your framework) — builds deps inside an Amazon
  Linux image matching the runtime, so `roaring` compiles for the target. The simplest path.
- **Container image Lambda** — `FROM public.ecr.aws/lambda/nodejs:22`, add a build toolchain
  (`dnf install -y gcc-c++ make python3`), `npm ci`, deploy the image.
- **A Lambda layer** — build `node_modules` once in an Amazon Linux 2023 container and ship it as a layer,
  reused across functions.

Match the **arch** (`arm64` Graviton vs `x86_64`) and **Node version** of your function when you build. Our
CI proves this path end-to-end with a `pnpm lambda-smoke` gate (builds `roaring` in an AL2023 container and
loads the package under both ESM and CJS). *(A prebuilt, drop-in Lambda layer ships too: `pnpm build-lambda-layer`
produces `dist-lambda/cloud-roaring-lambda-layer.zip`.)*

## Troubleshooting

### `Cannot find module './build/Release/roaring.node'` after a successful install

If you install with **`--ignore-scripts`** — a common hardening default in CI — the install **exits 0** and the
package is then unusable at runtime:

```
$ npm i --ignore-scripts @cloudbitmaps/roaring
$ node -e "require('@cloudbitmaps/roaring')"
Error: Cannot find module './build/Release/roaring.node'
```

**Why.** The native dependency `roaring` publishes an npm tarball containing **no** compiled binary; it ships an
`install` script that downloads the right prebuilt binary for your platform from GitHub Releases. Disable install
scripts and that download never happens, so there is nothing for the addon loader to find. npm reports success
because the *install* did succeed — only the post-install step was skipped.

**Fixes, in order of preference:**

1. **Allow the install script for that one package.** Both npm and pnpm let you narrow the exception rather than
   re-enabling scripts globally — pnpm's `onlyBuiltDependencies`, or an npm install run scoped to it.
2. **`npm rebuild roaring`** after the ignore-scripts install; it runs the skipped step.
3. **Build from source** — `npm_config_build_from_source=true npm i` with a C/C++ toolchain present. Also the
   route on **Alpine/musl**, where no prebuilt binary is published at all.

**Check it at install time, not at 3am.** Because npm's exit code cannot tell you about this, add a startup or CI
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

### Two different limits: `budget` (cost) and the memory ceilings

They are separate on purpose, and it is worth knowing which one you just hit.

| | `budget` | the memory ceilings |
| --- | --- | --- |
| bounds | **cost** — backend requests a single op may fan out into | **memory** — what a process holds resident, whatever the segments' size |
| knobs | `budget: { maxRequests }`; `false` disables it | `cacheMaxChunks` (decoded hot chunks, default 1024) · `coldReaderCacheMax` / `coldReaderCacheMaxBytes` (open `.crbm` indices, default 1024 / 64 MiB) · the combines' `concurrency` window · the per-chunk decode cap — **`budget: false` lifts none of them** |
| covers | `count` · `iterate` · the combines · `subjectReport` · `eraseSubject` | every read, on every backend |

Why not one control? Because `intersect`'s budget is a *product* — surviving keys × operands — while its memory is
the *window*: `concurrency × operands × chunk`, independent of segment size. A request budget cannot express a
memory bound, and `budget: false` is a reasonable choice ("I know my fan-out") that must not silently also mean
"unbounded RAM". A wide segment's parsed index can be several MB, which is why the reader cache is bounded by
bytes as well as by count — lower `coldReaderCacheMaxBytes` for a memory-tight deployment (a 128 MB Lambda) that
reads across many wide segments.

**Neither limits how many ids a segment can hold.** A segment holds up to the full 32-bit id space — ~4.29
billion members — and no ceiling here changes that. `maxScanSegments` (on the sweep and the consistency check)
counts **segments** — distinct named bitmaps in the registry — not members: 500 audience segments count as 500,
whatever their size.

## What blocks the event loop, and where to run it

Node is single-threaded, so CPU-heavy work stalls **every** other request on that instance. Most of this library
is network-bound and irrelevant here — a `has()` spends a negligible fraction of its time on bit math — but a
**load** and an **erasure rewrite** are genuinely CPU-heavy, because each one touches a whole generation. Measured
on an M3 Pro:

| path | cost | longest single stall | where it belongs |
| --- | --- | --- | --- |
| `bulkLoadCrbmGeneration` (1M ids) | ~256 ms | **~19 ms** | a batch job or worker; survivable off the request path |
| `eraseSubject` / `eraseIdFromSegment` | decodes and re-encodes every chunk of the segment — same order of work as a load | yields on the same cadence | an admin job, never a request handler |
| `has` / `count` / `intersect` / `union` / `andNot` | microseconds of CPU; dominated by network | — | anywhere |

The **stall** column is the number that decides whether co-resident work survives, and it is not the same as
cost. A load yields the event loop periodically, so its ~256 ms is spent in ~19 ms slices with the loop free
in between — other requests interleave rather than queueing behind the whole load. Before that fix the two
columns were the same number: a 1M-id load blocked the loop for **450 ms straight**, long enough for a health
check to time out and the instance to be pulled from its load balancer.

Yielding is on by default for `@cloudbitmaps/roaring` users; there is nothing to configure. It needs a `Clock`,
which the flavor package pre-binds into `bulkLoadCrbmGeneration` and `eraseIdFromSegment`. If you call
`@cloudbitmaps/core` directly, pass one (`clock`) or the work runs uninterrupted.

**The rule:** anything that touches a whole generation belongs out of the request path. Yielding makes a load a
well-behaved neighbour, not a cheap one — it still burns a core for a fraction of a second, holds the whole
generation in memory, and streams a multipart upload. Use a job runner, a queue consumer, or a short-lived task —
and keep `has`, `count` and `intersect` where the requests are.

## Where next

- [Roadmap](../ROADMAP.md) — what's shipped, the **validated envelope** (what's proven and what isn't), the
  path to `1.0`, and what we've deliberately said no to.
- [API Reference](api-reference.md) — every export, kept in sync with the code by CI.
- Writing your own storage driver? A shared **conformance suite** (`packages/roaring/src/testing/conformance.ts`) is the bar
  every driver must pass. It remains an internal SDK helper (consumed in-repo via the `@/` alias) — it is not
  exported as a public `./testing` package subpath.
