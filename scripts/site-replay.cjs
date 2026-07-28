#!/usr/bin/env node
/**
 * Generates `site-final/assets/replay.json` — the data the /demo page replays.
 *
 * WHY THIS IS A GENERATOR AND NOT A HAND-WRITTEN FILE
 *
 * The demo's whole claim is that it replays a run that was actually measured. A hand-authored JSON would
 * make that claim unfalsifiable: nothing would stop a number drifting from the benchmark, and the page
 * would keep asserting "measured" either way. That is the failure this project keeps recording — an
 * observable that cannot distinguish the two cases.
 *
 * So every value below is either
 *   (a) read straight out of `bench/scale-results.json`, the benchmark's own output, or
 *   (b) DERIVED from the construction in `bench/scale.cjs`, which is deterministic —
 *
 * and the two are then cross-checked against each other. If the benchmark's reported totals stop matching
 * what its construction implies, this script FAILS rather than emitting a plausible file. That is the point:
 * the page cannot silently drift, because the drift breaks the build instead of the argument.
 *
 * THE CONSTRUCTION, from bench/scale.cjs::measureIntersect
 *
 *   Segment A: chunk keys [0, CHUNKS), DENSITY ids each.
 *   Segment B: for c in [0, CHUNKS), key = c < sharedChunks ? c : c + CHUNKS.
 *              So B is [0, sharedChunks) followed by [CHUNKS + sharedChunks, 2 * CHUNKS).
 *
 * Which gives, with no measurement needed:
 *   shared keys   = [0, sharedChunks)                      -> sharedChunks
 *   A-only keys   = [sharedChunks, CHUNKS)                  -> CHUNKS - sharedChunks
 *   B-only keys   = [CHUNKS + sharedChunks, 2 * CHUNKS)     -> CHUNKS - sharedChunks
 *   ids in common = sharedChunks * DENSITY   (B's shared prefix carries A's ids exactly)
 *
 * Usage: node scripts/site-replay.cjs [--check]
 *   --check verifies the committed file is what this script would emit, without rewriting it. CI uses this
 *   so a stale replay.json fails a gate instead of shipping.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'bench', 'scale-results.json');
const TARGET = path.join(ROOT, 'site-final', 'assets', 'replay.json');

function fail(msg) {
  console.error(`site-replay: ${msg}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const m = raw.intersect;
if (!m) fail(`no \`intersect\` block in ${path.relative(ROOT, SOURCE)}`);

const need = [
  'chunksPerSegment',
  'idsPerSegment',
  'sharedChunks',
  'intersectMs',
  'resultCount',
  'fetchedChunks',
  'skippedChunks',
  'coldBytesRead',
];
for (const k of need) {
  if (typeof m[k] !== 'number') fail(`\`intersect.${k}\` missing or not a number`);
}

/**
 * The page also states figures that belong to the FORMAT rather than to this run — the size of the chunk key
 * space, and where an array container stops being smaller than a bitset. Those are read or derived here for
 * the same reason the benchmark numbers are: so nothing on the page is a figure with no stated origin.
 *
 * CHUNK_COUNT is parsed out of the source rather than restated, because a constant copied into a second file
 * is a constant that can disagree with the first.
 */
function formatConstants() {
  const src = fs.readFileSync(
    path.join(ROOT, 'packages', 'core', 'src', 'core', 'bit-route.ts'),
    'utf8',
  );
  const found = /export const CHUNK_COUNT = (0x[0-9a-f_]+|\d+)/i.exec(src);
  if (!found)
    fail('CHUNK_COUNT is no longer declared where this script looks for it (core/bit-route.ts)');
  const chunkCount = Number(found[1].replace(/_/g, ''));
  if (chunkCount !== 65536)
    fail(`CHUNK_COUNT is ${chunkCount}; the /demo copy assumes a 16-bit split`);
  // A bitset container is one bit per possible remainder. An array is two bytes per id present. The two costs
  // cross where `ids * 2 === bitsetBytes` — arithmetic, not a claim about any codec's source.
  const bitsetBytes = chunkCount / 8;
  const arrayCrossoverIds = bitsetBytes / 2;
  return { chunkCount, bitsetBytes, arrayCrossoverIds };
}
const fc = formatConstants();

