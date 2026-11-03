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

None yet. The suite has been built and rehearsed against MinIO; it has not been run on S3.
