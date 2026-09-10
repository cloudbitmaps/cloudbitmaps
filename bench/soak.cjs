/*
 * Soak / endurance harness (test-strategy T1) — the LOADED store under sustained mixed load.
 *
 * bench/scale.cjs proves the memory bound as a *snapshot* (read a whole fleet once → flat retained heap). Soak
 * proves it over *time*: a store under **sustained mixed load** — point reads across the population (`has`,
 * `count`, `iterate`), chunk-skipping combines (`intersect` / `union` / `andNot`, each with an `exclude` list),
 * and periodic **re-loads** (a new `.crbm` generation published over a random segment, its superseded object then
 * collected) — must not leak or creep. We sample post-GC live heap at intervals for the whole run and assert the
 * last-third median hasn't grown past the first-third median beyond a small band. This is the "true steady
 * state" a long-running server actually sees.
 *
 * WHY EVERY VERB IS IN THE LOOP. Each one owns a different piece of the memory story:
 *   - `has`       fills the HOT LRU (decoded chunks) — the count-bounded cache must evict, not grow.
 *   - `count`     parses `.crbm` indices into the cold reader cache — the count+byte-bounded cache under `SOAK_CAP`.
 *   - `iterate`   streams a whole segment one chunk at a time — nothing may accumulate across the stream.
 *   - combines    the crown jewel: the chunk-aligned window holds at most `concurrency × operands` payloads, and
 *                 `exclude` operands are read only at surviving keys. The *structural* half of that bound is proven
 *                 deterministically in `tests/core/intersect-window-bounded.test.ts`; this file covers what a unit
 *                 test cannot — that nothing accumulates across many combines over time. A run that performed no
 *                 combines is INCONCLUSIVE, never PASS: this harness once reported clean PASSes while issuing zero
 *                 combines, and the RSS gate built on it claimed to bound the window anyway.
 *   - re-loads    publish a new generation of a live segment. That is what makes the reader cache's generation
 *                 refresh (`coldGenTtlMs`) and the HOT LRU's generation-keyed entries do real work: a stale reader
 *                 must be swapped, not stacked, and the old generation's cached chunks must age out. A soak with
 *                 no re-loads cannot observe either, so zero re-loads is likewise INCONCLUSIVE.
 *
 * It also reports an **isolated read-path footprint**: a FRESH reader-only child opens the fleet (its post-soak
 * on-disk state) and reads across all of it (count + has, so it DECODES bitmaps) with no seed-phase arena
 * contamination, then runs a burst of combines. Post-GC *heap* is one bound to watch. But JS heap misses the
 * roaring bitmaps' **native/off-heap** memory (the addon allocates its containers outside V8), so the verdict
 * watches **both**: post-GC JS heap AND `getRoaringUsedMemory()` (the addon's live native bytes, decremented on
 * free/GC-finalize) — a run PASSes only if neither creeps.
 *
 * SCOPE (be honest): live-native proves **no off-heap leak** — it does NOT prove **RSS is bounded**. The malloc
 * allocator can retain freed arenas, so RSS climbs while live heap+native stay flat; the counter can't see that
 * retention. The definitive RSS ceiling is `scripts/rss-gate.sh`, which copies THIS file into a container and
 * runs it under a hard cgroup `--memory` limit (swap off) in CI — an OOM kill there is exit 137. RSS is reported
 * here only as a floor sanity-check (dominated by the fixed Node + addon floor).
 *
 * LocalFs drivers, not memory ones, on purpose: the fleet must live on disk so the reader child can open the
 * same post-soak state in a fresh process, and so a re-load is a real durable object write + pointer CAS.
 *
 * Offline + machine-dependent (wall-clock + RSS) — NOT a CI gate by itself (the cgroup gate is); the
 * deterministic claims stay gated in tests/. Run with --expose-gc. On a laptop, prevent sleep (`caffeinate -dis`)
 * so the duration isn't corrupted by suspend.
 *
 * Run: `pnpm soak` (builds first). Env knobs:
 *   SOAK_SECONDS=90   duration        SOAK_SEGMENTS=400   fleet size     SOAK_CAP=64   cold reader-cache cap
 *   SOAK_SAMPLE_MS=2000  heap sample interval             SOAK_SEED=1     load-pattern seed
 *   SOAK_INJECT=1     persist bench/soak-results.json (else a dry run prints only)
 *   SOAK_TASK=reader SOAK_DIR=<dir>   internal: the reader-only child
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
  nextGeneration,
} = require('@cloudbitmaps/roaring');
// The roaring addon allocates bitmap containers OUTSIDE the V8 heap, so heapUsed can't see them. This is the
// process-wide live native byte count — the off-heap component the memory verdict must watch.
const { getRoaringUsedMemory } = require('roaring');

const ROOT = path.resolve(__dirname, '..');
const SECONDS = int(process.env.SOAK_SECONDS, 90);
const SEGMENTS = int(process.env.SOAK_SEGMENTS, 400);
const CAP = int(process.env.SOAK_CAP, 64);
const SAMPLE_MS = int(process.env.SOAK_SAMPLE_MS, 2000);
const SEED = int(process.env.SOAK_SEED, 1);
const IDS_PER_SEG = 128;
const CHUNKS_PER_SEG = 8; // spread ids across multiple 16-bit chunks (NOT all chunkKey 0)
const REMAINDER = 4096; // remainder within a chunk
const RELOAD_EVERY = 5; // iterations between re-load rounds
const RELOADS_PER_ROUND = 4; // segments re-loaded (new generation published) per round

function int(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}
function heapMiB() {
  return process.memoryUsage().heapUsed / 1048576;
}
function rssMiB() {
  return process.memoryUsage().rss / 1048576;
}
/** Live native bytes held by the roaring addon (off-heap) — invisible to heapUsed; drives RSS. */
function nativeMiB() {
  return getRoaringUsedMemory() / 1048576;
}
function gc() {
  if (typeof global.gc === 'function') global.gc();
}
/** Tiny seeded RNG (mulberry32) so the load pattern is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crbm-soak-'));
}
function segName(i) {
  return `s${i}`;
}
function pick(rand) {
  return (rand() * SEGMENTS) | 0;
}
/** A random id spread across CHUNKS_PER_SEG distinct 16-bit chunks (id = chunkKey·65536 + remainder). */
function randId(rand) {
  return ((rand() * CHUNKS_PER_SEG) | 0) * 65536 + ((rand() * REMAINDER) | 0);
}
function randIds(rand) {
  const ids = [];
  for (let k = 0; k < IDS_PER_SEG; k++) ids.push(randId(rand));
  return ids;
}
function openDrivers(dir) {
  return {
    cold: new LocalFsColdDriver(dir),
    registry: new LocalFsRegistryDriver(dir, { now: () => Date.now() }),
  };
}

