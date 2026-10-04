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
const { AbortController } = globalThis;

const { redact, resolveMaxSockets } = require('./calibrate-guards.cjs');

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

/** An error and the errors beneath it, through `cause`, as far as five down. */
function chainOf(err) {
  const chain = [];
  for (let e = err; e !== null && typeof e === 'object' && chain.length < 6; e = e.cause) {
    chain.push(e);
  }
  return chain;
}

/**
 * What an error says about itself, for a results file: its name, the name of the error at the bottom of its causes,
 * the transport `code` and the SDK's `$metadata` from the first error down the chain that has them, and its message,
 * redacted.
 *
 * The name alone is not enough. The SDK's HTTP handler renames a request error whose code is `ECONNRESET`, `EPIPE` or
 * `ETIMEDOUT` to `TimeoutError`, and the S3 driver wraps that in a `TransientError`, so a run that recorded a name
 * said "TimeoutError" and could not say which of the three it was. The code survives the rename, a level down.
 */
function faultOf(err) {
  const chain = chainOf(err);
  const first = (pick) => {
    for (const e of chain) {
      const v = pick(e);
      if (v !== undefined) return v;
    }
    return null;
  };
  const bottom = chain[chain.length - 1];
  return {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    cause: chain.length > 1 && typeof bottom.name === 'string' ? bottom.name : null,
    code: first((e) => (typeof e.code === 'string' ? e.code : undefined)),
    attempts: first((e) =>
      Number.isInteger(e.$metadata?.attempts) ? e.$metadata.attempts : undefined,
    ),
    httpStatus: first((e) =>
      Number.isInteger(e.$metadata?.httpStatusCode) ? e.$metadata.httpStatusCode : undefined,
    ),
    message: redact(err?.message ?? String(err)),
  };
}

/** One line for a console, from {@link faultOf}: the message, then what lies beneath it. */
function describeFault(f) {
  const parts = [
    f.cause === null ? f.name : `${f.name} from ${f.cause}`,
    ...(f.code === null ? [] : [`code ${f.code}`]),
    ...(f.httpStatus === null ? [] : [`HTTP ${f.httpStatus}`]),
    ...(f.attempts === null ? [] : [`${f.attempts} attempt${f.attempts === 1 ? '' : 's'}`]),
  ];
  return `${f.message} (${parts.join(', ')})`;
}

/**
 * What a run's failure records ({@link faultOf}), or `null` when it is only the gate refusing a send because the run
 * is stopping. A request that fails while the run is stopping is still a failure, and is recorded: one that answers
 * 403 during the drain, the likeliest reason someone presses Ctrl-C on a run that looks stuck, must not be discarded
 * because the run is stopping.
 */
