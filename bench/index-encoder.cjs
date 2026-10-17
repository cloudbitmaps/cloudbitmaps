/*
 * Index-encoder probe: what the writer's chunk-index encoding holds while it runs, before and after it wrote into one
 * buffer. The measured evidence behind the figures in `docs/benchmarks.md#what-a-sorted-load-holds-in-memory`.
 *
 * WHAT IS MEASURED
 *
 * The writer keeps one entry per chunk (key, offset, length, cardinality, crc32c) and encodes them all at the footer.
 * `old` replays the encoding as it was: push every byte to a plain array of numbers, then copy it with
 * `Uint8Array.from`. `new` replays it as it is now: size the index exactly, then write it once into one buffer. Both
 * run over entries held live, as the writer holds them, and each is read in its own fresh process.
 *
 * Reported per run, in MiB over the entries: the retained size at the end of the encoding (the array, for `old`; the
 * index buffer, for `new`), and the size at the peak (for `old`, the array and the copy together). Each reading is
 * taken after repeated synchronous major collections, so it is a sample after collection, never a high-water mark.
 *
 * THE ENTRIES
 *
 * `load` (the default) is the shape of the sorted-load heap test's ids spread over every chunk: consecutive chunk
 * keys, no gap between payloads, payloads of 138 to 140 bytes and 61 to 62 ids in each chunk, which is 4,000,000 ids
 * over 65,536 chunks. Its index is 9 bytes a chunk. `wide` is a synthetic shape with payloads of 64 to 60,063 bytes
 * (larger than a roaring chunk makes) and cardinalities of 1 to 65,536, so most length varints take 3 bytes; its
 * index is 11.5 bytes a chunk. Every entry's fields are read once before the baseline, so the baseline already holds
 * the shapes V8 settles an object into on its first full read.
 *
 * HOW TO RUN
 *
 *   node bench/index-encoder.cjs [--shape load|wide] [chunks ...]      (default: 8192 65536)
 *
 * It prints a table; nothing is written. It needs no build, and it starts its own `--expose-gc` child processes.
 */
'use strict';

const { spawnSync } = require('node:child_process');

const MIB = 1024 * 1024;

function entriesOf(shape, n) {
  const entries = [];
  let offset = 8;
  for (let i = 0; i < n; i++) {
    const length =
      shape === 'wide' ? 64 + ((Math.imul(i, 2654435761) >>> 0) % 60000) : 138 + (i % 3);
    const cardinality = shape === 'wide' ? 1 + ((Math.imul(i, 40503) >>> 0) % 65536) : 61 + (i & 1);
    entries.push({
      chunkKey: i,
      offset,
      length,
      cardinality,
      crc32c: Math.imul(i + 1, 2246822519) >>> 0,
    });
    offset += length;
  }
  return entries;
}

function varintLength(v) {
  if (v < 0x80) return 1;
  if (v < 0x4000) return 2;
  if (v < 0x20_0000) return 3;
  if (v < 0x1000_0000) return 4;
  return 5;
}

function pushVarint(out, value) {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function putVarint(out, pos, value) {
  let v = value;
  let at = pos;
  while (v > 0x7f) {
    out[at++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  out[at++] = v;
  return at;
}

function encodeOld(entries) {
  const out = [];
  let prevKey = 0;
  let prevEnd = 8;
  for (const e of entries) {
    pushVarint(out, e.chunkKey - prevKey);
    pushVarint(out, e.offset - prevEnd);
    pushVarint(out, e.length);
    pushVarint(out, e.cardinality);
    out.push(e.crc32c & 0xff, (e.crc32c >>> 8) & 0xff, (e.crc32c >>> 16) & 0xff, e.crc32c >>> 24);
    prevKey = e.chunkKey;
    prevEnd = e.offset + e.length;
  }
  return out;
}

function encodeNew(entries) {
  let size = 0;
  let prevKey = 0;
  let prevEnd = 8;
  for (const e of entries) {
    size +=
      varintLength(e.chunkKey - prevKey) +
      varintLength(e.offset - prevEnd) +
      varintLength(e.length) +
      varintLength(e.cardinality) +
      4;
    prevKey = e.chunkKey;
    prevEnd = e.offset + e.length;
  }
  const out = new Uint8Array(size);
  let pos = 0;
  prevKey = 0;
  prevEnd = 8;
  for (const e of entries) {
    pos = putVarint(out, pos, e.chunkKey - prevKey);
    pos = putVarint(out, pos, e.offset - prevEnd);
    pos = putVarint(out, pos, e.length);
    pos = putVarint(out, pos, e.cardinality);
    out[pos++] = e.crc32c & 0xff;
    out[pos++] = (e.crc32c >>> 8) & 0xff;
    out[pos++] = (e.crc32c >>> 16) & 0xff;
    out[pos++] = e.crc32c >>> 24;
    prevKey = e.chunkKey;
    prevEnd = e.offset + e.length;
  }
  if (pos !== size) throw new Error('sizing and encoding disagree');
  return out;
}

/** Heap and array buffers after collections that run until the figure stops falling. */
function settled() {
  let last = Infinity;
  for (let i = 0; i < 12; i++) {
    globalThis.gc({ type: 'major', execution: 'sync' });
    const m = process.memoryUsage();
    const total = m.heapUsed + m.arrayBuffers;
    if (total >= last - 1024) return total;
    last = total;
  }
  return last;
}

function child(shape, mode, n) {
  const entries = entriesOf(shape, n);
  // Read every field of every entry, and warm both encoders, before the baseline.
  let sink = 0;
  for (const e of entries) sink += e.chunkKey + e.offset + e.length + e.cardinality + e.crc32c;
  const warm = entries.slice(0, 3000);
  for (let w = 0; w < 40; w++) {
    encodeNew(warm);
    Uint8Array.from(encodeOld(warm));
  }
  settled();
  settled();
  const base = settled();
  let atEnd;
  let atPeak;
  let indexBytes;
  if (mode === 'old') {
    const array = encodeOld(entries);
    atEnd = settled() - base;
    const copy = Uint8Array.from(array);
    atPeak = settled() - base;
    indexBytes = copy.length;
    if (array.length !== copy.length) throw new Error('unreachable');
  } else {
    const index = encodeNew(entries);
    atEnd = atPeak = settled() - base;
    indexBytes = index.length;
  }
  if (entries.length !== n || sink < 0) throw new Error('unreachable');
  process.stdout.write(JSON.stringify({ atEnd, atPeak, indexBytes }));
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--child') {
    child(args[1], args[2], Number(args[3]));
    return;
  }
  let shape = 'load';
  const sizes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shape') shape = args[++i];
    else sizes.push(Number(args[i]));
  }
  if (shape !== 'load' && shape !== 'wide') throw new Error(`unknown shape ${shape}`);
  if (sizes.length === 0) sizes.push(8192, 65536);
  const fmt = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;
  console.log(`shape: ${shape}; MiB over the entries, after collection`);
  console.log('chunks | index bytes | old: end of encoding | old: with the copy | new');
  for (const n of sizes) {
    const run = (mode) => {
      const r = spawnSync(
        process.execPath,
        ['--expose-gc', __filename, '--child', shape, mode, String(n)],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(r.stderr || `child exited ${r.status}`);
      return JSON.parse(r.stdout);
    };
    const before = run('old');
    const after = run('new');
    console.log(
      `${n} | ${after.indexBytes} (${fmt(after.indexBytes)}) | ${fmt(before.atEnd)} | ${fmt(before.atPeak)} | ${fmt(after.atEnd)}`,
    );
  }
}

main();
