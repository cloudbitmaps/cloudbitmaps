# `bench/calibration/batch/` — the batch suite's runs

The evidence of `node bench/calibrate-aws.cjs --suite batch`: one `store.materializeMany` call of the refresh shape's outputs (100
stored operands of 200,000 ids and 1,000 outputs, each a tree of one or two levels with an opt-out operand excluded) onto
destinations nothing has written, measured against a real object store. It is not the guide's refresh call, whose
destinations already hold a generation, so its counts are not that call's figures. [`bench/README.md`](../../README.md#the-batch-suite) says what the suite measures, how each
stage is bounded and held to its exact counts, and how to rehearse and run it.

Each finished run has one file here, named by its run id and committed unedited, as in the
[default suite's directory](../README.md):

- **`<runId>.json`, the evidence.** The results file the harness wrote: each stage's requests by class, the bytes, the
  timings, the groups each call ran in, each sample's requests and those of reading its outputs back, the requests the
  engine was expected to make and the plan they were computed from (with the size set arithmetic gives each output), and
  the code it ran. It is written once, under a new id, and a run whose id has a file here is refused. A run that does
  not finish writes `<runId>.partial.json` instead, which is not evidence and which git ignores; a rehearsal writes
  `bench/calibrate-aws-rehearsal-batch.json`, ignored the same way.

`bench/lib/batch-evidence.cjs` is the check a committed file is held to (a test reads every file here through it): a
finished run of the batch suite with no count missed, the projection not exceeded, a bill, and every stage's and every
sample's requests equal to the expected ones in both classes. No default-suite figure is derived from a batch run.

## What a run records about its call

- **The call's settings**, in `workload`: `publishConcurrency`, `concurrency` and `maxBufferedBytes` as passed to
  `materializeMany`, each `null` for "not passed: the library's default", beside the sample count (`samples`). The harness
  passes `publishConcurrency` only when `CR_CALIBRATE_BATCH_PUBLISH_CONCURRENCY` (1 to 1,024) is set; the other two are
  never passed. The expected requests and groups in the file are those of a call made with the same settings, since the
  grouping depends on them. The gate refuses a new run's file that lacks them. The two files below were written before
  the fields existed and are never edited, so the gate reads their absence as "not passed".
- **Each sample's depth and unfiled reads**: `peakInFlight` and `meanInFlight` of that call (its peak requests in flight,
  and its requests' summed time over its wall time), and `noObjectReads`, the call's GET-class requests that returned no
  object (a HEAD, a read that found nothing, the earlier attempt of a retried one). The meter files a read under a kind
  only when it returns an object, so a sample's `get` is `rangeReads + tailReads + pointerReads + noObjectReads`, and the
  gate holds that identity for every new run.

## A run at another value

A run whose settings are not all `null` is a run at another value. The benchmarks page's section headed with the latest
run at the defaults stays on the newest run that passed nothing, however new a run at another value is, and a run at
another value is never compared with it unless both ran in one CloudShell session: latencies of runs from different
sessions are not comparable. So, to make the comparison, run the defaults first and the other value straight after, in
the same session (the commands are in [`bench/README.md`](../../README.md#the-batch-suite)). When the evidence of a run at
another value lands, give it:

- a section in [`docs/benchmarks.md`](../../../docs/benchmarks.md) headed
  ``## Many outputs from one call — run `<run id>` (`publishConcurrency` 64)``, naming each setting that was passed, that
  states every figure the defaults section states for its own file;
- a row in the table below that names the same settings, as `` `publishConcurrency` 64 ``;
- and, in the same change, the four places that say no run at another value has been made: the `[Unreleased]` entry in
  [`CHANGELOG.md`](../../../CHANGELOG.md), the batch bullet of "What it does not measure" in
  [`bench/README.md`](../../README.md), the batch section's "What these figures are not" in [`docs/benchmarks.md`](../../../docs/benchmarks.md)
  and the loaded-store row of [`docs/ROADMAP.md`](../../../docs/ROADMAP.md).

`tests/docs/batch-figures.test.ts` holds both, and holds every link to the defaults section's anchor to the latest run at
the defaults, so a new run at the defaults moves those links in the same change.

This directory is separate from `bench/calibration/` on purpose: the default suite's figures, its report gates and the
site's single-bucket figures list that directory without descending into it, so a run of the batch suite is never their
latest run and cannot move them.

## Runs

| report · evidence | when, and from where | what it established |
|---|---|---|
| no report file · [`2026-11-03-78516.json`](2026-11-03-78516.json) | 2026-11-03 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.27.0` packages, harness `3ed7d62d` | The first run of the batch suite, in an earlier CloudShell session than the second run's: three cold `materializeMany` calls of the refresh shape's 1,000 outputs over 100 stored operands, onto destinations nothing had written, run with `keep: 12`, the request budget lifted and `publishConcurrency` 8 and `concurrency` 1 at their defaults. Every stage and every sample made the counted requests (**measured**): each sample 2,000 PUT-class and 4,449 GET-class in 8 groups with 1,000 outputs published, then 1,000 GET-class to read them back; the stages 6,000 PUT-class and 16,347 GET-class; the run 6,216 PUT-class and 16,658 GET-class, $0.0377432. No discarded sample, not partial. Median 64,034 ms a call (3 calls), 15.62 outputs a second, `peakRssMB` 740 to 751. Its latencies are not comparable with the second run's, a different session's. |
| no report file · [`2026-11-08-b12e6.json`](2026-11-08-b12e6.json) | 2026-11-08 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1` (round-trip floor 5.64 ms, so in-region), against the published `0.27.0` packages, harness `3ed7d62d` | The second run of the batch suite, the one [the benchmarks page](../../../docs/benchmarks.md#many-outputs-from-one-call--run-2026-11-08-b12e6) publishes: the same suite, packages, shape and counted requests as the first run's, every one exact (**measured**), the same bill, no discarded sample, not partial. Median 53,192 ms a call and 95th percentile 61,032 ms (3 calls), 18.80 outputs a second at the median, `peakRssMB` 724 to 754 with 2,609 MiB available. The median call averaged about five requests in flight (`medianMeanInFlight` 5.11, summed request time over wall time) and the median call peaked at 49 (`medianPeakInFlight`, **measured**), at the defaults `publishConcurrency` 8 and `concurrency` 1. It is a first materialization onto new destinations, not the guide's refresh call, so it neither measures nor confirms that call's figures. |
