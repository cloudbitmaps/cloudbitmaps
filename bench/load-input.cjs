/*
 * Load-input benchmark — what a load costs from ids and from a bitmap, the measured evidence behind the loading
 * guide's "How fast a bitmap loads".
 *
 * WHY THIS EXISTS
 *
 * A load from a bitmap is meant to spend no time per id in JavaScript: it serializes the bitmap once, checks the
 * bytes, and cuts the chunks out of the bitmap's own containers. `tests/roaring/load-no-per-id.test.ts` proves no
 * per-id code runs, by counting calls, on every pull request. What a count cannot show is what that is worth in
 * time, against the id path a caller holding a bitmap would otherwise take, and that figure is machine-dependent.
 *
 * WHAT IS MEASURED
 *
 * `store.load()` onto `MemoryStorage`, through the BUILT package, each trial in its own fresh process. Five sets:
 *
 *   dense        72 % of [0, 16M): about 11.5M members in 245 bitset containers.
 *   sparse       184 members in each of the 65,536 chunks: 12,058,624 members in 65,536 array containers, the
 *                worst case for the per-byte work, since every container is copied out and checksummed.
 *   runs         ranges of 1 to 400 ids with gaps of 1 to 200, to 12M members: mostly run containers.
 *   density-10   10 % of the same 245 chunks: about 1.6M members.
 *   density-90   90 % of them: about 14.4M members, the same 245 bitset containers.
 *
 * The last two are the falsifiable figure. Same container layout, nine times the members: a path with per-id work
 * costs about nine times as much on the second, and a path without it costs about the same.
 *
 * Four inputs per set: ids as a plain array (the sync id path), the same ids through an async generator (what a
 * caller iterating its bitmap into `load` pays), `{ bitmap }`, and `{ serialized }`. Building the set and the
 * caller-side array or bytes is outside the timed region; `{ bitmap }`'s own `serialize` is inside it, because the
 * load makes that call. Per trial it records the load's wall time, the longest single event-loop stall (the
 * longest gap between two turns of a `setImmediate` chain beside the load), and the object's SHA-256, so the run
 * also records that every input wrote the same bytes.
 *
 * HONESTY BOUNDARY — read this before quoting any number here.
 *
 * Wall-clock and machine-dependent: recorded, not asserted. The run records the CPU, Node version, commit, and
 * the 1-minute load average before and after. In-memory storage means no network and no disk, so this is the CPU
 * cost of building and encoding the generation; a real bucket adds the upload, which is the same for every input.
 *
 * Run: `pnpm bench:load-input` (builds first; heavy: a few minutes, and wants an idle machine).
 * With `LOAD_INPUT_INJECT=1` it also persists bench/load-input-results.json. A plain run is a dry run.
 * `pnpm bench:load-input:check` (`--check`) re-measures nothing: it fails if the guide's figures are not the ones
 * in the committed results file, or, while there is no results file, if the guide quotes any figure at all.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setImmediate } = require('node:timers');

// `LOAD_INPUT_ROOT` points `--check` at a copy of the tree, which is how its test mutates the files it reads.
const ROOT = process.env.LOAD_INPUT_ROOT || path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench/load-input-results.json');
const GUIDE = path.join(ROOT, 'docs/guide/loading.md');
const SECTION_START = '<!-- load-input:start -->';
const SECTION_END = '<!-- load-input:end -->';
/** What the guide's section says while there is no results file, so it can quote no figure. */
const UNMEASURED = 'have not been measured yet';

const SHAPES = ['dense', 'sparse', 'runs', 'density-10', 'density-90'];
const VARIANTS = ['idsSync', 'idsAsync', 'bitmap', 'serialized'];
const TRIALS = int(process.env.LOAD_INPUT_TRIALS, 5);
const MIN_TRIALS = 5;

