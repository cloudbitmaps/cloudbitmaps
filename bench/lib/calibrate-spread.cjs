'use strict';
/*
 * The spread layout: the calibration workload's overlap with its shared chunks scattered instead of packed.
 *
 * WHY IT EXISTS. The calibration layout puts every segment's shared ids at chunk keys 0 to 99, one contiguous run,
 * so the shared chunks sit side by side in each generation object. A read that merges neighbouring chunks into one
 * request would look better on that layout than on data whose shared chunks are far apart. This layout keeps the
 * same overlap (the same number of shared chunks, the same ids in every chunk) and puts the shared keys at positions
 * spread uniformly over each segment's chunks, so the bytes between two shared chunks are other chunks the
 * intersect never wants.
 *
 * PLACEMENT. Chunk keys 0 to span - 1 are the universe, span being the shared chunks plus every segment's private
 * chunks. The universe is cut into one equal stratum per shared chunk and a seeded generator picks a key inside each
 * stratum; those are the shared keys. The keys left over are dealt to the segments one at a time in turn, so each
 * segment's private chunks are spread over the same span and no two segments hold the same private key. Every chunk
 * holds the same number of ids, so every chunk costs about the same bytes and the only thing that varies with
 * position is the distance between shared chunks.
 *
 * It is a pure function of its arguments: the same seed gives the same keys, so a run and its rehearsal read the
 * same layout, and the expected intersection of any pair (its count and its sum) is known exactly.
 */

/** One roaring chunk spans this many ids: the top 16 bits of a 32-bit id choose it. */
const CHUNK_SPAN = 65_536;
/** How many chunks a 32-bit id space holds. */
const ID_SPACE_CHUNKS = 65_536;

/** A small deterministic generator (mulberry32): a 32-bit seed in, floats in [0, 1) out. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Plan a spread layout for `segments` segments that pairwise share exactly `sharedChunks` chunks.
 *
 * Every chunk holds `idsPerChunk` ids, spaced `stride` apart from the chunk's first id, so a chunk's ids all lie in
 * its own 65,536 and the expected intersection of any pair is the shared chunks' ids and nothing else.
 */
function planSpread({ segments, sharedChunks, privateChunks, idsPerChunk, stride, seed }) {
  for (const [name, v] of Object.entries({
    segments,
    sharedChunks,
    privateChunks,
    idsPerChunk,
    stride,
  })) {
    if (!Number.isInteger(v) || v < 1)
      throw new Error(`${name} must be a positive integer, got ${v}`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`seed must be an integer from 0 to 2^32 - 1, got ${seed}`);
  }
  if ((idsPerChunk - 1) * stride >= CHUNK_SPAN) {
    throw new Error(
      `${idsPerChunk} ids ${stride} apart do not fit in one chunk of ${CHUNK_SPAN} ids — the ids would cross ` +
        'into the next chunk and the shared chunks would no longer be the planned ones',
    );
  }
  const span = sharedChunks + segments * privateChunks;
  if (span > ID_SPACE_CHUNKS) {
    throw new Error(
      `layout needs ${span} chunks but a 32-bit id space holds ${ID_SPACE_CHUNKS} — ` +
        'shrink the workload rather than let ids wrap',
    );
  }
  const next = seeded(seed);
  const sharedKeys = [];
  for (let j = 0; j < sharedChunks; j += 1) {
    const lo = Math.floor((j * span) / sharedChunks);
    const hi = Math.floor(((j + 1) * span) / sharedChunks);
    sharedKeys.push(lo + Math.floor(next() * (hi - lo)));
  }
  const isShared = new Set(sharedKeys);
  const owned = Array.from({ length: segments }, () => []);
  let dealt = 0;
  for (let key = 0; key < span; key += 1) {
    if (isShared.has(key)) continue;
    owned[dealt % segments].push(key);
    dealt += 1;
  }
  const keys = owned.map((own) => [...sharedKeys, ...own].sort((a, b) => a - b));
  // Exact, and checked: the harness asserts a real object store returned precisely these ids.
  const perChunkOffsets = (BigInt(stride) * BigInt(idsPerChunk) * BigInt(idsPerChunk - 1)) / 2n;
  let sum = 0n;
  for (const key of sharedKeys) {
    sum += BigInt(idsPerChunk) * BigInt(key) * BigInt(CHUNK_SPAN) + perChunkOffsets;
  }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      'the expected intersection sum exceeds 2^53 — the exact-content check would be unsound',
    );
  }
  return {
    segments,
    sharedChunks,
    privateChunks,
    chunksPerSegment: sharedChunks + privateChunks,
    idsPerChunk,
    idsPerSegment: (sharedChunks + privateChunks) * idsPerChunk,
    stride,
    seed,
    span,
    sharedKeys,
    keys,
    expected: { count: sharedChunks * idsPerChunk, sum: Number(sum) },
  };
}

/** The ids of segment `i` under `layout`, ascending: a generator, so no workload is materialised twice. */
function* spreadIds(layout, i) {
  const keys = layout.keys[i];
  if (keys === undefined) throw new Error(`segment ${i} is not in a layout of ${layout.segments}`);
  for (const key of keys) {
    const base = key * CHUNK_SPAN;
    for (let j = 0; j < layout.idsPerChunk; j += 1) yield base + j * layout.stride;
  }
}

module.exports = { planSpread, spreadIds };
