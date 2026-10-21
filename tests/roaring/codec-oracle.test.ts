import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError } from '@cloudbitmaps/core';
import type { CodecBitmap, CodecInterface } from '@cloudbitmaps/core';
import { BufferReader } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { checkPortableLayout } from '@/portable/layout';
import {
  CODECS,
  buildSet,
  chunksOf,
  crOf,
  crPlainBytes,
  crStoredBytes,
  describeDifference,
  firstDifference,
  oneChunk,
  plainRuleBytes,
  prng,
  relatedTo,
  ruleBytes,
  scrambled,
  setSpec,
  type ChunkShape,
  type SetSpec,
} from '../helpers/roaring-oracle';
import { heavy } from '../helpers/strength';

/**
 * The differential oracle: every codec behind `CodecInterface` is held to CRoaring (the pinned `roaring` package) and
 * to the stored-byte rule written from `docs/format.md` section 3 (`ruleBytes`, in the helper).
 *
 * WHY. The bytes a codec stores are the contract: a generation written by one codec must be one every other reads, and
 * one written twice from the same ids must be the same object. So each case asserts, for every codec in `CODECS`:
 *
 *   - stored bytes: `fromValues`, then `optimize()`, then `serialize()` are byte-identical to CRoaring's canonical
 *     bytes for the same set, and, for one chunk, to the rule's;
 *   - decoded contents: what `safeDeserialize` returns, and what the bitmap itself answers, are CRoaring's;
 *   - results: `andInPlace`, `orInPlace`, `andNotInPlace`, `has`, `size`, `isEmpty`, `maximum`, iteration, `toArray`
 *     and `clone` agree in content. An operation result's container kind is not compared; only what is stored is.
 *
 * ADDING A CODEC is one line in `CODECS` (`helpers/roaring-oracle.ts`). The list holds the native codec, so this file
 * also proves the oracle against the rule and a plain `Set` (CRoaring is checked as well as used), and the TypeScript codec.
 */
const CAP = 1 << 24;
const FOUR_GIB = 0xffffffff;

// --- what one case asserts ----------------------------------------------------------------------------------------

function expectSame(label: string, got: ArrayLike<number>, want: ArrayLike<number>): void {
  expect(firstDifference(got, want), describeDifference(label, got, want)).toBe(-1);
}

/** Members and near-members: what `has` is asked about. */
function probes(ids: readonly number[]): number[] {
  const step = Math.max(1, Math.floor(ids.length / 24));
  const members = ids.filter((_, i) => i % step === 0);
  const near = members.flatMap((v) => [v - 1, v + 1]).filter((v) => v >= 0 && v <= FOUR_GIB);
  return [0, 65_535, 65_536, 2 ** 31, FOUR_GIB, ...members, ...near];
}

/** Everything a bitmap answers, against the ascending ids it must hold. */
function expectContents(label: string, bitmap: CodecBitmap, ids: readonly number[]): void {
  expect(bitmap.size, `${label}: size`).toBe(ids.length);
  expect(bitmap.isEmpty, `${label}: isEmpty`).toBe(ids.length === 0);
  expectSame(`${label}: toArray`, bitmap.toArray(), ids);
  expectSame(`${label}: iteration`, [...bitmap], ids);
  if (bitmap.maximum !== undefined) {
    expect(bitmap.maximum(), `${label}: maximum`).toBe(ids.length === 0 ? undefined : ids.at(-1));
  }
  if (bitmap.toUint32Array !== undefined) {
    const first = bitmap.toUint32Array();
    const second = bitmap.toUint32Array();
    expectSame(`${label}: toUint32Array`, first, ids);
    expect(
      first.buffer === second.buffer,
      `${label}: toUint32Array must be a new array each call`,
    ).toBe(false);
  }
  const member = new Set(ids);
  for (const v of probes(ids)) expect(bitmap.has(v), `${label}: has(${v})`).toBe(member.has(v));
}

