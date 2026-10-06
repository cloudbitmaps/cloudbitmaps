# `bench/calibration/` — the real-cloud calibration runs

Each published run of [`calibrate-aws.cjs`](../calibrate-aws.cjs) against a cloud account has two files here, named
by its run id:

- **`<runId>.json`, the evidence.** The results file the harness wrote, committed unedited: every request it made,
  by command and by kind of read, the bytes, the timings, the workload and the code it ran. A figure published from
  a run is checked against this file, so the file is never regenerated or hand-edited once a figure cites it. The
  harness writes each run under a new id, and refuses to overwrite a run that already has one; a run that does not
  finish writes `<runId>.partial.json` instead, which is not evidence and which git ignores. Nothing is ever
  replaced: a run whose name was taken while it ran writes `<runId>.<start>.partial.json`, ignored the same way, and
  says so. That file records the run and what it spent. It is not evidence, since its id is another run's.
- **`<runId>.md`, the report.** What the run lets the project publish, each figure labelled measured, derived or
  expected, with what it means and what the run does not establish.

`2026-09-23-94416.json` is committed exactly as the harness at commit `e42c27f` wrote it, under another path, so its
`note` says to regenerate it; no evidence file here is ever regenerated.

[`tests/docs/calibration-reports.test.ts`](../../tests/docs/calibration-reports.test.ts) holds each report to its
evidence in both directions: every headline figure must appear, and no dollar amount, percentage, duration, byte
size, or count of requests, chunks, ids or loads may appear that the evidence cannot account for. It checks each
report's tables row by row, and fails if more than one commit has touched an evidence file. It holds the benchmarks
page's section on the latest run to the same evidence. [`scripts/site-figures.cjs`](../../scripts/site-figures.cjs)
takes the site's single-bucket figures from the latest run the same way, through
[`lib/calibration-figures.cjs`](../lib/calibration-figures.cjs), so the site, the benchmarks page and the report
take a run's numbers from one derivation, and hold them to it with one matcher.

## Runs

| report · evidence | when, and from where | what it established |
|---|---|---|
| [`2026-09-23-94416.md`](2026-09-23-94416.md) · [`2026-09-23-94416.json`](2026-09-23-94416.json) | 2026-09-23 (UTC), `us-east-1`, from a laptop outside the region | The single-bucket bill for a cold intersect and a load, pointer included, and chunk-skipping on real S3. Not latency or throughput: the client measured its own connection. |
| [`2026-10-03-e13c7.md`](2026-10-03-e13c7.md) · [`2026-10-03-e13c7.json`](2026-10-03-e13c7.json) | 2026-10-03 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.12.0` packages | The first complete in-region run: cold intersect latency, load throughput, the sweep, warm intersects, point reads and `andNot`, with the bill. Every stage exact, every request count as expected, $0.0376350 in all. |
| [`2026-10-04-73668.md`](2026-10-04-73668.md) · [`2026-10-04-73668.json`](2026-10-04-73668.json) | 2026-10-04 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.13.0` packages | The same seven stages on the engine whose combine window widens from 8 to 32, set against `0.12.0`'s run: the same requests and bill, in fewer rounds. Every stage exact, $0.0376350 in all. Its rounds sit a fifth to a half above the rounds model's, which assumes no socket limit; the run did not vary its client's 50 sockets, so it does not say why. |
| [`2026-10-04-f3599.md`](2026-10-04-f3599.md) · [`2026-10-04-f3599.json`](2026-10-04-f3599.json) | 2026-10-04 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.15.0` packages | The same seven stages on the engine that reads each operand's chunks as coalesced ranges: a cold intersect of the calibration shape in 6 GETs and an `andNot` against ten excludes in 33, with the bill. Every stage exact, every request count as expected, $0.0025670 in all. Its rounds sit above the rounds model's; the run did not vary its client's 128 sockets, and no stage held more than 11 requests in flight, so it does not say why. |
| [`2026-10-05-50b5d.md`](2026-10-05-50b5d.md) · [`2026-10-05-50b5d.json`](2026-10-05-50b5d.json) | 2026-10-05 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.16.0` packages | The same seven stages on the engine whose registry write takes the row it already holds: a segment's first `store.load()` in 2 PUT + 3 GET (for a multipart load, 5 PUT-class + 3 GET), measured, with a cold intersect still in 6 GETs and an `andNot` in 33, and the bill. Every stage exact, every request count as expected, $0.0025506 in all. Its rounds sit above the rounds model's; the run did not vary its client's 128 sockets, and no stage held more than 11 requests in flight, so it does not say why. |
| [`2026-10-06-9d36b.md`](2026-10-06-9d36b.md) · [`2026-10-06-9d36b.json`](2026-10-06-9d36b.json) | 2026-10-06 (UTC), `us-east-1`, from AWS CloudShell in `us-east-1`, against the published `0.17.0` packages | The same seven stages and a steady-load stage: one segment loaded 18 times at `keep: 12`, each load's requests measured by kind (first 2 PUT + 3 GET, reload 2 + 2, a load that deletes by name 2 + 4 and a delete, a load that lists 3 + 5 and a delete), with a cold intersect still in 6 GETs and an `andNot` in 33, and the bill. Every stage exact, every request count as expected, $0.0027548 in all. Its rounds sit above the rounds model's; the run did not vary its client's 128 sockets, and no stage held more than 11 requests in flight, so it does not say why. Its latencies are this session's, and are not comparable with another session's. |

## Adding a run

1. **Run it**, with `pnpm calibrate:aws --run` or, for latency that means anything, from AWS CloudShell with
   `bash bench/calibrate-cloudshell.sh`. [`bench/README.md`](../README.md#real-cloud-calibration) describes both.
   A run from CloudShell leaves the file in the shell's home directory; it belongs here under the same name. A
   `.partial.json` is a run that did not finish, or one whose name was taken, and is not evidence.
2. **Check the file for anything identifying before committing it**: no account id, no ARN, no bucket URI. The
   harness writes none. CI's leak scan looks for all three. `pnpm leak-scan` looks for an account id (any standalone
   run of 12 digits) and an ARN on its own, and for the rest only with the same extra patterns, in
   `.leak-needles` or `LEAK_SCAN_EXTRA`; it reads only files git tracks, so stage the file first.
3. **Write its report.** The existing one is the template. The gate lists the headline figures a report must state
   and any figure in it the evidence cannot account for, so run it until it passes. A run that discarded a sample
   after a transient fault is evidence, its latency and request-count figures taken from the samples each stage kept,
   and its report states how many it discarded (`1 discarded sample`, `3 discarded samples`), a count the gate holds to
   the evidence. Each stage's `discarded` says which samples they were.
4. **Give it a row above.** If it is the latest run, move the benchmarks page's section onto it. The site's gate
   then requires the site to state the new run's figures.
