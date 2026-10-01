'use strict';
/*
 * How a calibration run stops, and what it leaves behind.
 *
 * The process plumbing around `bench/calibrate-aws.cjs`, kept apart from the pure guards in `calibrate-guards.cjs`
 * so that each piece can be driven in a test rather than read. Each function here handles a way a run can be
 * stopped or can go wrong at its edges: a Ctrl-C while the loads are still writing, a terminal closed on macOS, a
 * second run under a name already taken, and a harness with uncommitted edits recorded as a commit.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { createRequire } = require('node:module');
const { clearTimeout, setTimeout } = require('node:timers');

const { redact } = require('./calibrate-guards.cjs');

const INTERRUPTED = 'CalibrationInterrupted';

/** The error a stopped client's sends fail with. */
function interruption() {
  return Object.assign(new Error('calibrate: interrupted — no new requests are sent'), {
    name: INTERRUPTED,
  });
}

/** Whether an error is a send the gate refused, rather than a failure of the request itself, however it was wrapped. */
function isInterruption(err) {
  for (let e = err, depth = 0; e != null && depth < 5; e = e.cause, depth += 1) {
    if (e.name === INTERRUPTED) return true;
  }
  return false;
}

/**
 * What a run's failure records: its message, redacted, or `null` when it is only the gate refusing a send because the
 * run is stopping. A request that fails while the run is stopping is still a failure, and is recorded: one that
 * answers 403 during the drain, the likeliest reason someone presses Ctrl-C on a run that looks stuck, must not be
 * discarded because the run is stopping.
 */
function failureOf(err) {
  if (isInterruption(err)) return null;
  return redact(err?.message ?? String(err));
}

/**
 * Stop a client from sending anything more, and know when what it already sent has answered.
 *
 * A signal that starts teardown while the workload is still writing leaves the bucket behind: teardown lists the
 * bucket, and a load's PUT lands after the listing. And an interrupt while `CreateBucket` is in flight would tear
 * down a bucket that does not exist yet, and the create would land afterwards with nothing said. So a signal stops
 * the work before anything is deleted: `abort()` makes every later send on the client fail at once, before it
 * reaches the wire, and `drained()` resolves once every send already made has answered. Teardown waits for both.
 *
 * It sits at `initialize` with high priority, outside the meter, so a send it refuses is not counted: it is not a
 * request, and it is not billed.
 */
function interruptGate(client) {
  let aborted = false;
  let inflight = 0;
  const waiters = new Set();
  client.middlewareStack.add(
    (next) => async (args) => {
      if (aborted) throw interruption();
      inflight += 1;
      try {
        return await next(args);
      } finally {
        inflight -= 1;
        if (inflight === 0) for (const done of [...waiters]) done();
      }
    },
    { step: 'initialize', priority: 'high', name: 'cloudbitmapsInterruptGate' },
  );
  return {
    abort() {
      aborted = true;
    },
    get aborted() {
      return aborted;
    },
    get inflight() {
      return inflight;
    },
    /**
     * True once nothing is in flight; false if `ms` pass first, so that a request that never answers cannot hold
     * a teardown.
     */
    drained(ms) {
      if (inflight === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(false);
        }, ms);
        waiters.add(done);
      });
    },
  };
}

/**
 * The order both of a run's exits follow: stop the workload's client, wait for what it sent, then tear down.
 *
 * A signal handler and `main`'s `finally` each call this. `cutShort` is whether the workload was still running,
 * which is what makes the run interrupted. A request that never answered within `drainMs` is passed on to teardown,
 * which cannot then read "no such bucket" as done: the unanswered request may be the bucket's creation. What teardown
 * left is recorded in the results, because after a hang-up there is no terminal to say it.
 */
async function stopThenTearDown({ gate, drainMs, teardown, results, cutShort, log }) {
  if (cutShort) results.interrupted = true;
  gate.abort();
  const drained = await gate.drained(drainMs);
  if (!drained)
    log(`a request was still unanswered after ${drainMs / 1000} s — tearing down anyway`);
  const left = await teardown({ unanswered: !drained });
  if (left.length > 0) results.leftovers = left;
  return left;
}

/**
 * The exit code of a run that got a signal: 130 when the signal cut the work short, which includes the abort window
 * before anything was made, and the run's own code when the workload had finished and only teardown remained.
 */
function exitCodeAfterSignal({ finished, code }) {
  return finished ? (code ?? 0) : 130;
}

/**
 * Open the terminal's two streams now, while there is a terminal.
 *
 * Node creates `process.stdout` and `process.stderr` on first use, and on macOS creating one on a terminal that has
 * hung up (a closed window, a dropped SSH session) never returns. A hang-up handler whose first line of output is
 * the first use of stderr blocks there, so teardown never runs: no bucket removed, no results written, no LEFTOVERS
 * message. Writing to a stream created before the hang-up returns. A harness spared only because something happened
 * to create stderr earlier is spared by luck, and dropping output on a hang-up does not help on its own, since
 * reaching `process.stderr` to silence it creates it. So both are created at startup.
 */
function holdTerminal() {
  void process.stdout;
  void process.stderr;
}

/**
 * Drop what would be written to a terminal after it has hung up. Nothing is left to read it there, and the results
 * file records what teardown left behind. A stream that is a pipe or a file is left alone: a log, `tee` or CI still
 * has a reader, and silencing those would lose the teardown and LEFTOVERS lines from `nohup … > run.log`. Safe only
 * because {@link holdTerminal} ran first: this reaches both streams.
 */
