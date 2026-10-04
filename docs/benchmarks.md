# CloudBitmaps — benchmarks & the Redis crossover

> **Generated, not hand-written.** The chart and table below are produced by `pnpm bench` from the shipped
> `estimateCost()` at the default `aws-us-east-1-ondemand` rates: the line against one three-node Redis-HA cluster,
> `ONE_REDIS_HA_CLUSTER`, whatever the data size, and the table's last row against the Redis the default profile
> sizes for the reference set. `pnpm bench:check` fails CI when either drifts from the library's own numbers. The
> polished, shareable version lives on the [site](../site/benchmarks.html)

CloudBitmaps bills per request and per byte; a Redis-HA cluster bills a flat monthly rate. Below a certain
sustained read rate, pay-per-use is far cheaper; above it, the cluster wins. This is that crossover.

There is **one** crossover, not two, because a loaded store has no per-id write to plot: data enters as a whole
generation — one object PUT, a few when multipart, then the pointer — which the estimator prices as `loadsPerMonth`
rather than as a rate. Reads are the axis where a flat, always-on cluster competes.

## The crossover chart

<!-- BENCH:CHART:START -->
![CloudBitmaps against one Redis-HA cluster: where the cost crosses](../bench/crossover.svg)
<!-- BENCH:CHART:END -->

<!-- BENCH:STATS:START -->
| Scenario | Value | Basis | Verdict |
| --- | --- | --- | --- |
| At-rest (1.2 GiB, no traffic) | **$0.03/mo** | 0.008% of the $346 cluster | win-big |
| Read crossover | **329.15 reads/s** | object GETs, cache off | past here the cluster is cheaper |
| Redis-HA baseline | **$346/mo** | one cluster, whatever the data size | the comparison line |
| The Redis the default prices for the 1.2 GiB set | **$142.35/mo** | 3 × cache.t4g.medium, the cheapest cluster in the catalogue that holds it | the line would sit at 135.42 reads/s |
<!-- BENCH:STATS:END -->

The comparison line is **$346/mo**, standing, whether or not you send it traffic: an ElastiCache HA cluster of
**1 primary + 2 replicas on `cache.m7g.large`** (~$115/mo single-node). The spec is stated because the number is
otherwise unauditable — a reader cannot judge a baseline without knowing whether it is sized for the reference
dataset or several times larger than it. Look up the instance class and check us.

"Redis" is the legible example of the axis, not the opponent: the axis is **reserved capacity vs metered
requests**, and any always-on node crosses any per-request meter somewhere.

## How these stay honest

Every number above is turned into a **deterministic, build-breaking CI assertion** in
[`tests/bench/anchors.test.ts`](../tests/bench/anchors.test.ts), and the estimator's request counts in
[`tests/core/cost.test.ts`](../tests/core/cost.test.ts); `pnpm bench:check` holds the chart, the table and
`bench/results.json` to the same estimator — a regression or an overclaim fails the build:

- **Counting is free** — `count()` on a loaded segment performs **0 payload reads**, and a cold one is **one pointer
  read** and no read of the object: the registry row records the generation's id count. The index sum answers only
  when the row has no summary it can use.
- **Chunk-skipping works** — the chunks a 5%-overlap intersection fetches come to ≤ 10% of the bytes of a full
  two-segment download (measured through the metrics sink, which counts chunk reads).
- **Cheap at rest** — the reference ~1.2 GiB set with no traffic costs ≤ 10% of the $346 cluster.
- **The published crossover is the modelled one** — the estimator's read crossover, at the pessimal cache
  posture, is asserted against the rate this page prints, over the same $346 baseline.
- **The estimator never quotes fewer chunk reads than the engine makes** — priced against the chunk GETs a metrics
  sink observed for a point-read workload on an in-memory store, the prediction must land on or above the measured
  cost. That covers point reads' chunk GETs.
