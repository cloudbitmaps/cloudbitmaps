# `bench/calibration/multi/` — the multi suite's runs

The evidence of `node bench/calibrate-aws.cjs --suite multi`: an `intersect` and an `intersectCount` over three to ten
stored operands, in seven shapes (k = 3, 5 and 10 at 1,000,000 ids and a 20 % core; k = 5 at 5,000,000 ids; k = 5 at a
5 % and a 50 % core; and a near miss, where a band of chunks is held by every operand but one), measured against a real
object store. [`bench/README.md`](../../README.md#the-multi-operand-suite) says what the suite measures and does not,
how each stage is bounded and held to its exact counts, and how to rehearse and run it.

**There is no run here yet.** The suite has not run on S3, so this directory holds only this file, and no figure on the
benchmarks page or in the roadmap rests on it.

Each finished run will have one file here, named by its run id and committed unedited, as in the
[default suite's directory](../README.md):

- **`<runId>.json`, the evidence.** The results file the harness wrote: each stage's requests by class, the bytes, the
  timings, each shape's reads (the requests by kind, the bytes read against the bytes of the k objects, and each sample's
  own requests and in-flight depth), the requests the engine was expected to make and the counts they were computed
  from, and the code it ran. It is written once, under a new id, and a run whose id has a file here is refused. A run
  that does not finish writes `<runId>.partial.json` instead, which is not evidence and which git ignores; a rehearsal
  writes `bench/calibrate-aws-rehearsal-multi.json`, ignored the same way.

`bench/lib/multi-evidence.cjs` is the check a committed file is held to (a test reads every file here through it): a
finished run of the multi suite with no count missed, the projection not exceeded, a bill, every stage's requests equal to
the expected ones in both classes, and every shape's reads exact, as many as asked, at the expected requests and under
the bound. No default-suite figure is derived from a multi run.

When the first run lands, the same change updates `docs/benchmarks.md` ("What is still owed" and a section naming which
shapes were measured and which were not: `union` and `andNot` over k operands, run-encoded containers, unequal sizes) and
the roadmap's line on the measurement, with measured figures.

This directory is separate from `bench/calibration/` on purpose: the default suite's figures, its report gates and the
site's single-bucket figures list that directory without descending into it, so a run of the multi suite is never their
latest run and cannot move them.
