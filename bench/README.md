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
| `run.cjs` | The read-cost curve against a flat Redis-HA node, and where they cross — computed from the **shipped** estimator (`estimateCost`) and the default pricing, so the chart cannot drift from the library's own arithmetic. | `pnpm bench` | `crossover.svg`, `results.json`, and the chart + stats table inside `docs/benchmarks.md` and `site/benchmarks.html` (between `BENCH` markers) | its deterministic anchors, via `tests/bench/anchors.test.ts` |
| `scale.cjs` | A fleet of up to 100,000 segments on local disk: retained heap as the fleet grows (the memory bound), the `O(total)` cost of enumerating it, and chunk-skipping on two large segments. | `pnpm bench:scale` (heavy); `SCALE_FLEETS=1000,10000` for a quick pass | `scale-results.json`, and the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` | no — too slow and too machine-dependent |
| `soak.cjs` | The loaded store under **sustained** mixed load — point reads, combines with `exclude` lists, and re-loads — watching post-GC heap *and* the addon's off-heap memory for creep over time. A run with no combines or no re-loads is reported inconclusive, never a pass. | `pnpm soak` (`SOAK_INJECT=1` to persist) | `soak-results.json` | yes, inside `pnpm rss-gate` (see `scripts/`) |
| `encoding.cjs` | Encoded size of the same ids under roaring against a fixed array, a fixed bitset and a fixed run-length encoding — the evidence behind the site's claim that roaring's advantage is choosing a representation *per chunk*. | `pnpm bench:encoding` | `encoding-results.json` | no |
| `calibrate-aws.cjs` | Against a **real** object store: load throughput (single-part and multipart), cold intersect latency, and what a single-bucket topology actually costs per request. It spends money — see [below](#real-cloud-calibration). | `pnpm calibrate:aws` | `calibrate-aws-results.json`; a rehearsal writes `calibrate-aws-rehearsal.json` instead, which git ignores | its guards, via `tests/bench/calibrate-guards.test.ts` |
| `calibrate-cloudshell.sh` | The same calibration, run from AWS CloudShell inside the region, against the **published** packages installed from npm. | `bash bench/calibrate-cloudshell.sh` | `~/calibrate-aws-results.json` in CloudShell | no |

## The results files, and what reads them

Each is committed and regenerated only by its harness. The last column says what checks each one — and where a
figure is published from it with no check behind it, the row says that too.

| file | written by | read by |
|---|---|---|
| `results.json` | `run.cjs` | `scripts/site-figures.cjs`, which checks the site's money figures against it |
| `crossover.svg` | `run.cjs` | `docs/benchmarks.md`, as an image. The site does **not** read this file: `run.cjs` inlines its own copy of the chart into `site/benchmarks.html`, where the page's colour tokens resolve so the chart follows light and dark |
| `scale-results.json` | `scale.cjs` | `scripts/site-replay.cjs`, which derives `site/assets/replay.json` from it and holds `demo.html`'s figures to it. **The at-scale table is not checked against it:** regenerate that table with `pnpm bench:scale:render`, which renders it from this file, rather than editing it by hand |
| `soak-results.json` | `soak.cjs` | `scripts/site-figures.cjs`, against the combine count and native-memory creep `site/benchmarks.html` quotes |
| `encoding-results.json` | `encoding.cjs` | `scripts/site-figures.cjs`, against the sizes `site/flavors/roaring.html` quotes |
| `rss-gate-results.json` | `scripts/rss-gate.sh` | `scripts/site-figures.cjs` — the hard RSS ceiling on the benchmarks page |

`calibrate-aws.cjs` writes a seventh, `calibrate-aws-results.json`. It is not committed yet: it arrives with the
first in-region run, together with the gate that checks the figures published from it. A rehearsal writes
`calibrate-aws-rehearsal.json` instead, which git ignores — it has the same shape as a real run's file, so under
the same name it would be one `git add` from being committed as the evidence.

## Real-cloud calibration

`calibrate-aws.cjs` pays three debts listed on the benchmarks page, all of which need a real object store rather
than local disk:

1. **Load throughput** — ids/s and bytes/s into a bucket, for objects that fit one PUT and objects large enough
   to upload multipart.
2. **Cold intersect latency** — wall-clock for a chunk-skipping `A ∩ B` that has to fetch from the object store.
3. **The single-bucket bill** — the registry pointer now lives in the same bucket as the data, so resolving a
   generation costs an object GET and advancing one costs a conditional PUT. The published cost figures predate
   that, and billed the pointer to a separate table.

### It spends money, so it is hard to run by accident

| mode | what it does |
|---|---|
| `pnpm calibrate:aws` | **Projection only.** Prints the worst-case request count and dollar cost. Touches nothing, reads no credentials. |
| `pnpm calibrate:aws --rehearse` | The workload, the metering, teardown and signal handling, against the MinIO in `docker-compose.yml` (`docker compose up -d minio`). Free — and so none of the money guards run. |
| `pnpm calibrate:aws --run` | The real thing. Refuses unless the region, a spend ceiling and a typed confirmation are each set. |
| `pnpm calibrate:aws [--rehearse] --cleanup <runId>` | Removes a run's bucket after a kill that nothing could catch. |

A real run needs, separately:

```
CR_CALIBRATE_REGION=us-east-1          # never guessed
CR_CALIBRATE_MAX_USD=0.25              # checked before the run AND during it
CR_CALIBRATE_CONFIRM=yes-spend-money   # a typo must not spend money
CR_CALIBRATE_EXPECT_ACCOUNT=<12 digits> # optional: refuses to run in any other account
```

It then prints the account — **last four digits only**, enough to recognise, not enough to be worth pasting — and
waits ten seconds so you can Ctrl-C before anything is created. The default workload projects to under half a cent.

### The guards

Most live in [`lib/calibrate-guards.cjs`](lib/calibrate-guards.cjs) as pure functions, each with a test that
plants the bug it exists for. Every one of them was a real bug, either in this harness or in the one it replaced:

- **The spend ceiling is validated before it is compared.** `Number('abc')` is `NaN`, and every comparison
  against `NaN` is false — so a malformed ceiling once silently *removed* the bound.
- **An explicit `0` means zero.** A helper once mapped a falsy size to the default, handing someone shrinking a run
  the full workload.
- **Only a clean 404 means "the bucket does not exist".** `HeadBucket` answers **403** for a bucket you own but
  cannot list, and in `us-east-1` `CreateBucket` on a bucket you already own returns **200 OK** — so reading 403
  as absent would run the workload inside a real bucket of yours and then delete it on teardown.
- **The projection is a real upper bound, and every run checks it.** It counts both operands of an intersect, and
  its retry bound must match the loop in `publishGeneration`: a test reads the loop's number out of the source and
  fails if they differ, because an earlier version retyped it wrong. The workload's client makes one attempt per
  request, and every attempt teardown's client may make is allowed for, so no SDK retry can fall outside it either.
  After teardown, the run compares what it actually issued against what it projected, and flags itself if it went
  over.
- **Only `NoSuchBucket` means teardown has nothing left to remove.** Teardown once read *any* 404 as "already
  gone" — and an abort retried after its first answer was lost gets back a 404 `NoSuchUpload`. It then skipped
  deleting the objects and the bucket, and reported nothing. An abort that finds its upload gone is now simply
  done, and only S3's own `NoSuchBucket` counts as removed.
- **Teardown's delete passes are bounded.** `DeleteObjects` reports a key it could not delete inside a 200, where no
  retry sees it, so a key that can never be deleted kept the listing loop running — and billing. After three
  passes, what is left is reported as a leftover, and the projection covers every listing those passes make.

**Ctrl-C tears down** — and this one lives in the harness itself, not in the pure functions, so it has no unit
test. A signal handler replaces Node's default exit, so a handler that only logs leaves the workload running, and
the first version did exactly that. This one tears down, writes the results — every phase it had finished, and the
cost — marked `interrupted`, and exits 130. A second signal during teardown warns instead of killing the process
mid-delete, and the handler is armed before the bucket is created, so an interrupt during creation tears down too.
It is proven by interrupting rehearsals: mid-load, mid-intersect, and twice in quick succession during
teardown, each ending with the bucket gone and the cost recorded.

### What a run records, so its numbers cannot be misread

- **How far away the client was.** Ten trivial requests give a round-trip floor, recorded raw and labelled
  `in-region` below 30 ms or `REMOTE — latency below is network-dominated` above it (a rehearsal says `local
  container`). From outside the region, latency measures the internet. The line keeps another continent out, not
  a neighbouring region, so the raw floor is kept for a reader who wants a stricter one.
- **Every attempt, and only one per request.** The meter counts each attempt the SDK makes, retries included.
  The workload's client is pinned to a single attempt, and the timed intersects run with the store's own read
  retry off — so the request count is exact, no retry's backoff hides inside a latency sample, and a transient
  failure fails the run, keeping every phase it had finished, rather than being retried. The latency figures are
  therefore from fault-free runs: on that path they match what a consumer with default settings sees, whose worst
  case adds up to three SDK attempts for each of the store's four, with backoff. Teardown and `--cleanup` keep the
  SDK's retries, on a second client metered into the same bill: a transient failure there would otherwise leave
  the bucket behind.
- **Cold reads only.** Each intersect gets a fresh store, so no cache can answer it.
- **Exact content.** Every pair of segments shares a planned set of ids, so each intersect must return precisely
  that set — the count *and* the sum — or the run refuses to report a latency.
- **The published shape.** 500,000-id segments spanning ~2,000 chunks with 100 shared, so the run tests the "100
  of 2,000 chunks" claim itself; plus two dense segments of ~12 MiB so multipart is actually exercised.
- **Chunk reads and the tail read, separately.** Measured request by request, a cold intersect reads exactly 100
  chunks per operand (about 516 bytes each) plus one 256 KiB read from the end of each object, which fetches the
  footer and index in a single round trip. They are reported apart: the chunk count is the proportional part and
  the tail read is a fixed cost per operand, and a single "fraction fetched" would describe neither.
- **What it measured.** The package version, the harness commit and the Node version.

### Running it in the region

```
# in AWS CloudShell, in the region being measured
git clone https://github.com/cloudbitmaps/cloudbitmaps && cd cloudbitmaps
CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.25 bash bench/calibrate-cloudshell.sh
```

The script installs Node 22 if CloudShell's is older, installs the **published** `@cloudbitmaps/roaring` and
`@cloudbitmaps/s3` into a scratch directory, and runs the harness against those — so the figures describe what a
consumer installs, not a build of this checkout. Results land in `~/calibrate-aws-results.json` even if the run
is interrupted. `CR_CALIBRATE_REHEARSE=1` runs the same install path against local MinIO, to test the script;
its results land in `~/calibrate-aws-rehearsal.json`.

### What it does not measure

Its scope is the three debts above, on one workload shape. Also owed, and **not** in this harness yet:

- **`andNot` with a large `exclude`**, and the `*Into` verbs, which publish their result as a new generation of
  a destination segment.
- **Other shapes of intersect** — more than two operands, or a sweep of how many chunks the operands share. It
  measures one shape, the published one.
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
| `lib/calibrate-guards.cjs` | The guards above, plus the planned id layout (`planLayout`, `layoutIds`), the account mask, which file each kind of run writes (`resultsFile`), how many attempts each of the two S3 clients makes (`clientConfigs`), and what teardown counts as done (`bucketIsGone`, `uploadIsGone`, `TEARDOWN_PASSES`). Pure functions, so each can be tested against the bug it exists for. |

## Adding a harness

- **Open with a header that says why it exists** — what claim it measures and what would be wrong without it.
  Every file here does, and it is the part a later reader most needs.
- **Write a results file, not only a log line.** A measurement that is not recorded does not exist: the RSS
  ceiling was measured on every pull request for months and listed as owed, because its numbers went to a
  container's stdout and nowhere else.
- **Gate any figure you publish.** A number that reaches the site is checked against its results file by
  `scripts/site-figures.cjs`; add it there, or the page can drift from the run.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