- **The estimator counts what the engine sends** — a cold intersect's pointer and index reads for each operand before
  its chunks, what `store.load()` adds to a load's object write, the registry reads and writes of a retirement and of a purge in
  the retention sweep, and at most one pointer read per hot segment per `cache.genTtlMs`. A test drives the real engine over the single-bucket registry protocol and holds each count to
  the requests it makes, on S3's request shape, which GCS shares. Azure Blob shares it for a pointer read and makes
  two requests for a tail read, which the pricing profile's `requestsPerSizedRead` carries; `requestsPerPointerRead`
  carries a pointer read's. A fleet of readers pays the refresh once per reader,
  which `readerProcesses` carries. And it still quotes low where it cannot see: more hot segments than a reader
  keeps open (1,024 by default), which re-opens them as it reads them; the index every reader opens again after
  each load; an intersect slow enough to outlive `cache.genTtlMs`, which re-reads its pointers; an operand whose
  index outgrows the tail read, one more GET; and a load that loses a publish race, which reads the pointer again.

## Real-cloud calibration — AWS

One run of the loaded store against real S3 in `us-east-1` is published here, driven from AWS CloudShell inside the
region. It measured the topology that ships, with the pointer in the same bucket as the data: what a cold intersect
and a load cost, and how long they take.

### The in-region run — run `2026-10-04-73668`

> **Measured** against real S3 in `us-east-1` on 2026-10-04 (UTC), from AWS CloudShell in the same region, with the
> packages published before this release, and a client of 50 sockets: a round-trip floor of 5.01 ms. The run's report explains every figure:
> [`bench/calibration/2026-10-04-73668.md`](../bench/calibration/2026-10-04-73668.md). The evidence beside it is the
> harness's own results file. [`tests/docs/calibration-reports.test.ts`](../tests/docs/calibration-reports.test.ts)
> holds this section and the report to it in both directions: every dollar amount, percentage, duration, byte size
> and ratio, every number written before the request, chunk, id or load it counts, and the bill below, row by row.

**What it establishes:**

- **Chunk-skipping works on real S3.** 40 of 40 cold intersects of two 500,000-id segments returned the planned ids,
  checked by count and by sum. Each fetched 100 of 1,999 chunks per segment, the 100 the two share, and skipped the
  other 95.0%.
- **A cold intersect of that shape took 290.06 ms at the median** (p95 416.22 ms, p99 588.99 ms) and made 204 GETs:
  one pointer read and one 256 KiB tail read per operand, and one GET per shared chunk per operand. That is 4 + 2k
  for k shared chunks, whatever the segments' size, while each index fits the tail read: up to about 26,000 chunks
  of this shape. Each GET round took about 36 to 41 ms (**derived**), longer than the previous run's, with more requests open at once.
- **Latency grows with the overlap, because each shared chunk is a request.** At 1,000 shared chunks the median was
  1,808.80 ms, and at 2,000 it was 3,291.35 ms, 1.82 times as long for twice the chunks.
- **A warm intersect took 4.05 ms** at the median and made no request.
- **Point reads.** A cold `count()` is one request, 27.82 ms at the median. `has()` on an open segment is one
  request, 25.94 ms, and microseconds once the chunk is cached.
- **Load throughput.** A single-part `store.load()` of a 1.05 MB segment ran at 2.42 million ids a second, 5,100,414
  bytes a second; a multipart load of a 12.6 MB segment at 10.4 million ids a second, 10,432,654 bytes a second.
- **`andNot`** of a 1,999-chunk segment against ten excludes took 3,335.85 ms at the median and 3,021 GETs.
- **The rounds sit above the rounds model.** They are a fifth to a half above it (7.1 against 6 for the cold intersect, 50.2
  against 34 and 92.4 against 66 for the sweeps), and the model assumes no socket limit. The client had 50 sockets, the
  SDK default. Only the `andNot` held more requests in flight than that (mean 80.6, stage-median peak 352); the cold
  intersect and the sweeps averaged 29.1, 41.3 and 43.4. The run did not vary the socket count, so it does not say
  what part of the gap is socket wait, and no figure is claimed for any other count.