const chunks = m.chunksPerSegment;
const shared = m.sharedChunks;
// Not read from the file: the benchmark records ids-per-segment, and density follows from it. Deriving it
// rather than trusting a second recorded field means a change to either one is caught below.
const density = m.idsPerSegment / chunks;
if (!Number.isInteger(density))
  fail(`idsPerSegment / chunksPerSegment is not an integer (${density})`);

// ── the cross-checks. Each one compares a MEASURED total against what the construction implies. ───────────
const checks = [
  ['fetchedChunks', m.fetchedChunks, shared, 'only the aligned keys may be fetched'],
  [
    'skippedChunks',
    m.skippedChunks,
    2 * (chunks - shared),
    'every non-aligned key in either segment is skipped',
  ],
  ['resultCount', m.resultCount, shared * density, "B's shared prefix carries A's ids exactly"],
];
for (const [name, measured, derived, why] of checks) {
  if (measured !== derived) {
    fail(
      `${name}: benchmark reports ${measured}, construction implies ${derived} (${why}).\n` +
        `  The benchmark and this generator disagree. Do not "fix" this by editing the expected value —\n` +
        `  one of the two is wrong, and the /demo page must not claim to replay a run it cannot explain.`,
    );
  }
}

if (m.coldBytesRead % shared !== 0) {
  fail(`coldBytesRead (${m.coldBytesRead}) is not divisible by the ${shared} fetched chunks`);
}
const bytesPerChunk = m.coldBytesRead / shared;

// ── key-space geometry, entirely derived ──────────────────────────────────────────────────────────────────
const axisKeys = 2 * chunks; // A occupies the low half, B's disjoint tail the high half
const bands = {
  shared: { from: 0, to: shared },
  aOnly: { from: shared, to: chunks },
  // The gap [chunks, chunks + shared) belongs to neither segment: B's tail is offset by CHUNKS from an index
  // that already starts at `shared`, so those keys are simply never touched. Stating it keeps the axis
  // honest — a reader counting cells would otherwise find `shared` of them unaccounted for.
  untouched: { from: chunks, to: chunks + shared },
  bOnly: { from: chunks + shared, to: axisKeys },
};

