import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoaringBitmap } from '@/index';
import { runBitmapOps } from '@/testing/fuzz-bitmap-ops';

/**
 * The committed `bitmap-ops` reproducers for the counting methods: two start from a decode that holds an array, a
 * bitset and a run container and make the target call every counting method; the third has no bitmap bytes and asks every
 * counting method to take a value that is not a bitmap. The target's check is shown to fire
 * on a wrong count and on a non-bitmap operand that is accepted, and to stay quiet on right ones. Which container pairs a
 * count compares is the public count suite's to prove, not these files'.
 */
const DIR = join(__dirname, '../core/crbm/fuzz-corpus/bitmap-ops');
const MODEL_LIMIT = 20_000;
const METHODS = [
  'andCardinality',
  'orCardinality',
  'xorCardinality',
  'andNotCardinality',
  'intersects',
  'isSubset',
  'isEqual',
] as const;

/** The bitmap bytes at the head of a reproducer: `[u16 n][n bytes]`. */
function bitmapBytes(file: Uint8Array): Uint8Array {
  return file.subarray(2, 2 + (file[0] as number) + ((file[1] as number) << 8));
}

/** The container kinds a portable bitmap holds, read from its header (the run cookie, its run flags, the cardinalities). */
function kindsOf(bytes: Uint8Array): Set<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cookie = view.getUint32(0, true);
  expect(cookie & 0xffff, 'the run-capable cookie').toBe(12347);
  const count = (cookie >>> 16) + 1;
  const flags = 4;
  const header = flags + Math.ceil(count / 8);
  const kinds = new Set<string>();
  for (let i = 0; i < count; i++) {
    const isRun = ((bytes[flags + (i >> 3)] as number) >> (i & 7)) & 1;
    const card = view.getUint16(header + 4 * i + 2, true) + 1;
    kinds.add(isRun ? 'run' : card > 4096 ? 'bitset' : 'array');
  }
  return kinds;
}

const REFUSAL_FILE = 'counts-refuse-non-bitmaps.bin';
const FILES = ['counts-on-a-bitset-array-and-run.bin', 'counts-at-the-model-limit.bin'];

describe('the counting reproducers of the bitmap-ops target', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(FILES)('%s starts from an array, a bitset and a run, inside the model limit', (name) => {
    const file = readFileSync(join(DIR, name));
    expect(kindsOf(bitmapBytes(file))).toEqual(new Set(['array', 'bitset', 'run']));
    const start = RoaringBitmap.deserialize(bitmapBytes(file));
    expect(start.size).toBeLessThanOrEqual(MODEL_LIMIT);
  });

  it('the one at the limit holds exactly as many ids as the model keeps whole', () => {
    const file = readFileSync(join(DIR, 'counts-at-the-model-limit.bin'));
    expect(RoaringBitmap.deserialize(bitmapBytes(file)).size).toBe(MODEL_LIMIT);
  });

  it.each(FILES)('%s makes the target call every counting method, and passes', (name) => {
    const spies = METHODS.map((m) => vi.spyOn(RoaringBitmap.prototype, m));
    runBitmapOps(readFileSync(join(DIR, name)));
    METHODS.forEach((m, i) =>
      expect(spies[i]?.mock.calls.length, `${m} called`).toBeGreaterThan(0),
    );
  });

  it.each(METHODS)('a wrong %s is a finding', (method) => {
    const file = readFileSync(join(DIR, FILES[0] as string));
    const real = RoaringBitmap.prototype[method] as (o: RoaringBitmap) => number | boolean;
    vi.spyOn(RoaringBitmap.prototype, method).mockImplementation(function (
      this: RoaringBitmap,
      other: RoaringBitmap,
    ) {
      const answer = real.call(this, other);
      return typeof answer === 'boolean' ? !answer : answer + 1;
    } as never);
    expect(() => runBitmapOps(file)).toThrow(new RegExp(`bitmap-ops: .*${method}`));
  });

  it.each(METHODS)(
    '%s is asked for a non-bitmap by the refusal reproducer, and refuses',
    (method) => {
      const asked = vi.spyOn(RoaringBitmap.prototype, method);
      runBitmapOps(readFileSync(join(DIR, REFUSAL_FILE)));
      const strangers = asked.mock.calls.filter(([other]) => !(other instanceof RoaringBitmap));
      expect(strangers.length, `${method} called with a non-bitmap`).toBeGreaterThan(0);
    },
  );

  it.each(METHODS)('%s accepting a non-bitmap is a finding', (method) => {
    const file = readFileSync(join(DIR, REFUSAL_FILE));
    const real = RoaringBitmap.prototype[method] as (o: RoaringBitmap) => number | boolean;
    vi.spyOn(RoaringBitmap.prototype, method).mockImplementation(function (
      this: RoaringBitmap,
      other: unknown,
    ) {
      return other instanceof RoaringBitmap ? real.call(this, other) : 0;
    } as never);
    expect(() => runBitmapOps(file)).toThrow(
      new RegExp(`${method} with a non-bitmap: was accepted`),
    );
  });
});
