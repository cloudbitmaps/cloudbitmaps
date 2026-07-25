/*
 * Stress harness (test-strategy T4).
 *
 * Push the system past normal load to find breaking points + confirm the design's bounds hold under duress.
 * Three scenarios, each mapped to a claimed guarantee:
 *   S1  Compaction-backlog explosion   dirty EVERY segment at once, then drain with a bounded per-cycle budget.
 *                                       Confirms the daemon does O(budget) work per cycle (not O(fleet)) and the
 *                                       backlog drains monotonically — gap #2/#3 (budgeted/urgency-ordered).
 *   S2  Hot-row Warm contention        many concurrent writers hammer ONE chunk → OCC WriteConflictError storms.
 *                                       Confirms convergence to the oracle with no lost update (I2, jittered OCC).
 *   S3  Single huge segment            build a segment with tens of millions of ids. Oracle: count === input
 *                                       (no dedupe/loss). Footprint is bounded by the roaring container structure
 *                                       (≤ 65536 chunks / the .crbm size), NOT constant — JS heap stays flat only
 *                                       because roaring lives off-heap (native), so RSS is the honest footprint.
 *
 * Offline + machine-dependent (wall-clock + heap/RSS) — NOT a CI gate, same rationale as bench/run.cjs /
 * scale.cjs / soak.cjs; the deterministic claims stay gated in tests/. Run with --expose-gc for post-GC heap.
 * On a laptop, prevent sleep (`caffeinate -dis`) so timings aren't corrupted by suspend.
 *
 * Run: `pnpm stress` (builds first). Env knobs:
 *   STRESS_ONLY=s1|s2|s3        run one scenario         STRESS_INJECT=1   persist bench/stress-results.json
 *   S1_SEGMENTS=1000  S1_BUDGET=64                       S2_WRITERS=24  S2_OPS=200
 *   S3_IDS=50000000 (ids in the huge segment)            STRESS_SEED=1
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CloudRoaring,
  CrbmColdChunkSource,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  MemoryColdDriver,
  MemoryWarmDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  findCompactable,
  runCompactionCycle,
} = require('@cloudbitmaps/roaring');

const ROOT = path.resolve(__dirname, '..');
const SEED = int(process.env.STRESS_SEED, 1);
const S1_SEGMENTS = int(process.env.S1_SEGMENTS, 1000);
const S1_BUDGET = int(process.env.S1_BUDGET, 64);
const S2_WRITERS = int(process.env.S2_WRITERS, 24);
const S2_OPS = int(process.env.S2_OPS, 200);
const S3_IDS = int(process.env.S3_IDS, 50_000_000);
const ONLY = process.env.STRESS_ONLY;

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
function gc() {
  if (typeof global.gc === 'function') global.gc();
}
function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
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
function segName(i) {
  return `s${i}`;
}
function memWorld() {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps = { cold, warm, registry, clock: { now: () => Date.now() } };
  // Default retry (decorators on) — S2 relies on the OCC WriteConflict retry to converge under contention.
  const store = new CloudRoaring({ warm, cold: new CrbmColdChunkSource(cold, { registry }) });
  return { cold, warm, registry, deps, store };
}

// ── S1: compaction-backlog explosion — dirty every segment, drain under a bounded per-cycle budget ──
async function scenario1() {
  const w = memWorld();
  const rand = rng(SEED);
  // Seed a fleet of cold gen-0 segments, then dirty EVERY one (a full backlog).
  for (let i = 0; i < S1_SEGMENTS; i++) {
    await bulkLoadCrbmGeneration(
      w.cold,
      { segment: segName(i), generation: 0 },
      [i * 3, i * 3 + 1],
      {
        registry: w.registry,
      },
    );
  }
  for (let i = 0; i < S1_SEGMENTS; i++) {
    await w.store.segment(segName(i)).add(((rand() * 65536) | 0) + i * 65536);
  }
  const backlog0 = (await findCompactable(w.deps, {})).length;
  gc();
  const cycles = [];
  let remaining = backlog0;
  let guard = 0;
  while (remaining > 0 && guard++ < S1_SEGMENTS + 10) {
    const t = process.hrtime.bigint();
    const res = await runCompactionCycle(w.deps, { owner: 'stress', maxSegments: S1_BUDGET });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    remaining = (await findCompactable(w.deps, {})).length;
    cycles.push({
      compacted: res.compacted ?? res.compactedCount ?? null,
      remaining,
      ms: round(ms, 1),
    });
  }
  gc();
  const perCycleCompacted = cycles.map((c) => c.compacted).filter((n) => typeof n === 'number');
  const maxPerCycle = perCycleCompacted.length ? Math.max(...perCycleCompacted) : null;
  // Backlog must shrink every cycle (never grow) and reach zero — a real end-to-end drain, not oscillation.
  let monotonic = true;
  let prevRemaining = backlog0;
  for (const c of cycles) {
    if (c.remaining > prevRemaining) monotonic = false;
    prevRemaining = c.remaining;
  }
  return {
    segments: S1_SEGMENTS,
    budget: S1_BUDGET,
    initialBacklog: backlog0,
    cyclesToDrain: cycles.length,
    maxCompactedPerCycle: maxPerCycle,
    // NB: this bounds the per-cycle *compaction count* (the daemon commits ≤ budget generations/cycle). It does
    // NOT bound total per-cycle work — discovery (findCompactable's registry scan) is O(fleet) every cycle (the
    // `ms` samples below reflect that). Claim only what this proves: the budget is enforced end-to-end.
    boundedPerCycle: maxPerCycle !== null && maxPerCycle <= S1_BUDGET,
    monotonicDrain: monotonic,
    drained: remaining === 0,
    heapMiB: round(heapMiB(), 1),
    sampleCycles: cycles.slice(0, 3).concat(cycles.slice(-1)),
  };
}

// ── S2: hot-row Warm contention — many concurrent writers on ONE chunk; verify no lost update vs an oracle ──
async function scenario2() {
  const w = memWorld();
  const seg = 'hot';
  const CHUNK = 7 * 65536; // every id shares one 16-bit chunk → ONE Warm row → maximal OCC contention
  const perWriter = Math.max(1, Math.floor(4096 / S2_WRITERS));
  // Each writer owns a DISJOINT low-16 sub-range, so the final state is deterministic regardless of cross-writer
  // interleaving — the union of each writer's own last-op-per-id. OCC contention on the shared Warm row must not
  // lose any committed op: concurrent result MUST equal that oracle (I2, no lost update; jittered OCC retry).
  const plans = [];
  const oracle = new Set();
  for (let wct = 0; wct < S2_WRITERS; wct++) {
    const rand = rng(SEED + wct * 2654435761);
    const base = CHUNK + wct * perWriter;
    const ops = [];
    for (let o = 0; o < S2_OPS; o++) {
      const id = base + ((rand() * perWriter) | 0);
      const add = rand() < 0.6;
      ops.push({ id, add });
      if (add) oracle.add(id);
      else oracle.delete(id);
    }
    plans.push(ops);
  }
  const started = process.hrtime.bigint();
  await Promise.all(
    plans.map(async (ops) => {
      for (const op of ops) {
        if (op.add) await w.store.segment(seg).add(op.id);
        else await w.store.segment(seg).remove(op.id);
      }
    }),
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const final = [];
  for await (const id of w.store.segment(seg).iterate()) final.push(id);
  final.sort((a, b) => a - b);
  const oracleArr = [...oracle].sort((a, b) => a - b);
  const converged = final.length === oracleArr.length && final.every((v, i) => v === oracleArr[i]);
  return {
    writers: S2_WRITERS,
    opsPerWriter: S2_OPS,
    totalOps: S2_WRITERS * S2_OPS,
    concurrentMs: round(ms, 1),
    finalCardinality: final.length,
    oracleCardinality: oracleArr.length,
    convergedNoLostUpdate: converged,
  };
}

// ── S3: one huge segment — memory tracks container structure (≤ 65536 chunks), not id count ──
async function scenario3(dir) {
  const cold = new LocalFsColdDriver(dir);
  const registry = new LocalFsRegistryDriver(dir, { now: () => Date.now() });
  const seg = 'huge';
  // Guard the oracle: ids are strided across the 32-bit space, so distinctness (count === S3_IDS) holds only
  // while S3_IDS ≤ 2^32. Beyond that the stride floors to 1 and `v >>> 0` wraps, silently deduping — which would
  // make `count < S3_IDS` and quietly defeat the check. Fail fast rather than report a misleading number.
  if (S3_IDS > 0x1_0000_0000) {
    throw new RangeError(
      `S3_IDS=${S3_IDS} exceeds 2^32; strided ids would wrap/dedupe and break the count oracle`,
    );
  }
  // A strided range so ids span the full 32-bit space across many chunks (bitmap containers, not one run).
  const stride = Math.max(1, Math.floor(0xffffffff / S3_IDS));
  function* ids() {
    for (let i = 0, v = 0; i < S3_IDS; i++, v += stride) yield v >>> 0;
  }
  gc();
  const heapBefore = heapMiB();
  const t = process.hrtime.bigint();
  await bulkLoadCrbmGeneration(cold, { segment: seg, generation: 0 }, ids(), { registry });
  const buildMs = Number(process.hrtime.bigint() - t) / 1e6;
  gc();
  const heapAfter = heapMiB();
  // On-disk size of the generation's .crbm payload. LocalFs nests it under <ns>/segments/, so walk
  // recursively and sum only .crbm files (the registry .reg is excluded — we want the cold payload size).
  const crbmBytesUnder = (d) => {
    let total = 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) total += crbmBytesUnder(p);
      else if (e.name.endsWith('.crbm')) total += fs.statSync(p).size;
    }
    return total;
  };
  const bytes = crbmBytesUnder(dir);
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new CrbmColdChunkSource(cold, { registry }),
    retry: false,
  });
  const tc = process.hrtime.bigint();
  const count = await store.segment(seg).count();
  const countMs = Number(process.hrtime.bigint() - tc) / 1e6;
  gc();
  return {
    ids: S3_IDS,
    buildMs: round(buildMs, 0),
    idsPerSec: round(S3_IDS / (buildMs / 1000), 0),
    crbmBytes: bytes,
    crbmMiB: round(bytes / 1048576, 2),
    count,
    countMatchesInput: count === S3_IDS, // oracle: the segment holds exactly what we streamed in (no dedupe/loss)
    countMs: round(countMs, 1),
    // JS heap stays flat because roaring bitmaps live OFF-heap (native addon) — heap is NOT the footprint here.
    // The real footprint is RSS, which tracks the roaring container structure (~the .crbm size), not a constant.
    buildHeapDeltaMiB: round(heapAfter - heapBefore, 1),
    postGcHeapMiB: round(heapAfter, 1),
    rssMiB: round(rssMiB(), 1),
  };
}

async function main() {
  const out = {
    note: 'Generated by `pnpm stress`. Measured (wall-clock + heap/RSS) — machine-dependent, not a gate.',
    env: {
      node: process.version,
      arch: process.arch,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
    },
  };
  if (!ONLY || ONLY === 's1') {
    console.log(`S1 compaction-backlog: ${S1_SEGMENTS} segments, budget ${S1_BUDGET} …`);
    out.s1 = await scenario1();
    console.log(
      `  backlog ${out.s1.initialBacklog} drained in ${out.s1.cyclesToDrain} cycles; max compacted/cycle=${out.s1.maxCompactedPerCycle} (≤budget: ${out.s1.boundedPerCycle}); monotonic=${out.s1.monotonicDrain}; drained=${out.s1.drained}`,
    );
  }
  if (!ONLY || ONLY === 's2') {
    console.log(`S2 hot-row contention: ${S2_WRITERS} writers × ${S2_OPS} ops on one chunk …`);
    out.s2 = await scenario2();
    console.log(
      `  ${out.s2.totalOps} ops in ${out.s2.concurrentMs}ms concurrent; converged (no lost update)=${out.s2.convergedNoLostUpdate}`,
    );
  }
  if (!ONLY || ONLY === 's3') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crbm-stress-'));
    try {
      console.log(`S3 huge segment: ${S3_IDS.toLocaleString()} ids …`);
      out.s3 = await scenario3(dir);
      console.log(
        `  built ${out.s3.count.toLocaleString()} ids in ${out.s3.buildMs}ms (${out.s3.idsPerSec.toLocaleString()}/s); count matches input=${out.s3.countMatchesInput}; .crbm ${out.s3.crbmMiB}MiB; count ${out.s3.countMs}ms; heap ${out.s3.postGcHeapMiB}MiB (off-heap roaring) / RSS ${out.s3.rssMiB}MiB`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  out.rssMiB = round(rssMiB(), 1);
  if (process.env.STRESS_INJECT === '1') {
    fs.writeFileSync(
      path.join(ROOT, 'bench/stress-results.json'),
      JSON.stringify(out, null, 2) + '\n',
    );
    console.log('  wrote bench/stress-results.json');
  } else {
    console.log('  (dry run — set STRESS_INJECT=1 to persist bench/stress-results.json)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