const out = {
  note:
    'GENERATED by scripts/site-replay.cjs from bench/scale-results.json. Do not edit by hand — ' +
    '`node scripts/site-replay.cjs --check` fails if this file drifts from the benchmark.',
  source: 'bench/scale-results.json',
  sourceScript: 'bench/scale.cjs::measureIntersect',
  // Split deliberately: a reader (and a reviewer) can see which numbers were observed and which follow from
  // the construction. The page labels them the same way.
  measured: {
    chunksPerSegment: chunks,
    idsPerSegment: m.idsPerSegment,
    sharedChunks: shared,
    fetchedChunks: m.fetchedChunks,
    skippedChunks: m.skippedChunks,
    coldBytesRead: m.coldBytesRead,
    intersectMs: m.intersectMs,
    resultCount: m.resultCount,
  },
  format: {
    note: 'From the format, not from this run. CHUNK_COUNT is read out of core/bit-route.ts.',
    chunkCount: fc.chunkCount,
    bitsetBytesPerChunk: fc.bitsetBytes,
    arrayCrossoverIds: fc.arrayCrossoverIds,
  },
  derived: {
    density,
    bytesPerFetchedChunk: bytesPerChunk,
    axisKeys,
    bands,
    fetchedFraction: shared / chunks,
    skippedFraction: (chunks - shared) / chunks,
  },
  // The four beats the page steps through. Text lives here so the page cannot state a number the generator
  // did not put in front of it.
  beats: [
    {
      id: 'segments',
      label: 'Two segments',
      headline: `${m.idsPerSegment.toLocaleString()} ids each, ${chunks.toLocaleString()} chunk keys each`,
      body:
        `Each segment holds ${m.idsPerSegment.toLocaleString()} ids spread over ${chunks.toLocaleString()} ` +
        `chunk keys, ${density.toLocaleString()} ids per key. Nothing has been read yet.`,
    },
    {
      id: 'compare',
      label: 'Compare keys',
      headline: `${shared} of ${chunks.toLocaleString()} keys align`,
      body:
        `Keys are compared before any bytes move. ${shared} appear in both segments; ` +
        `${(chunks - shared).toLocaleString()} in each segment appear in only one. Still zero bytes read.`,
    },
    {
      id: 'fetch',
      label: 'Fetch',
      headline: `${m.coldBytesRead.toLocaleString()} bytes, ${shared} chunks`,
      body:
        `Only the ${shared} aligned chunks are requested — ${bytesPerChunk.toLocaleString()} bytes each. ` +
        `The other ${m.skippedChunks.toLocaleString()} chunk reads never happen, and are never billed.`,
    },
    {
      id: 'result',
      label: 'Result',
      headline: `${m.resultCount.toLocaleString()} ids in ${m.intersectMs} ms`,
      body:
        `${shared} shared keys times ${density.toLocaleString()} ids per key is ` +
        `${m.resultCount.toLocaleString()} ids — which is what the run reported.`,
    },
  ],
};

const text = JSON.stringify(out, null, 2) + '\n';

/**
 * The page is deliberately STATIC — every number is in demo.html's markup, and the data attributes the
 * stepper reads are there too. That is what lets /demo work with no JavaScript, no network and from
 * `file://`. The cost is a second place a number can live, so the check covers it: if the page and the
 * benchmark disagree, the gate fails rather than the argument.
 */