**Every latency above was measured on the engine whose combine window opens 8 keys wide and widens to 32, by a client of 50 sockets**; the
[section below](#the-window-of-32--measured-against-the-model) sets it against the previous run's, and against the
model that predicted it.

| Operation | Requests | One | Per million | Label |
| --- | --- | --- | --- | --- |
| Cold intersect, two 500,000-id segments sharing 100 of 1,999 chunks, the median measured | 204 GET | $0.0000816 | **$81.60** | derived |
| The same, with each pointer read once, as inside the region | 204 GET | $0.0000816 | $81.60 | expected |
| A segment's first single-part `store.load()`, a 1.05 MB segment, pointer included | 2 PUT + 4 GET | $0.0000116 | **$11.60** | derived |
| A segment's first multipart `store.load()`, a 12.6 MB segment | 5 PUT-class + 4 GET | $0.0000266 | **$26.60** | derived |

**Derived** rows are measured request counts times the `aws-us-east-1-ondemand` list prices. The second row is the
code's prediction, which the run met exactly. PUT-class requests are the ones S3 bills at the PUT rate, listings
included. The whole run was 101 PUT-class and 92,825 GET-class requests, teardown included, and its requests cost
$0.0376350, against a projected upper bound of $0.044470. Inside the region there is no data-transfer charge to add.

**Against the $346-a-month Redis-HA line**, that is 4.2 million cold intersects of this shape a month, 1.6 every
second, or 29.8 million single-part loads. Below those rates this design costs less; above them, the standing
node does. Every intersect in the run was cold on purpose. A long-lived reader answers a repeat from memory, and pays
instead for the pointer refresh: at most one GET per segment every 2 s while the segment is being read.

**What it does not establish:**

- **Lambda.** A function's cold start and initialisation need a run from inside one.
- **Other shapes**: more operands, other combine shapes, the `*Into` verbs.
- **Other clouds.** GCS and Azure Blob have no in-region run.
- **One client on one day.** The 36 to 41 ms GET round is this run's, not a guarantee.
- **A wider client.** The run used 50 sockets. The client this release builds allows 128; what that measures is not in the run.

**`estimateCost()` counts what this run's bill counted**: each cold operand's pointer and tail read, which prices
this run's intersect at 204 GETs; what `store.load()` adds to its object's write; and the pointer
refresh, for the segments a long-lived reader keeps reading. The
[guide](guide/cost.md#what-each-term-counts) says what each term counts.

### The window of 32 — measured against the model

**The release before this one kept a fixed window of 8 chunk keys; the engine of the run of 2026-10-04 opens a combine's window 8 keys wide and widens it to 32 as
keys are taken, and `andNot` and `union` read an exclude's chunk in the same round trip as the include's.** A read of
`n` chunks took about `n / 8` request times in sequence, and that window, not the network, set how long a long read
took. Before the run of 2026-10-04 the wider window was only **derived**, from a latency model that draws each GET's
latency from a lognormal distribution with a median of 26 ms and caps the open requests at 50, as the S3 SDK's default
sockets do. That run is the measurement of it, and [the previous release's run](#the-previous-in-region-run--run-2026-10-03-e13c7) is
what it is measured against. The same harness ran the same workload on both: the requests are the same ones, and the bill is the same
to the request.

**Measured, in region, on S3**, the median of each:

| Shape | Previous run, window of 8 | The run of 2026-10-04, window to 32 |
| --- | --- | --- |
| cold intersect, 100 shared chunks | 492.69 ms · 18.3 rounds · mean 11.2 in flight, peak 16 | 290.06 ms · 7.1 rounds · mean 29.1 in flight, peak 64 |
| cold intersect, 1,000 shared chunks | 4,238.82 ms · 160.4 rounds | 1,808.80 ms · 50.2 rounds · mean 41.3 in flight |
| cold intersect, 2,000 shared chunks | 8,658.44 ms · 324.0 rounds | 3,291.35 ms · 92.4 rounds · mean 43.4 in flight |
| `andNot`, a 1,999-chunk include against 10 excludes | 8,687.10 ms · 303.9 rounds · mean 10.3 in flight, peak 80 | 3,335.85 ms · 37.5 rounds · mean 80.6 in flight, peak 352 |

**How the measurement compares with the latency model.** The latency model's two figures for the shapes the run timed are 13.1 s and
3.7 s for the `andNot`, and 6.3 s and 2.1 s for an intersect of 1,000 shared chunks, for a window of 8 and for the
widened window. The measured medians are lower on both engines: 8.69 s and 3.34 s for the `andNot`, 4.24 s and 1.81 s
for the intersect. So the latency model overstated the time of each, and it overstated the gain too: it has the
`andNot` 3.5 times faster, and the run 2.6 times, and for the intersect 3.0 times against the run's 2.3. The
direction holds: the same requests in about an eighth of the rounds for the `andNot`, a third for the
intersect, with a wider window and the exclude's read joining the include's.

**The measured rounds sit above the rounds model, and the run does not say why.** The rounds model is the engine's own
count of requests in line, and assumes no socket limit: 6 rounds for the cold intersect, 34 and 66 for the two sweeps.
The run measured 7.1, 50.2 and 92.4, a fifth to a half more. The client had 50
sockets. Only the `andNot` held more in flight than that, a mean of 80.6 and a stage-median peak of 352 (the run-wide
peak was 351); the cold intersect and the sweeps averaged 29.1, 41.3 and 43.4. A round took about 36 to 41 ms for the
intersects and about 89 ms for the `andNot`, where the previous run's took about 26 to 29 ms. The run did not vary the
socket count, so it does not say what part of the gap is socket wait: S3's own time to answer and the client's
connection handling are other candidates. The client this release builds allows 128 sockets, and the run's figures were taken with 50, so
**no figure is claimed here for the effect of 128**.

**Still derived, not measured.** The rows below are the latency model's, for shapes the run did not time. It draws the
requests in the old and the new engine alike:

| Shape | Window of 8 | Window of 8 widening to 32 | Requests (both) |
| --- | --- | --- | --- |
| `andNot` against one opt-out list holding every chunk | 18.2 s | 3.9 s | 3,998 |
| `intersect`, 16 shared chunks | 129 ms | 129 ms | 32 |
| `intersect`, 128 shared chunks | 866 ms | 338 ms | 256 |
| `iterate` over a 1,999-chunk segment | 10.8 s | 3.6 s | 1,999 |
| `intersect` page that stops after 50 ids (25 keys) | 178 ms | 117 ms | 66 to 114 |
| `iterate` page that stops after 50 ids (10 chunks) | 102 ms | 103 ms | 17 to 41 |

The latency model overstated the timed shapes, so read these as upper bounds on the time, not as predictions. The request counts are the model's chunk reads and leave out index reads: the measured `andNot` made 3,021 GETs, the model's 2,999 plus 22 index reads. The last two rows are the cost: a read that stops early has requested
up to 32 keys per operand ahead, where a window of 8 had requested up to 8. Pass `concurrency` to bound that.

### The previous in-region run — run `2026-10-03-e13c7`

> **Measured** on 2026-10-03 (UTC), from AWS CloudShell in `us-east-1`, with the packages published before the window widened, whose
> combine kept a fixed window of 8 chunk keys: a round-trip floor of 5.07 ms. Its report is
> [`bench/calibration/2026-10-03-e13c7.md`](../bench/calibration/2026-10-03-e13c7.md). It is kept here as what
> [the run above](#the-window-of-32--measured-against-the-model) is measured against.

- A cold intersect of two 500,000-id segments sharing 100 chunks took 492.69 ms at the median (p95 559.30 ms).
- With 1,000 shared chunks the median was 4,238.82 ms, and with 2,000 it was 8,658.44 ms.
- The `andNot` against ten excludes took 8,687.10 ms at the median, at a mean of 10.3 requests in flight.
- A warm intersect took 3.96 ms, a cold `count()` 27.48 ms and a `has()` on an open segment 25.60 ms.
- A single-part load ran at 2.86 million ids a second and a multipart load at 11.3 million. The later run's single-part rate, 2.42 million, is 15% below it; the load path did not change between the releases (from the code, not from either run), and the runs do not say why the rate differs.
- It made the same requests as the run above, and its bill is the same to the request.

## At scale — measured (1K → 10K → 100K segments)

> **Measured, not modeled.** Unlike the cost curve above (which comes from the estimator), the numbers here are
> wall-clock + memory from a real run of `pnpm bench:scale` that builds a fleet of up to 100K segments on local
> disk and reads across all of it, and intersects two large segments on in-memory storage. They're
> machine-dependent — a point-in-time snapshot, **not** a CI gate. What CI does check is that the table below is
> what the committed results file renders.

Three things could make a large fleet expensive to run: an unbounded `.crbm` reader cache, an `O(total)`
fleet-wide registry scan, and an intersection of large segments that read more than it needs. This is the
measured evidence at fleet scale:

<!-- BENCH:SCALE:START -->
| Fleet | Retained heap (cap 1024) | Peak RSS | Discovery scan |
| --- | --- | --- | --- |
| 1,000 segments | 8.2 MiB | 68.1 MiB | 87.6 ms |
| 10,000 segments | 8.3 MiB | 86.8 MiB | 1,067.9 ms |
| 100,000 segments | 7.4 MiB | 162.2 MiB | 11,606.4 ms |

Intersection of two 2,000,000-id segments on in-memory storage (2,000 chunks each, 100 shared): **fetched only 100 of the 2,000 chunks per segment** — the shared keys; the rest skipped by key alignment — in 24.6 ms, which times the engine rather than object storage.

_Measured on Apple M3 Pro (arm64, node v24.18.1). **The bound is the retained heap** (post-GC), flat at 8.2 MiB @ 1,000 · 8.3 MiB @ 10,000 · 7.4 MiB @ 100,000 — the reader cache holds bounded live data regardless of fleet. Process **peak RSS** (shown for context) is a high-water that also folds in the benchmark's own fleet-*seeding* allocations and isn't returned to the OS after GC, so it grows with fleet here — it is not a clean read-path footprint (isolating read-path RSS in a reader-only process is a follow-up). Fleet seeded by writing and publishing each generation at ~38–51 durable segments/s (fsync-bound); discovery is LocalFs-filesystem-bound — the `O(total)` **shape** is the point, not the absolute ms._
<!-- BENCH:SCALE:END -->

- **Memory is a function of the working set, not the fleet.** The storage-reader cache is capped by open-segment
  _count_ (`cache.readerMax`, default 1024) **and** aggregate parsed-index _bytes_ (`cache.readerMaxBytes`,
  default 64 MiB), so **retained live heap after reading the _entire_ fleet is flat from 1K to 100K segments** — a 100×
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
  promised. [Why a ceiling is published](#why-a-ceiling-is-published-and-not-a-number) says more.

- **The fleet-wide registry scan is `O(total segments)`** — the near-linear "discovery" column is the
  enumeration that every admin pass (`checkConsistency`, `retireExpired`, `eraseSubject`, `subjectReport`)
  pays before it does any
  work. **No read verb enumerates**: `has`, `count`, `iterate` and `intersect` each address one segment. The
  retention sweep enumerates too by default (`scan: 'fleet'`); `retireExpired({ scan: 'index' })` reads a due-day
  index instead of the fleet, and is the fast half of a pair, since a periodic `'fleet'` pass is what retires a
  policy the index missed. `checkConsistency`, `eraseSubject` and `subjectReport` always enumerate, and the
  column above is that enumeration. The total is the rows the registry holds: live segments, and retired ones still
  inside their grace. On a registry that reports `conditionalDelete` the sweep's purge removes a retired row for good,
  so a namespace that churns short-lived segments does not grow it; elsewhere each purged row stays as a tombstone the
  scan reads, and the total is every name the namespace ever held (the
  [retention guide](guide/retention.md#how-it-stays-correct) says which backends are which).
- **Chunk-skipping intersection holds at scale** — intersecting two large multi-chunk segments fetches only the
  shared chunks and skips the rest by key alignment (the crown jewel, on the ids-per-segment axis). The
  load-bearing figure there is the chunk **count** — 100 fetched of 2,000 — because key alignment does not depend
  on how the ids inside a chunk are distributed. The accompanying **bytes** figure does: this fixture seeds each
  chunk with a contiguous run of ids, which Roaring stores as a single run, so the 3,000 bytes read (measured) over
  200 chunk reads (derived: each of the 100 shared keys is read from both segments) come to 15 bytes a read: a
  **best case for the encoding** rather than a typical segment. Real ids at that density are scattered and land in an array container nearer 2 KB per chunk. Read the byte count as "the window is
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
grows until the kernel kills it. Since ["bounded memory & cost, always"](../AGENTS.md#hard-correctness-invariants) is one of this project's
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
establishes and what a reader can act on. The committed run, `bench/rss-gate-results.json`, is one arm64 machine
under Docker: its isolated reader process sat at 69.5 MiB of RSS, well inside the ceiling. CI runs the same gate on
an x64 Linux runner and fails the build if the workload is OOM-killed or creeps; it keeps no reading. A latency
number moves with the machine and the network as well, which is why the latency figures above come from a run
inside the region and not from a laptop.

## Caveats

- **Default rates, one cluster** (`aws-us-east-1-ondemand` against `ONE_REDIS_HA_CLUSTER`, cache off). Your
  region, cloud, committed term and cache-hit rate all move the crossover, and so does your data's size: the
  estimator's default prices the Redis that would hold it, which [what it costs at your size](guide/sizing.md)
  works through. Feed your own `PricingProfile` and workload to `CloudRoaring.estimateCost()`.
- **Model, not a cloud bill** — the dollars in the crossover chart come from the cost formulas + published
  rates. Measured AWS dollars live in [Real-cloud calibration](#real-cloud-calibration--aws).
- **Three kinds of number here.** The crossover chart is _modeled money_ (estimator, deterministic, CI-gated);
  the at-scale table is _measured memory + wall-clock_ (a real run, the fleet on local disk and the large
  intersect in memory, machine-dependent, never CI-gated — shared runners are too noisy); and the real-cloud section is _measured AWS cost_ (owner-run against
  a real account, on 2026-10-03, from inside the region). Only the third is cloud-calibrated, and even then the dollars are
  published prices applied to wire-metered requests, not the invoice itself.
- **Rates are the vendor's to change, and are region-specific.** Every dollar figure in this document uses the
  default `aws-us-east-1-ondemand` rates, dated where it was measured; the crossover is drawn against
  `ONE_REDIS_HA_CLUSTER`, and the stats table's last row against the Redis the default profile sizes for the
  reference set. Treat the _ratios_ as the durable
  finding and re-derive any absolute figure from your own region and contract — `CloudRoaring.estimateCost()` takes a
  `PricingProfile` so you can plug your real rates in rather than trusting ours.

## What is still owed

The [in-region run](#the-in-region-run--run-2026-10-04-73668) measured the loaded store's latency and load
throughput on S3. These are not published yet:

- **A Lambda figure** — a function's cold start and initialisation against a real store, from inside one.
- **The `*Into` verbs** — materialising a combine's result back into a segment, against a real object store.
- **Other combine shapes** — more than two operands, and other overlaps than the sweep's, against a real object store.
- **GCS and Azure Blob in-region runs** — the run measured S3 only.

**The harness is built, and has run for real from inside the region.** [`bench/calibrate-aws.cjs`](../bench/calibrate-aws.cjs)
(`pnpm calibrate:aws`) measures, in one run against a real bucket, in seven stages: load throughput through
`store.load()`, single-part and multipart, each load's own requests recorded; cold `A ∩ B` latency for two 500,000-id
operands spanning ~2,000 chunks with 100 shared — the chunk-skipping ratio the at-scale section reports, at a quarter
of its density — and again with the same overlap spread uniformly over each segment's chunks; a sweep over how many
chunks the operands share; the same intersects answered again from memory, held to no requests at all; `count()` and
`has()` as a first read, `has()` on a segment already open, and both again warm; and `andNot` of one segment against ten. Every request the single-bucket topology
bills, pointer reads and conditional PUTs included, is counted attempt by attempt and by stage. Each intersect must
return exactly the planned ids or no latency is reported, and each cold one turns off its store's timed pointer
refresh, so its request count does not move with the network. A sample that meets a transient fault is not retried
inside its timing: it is discarded whole and run again from the start, from a state the failed attempt left nothing
cached in (a fresh store, or for a point read that assumes a store in a given state, that store put back in it), for
at most three samples a run and two a stage. Its requests are billed, projected and recorded beside its stage; every
latency and request-count figure comes from the samples each stage kept, held to their expected counts exactly,
while the bill counts both; and a run's report states how many it discarded. A fault in a load, or one past the bound,
fails the run. Every run records its own round-trip floor to the
region and labels its latency in-region only below 30 ms — a line that keeps another continent out, not a
neighbouring region, so the raw floor is recorded with it for a reader who wants a stricter one, and so is the region the shell ran in. A page states a run's latency as in-region only when that region is the bucket's too. Each cold intersect also records how many requests were in flight at once and how many it waited for one after another, and every run records the AWS SDK and handler versions and the handler's socket cap. Its runs
`2026-10-03-e13c7` and `2026-10-04-73668`, from AWS CloudShell in `us-east-1`, paid the in-region rows: intersect and point-read latency,
load throughput, `andNot` with a large `exclude`, the sweep, and what `store.load()` costs on S3. The `*Into` verbs and
the Lambda figure are not in it yet.
How it guards against spending more than it says, and how to run it from inside the region:
[`bench/README.md`](../bench/README.md#real-cloud-calibration).

Nothing above should be read as covering any of these.

<!-- No count in that sentence, deliberately: a tally in prose beside a list it does not derive from is a
     drift surface with nothing checking it, and a count that happens to be right reads as maintained. -->

## Reproduce

```sh
pnpm calibrate:aws            # projection only — touches nothing, needs no credentials
pnpm calibrate:aws --rehearse # the workload against MinIO from docker-compose, free — no money guards run
bash bench/calibrate-cloudshell.sh   # from AWS CloudShell: in-region, against the PUBLISHED packages
pnpm bench         # builds, then regenerates bench/crossover.svg, bench/results.json, and the cost table here + the site
pnpm bench:scale   # HEAVY: builds a fleet up to 100K segments on local disk (fsync-bound), measures, and prints
SCALE_INJECT=1 pnpm bench:scale   # the same, then rewrites bench/scale-results.json and the at-scale table here + the site
SCALE_FLEETS=1000,10000 pnpm bench:scale   # smaller + faster for a quick check
pnpm soak          # sustained loaded-store reads + combines + re-loads; heap/native creep verdict
pnpm rss-gate      # the same soak under a hard cgroup --memory ceiling (needs Docker)
```

The formulas are in `packages/core/src/core/cost.ts` — every rate, the crossover derivation and what each term
does and does not model are stated there — and the
[cost guide](guide/cost.md) covers the estimator API.
