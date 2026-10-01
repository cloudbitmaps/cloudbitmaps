# CloudBitmaps

[![npm](https://img.shields.io/npm/v/@cloudbitmaps/roaring?logo=npm&label=%40cloudbitmaps%2Froaring)](https://www.npmjs.com/package/@cloudbitmaps/roaring)
[![CI](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/@cloudbitmaps/roaring)](https://nodejs.org)

CloudBitmaps stores large sets of integer ids, such as an audience or a cohort, in your own object-storage bucket and
reads them from anywhere: `has`, `count`, `iterate`, `intersect`. There is no server or cache to run. You compute a set
upstream (a warehouse query, a nightly job), load it, and query it, from a script or a stateless function. It is
built on [Roaring Bitmaps](https://roaringbitmap.org/), the compressed-bitmap format behind Lucene, ClickHouse, Druid
and Spark.

> **These docs describe `main`.** The library is pre-1.0 and the API can still change. [The changelog](CHANGELOG.md#unreleased)
> lists what `main` has that the latest release does not, and the docs for each release are at its tag, on the
> [releases page](https://github.com/cloudbitmaps/cloudbitmaps/releases).

Three words appear everywhere:

- **segment**: a named set of integer ids.
- **generation**: one immutable file holding the whole set at one point in time. A load writes a new one.
- **pointer**: the small record that names a segment's current generation.

## Install & entry points

```bash
pnpm add @cloudbitmaps/roaring    # the store, with in-memory and local-disk backends
pnpm add @cloudbitmaps/s3         # the storage you have: or @cloudbitmaps/gcs, or @cloudbitmaps/azure-blob
```

On pnpm 10 and later, allow the one build script first, or the package throws at `import` while the install exits 0.
Put this in your `package.json`: `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm and pnpm 9 need nothing
extra.

**ESM-only, Node ≥ 22.12.** For CommonJS, Jest and TypeScript details, see
[CommonJS, Jest and TypeScript](docs/guide/getting-started.md#commonjs-jest-and-typescript).

You install two packages: `@cloudbitmaps/roaring` (the store) and one storage package for your cloud. Each storage
package depends on its cloud SDK, so installing it is the whole step. `@cloudbitmaps/core`, the engine underneath,
arrives on its own and you never install it.

### First run, in memory

Save this as `first-run.mjs` (the `.mjs` extension allows top-level `await`) and run `node first-run.mjs`:

```js
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

// A load replaces a segment's contents with the ids you give it.
await store.load({ segment: 'shoppers' }, [5, 99_999, 1_234_567_890]);
await store.load({ segment: 'active' }, [5, 7, 1_234_567_890]);

const shoppers = store.segment('shoppers');
console.log(await shoppers.has(99_999)); // true
console.log(await shoppers.count()); // 3

const both = [];
for await (const id of shoppers.intersect([store.segment('active')])) both.push(id);
console.log(both); // [ 5, 1234567890 ]
```

It prints `true`, `3`, then `[ 5, 1234567890 ]`. The [getting-started guide](docs/guide/getting-started.md) goes on
from here.

### The same code on S3

Install `@cloudbitmaps/s3`, give it a bucket, and change one line. Everything after it is unchanged:

```js
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({ bucket: 'my-bitmaps', prefix: 'prod', region: 'us-east-1' }),
});
```

It builds its own client from your usual AWS credentials. The bucket must honor conditional writes, as AWS S3 does.

### Which backend

You pass one **backend** as `storage`. It decides where generations and pointers live:

| Backend | Package | Use it for |
|---|---|---|
| `MemoryStorage` | `@cloudbitmaps/roaring` | Tests and a first look. Gone when the process exits. |
| `LocalFsStorage` | `@cloudbitmaps/roaring` | One process on one folder: a laptop or a CI job. |
| `S3Storage` | `@cloudbitmaps/s3` | Production. The validated one, on AWS S3. It also runs against MinIO, which the tests use, and any S3-compatible service that honors conditional writes. |
| `GcsStorage` | `@cloudbitmaps/gcs` | Google Cloud Storage. Passes the conformance suites; outside the validated envelope. |
| `AzureBlobStorage` | `@cloudbitmaps/azure-blob` | Azure Blob Storage. Passes the conformance suites; outside the validated envelope. |

The [validated envelope](docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt) says what has been
proven: read-mostly, up to about 100,000 segments, single-tenant and single-region, on S3. Choosing GCS or Azure
means being an early user.

## Use it when, and when not

**Use it when:**

- You have many large id sets (audiences, cohorts, suppression lists, eligibility) that you compute in batches and read often.
- You want them durable and cheap at rest, in a bucket you own, rather than held in always-on memory.
- You need fast set algebra (intersect, union, difference) over them, including from short-lived or serverless workers.

**Do not use it when:**

- You need to add or remove one id at a time. There is no `add`, no `remove` and no `SETBIT`: a segment changes only
  by loading a new generation. If events arrive one at a time, collect them where they arrive (Redis is good at that)
  and load the set on a schedule. Removing one id everywhere is a compliance operation (`eraseSubject`), not a
  hot-path call.
- You need sub-millisecond answers on a small working set. A read that misses the cache is a ranged GET against
  object storage.
- You want an addressable bit buffer. `BITPOS`, `BITFIELD` and `BITOP NOT` have no equivalent, and the stored bytes
  are not a flat bit array.

A load is a batch job, not a request handler: it replaces a whole segment and holds the set in memory while it runs.
If you need fresher data, shorten the load interval. Coming from Redis bitmaps? See
[the mapping, command by command](docs/guide/getting-started.md#coming-from-redis-bitmaps).

## Why CloudBitmaps

A Roaring Bitmap holds a huge set of integer ids, such as *"which of my 1.2 billion customers are in the
`high-value-shoppers` segment?"*, in very little space. The established libraries are local, in-process data
structures, so teams reach for an always-on Redis cluster and pay for memory around the clock to hold sets that are
mostly read. CloudBitmaps keeps the bitmap engine and puts the sets in your own object storage.

What it costs at three illustrative sizes, priced by the library's own estimator against the cheapest on-demand
Redis OSS cluster that would hold each one's data:

<!-- SIZING:WHY_SIZES:START -->
| | data | CloudBitmaps a month | the Redis that holds it | CloudBitmaps costs |
|---|---:|---:|---:|---:|
| **Small** — a product team keeping its user cohorts | 200 MB | $3.35 | $35.04 | **90% less** |
| **Medium** — an ad platform matching audiences | 20 GB | $281 | $900 | **69% less** |
| **Large** — a marketplace filtering its catalogue | 2 TB | $6,771 | $27,325 | **75% less** |
<!-- SIZING:WHY_SIZES:END -->

<!-- SIZING:WHY_CAVEATS:START -->
Each Redis is the cheapest on-demand ElastiCache for Redis OSS cluster in the estimator's catalogue that holds the data, every shard a primary and two replicas: the cheapest of one kind, not the least Redis could cost. Against [ElastiCache for Valkey](https://aws.amazon.com/elasticache/pricing/), which AWS prices 20% lower a node, CloudBitmaps costs 88% less, 61% less and 69% less; with one replica a shard, 86% less, 53% less and 63% less; with both, 82% less, 41% less and 54% less. Reserved nodes cost less again, and stack on both: on a one-year term with nothing upfront, CloudBitmaps costs 74% less, 14% less and 32% less, and on three years paid upfront, 60% less, 1.3× as much and 1.03× as much, so a Redis bought all three ways costs less than CloudBitmaps at the medium and large sizes.

All three assume that two segments share 100 of their 2,000 chunks, and filters over one catalogue or one audience can share most of theirs: at 1,000 shared chunks, the medium and large deployments cost 2.4× and 1.6× their Redis, and their bills pass it at 395 and 589 shared chunks.

The large deployment's 200,000 segments are past the roughly 100,000 the library has been validated at, and its readers would need an index budget and a chunk cache far past their defaults ([what each reader holds](docs/guide/sizing.md#what-each-reader-holds)), in memory not priced here.
<!-- SIZING:WHY_CAVEATS:END -->

Where it loses: small data queried hard, where a node that costs the same however hard it is used wins, and wherever
an answer cannot wait on object storage. [What it saves, and where it doesn't](docs/guide/why-cloudbitmaps.md)
explains these, S3's request rate and overlap, with the charts; [what it costs at your size](docs/guide/sizing.md) has each bill term by term, and
[the measured AWS bill](docs/benchmarks.md#real-cloud-calibration--aws) says what was measured on real S3.

## What it costs on real AWS

Run [`2026-09-23-94416`](bench/calibration/2026-09-23-94416.md), made on 2026-09-23 on the release then current, drove the
packages against a real AWS account in `us-east-1`, with the pointer in
the same bucket as the data. What each operation costs:

| Operation | Cost | Kind |
|---|---|---|
| Cold `intersect` of two 500,000-id segments sharing 100 of 1,999 chunks: 206 GETs at the median | **$82.40 / million** | measured requests at list prices |
| The same inside the region, each pointer read once: 204 GETs | $81.60 / million | expected |
| Loading a segment: the write and the publish, pointer included | **$11.20 / million** | measured requests at list prices |

The run was driven from outside the region, so it calibrates cost, not in-region latency. The
[benchmarks page](docs/benchmarks.md#real-cloud-calibration--aws) says exactly what it did and did not measure.

## Your data stays yours

If the library breaks, you are not stuck:

- **It is a library, not a service.** Your data lives in your bucket, your account or your filesystem. CloudBitmaps never sees it, and you are the data controller (see [`PRIVACY.md`](PRIVACY.md)).
- **The files are an open format.** Each `.crbm` object is a documented container with a footer index and CRC32C checksums, wrapping standard Roaring serialization that every Roaring library (Java, Go, Python, C++, Rust, C#) reads.
- **A bad load does not overwrite the last good one.** Generations are write-once and checksummed, and corruption is rejected before it is decoded. The one answer taken from the index alone, [`count()`](docs/guide/reading.md#what-count-trusts), is checked for internal consistency but not against the payloads. A bad load writes a new generation, and the previous one stays in the bucket for you to [roll the pointer back](docs/guide/loading.md#roll-back-a-segment) to. Under the default `keep: 1` it stays only until the next load, so roll back before you load again, or raise [`keep`](docs/guide/loading.md#generations-and-keep).
- **You can leave.** `store.exportSegments(sink)` writes every segment's current generation to portable `roaring` or `ndjson`. The `export-segments` command does the same for a local-filesystem store only; for S3, GCS or Azure, call `exportSegments` in code. See [Export your data](docs/guide/export.md).

How this compares with pure Roaring libraries and bitmap databases on lock-in is in
[Beyond the bill](docs/guide/why-cloudbitmaps.md#beyond-the-bill), and what a raw copy of the bucket holds is in
[Export your data](docs/guide/export.md#things-to-know).

## The whole surface, in three steps

```
  ┌─ STEP 1 ── pick a backend ────────────────────────────────────────────┐
  │  MemoryStorage()          LocalFsStorage(root)                        │
  │  S3Storage({ bucket, prefix })   GcsStorage(…)   AzureBlobStorage(…)  │
  │                                                                       │
  │  One object. It decides where the generations go AND where the        │
  │  pointer that says which one is current goes, from one bucket and     │
  │  one prefix.                                                          │
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
  │  invalidate()        ← forget what this store cached for a segment    │
  └───────────────────────────────────────────────────────────────────────┘
```

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'prod' }) });

// idsFromWarehouse() and engagedFromWarehouse() are your functions: each yields the ids (an array, a generator, a cursor).
const r = await store.load({ segment: 'vips' }, idsFromWarehouse());
if (!r.published) console.warn({ reason: r.reason, had: r.cardinalityBefore });
await store.load({ segment: 'engaged' }, engagedFromWarehouse()); // an operand has to exist: load it first

for await (const id of store.segment('vips').intersect([store.segment('engaged')])) {
  /* the audience */
}
```

**Where next:** [getting started](docs/guide/getting-started.md) ·
[before production](docs/guide/production.md) ·
[coming from Redis bitmaps](docs/guide/getting-started.md#coming-from-redis-bitmaps) ·
[API reference](docs/guide/api-reference.md) ·
[errors and what to do](docs/guide/api-reference.md#errors-typed--you-catch-these)

## How it works

**Chunks.** Every 32-bit id is split into a 16-bit chunk key and a 16-bit remainder. Each chunk is a small Roaring
bitmap of up to 65,536 ids, and it is the unit of storage and transfer: you never read a whole segment to test one id.

**Two tiers and one pointer.**

```text
  load(ids) ─► group by chunk ─► write ONE immutable .crbm object ─► publish the pointer
                                   (segment.<gen>.crbm, write-once)     (a registry compare-and-swap)

  has(id)   ─► CACHE? (RAM + bounded LRU) ─► STORAGE (single-chunk byte-range read)
  count()   ─► the object's footer index (0 payload reads)
  intersect(A,B) ─► align chunk indexes ─► fetch only the chunks present in BOTH ─► stream IDs
```

- **Storage** holds immutable, generation-keyed `.crbm` objects, each with a footer index that makes `count()` and single-chunk reads cheap.
- **The registry** is one small row per segment saying which generation is current. A load moves it by compare-and-swap, and it is the only thing a write changes.
- **The cache** is a bounded in-memory LRU of decoded chunks, keyed by generation, so a new generation misses it instead of being answered with the old one's bytes. A reader moves to a new generation within [`cache.genTtlMs`](docs/guide/reading.md#how-soon-a-reader-sees-a-new-load), 2 s by default.

**Intersection.** To find the ids in both of two huge segments, CloudBitmaps reads the two small chunk indexes,
aligns their keys, and fetches only the chunks present in both. Two 100 MB segments overlapping in 5% of chunks
transfer about 10 MB of chunks, not 200 MB (arithmetic, for chunks of equal size). An `exclude` list is read only at
the keys that survived.

More: [Loading in depth](docs/guide/loading.md), [Reading in depth](docs/guide/reading.md) and [Before production](docs/guide/production.md).

## Status

The library is pre-1.0: the API and the `.crbm` on-disk format may still change before `1.0`, which is earned by
real-cloud calibration, real adoption and a format freeze, not by a date. Everything described here is built behind
tests and an adversarial review. The
[validated envelope](docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt) says where it is ready;
GCS and Azure Blob sit outside it. [The roadmap](docs/ROADMAP.md) lists what is shipped and what stands between here
and `1.0`.

## Documentation

- **[Getting started](docs/guide/getting-started.md)**: the 10-minute path.
- **[The guide index](docs/guide/README.md)**: production, loading, reading, retention, encryption, erasure, observability, export and disaster recovery.
- **[API reference](docs/guide/api-reference.md)**: every export, kept in sync with the code by CI.
- **[Usage walkthrough](https://cloudbitmaps.pages.dev/usage.html)**: the flows end to end.
- **[Benchmarks](docs/benchmarks.md)**, **[Privacy and shared responsibility](PRIVACY.md)**, **[Roadmap](docs/ROADMAP.md)**, **[Changelog](CHANGELOG.md)**.

## Building & contributing

You need **Node ≥ 22.12** and **pnpm 9**; Docker is needed only for the integration tests.

```bash
pnpm install
pnpm lint && pnpm lint:arch && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the canonical record of how we work. [`AGENTS.md`](AGENTS.md) is the AI-agent
operating manual (`CLAUDE.md` is a symlink to it).

## License

**Apache-2.0.** The `@cloudbitmaps` scope is where the packages publish, and the CloudBitmaps name is trademarked
at the public launch.
