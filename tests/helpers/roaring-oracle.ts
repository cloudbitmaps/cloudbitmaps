/**
 * What the codec oracle suite (`roaring/codec-oracle.test.ts`) compares a codec against.
 *
 * THREE ANSWERS PER CASE. A codec under test (a {@link CodecInterface}) is held to
 *
 *   1. CRoaring, through the pinned `roaring` package: its decoded contents, its operation results, and the bytes it
 *      stores after `removeRunCompression()` and `runOptimize()` (what `optimize()` does today);
 *   2. {@link ruleBytes}: the stored bytes of one chunk written from the public rule alone (`docs/format.md`
 *      section 3), never from CRoaring's source;
 *   3. a plain `Set`, for what CRoaring itself should answer, so the oracle is checked as well as used.
 *
 * A codec that differs from CRoaring while CRoaring equals the rule is a codec bug. A CRoaring that differs from the
 * rule is an oracle that moved (a `roaring` upgrade): keep it pinned and do not follow it (`oracle-pin.test.ts`).
 *
 * Also here: the list of codecs under test, the biased set generators (a uniform random set almost never lands on a
 * container boundary or a run tie, so each generator picks a shape and a boundary first and then fills it), and the
 * comparison helpers that name the first difference instead of printing megabytes.
 */
import fc from 'fast-check';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import type { CodecInterface } from '@cloudbitmaps/core';
import { roaringCodec } from '@/native-codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';

/** A codec the oracle suite holds to CRoaring's answers. */
export interface CodecUnderTest {
  readonly name: string;
  readonly codec: CodecInterface;
}

/**
 * Every codec the suite runs against: the native one, which proves the oracle against itself and the rule, and the
 * TypeScript codec, which is held to both. A further codec is one more entry here.
 */
export const CODECS: readonly CodecUnderTest[] = [
  { name: 'native (CRoaring through roaring)', codec: roaringCodec },
  { name: 'TypeScript', codec: tsRoaringCodec },
];

// --- CRoaring, as the oracle --------------------------------------------------------------------------------------

/** A CRoaring bitmap of `values`, built as the native codec builds one (`new RoaringBitmap32(values)`). */
export function crOf(values: Iterable<number>): RoaringBitmap32 {
  return new RoaringBitmap32(values);
}

/** The portable bytes CRoaring stores for `values` after its canonical re-encoding: what `optimize()` then `serialize()` give. */
export function crStoredBytes(values: Iterable<number>): Uint8Array {
  const bitmap = crOf(values);
  bitmap.removeRunCompression();
  bitmap.runOptimize();
  return new Uint8Array(bitmap.serialize(SerializationFormat.portable));
}

/**
 * CRoaring's portable bytes for a bitmap it has not re-encoded, as another writer may leave a payload: `plain` from
 * ids; `runs` after a `runOptimize()` (an array stays an array at a tie); `ranges` built by `addRange` per maximal run,
 * so every container is a run even where an array is smaller or equal.
 */
export function crPlainBytes(
  values: readonly number[],
  how: 'plain' | 'runs' | 'ranges',
): Uint8Array {
  const bitmap = how === 'ranges' ? new RoaringBitmap32() : crOf(values);
  if (how === 'ranges') {
    for (let i = 0; i < values.length;) {
      let j = i;
      while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++;
      bitmap.addRange(values[i]!, values[j]! + 1);
      i = j + 1;
    }
  }
  if (how === 'runs') bitmap.runOptimize();
  return new Uint8Array(bitmap.serialize(SerializationFormat.portable));
}

// --- The written rule ---------------------------------------------------------------------------------------------

const ARRAY_MAX = 4_096;
const BITSET_BODY_BYTES = 8_192;

/**
 * The stored payload of one chunk, written from `docs/format.md` section 3 and nothing else: the chunk holds the
 * ascending distinct `values` (each 0 to 65,535, at least one).
 *
 *   - a run is a maximal sequence of consecutive values; a run body is `2 + 4 * runs` bytes;
 *   - the plain body is `2 * cardinality` (an array) up to 4,096 values, else 8,192 (a bitset);
 *   - the payload is a run only when its body is strictly smaller than the plain body, so a tie stays an array;
 *   - array and bitset: cookie 12346, count 1, key 0, `cardinality - 1`, offset 16, then the body;
 *   - run: cookie 12347 (count - 1 = 0 in its high half), one flag byte 1, key 0, `cardinality - 1`, the run count,
 *     then `(start, length - 1)` per run, with no offset header.
 */
