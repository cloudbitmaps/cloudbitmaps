/*
 * Event-loop benchmark — the measured evidence behind the guide's "What blocks the event loop, and where to run it".
 *
 * WHY THIS EXISTS
 *
 * The guide tells a reader that a load of 1M ids spread across the id space costs a few hundred milliseconds, that
 * it hands the event loop back in slices so the longest single stall is a small fraction of that, and that the same
 * load with no clock to yield through holds the loop for its whole duration. Those are claims about a co-resident
 * server's health checks, and without a recorded run they stand on a figure typed once and never re-checked,
 * which drifts in either direction, and a worst case is the figure most likely to be stated too kindly.
 *
 * WHAT IS MEASURED
 *
 * `store.load()` of 1,000,000 distinct ids drawn from a seeded generator across the whole 32-bit id space (about
 * 65,000 chunks, 15 ids per chunk), onto `MemoryStorage`, through the BUILT package. Two variants, each trial in
 * its own fresh process so no trial inherits another's heap, JIT state or native allocator:
 *
 *   yielded     the store's default clock, which yields the event loop through `setImmediate`.
 *   unyielded   a clock whose `yieldNow` resolves on a microtask, which yields nothing: the load as it runs for a
 *               caller that passes no working clock.
 *
 * Per trial it records the load's wall time and the LONGEST SINGLE STALL during it, read two ways:
 *
 *   monitorEventLoopDelay   `perf_hooks`, 1 ms resolution, its `max`. A timer-based probe: it learns of a stall
 *                           only when its timer finally fires, and a stall that is one unbroken block can be
 *                           under-reported (a 480 ms unyielded load read as ~34 ms in a trial run), so it cannot
 *                           carry the figure by itself.
 *   immediate gap           the longest gap between two consecutive turns of a `setImmediate` chain running beside
 *                           the load. A stall is by definition a stretch in which no turn happens, so this is the
 *                           stall itself, to the nanosecond. The load's own yields are immediates too, which
 *                           only makes the probe turn more often, never less.
 *
 * The published figure is the immediate gap. The other is recorded beside it: where the load yields, the two agree
 * to within a few percent.
 *
 * Every trial is warmed by nothing: a fresh process is the thing a batch job is, and the first load in a process is
 * the one that matters. The ids are generated before the probes start, and are not part of the timed region.
 *
 * HONESTY BOUNDARY — read this before quoting any number here.
 *
 * Wall-clock and machine-dependent, like bench/scale.cjs: it is recorded, not asserted. The run records the CPU,
 * Node version, commit, and the 1-minute load average before and after, because a busy machine inflates both
 * columns and a reader must be able to see that it was not. In-memory storage means no network and no disk, so
 * this is the CPU cost of building and encoding the generation, which is the part that blocks; a real bucket adds
 * waiting, which does not block. A worker with a slower core, or a bigger segment, stalls for longer in proportion.
 *
 * Run: `pnpm bench:event-loop` (builds first; heavy: about a minute, and wants an idle machine).
 * With `EVENT_LOOP_INJECT=1` it also persists bench/event-loop-results.json. A plain run is a dry run.
 * `pnpm bench:event-loop:check` (`--check`) re-measures nothing: it fails if the guide's figures are not the ones
 * in the committed results file. CI runs that, since CI hardware is not the hardware that measured.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setImmediate, setTimeout } = require('node:timers');

// `EVENT_LOOP_ROOT` points `--check` at a copy of the tree, which is how its test mutates the files it reads.
const ROOT = process.env.EVENT_LOOP_ROOT || path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench/event-loop-results.json');
const GUIDE = path.join(ROOT, 'docs/guide/production.md');
const SECTION_START = '## What blocks the event loop, and where to run it';
const SECTION_END = '## Deploying to AWS Lambda';

const IDS = 1_000_000;
const TRIALS = int(process.env.EVENT_LOOP_TRIALS, 20);

function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** The built library, loaded only by the modes that measure: `--check` reads files and nothing else. */
function library() {
  return require('@cloudbitmaps/roaring');
}

