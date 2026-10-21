/*
 * The data sets of the engine bench (`bench/ts-codec-engine.cjs`): deterministic ids of the shapes the comparison
 * times, from a seeded generator, so every process and every run builds the same bytes. Pure.
 *
 * A data set is a number of chunks of one kind: `dense` (a bitset in every chunk), `sparse` (arrays), `runs`, `mixed`
 * (the three kinds in turn), `spread` (16 ids in chunks drawn from the whole key space: a million ids over 62,500
 * chunks, the largest load the comparison times) and `spread8k` (the same shape; a separate name so a scale can give it fewer chunks).
 */
'use strict';

/** A seeded generator of fractions in [0, 1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` distinct values below 65,536, ascending. */
function randomLows(next, count) {
  const seen = new Set();
  while (seen.size < count) seen.add(Math.floor(next() * 65536));
  return Array.from(seen).sort((x, y) => x - y);
}

/** The lows of one chunk made of runs 100 to 300 long. */
function runLows(next) {
  const out = [];
  let at = Math.floor(next() * 50);
  for (let r = 0; r < 150 && at <= 65535; r++) {
    const len = 100 + Math.floor(next() * 201);
    for (let k = 0; k < len && at + k < 65536; k++) out.push(at + k);
    at += len + 50 + Math.floor(next() * 150);
  }
  return out;
}

/** The lows of one chunk of the given kind. */
function lowsOf(kind, next) {
  if (kind === 'dense') return randomLows(next, 32768);
  if (kind === 'sparse') return randomLows(next, 1000);
  if (kind === 'spread') return randomLows(next, 16);
  return runLows(next);
}

/**
 * The ids of segment `which` (0 to 3) of a data set: the same chunk keys in every segment, different ids in each.
 * `scale` maps a data set's name to its number of chunks.
 */
function idsOf(dataset, which, scale) {
  const chunks = scale[dataset];
  if (!Number.isInteger(chunks) || chunks < 1)
    throw new Error(`no chunk count for the data set ${JSON.stringify(dataset)}`);
  const keys = [];
  if (dataset.startsWith('spread')) {
    const pick = prng(7);
    const all = Array.from({ length: 65536 }, (_, i) => i);
    for (let i = 0; i < chunks; i++) {
      const j = i + Math.floor(pick() * (65536 - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    keys.push(...all.slice(0, chunks).sort((x, y) => x - y));
  } else {
    for (let i = 0; i < chunks; i++) keys.push(i * 3);
  }
  const kinds = ['dense', 'sparse', 'runs'];
  const ids = [];
  keys.forEach((key, i) => {
    const kind =
      dataset === 'mixed' ? kinds[(i + which) % 3] : dataset.replace('spread8k', 'spread');
    const next = prng(1000 * (which + 1) + i + 1);
    for (const low of lowsOf(kind, next)) ids.push(key * 65536 + low);
  });
  return ids;
}

module.exports = { prng, randomLows, runLows, lowsOf, idsOf };
