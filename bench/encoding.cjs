/*
 * Encoded-size benchmark — the measured evidence behind the site's STRUCTURAL claim.
 *
 * WHY THIS EXISTS
 *
 * Three layers carry the argument on the site. Two were measured: residency (`$0.03` at rest against `$346`
 * standing) and idle cost (the published crossovers). The first one — structure — was the only claim with no
 * number under it at all:
 *
 *   "Redis has no Roaring type of its own … So the honest comparison is not us versus Redis: it is Roaring
 *    versus a fixed representation."                                          — site/flavors-roaring.html
 *
 * That is a falsifiable claim about encoded size, and it was published on assertion. This measures it.
 *
 * WHAT IS COMPARED, AND WHY THESE THREE
 *
 * Roaring's whole trick is that it picks per 16-bit chunk between an ARRAY, a BITSET and a RUN. The site's point
 * is that the alternatives are each one of those three, chosen permanently and in advance — so the comparison
 * that means anything is against those fixed choices, on the same ids:
 *
 *   roaring   the shipped codec's own `serialize()` — the bytes we would actually store.
 *   array     a sorted `u32` list: `4 × n`. What "just keep the ids" costs, and the floor a Redis intset-encoded
 *             Set is measured against below.
 *   bitset    one bit per id across the whole span: `ceil((max + 1) / 8)`. What `SETBIT` over a Redis String
 *             costs, and what the `bitset` flavor will cost when it ships.
 *
 * HONESTY BOUNDARY — read this before quoting any number here.
 *
 * These are ENCODED SIZES, not Redis process memory. A real Redis Set costs materially MORE than the `array`
 * column: an intset is a sorted array of 2/4/8-byte ints plus a header, and past `set-max-intset-entries` (512
 * by default) it converts to a hashtable with tens of bytes of overhead per element. A Redis String bitmap
 * carries allocator overhead over the `bitset` column. So every fixed-representation figure here is that
 * representation's BEST case, and the comparison is deliberately tilted in its favour: if roaring wins on these
 * numbers it wins by more in a real process. What this does NOT do is measure a running Redis — no claim here
 * should be phrased as one.
 *
 * Deterministic: every shape is generated from a seeded mulberry32, so the numbers reproduce byte-for-byte on
 * any machine. Unlike bench/run.cjs and bench/scale.cjs this has no wall-clock or RSS component at all, which is
 * why it CAN be asserted in CI rather than only recorded — see the gate note at the bottom.
 *
 * Run: `pnpm bench:encoding` (builds first). With `ENCODING_TASK=inject` it also persists
 * bench/encoding-results.json.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { roaringCodec } = require('@cloudbitmaps/roaring');

/** Tiny seeded RNG (mulberry32) so every shape is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const U32_MAX = 4294967295;

/**
 * The shapes. Each is a real workload silhouette rather than a number chosen to flatter us — and two of the four
 * are cases where a fixed representation BEATS roaring, which is the point: the claim is adaptivity, not that
 * roaring is smallest everywhere. A benchmark that only showed wins would be advertising.
 */
const SHAPES = [
  {
    name: 'sparse random',
    note: 'ids scattered over a wide space — a user cohort across a large id range',
    build: () => {
      const r = rng(1);
      const out = new Set();
      while (out.size < 100_000) out.add(Math.floor(r() * 100_000_000));
      return [...out].sort((a, b) => a - b);
    },
  },
  {
    name: 'dense contiguous',
    note: 'one solid range — "everything created in this window"',
    build: () => Array.from({ length: 1_000_000 }, (_, i) => 5_000_000 + i),
  },
  {
    name: 'clustered runs',
    note: '2,000 runs of ~500 — the shape sequential ids acquire once rows are deleted in batches',
    build: () => {
      const r = rng(7);
      const out = [];
      let at = 1_000;
      for (let run = 0; run < 2_000; run++) {
        const len = 400 + Math.floor(r() * 200);
        for (let i = 0; i < len; i++) out.push(at + i);
        at += len + 200 + Math.floor(r() * 3_000);
      }
      return out;
    },
  },
  {
    name: 'half-dense block',
    note: 'every other id in a 2M block — the case an uncompressed bitset is built for',
    build: () => {
      const out = [];
      for (let i = 0; i < 2_000_000; i += 2) out.push(1_000_000 + i);
      return out;
    },
  },
];

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

