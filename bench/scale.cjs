/*
 * At-scale load benchmark — turns the production-readiness audit's code-read conclusions
 * into MEASURED evidence at 1K → 10K → 100K segments.
 *
 * The audit's "NOT READY" verdict rested on three concerns, all since fixed: docs honesty, the unbounded
 * reader cache, and fleet-scale admin passes. This harness measures that those fixes
 * actually deliver at scale:
 *   M1  Bounded memory (headline)   reading the WHOLE fleet under a fixed reader-cache cap holds the post-GC
 *                                   LIVE HEAP ~flat as the fleet grows — memory is a function of the cap, not the
 *                                   fleet (the "OOMs a long-running server" claim). (Process RSS also
 *                                   grows with the in-process seed phase and isn't the bound — see render().)
 *                                   NB: M1's read loop parses `.crbm` INDICES (JS-heap objects) — it does not
 *                                   decode payloads — so JS heap IS the right metric here; the roaring addon's
 *                                   OFF-HEAP native memory (the read/intersect path with decoded bitmaps) is
 *                                   proved bounded over time by the soak (`getRoaringUsedMemory()`).
 *   M2  Fleet-scan cost             time the one bounded drain of `registry.list()` — what every
 *                                   fleet-wide admin pass (`checkConsistency`, `retireExpired`, `eraseSubject`)
 *                                   pays before it does any work across fleet sizes: the honest O(total)
 *                                   registry-enumeration floor a deferred cursor would bound. No read
 *                                   verb calls it: `has`, `count`, `iterate` and `intersect` address one segment
 *                                   each and never enumerate.
 *   M3  Intersection chunk-skipping two large multi-chunk segments, ~5% overlap: fetchedChunks ≪ total + latency
 *                                   (the crown jewel, on the ids-per-segment axis).
 *   M4  Load throughput             segments/sec while the fleet is bulk-loaded — one published generation per
 *                                   segment, which is the only write path the store has (a coarse write number).
 *
 * Each fleet size is measured in a FRESH CHILD PROCESS so RSS is clean (RSS is monotonic within a process, so
 * running all sizes in one would contaminate the 100K baseline with 1K/10K residue). Run with --expose-gc so
 * the baseline is sampled after a forced GC.
 *
 * Run: `pnpm bench:scale` (builds first). HEAVY + machine-dependent (wall-clock + RSS) — so, exactly like
 * bench/run.cjs, the MEASUREMENT is not a CI gate; measured numbers live here, the deterministic claims are gated
 * in tests/bench/anchors.test.ts. What CI does check is the published table: `pnpm bench:scale:check`
 * (`SCALE_TASK=check`) re-renders it from the committed results and fails if either page's copy differs. With SCALE_INJECT=1 (publish mode) it persists bench/scale-results.json AND
 * injects the table into docs/benchmarks.md + site/benchmarks.html (between BENCH:SCALE markers); a plain run is
 * a dry-run that only prints (so a quick small-scale validation can't clobber the committed 100K results).
 *
 * IMPORTANT on a laptop: the 100K run takes tens of minutes, and `process.hrtime` counts SUSPEND time as
 * elapsed — if the machine sleeps mid-run the wall-clock numbers are silently inflated (memory numbers are
 * unaffected). Prevent sleep for the duration, e.g. macOS `caffeinate -i pnpm bench:scale`.
 *
 * TO RESTYLE THE PUBLISHED TABLE WITHOUT RE-MEASURING: `pnpm bench:scale:render`. It re-renders and re-injects
 * from the committed bench/scale-results.json and takes about a second. Reach for it whenever the change is to
 * the PRESENTATION rather than the measurement — re-running the real thing to pick up a markup fix would burn
 * half an hour and, worse, would silently replace a recorded 100K measurement with a different machine's
 * wall-clock numbers. The committed results file is the record; rendering is separate from measuring.
 *
 * Loads the ESM-only package with `require()`, exactly as bench/run.cjs does (Node's `require(esm)`, from 22.12).
 *
 * Env knobs (for a quick validation run at small scale):
 *   SCALE_FLEETS=1000,10000,100000   fleet sizes to measure       SCALE_CAP=1024        maxOpenSegments
 *   SCALE_IDS_PER_SEG=256            ids seeded per segment        SCALE_INTERSECT_CHUNKS=2000
 *   SCALE_INTERSECT_DENSITY=1000     ids per 65,536-id chunk       SCALE_INTERSECT_OVERLAP=0.05
 *   SCALE_INJECT=1                   inject into docs/site         SCALE_TASK=inject|check   render or verify only
 *                                                                  SCALE_TASK=fleet|intersect, SCALE_N (internal)
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The built library, loaded only by the modes that measure. Rendering and checking the table read the committed
 * results file and nothing else, so CI can check the table before anything is built.
 */
