/*
 * Soak / endurance harness (test-strategy T1).
 *
 * G4 proved the memory bound as a *snapshot* (read a fleet once → flat live heap). Soak proves it over *time*:
 * a store under **sustained mixed load** — continuous writes (grow the Warm delta), reads across the population,
 * and compaction (fold Warm→Cold) — must not leak or creep. We sample post-GC live heap at intervals for the
 * whole run and assert the last-third median hasn't grown past the first-third median beyond a small band. This
 * is the "true steady state" a long-running server actually sees.
 *
 * It also closes G4's logged follow-up — **isolated read-path footprint**: a FRESH reader-only child opens the
 * fleet (its post-soak on-disk state) and reads across all of it (count + has, so it DECODES bitmaps) with no
 * seed-phase arena contamination. Post-GC *heap* is one bound to watch (distinct from the seed-inflated in-process
 * heap G4 measured). But JS heap misses the roaring bitmaps' **native/off-heap** memory (the addon allocates its
 * containers outside V8), so the verdict now watches **both**: post-GC JS heap AND `getRoaringUsedMemory()` (the
 * addon's live native bytes, decremented on free/GC-finalize) — a run PASSes only if neither creeps.
 *
 * SCOPE (be honest): live-native proves **no off-heap leak** — it does NOT prove **RSS is bounded**. The malloc
 * allocator can retain freed arenas, so RSS climbs (the committed runs show ~64→~106 MiB) while live heap+native
 * stay flat; the counter can't see that retention. The definitive RSS ceiling is a hard cgroup `--memory` gate,
 * which needs Linux runners and is **deferred to the public launch** (gap #12). RSS is reported here only as a
 * floor sanity-check (dominated by the fixed Node + addon floor, ~65 MiB on this arch).
 *
 * Offline + machine-dependent (wall-clock + RSS) — NOT a CI gate, same rationale as bench/run.cjs and
 * bench/scale.cjs; the deterministic claims stay gated in tests/. Run with --expose-gc. On a laptop, prevent
 * sleep (`caffeinate -dis`) so the duration isn't corrupted by suspend.
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
  LocalFsWarmDriver,
  LocalFsRegistryDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  findCompactable,
  gcOrphanGenerations,
} = require('@cloudbitmaps/roaring');
// The roaring addon allocates bitmap containers OUTSIDE the V8 heap, so heapUsed can't see them. This is the
// process-wide live native byte count — the off-heap component the memory verdict must watch (auditor F2).
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
/** A random id spread across CHUNKS_PER_SEG distinct 16-bit chunks (id = chunkKey·65536 + remainder). */
function randId(rand) {
  return ((rand() * CHUNKS_PER_SEG) | 0) * 65536 + ((rand() * REMAINDER) | 0);
}

/** Seed a LocalFs fleet of cold gen-0 segments; returns the drivers. */
async function seedFleet(dir) {
  const cold = new LocalFsColdDriver(dir);
  const warm = new LocalFsWarmDriver(dir);
  const registry = new LocalFsRegistryDriver(dir, { now: () => Date.now() });
  const rand = rng(SEED);
  for (let i = 0; i < SEGMENTS; i++) {
    const ids = [];
    for (let k = 0; k < IDS_PER_SEG; k++) ids.push(randId(rand));
    await bulkLoadCrbmGeneration(cold, { segment: segName(i), generation: 0 }, ids, { registry });
  }
  return { cold, warm, registry };
}

// ── the reader-only child: open the post-soak fleet, read across all of it, report isolated heap+RSS ──
async function readerChild() {
  const dir = process.env.SOAK_DIR;
  const cold = new LocalFsColdDriver(dir);
  const warm = new LocalFsWarmDriver(dir);
  const registry = new LocalFsRegistryDriver(dir, { now: () => Date.now() });
  const store = new CloudRoaring({ cold, warm, registry, coldReaderCacheMax: CAP });
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
  gc();
  process.stdout.write(
    `SOAK_READER:${JSON.stringify({
      heapMiB: round(heapMiB(), 1),
      nativeMiB: round(nativeMiB(), 2),
      rssMiB: round(rssMiB(), 1),
    })}\n`,
  );
}