/** The set a plain `Set` holds, ascending: what CRoaring itself is checked against. */
function ascending(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** CRoaring against a plain `Set`: the oracle's own answers, checked before they are used. */
function expectOracleSound(ids: readonly number[]): void {
  const cr = crOf(ids);
  expect(cr.size).toBe(ids.length);
  expectSame('CRoaring toArray', cr.toArray(), ids);
}

/** The stored bytes of one chunk, three ways: the codec's, CRoaring's and the rule's. */
function expectChunkStored(
  label: string,
  codec: CodecInterface,
  lows: readonly number[],
  salt: number,
): void {
  const ruled = ruleBytes(lows);
  const native = crStoredBytes(lows);
  expectSame(`${label}: CRoaring's stored bytes against the written rule`, native, ruled);

  const built = codec.fromValues(scrambled(salt, lows));
  built.optimize?.();
  expectSame(
    `${label}: fromValues, optimize, serialize against the rule`,
    built.serialize(),
    ruled,
  );

  // The same set reached by other routes must store the same bytes: that is what canonical means.
  const added = codec.empty();
  for (const v of scrambled(salt + 1, lows)) added.add(v);
  added.optimize?.();
  expectSame(`${label}: add one by one`, added.serialize(), ruled);

  const many = codec.empty();
  many.addMany(scrambled(salt + 2, lows));
  const copy = many.clone();
  copy.optimize?.();
  expectSame(`${label}: addMany then clone`, copy.serialize(), ruled);

  for (const how of ['plain', 'runs', 'ranges'] as const) {
    // A payload as another writer left it, with or without run containers: decoded, then stored, it is the rule's.
    const decoded = codec.safeDeserialize(crPlainBytes(lows, how), CAP, { whole: true });
    // Before optimize(): a decoded bitmap serializes to the bytes it was given, runs and ties kept.
    const given = crPlainBytes(lows, how);
    expectSame(
      `${label}: decoded ${how} bytes, serialize before optimize`,
      decoded.serialize(),
      given,
    );
    // The { serialized } load path: the chunk payloads are the rule's, whatever container kinds came in.
    const viaEncode = [
      ...(codec.safeDeserialize(given, CAP, { whole: true }).encodeChunks?.() ?? []),
    ];
    for (const chunk of viaEncode)
      expectSame(`${label}: decoded ${how} bytes, encodeChunks`, chunk.payload, ruled);
    decoded.optimize?.();
    expectSame(`${label}: decoded ${how} bytes, then stored`, decoded.serialize(), ruled);
    expectContents(`${label}: decoded contents`, decoded, lows);
  }

  const back = codec.safeDeserialize(ruled, CAP, { whole: true });
  expectContents(`${label}: decoded stored bytes`, back, lows);
  expectSame(`${label}: stored bytes re-stored`, (back.optimize?.(), back.serialize()), ruled);
}

/** One set, end to end: contents, whole-bitmap bytes, every chunk's payload, and the decoded round trip. */
function checkSet(label: string, ids: readonly number[], salt: number): void {
  expectOracleSound(ids);
  const nativeWhole = crStoredBytes(ids);
  const plain = plainRuleBytes(ids);
  expectSame(
    `${label}: CRoaring's unoptimized bytes against the written form`,
    crPlainBytes(ids, 'plain'),
    plain,
  );
  for (const { name, codec } of CODECS) {
    const where = `${name}, ${label}`;
    // serialize() with no optimize(): what the export path writes. Array or bitset by cardinality, never stale.
    expectSame(
      `${where}: serialize before optimize, fromValues`,
      codec.fromValues(scrambled(salt, ids)).serialize(),
      plain,
    );
    const exported = codec.empty();
    for (const v of ids) exported.add(v);
    expectSame(`${where}: serialize before optimize, add per id`, exported.serialize(), plain);
    const bulk = codec.empty();
    bulk.addMany(scrambled(salt + 3, ids));
    expectSame(`${where}: serialize before optimize, addMany`, bulk.serialize(), plain);

    const bitmap = codec.fromValues(scrambled(salt, ids));
    expectContents(where, bitmap, ids);

    const encoded = bitmap.encodeChunks?.();
    bitmap.optimize?.();
    expectSame(`${where}: whole bitmap stored bytes`, bitmap.serialize(), nativeWhole);
    expectContents(`${where}: contents after optimize`, bitmap, ids);

    const chunks = chunksOf(ids);
    if (encoded !== undefined) {
      const got = [...encoded];
      expect(got.length, `${where}: encodeChunks count`).toBe(chunks.length);
      chunks.forEach(({ key, lows }, i) => {
        expect(got[i]!.chunkKey, `${where}: chunk key`).toBe(key);
        expect(got[i]!.cardinality, `${where}: chunk cardinality`).toBe(lows.length);
        expectSame(
          `${where}: encodeChunks payload of key ${key}`,
          got[i]!.payload,
          ruleBytes(lows),
        );
      });
    }
    chunks.forEach(({ key, lows }) =>
      expectChunkStored(`${where}, chunk ${key}`, codec, lows, salt + key),
    );

    const decoded = codec.safeDeserialize(nativeWhole, CAP, { whole: true });
    expectContents(`${where}: decoded whole bitmap`, decoded, ids);
  }
}

// --- operations ---------------------------------------------------------------------------------------------------

type Combine = 'andInPlace' | 'orInPlace' | 'andNotInPlace';
const COMBINES: readonly Combine[] = ['andInPlace', 'orInPlace', 'andNotInPlace'];

function expectedCombine(op: Combine, a: readonly number[], b: readonly number[]): number[] {
  const other = new Set(b);
  if (op === 'orInPlace') return ascending([...a, ...b]);
  return a.filter((v) => (op === 'andInPlace') === other.has(v));
}

/**
 * How an operand is built. `values` is `fromValues` (array and bitset containers only); `runs` is decoded from bytes
 * CRoaring wrote after `runOptimize()` (a run only where it is smaller; an array stays at a tie); `ranges` is decoded
 * from bytes built by `addRange` per maximal run, so every container is a run, ties and bitsets included.
 */
type Route = 'values' | 'runs' | 'ranges';
const ROUTES: readonly Route[] = ['values', 'runs', 'ranges'];

function buildBitmap(
  codec: CodecInterface,
  ids: readonly number[],
  route: Route,
  salt: number,
): CodecBitmap {
  if (route === 'values') return codec.fromValues(scrambled(salt, ids));
  return codec.safeDeserialize(crPlainBytes(ids, route), CAP, { whole: true });
}

/** What every codec must give for `a op b`, with the operand `b` and an earlier clone of `a` untouched. */
function checkCombine(
  label: string,
  op: Combine,
  a: readonly number[],
  b: readonly number[],
  salt: number,
  routes: readonly [Route, Route] = ['values', 'values'],
): void {
  const want = expectedCombine(op, a, b);
  const raw = crOf(a);
  raw[op](crOf(b));
  expectSame(`CRoaring ${label}: ${op}`, raw.toArray(), want);
  const wantBytes = crStoredBytes(want);

  for (const { name, codec } of CODECS) {
    const where = `${name}, ${label} (${routes[0]} / ${routes[1]}): ${op}`;
    const left = buildBitmap(codec, a, routes[0], salt);
    const right = buildBitmap(codec, b, routes[1], salt + 1);
    const before = left.clone();
    left[op](right);
    expectContents(`${where} result`, left, want);
    expectContents(`${where} operand`, right, b);
    expectContents(`${where} clone taken before`, before, a);

    // Independence runs both ways: changing the result must not change the clone, nor the clone the result.
    before.add(7);
    before.remove(8);
    expectContents(`${where} result after its earlier clone changed`, left, want);

    left.optimize?.();
    expectContents(`${where} result after optimize`, left, want);
    expectSame(`${where}: stored bytes of the result`, left.serialize(), wantBytes);
    if (want.length > 0 && want.at(-1)! < 65_536) {
      expectSame(
        `${where}: stored bytes of the result against the rule`,
        left.serialize(),
        ruleBytes(want),
      );
    }
  }
}

// --- the corpus ---------------------------------------------------------------------------------------------------

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i);
const spaced = (count: number, step: number, from = 0): number[] =>
  Array.from({ length: count }, (_, i) => from + i * step);

