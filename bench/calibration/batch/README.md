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

This directory is separate from `bench/calibration/` on purpose: the default suite's figures, its report gates and the
site's single-bucket figures list that directory without descending into it, so a run of the batch suite is never their
latest run and cannot move them.

## Runs

| no report file · [`2026-11-03-78516.json`](2026-11-03-78516.json) | 2026-11-03 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.27.0` packages, harness `3ed7d62d` | The first run of the batch suite, in an earlier CloudShell session than the second run's: three cold `materializeMany` calls of the refresh shape's 1,000 outputs over 100 stored operands, onto destinations nothing had written, run at the call's defaults. Every stage and every sample made the counted requests (**measured**): each sample 2,000 PUT-class and 4,449 GET-class in 8 groups with 1,000 outputs published, then 1,000 GET-class to read them back; the stages 6,000 PUT-class and 16,347 GET-class; the run 6,216 PUT-class and 16,658 GET-class, $0.0377432. No discarded sample, not partial. Median 64,034 ms a call (3 calls), 15.62 outputs a second, `peakRssMB` 740 to 751. Its latencies are not comparable with the second run's, a different session's. |
| no report file · [`2026-11-08-b12e6.json`](2026-11-08-b12e6.json) | 2026-11-08 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1` (round-trip floor 5.64 ms, so in-region), against the published `0.27.0` packages, harness `3ed7d62d` | The second run of the batch suite, the one [the benchmarks page](../../../docs/benchmarks.md#many-outputs-from-one-call--run-2026-11-08-b12e6) publishes: the same suite, packages, shape and counted requests as the first run's, every one exact (**measured**), the same bill, no discarded sample, not partial. Median 53,192 ms a call and 95th percentile 61,032 ms (3 calls), 18.80 outputs a second at the median, `peakRssMB` 724 to 754 with 2,609 MiB available. About five requests were in flight on average (`medianMeanInFlight` 5.11, summed request time over wall time) and at most 49 (**measured**), at the defaults `publishConcurrency` 8 and `concurrency` 1. It is a first materialization onto new destinations, not the guide's refresh call, so it neither measures nor confirms that call's figures. |