/** Seed a LocalFs fleet: one generation per segment, published through the registry. */
async function seedFleet(dir) {
  const { cold, registry } = openDrivers(dir);
  const rand = rng(SEED);
  for (let i = 0; i < SEGMENTS; i++) {
    await bulkLoadCrbmGeneration(cold, { segment: segName(i), generation: 1 }, randIds(rand), {
      registry,
    });
  }
  return { cold, registry };
}

// ── the reader-only child: open the post-soak fleet, read across all of it, report isolated heap+RSS ──
async function readerChild() {
  const { cold, registry } = openDrivers(process.env.SOAK_DIR);
  const store = new CloudRoaring({ cold, registry, coldReaderCacheMax: CAP });
  const rand = rng(SEED);
  // Two full passes so a bounded cache cycles eviction (each segment re-opened after eviction). Each segment is
  // both counted (index-only) AND has()-probed — has() DECODES a chunk bitmap into the bounded hot cache, so
  // the reported native footprint reflects a real decoded working set (not the ~0 an index-only count shows).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const seg = store.segment(segName(i));
      await seg.count();
      await seg.has(randId(rand));
    }
  }
  // Isolated COMBINE footprint, on the same fresh process: a run of chunk-skipping intersections across the
  // fleet, each with an exclude operand, with no seed-phase arena and no load in the picture. This is the closest
  // thing to the Lambda case the harness can express — a cold process whose entire job is combining segments —
  // so it is the number worth reporting beside the read-path one.
  let combines = 0;
  let combineIds = 0;
  for (let i = 0; i + 2 < SEGMENTS; i += 3) {
    const a = store.segment(segName(i));
    const b = store.segment(segName(i + 1));
    const c = store.segment(segName(i + 2));
    for await (const id of a.intersect([b], { exclude: [c] })) combineIds += id >= 0 ? 1 : 0;
    combines++;
  }
  gc();
  process.stdout.write(
    `SOAK_READER:${JSON.stringify({
      heapMiB: round(heapMiB(), 1),
      nativeMiB: round(nativeMiB(), 2),
      rssMiB: round(rssMiB(), 1),
      combines,
      combineIds,
    })}\n`,
  );
}