/** `lengths.length` runs of those lengths, `pitch` apart, so none touches the next. */
function runsOf(lengths: readonly number[], pitch: number, from = 0): number[] {
  return lengths.flatMap((len, i) => range(from + i * pitch, len));
}

const shape = (s: ChunkShape): number[] => buildSet([{ key: 0, shape: s }]);

interface Case {
  readonly name: string;
  readonly ids: number[];
}

/** Every boundary the stored-byte rule has, and the ones the id space has. */
function corpus(): Case[] {
  const cases: Case[] = [
    { name: 'empty', ids: [] },
    ...[0, 1, 65_535, 65_536, 2 ** 31 - 1, 2 ** 31, 2 ** 31 + 65_535, FOUR_GIB].map((v) => ({
      name: `single ${v}`,
      ids: [v],
    })),
    ...[2, 3, 4, 5, 6, 7].map((n) => ({ name: `${n} consecutive values`, ids: range(1_000, n) })),
    ...[2, 3, 4, 5, 6, 7].map((n) => ({
      name: `${n} values, every other`,
      ids: spaced(n, 2, 500),
    })),
    {
      name: 'ids at and above 2^31',
      ids: [2 ** 31, 2 ** 31 + 1, 2 ** 31 + 70_000, FOUR_GIB - 1, FOUR_GIB],
    },
    { name: 'a run across the 2^31 boundary', ids: range(2 ** 31 - 40, 80) },
    { name: 'last chunk, full', ids: range(FOUR_GIB - 65_535, 65_536) },
  ];
  for (const card of [4_093, 4_094, 4_095, 4_096, 4_097, 4_098, 4_099]) {
    cases.push({ name: `${card} values, spread`, ids: spaced(card, 15) });
    cases.push({
      name: `${card} values, clustered`,
      ids: range(200, card).map((v) => v + Math.floor((v - 200) / 700)),
    });
  }
  cases.push({ name: '4,096 values in one run', ids: range(0, 4_096) });
  cases.push({ name: '4,097 values in one run', ids: range(9, 4_097) });
  cases.push({ name: '65,535 values', ids: range(0, 65_535) });
  cases.push({ name: '65,536 values: one full container', ids: range(0, 65_536) });
  cases.push({ name: 'full container missing its first value', ids: range(1, 65_535) });
  cases.push({
    name: 'full container with a hole in the middle',
    ids: [...range(0, 30_000), ...range(30_001, 35_535)],
  });
  for (const removed of [1, 8, 100, 1_000, 3_000, 30_000]) {
    cases.push({
      name: `full container minus ${removed} scattered values`,
      ids: shape({ kind: 'holes', seed: removed, removed }),
    });
  }
  cases.push({ name: 'dense random', ids: shape({ kind: 'dense', seed: 11, card: 40_000 }) });
  cases.push({ name: 'half the bits, alternating', ids: spaced(32_768, 2) });
  // A run and an array of the same body size: the array stays. Three consecutive values (card = 2 runs + 1), five
  // in two runs, and the same shape at every size up to the largest an array allows.
  cases.push({ name: 'tie: 3 consecutive values', ids: [1, 2, 3] });
  cases.push({ name: 'tie: 5 values in two runs, 3 then 2', ids: [10, 11, 12, 40, 41] });
  cases.push({ name: 'tie: 5 values in two runs, 2 then 3', ids: [10, 11, 40, 41, 42] });
  for (const runs of [1, 2, 3, 10, 100, 1_000, 2_000, 2_047]) {
    for (const delta of [-1, 0, 1, 2]) {
      cases.push({
        name: `${runs} runs, cardinality 2 x runs ${delta < 0 ? '- 1' : `+ ${delta}`}`,
        ids: shape({ kind: 'tie', seed: runs * 7 + delta, runs, delta }),
      });
    }
  }
  // Run against bitset: 2 + 4 x runs against 8,192, so 2,047 runs is a run and 2,048 a bitset.
  for (const runs of [2_040, 2_046, 2_047, 2_048, 2_049, 2_055, 2_056, 2_100]) {
    cases.push({
      name: `${runs} runs, more than 4,096 values`,
      ids: shape({ kind: 'band', seed: runs, runs: Math.max(runs, 2_040) }),
    });
    cases.push({ name: `${runs} runs of 4`, ids: runsOf(Array<number>(runs).fill(4), 30) });
  }
  // One to three runs totalling the array/bitset boundary, in every split the sizes allow.
  for (const total of [4_094, 4_095, 4_096, 4_097, 4_098]) {
    for (const split of [
      [total],
      [1, total - 1],
      [total - 1, 1],
      [total / 2, total / 2],
      [3, 4, total - 7],
    ]) {
      const lengths = split.map(Math.floor);
      cases.push({ name: `runs of ${lengths.join(' + ')}`, ids: runsOf(lengths, 20_000) });
    }
  }
  cases.push({ name: 'a run at the top of the container', ids: range(65_000, 536) });
  cases.push({ name: 'runs at both ends', ids: [...range(0, 300), ...range(65_236, 300)] });
  // More than one chunk.
  cases.push({ name: 'two chunks', ids: [...range(0, 5_000), ...range(65_536 + 9, 3)] });
  cases.push({
    name: 'one chunk of each shape',
    ids: buildSet(
      Array.from({ length: 8 }, (_, key) => ({
        key,
        shape: (
          [
            { kind: 'sparse', seed: 1, card: 50 },
            { kind: 'boundary', seed: 2, card: 4_097 },
            { kind: 'dense', seed: 3, card: 30_000 },
            { kind: 'runs', seed: 4, runs: 500, maxLen: 20 },
            { kind: 'tie', seed: 5, runs: 300, delta: 1 },
            { kind: 'band', seed: 6, runs: 2_047 },
            { kind: 'holes', seed: 7, removed: 20 },
            { kind: 'cluster', seed: 8, centre: 1_000, width: 3_000, card: 2_500 },
          ] as ChunkShape[]
        )[key]!,
      })) as SetSpec,
    ),
  });
  cases.push({
    name: '2,000 chunks of a few values',
    ids: Array.from({ length: 2_000 }, (_, k) => [k * 32 * 65_536 + 5, k * 32 * 65_536 + 6]).flat(),
  });
  cases.push({
    name: 'chunks 0 and 65,535 only',
    ids: [3, 4, 5, 65_535 * 65_536, 65_535 * 65_536 + 65_535],
  });
  return cases;
}