// ── the soak loop: sustained writes + reads + compaction; sample post-GC heap over time ──
async function soak() {
  const dir = mkTmp();
  try {
    const { cold, warm, registry } = await seedFleet(dir);
    const store = new CloudRoaring({ cold, warm, registry, coldReaderCacheMax: CAP });
    const deps = { cold, warm, registry, clock: { now: () => Date.now() } };
    const rand = rng(SEED ^ 0x9e3779b9);

    const samples = [];
    const startedAt = Date.now();
    let lastSample = 0;
    let iters = 0;
    let compactions = 0;

    while (Date.now() - startedAt < SECONDS * 1000) {
      // Writes — a few adds + removes on random segments (grows the Warm delta).
      for (let w = 0; w < 8; w++) {
        const seg = store.segment(segName((rand() * SEGMENTS) | 0));
        const id = randId(rand);
        if (rand() < 0.5) await seg.add(id);
        else await seg.remove(id);
      }
      // Reads — count + has across random segments (exercises the bounded cold reader cache).
      for (let r = 0; r < 12; r++) {
        const seg = store.segment(segName((rand() * SEGMENTS) | 0));
        await seg.count();
        await seg.has(randId(rand));
      }
      // Compaction — every few iterations, fold Warm→Cold for a handful of dirty segments (keeps Warm
      // bounded), then GC superseded Cold generations so cold on-disk storage stays bounded over a long run.
      if (iters % 5 === 0) {
        const candidates = await findCompactable(deps, {});
        for (const c of candidates.slice(0, 8)) {
          const res = await compactSegment(c.ref, deps, { owner: 'soak' });
          if (res.compacted) {
            compactions++;
            // Best-effort post-commit cleanup (mirrors the library's own guarded call in runCompactionCycle):
            // a transient FS fault here must not abort the soak — it's disk hygiene, not part of the verdict.
            await gcOrphanGenerations(c.ref, deps, { keep: 1 }).catch(() => undefined);
          }
        }
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

    return analyze(samples, iters, compactions, reader);
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
 * evidence for the RSS envelope, not just the heap (auditor F2: a native creep slips a heap-only gate).
 */
function analyze(samples, iters, compactions, reader) {
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
  const creepOf = (pick, floorMiB) => {
    const xs = samples.map(pick);
    const firstMed = median(xs.slice(0, third));
    const lastMed = median(xs.slice(-third));
    const creep = round(lastMed - firstMed, 2);
    const limit = round(firstMed * 0.15 + floorMiB, 2);
    return { firstMed, lastMed, creep, limit, ok: creep <= limit };
  };
  const heap = creepOf((s) => s.heapMiB, 1);
  const native = creepOf((s) => s.nativeMiB, 0.25);
  const verdict = samples.length < 3 ? 'inconclusive' : heap.ok && native.ok ? 'PASS' : 'CREEP';
  return {
    note: 'Generated by `pnpm soak`. Measured (wall-clock + heap/native/RSS) — machine-dependent, not a gate.',
    env: {
      node: process.version,
      arch: process.arch,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
    },
    config: { seconds: SECONDS, segments: SEGMENTS, cap: CAP, sampleMs: SAMPLE_MS },
    iters,
    itersPerSec: round(iters / SECONDS, 1),
    compactions,
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
  const result = await soak();
  const r = result;
  console.log(
    `\nsoak: verdict=${r.verdict} · heap creep=${r.creepMiB}MiB (${r.firstThirdHeapMiB}→${r.lastThirdHeapMiB}, limit ${r.creepLimitMiB}) · native creep=${r.nativeCreepMiB}MiB (${r.firstThirdNativeMiB}→${r.lastThirdNativeMiB}, limit ${r.nativeCreepLimitMiB}) over ${r.samples.length} samples · ${r.iters} iters (${r.itersPerSec}/s) · ${r.compactions} compactions` +
      (r.readerProcess
        ? ` · reader-child heap=${r.readerProcess.heapMiB}MiB native=${r.readerProcess.nativeMiB}MiB (bounds) rss=${r.readerProcess.rssMiB}MiB (~Node floor)`
        : ''),
  );
  if (process.env.SOAK_INJECT === '1') {
    fs.writeFileSync(
      path.join(ROOT, 'bench/soak-results.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log('  wrote bench/soak-results.json');
  } else {
    console.log('  (dry run — set SOAK_INJECT=1 to persist bench/soak-results.json)');
  }
  if (r.verdict !== 'PASS') process.exit(1); // only a clean PASS is success (CREEP or inconclusive → non-zero)
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