function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Tiny seeded RNG (mulberry32) so every set is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ids of one set, ascending, as a `Uint32Array`. Pure and seeded: the same on every machine. */
function shapeIds(shape) {
  const r = rng(SHAPES.indexOf(shape) + 1);
  const keep = (span, density) => {
    const out = new Uint32Array(Math.ceil(span * density * 1.01) + 1024);
    let n = 0;
    for (let i = 0; i < span; i++) if (r() < density) out[n++] = i;
    // A typed array drops a write past its end without a word, so a short buffer would lose ids silently.
    if (n > out.length) throw new Error(`shape buffer too small: ${n} > ${out.length}`);
    return out.subarray(0, n);
  };
  if (shape === 'dense') return keep(16_000_000, 0.72);
  if (shape === 'density-10') return keep(245 * 65_536, 0.1);
  if (shape === 'density-90') return keep(245 * 65_536, 0.9);
  if (shape === 'sparse') {
    const perChunk = 184;
    const slot = 356; // 184 slots of 356 values fit a chunk
    const out = new Uint32Array(65_536 * perChunk);
    let n = 0;
    for (let chunk = 0; chunk < 65_536; chunk++) {
      for (let s = 0; s < perChunk; s++)
        out[n++] = chunk * 65_536 + s * slot + Math.floor(r() * slot);
    }
    return out;
  }
  if (shape === 'runs') {
    const out = new Uint32Array(12_000_400);
    let n = 0;
    let at = 0;
    while (n < 12_000_000) {
      const length = 1 + Math.floor(r() * 400);
      for (let i = 0; i < length; i++) out[n++] = at + i;
      at += length + 1 + Math.floor(r() * 200);
    }
    return out.subarray(0, n);
  }
  throw new Error(`unknown shape ${shape}`);
}

/** The built library, loaded only by the modes that measure: `--check` reads files and nothing else. */
function library() {
  return require('@cloudbitmaps/roaring');
}

// ── child mode: one load, in a fresh process ────────────────────────────────────────────────────────
async function child() {
  const { CloudRoaring, MemoryStorage } = library();
  const { RoaringBitmap32 } = require('roaring');
  const shape = process.env.LOAD_INPUT_SHAPE;
  const variant = process.env.LOAD_INPUT_VARIANT;
  const ids = shapeIds(shape);
  const bitmap = new RoaringBitmap32(ids);
  const stats = bitmap.statistics();
  let input;
  if (variant === 'idsSync') input = Array.from(ids);
  else if (variant === 'idsAsync') {
    const list = Array.from(ids);
    input = (async function* () {
      for (const id of list) yield id;
    })();
  } else if (variant === 'bitmap') input = { bitmap };
  else if (variant === 'serialized') input = { serialized: bitmap.serialize('portable') };
  else throw new Error(`unknown variant ${variant}`);

  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend });
  let last = process.hrtime.bigint();
  let maxGap = 0n;
  let running = true;
  const turn = () => {
    const now = process.hrtime.bigint();
    if (now - last > maxGap) maxGap = now - last;
    last = now;
    if (running) setImmediate(turn);
  };
  last = process.hrtime.bigint();
  setImmediate(turn);

  const t0 = process.hrtime.bigint();
  const result = await store.load({ segment: 'bench' }, input);
  const t1 = process.hrtime.bigint();
  await new Promise((resolve) => setImmediate(resolve));
  running = false;

  process.stdout.write(
    'LOAD_INPUT_RESULT:' +
      JSON.stringify({
        wallMs: Number(t1 - t0) / 1e6,
        stallMs: Number(maxGap) / 1e6,
        members: result.cardinality,
        chunkCount: result.chunkCount,
        size: result.size,
        sha256: result.sha256,
        containers: {
          array: stats.arrayContainers,
          bitset: stats.bitsetContainers,
          run: stats.runContainers,
        },
      }) +
      '\n',
  );
}