/** 62,000 chunks of one to three values each: the shape of a million-id bulk load. */
function bulkLoadIds(): number[] {
  const next = prng(62_000);
  const out: number[] = [];
  for (let key = 0; key < 62_000; key++) {
    const count = 1 + Math.floor(next() * 3);
    const base = Math.floor(next() * 60_000);
    for (let i = 0; i < count; i++) out.push(key * 65_536 + base + i * 2);
  }
  return out;
}

describe('the codec oracle: the corpus', () => {
  const cases = corpus();
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    checkSet(c.name, ascending(c.ids), c.ids.length + 1);
  });

  it('holds 62,000 chunks, as a bulk load writes them', () => {
    const ids = bulkLoadIds();
    expectOracleSound(ids);
    const chunks = chunksOf(ids);
    expect(chunks.length).toBe(62_000);
    const nativeWhole = crStoredBytes(ids);
    for (const { name, codec } of CODECS) {
      const bitmap = codec.fromValues(ids);
      expectContents(`${name}, 62,000 chunks`, bitmap, ids);
      const encoded = bitmap.encodeChunks?.();
      bitmap.optimize?.();
      expectSame(`${name}: whole bitmap stored bytes`, bitmap.serialize(), nativeWhole);
      if (encoded !== undefined) {
        let i = 0;
        for (const chunk of encoded) {
          const { key, lows } = chunks[i++]!;
          expect(chunk.chunkKey).toBe(key);
          expectSame(`${name}: payload of chunk ${key}`, chunk.payload, ruleBytes(lows));
        }
        expect(i).toBe(chunks.length);
      }
      // Each chunk as the load writes it: built alone from its low 16 bits.
      for (const { key, lows } of chunks.filter((_, i) => i % 97 === 0)) {
        const alone = codec.fromValues(lows);
        alone.optimize?.();
        expectSame(`${name}: chunk ${key} built alone`, alone.serialize(), ruleBytes(lows));
      }
      expectContents(
        `${name}: decoded`,
        codec.safeDeserialize(nativeWhole, CAP << 4, { whole: true }),
        ids,
      );
    }
  }, 120_000);

  it('holds a run container with values removed, the shape an erasure leaves', () => {
    for (const removed of [1, 3, 50, 1_500, 3_000]) {
      const ids = range(100, 20_000);
      const gone = new Set(
        shape({ kind: 'sparse', seed: removed, card: removed }).map((v) => 100 + (v % 20_000)),
      );
      const rest = ids.filter((v) => !gone.has(v));
      for (const { name, codec } of CODECS) {
        const bitmap = codec.safeDeserialize(crPlainBytes(ids, 'ranges'), CAP, { whole: true });
        bitmap.removeMany([...gone]);
        expectContents(`${name}, erased ${removed}`, bitmap, rest);
        bitmap.optimize?.();
        expectSame(`${name}, erased ${removed}: stored bytes`, bitmap.serialize(), ruleBytes(rest));
        expectSame(
          `${name}, erased ${removed}: against CRoaring`,
          bitmap.serialize(),
          crStoredBytes(rest),
        );
      }
    }
  });

  it('holds a bitset that remove() brings down to 4,096 values: an array, not 8,192 bytes', () => {
    for (const { name, codec } of CODECS) {
      const bitmap = codec.fromValues(spaced(4_098, 3));
      bitmap.remove(0);
      bitmap.remove(3);
      expect(bitmap.size).toBe(4_096);
      bitmap.optimize?.();
      expectSame(
        `${name}: 4,096 values after remove`,
        bitmap.serialize(),
        ruleBytes(spaced(4_096, 3, 6)),
      );
      const grown = codec.fromValues(spaced(4_096, 3));
      grown.add(1);
      grown.optimize?.();
      expectSame(
        `${name}: 4,097 values after add`,
        grown.serialize(),
        ruleBytes(ascending([...spaced(4_096, 3), 1])),
      );
    }
  });

  it('keeps an empty result empty: no container, the empty bitmap is 8 bytes', () => {
    for (const { name, codec } of CODECS) {
      const emptied = codec.fromValues([5, 6, 7]);
      emptied.andNotInPlace(codec.fromValues([5, 6, 7]));
      emptied.optimize?.();
      expectContents(`${name}: emptied`, emptied, []);
      expectSame(`${name}: emptied bitmap's bytes`, emptied.serialize(), crStoredBytes([]));
      expect(emptied.serialize().length).toBe(8);
      const none = codec.empty();
      none.andInPlace(codec.fromValues([1]));
      expectContents(`${name}: empty and one`, none, []);
    }
  });

  it('holds clone independence in both directions', () => {
    for (const { name, codec } of CODECS) {
      const original = codec.fromValues(spaced(5_000, 7));
      const copy = original.clone();
      copy.addMany([1, 2, 3]);
      copy.removeMany(spaced(100, 7));
      copy.orInPlace(codec.fromValues([9_999_999]));
      expectContents(`${name}: original after the clone changed`, original, spaced(5_000, 7));
      original.andInPlace(codec.fromValues([0, 7]));
      expectContents(
        `${name}: clone after the original changed`,
        copy,
        ascending([...spaced(5_000, 7).slice(100), 1, 2, 3, 9_999_999]),
      );
    }
  });
});

