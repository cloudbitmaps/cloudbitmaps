# `bench/calibration/batch/` — the batch suite's runs

The evidence of `node bench/calibrate-aws.cjs --suite batch`: one refresh-shaped `store.materializeMany` call (100 stored
operands of 200,000 ids and 1,000 outputs, each a tree of one or two levels with an opt-out operand excluded), measured
against a real object store. [`bench/README.md`](../../README.md#the-batch-suite) says what the suite measures, how each
stage is bounded and held to its exact counts, and how to rehearse and run it.

Each finished run has one file here, named by its run id and committed unedited, as in the
[default suite's directory](../README.md):

- **`<runId>.json`, the evidence.** The results file the harness wrote: each stage's requests by class, the bytes, the
  timings, the groups each call ran in, the requests the engine was expected to make and the plan they were computed from,
  and the code it ran. It is written once, under a new id, and a run whose id has a file here is refused. A run that does
  not finish writes `<runId>.partial.json` instead, which is not evidence and which git ignores; a rehearsal writes
  `bench/calibrate-aws-rehearsal-batch.json`, ignored the same way.

This directory is separate from `bench/calibration/` on purpose: the default suite's figures, its report gates and the
site's single-bucket figures list that directory without descending into it, so a run of the batch suite is never their
latest run and cannot move them.

## Runs

None yet. The suite has been built and rehearsed against MinIO; it has not been run on S3.
