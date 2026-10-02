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
 * Needs a build first (`pnpm build`) — it drives the public `CloudRoaring.load` from dist/.
 *
 * It builds each archive with `store.load()` into an in-memory backend and reads the object back, rather than
 * driving the `.crbm` writer class directly. That class is not public — and this is the better seed anyway,
 * because the bytes then come off exactly the code path that writes a real generation, so a corpus entry
 * cannot drift from the format the library actually emits. The bitmaps for the `safe-deserialize` target come
 * from the native `roaring` addon's portable serializer, which is what the library's codec calls.
 *
 * Format 1.1 objects, which carry a generation's metadata, come from the `.crbm` writer itself, through the fuzz
 * build (`fuzz/build/fuzz-core.js`): a load is not given metadata, so it writes format 1.0 only.
 *
 * ONE CONSEQUENCE WORTH KNOWING: a load calls `runOptimize()` before serializing, which the writer class did
 * not. Run-encodable payloads therefore serialize much smaller here, and the layouts below are chosen so the
 * corpus still covers both container shapes — a strided `dense-chunk` that stays an array container and keeps
 * a multi-KB payload in the corpus, alongside the small run-encoded ones.
 */
const fs = require('node:fs');
const path = require('node:path');
const { CloudRoaring, MemoryStorage } = require('@cloudbitmaps/roaring');
const { RoaringBitmap32, SerializationFormat } = require('roaring');

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
    const ser = new RoaringBitmap32(vals).serialize(SerializationFormat.portable);
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

/**
 * The bytes of generation `generation` of a segment holding `chunks`, as `store.load()` writes them. A load takes
 * the next generation number itself, so generation `n` is the `n + 1`th load of the segment.
 */
async function validCrbm(chunks, generation) {
  const backend = new MemoryStorage({ now: () => 0 });
  const store = new CloudRoaring({ storage: backend });
  const ref = { segment: 'seed' };
  // A chunk key is an id's high 16 bits and `vals` are the low 16 bits under it.
  const ids = chunks.flatMap(({ key, vals }) => vals.map((v) => key * 65536 + v));
  for (let n = 0; n <= generation; n++) {
    const result = await store.load(ref, ids);
    if (!result.published || result.generation !== n) {
      throw new Error(`seed load ${n} did not publish generation ${n}: ${JSON.stringify(result)}`);
    }
  }
  const key = { segment: 'seed', generation };
  const { size } = await backend.storage.getTail(key, 1);
  return backend.storage.getRange(key, 0, size);
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
    // STRIDED, not contiguous. The write path optimizes before serializing, and a contiguous range
    // collapses to one run container — which turned this seed into 136 bytes and left the corpus with no
    // multi-KB payload and no array-container decode branch. A stride of 10 cannot run-encode.
    { name: 'dense-chunk', gen: 3, chunks: [{ key: 42, vals: stridedVals(0, 6000, 10) }] },
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
  // Format 1.1: the extension block between the last payload and the index. A flip in the block's trailer reaches
  // the trailer checks; one in its sections reaches the block CRC.
  for (const [name, metadata] of Object.entries(metadataSets())) {
    const bytes = await validCrbmWithMetadata(metadata);
    writeSeed('crbm-reader', `valid-v1_1-${name}.bin`, bytes);
    const { indexOffset } = extensionOf(bytes);
    for (const [where, at] of [
      ['magic', indexOffset - 1],
      ['length', indexOffset - 12],
      ['section', indexOffset - 13],
    ]) {
      const flipped = bytes.slice();
      flipped[at] = flipped[at] ^ 0xff;
      writeSeed('crbm-reader', `flip-v1_1-${where}-${name}.bin`, flipped);
    }
  }
}

/** Metadata records spanning the value types, the key and value shapes, and the 1 KiB cap. */
function metadataSets() {
  return {
    small: { def: 'v41' },
    mixed: {
      def: 'v41',
      landedAt: 1790000000000,
      ratio: -1.5,
      zero: 0,
      unicode: '\u65e5\u{1F600}',
    },
    escapes: { 'quote"key': 'line\nbreak\ttab\\', '\u0001': '\u001f' },
    cap: { k: 'x'.repeat(1024 - 8) },
  };
}

/** Where a 1.1 object's index starts, and its extension block's sections (the bytes before the block's trailer). */
function extensionOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexOffset = Number(view.getBigUint64(bytes.length - 104, true));
  const sectionsLength = view.getUint32(indexOffset - 12, true);
  return {
    indexOffset,
    sections: bytes.subarray(indexOffset - 12 - sectionsLength, indexOffset - 12),
  };
}

/**
 * Refuse to write a seed whose sections are not what the writer wrote: the parser must read `metadata` back from
 * them. A slip in `extensionOf` would otherwise leave a corpus of seeds that are not valid sections, and nothing
 * would say so.
 */
async function assertSectionsHold(sections, metadata, name) {
  const { parseExtension } = await import('./build/fuzz-core.js');
  const sorted = (m) => JSON.stringify(Object.fromEntries(Object.entries(m ?? {}).sort()));
  if (sorted(parseExtension(sections, undefined)) !== sorted(metadata)) {
    throw new Error(`seed ${name}: the sections cut from its object do not hold its metadata`);
  }
}

/** A format 1.1 `.crbm` holding three chunks and `metadata`, written by the `.crbm` writer from the fuzz build. */
async function validCrbmWithMetadata(metadata) {
  const { CrbmWriter, BufferSink } = await import('./build/fuzz-core.js');
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 5, metadata });
  for (const key of [0, 256, 65535]) {
    const payload = new RoaringBitmap32([1, 2, key + 3]).serialize(SerializationFormat.portable);
    await writer.addChunk(key, payload, 3);
  }
  await writer.finish();
  return sink.bytes();
}

/** A strided set: dense enough to be a large array container, never a run. See `dense-chunk` above. */
function stridedVals(lo, count, step) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(lo + i * step);
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

// ── crbm-ext target: raw extension-block sections fed straight to parseExtension (no CRC wall) ──
// Taken from real 1.1 objects, so a seed is exactly what the writer emits: one metadata section (u8 type 1, a u32
// length, the canonical JSON).
async function seedCrbmExt() {
  // A section of a type a later minor might add (u8 type 9, u32 length 1, one byte), which the parser skips.
  const later = Uint8Array.of(9, 1, 0, 0, 0, 0x78);
  for (const [name, metadata] of Object.entries(metadataSets())) {
    const { sections } = extensionOf(await validCrbmWithMetadata(metadata));
    await assertSectionsHold(sections, metadata, name);
    writeSeed('crbm-ext', `valid-${name}.bin`, sections);
    const withLater = new Uint8Array(sections.length + later.length);
    withLater.set(sections, 0);
    withLater.set(later, sections.length);
    writeSeed('crbm-ext', `later-section-${name}.bin`, withLater);
    writeSeed('crbm-ext', `trunc-${name}.bin`, sections.subarray(0, sections.length - 2));
  }
  writeSeed('crbm-ext', 'empty.bin', new Uint8Array(0));
}

async function main() {
  const only = process.argv[2];
  if (!only || only === 'safe-deserialize') seedSafeDeserialize();
  if (!only || only === 'crbm-reader') await seedCrbmReader();
  if (!only || only === 'crbm-index') seedCrbmIndex();
  if (!only || only === 'crbm-ext') await seedCrbmExt();
  const targets = only ? [only] : ['safe-deserialize', 'crbm-reader', 'crbm-index', 'crbm-ext'];
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