// --- exhaustive small universes -----------------------------------------------------------------------------------

/** Every subset of the values at `positions`: each run shape that window can hold, once. */
function everySubset(positions: readonly number[]): void {
  for (const { name, codec } of CODECS) {
    for (let mask = 1; mask < 2 ** positions.length; mask++) {
      const ids = positions.filter((_, b) => (mask & (1 << b)) !== 0);
      const built = codec.fromValues(ids);
      built.optimize?.();
      const label = `${name}: subset ${mask} of the window at ${positions[0]}`;
      expectSame(`${label}: stored bytes against CRoaring`, built.serialize(), crStoredBytes(ids));
      expectSame(`${label}: stored bytes against the rule`, built.serialize(), ruleBytes(ids));
      expectSame(`${label}: contents`, built.toArray(), ids);
    }
  }
}

describe('the codec oracle: every subset of a small window', () => {
  const bits = Math.log2(heavy('codecOracleSubsets'));
  const window = (from: number, gap: (b: number) => number): number[] =>
    Array.from({ length: bits }, (_, b) => from + b + gap(b));
  it(`every subset of ${bits} consecutive values at the start of a container`, () => {
    everySubset(window(0, () => 0));
  }, 120_000);
  it(`every subset of ${bits} consecutive values at the end of a container`, () => {
    everySubset(window(65_536 - bits, () => 0));
  }, 120_000);
  it(`every subset of ${bits} values in groups of four, three apart, ending at the array limit`, () => {
    everySubset(window(4_096 - bits - 3 * Math.floor(bits / 4), (b) => 3 * Math.floor(b / 4)));
  }, 120_000);
});

// --- properties ---------------------------------------------------------------------------------------------------

const propertyRuns = (): { numRuns: number } => ({ numRuns: heavy('codecOracleProperties') });
const salt = fc.integer({ min: 0, max: 0x7fffffff });
const mode = fc.constantFrom('subset', 'superset', 'shift', 'copy', 'stranger');
const route = fc.constantFrom(...ROUTES);

describe('the codec oracle: properties over biased random sets', () => {
  it('stores one chunk as the rule and CRoaring write it, however the set was built', () => {
    fc.assert(
      fc.property(oneChunk, salt, (spec, s) => {
        checkSet('one chunk', buildSet(spec), s);
      }),
      propertyRuns(),
    );
  }, 300_000);

  it('stores sets of several chunks as CRoaring does, and each chunk as the rule does', () => {
    fc.assert(
      fc.property(setSpec(3), salt, (spec, s) => {
        checkSet('several chunks', buildSet(spec), s);
      }),
      { numRuns: Math.max(5, Math.floor(heavy('codecOracleProperties') / 2)) },
    );
  }, 300_000);

  it('combines two sets as CRoaring does, leaving the operand and an earlier clone alone', () => {
    fc.assert(
      fc.property(
        setSpec(2),
        setSpec(2),
        mode,
        salt,
        route,
        route,
        (specA, specB, how, s, ra, rb) => {
          const a = buildSet(specA);
          const b = relatedTo(a, how, s, buildSet(specB));
          for (const op of COMBINES) checkCombine(`related by ${how}`, op, a, b, s, [ra, rb]);
        },
      ),
      propertyRuns(),
    );
  }, 300_000);

  it('combines two single chunks, and stores the result as the rule writes it', () => {
    fc.assert(
      fc.property(oneChunk, oneChunk, mode, salt, route, route, (specA, specB, how, s, ra, rb) => {
        const a = buildSet(specA);
        const b = relatedTo(a, how, s, buildSet(specB)).filter((v) => v < 65_536);
        for (const op of COMBINES) checkCombine(`one chunk, ${how}`, op, a, b, s, [ra, rb]);
      }),
      propertyRuns(),
    );
  }, 300_000);
});

// --- random operation sequences -----------------------------------------------------------------------------------

type Step =
  | { readonly op: 'add' | 'remove'; readonly at: number; readonly id: number }
  | {
      readonly op: 'addMany' | 'removeMany';
      readonly at: number;
      readonly spec: SetSpec;
      readonly salt: number;
    }
  | { readonly op: Combine; readonly at: number; readonly other: number }
  | { readonly op: 'clone'; readonly at: number; readonly other: number }
  | { readonly op: 'optimize'; readonly at: number };

const idArb = fc.oneof(
  fc.constantFrom(0, 1, 4_095, 4_096, 4_097, 65_535, 65_536, 65_537, 2 ** 31, FOUR_GIB),
  fc.integer({ min: 0, max: 70_000 }),
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ op: fc.constantFrom('add' as const, 'remove' as const), at: fc.nat(2), id: idArb }),
  fc.record({
    op: fc.constantFrom('addMany' as const, 'removeMany' as const),
    at: fc.nat(2),
    spec: setSpec(2),
    salt,
  }),
  fc.record({ op: fc.constantFrom(...COMBINES), at: fc.nat(2), other: fc.nat(2) }),
  fc.record({ op: fc.constant('clone' as const), at: fc.nat(2), other: fc.nat(2) }),
  fc.record({ op: fc.constant('optimize' as const), at: fc.nat(2) }),
);

