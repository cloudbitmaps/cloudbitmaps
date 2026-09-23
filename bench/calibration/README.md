# `bench/calibration/` — the real-cloud calibration runs

Each real run of [`calibrate-aws.cjs`](../calibrate-aws.cjs) against a cloud account leaves two files here, named by
its run id:

- **`<runId>.json`, the evidence.** The results file the harness wrote, committed unedited: every request it made,
  by command and by kind of read, the bytes, the timings, the workload and the code it ran. A figure published from
  a run is checked against this file, so the file is never regenerated or hand-edited once a figure cites it. The
  harness writes each run under a new id, and refuses to overwrite a run that already has one.
- **`<runId>.md`, the report.** What the run lets the project publish, each figure labelled measured, derived or
  expected, with what it means and what the run does not establish.

[`tests/docs/calibration-reports.test.ts`](../../tests/docs/calibration-reports.test.ts) holds each report to its
evidence in both directions: every headline figure must appear, and no dollar amount, percentage, duration or byte
size may appear that the evidence cannot account for. It holds the benchmarks page's section on the latest run to
the same evidence. [`scripts/site-figures.cjs`](../../scripts/site-figures.cjs) takes the site's single-bucket
figures from the latest run the same way, through [`lib/calibration-figures.cjs`](../lib/calibration-figures.cjs),
so the site, the benchmarks page and the report cannot disagree about a run.

## Runs

| report · evidence | when, and from where | what it established |
|---|---|---|
| [`2026-09-23-94416.md`](2026-09-23-94416.md) · [`2026-09-23-94416.json`](2026-09-23-94416.json) | 2026-09-23, `us-east-1`, from a laptop outside the region | The single-bucket bill for a cold intersect and a load, pointer included, and chunk-skipping on real S3. Not latency or throughput: the client measured its own connection. |

The July 2026 run predates this directory. Its harness and raw file were removed with the tier they metered, and
[`docs/benchmarks.md`](../../docs/benchmarks.md#real-cloud-calibration--aws) keeps its figures as the record.

## Adding a run

1. **Run it**, with `pnpm calibrate:aws --run` or, for latency that means anything, from AWS CloudShell with
   `bash bench/calibrate-cloudshell.sh`. [`bench/README.md`](../README.md#real-cloud-calibration) describes both.
   A run from CloudShell leaves the file in the shell's home directory; it belongs here under the same name.
2. **Check the file for anything identifying before committing it**: no account id, no ARN, no bucket URI.
   `pnpm leak-scan` fails on them.
3. **Write its report.** The existing one is the template. The gate lists the headline figures a report must state
   and any figure in it the evidence cannot account for, so run it until it passes.
4. **Give it a row above.** If it is the latest run, move the benchmarks page's section onto it. The site's gate
   then requires the site to state the new run's figures.
