'use strict';
/*
 * How a calibration run stops, and what it leaves behind.
 *
 * The process plumbing around `bench/calibrate-aws.cjs`, kept apart from the pure guards in `calibrate-guards.cjs`
 * so that each piece can be driven in a test rather than read. Every function here exists because a review stopped
 * a run in a way no run had yet: a Ctrl-C while the loads were still writing, a terminal closed on macOS, a second
 * run under a name already taken, and a harness with uncommitted edits recorded as a commit.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { clearTimeout, setTimeout } = require('node:timers');

const INTERRUPTED = 'CalibrationInterrupted';

/** The error a stopped client's sends fail with. */
function interruption() {
  return Object.assign(new Error('calibrate: interrupted — no new requests are sent'), {
    name: INTERRUPTED,
  });
}

/** Whether an error is a send the gate refused, rather than a failure of the request itself. */
function isInterruption(err) {
  return err?.name === INTERRUPTED;
}

/**
 * Stop a client from sending anything more, and know when what it already sent has answered.
 *
 * A signal used to start teardown while the workload was still writing. Teardown listed the bucket, a load's PUT
 * landed after the listing, and the bucket was left behind: in two of four rehearsals interrupted during their
 * loads, one of them after printing that the bucket had been removed. And an interrupt while `CreateBucket` was in
 * flight would tear down a bucket that did not exist yet, and the create would land afterwards with nothing said. So a signal now stops the work before anything is deleted:
 * `abort()` makes every later send on the client fail at once, before it reaches the wire, and `drained()`
 * resolves once every send already made has answered. Teardown waits for both.
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
    /** True once nothing is in flight; false if `ms` pass first, so a request that never answers cannot hold a teardown. */
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
 * Open the terminal's two streams now, while there is a terminal.
 *
 * Node creates `process.stdout` and `process.stderr` on first use, and on macOS creating one on a terminal that has
 * hung up (a closed window, a dropped SSH session) never returns. A hang-up handler whose first line of output was
 * the first use of stderr blocked there, so teardown never ran: no bucket removed, no results written, no LEFTOVERS
 * message. Writing to a stream created before the hang-up returns. The harness had been spared only because
 * something happened to create stderr earlier, and a first fix that dropped output on a hang-up would itself have
 * blocked, since reaching `process.stderr` to silence it created it. So both are created at startup.
 */
function holdTerminal() {
  void process.stdout;
  void process.stderr;
}

/**
 * Drop everything written after a hang-up. Nothing is left to read it, and the results file records what teardown
 * left behind. Safe only because {@link holdTerminal} ran first: this reaches both streams.
 */
function silenceTerminal() {
  for (const stream of [process.stdout, process.stderr]) stream.write = () => true;
}

/**
 * Write a run's results without ever replacing a file, and say where they went.
 *
 * The evidence file is created with `wx`, since evidence is write-once: if a file under the same id appeared while
 * the run was going, the write fails rather than replacing it. That failure used to escape, taking the results with
 * it, so neither the evidence nor the partial file was written. Now they go to `fallback`, a name only this run can
 * hold because it carries the run's start, and the caller is told. A partial file is kept the same way, so a retry
 * under the same id no longer replaces the earlier attempt's bill. A rehearsal's file is scratch, and is overwritten.
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

/** The files that are the harness, as a run executes them. */
const HARNESS_FILES = ['bench/calibrate-aws.cjs', 'bench/calibrate-cloudshell.sh', 'bench/lib'];

/**
 * The commit the harness ran from, marked `-dirty` when its files had uncommitted edits.
 *
 * Evidence names the harness that produced it. A bare commit named one that did not run whenever the harness had
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

module.exports = {
  interruptGate,
  isInterruption,
  holdTerminal,
  silenceTerminal,
  writeResultsFile,
  harnessRef,
  HARNESS_FILES,
};