/** The model of one bitmap: a plain `Set`, the CRoaring bitmap that has had the same calls, and the codec's. */
interface Triple {
  model: Set<number>;
  raw: ReturnType<typeof crOf>;
  bitmap: CodecBitmap;
}

function applyStep(all: Triple[], step: Step): void {
  const at = step.at % all.length;
  const t = all[at]!;
  switch (step.op) {
    case 'add':
    case 'remove': {
      const call = step.op;
      t.bitmap[call](step.id);
      t.raw[call](step.id);
      if (call === 'add') t.model.add(step.id);
      else t.model.delete(step.id);
      return;
    }
    case 'addMany':
    case 'removeMany': {
      const values = scrambled(step.salt, buildSet(step.spec));
      t.bitmap[step.op](values);
      t.raw[step.op](values);
      for (const v of values) {
        if (step.op === 'addMany') t.model.add(v);
        else t.model.delete(v);
      }
      return;
    }
    case 'clone': {
      all[step.other % all.length] = {
        model: new Set(t.model),
        raw: t.raw.clone(),
        bitmap: t.bitmap.clone(),
      };
      return;
    }
    case 'optimize':
      t.bitmap.optimize?.();
      return;
    default: {
      const o = all[step.other % all.length]!;
      if (o === t) return;
      t.bitmap[step.op](o.bitmap);
      t.raw[step.op](o.raw);
      const want = expectedCombine(step.op, ascending(t.model), ascending(o.model));
      t.model = new Set(want);
    }
  }
}

describe('the codec oracle: random sequences of adds, removes and combines', () => {
  it('keeps every bitmap equal to CRoaring and to a Set after every step, and stores the same bytes', () => {
    fc.assert(
      fc.property(
        fc.array(setSpec(2), { minLength: 2, maxLength: 3 }),
        fc.array(route, { minLength: 3, maxLength: 3 }),
        fc.array(stepArb, { minLength: 1, maxLength: 20 }),
        (starts, routes, steps) => {
          for (const { name, codec } of CODECS) {
            const all: Triple[] = starts.map((spec, i) => {
              const ids = buildSet(spec);
              return {
                model: new Set(ids),
                raw: crOf(ids),
                bitmap: buildBitmap(codec, ids, routes[i]!, i),
              };
            });
            steps.forEach((step, n) => {
              applyStep(all, step);
              const t = all[step.at % all.length]!;
              const label = `${name}, step ${n} (${step.op})`;
              expectSame(`${label}: against CRoaring`, t.bitmap.toArray(), t.raw.toArray());
              expect(t.bitmap.size, `${label}: size`).toBe(t.raw.size);
              expect(t.bitmap.isEmpty, `${label}: isEmpty`).toBe(t.raw.isEmpty);
              if (t.bitmap.maximum !== undefined) {
                expect(t.bitmap.maximum(), `${label}: maximum`).toBe(
                  t.raw.isEmpty ? undefined : t.raw.maximum(),
                );
              }
              if (step.op === 'clone') {
                const c = all[step.other % all.length]!;
                expectSame(`${label}: the clone`, c.bitmap.toArray(), t.raw.toArray());
              }
              if (step.op === 'optimize') {
                expectSame(
                  `${label}: stored bytes`,
                  t.bitmap.serialize(),
                  crStoredBytes(ascending(t.model)),
                );
              }
            });
            for (const [i, t] of all.entries()) {
              const ids = ascending(t.model);
              expectSame(
                `${name}, end, bitmap ${i}: CRoaring against the Set`,
                t.raw.toArray(),
                ids,
              );
              expectContents(`${name}, end, bitmap ${i}`, t.bitmap, ids);
              t.bitmap.optimize?.();
              expectSame(
                `${name}, end, bitmap ${i}: stored bytes`,
                t.bitmap.serialize(),
                crStoredBytes(ids),
              );
              for (const { key, lows } of chunksOf(ids)) {
                if (key === 0)
                  expectSame(
                    `${name}, end, bitmap ${i}: chunk 0 against the rule`,
                    crStoredBytes(lows),
                    ruleBytes(lows),
                  );
              }
            }
          }
        },
      ),
      propertyRuns(),
    );
  }, 300_000);
});

// --- every pair of container kinds ---------------------------------------------------------------------------------

type Kind = 'array' | 'bitset' | 'run';

/**
 * Operands of each container kind, all inside one chunk and laid over one another so a combine finds work: runs that
 * end where the other operand's run ends, begin where it begins, sit inside it, and straddle it.
 */
const OPERANDS: Record<Kind, ReadonlyArray<{ readonly name: string; readonly ids: number[] }>> = {
  array: [
    { name: 'every 7th from 5', ids: spaced(300, 7, 5) },
    { name: 'three consecutive', ids: [1, 2, 3] },
    { name: 'five and a stray', ids: [100, 101, 102, 103, 104, 999] },
    { name: '4,096 values', ids: spaced(4_096, 3) },
  ],
  bitset: [
    { name: 'every 11th from 3', ids: spaced(5_000, 11, 3) },
    { name: '4,097 consecutive', ids: range(0, 4_097) },
    { name: 'a long band', ids: range(100, 60_000) },
  ],
  run: [
    { name: 'two runs, 100-199 and 300-349', ids: [...range(100, 100), ...range(300, 50)] },
    { name: 'a run ending where the first ends', ids: range(150, 50) },
    { name: 'a run across the gap', ids: range(199, 102) },
    { name: 'one run over both', ids: range(100, 250) },
    { name: 'three then a run of five', ids: [1, 2, 3, ...range(100, 5)] },
    { name: 'a full container', ids: range(0, 65_536) },
    { name: 'six runs of mixed length', ids: runsOf([30, 1, 200, 2, 60, 700], 1_000, 10) },
  ],
};
const KINDS: readonly Kind[] = ['array', 'bitset', 'run'];
const routeOf = (kind: Kind): Route => (kind === 'run' ? 'ranges' : 'values');