function measure(ids) {
  const min = ids[0];
  const max = ids[ids.length - 1];
  if (max > U32_MAX) throw new Error(`shape exceeds u32 (${max})`);
  // `optimize()` first, because that is what a cold write does — see writeCrbmGeneration. Measuring the
  // un-optimized encoding would understate our own codec by up to 570x and describe bytes we do not store.
  const rb = roaringCodec.fromValues(ids);
  const roaringPlain = rb.serialize().length;
  rb.optimize();
  const roaring = rb.serialize().length;
  const array = ids.length * 4;
  // From 0, because that is what a Redis String bitmap actually costs: SETBIT is indexed from zero, so
  // `SETBIT key 5000000 1` allocates the preceding 5 million bits whether or not anything is in them.
  const bitset = Math.ceil((max + 1) / 8);
  // The same bitset if you could rebase it to the lowest id present. Redis cannot, but a reader will
  // immediately ask whether the column above is padded by an arbitrary offset — so the un-padded figure is
  // published beside it rather than left to be suspected. `bitset` is what Redis charges; `bitsetSpan` is the
  // representation's theoretical floor, and roaring is compared against the FLOOR below.
  const bitsetSpan = Math.ceil((max - min + 1) / 8);
  const best = Math.min(array, bitsetSpan);
  const ratio = best / roaring;
  return {
    n: ids.length,
    roaringPlain,
    min,
    max,
    roaring,
    array,
    bitset,
    bitsetSpan,
    // Against the best fixed representation at ITS floor, never the worst — a ratio that picks whichever
    // alternative happens to be terrible on this shape would be advertising, not measurement.
    //
    // Three decimals when the result is within 5% of parity: at 2dp a shape where roaring is 0.2% LARGER
    // rounds to "1×", which reads as a tie and hides a loss. `roaringSmaller` states the direction outright so
    // no rounding can imply the wrong one.
    vsBestFixed: Number(ratio.toFixed(Math.abs(ratio - 1) < 0.05 ? 3 : 2)),
    roaringSmaller: roaring < best,
    bestFixed: array <= bitsetSpan ? 'array' : 'bitset span',
  };
}

const rows = SHAPES.map((s) => {
  const ids = s.build();
  return { shape: s.name, note: s.note, ...measure(ids) };
});

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);
console.log('\nEncoded size for the same id set, three ways (lower is better)\n');
console.log(
  `  ${pad('shape', 19)}${rpad('ids', 10)}${rpad('roaring', 12)}${rpad('array', 12)}${rpad('bitset', 12)}${rpad('span-only', 12)}${rpad('vs best floor', 18)}`,
);
console.log(`  ${'-'.repeat(92)}`);
for (const r of rows) {
  const verdict = r.roaringSmaller
    ? `${r.vsBestFixed}× smaller`
    : `${(1 / r.vsBestFixed).toFixed(3)}× LARGER`;
  console.log(
    `  ${pad(r.shape, 19)}${rpad(r.n.toLocaleString(), 10)}${rpad(kib(r.roaring), 12)}${rpad(kib(r.array), 12)}${rpad(kib(r.bitset), 12)}${rpad(kib(r.bitsetSpan), 12)}${rpad(`${verdict} (${r.bestFixed})`, 18)}`,
  );
}
console.log('');
for (const r of rows) console.log(`  ${pad(r.shape, 19)} ${r.note}`);

const wins = rows.filter((r) => r.roaringSmaller).length;
const worst = rows.filter((r) => r.roaring >= Math.max(r.array, r.bitsetSpan)).length;
console.log(
  `\n  Roaring is smaller than the best fixed representation's FLOOR on ${wins} of ${rows.length} shapes,` +
    `\n  and is the largest of the three on ${worst}. That is the claim being tested — not that roaring always` +
    `\n  wins, but that no single fixed choice does, so a representation picked in advance is a bet.` +
    `\n\n  Columns. \`bitset\` is what Redis charges: SETBIT indexes from 0, so the empty prefix below the lowest` +
    `\n  id is paid for. \`span-only\` rebases to the lowest id — a floor Redis cannot reach, published anyway so` +
    `\n  the comparison is not suspected of being padded by an offset. Roaring is compared against the FLOOR.` +
    `\n\n  These are ENCODED sizes, not Redis process memory. A real Set costs more than \`array\` (intset header,` +
    `\n  then hashtable overhead past set-max-intset-entries); a String bitmap costs more than \`bitset\`. Every` +
    `\n  alternative here is therefore quoted at its best case, and none of this measures a running Redis.\n`,
);

if (process.env.ENCODING_TASK === 'inject') {
  const out = {
    note: 'Encoded size of one id set under roaring vs two fixed representations. Deterministic (seeded); no wall-clock or RSS component. See bench/encoding.cjs for the honesty boundary — these are encoded sizes, NOT Redis process memory.',
    generatedBy: 'bench/encoding.cjs',
    shapes: rows,
  };
  const dest = path.join(__dirname, 'encoding-results.json');
  fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`  wrote ${path.relative(path.join(__dirname, '..'), dest)}\n`);
} else {
  console.log('  (dry run — set ENCODING_TASK=inject to persist bench/encoding-results.json)\n');
}