// ── parent mode ─────────────────────────────────────────────────────────────────────────────────────
function runChild(shape, variant) {
  const stdout = execFileSync(process.execPath, [__filename], {
    env: {
      ...process.env,
      LOAD_INPUT_CHILD: '1',
      LOAD_INPUT_SHAPE: shape,
      LOAD_INPUT_VARIANT: variant,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('LOAD_INPUT_RESULT:'));
  if (!line) throw new Error('child produced no LOAD_INPUT_RESULT');
  return JSON.parse(line.slice('LOAD_INPUT_RESULT:'.length));
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
    nsPerMember: round1((median(col('wallMs')) * 1e6) / trials[0].members),
    samples: trials.map((t) => ({ wallMs: round1(t.wallMs), stallMs: round1(t.stallMs) })),
  };
}

/** The date on the machine's own calendar, as `YYYY-MM-DD`. */
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
      ['status', '--porcelain', '--', 'packages', 'bench/load-input.cjs'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

function parent() {
  const loadStart = os.loadavg();
  const shapes = {};
  for (const shape of SHAPES) {
    const trials = Object.fromEntries(VARIANTS.map((v) => [v, []]));
    for (let i = 0; i < TRIALS; i++) {
      // Interleaved, so a drift in machine state lands on every input rather than on one.
      for (const v of VARIANTS) trials[v].push(runChild(shape, v));
      console.log(
        `  ${shape} trial ${i + 1}/${TRIALS}: ` +
          VARIANTS.map((v) => `${v} ${trials[v][i].wallMs.toFixed(0)} ms`).join(', '),
      );
    }
    const all = VARIANTS.flatMap((v) => trials[v]);
    const first = all[0];
    shapes[shape] = {
      members: first.members,
      chunkCount: first.chunkCount,
      crbmBytes: first.size,
      containers: first.containers,
      identicalBytes: all.every((t) => t.sha256 === first.sha256 && t.size === first.size),
      ...Object.fromEntries(VARIANTS.map((v) => [v, summarize(trials[v])])),
    };
  }
  const loadEnd = os.loadavg();
  const results = {
    note: 'Generated by `pnpm bench:load-input`. Measured (wall-clock) — machine-dependent, not a gate. Do not edit by hand.',
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
    trials: TRIALS,
    shapes,
  };
  for (const [name, f] of Object.entries(publishedFigures(results))) console.log(`  ${name}: ${f}`);
  console.log(
    `  load average 1/5/15 min: start ${loadStart.map(round1)}  end ${loadEnd.map(round1)}\n`,
  );
  if (process.env.LOAD_INPUT_INJECT === '1') {
    fs.writeFileSync(RESULTS, formatResults(results));
    console.log(
      '  wrote bench/load-input-results.json — now update the guide to match, and run --check',
    );
  } else {
    console.log('  (dry run — set LOAD_INPUT_INJECT=1 to persist bench/load-input-results.json)');
  }
}

// ── --check: the guide against the committed results; measures nothing ──────────────────────────────

/** The figures the guide publishes, derived from the results file the one way `--check` and a writer both use. */
function publishedFigures(results) {
  // Thousands separated, as the guide writes every number: `1,075 ms`, which the check reads whole.
  const ms = (x) => `${Math.round(x).toLocaleString('en-US')} ms`;
  const out = {};
  for (const shape of ['dense', 'sparse', 'runs']) {
    for (const v of VARIANTS) out[`${shape} ${v}`] = ms(results.shapes[shape][v].wallMs.median);
  }
  const ratio = (v) =>
    `${round1(results.shapes['density-90'][v].wallMs.median / results.shapes['density-10'][v].wallMs.median)}×`;
  out['density 90/10, ids'] = ratio('idsSync');
  out['density 90/10, bitmap'] = ratio('bitmap');
  out['longest stall, bitmap'] = ms(
    Math.max(...SHAPES.map((s) => results.shapes[s].bitmap.stallMs.worst)),
  );
  return out;
}

/** The guide's section between the two markers, or null when either is missing. */
function guideSection() {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const start = guide.indexOf(SECTION_START);
  const end = guide.indexOf(SECTION_END, start);
  return start < 0 || end < 0 ? null : guide.slice(start, end);
}

/**
 * Every time or ratio the section quotes, in any form a note would write one: `270 ms`, `270ms`, `270 msec`,
 * `0.27 s`, `1.2 sec`, `2 min`, `22 ns`, `3 µs` (or with the Greek letter, `3 μs`), `200 milliseconds`, `4x`,
 * `4.2×`, `4 times`, `4-fold`. A number is read whole, thousands separators included, so `1,075 ms` is one figure.
 * Counts, sizes and shares (`12M`, `28 MB`, `10 %`) are not figures this bench produces, and are left alone, as is a
 * product: `×` or `x` followed by a number (`245 × 65,536`) multiplies rather than compares, and a unit followed by
 * a hyphen or a letter (`us-east-1`) is not a unit.
 */
const FIGURE = new RegExp(
  '(?<![\\d.,])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?' +
    '(?:\\s?(?:milliseconds?|microseconds?|nanoseconds?|seconds?|minutes?|msecs?|secs?|mins?|ms|µs|μs|us|ns|s)(?![\\w-])' +
    '|\\s?x(?![\\w-])(?!\\s?\\d)|\\s?×(?!\\s?\\d)|\\stimes\\b|-fold\\b)',
  'gu',
);
function quotedFigures(section) {
  return new Set([...section.matchAll(FIGURE)].map((m) => m[0]));
}

function checkProblems() {
  const section = guideSection();
  if (section === null)
    return [`the guide has no section between "${SECTION_START}" and "${SECTION_END}"`];
  const found = quotedFigures(section);
  if (!fs.existsSync(RESULTS)) {
    // Nothing measured yet: the guide may say so, and may quote nothing.
    const problems = [...found].map(
      (f) => `the guide quotes ${f}, and there is no bench/load-input-results.json to give it`,
    );
    if (!section.includes(UNMEASURED))
      problems.push(`with no results file, the guide's section must say the figures ${UNMEASURED}`);
    return problems;
  }
  const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const problems = [];
  const want = publishedFigures(results);
  const wanted = new Set(Object.values(want));
  // Every figure in the section must be one the results account for, and every one the results publish must
  // appear: so neither a hand-edited guide nor a hand-edited results file passes.
  for (const f of found) {
    if (!wanted.has(f))
      problems.push(`the guide quotes ${f}, which bench/load-input-results.json does not give`);
  }
  for (const [name, f] of Object.entries(want)) {
    if (!found.has(f))
      problems.push(`the guide does not quote ${f} (${name}) from bench/load-input-results.json`);
  }
  if (section.includes(UNMEASURED))
    problems.push(`the guide still says the figures ${UNMEASURED}, and there is a results file`);
  for (const [what, text] of [
    ['the CPU', results.env.cpu],
    ['the date', results.measuredOn],
    ['the trial count', `${results.trials} runs`],
  ]) {
    if (!section.includes(text))
      problems.push(`the guide does not name ${what} (${text}) the results were measured on`);
  }
  if (results.trials < MIN_TRIALS)
    problems.push(`the results file records ${results.trials} trials, fewer than ${MIN_TRIALS}`);
  for (const shape of SHAPES) {
    if (results.shapes[shape]?.identicalBytes !== true)
      problems.push(`the results do not record every input writing the same bytes for "${shape}"`);
  }
  return problems;
}

function check() {
  const problems = checkProblems();
  if (problems.length) {
    console.error('bench:load-input:check FAILED:\n  - ' + problems.join('\n  - '));
    console.error(
      '\nThe guide and bench/load-input-results.json must agree. The results come from `pnpm bench:load-input`' +
        ' (LOAD_INPUT_INJECT=1 to persist); the guide is edited by hand to match. This check does not re-measure.',
    );
    process.exit(1);
  }
  console.log(
    fs.existsSync(RESULTS)
      ? "bench:load-input:check: the guide's load-input figures are the ones in bench/load-input-results.json."
      : 'bench:load-input:check: nothing measured yet, and the guide quotes no figure.',
  );
}

module.exports = { shapeIds, publishedFigures, SHAPES, VARIANTS };

if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else if (process.env.LOAD_INPUT_CHILD === '1') {
    child().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else parent();
}