function silenceTerminal() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.isTTY) stream.write = () => true;
  }
}

/**
 * Write a run's results without ever replacing a file, and say where they went.
 *
 * The evidence file is created with `wx`, since evidence is write-once: if a file under the same id appeared while
 * the run was going, the write fails rather than replacing it. Were that failure to escape, it would take the
 * results with it, and neither the evidence nor the partial file would be written. So they go to `fallback`, a name
 * only this run can hold because it carries the run's start, and the caller is told. A partial file is kept the
 * same way, so a retry under the same id cannot replace the earlier attempt's bill. A rehearsal's file is scratch,
 * and is overwritten.
 */
function writeResultsFile({ file, fallback, text, overwrite = false }) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, text, { flag: overwrite ? 'w' : 'wx' });
    return file;
  } catch (err) {
    if (err?.code !== 'EEXIST' || fallback === undefined) throw err;
  }
  writeFileSync(fallback, text, { flag: 'wx' });
  return fallback;
}

/**
 * A run's results as the text of its file, every fractional number written to nine decimals.
 *
 * A ratio or a sum prints with a binary tail of up to 17 digits that no measurement carries, and a tail of exactly 12
 * is the run of digits the leak scan refuses as a possible account id, so a file could fail it by chance and then
 * not be committed. Nine decimals is below a nanosecond for a time in milliseconds and a billionth of a dollar for a
 * cost, so nothing measured is lost.
 */
function resultsJson(results) {
  const round = (_key, v) =>
    typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Number(v.toFixed(9)) : v;
  return `${JSON.stringify(results, round, 2)}\n`;
}

/**
 * The files a run from a checkout executes: the harness, the modules it loads, and the packages it loads, which are
 * this checkout's. The figures library in `bench/lib` is not among them; it reads a run's file, and never runs one.
 */
const HARNESS_FILES = [
  'bench/calibrate-aws.cjs',
  'bench/lib/aws-meter.cjs',
  'bench/lib/calibrate-guards.cjs',
  'bench/lib/calibrate-process.cjs',
  'bench/lib/calibrate-spread.cjs',
  'bench/lib/calibrate-stages.cjs',
  'packages',
];

/**
 * The commit the harness ran from, marked `-dirty` when its files had uncommitted edits.
 *
 * Evidence names the harness that produced it. A bare commit names one that did not run whenever the harness has
 * been edited since, which is exactly the state a harness is in while someone fixes it. `calibrate-cloudshell.sh`
 * passes the ref in, because the copy of the harness it runs is not a git checkout.
 */
function harnessRef(root, env = process.env) {
  if (env.CR_CALIBRATE_HARNESS_REF) return env.CR_CALIBRATE_HARNESS_REF;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const ref = git('rev-parse', '--short', 'HEAD');
    return git('status', '--porcelain', '--', ...HARNESS_FILES) === '' ? ref : `${ref}-dirty`;
  } catch {
    return '(unknown)';
  }
}

/**
 * The version of `@cloudbitmaps/roaring` a run measured: this checkout's own package when the run is from one, and the
 * installed package when it is from a scratch directory that installed the published ones, as the CloudShell script
 * does. A directory with neither is refused, since a run that cannot say what it measured has no evidence to write.
 */
function measuredVersion(root) {
  const where = [
    'packages/roaring/package.json',
    'node_modules/@cloudbitmaps/roaring/package.json',
  ];
  for (const rel of where) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    return JSON.parse(text).version;
  }
  throw new Error(
    `no @cloudbitmaps/roaring package under ${root}: looked in ${where.join(' and ')}`,
  );
}

/** How many sockets the SDK's HTTP handler opens to one host unless told otherwise. The harness does not set it. */
const SDK_DEFAULT_MAX_SOCKETS = 50;

/**
 * The versions of the AWS SDK client and of the HTTP handler under it that a run used, read from what is installed
 * under `root`. The scratch directory a CloudShell run installs into is deleted once the results are copied out, so the
 * file is the only place they survive; and the handler's socket cap bounds how many requests a stage can really have
 * in flight, which a latency has to be read against. A directory with neither is refused, as `measuredVersion` does.
 */
function measuredSdk(root) {
  const version = (from, spec) => {
    let file;
    try {
      file = createRequire(from).resolve(`${spec}/package.json`);
    } catch (err) {
      if (err?.code === 'MODULE_NOT_FOUND') return null;
      throw err;
    }
    return { file, version: JSON.parse(readFileSync(file, 'utf8')).version };
  };
  const client = version(join(root, 'package.json'), '@aws-sdk/client-s3');
  if (client === null) throw new Error(`no @aws-sdk/client-s3 installed under ${root}`);
  const handler = version(client.file, '@smithy/node-http-handler');
  if (handler === null) {
    throw new Error(
      `no @smithy/node-http-handler under the @aws-sdk/client-s3 installed in ${root}`,
    );
  }
  return { clientS3: client.version, nodeHttpHandler: handler.version };
}

module.exports = {
  measuredVersion,
  measuredSdk,
  SDK_DEFAULT_MAX_SOCKETS,
  interruptGate,
  isInterruption,
  failureOf,
  stopThenTearDown,
  exitCodeAfterSignal,
  holdTerminal,
  silenceTerminal,
  writeResultsFile,
  resultsJson,
  harnessRef,
  HARNESS_FILES,
};