export function ruleBytes(values: readonly number[]): Uint8Array {
  const card = values.length;
  if (card === 0 || card > 65_536)
    throw new RangeError(`a chunk holds 1 to 65,536 values, not ${card}`);
  let runs = 0;
  for (let i = 0; i < card; i++) {
    const v = values[i]!;
    if (!Number.isInteger(v) || v < 0 || v > 65_535)
      throw new RangeError(`${v} is not a remainder`);
    if (i > 0 && v <= values[i - 1]!) throw new RangeError('values must be strictly ascending');
    if (i === 0 || v !== values[i - 1]! + 1) runs++;
  }
  const plain = card <= ARRAY_MAX ? 2 * card : BITSET_BODY_BYTES;
  if (2 + 4 * runs < plain) return ruleRun(values, runs);

  const header = 16;
  const out = new Uint8Array(header + plain);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x303a, true);
  view.setUint32(4, 1, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, card - 1, true);
  view.setUint32(12, header, true);
  if (card <= ARRAY_MAX) {
    values.forEach((v, i) => view.setUint16(header + 2 * i, v, true));
  } else {
    for (const v of values) out[header + (v >>> 3)]! |= 1 << (v & 7);
  }
  return out;
}

/**
 * The bytes of a whole bitmap that has had no `optimize()`: what `serialize()` writes for a bitmap built from ids (or
 * by `add`, ascending, as the export path builds one) and never re-encoded. No container is a run, so the cookie is
 * 12346 and the header is a container count, a `(key, cardinality - 1)` pair and a body offset for each container; a
 * container is an array up to 4,096 values and a bitset above. `ids` are ascending and distinct, any 32-bit id.
 */
export function plainRuleBytes(ids: readonly number[]): Uint8Array {
  const chunks = chunksOf(ids);
  const n = chunks.length;
  const headerBytes = 8 + 8 * n;
  const bodyBytes = chunks.map(({ lows }) =>
    lows.length <= ARRAY_MAX ? 2 * lows.length : BITSET_BODY_BYTES,
  );
  const out = new Uint8Array(headerBytes + bodyBytes.reduce((sum, b) => sum + b, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x303a, true);
  view.setUint32(4, n, true);
  let at = headerBytes;
  chunks.forEach(({ key, lows }, i) => {
    view.setUint16(8 + 4 * i, key, true);
    view.setUint16(10 + 4 * i, lows.length - 1, true);
    view.setUint32(8 + 4 * n + 4 * i, at, true);
    if (lows.length <= ARRAY_MAX) lows.forEach((v, k) => view.setUint16(at + 2 * k, v, true));
    else for (const v of lows) out[at + (v >>> 3)]! |= 1 << (v & 7);
    at += bodyBytes[i]!;
  });
  return out;
}

function ruleRun(values: readonly number[], runs: number): Uint8Array {
  const out = new Uint8Array(11 + 4 * runs);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x303b, true);
  out[4] = 1;
  view.setUint16(5, 0, true);
  view.setUint16(7, values.length - 1, true);
  view.setUint16(9, runs, true);
  let at = 11;
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++;
    view.setUint16(at, values[i]!, true);
    view.setUint16(at + 2, j - i, true);
    at += 4;
    i = j + 1;
  }
  return out;
}

// --- Sets: shapes, builders and generators -------------------------------------------------------------------------

