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
| `calibrate-aws.cjs` | Against a **real** object store: load throughput (single-part and multipart), cold intersect latency, and what a single-bucket topology actually costs per request. It spends money — see [below](#real-cloud-calibration). | `pnpm calibrate:aws` | one evidence file per finished real run, `calibration/<runId>.json`; a real run that does not finish writes `calibration/<runId>.partial.json`, and a rehearsal `calibrate-aws-rehearsal.json`, both of which git ignores | its guards, via `tests/bench/calibrate-guards.test.ts` |
| `calibrate-cloudshell.sh` | The same calibration, run from AWS CloudShell inside the region, against the **published** packages installed from npm. | `bash bench/calibrate-cloudshell.sh` | `~/<runId>.json` in CloudShell, which belongs in `calibration/`, or `~/<runId>.partial.json` for a run that did not finish | no |

## The results files, and what reads them

Each is committed and regenerated only by its harness. The last column says what checks each one — and where a
figure is published from it with no check behind it, the row says that too.

| file | written by | read by |
|---|---|---|
| `results.json` | `run.cjs` | `scripts/site-figures.cjs`, which checks the site's money figures against it |
| `crossover.svg` | `run.cjs` | `docs/benchmarks.md`, as an image. The site does **not** read this file: `run.cjs` inlines its own copy of the chart into `site/benchmarks.html`, where the page's colour tokens resolve so the chart follows light and dark |
| `scale-results.json` | `scale.cjs` | `scripts/site-replay.cjs`, which holds `demo.html`'s figures to it, and `scale.cjs` itself: `pnpm bench:scale:render` renders the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` from it, and `pnpm bench:scale:check` fails in CI if either copy is not what it renders |
| `soak-results.json` | `soak.cjs` | `scripts/site-figures.cjs`, against the combine count and native-memory creep `site/benchmarks.html` quotes |
| `encoding-results.json` | `encoding.cjs` | `scripts/site-figures.cjs`, against the sizes `site/flavors/roaring.html` quotes |
| `rss-gate-results.json` | `scripts/rss-gate.sh` | `scripts/site-figures.cjs` — the hard RSS ceiling on the benchmarks page |
| `calibration/` | `calibrate-aws.cjs`: one evidence file per real run, beside that run's report. The directory has [its own README](calibration/README.md), which lists every run | `tests/docs/calibration-reports.test.ts`, against each run's report and the benchmarks page's section on the latest run; `scripts/site-figures.cjs`, against the site's single-bucket figures |

A rehearsal writes `calibrate-aws-rehearsal.json` instead, which git ignores — it has the same shape as a real
run's file, so under an evidence name it would be one `git add` from being committed as the evidence.

## Real-cloud calibration

`calibrate-aws.cjs` was built to pay three debts the benchmarks page listed, all of which need a real object store
rather than local disk. It has paid one of them:

1. **Load throughput** — ids/s and bytes/s into a bucket, for objects that fit one PUT and objects large enough
   to upload multipart. Still owed: it needs a run from inside the region.
2. **Cold intersect latency** — wall-clock for a chunk-skipping `A ∩ B` that has to fetch from the object store.
   Still owed, for the same reason.
3. **The single-bucket bill** — the registry pointer now lives in the same bucket as the data, so resolving a
   generation costs an object GET and advancing one costs a conditional PUT. **Paid** by its first publishable
   run, [`2026-09-23-94416`](calibration/2026-09-23-94416.md), from a laptop. A request count, and so the bill for
   requests, does not depend on where the client is, with one exception that run found: an intersect slower than
   the pointer refresh reads each pointer again. The harness now pins the pointer for each timed intersect. Bytes
   read out of the region are billed as transfer, which the harness counts and does not price.

### It spends money, so it is hard to run by accident

| mode | what it does |
|---|---|
| `pnpm calibrate:aws` | **Projection only.** Prints the worst-case request count and dollar cost. Touches nothing, reads no credentials. |
| `pnpm calibrate:aws --rehearse` | The workload, the metering, teardown and signal handling, against the MinIO in `docker-compose.yml` (`docker compose up -d minio`). Free — and so none of the money guards run. |
| `pnpm calibrate:aws --run` | The real thing. Refuses unless the region, a spend ceiling and a typed confirmation are each set. |
| `pnpm calibrate:aws [--rehearse] --cleanup <runId>` | Removes a run's bucket after a kill that nothing could catch. It checks the account pin as a run does, and refuses a bucket holding anything the harness did not write. |

A real run needs, separately:

```
CR_CALIBRATE_REGION=us-east-1          # never guessed, and us-east-1 only: the one region it has prices for
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
  fails if they differ, because an earlier version retyped it wrong. A load reads the pointer three times even with
  nothing racing it (the loader, the publish, and the registry before its conditional write) and up to twelve if
  every publish attempt loses, which a test drives through the real registry code; the projection once allowed
  one read per attempt. The workload's client makes one attempt per request, and every attempt teardown's client
  may make is allowed for, so no SDK retry can fall outside it either. After teardown, the run compares what it
  actually issued against what it projected, and flags itself if it went over.
- **Evidence is write-once.** A real run's results go to a file named by its run id, and the harness refuses —
  before it reads any credentials, and before it even loads the library — to overwrite one that exists: a second
  run under a published run's id would replace the file its figures are checked against. The id is checked before
  anything uses it, because it names the bucket and the file: a real date, then a label, with none of the suffixes
  S3 keeps for its own kinds of bucket. Nothing is replaced at the end either: a run whose file appeared while it
  ran, or a retry whose partial name is taken, writes `<runId>.<start>.partial.json` beside it and says so.
- **The workload fits one teardown listing.** Teardown lists 1,000 object versions a pass and each segment leaves
  two, so a run loads at most 500 segments. A rehearsal of 1,510 passed every guard and left 20 versions behind.
- **Teardown empties only a bucket the harness made.** It aborts every upload and deletes every version of every key
  it lists, and `--cleanup` points it at a bucket by name. So before it touches anything it lists every upload and
  every page of versions, up to ten pages, and refuses and reports a bucket holding any key outside `calib/`, the
  store's prefix, rather than empty it. `--cleanup` checks `CR_CALIBRATE_EXPECT_ACCOUNT` as a run does.
- **Teardown cannot hang.** Its requests time out, 5 s to connect and 30 s to answer, and are retried; the SDK waits
  for ever by default. The workload's requests have no timeout, since a timed request must not be cut short.
- **It runs only where it has prices.** Every run is priced at `us-east-1`'s rates, so a run anywhere else would
  record the wrong bill and check its ceiling against the wrong one. It is refused until a pricing profile for that
  region exists.
- **Error text is redacted.** AWS puts the caller's ARN, account id and all, in an AccessDenied message, and the
  harness printed and stored error text as it came. ARNs are now removed and account ids masked in everything it
  prints and records.
- **Only `NoSuchBucket` means teardown has nothing left to remove.** Teardown once read *any* 404 as "already
  gone" — and an abort retried after its first answer was lost gets back a 404 `NoSuchUpload`. It then skipped
  deleting the objects and the bucket, and reported nothing. An abort that finds its upload gone is now simply
  done, and only S3's own `NoSuchBucket` counts as removed.
- **Teardown's delete passes are bounded.** `DeleteObjects` reports a key it could not delete inside a 200, where no
  retry sees it, so a key that can never be deleted kept the listing loop running — and billing. After three
  passes, what is left is reported as a leftover, and the projection covers every listing those passes make.

**Ctrl-C stops the work, then tears down.** A signal handler replaces Node's default exit, so a handler that only
logs leaves the workload running, and the first version did exactly that. This one first stops the workload's
client, so every later request fails before it is sent, and waits up to 30 s for the requests already sent to
answer (`interruptGate` and `stopThenTearDown`, in [`lib/calibrate-process.cjs`](lib/calibrate-process.cjs)). Only
then does it tear down. The harness before this listed the bucket while loads were still writing, and a PUT that
landed after the listing left the bucket behind: in two of four rehearsals interrupted during their loads, one of
them after printing that it had been removed. None of eleven interrupted during their loads since has, by SIGINT or by SIGTERM, nor three interrupted during the intersects. Waiting also lets a `CreateBucket` still in flight land
before teardown looks for the bucket; if a request is still unanswered after 30 s, teardown goes ahead, and a bucket
it then cannot find is reported as one that may yet appear, with the `--cleanup` line. The handler writes the
results, every phase it had finished and the cost, marked `interrupted`, with anything teardown left under
`leftovers`, and a request that failed meanwhile under `error`. It exits 130, unless the workload had finished and
only teardown was left, when the run keeps its own exit code. A second signal warns instead of killing the process
mid-delete. The handler is armed before the bucket is created, so an interrupt during creation tears down too, and a
signal during `--cleanup` waits for the cleanup it interrupts.

A hang-up (a closed terminal, a dropped session) is handled the same way, with one more step. Node opens its
stdout and stderr on first use, and on macOS opening one on a terminal that has hung up never returns. A handler
whose first line of output was stderr's first use blocked there, before any teardown, so the harness opens both
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
  retry off — so the request count is exact, no retry's backoff hides inside a latency sample, and a transient
  failure fails the run, keeping every phase it had finished, rather than being retried. The latency figures are
  therefore from fault-free runs: on that path they match what a consumer with default settings sees, whose worst
  case adds up to three SDK attempts for each of the store's four, with backoff. Teardown and `--cleanup` keep the
  SDK's retries, on a second client metered into the same bill: a transient failure there would otherwise leave
  the bucket behind.
- **Cold reads only, and a count the network cannot move.** Each intersect gets a fresh store, so no cache can
  answer it, and the store's pointers are pinned for its lifetime (`cache.genTtlMs: 0`). On the default 2 s
  refresh, an intersect slower than that reads each pointer again — run `2026-09-23-94416`, 83 ms from the
  region, measured 206 GETs for its median intersect where the same intersect in-region would make 204 — so a count
  taken on the default would describe the network. A test drives the real engine on a slow clock to prove the pin holds.
- **Exact content.** Every pair of segments shares a planned set of ids, so each intersect must return precisely
  that set — the count *and* the sum — or the run refuses to report a latency.
- **The published shape.** 500,000-id segments spanning ~2,000 chunks with 100 shared, so the run tests the "100
  of 2,000 chunks" claim itself; plus two dense segments of ~12 MiB so multipart is actually exercised.
- **Chunk reads and the tail read, separately.** Measured request by request, a cold intersect reads exactly 100
  chunks per operand (about 516 bytes each) plus one 256 KiB read from the end of each object, which fetches the
  footer and index in a single round trip. They are reported apart: the chunk count is the proportional part and
  the tail read is a fixed cost per operand, and a single "fraction fetched" would describe neither.
- **What it measured.** The package version, the harness commit (marked `-dirty` when the harness had uncommitted
  edits, since the commit alone would name a harness that did not run), the Node version, and how the timed stores
  were built.

### Running it in the region

```
# in AWS CloudShell, in the region being measured
git clone https://github.com/cloudbitmaps/cloudbitmaps && cd cloudbitmaps
CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.25 bash bench/calibrate-cloudshell.sh
```

The script installs Node 22 if CloudShell's is older, installs the **published** `@cloudbitmaps/roaring` and
`@cloudbitmaps/s3` into a scratch directory, and runs the harness against those — so the figures describe what a
consumer installs, not a build of this checkout. A finished run's results land in `~/<runId>.json`, and an
interrupted one's in `~/<runId>.partial.json`, which is not evidence. A name already taken in `~` is left alone,
and this run's copy goes beside it with a timestamp, still a `.partial.json` if it was one. The script runs the
harness as a job of its own and passes on every signal that would stop it: a Ctrl-C, a closed CloudShell tab or a
`kill` reaches the harness exactly once, and the results are copied out only after it has stopped, with SIGPIPE
from a reader that has gone, such as a `tee`, ignored while they are. Run in the foreground, a SIGTERM or a hang-up
stopped the script at once, deleted the scratch directory under the harness mid-teardown and copied nothing; a
SIGTERM to the script alone never reached the harness at all. A job of its own may write to the terminal only while
`tostop` is off, as it is by default, so a terminal with it set is refused before anything is installed. Commit a finished run's file as
`bench/calibration/<runId>.json`, with its report — [`calibration/`](calibration/README.md) says how. `CR_CALIBRATE_REHEARSE=1` runs the same install path against local MinIO, to test the script; its
results land in `~/calibrate-aws-rehearsal.json`.

### What it does not measure

Its scope is the three debts above, on one workload shape. Also owed, and **not** in this harness yet:

- **`store.load()` itself.** The load stage calls `bulkLoadCrbmGeneration` with the generation number given, so it
  measures the write and the publish. `store.load()` also lists the segment to choose the number and runs a
  collection pass after the publish; listings bill at the PUT rate, so its full count is its own figure.
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
| `lib/calibrate-guards.cjs` | The guards above, plus the planned id layout (`planLayout`, `layoutIds`), the account mask and the redaction of error text (`maskAccount`, `redact`), what LEFTOVERS says last (`leftoversHint`), which file each kind of run writes and what makes a usable run id (`resultsFile`, `stampOf`, `EVIDENCE_DIR`, `checkRunId`, `checkCleanupId`), the workload's bounds and the one priced region (`checkWorkload`, `MAX_SEGMENTS`, `checkRunRegion`), how the timed stores are built (`TIMED_STORE`, `STORE_PREFIX`), how many attempts each of the two S3 clients makes (`clientConfigs`), and what teardown counts as done, what it refuses and how long it waits (`bucketIsGone`, `uploadIsGone`, `TEARDOWN_PASSES`, `foreignKeys`, `MAX_LISTING_PAGES`, `ADMIN_TIMEOUTS`). Pure functions, so each can be tested against the bug it exists for. |
| `lib/calibrate-process.cjs` | How a run stops and what it leaves behind: the gate that stops the workload's client and waits for what it sent before teardown (`interruptGate`, `stopThenTearDown`), what a failure records and what a signal exits with (`failureOf`, `exitCodeAfterSignal`), the terminal's streams opened at startup and silenced on a hang-up (`holdTerminal`, `silenceTerminal`), results written without ever replacing a file (`writeResultsFile`), and the harness commit, marked when dirty (`harnessRef`). Kept apart from the pure guards so each can be driven in a test. |
| `lib/calibration-figures.cjs` | Every figure a calibration run lets the project publish, derived from the run's evidence, the pricing profile and the library's own constants — and a refusal for evidence that does not reconcile with itself. `tests/docs/calibration-reports.test.ts` holds the run reports and the benchmarks page to it, and `scripts/site-figures.cjs` takes the site's single-bucket figures from it. |

## Adding a harness

- **Open with a header that says why it exists** — what claim it measures and what would be wrong without it.
  Every file here does, and it is the part a later reader most needs.
- **Write a results file, not only a log line.** A measurement that is not recorded does not exist: the RSS
  ceiling was measured on every pull request for months and listed as owed, because its numbers went to a
  container's stdout and nowhere else.
- **Gate any figure you publish.** A number that reaches the site is checked against its results file by
  `scripts/site-figures.cjs`; add it there, or the page can drift from the run. A calibration run's figures come
  out of `lib/calibration-figures.cjs`, which the run's report, the benchmarks page and the site all share.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
