# `bench/calibration/large/` — the large suite's runs

The evidence of `node bench/calibrate-aws.cjs --suite large`: combines (an intersect, a union, an `andNot` and the three
`*Into` verbs) on operands of about a million, five million and ten million ids, measured against a real object store.
[`bench/README.md`](../../README.md#the-large-suite) says what the suite measures, how each stage is bounded and held to
its exact counts, and how to rehearse and run it.

Each finished run has one file here, named by its run id and committed unedited, as in the
[default suite's directory](../README.md):

- **`<runId>.json`, the evidence.** The results file the harness wrote: each stage's requests by class, the bytes, the
  timings, the layouts, the requests the engine was expected to make and the plan they were computed from, and the
  code it ran. It is written once, under a new id, and a run whose id has a file here is refused. A run that does not
  finish writes `<runId>.partial.json` instead, which is not evidence and which git ignores; a rehearsal writes
  `bench/calibrate-aws-rehearsal-large.json`, ignored the same way.

This directory is separate from `bench/calibration/` on purpose. The default suite's figures, its report gates and the
site's single-bucket figures list that directory without descending into it, so a run of the large suite is never
their latest run and cannot move them. `tests/bench/calibrate-large.test.ts` holds that, and holds each file here to
being a finished, exact run of the large suite: every stage kept the requests it was expected to make, none was
exceeded, and the bill is recorded. With no run committed it checks nothing.

No run has been committed yet, so this directory holds no figure.

## Runs

| report · evidence | when, and from where | what it established |
|---|---|---|
