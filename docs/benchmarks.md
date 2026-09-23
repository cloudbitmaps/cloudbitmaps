# CloudBitmaps — benchmarks & the Redis crossover

> **Generated, not hand-written.** The chart and table below are produced by `pnpm bench` from the shipped
> `estimateCost()` + the default `aws-us-east-1-ondemand` pricing, so they can never drift from the
> library's own numbers. The polished, shareable version lives on the [site](../site/benchmarks.html)

CloudBitmaps bills per request and per byte; a Redis-HA node bills a flat monthly rate. Below a certain
sustained read rate, pay-per-use is far cheaper; above it, the flat node wins. This is that crossover.

There is **one** crossover, not two, because a loaded store has no per-id write to plot: data enters as a whole
generation — one object PUT, a few when multipart, then the pointer — which the estimator prices as `loadsPerMonth`
rather than as a rate. Reads are the axis where a flat, always-on node competes.

## The crossover chart

<!-- BENCH:CHART:START -->
![CloudBitmaps vs flat Redis-HA cost crossover](../bench/crossover.svg)
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
- **Chunk-skipping works** — the chunks a 5%-overlap intersection fetches come to ≤ 10% of the bytes of a full
  two-segment download (measured through the metrics sink, which counts chunk reads).
- **Cheap at rest** — the reference ~1.2 GiB set with no traffic costs ≤ 10% of a Redis-HA node.
- **The published crossover is the modelled one** — the estimator's read crossover, at the pessimal cache
  posture, is asserted against the rate this page prints, over the same $346 baseline.
