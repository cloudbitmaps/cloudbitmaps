# CloudBitmaps — benchmarks & the Redis crossover

> **Generated, not hand-written.** The chart and table below are produced by `pnpm bench` from the shipped
> `estimateCost()` + the default `aws-us-east-1-ondemand` pricing, so they can never drift from the
> library's own numbers. The polished, shareable version lives on the [site](../site/benchmarks.html)

CloudBitmaps bills per request and per byte; a Redis-HA node bills a flat monthly rate. Below a certain
sustained read rate, pay-per-use is far cheaper; above it, the flat node wins. This is that crossover.

There is **one** crossover, not two, because a loaded store has no per-id write to plot: data enters as a whole
generation — one object PUT, a few when multipart — which the estimator prices as `loadsPerMonth` rather than as a
rate. Reads are the axis where a flat, always-on node competes.

## The crossover chart

<!-- BENCH:CHART:START -->
![CloudRoaring vs flat Redis-HA cost crossover](../bench/crossover.svg)
<!-- BENCH:CHART:END -->

<!-- BENCH:STATS:START -->
| Scenario | Value | Basis | Verdict |
| --- | --- | --- | --- |
| At-rest (1.2 GiB, no traffic) | **$0.03/mo** | 0.008% of Redis | win-big |
| Read crossover | **329.15 reads/s** | object GETs, cache off | past here a flat tier is cheaper |
| Redis-HA baseline | **$346/mo** | flat | the comparison line |
<!-- BENCH:STATS:END -->

## How these stay honest

Every number above is turned into a **deterministic, build-breaking CI assertion** in
[`tests/bench/anchors.test.ts`](../tests/bench/anchors.test.ts) — a regression or an overclaim fails the
build:

- **Counting is free** — `count()` on a loaded segment performs **0 payload reads**, summing cardinality
  straight from the `.crbm` index.
- **Chunk-skipping works** — a 5%-overlap intersection fetches ≤ 10% of a full two-segment download
  (measured through the metrics sink).
- **Cheap at rest** — the reference ~1.2 GiB set with no traffic costs ≤ 10% of a Redis-HA node.
- **The published crossover is the modelled one** — the estimator's read crossover, at the pessimal cache
  posture, is asserted against the rate this page prints, over the same $346 baseline.
- **The estimator never quotes a cheaper bill than the engine incurs** — priced against the cold GETs a metrics
  sink actually observed for a real read workload, the prediction must land on or above the measured cost.

## Real-cloud calibration — AWS

> ✅ **MEASURED** against real S3 + DynamoDB on **2026-07-25**, `us-east-1`, run id `2026-07-25-60291`.
> Everything else on this page is either the cost **model** (`estimateCost`) or a **local** run. This is the
> section that reports what AWS actually charged.

**This is half of a run.** Its other half metered a NoSQL delta tier that the library no longer has, so those
line items, their unit rates and the latency table they produced are **not** restated here — republishing them
would put a price on a code path you cannot take. What is left is the object-store half, and the object store is
now the whole write path and the whole read path.

The harness that produced the run, and its raw artifact, were removed along with the tier they were built to
meter. The figures below are the record.

### What it cost

| Term | Billed quantity | Rate (`us-east-1` on-demand) | Cost |
| --- | --- | --- | --- |
| S3 PUT/LIST | 22 | $5.00/M | $0.000110 |
| S3 GET | 23 | $0.40/M | $0.000009 |

No total is published for the run: the rows above are two terms out of four, and a "total" over a subset would be
a number no run produced.

**Unit economics that fall out of it** — both are paths the loaded store still takes, so both still describe what
you would pay. Each is a whole operation end to end, so it includes the registry round trip that resolves or
advances the segment's current generation:

| Operation | Measured cost |
| --- | --- |
| `count()` on a published segment | **$0.14 per million** |
| Segment publish (bulk-load → one S3 PUT) | **$5.88 per million** |

