'use strict';
/*
 * The requests the engine makes of the object store for a cold intersect and a cold andNot, by the size of a deployment's
 * chunks and by how much two segments share and where, counted by running the real engine over the in-memory backend
 * (`bench/lib/range-counts.cjs`) and written to `bench/range-counts.json`, which the cost model (`bench/sizing.cjs`)
 * reads.
 *
 * Nothing here is measured on a cloud. These are the counts the code makes, from the layouts listed below; the cost
 * figures built from them are labelled expected. A calibration run on a real object store is what measures them, and the
 * calibration harness is held to the same counts (`bench/lib/calibrate-stages.cjs`).
 *
 * The layouts are the sizing model's own: a segment of 2,000 chunks, and the chunk sizes of its small, medium and large
 * deployments (a segment's bytes spread over its chunks), two segments sharing 100, 1,000 or all 2,000 of them, the shared
 * chunks packed first in each object (the calibration run's layout) or spread over it (the worst for a coalescing reader,
 * which then reads most of the object).
 *
 * Run: `pnpm build && node bench/range-counts.cjs` to rewrite the file; `--check` (what `pnpm bench:range-counts:check`
 * runs) counts the cases again and fails if the committed file is not what the engine makes. It takes about a minute.
 */
const fs = require('node:fs');
const path = require('node:path');
const { coldIntersect, coldAndNot, sharedLayout, run } = require('./lib/range-counts.cjs');

const FILE = path.join(__dirname, 'range-counts.json');
const CHUNKS = 2_000;
/** Each deployment's segment bytes, from `bench/sizing.cjs`'s profiles; the index and footer take about 20 KB. */
const PROFILES = [
  { id: 'small', segmentBytes: 1_000_000 },
  { id: 'medium', segmentBytes: 4_000_000 },
  { id: 'large', segmentBytes: 10_000_000 },
];
const INDEX_AND_FOOTER_BYTES = 20_000 + 112;
/** An array container is 2 bytes an id and a 16-byte header; so many ids make a chunk of the profile's size. */
const idsPerChunk = (segmentBytes) =>
  Math.round(((segmentBytes - INDEX_AND_FOOTER_BYTES) / CHUNKS - 16) / 2);
const SHARED = [100, 1_000, 2_000];
const LAYOUTS = ['packed', 'spread'];

async function count() {
  const profiles = {};
  for (const p of PROFILES) {
    const ipc = idsPerChunk(p.segmentBytes);
    const cases = [];
    let chunkBytes = null;
    for (const k of SHARED) {
      for (const layout of LAYOUTS) {
        const { keysA, keysB } = sharedLayout(CHUNKS, k, layout);
        const c = await coldIntersect(keysA, keysB, ipc);
        if (k === CHUNKS && layout === 'packed') chunkBytes = c.rangeBytes / 2 / CHUNKS;
        cases.push({
          shared: k,
          layout,
          rangesPerOperand: c.rangesPerOperand,
          rangeBytesPerOperand: c.rangeBytes / 2,
        });
      }
    }
    profiles[p.id] = {
      segmentBytes: p.segmentBytes,
      idsPerChunk: ipc,
      chunkBytes: Math.round(chunkBytes),
      coldIntersect: cases,
    };
  }
  // The calibration run's andNot: a segment of 1,999 chunks against ten that share 100 of them, packed first.
  const ipc = idsPerChunk(PROFILES[0].segmentBytes);
  const include = run(0, 1_999);
  const excludes = Array.from({ length: 10 }, (_, i) => [
    ...run(0, 100),
    ...run(10_000 + i * 1_900, 1_899),
  ]);
  const a = await coldAndNot(include, excludes, ipc);
  return {
    note: 'Counted by running the engine over the in-memory backend; not measured on a cloud. Rewritten by bench/range-counts.cjs.',
    chunksPerSegment: CHUNKS,
    profiles,
    andNot: {
      profile: 'small',
      includeChunks: include.length,
      excludes: excludes.length,
      sharedChunks: 100,
      getRange: a.getRange,
      getTail: a.getTail,
      pointer: a.pointer,
    },
  };
}

(async () => {
  const counted = await count();
  const text = JSON.stringify(counted, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const onDisk = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
    if (onDisk !== text) {
      console.error(
        'range-counts: bench/range-counts.json is not what the engine makes; run `node bench/range-counts.cjs`',
      );
      process.exit(1);
    }
    console.log('range-counts: bench/range-counts.json is what the engine makes');
    return;
  }
  fs.writeFileSync(FILE, text);
  console.log(`range-counts: wrote ${FILE}`);
})();
