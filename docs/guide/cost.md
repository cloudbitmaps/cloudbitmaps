# Estimate your own cost

[What it costs at your size](sizing.md) prices three example deployments. This page is how to price yours: call
`CloudRoaring.estimateCost()` with your workload for a plan, or `segment.costReport()` for what a real segment costs.
The [benchmarks page](../benchmarks.md) charts exactly where pay-per-use beats one Redis-HA cluster, whatever the data
size, drawn from this same estimator and turned into build-breaking CI assertions, so the numbers cannot drift ahead
of reality.

## Cost: estimate it, then ground it

CloudBitmaps can tell you what a workload will cost, and what your real segments are costing, because the library owns
the storage and the cache. The model has five terms and no per-id write:

- object-store **GETs** for point reads;
- GETs for **intersections**, each operand's pointer and index as well as its chunks;
- the requests of a **load**: the object's write and what `store.load()` does around it;
- the **pointer refresh** a long-lived reader pays;
- **storage**.

Each request count is one the engine is tested to make.

**Planning** (pure, no instance needed — sizing, sales, what-if):

<!-- SIZING:GUIDE_EXAMPLE:START -->
```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';

const report = CloudRoaring.estimateCost({
  segments: [{ sizeBytes: 6e8, count: 2 }], // or { cardinality }
  workload: {
    readsPerSec: 200, // point reads; each cache miss is one GET
    cacheHitRate: 0.8, // hits are free
    intersectsPerSec: 1, // priced cold: each operand's pointer and index are read too
    chunksPerIntersect: 20, // the chunks it fetches: 2 operands × 10 shared chunks
    loadsPerMonth: 30, // one store.load() a day, single-part
    hotSegments: 2, // segments a long-lived reader keeps reading: each refreshes its pointer every 2 s
  },
});
report.monthlyUSD.byOp; // { reads: ≈42, intersects: ≈25.2, storage: ≈0.0257, loads: ≈0.00037, pointerRefresh: ≈1.05 }
report.monthlyUSD.total; // ≈68.4
report.redisBaseline; // $142.35 a month: the cheapest cluster in the catalogue that holds 1.12 GiB, 1 shard of 3 cache.t4g.medium nodes
report.verdict; // 'win' — 'win-big' | 'win' | 'lose-zone', never hides the lose case
report.redisCrossover.readsPerSec; // ≈ 672 sustained reads/s at THIS report's 80% cache-hit rate (≈ 134 at 0%)
```
<!-- SIZING:GUIDE_EXAMPLE:END -->

**Grounded** (real sizes from the `.crbm` index — exact, no payload reads):

```ts
const report = await store.segment('active-us').costReport({
  workload: { readsPerSec: 200, cacheHitRate: 0.8 },
});
report.assumptions.grounded; // true — storage is this segment's real, measured size
```

Rates are a pluggable `PricingProfile` — `{ name, storage: { getPerMillion, putPerMillion, storagePerGiBMonth },
redis }`, default `aws-us-east-1-ondemand` from the fact-checked published pricing; override it for your
region/cloud. [What it compares against](#what-it-compares-against) covers `redis`. The report is honest: `verdict` always includes the lose-zone, and `assumptions.notes`
lists the model's simplifications (same-region egress free; request cost from your supplied workload rates —
deriving it from live metrics is a later refinement; how many GETs each intersection was priced at; and, when you
leave `loadsPerMonth` or `hotSegments` unset, that **loads** or **the pointer refresh are not modeled** — disclosed
rather than silently under-counted; and, last, which Redis it compared with and how it priced it).

### What it compares against

The verdict compares the bill with **the Redis that would hold the data**: the cheapest ElastiCache cluster that
holds the report's stored bytes, in memory or, on a data-tiering node, in memory and SSD. `report.redisBaseline`
names it: its monthly price, the node type, the shards, the nodes, and whether they tier to SSD.
<!-- SIZING:COMPARES:START -->
Every shard is a primary and two replicas, AWS's best practice, and each node keeps back the 25% of its memory ElastiCache reserves by default, at AWS's us-east-1 on-demand prices (`ELASTICACHE_REDIS_US_EAST_1_ONDEMAND`). So 200 MB is priced as three `cache.t4g.micro` nodes at $35.04 a month, 20 GB as three `cache.r6g.xlarge` nodes at $900 a month, and 2 TB as three `cache.r6gd.16xlarge` nodes at $27,325 a month: a data-tiering node, which keeps the values read least recently on its SSD.
<!-- SIZING:COMPARES:END -->

