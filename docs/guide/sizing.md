# What it costs at your size

Three illustrative deployments, small, medium and large, priced by the library's own `estimateCost()` at AWS
`us-east-1` on-demand rates, and set against the Redis that would hold each one's data.

**The workloads are made up; the arithmetic is not.** Each workload is a guess at what a typical deployment of
that size looks like, not anyone's measured system. Every figure below that comes from the model, the prices or the
library's defaults is generated from them, and `pnpm bench:sizing:check` fails CI when a generated figure and its
source disagree, so when any of them changes, the page is regenerated rather than edited. What the estimator counts
is held by tests to the requests the engine makes; [§11 of the guide](getting-started.md#what-each-term-counts) says
what each term counts.

**There is no latency on this page.** The loaded read path has not been timed inside a region yet, so how fast
these deployments would answer is not published; the [benchmarks page](../benchmarks.md#what-is-still-owed) keeps
it on the list of what is owed.

## Contents

- [The three workloads](#the-three-workloads)
- [What each reader holds](#what-each-reader-holds)
- [The monthly bill](#the-monthly-bill)
- [How much room each has](#how-much-room-each-has)
- [How much the overlap matters](#how-much-the-overlap-matters)
- [What moves the large bill](#what-moves-the-large-bill)
- [Where a standing cache still wins](#where-a-standing-cache-still-wins)
- [Price your own](#price-your-own)
- [What this page does not establish](#what-this-page-does-not-establish)

## The three workloads

<!-- SIZING:INPUTS:START -->
| | who | segments | stored | cold intersects a month | point reads a second | loads a month | hot segments | each read every |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **Small** | a product team keeping its user cohorts | 200 of 1 MB | 200 MB | 20,000 | 1, 50% from cache | 6,000 | 20 in each of 1 reader process | 20 s |
| **Medium** | an ad platform matching audiences | 5,000 of 4 MB | 20 GB | 2,628,000 | 50, 80% from cache | 150,000 | 200 in each of 3 reader processes | 12 s |
| **Large** | a marketplace filtering its catalogue | 200,000 of 10 MB | 2 TB | 52,560,000 | 2,000, 95% from cache | 6,000,000 | 1,000 in each of 20 reader processes | 10 s |
<!-- SIZING:INPUTS:END -->

<!-- SIZING:SHAPE:START -->
Every segment has the shape of the [calibration run's](../../bench/calibration/2026-09-23-94416.md): its ids spread over about 2,000 chunks, and every cold intersect of two segments sharing 100 of them, so each fetches the shared chunks from both. A larger segment is modeled as holding its ids more densely, not as sharing more chunks, which is the most favourable choice for large segments; [the overlap table](#how-much-the-overlap-matters) undoes it. **Hot segments** are the ones a long-lived reader keeps open, each reader its own; the last column is how often one reader reads each of them, with the point reads spread evenly. The large deployment's 10 MB segments load as 2-part uploads, 4 PUT-class requests each, since the S3 driver uploads in 8 MiB parts.
<!-- SIZING:SHAPE:END -->

## What each reader holds

The bill below assumes each reader keeps its hot segments open and answers its point reads from memory at the hit
rates above. Both take memory, and the defaults hold less than the larger deployments need:

<!-- SIZING:READERS:START -->
| | index a reader holds open, at 160 B a chunk | against the default `cache.readerMaxBytes` (64 MiB) | chunks in its hot set | what they hold | against the default `cache.maxChunks` (1,024) | reads it answers, spread evenly |
|---|---:|---|---:|---:|---|---:|
| **Small** | 6 MiB | fits | 40,000 | 20 MB | 39× it | 2.6% |
| **Medium** | 61 MiB | at the limit: raise it | 400,000 | 800 MB | 391× it | 0.26% |
| **Large** | 305 MiB | 4.8× it: raise it, or 209 stay open | 2,000,000 | 10 GB | 1,953× it | 0.051% |
<!-- SIZING:READERS:END -->

A reader past `cache.readerMaxBytes` evicts segments and opens them again as it reads them, a pointer read and a tail
read each, which **neither the bill below nor the estimator's report prices**: the report warns only when there are
more hot segments than `cache.readerMax`, since it cannot see how large each index is. Two more things about these
columns:

- **The index column is the reader's own count, an estimate.** The reader counts each chunk's index entry at the
  fixed size in the column's heading, an estimate reasoned from V8's object layout rather than measured on the heap,
  so leave room above it.
- **The hit rates assume the reads are skewed.** The fifth column is what holding a hot set whole takes, and the
  last is the share of reads a default chunk cache would answer if they were spread evenly over the hot set. The hit
  rates above hold only where most reads fall on a small part of it, or where the chunk cache is raised toward that
  size.

Raising both caches is the price of these figures, paid in each reader's memory.

## The monthly bill

<!-- SIZING:BILL:START -->
| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | the Redis that holds it | **against it** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Small** | $1.63 | $0.53 | $1.05 | $0.14 | under $0.01 | **$3.35** | $35.04 (3 × t4g.micro) | **90% less** |
| **Medium** | $214 | $10.51 | $52.56 | $3.54 | $0.43 | **$281** | $900 (3 × r6g.xlarge) | **69% less** |
| **Large** | $4,289 | $105 | $2,102 | $232 | $42.84 | **$6,771** | $27,325 (3 × r6gd.16xlarge) | **75% less** |
<!-- SIZING:BILL:END -->

<!-- SIZING:REDIS:START -->
Each deployment's Redis is the cheapest cluster that holds its data at its compressed size, at the prices the estimator ships (ElastiCache for Redis OSS, us-east-1 on-demand, AWS price list 20260914063714): every shard a primary and two replicas, each node keeping back the 25% of its memory ElastiCache reserves by default. The large deployment's is a data-tiering cluster, which keeps the values read least recently on its SSD, and which AWS recommends for workloads that regularly read up to 20% of their data. Kept all in memory it would be **$85,509** a month (285 × r6g.xlarge, 95 shards, past ElastiCache's default quota of 90 nodes a cluster), and CloudBitmaps **92% less**.
<!-- SIZING:REDIS:END -->

**Why the Redis follows the data and the bill follows the queries.** Redis holds all the data on nodes billed by the hour, a primary
and its replicas, around the clock: in memory, or on a data-tiering node's SSD for the values read least recently.
So its price follows the data. CloudBitmaps keeps the data in object storage, which is cheap to keep, and pays per
request, so its bill follows the queries. Which of the two is smaller turns on how hard the data is queried, not on
its size alone.

<!-- SIZING:LEANINGS:START -->
**Which way the Redis price leans.** It is the cheapest cluster of one kind, not the least Redis could cost, and its choices lean both ways. Toward Redis: the data is held at its compressed size, where a native Redis bitmap is sized by its highest id, so sparse ids take more memory than this; among node types the cheapest fit wins; a data-tiering node counts its SSD in full, though ElastiCache [moves no item larger than 128 MiB](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/data-tiering.html) to it; and every node keeps back only the 25% reserved by default, where AWS [advises 30% on small nodes and 50% on micro ones](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-memory-management.html) in production. Toward CloudBitmaps: the nodes are on-demand, every shard has two replicas, the engine is Redis OSS, and burstable `t4g` nodes are priced only as one shard. Reserved nodes, fewer replicas, or [ElastiCache for Valkey](https://aws.amazon.com/elasticache/pricing/), which AWS prices 20% lower a node, each cost less, and against them the saving is smaller. To compare with one cluster you name, pass `pricing.redis: { monthlyUSD }`; to price Redis your own way, `pricing.redis: { sizedToData }`.
<!-- SIZING:LEANINGS:END -->

## How much room each has

How many cold intersects a second each deployment could run before its bill meets its Redis, with every other term
held where it is:

<!-- SIZING:HEADROOM:START -->
| | cold intersects a second | where the bill meets its Redis | headroom |
|---|---:|---:|---:|
| **Small** | 0.0076 | 0.16 | 20× |
| **Medium** | 1.0 | 3.9 | 4× |
| **Large** | 20 | 116 | 6× |
<!-- SIZING:HEADROOM:END -->

An extra cold intersect a second of this shape costs the same at any data size, while the Redis it is measured
against grows with the data, so the rate at which the two bills meet rises with the data. It is where the bills
cross, not a capacity: how many requests a second S3 serves is a limit of its own, in
[the section below](#where-a-standing-cache-still-wins).

## How much the overlap matters

<!-- SIZING:OVERLAP_INTRO:START -->
A cold intersect costs 4 + 2k GETs for k shared chunks, so what two segments share sets the price, far more than their size. The tables above use the calibration run's overlap. Segments that are filters over the same catalogue or the same audience can share most of their chunks:
<!-- SIZING:OVERLAP_INTRO:END -->

<!-- SIZING:OVERLAP:START -->
| shared chunks, of 2,000 | GETs a cold intersect | Medium, a month | against its Redis | Large, a month | against its Redis |
|---:|---:|---:|---:|---:|---:|
| 100 (the tables above) | 204 | $281 | 69% less | $6,771 | 75% less |
| 1,000 | 2,004 | $2,174 | 2.4× as much | $44,614 | 1.6× as much |
| 2,000 | 4,004 | $4,276 | 4.8× as much | $86,662 | 3.2× as much |
<!-- SIZING:OVERLAP:END -->

<!-- SIZING:OVERLAP_NOTE:START -->
The medium deployment's bill passes its Redis at **395 shared chunks**, about 20% of a segment's, and the large one's at **589**, about 29%.
<!-- SIZING:OVERLAP_NOTE:END -->
Know your overlap before you trust a verdict: it is the one input that moves these bills most.

## What moves the large bill

Storage, point reads and loads stay small at this size too. What grows is what readers ask S3 for, and both of the
big lines have a lever:

<!-- SIZING:REFRESH:START -->
- **The pointer refresh.** A reader re-reads a segment's pointer on its first read of it after `cache.genTtlMs` has passed, 2 s by default. Here each reader reads each hot segment only every 10 s, so at the default every point read re-reads a pointer, and the point reads are what the refresh costs. Trusting a pointer longer cuts it, at the price of a new load taking up to that long to be seen:
<!-- SIZING:REFRESH:END -->

  <!-- SIZING:LEVERS:START -->
  | `cache.genTtlMs` | pointer refresh | **a month** | against its Redis |
  |---|---:|---:|---:|
  | 2 s, the default | $2,102 | **$6,771** | 75% less |
  | 1 minute | $350 | **$5,019** | 82% less |
  | 5 minutes | $70.08 | **$4,739** | 83% less |
  <!-- SIZING:LEVERS:END -->

- **The cold intersects**, which are priced as if every one started from an empty cache. A reader that serves a
  repeat intersect from memory reads almost nothing, so a deployment whose queries repeat pays less than this table
  says — if its chunk cache is large enough to hold what repeats. By how much is not measured yet; a warm stage in a
  future calibration run would measure it. Fetching neighbouring chunks together would cut the chunk reads, which
  are nearly all of a cold intersect's requests; that changes the hot path, so it needs a design before code.

## Where a standing cache still wins

The estimator will say "lose-zone" and mean it. A single hot path that runs hundreds of cold intersects a second
against the same few segments pays per request for every one of them, while a node in front costs the same however
hard it is used. So does a workload whose whole dataset fits in one small node and is read constantly.

<!-- SIZING:PREFIX:START -->
And S3 has a rate of its own. AWS documents [at least 5,500 GET requests a second per partitioned prefix](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html), and scales a prefix's partitions as its request rate grows, answering `503 Slow Down` while it does. A namespace's segments share one data prefix, with their pointers under another beside it.

The large deployment's reads average **4,140 GETs a second** on its one data prefix, **75%** of that documented rate, before any peak.
<!-- SIZING:PREFIX:END -->
Spread a deployment like that across namespaces, which give it more prefixes, and expect throttling at peaks until S3
has scaled. How far one hot object alone can go is not documented.

In those cases keep a cache tier in front of the hot path, or keep that path where it is, and let CloudBitmaps hold
the long tail: the segments that are too many or too large to keep in RAM, and too rarely read to pay a node for.

## Price your own

<!-- SIZING:SAMPLE:START -->
```ts
import { estimateCost } from '@cloudbitmaps/roaring';

const report = estimateCost({
  segments: [{ sizeBytes: 4_000_000, count: 5_000 }],
  workload: {
    intersectsPerSec: 1, // priced cold
    chunksPerIntersect: 200, // the chunks each intersect fetches, both operands
    readsPerSec: 50,
    cacheHitRate: 0.8,
    loadsPerMonth: 150_000,
    hotSegments: 200, // in each reader process…
    readerProcesses: 3, // …of 3
  },
  // pricing: your region's rates; on GCS or Azure Blob, set storage.requestsPerSizedRead to 2.
});
report.monthlyUSD.total; // $281, the medium deployment above
report.redisBaseline; // $900 a month: 1 shard of 3 cache.r6g.xlarge nodes
report.assumptions.notes; // what it modeled, and what it did not
```
<!-- SIZING:SAMPLE:END -->

Every report says what it modeled and what it left out: which Redis it priced and why, loads or the refresh when you
did not size them, and more hot segments than a reader keeps open. [§11 of the
guide](getting-started.md#11-cost-estimate-it-then-ground-it) has the whole model, and `segment.costReport()` prices a
real segment at its measured size and the store's own `cache.genTtlMs`.

## What this page does not establish

- **Latency.** Nothing here says how fast a query returns; the in-region run is owed.
- **A warm reader's intersects.** They are priced cold, which is the most they can cost.
- **Memory.** What the caches above take in each reader is not priced; it is your reader's memory, not S3's bill.
- **An invoice.** These are list prices applied to modeled request counts, not what AWS would bill; data transfer
  out of the region is not modeled.
- **Other clouds' prices.** The rates are AWS's. GCS and Azure Blob charge differently, and read a pointer or a tail
  in two requests; set both in your own pricing profile.
- **What running Redis takes besides its price.** The comparison is CloudBitmaps' bill for the workload against a
  Redis sized to hold the data, not to its request rate; nor does it price the operations, the failovers or the speed
  of either.
