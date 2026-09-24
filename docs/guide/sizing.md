# What it costs at your size

Three illustrative deployments, small, medium and large, priced by the library's own `estimateCost()` at AWS
`us-east-1` on-demand rates.

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
| | index a reader holds open | against the default `cache.readerMaxBytes` (64 MiB) | chunks in its hot set | against the default `cache.maxChunks` (1,024) |
|---|---:|---|---:|---|
| **Small** | 6 MiB | fits | 40,000 | 39× it |
| **Medium** | 61 MiB | at the limit: raise it | 400,000 | 391× it |
| **Large** | 305 MiB | 4.8× it: raise it, or 209 stay open | 2,000,000 | 1,953× it |
<!-- SIZING:READERS:END -->

A reader past `cache.readerMaxBytes` evicts segments and opens them again as it reads them, a pointer read and a tail
read each, which **neither the bill below nor the estimator's report prices**: the report warns only when there are
more hot segments than `cache.readerMax`, since it cannot see how large each index is. And a hit rate like the large
deployment's needs a chunk cache many times the default. Raising both is the price of those figures, paid in each
reader's memory.

## The monthly bill

<!-- SIZING:BILL:START -->
| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | against one $346 Redis-HA cluster |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Small** | $1.63 | $0.53 | $1.05 | $0.14 | under $0.01 | **$3.35** | <1% |
| **Medium** | $214 | $10.51 | $52.56 | $3.54 | $0.43 | **$281** | 81% |
| **Large** | $4,289 | $105 | $2,102 | $232 | $42.84 | **$6,771** | 19.6× |
<!-- SIZING:BILL:END -->

**How to read the last column.** It is the estimator's verdict, against one Redis-HA cluster: a primary and two
replicas on `cache.m7g.large`, at its on-demand price. It is the wrong size for every one of these deployments, and
in both directions (inferred from the instance class, not checked by anything here):

- the small deployment's data would fit a far smaller node, so the comparison is kind to CloudBitmaps there, though
  its bill stays small either way;
- the medium and large deployments' data would not fit in one cluster's memory at all: holding gigabytes or
  terabytes of bitmaps in RAM takes many such clusters, and the estimator prices only the one. There the comparison
  is kind to Redis.

The large deployment's verdict is a **lose-zone**, and it is meant: pay-per-use costs many times the one cluster.
Pass `pricing.redis.monthlyUSD` for the cluster that would actually hold your data, and the verdict changes with it.

## How much the overlap matters

A cold intersect costs 4 + 2k GETs for k shared chunks, so what two segments share sets the price, far more than
their size. The tables above use the calibration run's overlap. Segments that are filters over the same catalogue or
the same audience can share most of their chunks:

<!-- SIZING:OVERLAP:START -->
| shared chunks, of 2,000 | GETs a cold intersect | Medium, a month | Large, a month |
|---:|---:|---:|---:|
| 100 (the tables above) | 204 | $281 (81%) | $6,771 (19.6×) |
| 1,000 | 2,004 | $2,174 (6.3×) | $44,614 (128.9×) |
| 2,000 | 4,004 | $4,276 (12.4×) | $86,662 (250.5×) |
<!-- SIZING:OVERLAP:END -->

<!-- SIZING:OVERLAP_NOTE:START -->
The medium deployment's bill passes the cluster's price at **131 shared chunks**, about 7% of a segment's.
<!-- SIZING:OVERLAP_NOTE:END -->
Know your overlap before you trust a verdict: it is the one input that moves these bills most.

## What moves the large bill

Storage, point reads and loads stay small at this size too. What grows is what readers ask S3 for, and both of the
big lines have a lever:

<!-- SIZING:REFRESH:START -->
- **The pointer refresh.** A reader re-reads a segment's pointer on its first read of it after `cache.genTtlMs` has passed, 2 s by default. Here each reader reads each hot segment only every 10 s, so at the default every point read re-reads a pointer, and the point reads are what the refresh costs. Trusting a pointer longer cuts it, at the price of a new load taking up to that long to be seen:
<!-- SIZING:REFRESH:END -->

  <!-- SIZING:LEVERS:START -->
  | `cache.genTtlMs` | pointer refresh | **a month** |
  |---|---:|---:|
  | 2 s, the default | $2,102 | **$6,771** |
  | 1 minute | $350 | **$5,019** |
  | 5 minutes | $70.08 | **$4,739** |
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

And S3 has a rate of its own. AWS documents
[at least 5,500 GET requests a second per partitioned prefix](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html),
and scales a prefix's partitions as its request rate grows, answering `503 Slow Down` while it does. A namespace's
segments share one data prefix, with their pointers under another beside it:

<!-- SIZING:PREFIX:START -->
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
report.assumptions.notes; // what it modeled, and what it did not
```
<!-- SIZING:SAMPLE:END -->

Every report says what it modeled and what it left out: loads or the refresh when you did not size them, and more hot
segments than a reader keeps open. [§11 of the guide](getting-started.md#11-cost-estimate-it-then-ground-it) has the
whole model, and `segment.costReport()` prices a real segment at its measured size and the store's own
`cache.genTtlMs`.

## What this page does not establish

- **Latency.** Nothing here says how fast a query returns; the in-region run is owed.
- **A warm reader's intersects.** They are priced cold, which is the most they can cost.
- **Memory.** What the caches above take in each reader is not priced; it is your reader's memory, not S3's bill.
- **An invoice.** These are list prices applied to modeled request counts, not what AWS would bill; data transfer
  out of the region is not modeled.
- **Other clouds' prices.** The rates are AWS's. GCS and Azure Blob charge differently, and read a pointer or a tail
  in two requests; set both in your own pricing profile.
- **Redis sized to the data.** The comparison is with one cluster, whatever the data size.