function checkPage() {
  const PAGE = path.join(ROOT, 'site-final', 'demo.html');
  let html;
  try {
    html = fs.readFileSync(PAGE, 'utf8');
  } catch {
    return [`${path.relative(ROOT, PAGE)} is missing`];
  }
  const problems = [];
  // Rendered form, as a reader sees it — a page that says 403200 where the benchmark says 403,200 is still
  // consistent, but a page that says 41,208 where the benchmark says 100,000 is exactly what this catches.
  const grouped = (n) => n.toLocaleString('en-US');
  const mustAppear = [
    ['chunksPerSegment', grouped(chunks)],
    ['idsPerSegment', grouped(m.idsPerSegment)],
    ['skippedChunks', grouped(m.skippedChunks)],
    ['coldBytesRead', grouped(m.coldBytesRead)],
    ['resultCount', grouped(m.resultCount)],
    ['intersectMs', String(m.intersectMs)],
    ['bytesPerFetchedChunk', grouped(bytesPerChunk)],
    ['density', grouped(density)],
  ];
  for (const [name, text] of mustAppear) {
    if (!html.includes(text)) {
      problems.push(`demo.html never states ${name} (${text})`);
    }
  }

  // Presence alone is NOT enough, and finding that out is the reason this block exists. A check that only
  // asserts "each right number appears somewhere" cannot see a WRONG number being added: swapping one
  // instance of 100,000 for 41,208 left the other instances intact and the check passed. That is the same
  // shape of hole this project keeps writing down — an observable that cannot distinguish the two cases.
  //
  // So the page's grouped numbers are also checked the other way round: every thousands-separated figure in
  // the visible text must be one the benchmark can account for. Ungrouped integers are not policed — 100, 99
  // and 80 are too ordinary to be evidence of anything.
  const allowed = new Set(
    [
      m.idsPerSegment,
      chunks,
      chunks - shared,
      chunks - 1, // A's last key, as a range endpoint
      chunks + shared, // B's first key
      axisKeys,
      axisKeys - 1, // B's last key
      density,
      bytesPerChunk,
      m.coldBytesRead,
      m.skippedChunks,
      m.resultCount,
      // format constants, sourced above rather than allow-listed
      fc.chunkCount,
      fc.arrayCrossoverIds,
    ].map((n) => n.toLocaleString('en-US')),
  );
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ');
  const stated = new Set(visible.match(/\d{1,3}(?:,\d{3})+/g) || []);
  for (const n of stated) {
    if (!allowed.has(n)) {
      problems.push(
        `demo.html states ${n}, which the benchmark cannot account for ` +
          `(allowed: ${[...allowed].join(', ')})`,
      );
    }
  }
  // The stepper reads geometry from data attributes; if those drift the figure lies while the prose is fine.
  const attrs = [
    ['data-axis', axisKeys],
    ['data-shared-to', shared],
    ['data-a-to', chunks],
    ['data-b-from', chunks + shared],
    ['data-shared', shared],
    ['data-skipped', m.skippedChunks],
    ['data-bytes', m.coldBytesRead],
    ['data-ids', m.resultCount],
    ['data-bytes-per-chunk', bytesPerChunk],
    ['data-density', density],
  ];
  for (const [attr, want] of attrs) {
    const found = new RegExp(`${attr}="([^"]*)"`).exec(html);
    if (!found) problems.push(`demo.html is missing ${attr}`);
    else if (Number(found[1]) !== want) {
      problems.push(`demo.html ${attr}="${found[1]}" but the benchmark implies ${want}`);
    }
  }
  // The inset's 40 cells are hand-written markup so the figure survives with no JavaScript. That means their
  // shared/A-only split is a second statement of the boundary, and a second statement is a second thing that
  // can be wrong — so it is checked against the same `sharedChunks` everything else derives from.
  const cellRe = /<i class="icell (is-shared|is-a)" data-key="(\d+)"><\/i>/g;
  const cellsFound = [...html.matchAll(cellRe)].map((x) => ({ kind: x[1], key: Number(x[2]) }));
  if (cellsFound.length === 0) {
    problems.push('demo.html has no inset cells — the no-JavaScript figure would be empty');
  } else {
    for (const c of cellsFound) {
      const want = c.key < shared ? 'is-shared' : 'is-a';
      if (c.kind !== want) {
        problems.push(
          `demo.html inset key ${c.key} is marked ${c.kind}, but the shared prefix ends at ${shared}`,
        );
      }
    }
    const keys = cellsFound.map((c) => c.key);
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] !== keys[i - 1] + 1) {
        problems.push(`demo.html inset keys jump from ${keys[i - 1]} to ${keys[i]}`);
      }
    }
    if (!keys.some((k) => k < shared) || !keys.some((k) => k >= shared)) {
      problems.push(
        `demo.html inset does not straddle the boundary at ${shared}, so it demonstrates nothing`,
      );
    }
  }

  return problems;
}

if (process.argv.includes('--check')) {
  let have;
  try {
    have = fs.readFileSync(TARGET, 'utf8');
  } catch {
    fail(`${path.relative(ROOT, TARGET)} is missing. Run: node scripts/site-replay.cjs`);
  }
  if (have !== text) {
    fail(
      `${path.relative(ROOT, TARGET)} is stale — it no longer matches bench/scale-results.json.\n` +
        `  Run: node scripts/site-replay.cjs`,
    );
  }
  const pageProblems = checkPage();
  if (pageProblems.length) {
    fail(`site-final/demo.html disagrees with the benchmark:\n  - ${pageProblems.join('\n  - ')}`);
  }
  console.log('site-replay: replay.json and demo.html are current.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, text);
console.log(`site-replay: wrote ${path.relative(ROOT, TARGET)}`);
console.log(
  `  ${shared}/${chunks} keys aligned · ${m.coldBytesRead.toLocaleString()} bytes read · ` +
    `${m.resultCount.toLocaleString()} ids · ${m.intersectMs} ms`,
);