/** A small deterministic generator, so a generated shape is a few numbers that shrink, not a long array. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The shape of one chunk's values (0 to 65,535). */
export type ChunkShape =
  | { readonly kind: 'sparse'; readonly seed: number; readonly card: number }
  | { readonly kind: 'boundary'; readonly seed: number; readonly card: number }
  | { readonly kind: 'dense'; readonly seed: number; readonly card: number }
  | { readonly kind: 'runs'; readonly seed: number; readonly runs: number; readonly maxLen: number }
  | { readonly kind: 'tie'; readonly seed: number; readonly runs: number; readonly delta: number }
  | { readonly kind: 'band'; readonly seed: number; readonly runs: number }
  | { readonly kind: 'holes'; readonly seed: number; readonly removed: number }
  | {
      readonly kind: 'cluster';
      readonly seed: number;
      readonly centre: number;
      readonly width: number;
      readonly card: number;
    };

function distinct(seed: number, card: number, lo: number, hi: number): number[] {
  const next = prng(seed);
  const span = hi - lo + 1;
  const want = Math.min(card, span);
  const seen = new Set<number>();
  while (seen.size < want) seen.add(lo + Math.floor(next() * span));
  return [...seen].sort((a, b) => a - b);
}

/** Runs of the given lengths, one per slot of an even pitch, so they never touch and always fit. */
function placeRuns(seed: number, lengths: readonly number[]): number[] {
  const next = prng(seed);
  const pitch = Math.floor(65_536 / lengths.length);
  const out: number[] = [];
  lengths.forEach((raw, i) => {
    const len = Math.min(raw, pitch - 2);
    const start = i * pitch + Math.floor(next() * (pitch - len - 1));
    for (let k = 0; k < len; k++) out.push(start + k);
  });
  return out;
}