For contrast, the reserved-RAM line this project exists to undercut is **$346/mo** — standing, whether or not
you send it traffic. Specifically: an ElastiCache HA cluster of **1 primary + 2 replicas on `cache.m7g.large`**
(~$115/mo single-node). The spec is stated because the number is otherwise unauditable — a reader cannot judge a
baseline without knowing whether it is sized for the reference dataset or several times larger than it. Look up
the instance class and check us.

"Redis" is the legible example of the axis, not the opponent: the axis is **reserved capacity vs metered
requests**, and any always-on node crosses any per-request meter somewhere.

### What this section is not

- **It is prices × wire-metered ops — not the invoice.** AWS billing lags hours and has no per-run granularity,
  so the run tagged its resources (`cloudbitmaps-calibration=<runId>`) and the Cost Explorer comparison followed
  a day later.
- **The measured cost counts S3 PUTs**, which the library's own metrics sink cannot see (it emits no `cold.put`
  event — a known observability gap). That is why the meter sat at the AWS SDK layer instead. PUTs bill at 12.5×
  a GET, so an ingest-heavy workload priced without them is materially understated.
- **It says nothing about latency.** The run was driven from a laptop outside the region, so its wall-clock
  figures were dominated by internet transit and calibrated the **cost** claim only. In-region latency for the
  loaded read path is [owed](#what-is-still-owed), not published.
- **One run, one region, one client, one workload shape.**

## At scale — measured (1K → 10K → 100K segments)

> **Measured, not modeled.** Unlike the cost curve above (which comes from the estimator), the numbers here are
> wall-clock + memory from a real run of `pnpm bench:scale` that builds a fleet of up to 100K segments on local
> disk and reads across all of it. They're machine-dependent — a point-in-time snapshot, **not** a CI gate.

The production-readiness audit flagged three scale risks — an unbounded `.crbm` reader cache, an `O(total)`
fleet-wide registry scan, and intersection unproven under load. This is the measured evidence at fleet scale:

<!-- BENCH:SCALE:START -->
| Fleet | Retained heap (cap 1024) | Peak RSS | Discovery scan |
| --- | --- | --- | --- |
| 1,000 segments | 8.2 MiB | 68.1 MiB | 87.6 ms |
| 10,000 segments | 8.3 MiB | 86.8 MiB | 1,067.9 ms |
| 100,000 segments | 7.4 MiB | 162.2 MiB | 11,606.4 ms |

Intersection of two 2,000,000-id segments (2,000 chunks each, 100 shared): **fetched only 100 of the 2,000 chunks per segment** — the shared keys; the rest skipped by key alignment — in 24.6 ms.

_Measured on Apple M3 Pro (arm64, node v24.18.1). **The bound is the retained heap** (post-GC), flat at 8.2 MiB @ 1,000 · 8.3 MiB @ 10,000 · 7.4 MiB @ 100,000 — the reader cache holds bounded live data regardless of fleet. Process **peak RSS** (shown for context) is a high-water that also folds in the benchmark's own fleet-*seeding* allocations and isn't returned to the OS after GC, so it grows with fleet here — it is not a clean read-path footprint (isolating read-path RSS in a reader-only process is a follow-up). Fleet seeded at ~38–51 durable segments/s (fsync-bound); discovery is LocalFs-filesystem-bound — the `O(total)` **shape** is the point, not the absolute ms._
<!-- BENCH:SCALE:END -->

- **Memory is a function of the working set, not the fleet.** The cold-reader cache is capped by open-segment
  _count_ (`maxOpenSegments`, default 1024) **and** aggregate parsed-index _bytes_ (`maxOpenIndexBytes`, default
  64 MiB), so **retained live heap after reading the _entire_ fleet is flat from 1K to 100K segments** — a 100×
  larger fleet holds the same resident reader set, and unusually _wide_ segments can't pin gigabytes of indices
  while the count looks "in bounds". Peak RSS is shown for context only: it is a **process high-water** that also
  folds in the benchmark's own fleet-_seeding_ allocations (not returned to the OS after GC), so it grows with
  fleet size here and is **not** a clean read-path footprint. The flat **live-heap** column is the bound. Live
  heap plus the soak's native-memory watch prove **no leak** on the read path; the hard RSS ceiling under a
  cgroup `--memory` limit ships as `pnpm rss-gate` (a soak under a hard `docker --memory` ceiling with swap off;
  an OOM-kill → exit 137).
- **The fleet-wide registry scan is `O(total segments)`** — the near-linear "discovery" column is the
  enumeration that every admin pass (`checkConsistency`, `retireExpired`, `eraseSubject`) pays before it does any
  work. **No read verb enumerates**: `has`, `count`, `iterate` and `intersect` each address one segment. An
  indexed-enumeration cursor that would bound it is a documented deferral.
- **Chunk-skipping intersection holds at scale** — intersecting two large multi-chunk segments fetches only the
  shared chunks and skips the rest by key alignment (the crown jewel, on the ids-per-segment axis). The
  load-bearing figure there is the chunk **count** — 100 fetched of 2,000 — because key alignment does not depend
  on how the ids inside a chunk are distributed. The accompanying **bytes** figure does: this fixture seeds each
  chunk with a contiguous run of ids, which Roaring stores as a run container of a few dozen bytes, so ~30 bytes
  per fetched chunk is a **best case for the encoding** rather than a typical segment. Real ids at that density
  are scattered and land in an array container nearer 2 KB per chunk. Read the byte count as "the window is
  small and bounded", not as a size to plan a bill around — for that, price the requests.

## Caveats

- **Default pricing** (`aws-us-east-1-ondemand`, cache off). Your region, cloud, committed term and cache-hit
  rate all move the crossover — feed your own `PricingProfile` and workload to `estimateCost()`.
- **Model, not a cloud bill** — the dollars in the crossover chart come from the cost formulas + published
  rates. Measured AWS dollars live in [Real-cloud calibration](#real-cloud-calibration--aws).
- **Three kinds of number here.** The crossover chart is _modeled money_ (estimator, deterministic, CI-gated);
  the at-scale table is _measured memory + wall-clock_ (real run on local disk, machine-dependent, never
  CI-gated — shared runners are too noisy); and the real-cloud section is _measured AWS cost_ (owner-run against
  a real account, 2026-07-25). Only the third is cloud-calibrated, and even then the dollars are published prices
  applied to wire-metered requests, not the invoice itself.
- **Rates are the vendor's to change, and are region-specific.** Every dollar figure in this document uses the
  repo's default `aws-us-east-1-ondemand` profile, dated where it was measured. Treat the _ratios_ as the durable
  finding and re-derive any absolute figure from your own region and contract — `estimateCost()` takes a
  `PricingProfile` so you can plug your real rates in rather than trusting ours.

## What is still owed

The loaded store's own measurements are the next benchmark pass, and none of them is published yet:

- **Load throughput** — sustained `bulkLoadCrbmGeneration` rate and cost against a real object store, at the
  segment sizes a real refresh produces. The at-scale table's seed rate is local disk, fsync-bound, and is not
  that number.
- **Intersect latency** — in-region wall-clock for a chunk-skipping `A ∩ B`, and for `andNot` with a large
  `exclude`, against a real object store rather than local disk.
- **RSS soak** — a recorded envelope from `pnpm rss-gate`. The gate exists and has teeth (an OOM-kill fails the
  build), but no measured RSS figure from it is published here.

Nothing above should be read as covering any of the three.

## Reproduce

```sh
pnpm bench         # builds, then regenerates bench/crossover.svg, bench/results.json, and the cost table here + the site
pnpm bench:scale   # HEAVY: builds a fleet up to 100K segments on local disk (fsync-bound), measures, rewrites the at-scale table
SCALE_FLEETS=1000,10000 pnpm bench:scale   # smaller + faster for a quick check
pnpm soak          # sustained loaded-store reads + combines + re-loads; heap/native creep verdict
pnpm rss-gate      # the same soak under a hard cgroup --memory ceiling (needs Docker)
```

The formulas are in `packages/core/src/core/cost.ts` — every rate, the crossover derivation and what each term
does and does not model are stated there — and the
[getting-started guide](guide/getting-started.md) covers the estimator API.