function failureOf(err) {
  if (isInterruption(err)) return null;
  return faultOf(err);
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
  'bench/lib/calibrate-samples.cjs',
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

/**
 * The socket limit the library gives the client it builds itself, which the workload's client is given too so that a
 * run measures what a consumer who lets the library build its client gets.
 */
const LIBRARY_MAX_SOCKETS = 128;

/**
 * Cap the sockets the SDK's own request handler opens, and change nothing else about it: the handler stays the SDK's
 * default, with its defaults-mode connection timeout, keep-alive and 100-continue path. Only the `maxSockets` of its
 * two pooled agents is set. The handler makes its agents on its first request (the http one later, per request), so
 * the first request first runs an aborted one through it, which makes both, then sets the limit on the agents it made.
 * This is the library's own mechanism, reproduced here because the published `@cloudbitmaps/s3` does not export it.
 * A handler of another shape is left as it is, and `socketsOf` then reads back what it has.
 */
function limitSockets(client, maxSockets) {
  const handler = client.config.requestHandler;
  if (typeof handler?.handle !== 'function' || typeof handler.httpHandlerConfigs !== 'function') {
    return;
  }
  const handle = handler.handle.bind(handler);
  const agents = handler.httpHandlerConfigs.bind(handler);
  let ready;
  const warm = async () => {
    const abort = new AbortController();
    abort.abort();
    try {
      await handle({ protocol: 'http:' }, { abortSignal: abort.signal }).catch(() => undefined);
      const { httpAgent, httpsAgent } = agents();
      if (httpAgent) httpAgent.maxSockets = maxSockets;
      if (httpsAgent) httpsAgent.maxSockets = maxSockets;
    } catch {
      // Not the shape this expects: the limit stays the SDK's own, and `socketsOf` reports what the agents hold.
    }
  };
  handler.handle = async (request, options) => {
    ready ??= warm();
    await ready;
    return handle(request, options);
  };
}

/**
 * The socket limit the client's agents hold now, read from them, or null when it cannot be observed: a handler that
 * does not expose its agents, no agent made yet, or two agents that disagree. Call it after the run, since the agents
 * exist only once a request has gone out.
 */
function socketsOf(client) {
  try {
    const { httpAgent, httpsAgent } = client.config.requestHandler.httpHandlerConfigs();
    const limits = [httpAgent, httpsAgent]
      .filter((a) => a !== undefined && a !== null)
      .map((a) => a.maxSockets);
    if (limits.length === 0 || !limits.every((n) => Number.isSafeInteger(n) && n === limits[0])) {
      return null;
    }
    return limits[0];
  } catch {
    return null;
  }
}

/**
 * The workload client's socket limit from the environment's `CR_CALIBRATE_MAX_SOCKETS` (`raw`): the library's 128 unless
 * it gives another. Throws on a value `resolveMaxSockets` refuses, so a run can refuse it before anything is created.
 */
function resolveSocketLimit(raw) {
  return {
    maxSockets: resolveMaxSockets(raw, LIBRARY_MAX_SOCKETS),
    overridden: raw !== undefined && String(raw).trim() !== '',
  };
}

/**
 * Give the workload's client its socket limit and prove it took, before anything is created or spent. Resolves the
 * limit from `raw`, applies it, pushes one already-aborted request through the handler so that its agents exist (the
 * handler sits below the metering and the gate, so that request is neither counted nor billed and is no fault), and
 * requires the agents to hold the limit. A handler of a shape that does not take it throws, naming what was read back.
 * Returns the limit read back, and `evidence()`, which reads the agents again and says where the limit came from.
 */
async function limitWorkloadSockets(client, raw) {
  const { maxSockets, overridden } = resolveSocketLimit(raw);
  limitSockets(client, maxSockets);
  const abort = new AbortController();
  abort.abort();
  try {
    await client.config.requestHandler.handle({ protocol: 'http:' }, { abortSignal: abort.signal });
  } catch {
    // An aborted request fails by design; what matters is what the agents hold afterwards.
  }
  const observed = socketsOf(client);
  if (observed !== maxSockets) {
    throw new Error(
      `the workload client holds ${observed ?? 'an unreadable number of'} sockets, not ${maxSockets}: ` +
        "the installed SDK's handler did not take the limit; nothing was created",
    );
  }
  return {
    observed,
    evidence: () =>
      socketEvidence({ observed: socketsOf(client), configured: maxSockets, overridden }),
  };
}

/**
 * What the evidence says about the socket limit: the value read back from the client's agents, and where it came
 * from. `configured` is the number the run asked for and `overridden` whether the environment gave it; a limit
 * that was read back as something else says so, and one that could not be read is null, never the configured number.
 */
function socketEvidence({ observed, configured, overridden }) {
  if (observed === null) {
    return {
      maxSockets: null,
      maxSocketsSource: "not observed: the client's agents could not be read after the run",
    };
  }
  const how = overridden
    ? 'set by the harness from CR_CALIBRATE_MAX_SOCKETS'
    : "set by the harness to match the library's own client";
  return {
    maxSockets: observed,
    maxSocketsSource:
      observed === configured
        ? `${how}, read back from the client's agents after the run`
        : `read back from the client's agents after the run; the harness asked for ${configured} (${how})`,
  };
}

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

/**
 * The SDK's own classes of retryable fault, from the `@aws-sdk/client-s3` installed under `root`: what its standard
 * retry would have tried again, had the workload's client been let retry — throttling, a transient fault (a timeout,
 * a reset or refused socket, a 500, 502, 503 or 504) and any other 5xx. They are read from the SDK that sends the
 * requests rather than restated, so the harness counts as transient exactly what that SDK does. An SDK that does not
 * export them is refused, before anything is created.
 */
function sdkFaultClasses(root) {
  let retry;
  try {
    const client = createRequire(join(root, 'package.json')).resolve('@aws-sdk/client-s3');
    retry = createRequire(client)('@smithy/core/retry');
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
  }
  const classes = ['isThrottlingError', 'isTransientError', 'isServerError'];
  if (retry === undefined || classes.some((name) => typeof retry[name] !== 'function')) {
    throw new Error(
      `the @aws-sdk/client-s3 installed under ${root} does not export ${classes.join(', ')} from @smithy/core/retry, ` +
        'so the harness cannot tell a transient fault from another',
    );
  }
  return {
    isThrottlingError: retry.isThrottlingError,
    isTransientError: retry.isTransientError,
    isServerError: retry.isServerError,
  };
}

module.exports = {
  measuredVersion,
  measuredSdk,
  sdkFaultClasses,
  chainOf,
  faultOf,
  describeFault,
  LIBRARY_MAX_SOCKETS,
  limitSockets,
  socketsOf,
  socketEvidence,
  resolveSocketLimit,
  limitWorkloadSockets,
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
