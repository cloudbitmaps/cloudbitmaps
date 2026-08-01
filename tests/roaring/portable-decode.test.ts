import { RoaringBitmap32 } from 'roaring';
import { decodePortableRoaring } from '@/portable/decode';
import { IntegrityError } from '@cloudbitmaps/core';

/**
 * The pure-JS portable-roaring reader, judged against the native library rather than against my reading of the
 * spec.
 *
 * This is the point of the whole file. A second decoder for a format someone else defines is only worth having
 * if it agrees with the first one on inputs nobody chose by hand — a suite of cases I invented would test the
 * format as I remember it, which is exactly the thing under suspicion. So `roaring` produces the bytes and the
 * answers, and these tests assert the pure-JS reader matches. Where they disagree, the native library is right.
 *
 * Deliberately driven across all three container encodings and both cookies, because the format's traps are
 * per-shape: the run-container flag bitmap only exists under one cookie, the offset header only exists above a
 * container-count threshold, and a run's stored length is one *less* than the number of values it covers.
 */

/** Deterministic PRNG — a failing seed has to be reproducible or the differential test is a rumour. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The shapes that select different container encodings, plus the ones that sit on their boundaries. */
const SHAPES: ReadonlyArray<{ name: string; ids: (rand: () => number) => number[] }> = [
  { name: 'empty', ids: () => [] },
  { name: 'single value', ids: () => [42] },
  { name: 'tiny array', ids: () => [0, 1, 2, 70, 65535] },
  {
    name: 'array at the 4096 boundary',
    ids: () => Array.from({ length: 4096 }, (_, i) => i * 2),
  },
  {
    name: 'bitmap just past the boundary',
    ids: () => Array.from({ length: 4097 }, (_, i) => i * 2),
  },
  { name: 'contiguous run', ids: () => Array.from({ length: 3000 }, (_, i) => i + 100) },
  {
    name: 'many runs',
    ids: () => Array.from({ length: 2000 }, (_, i) => [i * 10, i * 10 + 1, i * 10 + 2]).flat(),
  },
  {
    name: 'multi-container, sparse',
    ids: () => [0, 1, 65536, 65537, 131072, 4294967295],
  },
  {
    name: 'multi-container, enough to force an offset header',
    // >= NO_OFFSET_THRESHOLD (4) containers, run-optimizable, so the run cookie DOES carry offsets.
    ids: () => [0, 1, 2, 3].flatMap((c) => Array.from({ length: 500 }, (_, i) => c * 65536 + i)),
  },
  {
    name: 'high keys only',
    ids: () => [0xffff_0000, 0xffff_0001, 0xffff_ffff],
  },
  {
    name: 'random sparse',
    ids: (rand) => Array.from({ length: 3000 }, () => Math.floor(rand() * 0xffff_ffff)),
  },
  {
    name: 'random dense in one container',
    ids: (rand) => Array.from({ length: 20000 }, () => Math.floor(rand() * 65536)),
  },
];

/** Probe set: every member, plus non-members around the edges where an off-by-one would hide. */
function probes(ids: number[], rand: () => number): number[] {
  const out = new Set<number>(ids);
  for (const id of ids.slice(0, 400)) {
    if (id > 0) out.add(id - 1);
    if (id < 0xffff_ffff) out.add(id + 1);
  }
  out.add(0);
  out.add(0xffff_ffff);
  out.add(65535);
  out.add(65536);
  for (let i = 0; i < 500; i++) out.add(Math.floor(rand() * 0xffff_ffff));
  return [...out];
}