describe('the codec oracle: every pair of container kinds, for every combine', () => {
  it('builds the operands as the kinds it names', () => {
    for (const kind of KINDS) {
      for (const { name, ids } of OPERANDS[kind]) {
        const bytes = crPlainBytes(ids, kind === 'run' ? 'ranges' : 'plain');
        const cookie = new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true);
        expect(cookie, `${kind} operand ${name}`).toBe(kind === 'run' ? 12_347 : 12_346);
        if (kind !== 'run')
          expect(ids.length > 4_096, `${kind} operand ${name}`).toBe(kind === 'bitset');
      }
    }
  });

  for (const kindA of KINDS) {
    for (const kindB of KINDS) {
      it(`${kindA} against ${kindB}: and, or and andNot, then the bytes after optimize`, () => {
        for (const a of OPERANDS[kindA]) {
          for (const b of OPERANDS[kindB]) {
            for (const op of COMBINES) {
              checkCombine(
                `${kindA} (${a.name}) with ${kindB} (${b.name})`,
                op,
                a.ids,
                b.ids,
                a.ids.length + b.ids.length,
                [routeOf(kindA), routeOf(kindB)],
              );
            }
          }
        }
      });
    }
  }

  it('stores an andNot result as the rule writes it, not as the run it was: 22 bytes, not 15', () => {
    // Three values left of a run that is removed: card = 2 x runs + 1, so the rule keeps an array.
    const a = [1, 2, 3, ...range(100, 5)];
    const b = [...range(100, 5), 999];
    for (const { name, codec } of CODECS) {
      const left = buildBitmap(codec, a, 'ranges', 0);
      left.andNotInPlace(buildBitmap(codec, b, 'values', 1));
      left.optimize?.();
      expectSame(
        `${name}: andNot of a run container, stored`,
        left.serialize(),
        ruleBytes([1, 2, 3]),
      );
      expect(left.serialize().length, `${name}: an array of three values`).toBe(22);
    }
  });

  it('removes every value of a run operand from a run container, its last one included', () => {
    for (const { name, codec } of CODECS) {
      const left = buildBitmap(codec, range(100, 100), 'ranges', 0);
      left.andNotInPlace(buildBitmap(codec, range(150, 50), 'ranges', 1));
      expectContents(`${name}: run andNot run, ending together`, left, range(100, 50));
      const rest = buildBitmap(codec, range(100, 100), 'ranges', 0);
      rest.andNotInPlace(buildBitmap(codec, range(100, 100), 'ranges', 1));
      expectContents(`${name}: run andNot the same run`, rest, []);
    }
  });
});

// --- serialize before optimize ------------------------------------------------------------------------------------

describe('the codec oracle: serialize() with no optimize(), the export path', () => {
  const grown = (n: number): number[] => spaced(n, 3);
  it('writes an array at 4,096 values and a bitset at 4,097, whichever way it got there', () => {
    for (const { name, codec } of CODECS) {
      const down = codec.fromValues(grown(4_098));
      down.remove(0);
      down.remove(3);
      expectSame(
        `${name}: bitset removed to 4,096`,
        down.serialize(),
        plainRuleBytes(spaced(4_096, 3, 6)),
      );
      expect(down.serialize().length, `${name}: an array of 4,096 values`).toBe(16 + 2 * 4_096);

      const up = codec.fromValues(grown(4_096));
      expectSame(`${name}: 4,096 values`, up.serialize(), plainRuleBytes(grown(4_096)));
      up.add(1);
      expectSame(
        `${name}: array added to 4,097`,
        up.serialize(),
        plainRuleBytes(ascending([...grown(4_096), 1])),
      );

      const exported = codec.empty();
      for (const v of grown(4_096)) exported.add(v);
      expectSame(
        `${name}: 4,096 added one by one`,
        exported.serialize(),
        plainRuleBytes(grown(4_096)),
      );
      exported.add(1);
      exported.remove(1);
      expectSame(`${name}: back to 4,096`, exported.serialize(), plainRuleBytes(grown(4_096)));
    }
  });

  it('writes each chunk by its own cardinality, in several chunks', () => {
    const ids = [
      ...spaced(4_096, 3),
      ...spaced(4_097, 3, 65_536),
      ...spaced(10, 5, 3 * 65_536),
      ...range(7 * 65_536, 65_536),
    ];
    for (const { name, codec } of CODECS) {
      expectSame(`${name}: four chunks`, codec.fromValues(ids).serialize(), plainRuleBytes(ids));
    }
  });
});

// --- add and remove, directly -------------------------------------------------------------------------------------

