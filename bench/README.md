# `bench/` — the measurements behind every published number

Everything in this directory **measures**; nothing here is a test. The distinction matters because the two are
held to different standards:

- A **test** asserts something that must be true on every machine, and runs in CI on every pull request.
- A **measurement** produces a number that depends on the machine, the network and the cloud. It is run by hand,
  its output is committed as a results file, and a published figure is then checked against that file — so the
  number on the site cannot drift from the run that produced it, and cannot improve without a new run.

The deterministic parts of these harnesses — the ones that hold on any machine — are pulled out and gated in CI
by [`tests/bench/`](../tests/bench). What stays here is the part that cannot be.

For what each published number means, how it was measured, and what it does *not* establish, read
[`docs/benchmarks.md`](../docs/benchmarks.md). This file is the map of the code that produces them.

## Contents

- [The harnesses](#the-harnesses)
- [The results files, and what reads them](#the-results-files-and-what-reads-them)
- [Real-cloud calibration](#real-cloud-calibration)
- [`lib/`](#lib)
- [Adding a harness](#adding-a-harness)

## The harnesses

| file | measures | run with | writes | in CI? |
|---|---|---|---|---|
| `run.cjs` | The read-cost curve against one Redis-HA cluster (`ONE_REDIS_HA_CLUSTER`), and where they cross — computed from the **shipped** estimator (`estimateCost`) at the default rates, so the chart cannot drift from the library's own arithmetic. | `pnpm bench` (builds first); `pnpm bench:check` to verify | `crossover.svg`, `results.json`, the chart inside `site/benchmarks.html`, and the chart and stats table inside `docs/benchmarks.md` (between `BENCH` markers) | yes — `pnpm bench:check` fails if a file it writes is not what the built estimator gives, and `tests/bench/anchors.test.ts` holds its figures to the estimator |
| `sizing.cjs` | A small, a medium and a large deployment — illustrative workloads, labelled as such — priced by the **shipped** estimator (`estimateCost`) at the default pricing, against the Redis that would hold each one's data, so the page cannot quote a bill the library would not. | `pnpm bench:sizing` (builds first) | the `SIZING` regions of `docs/guide/sizing.md`, `docs/guide/cost.md`, `docs/guide/why-cloudbitmaps.md` and `README.md`, and the explainer's two charts in `bench/`, each in a light and a dark file | yes — `pnpm bench:sizing:check` fails if a region or a chart is not what the generator draws from the estimator; on a marker it would not check; outside the regions of a page whose figures are generated, on a digit but in the names it lists, on a number word from two up but in the phrases it lists, on a share's sign and any character but plain ASCII, `§` and `—`, on HTML, an image or a code fence, which could hide one, and on a share, a multiple or an amount in words, in the spellings it knows; and on an entity GitHub decodes in any page it writes. It is a check against drift, not a bar to a figure written on purpose in a form it has never seen. `tests/bench/sizing-check.test.ts` holds the check itself to failing |
| `scale.cjs` | A fleet of up to 100,000 segments on local disk: retained heap as the fleet grows (the memory bound), the `O(total)` cost of enumerating it, and chunk-skipping on two large segments. | `pnpm bench:scale` (heavy); `SCALE_FLEETS=1000,10000` for a quick pass | `scale-results.json`, and the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` | no — too slow and too machine-dependent |
| `soak.cjs` | The loaded store under **sustained** mixed load — point reads, combines with `exclude` lists, and re-loads — watching post-GC heap *and* the addon's off-heap memory for creep over time. A run with no combines or no re-loads is reported inconclusive, never a pass. | `pnpm soak` (`SOAK_INJECT=1` to persist) | `soak-results.json` | yes, inside `pnpm rss-gate` (see `scripts/`) |
| `encoding.cjs` | Encoded size of the same ids under roaring against a fixed array, a fixed bitset and a fixed run-length encoding — the evidence behind the site's claim that roaring's advantage is choosing a representation *per chunk*. | `pnpm bench:encoding` | `encoding-results.json` | no |
| `event-loop.cjs` | `store.load()` of 1M ids spread across the id space onto in-memory storage, through the built package, 20 trials each in a fresh process: the load's wall time and the longest single event-loop stall, with the store's yielding clock and with a clock that yields nothing. Records the CPU, Node version, commit and the load average before and after, so a busy machine is visible in the evidence. Wall-clock and machine-dependent: recorded, not asserted. | `pnpm bench:event-loop` (builds first; wants an idle machine); `EVENT_LOOP_INJECT=1` to persist; `pnpm bench:event-loop:check` to verify | `event-loop-results.json` | yes — `pnpm bench:event-loop:check` fails if the guide's event-loop section, or the two source comments quoting the same run, differ from the results file. It never re-measures, because CI hardware is not the hardware that measured |
| `load-input.cjs` | `store.load()` of the same set from ids (a plain array, and through an async generator), from `{ bitmap }` and from `{ serialized }`, onto in-memory storage, through the built package, 5 trials each in a fresh process: five sets, among them a 12M-member sparse set in 65,536 chunks and one container layout at 10 % and at 90 % density, which a path with per-id work pays nine times for and a path without it does not. Records the wall time, the longest event-loop stall, and that every input wrote the same bytes. Wall-clock and machine-dependent: recorded, not asserted; that no per-id code runs is asserted on every pull request by `tests/roaring/load-no-per-id.test.ts`, which counts calls. | `pnpm bench:load-input` (builds first; wants an idle machine); `LOAD_INPUT_INJECT=1` to persist; `pnpm bench:load-input:check` to verify | `load-input-results.json`, not yet recorded | yes — `pnpm bench:load-input:check` fails if the loading guide's "How fast a bitmap loads" figures differ from the results file, or quote any figure while there is none. It never re-measures |
| `calibrate-aws.cjs` | Against a **real** object store: load throughput (single-part and multipart), cold intersect latency, and what a single-bucket topology actually costs per request. It spends money — see [below](#real-cloud-calibration). | `pnpm calibrate:aws` | one evidence file per finished real run, `calibration/<runId>.json`; a real run that does not finish writes `calibration/<runId>.partial.json`, and a rehearsal `calibrate-aws-rehearsal.json`, both of which git ignores | its guards, via `tests/bench/calibrate-guards.test.ts`, and how it discards a sample that meets a transient fault, via `tests/bench/calibrate-samples.test.ts` |
| `calibrate-cloudshell.sh` | The same calibration, run from AWS CloudShell inside the region, against the **published** packages installed from npm. | `bash bench/calibrate-cloudshell.sh` | `~/<runId>.json` in CloudShell, which belongs in `calibration/`, or `~/<runId>.partial.json` for a run that did not finish | no |
| `check-elasticache-prices.cjs` | Holds the estimator's on-demand catalogue, and the reserved prices `sizing.cjs` prices Redis with, to a downloaded AWS price list, node by node and on each node's full key. | `node bench/check-elasticache-prices.cjs <offer.json>`, by hand whenever the cited price list version moves | nothing: it exits non-zero, naming every node that disagrees | no: it needs the price list, a 2 MB download from AWS. CI tests its reader, `tests/bench/elasticache-prices.test.ts` |

## The results files, and what reads them

Each is committed and regenerated only by its harness. The last column says what checks each one — and where a
figure is published from it with no check behind it, the row says that too.

| file | written by | read by |
|---|---|---|
| `results.json` | `run.cjs` | `scripts/site-figures.cjs`, which checks the site's money figures against it |
| `bill-as-data-grows.svg`, `where-each-costs-less.svg` | `sizing.cjs` | `docs/guide/why-cloudbitmaps.md`, as images, for readers in the light theme. `pnpm bench:sizing:check` compares each with what `sizing.cjs` draws now, byte for byte, like the page's generated regions, so a chart cannot drift from the estimator |
| `bill-as-data-grows-dark.svg`, `where-each-costs-less-dark.svg` | `sizing.cjs` | the same page, through `<picture>`, for readers in the dark theme: the same charts in the dark palette, checked the same way |
| `crossover.svg` | `run.cjs` | `docs/benchmarks.md`, as an image. The site does **not** read this file: `run.cjs` inlines its own copy of the chart into `site/benchmarks.html`, where the page's colour tokens resolve so the chart follows light and dark |
| `scale-results.json` | `scale.cjs` | `scripts/site-replay.cjs`, which holds `demo.html`'s figures to it, and `scale.cjs` itself: `pnpm bench:scale:render` renders the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` from it, and `pnpm bench:scale:check` fails in CI if either copy is not what it renders |
| `soak-results.json` | `soak.cjs` | `scripts/site-figures.cjs`, against the combine count and native-memory creep `site/benchmarks.html` quotes |
| `event-loop-results.json` | `event-loop.cjs` | `event-loop.cjs --check`, against the guide's "What blocks the event loop, and where to run it" section and the figures quoted in `packages/core/src/core/cooperative.ts` and `packages/roaring/src/system-clock.ts` |
| `encoding-results.json` | `encoding.cjs` | `scripts/site-figures.cjs`, against the sizes `site/flavors/roaring.html` quotes |
| `rss-gate-results.json` | `scripts/rss-gate.sh` | `scripts/site-figures.cjs` — the hard RSS ceiling on the benchmarks page |
| `calibration/` | `calibrate-aws.cjs`: one evidence file per real run, beside that run's report. The directory has [its own README](calibration/README.md), which lists every run | `tests/docs/calibration-reports.test.ts`, against each run's report and the benchmarks page's section on the latest run; `scripts/site-figures.cjs`, against the site's single-bucket figures |

A rehearsal writes `calibrate-aws-rehearsal.json` instead, which git ignores — it has the same shape as a real
run's file, so under an evidence name it would be one `git add` from being committed as the evidence.
Both write every fractional number to nine decimals: below a nanosecond for a time in milliseconds and a billionth of
a dollar for a cost. A ratio's binary tail runs to 17 digits, and one of exactly 12 is a run the leak scan refuses.

## Real-cloud calibration

`calibrate-aws.cjs` measures three things that need a real object store rather than local disk. The benchmarks page
publishes all three:

1. **Load throughput** — ids/s and bytes/s into a bucket through `store.load()`, the whole write path, for
   objects that fit one PUT and objects large enough to upload multipart. **Paid** by the in-region run,
   [`2026-10-03-e13c7`](calibration/2026-10-03-e13c7.md), from AWS CloudShell in `us-east-1`, on the release before the one that widened the combine window, and measured
   again on the engine that widens it by [`2026-10-04-73668`](calibration/2026-10-04-73668.md).
2. **Cold intersect latency** — wall-clock for a chunk-skipping `A ∩ B` that has to fetch from the object store.
   **Paid** by the same in-region runs, [`2026-10-03-e13c7`](calibration/2026-10-03-e13c7.md) and, for the engine that
   widens the window, [`2026-10-04-73668`](calibration/2026-10-04-73668.md).
3. **The single-bucket bill** — the registry pointer lives in the same bucket as the data, so resolving a
   generation costs an object GET and advancing one costs a conditional PUT. **Paid** by its own run,
   [`2026-09-23-94416`](calibration/2026-09-23-94416.md), from a laptop, and measured again in-region by
   [`2026-10-03-e13c7`](calibration/2026-10-03-e13c7.md) and [`2026-10-04-73668`](calibration/2026-10-04-73668.md). A request count, and so the bill for
   requests, does not depend on where the client is, with one exception: an intersect
   slower than the pointer refresh reads each pointer again. The harness's timed store turns the pointer refresh
   off (`cache.genTtlMs: 0`). Bytes read out of the region are billed as transfer, which the harness counts and
   does not price.

### The stages

A run is a sequence of stages. Each records the requests it made, by class and by kind of read, beside the bound the
projection gave it and the exact count the engine is expected to make when nothing races it, from the layout alone
(`lib/calibrate-stages.cjs` holds both). A stage that misses its expected count says so on the console and in the
file under `expectedMissed`, and the run carries on, because a count that differs is a finding.

| stage | what it does | requests it is expected to make |
|---|---|---|
| `load` | 20 single-part and 5 multipart (two-part) loads through `store.load()`, each recording its own requests | per segment's first load: 2 PUT-class and 4 GET; a multipart object swaps its PUT for a create, its parts and a complete |
| `intersect` | 40 cold intersects over the calibration layout (100 shared chunks packed at keys 0 to 99), each on a fresh store | 4 + 2k GET each: both pointers, both tails, k chunks from each operand |
| `spread` | 10 segments of the same overlap with the shared chunks spread uniformly over each segment's chunks from a fixed seed, and 40 cold intersects | the same 4 + 2k, so a difference in latency is the layout's |
| `sweep` | segments sharing 1,000 chunks (10 intersects) and 2,000 (5), `CR_CALIBRATE_SWEEP` to change the list | 4 + 2k each, at each k |
| `warm` | the calibration pairs again on one store that trusts its pointers and holds every chunk it read; a priming pass first | the priming pass reads each segment once (a pointer, a tail, the shared chunks); a warm intersect makes none, **and a stage in which one does fails** |
| `pointReads` | three phases, each with its own count and the store it ran on: `count()` on 10 segments (a first read); `has()` of one id in every shared chunk of each, on the store `count()` resolved, each segment opened first (no chunk cached); and the same pairs once more, each on a fresh store (a first read); then the open-segment reads repeated warm | `count()` first read: a pointer, exactly 1; each segment opened by a `has()` that reads no chunk: one tail read; `has()` on an open segment: exactly one chunk read; `has()` first read: a pointer, a tail and a chunk, exactly 3; warm: none, which fails the stage if not. A cold phase that differs is recorded under `expectedMissed` and the run carries on |
| `andNot` | 10 calls of one calibration segment against 10 others, each on a fresh store | 2 + 2 x 10 + every chunk of the include operand + each exclude's chunks where it overlaps it |

**Depth.** A count of requests does not say how many ran at once, so the meter also keeps the requests in flight, their
peak, and the sum of every request's own time (sent to answered; a request is timed to its headers, so a chunk is about
the whole request and the 256 KiB tail is without its body). Each cold intersect and each `andNot` call starts its peak
afresh and records `peakInFlight`, `meanInFlight` (the summed request time over the wall time) and `rounds`: its
requests times its wall time over the summed request time, which is how many it waited for one after another. The stage
record carries their medians as `medianPeakInFlight`, `medianMeanInFlight` and `medianRounds`, beside `modelRounds`, the
engine's model of 2 + the rounds a window that opens 8 chunks wide and widens to 32 takes over k chunks (`windowRounds`
in `lib/calibrate-stages.cjs`, stepped at an even latency from the engine's two constants), for a pointer, a tail and
the window. A peak of 64 is the full window, 32 chunks each read from both operands; rounds above the model with a
mean in flight well under that is a slow request holding the window. A run made before the window widened ran a fixed window of 8
chunks, a model of 2 + ⌈k / 8⌉ and a peak of 16, and its figures are read against that. In flight counts requests the library issued, including any waiting for a free socket, so a mean or a peak above the
client's sockets (`maxSockets`, which the record carries; 50 is the SDK's default) means requests queued, a wait the rounds model, which assumes no limit, does not count.
The run of 2026-10-04 held an `andNot` mean of 80.6 in flight against 50 sockets, and its rounds sit above the model.

`andNot` reads every chunk of the segment it filters, since any of them can survive, and each exclude only where it
overlaps, so what it costs scales with the include operand and not with the size of the exclude list.

### A sample that meets a transient fault is discarded, and run again

The workload's client makes one attempt per request and every timed store has its own retry off, so no retry's backoff
can sit inside a latency sample and every count stays exact. On its own, that would let one transient fault anywhere
in a run's requests (up to ~94,600 GET-class and 364 PUT-class at the default workload) fail the whole run, and a
partial run is not evidence. One in-region run failed on a single transient connection fault after about 86,300
requests; at that rate a run of this size would finish about a third of the time. So a **sample** that fails with a
transient fault is **discarded**, never retried inside ([`lib/calibrate-samples.cjs`](lib/calibrate-samples.cjs)):

- **What a sample is.** One cold intersect (in `intersect`, `spread` and `sweep`), the warm stage's priming pass, one
  cold point read (`count()` as a first read, `has()` on a store that has resolved the segment, `has()` as a first read), and one `andNot`
  call. A warm read makes no request, so it cannot meet a fault, and one that does make a request fails its stage.
- **What a load is not.** A load is never discarded: a write that failed transiently may still have landed, its object
  or its pointer with only the answer lost, so the same load run again is a reload, which makes more requests than the
  first load the projection bounds. A load that meets a transient fault fails the run. The loads are
  about half a percent of a run's requests.
- **What counts as transient.** The library's `TransientError`, which the S3 driver raises for a throttle, a 5xx or a
  dropped or timed-out connection, or anything the installed SDK's own retry would have retried (its
  `isThrottlingError`, `isTransientError` and `isServerError`), anywhere in the error's causes. That takes in every
  5xx, 501 included, and a 403 refusing a skewed clock that the SDK has corrected, both of which the SDK retries
  itself. Never a wrong answer, another 403, a 404, an integrity failure, or the interrupt gate refusing a send.
- **Discarded whole, then run again from the start.** The failed attempt is abandoned. Its other requests still
  answer, since a cold intersect keeps its window of chunk reads in flight, so the harness waits until nothing is in
  flight and nothing new has been sent for a second, and counts all of it against the discard; a request still
  unanswered after 30 s fails the run. The wait watches a request until its headers arrive, not its body, so a body
  that stalls past the second lets the failed sample's next reads land in the sample run again; that sample then
  misses its expected count, and the run is refused as evidence rather than publishing a wrong figure. The sample then
  runs from the start, from a state the failed attempt left nothing cached in: a cold intersect, a first read, an
  `andNot` call and the priming pass on a store of their own, a first `count()` on its store after telling the store to
  forget that segment, and a `has()` on an open segment on the same store, which the failed chunk read left with the
  segment open and nothing cached. A test holds each re-run to the requests of the read it replaced.
- **Bounded.** At most three discards a run and two a stage. One more transient fault fails the run, with the fault
  under `error`.
- **Projected.** The projection allows three discarded samples, each at the bound of the costliest sample the run
  makes: at the default workload, a cold intersect sharing 2,000 chunks, 4,006 GET-class. The finished run holds each
  stage's kept samples to its bound and the discards together to that allowance.
- **Recorded.** Each stage's `discarded` lists its discards: which sample (`of`, `sample`), the error's `name`, the
  `cause` at the bottom of it, the transport `code` beneath it, the SDK's `attempts` and `httpStatus` where it has them,
  its message, how long the attempt ran, and the `requests` it made. Those requests are in the stage's `requests` and
  in the bill, since they were billed, and out of what the stage is held to: its expected count is checked against
  its requests less its discards'. The console says `DISCARDED` for each. The run records `discards`, its count and
  its bounds, and a stage a failure cut short under `discards.unfinished`. The run's `error` records a fault the same
  way: the SDK's HTTP handler gives a request error whose code is `ECONNRESET`, `EPIPE` or `ETIMEDOUT` one name, its
  timeout error's, and the code kept under the rename is what says which it was.
- **And the figures.** `lib/calibration-figures.cjs` treats a run with discards within the harness's bounds as
  evidence. Every latency and request-count figure comes from the samples each stage kept, held to its expected count
  exactly; the bill counts the discarded samples too, since they were billed. The run's report has to state how many
  it discarded (`N discarded samples`), and the count it states is held to the evidence. A run that met more faults
  than the bounds allow did not finish, and is refused like any partial run.

A rehearsal can show it: `CR_CALIBRATE_FAULT_GETS=1200,40000 pnpm calibrate:aws --rehearse` fails the 1,200th and the
40,000th GetObject the workload's client sends, once each, as a reset socket fails one, and `1200:denied` fails it as a
403 instead, which is not transient and fails the run. The harness refuses the variable in every other mode, and the
rehearsal's file lists each request it failed, and how, under `injectedFaults`. The integration lane runs the
harness through such a rehearsal on a small workload (`tests/integration/calibrate-rehearsal.test.ts`), so it needs
the packages built.

### It spends money, so it is hard to run by accident

| mode | what it does |
|---|---|
| `pnpm calibrate:aws` | **Projection only.** Prints the worst-case request count and dollar cost. Touches nothing, reads no credentials. |
| `pnpm calibrate:aws --rehearse` | The workload, the metering, teardown and signal handling, against the MinIO in `docker-compose.yml` (`docker compose up -d minio`). Free — and so none of the money guards run. `CR_CALIBRATE_FAULT_GETS` fails the GetObject requests it lists once each, to rehearse a discard. |
| `pnpm calibrate:aws --run` | The real thing. Refuses unless the region, a spend ceiling and a typed confirmation are each set. |
| `pnpm calibrate:aws [--rehearse] --cleanup <runId>` | Removes a run's bucket after a kill that nothing could catch. It checks the account pin as a run does, and refuses a bucket holding anything the harness did not write. |

A real run needs, separately:

```
CR_CALIBRATE_REGION=us-east-1          # never guessed, and us-east-1 only: the one region it has prices for
CR_CALIBRATE_MAX_USD=0.05              # checked before the run AND during it
CR_CALIBRATE_CONFIRM=yes-spend-money   # a typo must not spend money
CR_CALIBRATE_EXPECT_ACCOUNT=<12 digits> # optional: refuses to run in any other account
```

It then prints the account — **last four digits only**, enough to recognise, not enough to be worth pasting — and
waits ten seconds so you can Ctrl-C before anything is created. The default workload's projection, which is an upper
bound, is under four and a half cents with every discard it allows, so a ceiling of five cents holds it; `pnpm
calibrate:aws` prints each stage's bound, the allowance for discards and the total before anything is created.

### The guards

Most live in [`lib/calibrate-guards.cjs`](lib/calibrate-guards.cjs) as pure functions, each with a test that
plants the bug it exists for and fails unless the guard stops it; teardown's pass and page bounds are held by their
constants and the source text:

- **The spend ceiling is validated before it is compared.** `Number('abc')` is `NaN`, and every comparison
  against `NaN` is false — so a malformed ceiling, compared as it comes, silently *removes* the bound.
- **An explicit `0` means zero.** A helper that maps a falsy size to the default hands someone shrinking a run the
  full workload.
- **Only a clean 404 means "the bucket does not exist".** `HeadBucket` answers **403** for a bucket you own but
  cannot list, and in `us-east-1` `CreateBucket` on a bucket you already own returns **200 OK** — so reading 403
  as absent would run the workload inside a real bucket of yours and then delete it on teardown.
- **The projection covers every stage, and every run checks each one.** One table (`STAGES`) names the stages and one
  function bounds each, and a test fails when the harness runs a stage the table does not name, or the table names one
  the harness never runs, so a stage cannot spend money the ceiling never saw. The finished run is held to each
  stage's bound as well as to the total, so a stage that overspent is named. It counts both operands of an intersect, and
  its retry bound must match the publish loop in `packages/core/src/core/crbm-storage-source.ts`: a test reads the loop's number out of the source and
  fails if they differ, because a retyped number can be wrong. A load, `store.load()` of a new segment, checks that its
  generation number is free and lists nothing when it is, since it has nothing to collect (up to twice when the check
  finds the number taken, to number past the object and to collect; on S3 a listing bills at the PUT rate), and reads
  the pointer three times with nothing racing it, up to six when the check finds the number taken, twice more for each publish
  attempt it loses, and fourteen times at most: fifteen GET-class requests with the check. A test drives each count through the real registry code, so a projection allowing one
  read per attempt fails it. The workload's client makes one attempt per request, and every attempt teardown's client
  may make is allowed for, so no SDK retry can fall outside it either. A sample discarded after a transient fault was
  billed too, so the projection allows every discard a run may make, at the costliest sample's bound, and a plan that
  names no bound on discards is refused rather than projected without them. After teardown, the run compares what it
  actually issued against what it projected, each stage's kept samples against its bound and its discards against the
  allowance, and flags itself if it went over.
- **A segment is loaded once.** The projection bounds a segment's first load. A reload of a row with a summary
  opens nothing and makes fifteen GET-class requests under four lost races, as many as that bound; one of a row with none
  also opens the current generation's index and makes sixteen. A
  a collecting load reads the pointer once more. The harness claims each name before it loads (`firstLoads`) and
  refuses a repeat before sending anything.
- **A warm read that makes a request fails the stage.** Its count is not recorded and compared afterwards: the stage
  throws, the run keeps what it had finished and exits non-zero. Each warm store trusts its pointer for an hour and
  holds more chunks than the default cache, so the zero depends on neither the clock nor the cache size.
- **Evidence is write-once.** A real run's results go to a file named by its run id, and the harness refuses —
  before it reads any credentials, and before it even loads the library — to overwrite one that exists: a second
  run under a published run's id would replace the file its figures are checked against. The id is checked before
  anything uses it, because it names the bucket and the file: a real date, then a label, with none of the suffixes
  S3 keeps for its own kinds of bucket. Nothing is replaced at the end either: a run whose file appeared while it
  ran, or a retry whose partial name is taken, writes `<runId>.<start>.partial.json` beside it and says so.
- **The workload fits one teardown listing.** Teardown lists 1,000 object versions a pass and each segment leaves
  two, so a run loads at most 500 segments, counting every stage's. A run of 1,510 segments would leave 20 versions behind after three passes.
- **Teardown empties only a bucket the harness made.** It aborts every upload and deletes every version of every key
  it lists, and `--cleanup` points it at a bucket by name. So before it touches anything it lists every upload and
  every page of versions, up to ten pages, and refuses and reports a bucket holding any key outside `calib/`, the
  store's prefix, rather than empty it. `--cleanup` checks `CR_CALIBRATE_EXPECT_ACCOUNT` as a run does.
- **Teardown cannot hang.** Its requests time out, 5 s to connect and 30 s to answer, and are retried; the SDK waits
  for ever by default. The workload's requests have no timeout, since a timed request must not be cut short: its
  client sets none, and its store is built with `readTimeoutMs: 0`, stated rather than left to the S3 package's
  default, so a change of that default cannot add one.
- **It runs only where it has prices.** Every run is priced at `us-east-1`'s rates, so a run anywhere else would
  record the wrong bill and check its ceiling against the wrong one. It is refused until a pricing profile for that
  region exists.
- **Error text is redacted.** AWS puts the caller's ARN, account id and all, in an AccessDenied message, so ARNs are
  removed and account ids masked in everything the harness prints and records.
- **Only `NoSuchBucket` means teardown has nothing left to remove.** An abort retried after its first answer was
  lost gets back a 404 `NoSuchUpload`, so a teardown that read *any* 404 as "already gone" would skip deleting the
  objects and the bucket, and report nothing. An abort that finds its upload gone is simply done, and only S3's own
  `NoSuchBucket` counts as removed.
- **Teardown's delete passes are bounded.** `DeleteObjects` reports a key it could not delete inside a 200, where no
  retry sees it, so a key that can never be deleted would keep an unbounded listing loop running — and billing.
  After three passes, what is left is reported as a leftover, and the projection covers every listing those passes
  make.

**Ctrl-C stops the work, then tears down.** A signal handler replaces Node's default exit, so a handler that only
logs leaves the workload running. This one first stops the workload's client, so every later request fails before it
is sent, and waits up to 30 s for the requests already sent to answer (`interruptGate` and `stopThenTearDown`, in
[`lib/calibrate-process.cjs`](lib/calibrate-process.cjs)). Only then does it tear down: a teardown that lists the
bucket while loads are still writing leaves the bucket behind, because a PUT that lands after the listing is not in
it. Waiting also lets a `CreateBucket` still in flight land before teardown looks for the bucket; if a request is
still unanswered after 30 s, teardown goes ahead, and a bucket it then cannot find is reported as one that may yet
appear, with the `--cleanup` line. The handler writes the results, every phase it had finished and the cost, marked
`interrupted`, with anything teardown left under `leftovers`, and a request that failed meanwhile under `error`. It
exits 130, unless the workload had finished and only teardown was left, when the run keeps its own exit code. A
second signal warns instead of killing the process mid-delete. The handler is armed before the bucket is created, so
an interrupt during creation tears down too, and a signal during `--cleanup` waits for the cleanup it interrupts.

A hang-up (a closed terminal, a dropped session) is handled the same way, with one more step. Node opens its
stdout and stderr on first use, and on macOS opening one on a terminal that has hung up never returns. A handler
whose first line of output is stderr's first use blocks there, before any teardown, so the harness opens both
streams at startup and writes nothing more to a terminal once it hangs up. Output to a pipe or a file carries on,
since a log still has a reader. The harness stops on a hang-up by design, `nohup` included, so to keep a run going
after the terminal closes, run it inside `tmux` or `screen`. A supervisor that sends SIGKILL soon after SIGTERM, as
`docker stop` does after 10 s, can kill it during the 30 s wait; give it longer, or run `--cleanup` afterwards.

The gate is tested against a local server that answers slowly, the stop-drain-teardown order with stand-ins, the
hang-up on a real pseudo-terminal that is then closed, and the whole path by interrupting rehearsals. Each ended with the bucket gone and the results written: eleven interrupted during the loads, three during the intersects, four by closing the terminal, and a cleanup interrupted mid-delete, which finished and exited 130. A cleanup was also pointed at a bucket holding someone else's upload, and at one whose foreign key sat on a second page of 1,002 objects; each was refused with nothing touched.

### What a run records, so its numbers cannot be misread

- **How far away the client was.** Ten trivial requests give a round-trip floor, recorded raw and labelled
  `in-region` below 30 ms or `REMOTE — latency below is network-dominated` above it (a rehearsal says `local
  container`). From outside the region, latency measures the internet. The line keeps another continent out, not
  a neighbouring region, so the raw floor is kept for a reader who wants a stricter one.
- **Every attempt, and only one per request.** The meter counts each attempt the SDK makes, retries included.
  The workload's client is pinned to a single attempt, and the timed intersects run with the store's own read
  retry off — so the request count is exact, and no retry's backoff hides inside a latency sample. A sample that
  meets a transient fault is not retried either: it is discarded whole and run again
  ([above](#a-sample-that-meets-a-transient-fault-is-discarded-and-run-again)), and a fault past the bound, or in a
  load, fails the run, keeping every phase it had finished. The latency figures are therefore from fault-free
  samples: on that path they match what a consumer with default settings sees, whose worst case adds up to three SDK
  attempts for each of the store's four, with backoff. Teardown and `--cleanup` keep the SDK's retries, on a second
  client metered into the same bill: a transient failure there would otherwise leave the bucket behind.
- **Cold reads only, and a count the network cannot move.** Each intersect gets a fresh store, so no cache can
  answer it, and the store's timed pointer refresh is off (`cache.genTtlMs: 0`). On the default 2 s refresh, an
  intersect slower than that reads each pointer again, which adds GETs to the 204 an intersect of this shape makes,
  so a count taken on the default would describe the network. A test drives the real engine on a slow clock to prove each pointer is read once.
- **Exact content.** Every pair of segments shares a planned set of ids, so each intersect must return precisely
  that set — the count *and* the sum — or the run refuses to report a latency.
- **The published shape.** 500,000-id segments spanning ~2,000 chunks with 100 shared, so the run tests the "100
  of 2,000 chunks" claim itself; plus dense segments of ~12 MiB so multipart is actually exercised.
- **Each stage's own requests, and each load's.** A load makes pointer reads that the meter files with an intersect's,
  so a run's totals cannot be divided between stages afterwards. Every stage records its requests as it makes them,
  every load records its own, and `lib/calibration-figures.cjs` prices each load from its record and refuses a file
  whose stages do not add up to what was billed. It also refuses a file for what the run reports as wrong itself:
  anything teardown left behind, a missed expected count, a stage whose requests are not the ones it expected, and a
  shell that ran in another region than the bucket's. Latency is labelled in-region only when the floor is under the
  line and the shell's region is the bucket's.
- **Chunk reads and the tail read, separately.** Measured request by request, a cold intersect reads exactly 100
  chunks per operand (about 516 bytes each) plus one 256 KiB read from the end of each object, which fetches the
  footer and index in a single round trip. They are reported apart: the chunk count is the proportional part and
  the tail read is a fixed cost per operand, and a single "fraction fetched" would describe neither.
- **The SDK that sent the requests.** `measured.sdk` holds the versions of `@aws-sdk/client-s3` and of the HTTP handler
  under it, read from what is installed (a CloudShell run installs the latest and deletes the scratch directory once the
  results are copied out), with `maxSockets: 50`, the handler's default, which the harness does not set. It bounds how many
  requests can really be in flight: an `andNot` widens its window from 8 keys to 32 and fetches every exclude of a key in the same round as its include, so
  on its first shared keys it can want more than 50, and its latency is read against that.
- **What it measured.** The package version, the harness commit (marked `-dirty` when the harness had uncommitted
  edits, since the commit alone would name a harness that did not run), the Node version, and how the timed stores
  were built.

### Running it in the region

```
# in AWS CloudShell, in the region being measured
git clone https://github.com/cloudbitmaps/cloudbitmaps && cd cloudbitmaps
CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.05 bash bench/calibrate-cloudshell.sh
```

Before it installs anything the script refuses three things: a `CR_CALIBRATE_REHEARSE` that is not unset, empty, `0` or
`1` (any other value would take the run that spends money); a shell with no `AWS_REGION`, which CloudShell exports; and a
`CR_CALIBRATE_REGION` that is not that region, since a floor under 30 ms cannot tell a neighbouring region from this one.
The shell's region is recorded with the results as `network.clientRegion`. The release measured is the one this clone's
`packages/roaring/package.json` names, which its expected counts were written for; `CR_CALIBRATE_PACKAGE_VERSION`
overrides it, and the script prints the version before it installs.

The script installs Node 22 if CloudShell's is older, installs the **published** `@cloudbitmaps/roaring` and
`@cloudbitmaps/s3` into a scratch directory, and runs the harness against those — so the figures describe what a
consumer installs, not a build of this checkout. A finished run's results land in `~/<runId>.json`, and an
interrupted one's in `~/<runId>.partial.json`, which is not evidence. A name already taken in `~` is left alone,
and this run's copy goes beside it with a timestamp, still a `.partial.json` if it was one. The script runs the
harness as a job of its own and passes on every signal that would stop it: a Ctrl-C, a closed CloudShell tab or a
`kill` reaches the harness exactly once, and the results are copied out only after it has stopped, with SIGPIPE
from a reader that has gone, such as a `tee`, ignored while they are. Were the harness run in the foreground, a
SIGTERM or a hang-up would stop the script at once, delete the scratch directory under the harness mid-teardown and
copy nothing, and a SIGTERM to the script alone would never reach the harness at all. A job of its own may write to
the terminal only while `tostop` is off, as it is by default, so a terminal with it set is refused before anything is installed. Commit a finished run's file as
`bench/calibration/<runId>.json`, with its report — [`calibration/`](calibration/README.md) says how. `CR_CALIBRATE_REHEARSE=1` runs the same install path against local MinIO, to test the script; its
results land in `~/calibrate-aws-rehearsal.json`.

### What it does not measure

Its scope is the three measurements above, on one workload shape. Still owed, and **not** in this harness yet:

- **The `*Into` verbs**, which publish their result as a new generation of a destination segment.
- **Other shapes of combine** — an intersect of more than two operands, a union, or an `andNot` with a different
  include operand. It measures two operands, and one include operand against ten excluded.
- **Lambda.** CloudShell is a long-lived shell inside the region; a function's cold start and initialisation are
  a separate figure, which needs a run from inside a function.

### What the rehearsal cannot cover

MinIO is not AWS. A rehearsal proves the stages, the metering, the teardown order, the probe, the end-of-run
projection check and the signal handling. It never reaches the money guards — the region, the confirmation, the
spend ceiling and the account pin — which is why the ceiling's are pure functions with their own tests. It cannot
rehearse emptying a versioned bucket or aborting an in-flight multipart upload on a real account, and it does not
reproduce `us-east-1` answering 200 OK to `CreateBucket` on a bucket you own. Those paths first meet reality on a
real run — which is why the probe refuses anything that is not a clean 404.

## `lib/`

| file | what it is |
|---|---|
| `lib/aws-meter.cjs` | Counts every request the AWS SDK sends, as middleware — every attempt, retries included, read from the attempt count the SDK's retry loop records, and including requests the library never reports, like a multipart upload's parts. Classifies by **billing class**, not HTTP verb (a `LIST` bills like a `PUT`, twelve and a half times a `GET`), and splits `GetObject` by the shape of its `Range` header so chunk reads and the tail read can be told apart. An unrecognised command is counted as a paid read, never as free. |
| `lib/calibrate-guards.cjs` | The guards above, plus the planned id layouts (`planLayout`, `planSweepLayout`, `layoutIds`), the account mask and the redaction of error text (`maskAccount`, `redact`), what LEFTOVERS says last (`leftoversHint`), which file each kind of run writes and what makes a usable run id (`resultsFile`, `stampOf`, `EVIDENCE_DIR`, `checkRunId`, `checkCleanupId`), the workload's bounds and the one priced region (`checkWorkload`, `MAX_SEGMENTS`, `checkRunRegion`), how the timed and the warm stores are built (`TIMED_STORE`, `warmStore`, `STORE_PREFIX`), how many attempts each of the two S3 clients makes (`clientConfigs`), and what teardown counts as done, what it refuses and how long it waits (`bucketIsGone`, `uploadIsGone`, `TEARDOWN_PASSES`, `foreignKeys`, `MAX_LISTING_PAGES`, `ADMIN_TIMEOUTS`). Pure functions, so each can be tested against the bug it exists for. |
| `lib/calibrate-process.cjs` | How a run stops and what it leaves behind: the gate that stops the workload's client and waits for what it sent before teardown (`interruptGate`, `stopThenTearDown`), what a failure records, its name, its code and its message, and what a signal exits with (`faultOf`, `failureOf`, `describeFault`, `exitCodeAfterSignal`), the SDK's own classes of retryable fault (`sdkFaultClasses`), the terminal's streams opened at startup and silenced on a hang-up (`holdTerminal`, `silenceTerminal`), results written without ever replacing a file (`writeResultsFile`), and the harness commit, marked when dirty (`harnessRef`). Kept apart from the pure guards so each can be driven in a test. |
| `lib/calibrate-samples.cjs` | The timed samples that survive a transient fault: what counts as one (`transientFault`), the ledger every timed sample runs through, which discards a failed one whole, records it beside its stage and runs it again, at most three a run and two a stage (`discardLedger`, `DISCARDS_PER_RUN`, `DISCARDS_PER_STAGE`), the wait for a failed sample's requests to answer (`quiesce`), a stage's requests with and without its discards (`keptRequests`, `discardedRequests`), and a rehearsal's injected faults (`parseFaultGets`, `injectFaults`). |
| `lib/calibrate-spread.cjs` | The spread layout: the calibration overlap with its shared chunks at keys spread uniformly over each segment, from a fixed seed, so the bytes between two shared chunks are chunks an intersect never wants. A pure function (`planSpread`, `spreadIds`) whose placement is reproducible and whose overlap, as a count and a sum, is known exactly. |
| `lib/calibrate-stages.cjs` | The one table of the calibration run's stages (`STAGES`), the most each can request and the most one of its samples can (`projectStages`, the pre-flight projection and the end-of-run check, with its allowance for discarded samples; `sampleBounds`) and the exact requests the engine is expected to make for each (`expectedReads`), plus the sweep list (`parseSweep`). A stage the harness runs that is not in the table fails its test. |
| `lib/sizing-pages.cjs` | Which generated `SIZING` regions live on which page, and which charts `sizing.cjs` draws: one list, read by `sizing.cjs`, which writes them, and by `scripts/site-figures.cjs`, which leaves exactly those regions to `pnpm bench:sizing:check` and refuses any other `SIZING` marker |
| `lib/sizing-markers.cjs` | The one reader of `SIZING` markers, for `sizing.cjs` and `scripts/site-figures.cjs` alike, so the two agree on where every region begins and ends: each takes every comment shaped like a marker for one, so a page quotes none, and refuses a malformed one |
| `lib/log-chart.cjs` | The log–log chart `sizing.cjs` draws its two charts with, in the crossover chart's style, once for each theme: a card and palette of its own, every line and region named in words, and in-plot text ringed in the card's colour. It refuses rather than draws a point outside the axes, a label past the card's edge, within a third of an em of another label, across a line or a marker's dot, or on the wrong side of the region it names, and an axis from zero |
| `lib/elasticache-prices.cjs` | ElastiCache's reserved prices for every catalogue node type, and the one reader of AWS's price list they are held to: each node on its full key, `NodeUsage:<type>`, and a key that matches none or several refused |
| `lib/calibration-figures.cjs` | Every figure a calibration run lets the project publish, derived from the run's evidence, the pricing profile and the library's own constants — and a refusal for evidence that does not reconcile with itself. `tests/docs/calibration-reports.test.ts` holds the run reports and the benchmarks page to it, and `scripts/site-figures.cjs` takes the site's single-bucket figures from it. |

## Adding a harness

- **Open with a header that says why it exists** — what claim it measures and what would be wrong without it.
  Every file here does, and it is the part a later reader most needs.
- **Write a results file, not only a log line.** A measurement that is not recorded does not exist: a figure
  measured on every pull request is still owed if its numbers go to a container's stdout and nowhere else.
- **Gate any figure you publish.** A number that reaches the site is checked against its results file by
  `scripts/site-figures.cjs`; add it there, or the page can drift from the run. A calibration run's figures come
  out of `lib/calibration-figures.cjs`, which the run's report, the benchmarks page and the site all share.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