// ── the soak loop: sustained reads + combines + re-loads; sample post-GC heap over time ──
async function soak() {
  const dir = mkTmp();
  try {
    const { cold, registry } = await seedFleet(dir);
    const store = new CloudRoaring({ cold, registry, coldReaderCacheMax: CAP });
    const deps = { cold, registry };
    const rand = rng(SEED ^ 0x9e3779b9);

    const samples = [];
    const startedAt = Date.now();
    let lastSample = 0;
    let iters = 0;
    let reloads = 0;
    let combines = 0;
    let combineIds = 0;
    let combineChecksum = 0;
    let iterated = 0;

    while (Date.now() - startedAt < SECONDS * 1000) {
      // Re-loads — every few iterations, publish a NEW generation over a handful of random segments (the only
      // write path the store has). Then GC the superseded generation (keep the newest one as the grace window
      // for a reader still pinned to it) so on-disk storage stays bounded over a long run. `nextGeneration` is
      // the library's own bookkeeping for "which number comes next", so the re-load takes the same path a real
      // loader does — including the forward-only publish.
      if (iters % RELOAD_EVERY === 0) {
        for (let r = 0; r < RELOADS_PER_ROUND; r++) {
          const ref = { segment: segName(pick(rand)) };
          const generation = await nextGeneration(ref, deps);
          await bulkLoadCrbmGeneration(cold, { ...ref, generation }, randIds(rand), { registry });
          reloads++;
          // Best-effort: a transient FS fault here must not abort the soak — it's disk hygiene, not the verdict.
          await gcOrphanGenerations(ref, deps, { keep: 1 }).catch(() => undefined);
        }
      }
      // Reads — count + has across random segments (exercises the bounded cold reader cache AND, right after a
      // re-load, the generation refresh that must swap a stale reader rather than stack a second one).
      for (let r = 0; r < 12; r++) {
        const seg = store.segment(segName(pick(rand)));
        await seg.count();
        await seg.has(randId(rand));
      }
      // Iterate — one whole segment streamed, one chunk at a time.
      for await (const id of store.segment(segName(pick(rand))).iterate()) {
        iterated++;
        combineChecksum = (combineChecksum ^ id) >>> 0;
      }
      // Combines — every segment's ids live in chunks 0..CHUNKS_PER_SEG-1, so any two segments overlap on most
      // keys: these really do fetch, decode and combine chunk payloads through the bounded window rather than
      // short-circuiting on a disjoint key set. Each carries an `exclude` operand, read only at surviving keys.
      // Fully drained (a combine is an async generator — abandoning it mid-stream would measure a different
      // thing, and leave the window's last slots unobserved). andNot is included because suppression is the case
      // where an unbounded window would hurt most in production.
      for (let c = 0; c < 2; c++) {
        const a = store.segment(segName(pick(rand)));
        const b = store.segment(segName(pick(rand)));
        const x = store.segment(segName(pick(rand)));
        const roll = rand();
        const stream =
          roll < 1 / 3
            ? a.intersect([b], { exclude: [x] })
            : roll < 2 / 3
              ? a.union([b], { exclude: [x] })
              : a.andNot([b, x]);
        // XOR the ids rather than discarding them: the drained values are then genuinely consumed, and a change
        // that left the combine yielding *nothing* would move `combineChecksum` instead of being invisible.
        for await (const id of stream) {
          combineIds++;
          combineChecksum = (combineChecksum ^ id) >>> 0;
        }
        combines++;
      }
      iters++;

      const elapsed = Date.now() - startedAt;
      if (elapsed - lastSample >= SAMPLE_MS) {
        gc();
        samples.push({
          tSec: round(elapsed / 1000, 1),
          heapMiB: round(heapMiB(), 1),
          nativeMiB: round(nativeMiB(), 2),
          rssMiB: round(rssMiB(), 1),
          iters,
        });
        lastSample = elapsed;
      }
    }

    // Isolated read-path footprint: a fresh child reads the same fleet with no seed-phase arena.
    let reader = null;
    try {
      const out = execFileSync(process.execPath, ['--expose-gc', __filename], {
        env: { ...process.env, SOAK_TASK: 'reader', SOAK_DIR: dir },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      const line = out.split('\n').find((l) => l.startsWith('SOAK_READER:'));
      if (line) reader = JSON.parse(line.slice('SOAK_READER:'.length));
    } catch {
      /* reader child is a bonus; soak verdict stands without it */
    }

    return analyze(samples, iters, reader, {
      reloads,
      combines,
      combineIds,
      combineChecksum,
      iterated,
    });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Creep verdict: compare first-third vs last-third medians for BOTH post-GC JS heap AND the roaring addon's
 * live native bytes; PASS only if neither grows past its band. Watching native memory too is what makes this
 * evidence for the RSS envelope, not just the heap (a native creep slips a heap-only gate).
 */
function analyze(samples, iters, reader, work) {
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  };
  const third = Math.max(1, Math.floor(samples.length / 3));
  // Band = 15% of this run's baseline (a *relative* tolerance that scales with the working set) PLUS a small
  // absolute floor for the sampling/allocator noise that does NOT scale with size. The floor is metric-specific
  // so it stays anchored to each axis's real working set: heap sits at MiB scale (1 MiB floor), but post-GC
  // native jitter is sub-MiB (empirically ~0, since global.gc() reclaims dropped roaring memory fully), so a
  // 1 MiB native floor would rubber-stamp a ~10× leak on a ~0.1 MiB native baseline — native gets a 0.25 MiB
  // floor instead. Miss direction is fail-safe (a real leak compounds well past the band).
  const creepOf = (pickSample, floorMiB) => {
    const xs = samples.map(pickSample);
    const firstMed = median(xs.slice(0, third));
    const lastMed = median(xs.slice(-third));
    const creep = round(lastMed - firstMed, 2);
    const limit = round(firstMed * 0.15 + floorMiB, 2);
    return { firstMed, lastMed, creep, limit, ok: creep <= limit };
  };
  const heap = creepOf((s) => s.heapMiB, 1);
  const native = creepOf((s) => s.nativeMiB, 0.25);
  // A run that performed no combines, or no re-loads, is INCONCLUSIVE, never PASS — regardless of how flat the
  // samples were. The verdict refuses to claim coverage it does not have, so removing either phase breaks the
  // build instead of quietly narrowing what PASS means.
  const verdict =
    samples.length < 3 || work.combines === 0 || work.reloads === 0
      ? 'inconclusive'
      : heap.ok && native.ok
        ? 'PASS'
        : 'CREEP';
  return {
    note: 'Generated by `pnpm soak`. Measured (wall-clock + heap/native/RSS) — machine-dependent, not a gate.',
    env: {
      node: process.version,
      arch: process.arch,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
    },
    config: {
      seconds: SECONDS,
      segments: SEGMENTS,
      cap: CAP,
      sampleMs: SAMPLE_MS,
      idsPerSegment: IDS_PER_SEG,
      chunksPerSegment: CHUNKS_PER_SEG,
    },
    iters,
    itersPerSec: round(iters / SECONDS, 1),
    // Generations published over live segments during the run — the write path, and what exercises the reader
    // cache's generation refresh. Part of the evidence, like `combines`: a zero here is an inconclusive run.
    reloads: work.reloads,
    // Recorded so a reader can confirm the combine path was actually exercised rather than trusting that it was.
    combines: work.combines,
    combineIds: work.combineIds,
    combineChecksum: work.combineChecksum,
    iterated: work.iterated,
    samples,
    firstThirdHeapMiB: heap.firstMed,
    lastThirdHeapMiB: heap.lastMed,
    creepMiB: heap.creep,
    creepLimitMiB: heap.limit,
    firstThirdNativeMiB: native.firstMed,
    lastThirdNativeMiB: native.lastMed,
    nativeCreepMiB: native.creep,
    nativeCreepLimitMiB: native.limit,
    verdict,
    readerProcess: reader, // isolated read-path footprint (heap + native + RSS), or null if the child failed
  };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ── entry ──
(async () => {
  // Fail fast: the whole creep verdict rests on post-GC samples. Without --expose-gc, gc() silently
  // no-ops, samples retain uncollected garbage, and a leak can hide (or a clean run can look like creep).
  // A soak that can't force GC is not a soak — refuse to run rather than emit a meaningless PASS.
  if (typeof global.gc !== 'function') {
    console.error(
      'soak: global.gc is unavailable — run with --expose-gc (use `pnpm soak`, which sets it).\n' +
        '      Without it, post-GC heap sampling is impossible and the creep verdict is meaningless.',
    );
    process.exit(1);
  }
  if (process.env.SOAK_TASK === 'reader') {
    await readerChild();
    return;
  }
  console.log(
    `soak: ${SECONDS}s · ${SEGMENTS} segments · cap ${CAP} · sampling every ${SAMPLE_MS}ms …`,
  );
  const r = await soak();
  console.log(
    `\nsoak: verdict=${r.verdict} · heap creep=${r.creepMiB}MiB (${r.firstThirdHeapMiB}→${r.lastThirdHeapMiB}, limit ${r.creepLimitMiB}) · native creep=${r.nativeCreepMiB}MiB (${r.firstThirdNativeMiB}→${r.lastThirdNativeMiB}, limit ${r.nativeCreepLimitMiB}) over ${r.samples.length} samples · ${r.iters} iters (${r.itersPerSec}/s) · ${r.reloads} re-loads · ${r.combines} combines (${r.combineIds} ids) · ${r.iterated} iterated` +
      (r.readerProcess
        ? ` · reader-child heap=${r.readerProcess.heapMiB}MiB native=${r.readerProcess.nativeMiB}MiB (bounds) rss=${r.readerProcess.rssMiB}MiB (~Node floor) after ${r.readerProcess.combines} isolated combines`
        : ''),
  );
  if (process.env.SOAK_INJECT === '1') {
    fs.writeFileSync(path.join(ROOT, 'bench/soak-results.json'), JSON.stringify(r, null, 2) + '\n');
    console.log('  wrote bench/soak-results.json');
  } else {
    console.log('  (dry run — set SOAK_INJECT=1 to persist bench/soak-results.json)');
  }
  if (r.verdict !== 'PASS') process.exit(1); // only a clean PASS is success (CREEP or inconclusive → non-zero)
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