describe('the codec oracle: add and remove of one id', () => {
  const HIGH = [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 2 ** 31 + 65_535, FOUR_GIB - 1, FOUR_GIB];

  it('leaves size and bytes alone when the id is already present', () => {
    const cases: Array<[string, number[], Route]> = [
      ['an array', spaced(300, 7, 5), 'values'],
      ['a bitset', spaced(5_000, 11, 3), 'values'],
      ['a run container', [...range(100, 100), ...range(300, 50)], 'ranges'],
      ['a tie array', [1, 2, 3], 'values'],
    ];
    for (const { name, codec } of CODECS) {
      for (const [what, ids, how] of cases) {
        const bitmap = buildBitmap(codec, ids, how, 0);
        for (const v of [ids[0]!, ids[1]!, ids.at(-1)!]) {
          bitmap.add(v);
          expect(bitmap.size, `${name}, ${what}: size after add(${v}) of a present id`).toBe(
            ids.length,
          );
        }
        bitmap.addMany([ids[0]!, ids.at(-1)!]);
        expect(bitmap.size, `${name}, ${what}: size after addMany of present ids`).toBe(ids.length);
        expectContents(`${name}, ${what}: after adding present ids`, bitmap, ids);
        bitmap.remove(65_535 - 1);
        bitmap.removeMany([65_000, 65_001]);
        expect(bitmap.size, `${name}, ${what}: size after remove of absent ids`).toBe(ids.length);
        bitmap.optimize?.();
        expectSame(`${name}, ${what}: stored`, bitmap.serialize(), crStoredBytes(ids));
      }
    }
  });

  it('counts an id once however often it is added, in one chunk and in several', () => {
    for (const { name, codec } of CODECS) {
      const bitmap = codec.empty();
      for (const v of [5, 5, 5, 70_000, 70_000, 5, FOUR_GIB, FOUR_GIB]) bitmap.add(v);
      expect(bitmap.size, `${name}: size`).toBe(3);
      expectSame(`${name}: toArray`, bitmap.toArray(), [5, 70_000, FOUR_GIB]);
      expect(bitmap.serialize().length, `${name}: bytes`).toBe(
        plainRuleBytes([5, 70_000, FOUR_GIB]).length,
      );
    }
  });

  it('adds, finds, removes and stores ids at and above 2^31', () => {
    for (const { name, codec } of CODECS) {
      const bitmap = codec.empty();
      const model = new Set<number>();
      for (const v of HIGH) {
        bitmap.add(v);
        model.add(v);
        const ids = ascending(model);
        expectContents(`${name}: after add(${v})`, bitmap, ids);
        expect(bitmap.has(v), `${name}: has(${v})`).toBe(true);
        expect(bitmap.has(v - 2 ** 31), `${name}: has(${v} - 2^31) is a different id`).toBe(
          model.has(v - 2 ** 31),
        );
      }
      bitmap.addMany(HIGH.map((v) => v - 7).filter((v) => v >= 0));
      for (const v of HIGH) model.add(v - 7);
      expectContents(`${name}: after addMany`, bitmap, ascending(model));
      bitmap.optimize?.();
      expectSame(`${name}: stored`, bitmap.serialize(), crStoredBytes(ascending(model)));
      bitmap.remove(2 ** 31);
      bitmap.removeMany([FOUR_GIB, 2 ** 31 + 1]);
      for (const v of [2 ** 31, FOUR_GIB, 2 ** 31 + 1]) model.delete(v);
      expectContents(`${name}: after remove and removeMany`, bitmap, ascending(model));
      bitmap.optimize?.();
      expectSame(
        `${name}: stored after removes`,
        bitmap.serialize(),
        crStoredBytes(ascending(model)),
      );
    }
  });
});

// --- the golden corpus --------------------------------------------------------------------------------------------

describe('the codec oracle: the golden .crbm files', () => {
  const GOLDEN = fileURLToPath(new URL('../golden/', import.meta.url));
  const files = readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.crbm') && !f.includes('encrypted'))
    .sort();

  it('lists the cleartext objects of the corpus', () => {
    expect(files.length).toBe(6);
  });

  it.each(files)('%s: every chunk payload decodes and re-stores byte for byte', async (file) => {
    const reader = await CrbmReader.open(
      new BufferReader(new Uint8Array(readFileSync(join(GOLDEN, file)))),
    );
    let restored = 0;
    for (const key of reader.chunkKeys()) {
      const payload = (await reader.getChunk(key))!;
      let layoutAccepts = true;
      try {
        checkPortableLayout(payload);
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrityError);
        layoutAccepts = false;
      }
      for (const { name, codec } of CODECS) {
        if (!layoutAccepts) {
          // The basic and metadata objects hold opaque bytes that pin the container, not a codec.
          expect(
            () => codec.safeDeserialize(payload, CAP, { whole: true }),
            `${name}, ${file}, chunk ${key}`,
          ).toThrow(IntegrityError);
          continue;
        }
        const decoded = codec.safeDeserialize(payload, CAP, { whole: true });
        decoded.optimize?.();
        expectSame(`${name}, ${file}, chunk ${key}: re-stored`, decoded.serialize(), payload);
        expectSame(
          `${name}, ${file}, chunk ${key}: the rule's bytes`,
          ruleBytes(decoded.toArray()),
          payload,
        );
        const viaEncode = [...(codec.safeDeserialize(payload, CAP).encodeChunks?.() ?? [])];
        for (const chunk of viaEncode)
          expectSame(`${name}, ${file}: encodeChunks`, chunk.payload, payload);
        restored++;
      }
    }
    // Not vacuous: the load objects hold real bitmaps, so every chunk is decoded and re-stored by every codec.
    // (The basic and metadata objects hold opaque bytes, which the refusal branch covers.)
    if (file.includes('load')) {
      expect(restored, `${file}: payloads decoded and re-stored`).toBe(
        reader.chunkKeys().length * CODECS.length,
      );
      expect(restored, `${file}: some payload was decoded`).toBeGreaterThan(0);
    }
  });

  it('holds payloads of every shape: the load object decodes seven chunks', async () => {
    const reader = await CrbmReader.open(
      new BufferReader(new Uint8Array(readFileSync(join(GOLDEN, 'v1.0-load.crbm')))),
    );
    expect(reader.chunkKeys()).toEqual([0, 1, 2, 3, 4, 7, 65_535]);
  });
});