function library() {
  return require('@cloudbitmaps/roaring');
}

// The library's own default scan ceiling. It used to arrive as `DEFAULT_MAX_SCAN_SEGMENTS`; curating core's
// public surface made that constant internal, so the bench states the number it is measuring against rather
// than reaching for a name it no longer has. If core's default moves, this is a deliberate bench parameter
// and not a silent disagreement.
const SCAN_CEILING = 250_000;

const ROOT = path.resolve(__dirname, '..');
const CAP = int(process.env.SCALE_CAP, 1024);
const IDS_PER_SEG = int(process.env.SCALE_IDS_PER_SEG, 256);
const FLEETS = (process.env.SCALE_FLEETS || '1000,10000,100000')
  .split(',')
  .map((s) => int(s.trim(), 0))
  .filter((n) => n > 0);

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────
function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function rssMiB() {
  return process.memoryUsage().rss / 1024 / 1024;
}
function gc() {
  if (typeof global.gc === 'function') global.gc();
}
async function ms(fn) {
  const t = process.hrtime.bigint();
  const out = await fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
}
/** Deterministic id set for a loaded segment: IDS_PER_SEG ids spread across a handful of chunks. */
function segmentIds() {
  const CHUNKS = 4;
  const per = Math.max(1, Math.floor(IDS_PER_SEG / CHUNKS));
  const ids = [];
  for (let c = 0; c < CHUNKS; c++) for (let j = 0; j < per; j++) ids.push(c * 65536 + j);
  return ids;
}
function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `crbm-scale-${tag}-`));
}
function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