function shuffled<T>(seed: number, items: T[]): T[] {
  const next = prng(seed);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** The ascending distinct values of a shape. */
export function buildChunk(shape: ChunkShape): number[] {
  switch (shape.kind) {
    case 'sparse':
    case 'boundary':
    case 'dense':
      return distinct(shape.seed, shape.card, 0, 65_535);
    case 'cluster': {
      const lo = Math.min(shape.centre, 65_535 - shape.width);
      return distinct(shape.seed, shape.card, lo, lo + shape.width);
    }
    case 'runs': {
      const next = prng(shape.seed);
      const lengths = Array.from(
        { length: shape.runs },
        () => 1 + Math.floor(next() * shape.maxLen),
      );
      return placeRuns(shape.seed + 1, lengths);
    }
    case 'tie': {
      // card = 2 * runs + delta: every run two long, then runs lengthened or shortened by one to reach the delta.
      const lengths = Array.from({ length: shape.runs }, () => 2);
      let left = shape.delta;
      for (let i = 0; left !== 0 && i < lengths.length; i++, left -= Math.sign(left)) {
        lengths[i]! += Math.sign(left);
      }
      return placeRuns(shape.seed, shuffled(shape.seed, lengths));
    }
    case 'band': {
      // 2,040 to 2,060 runs of two, some of three so the container holds more than 4,096 values: the bitset against
      // run boundary is `2 + 4 * runs` against 8,192, at 2,047 and 2,048 runs.
      const lengths = Array.from({ length: shape.runs }, () => 2);
      for (let i = 0; i < Math.max(0, 4_097 - 2 * shape.runs); i++) lengths[i] = 3;
      return placeRuns(shape.seed, shuffled(shape.seed, lengths));
    }
    case 'holes': {
      const gone = new Set(distinct(shape.seed, shape.removed, 0, 65_535));
      return Array.from({ length: 65_536 }, (_, i) => i).filter((v) => !gone.has(v));
    }
  }
}

/** One chunk of a set: the high 16 bits every id shares, and the shape of the low 16. */
export interface ChunkSpec {
  readonly key: number;
  readonly shape: ChunkShape;
}

/** A set as a few chunk specs: what a generator draws and a failure prints. */
export type SetSpec = readonly ChunkSpec[];

/** The ascending distinct ids of a set spec. Specs that repeat a key are merged. */
export function buildSet(spec: SetSpec): number[] {
  const byKey = new Map<number, Set<number>>();
  for (const { key, shape } of spec) {
    const values = byKey.get(key) ?? new Set<number>();
    for (const v of buildChunk(shape)) values.add(v);
    byKey.set(key, values);
  }
  const out: number[] = [];
  for (const key of [...byKey.keys()].sort((a, b) => a - b)) {
    for (const v of [...byKey.get(key)!].sort((a, b) => a - b)) out.push(key * 65_536 + v);
  }
  return out;
}

const seed = fc.integer({ min: 0, max: 0x7fffffff });

/** A chunk shape biased to a container kind and to the boundary that kind has. */
export const chunkShape: fc.Arbitrary<ChunkShape> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('sparse' as const),
      seed,
      card: fc.integer({ min: 1, max: 4_096 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('boundary' as const),
      seed,
      card: fc.integer({ min: 4_094, max: 4_098 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('dense' as const),
      seed,
      card: fc.integer({ min: 4_097, max: 65_536 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('runs' as const),
      seed,
      runs: fc.integer({ min: 1, max: 3_000 }),
      maxLen: fc.integer({ min: 1, max: 40 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('tie' as const),
      seed,
      runs: fc.oneof(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 1_500 })),
      delta: fc.integer({ min: -1, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('band' as const),
      seed,
      runs: fc.integer({ min: 2_040, max: 2_060 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('holes' as const),
      seed,
      removed: fc.oneof(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 3_000 })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('cluster' as const),
      seed,
      centre: fc.integer({ min: 0, max: 65_535 }),
      width: fc.integer({ min: 8, max: 6_000 }),
      card: fc.integer({ min: 1, max: 4_200 }),
    }),
  },
);

/** A chunk key biased to the ends and the 2^31 boundary (ids at and above 2^31 are chunk keys of 32,768 and more). */
export const chunkKey: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 1, 2, 32_767, 32_768, 65_534, 65_535),
  fc.integer({ min: 0, max: 65_535 }),
);

/** A set of one to `max` chunks. */
export function setSpec(max: number): fc.Arbitrary<SetSpec> {
  return fc.array(fc.record({ key: chunkKey, shape: chunkShape }), {
    minLength: 1,
    maxLength: max,
  });
}

/** A set of one chunk (key 0), so every id is a remainder and its payload is exactly the rule's. */
export const oneChunk: fc.Arbitrary<SetSpec> = fc.array(
  fc.record({ key: fc.constant(0), shape: chunkShape }),
  { minLength: 1, maxLength: 2 },
);

/** A second set related to a first, so a combine has something to find: a subset, a superset, a shift, a copy or a stranger. */
export function relatedTo(
  ids: readonly number[],
  mode: string,
  salt: number,
  stranger: readonly number[],
): number[] {
  const next = prng(salt);
  switch (mode) {
    case 'subset':
      return ids.filter(() => next() < 0.5);
    case 'superset':
      return [...new Set([...ids, ...stranger])].sort((a, b) => a - b);
    case 'shift':
      return ids.map((v) => v + 1).filter((v) => v <= 0xffffffff);
    case 'copy':
      return [...ids];
    default:
      return [...stranger];
  }
}

/** The ids in a deterministic shuffled order with some repeated, as a caller's iterable may arrive. */
export function scrambled(salt: number, ids: readonly number[]): number[] {
  const next = prng(salt);
  const copy = [...ids, ...ids.filter(() => next() < 0.05)];
  return shuffled(salt + 1, copy);
}

// --- Comparison ---------------------------------------------------------------------------------------------------

/** The index of the first difference between two sequences, or -1 when they are equal (a length difference counts). */
export function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** What to print for a difference: where, and the lengths, never the sequences. */
export function describeDifference(
  label: string,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): string {
  const at = firstDifference(a, b);
  return at === -1
    ? label
    : `${label}: first difference at ${at} (lengths ${a.length} and ${b.length})`;
}

/** The ids of `ids` grouped by chunk: ascending chunk key, each with its ascending remainders. */
export function chunksOf(ids: readonly number[]): Array<{ key: number; lows: number[] }> {
  const out: Array<{ key: number; lows: number[] }> = [];
  for (const id of ids) {
    const key = Math.floor(id / 65_536);
    const last = out[out.length - 1];
    if (last !== undefined && last.key === key) last.lows.push(id - key * 65_536);
    else out.push({ key, lows: [id - key * 65_536] });
  }
  return out;
}