- **The estimator never quotes fewer chunk reads than the engine makes** — priced against the chunk GETs a metrics
  sink observed for a point-read workload on an in-memory store, the prediction must land on or above the measured
  cost. That covers chunk reads only: the estimator has no term yet for the pointer and tail reads a single-bucket
  store adds, which [the single-bucket bill](#the-single-bucket-bill--run-2026-09-23-94416) measured.

## Real-cloud calibration — AWS

Two runs have been metered against real S3 in `us-east-1`. Both were driven from a laptop outside the region, so
both calibrate **cost**, and neither publishes a latency:

| Run | Topology | What it establishes |
| --- | --- | --- |
| `2026-09-23-94416` | the one that ships: the pointer lives in the same bucket as the data | the single-bucket bill for a cold intersect and a load, and chunk-skipping on real S3 |
| `2026-07-25-60291` | a retired one: the pointer lived in a NoSQL table | the object-store half of that shape |

### The single-bucket bill — run `2026-09-23-94416`

> **Measured** against real S3 in `us-east-1` on 2026-09-23 (UTC), from a laptop 83 ms from the region, with the
> packages at `0.10.0`. The run's report explains every figure, with a diagram for each:
> [`bench/calibration/2026-09-23-94416.md`](../bench/calibration/2026-09-23-94416.md). The evidence beside it is the
> harness's own results file. [`tests/docs/calibration-reports.test.ts`](../tests/docs/calibration-reports.test.ts)
> holds this section and the report to it in both directions: every dollar amount, percentage, duration and byte
> size, every count of requests, chunks, ids and loads, and the bill below, row by row.

**What it establishes:**

- **Chunk-skipping works on real S3.** 40 of 40 cold intersects of two 500,000-id segments returned the planned ids,
  checked by count and by sum. Each fetched 100 of 1,999 chunks per segment, the 100 the two share, and skipped the
  other 95.0%.
- **The median cold intersect of that shape made 206 GETs**: one 256 KiB tail read per operand, one GET per shared
  chunk per operand, and each operand's pointer read twice, because from the laptop an intersect outlasted the
  store's 2 s pointer refresh. With each pointer read once, as inside the region, it makes 204 GETs: 4 + 2k
  for k shared chunks, whatever the segments' size, while each index fits the tail read: up to about 26,000 chunks
  of this shape.
- **Writing and publishing a segment is 2 PUT + 3 GET**: the generation, then the pointer, and the loader, the
  publish step and the registry each read the pointer first. A multipart load adds the upload's own requests.
  `store.load()` also lists the segment's objects and collects the old ones; a test counts what that adds.

| Operation | Requests | One | Per million | Label |
| --- | --- | --- | --- | --- |
| Cold intersect, two 500,000-id segments sharing 100 of 1,999 chunks, the median measured | 206 GET | $0.0000824 | **$82.40** | derived |
| The same, with each pointer read once | 204 GET | $0.0000816 | $81.60 | expected |
| Write and publish a 1.05 MB segment with `bulkLoadCrbmGeneration`, pointer included | 2 PUT + 3 GET | $0.0000112 | **$11.20** | derived |
| Write and publish a 12.6 MB segment, multipart | 5 PUT-class + 3 GET | $0.0000262 | **$26.20** | derived |
| A segment's first `store.load()`, single-part | 4 PUT-class + 7 GET | $0.0000228 | $22.80 | expected |

**Derived** rows are measured request counts times the `aws-us-east-1-ondemand` list prices. **Expected** rows are
what the code predicts where the run did not measure: the first from the measured chunk and tail reads with each
pointer read once, the second from a test that counts `store.load()`'s requests. PUT-class requests are the ones S3
bills at the PUT rate, listings included. The whole run was 34 PUT-class and 8,279 GET-class requests, teardown
included, and its requests cost $0.0034816. Data transfer is not in that figure.

**Against the $346-a-month Redis-HA line**, that is 4.2 million cold intersects of this shape a month, 1.6 every
second, or 30.9 million writes and publishes. Below those rates this design costs less; above them, the standing
node does. Every intersect in the run was cold on purpose. A long-lived reader answers a repeat from memory, and pays
instead for the pointer refresh: at most one GET per segment every 2 s while the segment is being read.

**What it does not establish:**

- **Latency or throughput.** The client was 83 ms from the region, so its intersect times and upload rates measured
  the laptop's connection. The report records them with that explanation; they are not published here, and the
  in-region run is [owed](#what-is-still-owed).
- **What `store.load()` costs on S3.** The run measured the write and the publish. The `store.load()` row is counted
  by a test, not measured.
- **Other shapes**: more operands, other overlaps, `andNot` with an `exclude`, the `*Into` verbs.

**`estimateCost()` does not count the pointer or the tail reads yet.** It prices a load as `requestsPerLoad`
PUT-class requests (1 by default, which is $5 per million loads) and an intersect as `chunksPerIntersect` GETs, and
it has no term for the pointer refresh. Until it counts them itself, pass `requestsPerLoad: 2.24`, which prices a
single-bucket write and publish at $11.20 per million, and `chunksPerIntersect: 204` for a cold intersect of this
shape. The fix is [owed](#what-is-still-owed).

### The July 2026 run — `2026-07-25-60291`, the object-store half of a retired topology

> ✅ **MEASURED** against real S3 + DynamoDB on **2026-07-25**, `us-east-1`, run id `2026-07-25-60291`.
> The registry in that run was a NoSQL table. **CloudBitmaps no longer ships one** — the registry now lives in
> the object store beside the data — so read the pointer-round-trip caveat below before reusing these numbers.
> Everything else on this page is the cost **model** (`estimateCost`), a **local** run, or the single-bucket run
> above. This section and that one price each run's metered requests at list prices.

**This is half of a run.** The other half is DynamoDB's two line items, and they covered both of that
topology's NoSQL uses: the delta tier the library no longer has, and the pointer round trip that resolved a
segment's current generation. Neither is restated here — republishing the first would put a price on a code
path you cannot take, and the second is priced differently now that the pointer lives in the object store. What is left is the object-store half, and the object store is
now the whole write path and the whole read path.

The harness that produced the run, and its raw artifact, were removed along with the tier they were built to
meter. The figures below are the record. Its replacement meters the topology that ships, and its first publishable
run is [the single-bucket bill above](#the-single-bucket-bill--run-2026-09-23-94416).

#### What it cost

| Term | Billed quantity | Rate (`us-east-1` on-demand) | Cost |
| --- | --- | --- | --- |
| S3 PUT/LIST | 22 | $5.00/M | $0.000110 |
| S3 GET | 23 | $0.40/M | $0.000009 |

No total is published for the run: the rows above are two terms out of four, and a "total" over a subset would be
a number no run produced.

**Unit economics that fall out of it** — both are paths the loaded store still takes, so both still describe the
object-store half of what you would pay. In the measured run, the round trip that resolves or advances the
segment's current generation was billed to the NoSQL registry, whose line items are withheld — so these two
figures are the S3 cost **excluding** that pointer access:

| Operation | Measured cost |
| --- | --- |
| `count()` on a published segment | **$0.14 per million** |
| Segment publish (bulk-load → one S3 PUT), superseded: it leaves out the pointer, which the single-bucket bill above includes | **$5.88 per million** |

For contrast, the reserved-RAM line this project exists to undercut is **$346/mo** — standing, whether or not
you send it traffic. Specifically: an ElastiCache HA cluster of **1 primary + 2 replicas on `cache.m7g.large`**
(~$115/mo single-node). The spec is stated because the number is otherwise unauditable — a reader cannot judge a
baseline without knowing whether it is sized for the reference dataset or several times larger than it. Look up
the instance class and check us.

"Redis" is the legible example of the axis, not the opponent: the axis is **reserved capacity vs metered
requests**, and any always-on node crosses any per-request meter somewhere.

#### What this section is not

- **It is prices × wire-metered ops — not the invoice.** AWS billing lags hours and has no per-run granularity,
  so the run tagged its resources (`cloudbitmaps-calibration=<runId>`) and the Cost Explorer comparison followed
  a day later.
- **The measured cost counts S3 PUTs**, which the library's own metrics sink cannot see (it emits no `storage.put`
  event — a known observability gap). That is why the meter sat at the AWS SDK layer instead. PUTs bill at 12.5×
  a GET, so an ingest-heavy workload priced without them is materially understated.
- **The registry it measured is not the registry that ships.** Generation resolution ran against a NoSQL table
  in that run; today the pointer is an object in the same bucket, so the same operations additionally pay
  object-store requests for it (GETs to resolve, a conditional PUT to advance) that are not in the two rows
  above. The September run measured them, in [the single-bucket bill](#the-single-bucket-bill--run-2026-09-23-94416).
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

- **Memory is a function of the working set, not the fleet.** The storage-reader cache is capped by open-segment
  _count_ (`maxOpenSegments`, default 1024) **and** aggregate parsed-index _bytes_ (`maxOpenIndexBytes`, default
  64 MiB), so **retained live heap after reading the _entire_ fleet is flat from 1K to 100K segments** — a 100×
  larger fleet holds the same resident reader set, and unusually _wide_ segments can't pin gigabytes of indices
  while the count looks "in bounds". Peak RSS is shown for context only: it is a **process high-water** that also
  folds in the benchmark's own fleet-_seeding_ allocations (not returned to the OS after GC), so it grows with
  fleet size here and is **not** a clean read-path footprint. The flat **live-heap** column is the bound. Live
  heap plus the soak's native-memory watch prove **no leak** on the read path.
- **The hard RSS ceiling — measured.** A sustained read + combine + re-load workload over **400 segments**
  completes inside a hard **384 MiB** cgroup ceiling with swap disabled (`--memory-swap == --memory`), so the
  limit is a true RSS bound rather than a heap one, and it covers the roaring addon's **off-heap** memory that
  a JS heap sample cannot see. No OOM-kill; both creep verdicts inside their bands. `pnpm rss-gate` records the
  run to `bench/rss-gate-results.json`, which the site figure gate checks the published number against.

  **Why a ceiling and not an RSS reading.** The ceiling is a property of the workload; a reader-process RSS
  figure is a property of the machine, and published as a headline it gets read as a spec the project has not
  promised. The two are easy to tell apart here because two very different machines were compared: a Linux CI
  runner and an Apple M3 Pro under Docker landed **0.4 MiB apart** on reader RSS (69.5 vs 69.9 MiB) while
  throughput differed **3.7×** (12.7/s vs 46.7/s). The memory envelope travels; the rate does not — which is
  exactly why this figure is published and the latency figures above it still are not.

- **The fleet-wide registry scan is `O(total segments)`** — the near-linear "discovery" column is the
  enumeration that every admin pass (`checkConsistency`, `retireExpired`, `eraseSubject`, `subjectReport`)
  pays before it does any
  work. **No read verb enumerates**: `has`, `count`, `iterate` and `intersect` each address one segment. The
  retention sweep is the one pass that no longer has to pay it — `retireExpired({ scan: 'index' })` reads a
  due-day index instead of the fleet — but `checkConsistency`, `eraseSubject` and `subjectReport` still
  enumerate, and the
  column below is that enumeration.
- **Chunk-skipping intersection holds at scale** — intersecting two large multi-chunk segments fetches only the
  shared chunks and skips the rest by key alignment (the crown jewel, on the ids-per-segment axis). The
  load-bearing figure there is the chunk **count** — 100 fetched of 2,000 — because key alignment does not depend
  on how the ids inside a chunk are distributed. The accompanying **bytes** figure does: this fixture seeds each
  chunk with a contiguous run of ids, which Roaring stores as a run container of a few dozen bytes, so ~30 bytes
  per fetched chunk is a **best case for the encoding** rather than a typical segment. Real ids at that density
  are scattered and land in an array container nearer 2 KB per chunk. Read the byte count as "the window is
  small and bounded", not as a size to plan a bill around — for that, price the requests.

## What RSS is, and why it is the number we bound

The memory figures above are **RSS**, not heap. The difference is the whole reason the bound is meaningful, so
it is worth stating plainly.

### What RSS is

**Resident Set Size** is the amount of physical RAM a process occupies right now — not what it reserved, not
what it might use. It is the number your OS reports (`top`, Activity Monitor, `docker stats`), and it is the
number the kernel consults when a container hits its memory limit and something has to die.

### Why RSS and not the JavaScript heap

CloudBitmaps does its set arithmetic through `roaring-node`, a **native addon**. Native code allocates with
`malloc`, entirely outside V8's JavaScript heap. So a process holding a large bitmap looks like this:

```
┌──────────────── RSS — what the OS sees ────────────────┐
│  Node binary, shared libraries      ~50–60 MiB, a floor │
│  V8 JavaScript heap                 ← heap sampling     │
│  roaring's containers               ← INVISIBLE to it   │
│  stacks, buffers, allocator arenas  ← invisible too     │
└─────────────────────────────────────────────────────────┘
```

**A leak in the bitmap containers is invisible to a heap sample.** The heap graph stays flat while the process
grows until the kernel kills it. Since ["bounded memory & cost, always"](../CLAUDE.md) is one of this project's
hard invariants, a measurement that cannot see the allocator doing the most work would be evidence of nothing.

RSS is the only figure that includes all of it. That is why the ceiling is expressed in RSS, and why
`--memory-swap` is pinned equal to `--memory`: with swap enabled a process that outgrows RAM merely spills to
disk and keeps running, and the limit stops being a memory bound at all. With swap off it is a hard wall.

### Why a ceiling is published, and not a number

The gate answers a **pass/fail** question — *did this workload survive inside 384 MiB, or was it OOM-killed?* —
rather than reporting a measurement. Two reasons the reading is the less useful half:

1. **It is mostly Node.** The harness labels its own figure `~Node floor`: an idle Node process already sits
   around 50–60 MiB, so the workload's contribution is small against that baseline. Quoting the total would
   mostly be quoting the runtime.
2. **It moves with the machine** — allocator behaviour, page size, what the OS has handed back. Published as a
   headline it would be read as a specification this project has not promised.

The ceiling, by contrast, is a property of *the workload and the bound*, which is what the gate actually
establishes and what a reader can act on.

The two-machine comparison is the evidence for that split, and it is why this figure is published while the
latency figures under [What is still owed](#what-is-still-owed) are not:

| | reader-process RSS | throughput |
|---|---|---|
| Linux CI runner | 69.5 MiB | 12.7 iters/s |
| Apple M3 Pro under Docker | 69.9 MiB | 46.7 iters/s |
| **spread** | **0.4 MiB** | **3.7×** |

Same workload, same code, two very different machines. **The memory envelope travels; the rate does not.** A
memory bound is therefore something we can state for your machine as well as ours. A latency number is not,
which is why none is published until an in-region run produces one.

## Caveats

- **Default pricing** (`aws-us-east-1-ondemand`, cache off). Your region, cloud, committed term and cache-hit
  rate all move the crossover — feed your own `PricingProfile` and workload to `estimateCost()`.
- **Model, not a cloud bill** — the dollars in the crossover chart come from the cost formulas + published
  rates. Measured AWS dollars live in [Real-cloud calibration](#real-cloud-calibration--aws).
- **Three kinds of number here.** The crossover chart is _modeled money_ (estimator, deterministic, CI-gated);
  the at-scale table is _measured memory + wall-clock_ (real run on local disk, machine-dependent, never
  CI-gated — shared runners are too noisy); and the real-cloud section is _measured AWS cost_ (owner-run against
  a real account, on 2026-07-25 and 2026-09-23). Only the third is cloud-calibrated, and even then the dollars are
  published prices applied to wire-metered requests, not the invoice itself.
- **Rates are the vendor's to change, and are region-specific.** Every dollar figure in this document uses the
  repo's default `aws-us-east-1-ondemand` profile, dated where it was measured. Treat the _ratios_ as the durable
  finding and re-derive any absolute figure from your own region and contract — `estimateCost()` takes a
  `PricingProfile` so you can plug your real rates in rather than trusting ours.

## What is still owed

The loaded store's own measurements are the next benchmark pass. The single-bucket bill is measured
([above](#the-single-bucket-bill--run-2026-09-23-94416)); these are not published yet:

- **Load throughput** — sustained `bulkLoadCrbmGeneration` rate against a real object store, from inside the
  region, at the segment sizes a real refresh produces. The September run's upload rates timed whole loads from a
  laptop 83 ms from the region, and the at-scale table's seed rate is local disk, fsync-bound; neither is that
  number.
- **Intersect latency** — in-region wall-clock for a chunk-skipping `A ∩ B`, and for `andNot` with a large
  `exclude`, against a real object store rather than local disk.
- **What `store.load()` costs on S3.** The run measured a load's write and publish. `store.load()` adds a listing
  to choose the generation number and a collection pass after the publish. A test counts the requests that adds,
  which about doubles a load's bill; they are not yet measured on S3.
- **An estimator that counts the pointer and the tail reads.** `estimateCost()` has no term for the pointer's
  requests in a load or an intersect, none for an intersect's tail reads, and none for the pointer refresh, so it
  under-quotes both operations in the single-bucket topology; see
  [the single-bucket bill](#the-single-bucket-bill--run-2026-09-23-94416) for the figures to use until it does.
- **A Lambda figure** — a function's cold start and initialisation against a real store, from inside one.

**The harness is built, and has run for real from a laptop.** [`bench/calibrate-aws.cjs`](../bench/calibrate-aws.cjs)
(`pnpm calibrate:aws`) measures, in one run against a real bucket, load throughput single-part and multipart; cold
`A ∩ B` latency for two 500,000-id operands spanning ~2,000 chunks with 100 shared — the chunk-skipping ratio the
at-scale section reports, at a quarter of its density; and every request the single-bucket topology bills, pointer
reads and conditional PUTs included, counted attempt by attempt. Each intersect must return exactly the planned ids
or no latency is reported, and each pins its store's pointers, so a cold intersect's request count does not move
with the network. Every run records its own round-trip floor to the region and labels its latency in-region only
below 30 ms — a line that keeps another continent out, not a neighbouring region, so the raw floor is recorded with
it for a reader who wants a stricter one. Its run `2026-09-23-94416`, from a laptop, paid the cost side above; the
in-region run from AWS CloudShell pays the rest. `andNot` with a large `exclude`, and `store.load()` itself, are not in it yet.
How it guards against spending more than it says, and how to run it from inside the region:
[`bench/README.md`](../bench/README.md#real-cloud-calibration).

Nothing above should be read as covering any of these.

<!-- No count in that sentence, deliberately. It said "any of the three" while this list held four,
     and the RSS-soak row leaving made it accidentally correct — which is the worse failure, because a
     number that is right by coincidence reads as maintained. A tally in prose beside a list it does not
     derive from is a drift surface with nothing checking it. -->

## Reproduce

```sh
pnpm calibrate:aws            # projection only — touches nothing, needs no credentials
pnpm calibrate:aws --rehearse # the workload against MinIO from docker-compose, free — no money guards run
bash bench/calibrate-cloudshell.sh   # from AWS CloudShell: in-region, against the PUBLISHED packages
pnpm bench         # builds, then regenerates bench/crossover.svg, bench/results.json, and the cost table here + the site
pnpm bench:scale   # HEAVY: builds a fleet up to 100K segments on local disk (fsync-bound), measures, rewrites the at-scale table
SCALE_FLEETS=1000,10000 pnpm bench:scale   # smaller + faster for a quick check
pnpm soak          # sustained loaded-store reads + combines + re-loads; heap/native creep verdict
pnpm rss-gate      # the same soak under a hard cgroup --memory ceiling (needs Docker)
```

The formulas are in `packages/core/src/core/cost.ts` — every rate, the crossover derivation and what each term
does and does not model are stated there — and the
[getting-started guide](guide/getting-started.md) covers the estimator API.