// ── M1+M2+M4: one fleet size, measured in its own process ────────────────────────────────────────────
async function measureFleet(n) {
  const {
    bulkLoadCrbmGeneration,
    CrbmStorageChunkSource,
    LocalFsStorage,
    collectWithinBudget,
    excludingReservedRows,
  } = library();
  const dir = mkTmp(`fleet${n}`);
  try {
    const backend = new LocalFsStorage(dir, { now: () => Date.now() });
    const { storage, registry } = backend;
    const ids = segmentIds();

    // M4 — load throughput (build the fleet on disk: one immutable .crbm generation + one registry row per
    // segment, published forward-only — the store's only write path).
    const seed = await ms(async () => {
      for (let i = 0; i < n; i++) {
        await bulkLoadCrbmGeneration(storage, { segment: `s${i}`, generation: 0 }, ids, {
          registry,
        });
      }
    });

    // M1 — bounded memory. Read across the WHOLE fleet through a reader cache capped at CAP ≪ n. Each
    // segment is touched once, so the cache never hits: resident readers rise to CAP then stay there (LRU
    // evicts the oldest). The bound we're proving is about RETAINED live memory, so the headline metric is
    // heapUsed AFTER a forced GC once the sweep ends — that reflects the live reader set, not the transient
    // per-iteration garbage a monotonic RSS high-water would fold in. rssPeak is kept as an informational
    // high-water (native + transient), rssAfterGc as the settled resident size.
    gc();
    const heapBaselineMiB = process.memoryUsage().heapUsed / 1024 / 1024;
    const source = new CrbmStorageChunkSource(storage, { registry, maxOpenSegments: CAP });
    let rssPeak = rssMiB();
    const read = await ms(async () => {
      for (let i = 0; i < n; i++) {
        await source.listChunkKeys({ segment: `s${i}` });
        if ((i & 1023) === 0) rssPeak = Math.max(rssPeak, rssMiB());
      }
      rssPeak = Math.max(rssPeak, rssMiB());
    });
    gc();
    const heapRetainedMiB = process.memoryUsage().heapUsed / 1024 / 1024;
    const rssAfterGcMiB = rssMiB();

    // M2 — fleet-scan cost. Time the one bounded drain of `registry.list()` that every fleet-wide admin pass
    // runs first (`checkConsistency`, `retireExpired`, `eraseSubject`). This isolates the O(total)
    // registry-enumeration floor — the irreducible per-cycle cost a deferred cursor would bound; a quiescent
    // fleet still pays it, which is exactly the concern. No read verb enumerates, so nothing on the hot path
    // pays this.
    //
    // Spelled with the two exported primitives the library composes for this — skip the reserved bookkeeping
    // rows, then collect under a ceiling — which is the same shape a caller writing their own admin pass uses.
    const disc = await ms(() =>
      collectWithinBudget(
        excludingReservedRows(registry.list()),
        { maxRequests: SCAN_CEILING },
        'bench:scale discovery',
      ),
    );
    // Rows the sweep would then act on — those carrying a retention deadline. 0 on a fleet with no policies,
    // which is what makes this a clean read of the enumeration floor rather than of the work it finds.
    const discoveryCandidates = disc.out.filter((r) => r.retention?.expiresAt !== undefined).length;

    return {
      n,
      seedMs: round(seed.ms, 0),
      seedPerSec: round(n / (seed.ms / 1000), 0),
      readAllMs: round(read.ms, 0),
      heapBaselineMiB: round(heapBaselineMiB, 1),
      heapRetainedMiB: round(heapRetainedMiB, 1), // headline: live memory after GC — the bound proof
      rssPeakMiB: round(rssPeak, 1), // informational high-water (native + transient garbage)
      rssAfterGcMiB: round(rssAfterGcMiB, 1),
      cap: CAP,
      discoveryMs: round(disc.ms, 1),
      discoveryCandidates,
    };
  } finally {
    rmTmp(dir);
  }
}

// ── M3: intersection chunk-skipping on two large multi-chunk segments (ids-per-segment axis) ───────────
async function measureIntersect() {
  const { bulkLoadCrbmGeneration, MemoryStorage, CloudRoaring, CountingMetricsSink } = library();
  const CHUNKS = int(process.env.SCALE_INTERSECT_CHUNKS, 2000);
  const DENSITY = int(process.env.SCALE_INTERSECT_DENSITY, 1000);
  const OVERLAP = Number(process.env.SCALE_INTERSECT_OVERLAP || '0.05');
  const sharedChunks = Math.max(1, Math.round(CHUNKS * OVERLAP));

  const backend = new MemoryStorage({ now: () => 0 });
  const { storage, registry } = backend;
  // Segment A: chunks [0, CHUNKS). Segment B: `sharedChunks` chunks shared with A, the rest disjoint (offset
  // past A's range) — so exactly `sharedChunks` chunk keys align, and intersect must fetch only those.
  const idsA = [];
  for (let c = 0; c < CHUNKS; c++) for (let j = 0; j < DENSITY; j++) idsA.push(c * 65536 + j);
  const idsB = [];
  for (let c = 0; c < CHUNKS; c++) {
    const chunk = c < sharedChunks ? c : c + CHUNKS; // shared prefix, then a disjoint tail
    for (let j = 0; j < DENSITY; j++) idsB.push(chunk * 65536 + j);
  }
  await bulkLoadCrbmGeneration(storage, { segment: 'A', generation: 0 }, idsA, { registry });
  await bulkLoadCrbmGeneration(storage, { segment: 'B', generation: 0 }, idsB, { registry });

  const metrics = new CountingMetricsSink();
  // The two halves ARE a StorageBackend — the port is structural, so an object literal satisfies it.
  const client = new CloudRoaring({ storage: backend, metrics });
  metrics.reset();
  let resultCount = 0;
  const run = await ms(async () => {
    for await (const id of client.segment('A').intersect([client.segment('B')])) {
      void id; // draining the stream; we only need the count + the metrics snapshot
      resultCount++;
    }
  });
  const snap = metrics.snapshot();
  return {
    chunksPerSegment: CHUNKS,
    idsPerSegment: CHUNKS * DENSITY,
    sharedChunks,
    intersectMs: round(run.ms, 1),
    resultCount,
    fetchedChunks: snap.intersect.fetchedChunks,
    skippedChunks: snap.intersect.skippedChunks,
    storageBytesRead: snap.storage.bytes,
  };
}