<!-- SIZING:GUIDE_LEANINGS:START -->
It is the cheapest cluster of one kind, not the least Redis could cost, and its choices lean both ways. Toward Redis: the data is held at its compressed size, where a native Redis bitmap is sized by its highest id, so sparse ids take more memory than this; among node types the cheapest fit wins; a data-tiering node counts its SSD in full, though ElastiCache [moves no item larger than 128 MiB](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/data-tiering.html) to it; and every node keeps back only the 25% reserved by default, where AWS [advises 30% on small nodes and 50% on micro ones](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-memory-management.html) in production. Toward CloudBitmaps: the nodes are on-demand, every shard has two replicas, the engine is Redis OSS, and burstable `t4g` nodes are priced only as one shard. Reserved nodes, fewer replicas, or [ElastiCache for Valkey](https://aws.amazon.com/elasticache/pricing/), which AWS prices 20% lower a node, each cost less, and against them the saving is smaller: bought all three ways, on three years paid upfront, the Redis of [the medium and large deployments](why-cloudbitmaps.md#the-short-answer) costs less than CloudBitmaps. So does the Redis of the planning example above: bought all three ways, it costs $51.39 a month on one year with nothing upfront, and $34.27 a month on three years paid upfront, where CloudBitmaps costs $68.35. It prices nodes, not quotas: a cluster of more than 90 nodes needs AWS to raise ElastiCache's [default quota](https://docs.aws.amazon.com/general/latest/gr/elasticache-service.html#limits_elasticache), which it [raises to at most 500 nodes a cluster](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Shards.html) on Redis OSS 5.0.6 to 7.1 or Valkey 7.2 and later, and data that needs more is several clusters, at the same price a node.
<!-- SIZING:GUIDE_LEANINGS:END -->

A report on one segment sizes its Redis to that segment alone, so the baselines of a store's segments do not add up
to the store's. To judge a store, price all its segments in one `CloudRoaring.estimateCost()`. To alarm on one, sum the
segments' `monthlyUSD.total` and compare the sum with the Redis you would run for the store, as
[the cost gauge](dashboards.md#2-cost-gauge-costreport--a-scheduled-sample) does: a per-segment verdict against that
whole price fires only when one segment alone costs more than all of it. Two ways to compare differently:

- **One cluster you name**, whatever the data size: `pricing: { ...AWS_US_EAST_1_ONDEMAND, redis: { monthlyUSD } }`.
  <!-- SIZING:ONE_CLUSTER:START -->
  `ONE_REDIS_HA_CLUSTER` is the one the benchmarks page charts: a primary and two replicas of `cache.m7g.large`, $346 a month. The catalogue leaves that node type out: three `cache.m6g.large` of 6.38 GiB each cost $326, so it is a fixed point to compare with, not a price the estimator picks.
  <!-- SIZING:ONE_CLUSTER:END -->
- **Your own prices**: `redis: { sizedToData: { source, nodeTypes, replicasPerShard, reservedMemoryFraction } }`,
  each node type `{ name, memoryGiB, hourlyUSD }` with `ssdGiB` for a data-tiering node and `maxShards` to cap it.
  [ElastiCache for Valkey](https://aws.amazon.com/elasticache/pricing/), also Redis-compatible, costs AWS's stated
  20% less a node than the Redis OSS prices the default uses.

### The read crossover

`redisCrossover.readsPerSec` is the sustained point-read rate at which pay-per-use GETs cost more than
`redisBaseline`, once storage and the pointer refresh are taken out of it. It is not a ceiling on the library —
it is a property of three inputs, and of the data size, which sets the Redis:

| Input | Default | Change it and |
| --- | --- | --- |
| `cacheHitRate` | `0` | Every read is billed. A working cache moves the crossover by the reciprocal of the miss rate — 80% hits is 5× the reads for the same bill; 100% is `Infinity`. |
| `hotSegments` | `0` | The pointer refresh comes out of the baseline before any read is priced, like storage: a hundred hot segments at the default refresh cost about $53 a month, which can be more than the whole Redis a small store is compared with, and the crossover is then 0. |
| `pricing.storage.getPerMillion` | `$0.40` | Your region's or your committed rate; the formula is the spec, the rate is yours. |

### What each term counts

- **An intersection is priced cold**: 2 reads for each operand (`operandsPerIntersect`, 2 by default, `exclude`
  operands included), its pointer and then its index in one read of the object's tail, before the chunks it
  fetches (`chunksPerIntersect`). Two segments sharing k chunks make 4 + 2k GETs: $81.60 per million for k = 100 at
  the default GET price. An operand whose index outgrows the reader's 256 KiB tail read makes one more GET, to read
  it whole, and an intersect slow enough to outlive `cache.genTtlMs` reads its pointers again; add either to
  `chunksPerIntersect`. `cacheHitRate` does not apply to intersections, so a long-lived reader that answers
  repeats from its cache pays less than the report says, and pays the pointer refresh instead.
- **A load** is `requestsPerLoad` PUT-class requests for the object (1 by default; a multipart write of P parts is
  P + 2), plus what `store.load()` adds: the pointer's write, PUT-class on S3, and five GETs: three pointer reads and
  two checks, each a single request on every backend (a `HeadObject` on S3), that the next generation number is free
  and that the current generation's object is there. The load reads no index: the row's summary of the current
  generation gives its guard the size. It then deletes by name the one generation its publish pushed out of the
  window, a request S3 does not bill, and lists the segment only on every 16th generation, which adds a PUT-class
  request and two pointer reads there and makes no check that the current object is there, a sixteenth of each a load
  on average. That is a segment with two generations behind it, whose row carries a summary, at the default `keep` of
  1, and about $12.34 per million single-part loads at the default prices; a segment's first two loads collect
  nothing and make fewer requests, and the first load of a row written before rows carried a summary reads the
  current generation's index, a tail read, in place of the check that its object is there. A publish
  that loses a race to another writer reads the pointer again, and a load whose check finds the number taken (a
  crashed load's object, or the generations a rollback left above the pointer) lists the segment to number past it
  and lists again to collect, two PUT-class requests and two more pointer reads. So does every load with a `keep` of
  2 or more, which lists to collect: one more PUT-class request and two more pointer reads than the model counts.
  These are a cleartext segment's counts: an encrypted segment's load reads its row once more, after its ids and
  before it unwraps the key, one more GET ($0.40 per million at the default prices), which the model leaves out, as
  it leaves out the key-management calls an encrypted load makes. Loads are cheap by construction: a thousand
  100-part loads a month is about $0.52.
- **The pointer refresh**: a long-lived reader re-reads a segment's pointer when it reads the segment after
  `cache.genTtlMs` has passed. So each hot segment costs at most one GET per `genTtlMs`, 1,314,000 a month at the
  default 2 s, about $0.53, and the whole term at most one GET per point read. Pass `hotSegments` for the segments
  each reader keeps reading, and **`readerProcesses`** for how many readers keep them: each refreshes on its own,
  so ten processes reading the same hundred segments pay ten times one's refresh.
  `segment.costReport()` prices it at the store's own `cache.genTtlMs`. Raising the TTL lowers it, at the price of
  a new load taking longer to become visible; `0` turns the timed refresh off, and the term with it: a reader then
  re-reads a pointer only on an eviction, a read that finds its generation swept, or an invalidation.

  It assumes each hot segment stays open in the reader's cache: 1,024 segments by default (`cache.readerMax`), and
  64 MiB of parsed index (`cache.readerMaxBytes`). A read of a segment the cache evicted opens it again, a pointer
  read and a tail read, which the model does not price, and the report says so when `hotSegments` is past 1,024.
  Nor does it price the index each reader opens again after every load. Size the caches to keep the hot set open.

**A pointer read is one request on every backend**: S3, GCS and Azure Blob each answer it with a single GET whose
headers carry the version beside the bytes. **A tail read needs the object's size.** S3 and GCS answer it with a single
suffix-range GET whose `Content-Range` carries the size; Azure Blob takes no suffix range, so there it is two requests,
the properties and then the bytes. The pricing profile prices the two apart: `storage.requestsPerPointerRead` (1 by
default) for each pointer read, and `storage.requestsPerSizedRead` (1 by default) for each tail read. For Azure Blob,
set `storage.requestsPerSizedRead: 2` and leave `requestsPerPointerRead` at 1; chunk reads stay one request each, and
S3 and GCS keep both defaults. Each count above is held to the engine by a test that counts its requests, on S3's
request shape, and each backend's own tests pin the requests it makes (a pointer read in one everywhere; a tail read in
one on GCS and two on Azure Blob), so the model moves when the engine does. The
[benchmarks page](../benchmarks.md#the-single-bucket-bill--run-2026-09-23-94416) has the request shapes measured
on real S3.

**See it at three sizes.** [What it costs at your size](sizing.md) prices a small, a medium and a large deployment
with this function, term by term, and says where a standing cache still wins.