/** Tiny seeded RNG (mulberry32) so the id set is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spreadIds() {
  const r = rng(1);
  const seen = new Set();
  while (seen.size < IDS) seen.add(Math.floor(r() * 4294967296));
  return [...seen];
}

// ── child mode: one load, in a fresh process ────────────────────────────────────────────────────────
async function child() {
  const { CloudRoaring, MemoryStorage } = library();
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const yielded = process.env.EVENT_LOOP_VARIANT === 'yielded';
  const seams = yielded
    ? undefined
    : {
        clock: {
          now: () => Date.now(),
          sleep: () => Promise.resolve(),
          yieldNow: () => Promise.resolve(),
        },
      };
  const store = new CloudRoaring({ storage: new MemoryStorage(), seams });
  const ids = spreadIds();

  const delay = monitorEventLoopDelay({ resolution: 1 });
  let last = process.hrtime.bigint();
  let maxGap = 0n;
  let running = true;
  const turn = () => {
    const now = process.hrtime.bigint();
    if (now - last > maxGap) maxGap = now - last;
    last = now;
    if (running) setImmediate(turn);
  };
  delay.enable();
  last = process.hrtime.bigint();
  setImmediate(turn);

  const t0 = process.hrtime.bigint();
  const result = await store.load({ segment: 'spread' }, ids);
  const t1 = process.hrtime.bigint();
  // Let the loop turn through a timer tick and an immediate, so a stall that ended with the load's own last slice
  // is recorded by both probes: a timer probe only learns of a stall once its timer finally fires.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setImmediate(resolve));
  running = false;
  delay.disable();

  process.stdout.write(
    'EVENT_LOOP_RESULT:' +
      JSON.stringify({
        wallMs: Number(t1 - t0) / 1e6,
        stallMs: Number(maxGap) / 1e6,
        monitorMaxMs: delay.max / 1e6,
        chunkCount: result.chunkCount,
        cardinality: result.cardinality,
      }) +
      '\n',
  );
}

// ── parent mode ─────────────────────────────────────────────────────────────────────────────────────
function runChild(variant) {
  const stdout = execFileSync(process.execPath, [__filename], {
    env: { ...process.env, EVENT_LOOP_CHILD: '1', EVENT_LOOP_VARIANT: variant },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('EVENT_LOOP_RESULT:'));
  if (!line) throw new Error('child produced no EVENT_LOOP_RESULT');
  return JSON.parse(line.slice('EVENT_LOOP_RESULT:'.length));
}

/** `JSON.stringify` with each array of numbers on one line, which is how `pnpm format` lays the file out. */
function formatResults(results) {
  const json = JSON.stringify(results, null, 2).replace(
    /\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g,
    (_, nums) => `[${nums.replace(/\s*,\s*/g, ', ')}]`,
  );
  return json + '\n';
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round1 = (x) => Math.round(x * 10) / 10;

function summarize(trials) {
  const col = (k) => trials.map((t) => t[k]);
  return {
    trials: trials.length,
    wallMs: { median: round1(median(col('wallMs'))), worst: round1(Math.max(...col('wallMs'))) },
    stallMs: { median: round1(median(col('stallMs'))), worst: round1(Math.max(...col('stallMs'))) },
    monitorMaxMs: {
      median: round1(median(col('monitorMaxMs'))),
      worst: round1(Math.max(...col('monitorMaxMs'))),
    },
    samples: trials.map((t) => ({
      wallMs: round1(t.wallMs),
      stallMs: round1(t.stallMs),
      monitorMaxMs: round1(t.monitorMaxMs),
    })),
  };
}

/** The date on the machine's own calendar, as `YYYY-MM-DD`: a run at 20:00 local is that day, not the next one in UTC. */
function localDate() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function gitCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'packages', 'bench/event-loop.cjs'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    ).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

function parent() {
  const loadStart = os.loadavg();
  const yielded = [];
  const unyielded = [];
  for (let i = 0; i < TRIALS; i++) {
    // Interleaved, so a drift in machine state lands on both variants rather than on one.
    yielded.push(runChild('yielded'));
    unyielded.push(runChild('unyielded'));
    console.log(
      `  trial ${i + 1}/${TRIALS}: yielded ${yielded[i].wallMs.toFixed(0)} ms, stall ${yielded[i].stallMs.toFixed(1)} ms;` +
        ` unyielded ${unyielded[i].wallMs.toFixed(0)} ms, stall ${unyielded[i].stallMs.toFixed(1)} ms`,
    );
  }
  const loadEnd = os.loadavg();
  const results = {
    note: 'Generated by `pnpm bench:event-loop`. Measured (wall-clock) — machine-dependent, not a gate. Do not edit by hand.',
    measuredOn: localDate(),
    env: {
      node: process.version,
      arch: process.arch,
      platform: process.platform,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
      cpus: os.cpus().length,
      commit: gitCommit(),
      loadavgStart: loadStart.map(round1),
      loadavgEnd: loadEnd.map(round1),
    },
    ids: IDS,
    chunkCount: yielded[0].chunkCount,
    yielded: summarize(yielded),
    unyielded: summarize(unyielded),
  };
  const line = (name, s) =>
    `  ${name.padEnd(10)} wall ${s.wallMs.median} ms median / ${s.wallMs.worst} worst; ` +
    `longest stall ${s.stallMs.median} ms median / ${s.stallMs.worst} worst ` +
    `(monitorEventLoopDelay max ${s.monitorMaxMs.median} / ${s.monitorMaxMs.worst})`;
  console.log(`\n${line('yielded', results.yielded)}\n${line('unyielded', results.unyielded)}`);
  console.log(
    `  load average 1/5/15 min: start ${loadStart.map(round1)}  end ${loadEnd.map(round1)}\n`,
  );
  if (process.env.EVENT_LOOP_INJECT === '1') {
    fs.writeFileSync(RESULTS, formatResults(results));
    console.log(
      '  wrote bench/event-loop-results.json — now update the guide to match, and run --check',
    );
  } else {
    console.log('  (dry run — set EVENT_LOOP_INJECT=1 to persist bench/event-loop-results.json)');
  }
}