// ── child mode: run one task, print its JSON, exit (fresh process ⇒ clean RSS) ─────────────────────────
async function child() {
  const task = process.env.SCALE_TASK;
  let out;
  if (task === 'fleet') out = await measureFleet(int(process.env.SCALE_N, 0));
  else if (task === 'intersect') out = await measureIntersect();
  else throw new Error(`unknown SCALE_TASK ${task}`);
  process.stdout.write(`SCALE_RESULT:${JSON.stringify(out)}\n`);
}

// ── parent mode: orchestrate children, aggregate, write + (optionally) inject ──────────────────────────
function runChild(env) {
  const stdout = execFileSync(process.execPath, ['--expose-gc', __filename], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('SCALE_RESULT:'));
  if (!line) throw new Error('child produced no SCALE_RESULT');
  return JSON.parse(line.slice('SCALE_RESULT:'.length));
}

async function parent() {
  const fleets = [];
  for (const n of FLEETS) {
    console.log(`  measuring fleet n=${n} (fresh process)…`);
    fleets.push(runChild({ SCALE_TASK: 'fleet', SCALE_N: String(n) }));
  }
  console.log('  measuring intersection (large segments)…');
  const intersect = runChild({ SCALE_TASK: 'intersect' });

  const results = {
    note: 'Generated by `pnpm bench:scale`. Measured (wall-clock + RSS) — machine-dependent, not a gate. Do not edit by hand.',
    env: {
      node: process.version,
      arch: process.arch,
      platform: process.platform,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
      cpus: os.cpus().length,
      totalMemMiB: Math.round(os.totalmem() / 1024 / 1024),
    },
    cap: CAP,
    idsPerSegment: IDS_PER_SEG,
    fleets,
    intersect,
  };
  const { mdTable, htmlTable, summary } = render(results);
  console.log('\n' + summary + '\n');
  // Persist + inject ONLY in publish mode (SCALE_INJECT=1). A plain run is a safe dry-run that just prints —
  // so a quick small-scale validation can't clobber the committed bench/scale-results.json (the 100K record).
  if (process.env.SCALE_INJECT === '1') {
    write('bench/scale-results.json', JSON.stringify(results, null, 2) + '\n');
    inject('docs/benchmarks.md', mdTable);
    inject('site/benchmarks.html', htmlTable);
  } else {
    console.log(
      '  (dry run — set SCALE_INJECT=1 to persist bench/scale-results.json + inject the docs)',
    );
  }
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────────────
function render(r) {
  const memFlat = r.fleets
    .map((f) => `${f.heapRetainedMiB} MiB @ ${f.n.toLocaleString('en-US')}`)
    .join(' · ');

  // The claim the table cannot make about itself, computed rather than asserted: how far the heap moved while
  // the fleet grew by a factor of N. Restating the heap column under the table (which is what `memFlat` does)
  // is fine in markdown, where the table and the note read as separate blocks; directly under a bordered panel
  // it is the same three numbers twice. This is the derived line the panel gets instead.
  const heaps = r.fleets.map((f) => f.heapRetainedMiB);
  const fleetLo = Math.min(...r.fleets.map((f) => f.n));
  const fleetHi = Math.max(...r.fleets.map((f) => f.n));
  const heapSpread = round(Math.max(...heaps) - Math.min(...heaps), 1);
  const fleetFactor = Math.round(fleetHi / fleetLo);

  // One decimal everywhere, so the .num columns line up on the decimal point. A bare `7` beside `7.9` breaks
  // the tabular alignment that is the entire reason those columns are right-aligned.
  const mib = (n) => `${n.toFixed(1)} MiB`;
  const rows = r.fleets.map((f) => [
    f.n.toLocaleString('en-US') + ' segments',
    mib(f.heapRetainedMiB),
    mib(f.rssPeakMiB),
    `${f.discoveryMs.toLocaleString('en-US')} ms`,
  ]);
  // "Retained heap" rather than "Live heap": it matches the `heapRetainedMiB` field it comes from AND the
  // word the site's own prose uses beside the table. Three names for one column is how a legend stops
  // agreeing with its figure.
  const header = ['Fleet', 'Retained heap (cap ' + r.cap + ')', 'Peak RSS', 'Discovery scan'];
  const seedLo = Math.min(...r.fleets.map((f) => f.seedPerSec));
  const seedHi = Math.max(...r.fleets.map((f) => f.seedPerSec));
  const perSeg = `fetched only ${r.intersect.fetchedChunks} of the ${r.intersect.chunksPerSegment.toLocaleString('en-US')} chunks per segment`;
  const mdTable =
    `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n` +
    rows.map((row) => `| ${row.join(' | ')} |`).join('\n') +
    `\n\nIntersection of two ${r.intersect.idsPerSegment.toLocaleString('en-US')}-id segments ` +
    `(${r.intersect.chunksPerSegment.toLocaleString('en-US')} chunks each, ${r.intersect.sharedChunks} shared): ` +
    `**${perSeg}** — the shared keys; the rest skipped by key alignment — in ${r.intersect.intersectMs} ms.\n\n` +
    `_Measured on ${r.env.cpu} (${r.env.arch}, node ${r.env.node}). **The bound is the retained heap** (post-GC), ` +
    `flat at ${memFlat} — the reader cache holds bounded live data regardless of fleet. Process **peak RSS** ` +
    `(shown for context) is a high-water that also folds in the benchmark's own fleet-*seeding* allocations and ` +
    `isn't returned to the OS after GC, so it grows with fleet here — it is not a clean read-path footprint ` +
    `(isolating read-path RSS in a reader-only process is a follow-up). Fleet seeded at ~${seedLo}–${seedHi} ` +
    `durable segments/s (fsync-bound); discovery is LocalFs-filesystem-bound — the \`O(total)\` **shape** is the ` +
    `point, not the absolute ms._`;
  // The site's markup, not the old site's `.bench-table` — that class no longer exists in
  // site/cloudbitmaps.css, so injecting it rendered as a bare unstyled table with nothing complaining.
  // Numeric columns take `.num` (tabular, right-aligned) so the fleet sizes and MiB figures line up.
  //
  // The footnote here is deliberately SHORTER than the markdown one: the page already carries a three-row
  // list explaining what is bounded, what is not, and what degrades. Repeating those explanations under the
  // table would say the same thing twice in two voices. What only the run knows — the machine, the node
  // version, the seed rate, the intersect result — stays.
  const htmlRows = rows
    .map(
      (row) =>
        `<tr><td>${row[0]}</td><td class="num">${row[1]}</td><td class="num">${row[2]}</td>` +
        `<td class="num">${row[3]}</td></tr>`,
    )
    .join('');
  const htmlTable =
    `<div class="tpanel">` +
    // The cap is already in the heap column's own header, where it qualifies the column it applies to —
    // repeating it here said "1024" twice on one panel. The head carries the axis instead.
    `<div class="tpanel-head"><span class="label">Memory at fleet scale</span>` +
    `<span class="label">Measured &middot; ${fleetLo.toLocaleString('en-US')} &rarr; ` +
    `${fleetHi.toLocaleString('en-US')} segments</span></div>` +
    `<div class="tscroll"><table><thead><tr>` +
    header.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${esc(h)}</th>`).join('') +
    `</tr></thead><tbody>${htmlRows}</tbody></table></div>` +
    `<p class="tpanel-foot">A <strong>${fleetFactor}&times;</strong> larger fleet moved retained heap by ` +
    `<strong>${heapSpread} MiB</strong>. Intersection of two ` +
    `${r.intersect.idsPerSegment.toLocaleString('en-US')}-id segments ` +
    `(${r.intersect.chunksPerSegment.toLocaleString('en-US')} chunks each, ${r.intersect.sharedChunks} shared) ` +
    `<strong>${perSeg}</strong>, in ${r.intersect.intersectMs} ms. Fleet seeded at ~${seedLo}&ndash;${seedHi} ` +
    `durable segments/s (fsync-bound). Measured on ${esc(r.env.cpu)} (${r.env.arch}, node ` +
    `${r.env.node}) &mdash; discovery is filesystem-bound here, so the ` +
    `<strong>shape</strong> is the claim, not the absolute milliseconds.</p>` +
    `</div>`;
  const summary =
    `scale: ` +
    r.fleets
      .map(
        (f) =>
          `n=${f.n} heap=${f.heapRetainedMiB}MiB rssPeak=${f.rssPeakMiB}MiB disc=${f.discoveryMs}ms seed=${f.seedPerSec}/s`,
      )
      .join(' | ') +
    ` || intersect fetched=${r.intersect.fetchedChunks}/${r.intersect.chunksPerSegment} in ${r.intersect.intersectMs}ms`;
  return { mdTable, htmlTable, summary };
}

// ── write / inject (same markers convention as bench/run.cjs) ─────────────────────────────────────────
const SCALE_START = '<!-- BENCH:SCALE:START -->';
const SCALE_END = '<!-- BENCH:SCALE:END -->';

/** A page's text, split around its at-scale region: what comes before, the region itself, and what follows. */
function scaleRegion(rel) {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const i = s.indexOf(SCALE_START);
  const j = s.indexOf(SCALE_END);
  if (i === -1 || j === -1 || j < i) throw new Error(`missing BENCH:SCALE markers in ${rel}`);
  // Exactly one region: a second copy would be one the check never compared.
  if (s.indexOf(SCALE_START, i + 1) !== -1 || s.indexOf(SCALE_END, j + 1) !== -1) {
    throw new Error(`more than one BENCH:SCALE region in ${rel}`);
  }
  return {
    before: s.slice(0, i + SCALE_START.length),
    region: s.slice(i + SCALE_START.length, j),
    after: s.slice(j),
  };
}
function inject(rel, body) {
  const { before, after } = scaleRegion(rel);
  fs.writeFileSync(path.join(ROOT, rel), before + '\n' + body + '\n' + after);
  log(rel);
}
function write(rel, body) {
  fs.writeFileSync(path.join(ROOT, rel), body);
  log(rel);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function log(rel) {
  console.log(`  wrote ${rel}`);
}

// ── inject-only: re-render + inject from an existing scale-results.json (no re-measuring) ──────────────
function doInject() {
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/scale-results.json'), 'utf8'));
  const { mdTable, htmlTable, summary } = render(results);
  console.log('\n' + summary + '\n');
  inject('docs/benchmarks.md', mdTable);
  inject('site/benchmarks.html', htmlTable);
}

// ── check-only: the published table is exactly what the committed results render ─────────────────────
// The at-scale table is a measured figure on two pages, and for a while nothing held it to the file it was
// rendered from: a hand edit to either page, or a new results file rendered into one page and not the other,
// would have shipped. `pnpm bench:scale:check` re-renders both copies from bench/scale-results.json and fails on
// any difference, the way `site-replay.cjs --check` holds the demo's figures to the same file.
function doCheck() {
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/scale-results.json'), 'utf8'));
  const { mdTable, htmlTable } = render(results);
  const stale = [
    ['docs/benchmarks.md', mdTable],
    ['site/benchmarks.html', htmlTable],
  ].filter(([rel, body]) => scaleRegion(rel).region !== '\n' + body + '\n');
  if (stale.length > 0) {
    console.error(
      `bench:scale:check: the at-scale table in ${stale.map(([rel]) => rel).join(' and ')} is not what ` +
        'bench/scale-results.json renders. Run `pnpm bench:scale:render` rather than editing it by hand.',
    );
    process.exit(1);
  }
  console.log('bench:scale:check: both at-scale tables are what bench/scale-results.json renders.');
}

// ── entry ────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  if (process.env.SCALE_TASK === 'inject') doInject();
  else if (process.env.SCALE_TASK === 'check') doCheck();
  else if (process.env.SCALE_TASK) await child();
  else await parent();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