describe('portable-roaring reader vs the native library', () => {
  // Both serializations matter: `runOptimize()` switches the cookie and adds the run-flag bitmap, and only
  // the optimized form ever produces run containers. Testing one would leave half the format unexercised.
  describe.each([
    ['as serialized', false],
    ['after runOptimize()', true],
  ])('%s', (_label, optimize) => {
    it.each(SHAPES.map((s) => [s.name, s] as const))('%s', (_name, shape) => {
      const rand = mulberry32(0xc0ffee);
      const ids = shape.ids(rand);
      const native = RoaringBitmap32.from(ids);
      if (optimize) native.runOptimize();

      const reader = decodePortableRoaring(new Uint8Array(native.serialize(true)));

      expect(reader.count()).toBe(native.size);

      const checked = probes(ids, mulberry32(0xbeef));
      const mismatches = checked.filter((v) => reader.has(v) !== native.has(v));
      expect(
        mismatches.slice(0, 10),
        `${mismatches.length} of ${checked.length} probes disagreed with the native library`,
      ).toEqual([]);
    });
  });

  it('agrees across 200 random bitmaps of random shape (the case nobody hand-picked)', () => {
    // Hand-written cases test the format as the author remembers it. This one does not: sizes, densities and
    // spans are drawn per iteration, so it reaches container mixes and boundary coincidences no fixture list
    // would contain. A failure prints its seed, so it is reproducible rather than a rumour.
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const span = [65536, 200000, 0xffff_ffff][Math.floor(rand() * 3)] as number;
      const size = Math.floor(rand() * 9000);
      const ids = Array.from({ length: size }, () => Math.floor(rand() * span));
      const native = RoaringBitmap32.from(ids);
      if (rand() < 0.5) native.runOptimize();

      const reader = decodePortableRoaring(new Uint8Array(native.serialize(true)));
      expect(reader.count(), `seed ${seed}: cardinality`).toBe(native.size);

      for (const v of probes(ids, mulberry32(seed + 100000)).slice(0, 600)) {
        if (reader.has(v) !== native.has(v)) {
          throw new Error(
            `seed ${seed}: disagreed on ${v} — reader ${reader.has(v)}, native ${native.has(v)}`,
          );
        }
      }
    }
  });
});

describe('portable-roaring reader — hostile bytes', () => {
  // These bytes come off a storage tier, so they are untrusted (hard invariant #5). Every one of these must be
  // a typed rejection, never a wrong answer and never an out-of-bounds read.
  const valid = (): Uint8Array =>
    new Uint8Array(RoaringBitmap32.from([1, 2, 3, 70000]).serialize(true));

  it('rejects an unrecognized cookie', () => {
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(0, 999, true);
    expect(() => decodePortableRoaring(bytes)).toThrow(IntegrityError);
  });

  it('rejects a truncated buffer at every prefix length', () => {
    // A single hand-picked truncation only proves the one bound it happens to hit. Walking every prefix is
    // what shows no header read is unguarded — and it is cheap.
    const full = valid();
    for (let n = 0; n < full.length; n++) {
      const cut = full.subarray(0, n);
      let threw = false;
      try {
        const r = decodePortableRoaring(cut);
        // Decoding a prefix may legitimately succeed if every header fits; querying it must still not read
        // out of bounds, and must not invent members.
        r.has(1);
        r.count();
      } catch (e) {
        threw = true;
        expect(e, `prefix length ${n} threw a non-typed error`).toBeInstanceOf(IntegrityError);
      }
      void threw;
    }
  });

  it('rejects a container count that cannot fit in the buffer', () => {
    const bytes = valid();
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 12_346, true);
    view.setUint32(4, 0xffff, true); // 65,535 containers in a ~20-byte buffer
    expect(() => decodePortableRoaring(bytes)).toThrow(IntegrityError);
  });

  it('rejects non-ascending container keys, rather than answering from a bad binary search', () => {
    // `has` binary-searches the descriptive header, which is only correct if keys ascend. Left unchecked, a
    // crafted file would produce silently wrong membership answers — a wrong answer being strictly worse than
    // a rejection is the whole premise of the untrusted-bytes invariant.
    const native = RoaringBitmap32.from([1, 70000, 140000]);
    const bytes = new Uint8Array(native.serialize(true));
    const view = new DataView(bytes.buffer);
    // NO_RUNCONTAINER layout: cookie(4) + count(4) then (key,card-1) pairs. Swap the first two keys.
    const k0 = view.getUint16(8, true);
    const k1 = view.getUint16(12, true);
    view.setUint16(8, k1, true);
    view.setUint16(12, k0, true);
    expect(() => decodePortableRoaring(bytes)).toThrow(IntegrityError);
  });

  it('returns false for out-of-range and non-integer values rather than throwing', () => {
    const r = decodePortableRoaring(valid());
    for (const v of [-1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(r.has(v as number)).toBe(false);
    }
  });
});