// ── --check: the guide against the committed results; measures nothing ──────────────────────────────

/** The figures the guide publishes, derived from the results file the one way `--check` and a writer both use. */
function publishedFigures(results) {
  const ms = (x) => `${Math.round(x)} ms`;
  return {
    loadMedian: ms(results.yielded.wallMs.median),
    stallMedian: ms(results.yielded.stallMs.median),
    stallWorst: ms(results.yielded.stallMs.worst),
    unyieldedStall: ms(results.unyielded.stallMs.median),
  };
}

function check() {
  const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const start = guide.indexOf(SECTION_START);
  const end = guide.indexOf(SECTION_END, start);
  const problems = [];
  if (start < 0 || end < 0) {
    problems.push(`the guide has no section between "${SECTION_START}" and "${SECTION_END}"`);
  } else {
    const section = guide.slice(start, end);
    const want = publishedFigures(results);
    // Every "N ms" in the section must be one the results account for, and every one the results publish must
    // appear: so neither a hand-edited guide nor a hand-edited results file passes.
    const found = new Set([...section.matchAll(/\b\d+(?:\.\d+)? ms\b/g)].map((m) => m[0]));
    const wanted = new Set(Object.values(want));
    for (const f of found) {
      if (!wanted.has(f))
        problems.push(`the guide quotes ${f}, which bench/event-loop-results.json does not give`);
    }
    for (const [name, f] of Object.entries(want)) {
      if (!found.has(f))
        problems.push(`the guide does not quote ${f} (${name}) from bench/event-loop-results.json`);
    }
    for (const [what, text] of [
      ['the CPU', results.env.cpu],
      ['the date', results.measuredOn],
      ['the trial count', `${results.yielded.trials} runs`],
    ]) {
      if (!section.includes(text))
        problems.push(`the guide does not name ${what} (${text}) the results were measured on`);
    }
    // The guide's "about N" load average is the one-minute figure at the start of the run.
    const load = `about ${Math.round(results.env.loadavgStart[0])}`;
    if (!section.includes(load))
      problems.push(
        `the guide does not say the machine's load average was ${load}, as the results record`,
      );
    if (results.yielded.trials !== results.unyielded.trials || results.yielded.trials < 20) {
      problems.push(
        'the results file records fewer than 20 trials, or a different count per variant',
      );
    }
  }
  // The two source comments that quote the same end-to-end run must agree with it too: they ship in the package.
  const n = (x) => Math.round(x);
  const y = results.yielded;
  const u = results.unyielded;
  for (const [file, text] of [
    [
      'packages/core/src/core/cooperative.ts',
      `**${n(u.wallMs.median)} ms wall, and ${n(u.stallMs.median)} ms during which the event loop did not turn at all** (medians of ${u.trials} fresh-process runs)`,
    ],
    [
      'packages/core/src/core/cooperative.ts',
      `${n(u.wallMs.median)} ms wall / ${n(u.stallMs.median)} ms blocked unyielded, ${n(y.wallMs.median)} ms / ${n(y.stallMs.median)} ms yielded`,
    ],
    [
      'packages/roaring/src/system-clock.ts',
      `end-to-end figures are ${n(u.stallMs.median)} ms \u2192 ${n(y.stallMs.median)} ms`,
    ],
  ]) {
    // The comments wrap, so compare with whitespace and comment stars collapsed.
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s*\n\s*\*?\s*/g, ' ');
    if (!src.includes(text))
      problems.push(`${file} does not quote "${text}" from bench/event-loop-results.json`);
  }
  if (problems.length) {
    console.error('bench:event-loop:check FAILED:\n  - ' + problems.join('\n  - '));
    console.error(
      '\nThe guide and bench/event-loop-results.json must agree. The results come from `pnpm bench:event-loop`' +
        ' (EVENT_LOOP_INJECT=1 to persist); the guide is edited by hand to match. This check does not re-measure.',
    );
    process.exit(1);
  }
  console.log(
    "bench:event-loop:check: the guide's event-loop figures are the ones in bench/event-loop-results.json.",
  );
}

if (process.argv.includes('--check')) check();
else if (process.env.EVENT_LOOP_CHILD === '1') {
  child().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else parent();
