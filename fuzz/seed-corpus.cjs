'use strict';
/*
 * Generate deterministic seed corpora for the jazzer targets (fuzz/targets/*.mjs).
 *
 * Coverage-guided fuzzing starts from seeds and evolves them; good, VALID seeds let libFuzzer reach deep parse
 * branches far faster than starting from nothing. We generate these at runtime (rather than committing binary
 * blobs) so they stay reproducible and reviewable. Idempotent: only writes files that are missing.
 *
 *   node fuzz/seed-corpus.cjs            # seed every target
 *   node fuzz/seed-corpus.cjs crbm-reader   # seed one target
 *
 * Needs a build first (`pnpm build`) — it drives the public writer/serializer from dist/.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SafeBitmap, CrbmWriter, BufferSink } = require('@cloudbitmaps/roaring');

const CORPUS = path.join(__dirname, 'corpus');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
function writeSeed(target, name, bytes) {
  const dir = path.join(CORPUS, target);
  ensureDir(dir);
  const file = path.join(dir, name);
  // `bytes` is always a Uint8Array (serialize()/subarray()/slice()/sink.bytes()); fs accepts it directly.
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
}

/** A spread of value distributions that exercise every roaring container type (array / bitmap / run). */
function valueSets() {
  const dense = [];
  for (let i = 0; i < 6000; i++) dense.push(i * 10); // many values → bitmap container
  const run = [];
  for (let i = 1000; i < 3000; i++) run.push(i); // long consecutive → run container
  const multiChunk = [1, 0x10000 + 5, 0x20000 + 9, 0x7fffffff]; // spans several 16-bit containers
  return {
    empty: [],
    tiny: [0],
    small: [1, 2, 3, 100, 65535],
    dense,
    run,
    multiChunk,
  };
}

function seedSafeDeserialize() {
  const sets = valueSets();
  for (const [name, vals] of Object.entries(sets)) {
    const ser = SafeBitmap.fromValues(vals).serialize();
    writeSeed('safe-deserialize', `valid-${name}.bin`, ser);
    // A couple of near-miss mutants of each valid seed — great libFuzzer springboards toward the error paths.
    if (ser.length > 4) {
      writeSeed('safe-deserialize', `trunc-${name}.bin`, ser.subarray(0, ser.length >> 1));
      const flipped = ser.slice();
      flipped[0] = flipped[0] ^ 0xff; // corrupt the serialization cookie/header
      writeSeed('safe-deserialize', `flip-${name}.bin`, flipped);
    }
  }
}

async function validCrbm(chunks, generation) {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation });
  for (const { key, vals } of chunks) {
    const payload = SafeBitmap.fromValues(vals).serialize();
    await writer.addChunk(key, payload, vals.length);
  }
  await writer.finish();
  return sink.bytes();
}

async function seedCrbmReader() {
  const layouts = [
    { name: 'one-chunk', gen: 0, chunks: [{ key: 0, vals: [1, 2, 3] }] },
    {
      name: 'multi-chunk',
      gen: 7,
      chunks: [
        { key: 0, vals: [1, 2, 3, 4] },
        { key: 256, vals: [10, 20] },
        { key: 65535, vals: [7] },
      ],
    },
    { name: 'dense-chunk', gen: 3, chunks: [{ key: 42, vals: rangeVals(0, 4000) }] },
  ];
  for (const l of layouts) {
    const bytes = await validCrbm(l.chunks, l.gen);
    writeSeed('crbm-reader', `valid-${l.name}.bin`, bytes);
    // Truncations that keep the footer's shape but sever the index/payload — hits the bounds/CRC/short paths.
    writeSeed('crbm-reader', `trunc-head-${l.name}.bin`, bytes.subarray(0, bytes.length >> 1));
    const flipped = bytes.slice();
    flipped[10] = flipped[10] ^ 0xff; // corrupt a preamble/payload byte
    writeSeed('crbm-reader', `flip-${l.name}.bin`, flipped);
  }
}

function rangeVals(lo, hi) {
  const out = [];
  for (let i = lo; i < hi; i++) out.push(i);
  return out;
}

// ── crbm-index target: raw index-region byte blobs fed straight to parseIndex (no CRC wall) ──
// Index entry wire form: varint(keyDelta) varint(offDelta)
// varint(len) varint(cardinality) + 4-byte payload CRC (LE). parseIndex stores the CRC without validating it
// here, so seed CRCs are arbitrary. offDelta=0 lays each chunk immediately after the previous (offsets stay in
// bounds); keyDelta>0 after the first avoids the duplicate-key rejection.
function pushVarint(arr, v) {
  let x = v >>> 0;
  while (x > 0x7f) {
    arr.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  arr.push(x);
}
function indexRegion(entries) {
  const a = [];
  for (const e of entries) {
    pushVarint(a, e.keyDelta);
    pushVarint(a, e.offDelta);
    pushVarint(a, e.len);
    pushVarint(a, e.card);
    a.push(0, 0, 0, 0); // payload CRC placeholder (unvalidated by parseIndex)
  }
  return Uint8Array.from(a);
}
function seedCrbmIndex() {
  const layouts = {
    'one-entry': [{ keyDelta: 0, offDelta: 0, len: 8, card: 2 }],
    'multi-entry': [
      { keyDelta: 0, offDelta: 0, len: 8, card: 2 },
      { keyDelta: 5, offDelta: 0, len: 4, card: 1 },
      { keyDelta: 250, offDelta: 0, len: 16, card: 3 },
      { keyDelta: 60000, offDelta: 0, len: 32, card: 10 },
    ],
    'wide-keys': [
      { keyDelta: 0, offDelta: 0, len: 4, card: 1 },
      { keyDelta: 65535, offDelta: 0, len: 4, card: 1 }, // cumulative key at the 0xffff ceiling
    ],
  };
  for (const [name, entries] of Object.entries(layouts)) {
    const region = indexRegion(entries);
    writeSeed('crbm-index', `valid-${name}.bin`, region);
    if (region.length > 6) {
      writeSeed('crbm-index', `trunc-${name}.bin`, region.subarray(0, region.length - 3)); // sever a trailing CRC
    }
  }
}

async function main() {
  const only = process.argv[2];
  if (!only || only === 'safe-deserialize') seedSafeDeserialize();
  if (!only || only === 'crbm-reader') await seedCrbmReader();
  if (!only || only === 'crbm-index') seedCrbmIndex();
  const targets = only ? [only] : ['safe-deserialize', 'crbm-reader', 'crbm-index'];
  for (const t of targets) {
    const dir = path.join(CORPUS, t);
    const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    console.log(`seeded ${t}: ${n} corpus files in fuzz/corpus/${t}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
