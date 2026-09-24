# What it costs at your size

Three illustrative deployments, small, medium and large, priced by the library's own `estimateCost()` at AWS
`us-east-1` on-demand rates.

**The workloads are made up; the arithmetic is not.** Each workload is a guess at what a typical deployment of
that size looks like, not anyone's measured system. Every dollar figure below comes out of the same function a
caller gets, and `pnpm bench:sizing:check` fails CI if this page and the estimator disagree, so when the model or
the prices change, the tables are regenerated rather than edited. What the estimator counts is held by tests to
the requests the engine makes; [§11 of the guide](getting-started.md#what-each-term-counts) says what each term
counts.

**There is no latency on this page.** The loaded read path has not been timed inside a region yet, so how fast
these deployments would answer is not published; the [benchmarks page](../benchmarks.md#what-is-still-owed) keeps
it on the list of what is owed.

## Contents

- [The three workloads](#the-three-workloads)
- [The monthly bill](#the-monthly-bill)
- [What the numbers say](#what-the-numbers-say)
- [Where a standing cache still wins](#where-a-standing-cache-still-wins)
- [Price your own](#price-your-own)
- [What this page does not establish](#what-this-page-does-not-establish)

## The three workloads

<!-- SIZING:INPUTS:START -->
| | who | segments | stored | cold intersects a month | point reads a second | loads a month | hot segments |
|---|---|---:|---:|---:|---:|---:|---:|
| **Small** | a product team keeping its user cohorts | 200 of 1 MB | 200 MB | 20,000 | 1, 50% from cache | 6,000 | 20 in each of 1 reader process |
| **Medium** | an ad platform matching audiences | 5,000 of 4 MB | 20 GB | 2,628,000 | 50, 80% from cache | 150,000 | 200 in each of 3 reader processes |
| **Large** | a marketplace filtering its catalogue | 200,000 of 10 MB | 2 TB | 52,560,000 | 2,000, 95% from cache | 6,000,000 | 1,000 in each of 20 reader processes |
<!-- SIZING:INPUTS:END -->

Every segment has the shape of the [calibration run's](../../bench/calibration/2026-09-23-94416.md): its ids spread
over about 2,000 chunks, and every cold intersect of two segments sharing 100 of them, so each fetches the shared chunks
from both. A larger segment holds its ids more densely; it does not share more chunks. **Hot segments** are the ones
a long-lived reader keeps open and reads at least once every `cache.genTtlMs`, 2 s by default; each reader process
keeps its own. The large deployment's 10 MB segments load as two-part uploads.

## The monthly bill

<!-- SIZING:BILL:START -->
| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | against the $346 node |
|---|---:|---:|---:|---:|---:|---:|---|
| **Small** | $1.63 | $0.53 | $1.05 | $0.14 | $0.00 | **$3.35** | under a tenth of it |
| **Medium** | $214 | $10.51 | $52.56 | $3.54 | $0.43 | **$281** | under it |
| **Large** | $4,289 | $105 | $2,102 | $232 | $42.84 | **$6,771** | 19.6× it |
<!-- SIZING:BILL:END -->

**How to read the last column.** The comparison line is the estimator's: one Redis-HA cluster, a primary and two
replicas on `cache.m7g.large`, at its on-demand price. For the small deployment that is a fair fight. For the
medium and large ones it flatters Redis, because their data would not fit in one cluster's memory: holding
gigabytes or terabytes of bitmaps in RAM takes many such clusters, and the estimator prices only the one. Pass
`pricing.redis.monthlyUSD` for the cluster that would actually hold your data, and the verdict changes with it.

## What the numbers say

- **Small: every term is small, and none is a node.** Nothing runs between queries. A team this size pays for
  requests it makes and bytes it stores, and the whole month is less than a tenth of the one cluster.
- **Medium: under one cluster, while holding data one cluster could not.** Cold intersects are most of the bill:
  one a second, every one priced as if nothing were cached, its pointers, indexes and shared chunks all read from
  S3. The pointer refresh is the next line: three readers keep two hundred segments open each, and a point read
  that finds its segment's pointer lapsed reads it again, so here the point reads are what bound it.
- **Large: cold intersects and the pointer refresh are the bill.** Storage, point reads and loads stay small at
  this size too; what grows is what a reader asks S3 for. Both of the big lines have a lever:
  - **The refresh** is set by `cache.genTtlMs`. Each reader re-reads a hot segment's pointer once per TTL, so
    trusting a pointer longer cuts it, at the price of a new load taking up to that long to be seen:

    <!-- SIZING:LEVERS:START -->
    | `cache.genTtlMs` | pointer refresh | **a month** |
    |---|---:|---:|
    | 2 s, the default | $2,102 | **$6,771** |
    | 1 minute | $350 | **$5,019** |
    | 5 minutes | $70.08 | **$4,739** |
    <!-- SIZING:LEVERS:END -->

  - **The cold intersects** are priced as if every one started from an empty cache. A reader that serves a repeat
    intersect from memory reads almost nothing, so a deployment whose queries repeat pays less than this table
    says. By how much is not measured yet; a warm stage in a future calibration run would measure it. Fetching
    neighbouring chunks
    together would cut the chunk reads, which are nearly all of a cold intersect's requests; that changes the hot
    path, so it needs a design before code.

## Where a standing cache still wins

The estimator will say "lose-zone" and mean it. A single hot path that runs hundreds of cold intersects a second
against the same few segments pays per request for every one of them, while a node in front costs the same however
hard it is used. So does a workload whose whole dataset fits in one small node and is read constantly. And S3 has a
ceiling of its own: AWS documents
[5,500 GET requests a second per partitioned prefix](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html),
and one hot segment is one object, so a hot path concentrated on a pair of segments reaches it long before the
bucket does. In those cases keep a cache tier in front of the hot path, or keep that path where it is, and let
CloudBitmaps hold the long tail: the segments that are too many or too large to keep in RAM, and too rarely read to
pay a node for.

## Price your own

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
    readerProcesses: 3, // …of three
  },
  // pricing: your region's rates; on GCS or Azure Blob, set storage.requestsPerSizedRead to 2.
});
report.monthlyUSD; // the bill, term by term
report.assumptions.notes; // what it modeled, and what it did not
```

Every report says what it left out: loads or the refresh when you did not size them, and a hot set larger than a
reader keeps open. [§11 of the guide](getting-started.md#11-cost-estimate-it-then-ground-it) has the whole model,
and `segment.costReport()` prices a real segment at its measured size and the store's own `cache.genTtlMs`.

## What this page does not establish

- **Latency.** Nothing here says how fast a query returns; the in-region run is owed.
- **A warm reader's intersects.** They are priced cold, which is the most they can cost.
- **An invoice.** These are list prices applied to modelled request counts, not what AWS would bill; data transfer
  out of the region is not modeled.
- **Other clouds' prices.** The rates are AWS's. GCS and Azure Blob charge differently, and read a pointer or a tail
  in two requests; set both in your own pricing profile.
- **Redis sized to the data.** The comparison is with one cluster, whatever the data size.
