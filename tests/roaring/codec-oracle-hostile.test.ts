import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError } from '@cloudbitmaps/core';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { DeserializationFormat, RoaringBitmap32 } from 'roaring';
import { checkPortableLayout } from '@/portable/layout';
import { bitsetOf, craftPortable, type CraftedContainer } from '../helpers/portable-bytes';
import {
  CODECS,
  buildSet,
  crPlainBytes,
  describeDifference,
  firstDifference,
  prng,
  setSpec,
} from '../helpers/roaring-oracle';
import { heavy } from '../helpers/strength';

/**
 * The hostile-bytes side of the codec oracle: whatever a codec is handed, it must refuse what `portable/layout.ts`
 * refuses, with `IntegrityError`, and accept what it accepts as the same set CRoaring decodes.
 *
 * `layout.ts` is the definition, because it is the one validator in front of every decoder: a codec that accepts
 * bytes it refuses answers `has`, `size` and `maximum` from a bitmap whose invariants are false, and a codec that
 * refuses bytes it accepts turns a readable object into an error. So for each codec in `CODECS`, on every input:
 *
 *   - `safeDeserialize` throws `IntegrityError` exactly when `checkPortableLayout` throws, and nothing else;
 *   - with `whole: true`, it also refuses exactly the buffers that hold bytes after the bitmap;
 *   - past `maxBytes` it refuses before reading;
 *   - what it accepts holds the set CRoaring's own decoder reads from the same bytes, and answers consistently.
 *
 * The inputs are the table of malformed shapes below, then real payloads with bytes overwritten, truncated and
 * extended (`codecOracleMutations` of them: 10,000 on a pull request, 100,000 nightly). The structural check itself is
 * held by `portable-layout.test.ts`; this file holds each codec to it.
 */
const CAP = 1 << 24;

/** `layout.ts`'s verdict: where the bitmap ends, or `undefined` when it refuses. */
function layoutEnd(bytes: Uint8Array): number | undefined {
  try {
    return checkPortableLayout(bytes);
  } catch (err) {
    expect(err).toBeInstanceOf(IntegrityError);
    return undefined;
  }
}

function decode(
  decoder: (bytes: Uint8Array, cap: number, options?: { whole?: boolean }) => CodecBitmap,
  bytes: Uint8Array,
  whole: boolean,
): CodecBitmap | undefined {
  try {
    return decoder(bytes, CAP, { whole });
  } catch (err) {
    expect(err, 'a refusal must be an IntegrityError').toBeInstanceOf(IntegrityError);
    return undefined;
  }
}

/** Holds every codec to the verdict of `layout.ts` on `bytes`. */
function expectVerdict(label: string, bytes: Uint8Array): boolean {
  const end = layoutEnd(bytes);
  let accepted = false;
  for (const { name, codec } of CODECS) {
    const decoder = codec.safeDeserialize.bind(codec);
    const lax = decode(decoder, bytes, false);
    expect(lax !== undefined, `${name}, ${label}: accepts exactly what layout.ts accepts`).toBe(
      end !== undefined,
    );
    const whole = decode(decoder, bytes, true);
    expect(whole !== undefined, `${name}, ${label}: whole refuses bytes after the bitmap`).toBe(
      end !== undefined && end === bytes.byteLength,
    );
    if (lax === undefined) continue;
    accepted = true;
    const cr = RoaringBitmap32.deserialize(bytes, DeserializationFormat.portable);
    const want = cr.toUint32Array();
    const got = lax.toArray();
    expect(
      firstDifference(got, want),
      describeDifference(`${name}, ${label}: contents`, got, want),
    ).toBe(-1);
    expect(lax.size, `${name}, ${label}: size`).toBe(want.length);
    if (lax.maximum !== undefined)
      expect(lax.maximum()).toBe(want.length === 0 ? undefined : want.at(-1));
    for (let i = 0; i < want.length; i += Math.max(1, Math.floor(want.length / 200)))
      expect(lax.has(want[i]!), `${name}, ${label}: has(${want[i]})`).toBe(true);
    // Iteration agrees with toArray; a dense payload is walked once in 16 mutations, since it costs the most.
    if (want.length <= 5_000 || (want.length & 15) === 0) {
      expect(firstDifference([...lax], want), `${name}, ${label}: iteration`).toBe(-1);
    }
  }
  return accepted;
}

const allBits = new Uint8Array(8_192).fill(0xff);
const HOSTILE: ReadonlyArray<{ name: string; containers: CraftedContainer[]; offsets?: number[] }> =
  [
    {
      name: 'containers out of order',
      containers: [
        { key: 1, kind: 'array', values: [5] },
        { key: 0, kind: 'array', values: [7] },
      ],
    },
    {
      name: 'a container key listed twice',
      containers: [
        { key: 0, kind: 'array', values: [5] },
        { key: 0, kind: 'array', values: [7] },
      ],
    },
    { name: 'array values out of order', containers: [{ key: 0, kind: 'array', values: [9, 3] }] },
    { name: 'array values repeated', containers: [{ key: 0, kind: 'array', values: [3, 3] }] },
    {
      name: 'runs overlapping',
      containers: [
        {
          key: 0,
          kind: 'run',
          runs: [
            [0, 10],
            [5, 3],
          ],
        },
      ],
    },
    {
      name: 'runs touching',
      containers: [
        {
          key: 0,
          kind: 'run',
          runs: [
            [0, 3],
            [4, 3],
          ],
        },
      ],
    },
    {
      name: 'a run past the end of its container',
      containers: [{ key: 0, kind: 'run', runs: [[65_530, 20]] }],
    },
    {
      name: 'a run container with no runs',
      containers: [{ key: 0, kind: 'run', runs: [], cardinality: 1 }],
    },
    {
      name: 'a bitset whose cardinality is too low',
      containers: [{ key: 0, kind: 'bitset', bits: allBits, cardinality: 5_000 }],
    },
    {
      name: 'a bitset whose cardinality is too high',
      containers: [{ key: 0, kind: 'bitset', bits: bitsetOf([1, 2]), cardinality: 3 }],
    },
    {
      name: 'a run container whose cardinality is not what its runs cover',
      containers: [{ key: 0, kind: 'run', runs: [[0, 9]], cardinality: 4 }],
    },
    {
      name: 'an offset that is not where its container starts',
      containers: [
        { key: 0, kind: 'array', values: [1] },
        { key: 1, kind: 'array', values: [2] },
      ],
      offsets: [24, 99],
    },
  ];

describe('the codec oracle: hostile bytes', () => {
  it.each(HOSTILE.map((h) => [h.name, h] as const))('refuses %s', (_name, h) => {
    expect(
      layoutEnd(craftPortable(h.containers, { offsets: h.offsets })),
      'layout.ts refuses it',
    ).toBeUndefined();
    expectVerdict(h.name, craftPortable(h.containers, { offsets: h.offsets }));
  });

  it('accepts the valid twin of each shape, and nothing a writer writes is refused', () => {
    const valid: CraftedContainer[][] = [
      [{ key: 0, kind: 'array', values: [3, 9] }],
      [
        {
          key: 0,
          kind: 'run',
          runs: [
            [0, 10],
            [20, 3],
          ],
        },
      ],
      [{ key: 0, kind: 'bitset', bits: allBits }],
      [
        { key: 0, kind: 'array', values: [1] },
        { key: 7, kind: 'array', values: [2] },
      ],
    ];
    for (const containers of valid) {
      expect(expectVerdict('valid twin', craftPortable(containers))).toBe(true);
    }
  });

  it('refuses a buffer longer than its cap', () => {
    const bytes = crPlainBytes([1, 2, 3], 'plain');
    for (const { name, codec } of CODECS) {
      expect(() => codec.safeDeserialize(bytes, bytes.length - 1), name).toThrow(IntegrityError);
      expect(() => codec.safeDeserialize(bytes, bytes.length), name).not.toThrow();
    }
  });

  it('refuses two bitmaps back to back when asked for one, and reads the first when not', () => {
    const one = crPlainBytes([5, 6], 'plain');
    const two = new Uint8Array([...one, ...crPlainBytes([9], 'plain')]);
    for (const { name, codec } of CODECS) {
      expect(() => codec.safeDeserialize(two, CAP, { whole: true }), name).toThrow(IntegrityError);
      expect(codec.safeDeserialize(two, CAP).toArray(), name).toEqual([5, 6]);
    }
  });
});

/**
 * A portable bitmap of array containers under the run cookie (12347), which `craftPortable` never writes for arrays
 * alone: the count is in the cookie's high half, `flags` is the run-flag bytes (all clear by default), and the offset
 * header is present from four containers up, as the format says.
 */
function crafted12347(
  containers: ReadonlyArray<{ key: number; values: number[] }>,
  options: { flags?: number[]; offsets?: boolean | number[] } = {},
): Uint8Array {
  const n = containers.length;
  const flagBytes = (n + 7) >>> 3;
  const flags = options.flags ?? new Array<number>(flagBytes).fill(0);
  const withOffsets = options.offsets === undefined ? n >= 4 : options.offsets !== false;
  const header = 4 + flagBytes + 4 * n + (withOffsets ? 4 * n : 0);
  const out = new Uint8Array(header + containers.reduce((sum, c) => sum + 2 * c.values.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, (12_347 | ((n - 1) << 16)) >>> 0, true);
  flags.forEach((f, i) => (out[4 + i] = f));
  let at = header;
  containers.forEach((c, i) => {
    view.setUint16(4 + flagBytes + 4 * i, c.key, true);
    view.setUint16(6 + flagBytes + 4 * i, c.values.length - 1, true);
    if (withOffsets) {
      const given = Array.isArray(options.offsets) ? options.offsets[i] : undefined;
      view.setUint32(4 + flagBytes + 4 * n + 4 * i, given ?? at, true);
    }
    c.values.forEach((v, k) => view.setUint16(at + 2 * k, v, true));
    at += 2 * c.values.length;
  });
  return out;
}

/** A cookie and a count, and nothing else, or with `tail` after them. */
function headerOnly(cookie: number, count: number, tail = 0): Uint8Array {
  const out = new Uint8Array(8 + tail);
  new DataView(out.buffer).setUint32(0, cookie, true);
  new DataView(out.buffer).setUint32(4, count, true);
  return out;
}

describe('the codec oracle: the header', () => {
  const four = [
    { key: 0, values: [1, 2] },
    { key: 1, values: [3] },
    { key: 5, values: [4, 9] },
    { key: 9, values: [7] },
  ];

  it('accepts a run cookie with every run flag clear: containers that are all arrays', () => {
    const one = crafted12347([{ key: 0, values: [3, 9, 10] }]);
    expect(layoutEnd(one), 'layout.ts accepts it').toBe(one.byteLength);
    expect(expectVerdict('12347, one array, no run flag', one)).toBe(true);
    const many = crafted12347(four);
    expect(layoutEnd(many), 'layout.ts accepts four containers with offsets').toBe(many.byteLength);
    expect(expectVerdict('12347, four arrays, no run flag, with offsets', many)).toBe(true);
    for (const { name, codec } of CODECS) {
      expect(codec.safeDeserialize(many, CAP, { whole: true }).toArray(), name).toEqual([
        1,
        2,
        65_536 + 3,
        5 * 65_536 + 4,
        5 * 65_536 + 9,
        9 * 65_536 + 7,
      ]);
    }
  });

  it('answers as layout.ts does for a run cookie over four or more containers', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['four arrays, offsets absent', crafted12347(four, { offsets: false })],
      ['four arrays, a wrong offset', crafted12347(four, { offsets: [32, 99, 36, 40] })],
      ['four arrays, one run flag set on an array', crafted12347(four, { flags: [0b0000_0100] })],
      ['five arrays, offsets', crafted12347([...four, { key: 20, values: [1] }])],
      [
        'eight arrays, two flag bytes',
        crafted12347(Array.from({ length: 8 }, (_, i) => ({ key: i, values: [i] }))),
      ],
      [
        'nine arrays, two flag bytes',
        crafted12347(Array.from({ length: 9 }, (_, i) => ({ key: i, values: [i] }))),
      ],
      [
        'four containers, a run among them',
        craftPortable([
          { key: 0, kind: 'array', values: [1] },
          { key: 1, kind: 'run', runs: [[5, 20]] },
          { key: 2, kind: 'array', values: [3] },
          { key: 3, kind: 'bitset', bits: allBits },
        ]),
      ],
    ];
    for (const [name, bytes] of cases) expectVerdict(name, bytes);
    expect(
      layoutEnd(crafted12347(four, { offsets: false })),
      'no offset header from four on',
    ).toBeUndefined();
    expect(
      layoutEnd(crafted12347(four, { offsets: [32, 99, 36, 40] })),
      'a wrong offset',
    ).toBeUndefined();
  });

  it('refuses a cookie that is neither 12346 nor 12347', () => {
    const valid = crPlainBytes([1, 2, 3], 'plain');
    for (const cookie of [0, 1, 12_345, 12_348, 0x303a_0000, 0xffff_ffff, 12_346 | 0x1_0000]) {
      const bytes = valid.slice();
      new DataView(bytes.buffer).setUint32(0, cookie >>> 0, true);
      const shown = `cookie ${cookie}`;
      if (cookie === 12_346 || (cookie & 0xffff) === 12_347) continue;
      expect(layoutEnd(bytes), `layout.ts refuses ${shown}`).toBeUndefined();
      expectVerdict(shown, bytes);
    }
  });

  it('answers as layout.ts does for a container count of 0, 65,536 and above', () => {
    const empty = headerOnly(12_346, 0);
    expect(layoutEnd(empty), 'layout.ts reads count 0 as the empty bitmap').toBe(8);
    expect(expectVerdict('count 0', empty)).toBe(true);
    for (const { name, codec } of CODECS) {
      const none = codec.safeDeserialize(empty, CAP, { whole: true });
      expect([none.size, none.isEmpty, none.toArray()], name).toEqual([0, true, []]);
    }

    // The largest count: 65,536 containers of one value each, every key once.
    const most = craftPortable(
      Array.from({ length: 65_536 }, (_, key) => ({
        key,
        kind: 'array' as const,
        values: [key & 0xff],
      })),
    );
    expect(layoutEnd(most), 'layout.ts accepts 65,536 containers').toBe(most.byteLength);
    expect(expectVerdict('count 65,536', most)).toBe(true);

    // One more is more than the 16 bits of a key can name: a header that says so, with room for its descriptors.
    for (const count of [65_537, 65_538, 0x7fff_ffff, 0xffff_ffff]) {
      const room = count <= 70_000 ? 8 * count : 64;
      const bytes = headerOnly(12_346, count, room);
      expect(layoutEnd(bytes), `layout.ts refuses count ${count}`).toBeUndefined();
      expectVerdict(`count ${count}`, bytes);
    }
  });

  it('reads a zero-length buffer as the empty bitmap, as layout.ts does', () => {
    expect(layoutEnd(new Uint8Array(0)), 'layout.ts').toBe(0);
    expect(expectVerdict('zero-length buffer', new Uint8Array(0))).toBe(true);
    for (const { name, codec } of CODECS) {
      expect(
        codec.safeDeserialize(new Uint8Array(0), CAP, { whole: true }).toArray(),
        name,
      ).toEqual([]);
    }
  });

  it('refuses every truncation inside the header and the bodies, for both cookies', () => {
    const sources: Array<[string, Uint8Array]> = [
      [
        '12346, two containers',
        craftPortable([
          { key: 0, kind: 'array', values: [1, 2] },
          { key: 3, kind: 'array', values: [9] },
        ]),
      ],
      [
        '12347, four containers with a run',
        craftPortable([
          { key: 0, kind: 'array', values: [1, 2] },
          { key: 1, kind: 'run', runs: [[10, 5]] },
          { key: 2, kind: 'array', values: [3] },
          { key: 3, kind: 'array', values: [4] },
        ]),
      ],
      ['12347, one run', craftPortable([{ key: 0, kind: 'run', runs: [[0, 9]] }])],
      ['12347, no run flag, four arrays', crafted12347(four)],
    ];
    for (const [name, full] of sources) {
      expect(layoutEnd(full), `${name}: whole`).toBe(full.byteLength);
      expect(expectVerdict(`${name}, whole`, full)).toBe(true);
      for (let length = 1; length < full.byteLength; length++) {
        const cut = full.slice(0, length);
        expect(
          layoutEnd(cut),
          `${name}: layout.ts refuses ${length} of ${full.byteLength} bytes`,
        ).toBeUndefined();
        expectVerdict(`${name}, cut at ${length}`, cut);
      }
    }
  });
});

describe('the codec oracle: mutated real payloads', () => {
  it('holds every codec to layout.ts on overwritten, truncated and extended payloads', () => {
    const total = heavy('codecOracleMutations');
    const cases = 100;
    const each = Math.ceil(total / cases);
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(
        setSpec(2),
        fc.constantFrom('plain', 'runs', 'ranges'),
        fc.integer({ min: 0, max: 0x7fffffff }),
        (spec, how, seed) => {
          const ids = buildSet(spec).slice(0, 70_000);
          const source = new Uint8Array(crPlainBytes(ids, how));
          const next = prng(seed);
          for (let i = 0; i < each; i++) {
            const bytes = mutate(source, next);
            if (expectVerdict(`mutation ${i} of seed ${seed}`, bytes)) accepted++;
            else refused++;
          }
        },
      ),
      { numRuns: cases },
    );
    // Both outcomes must be common, or the fuzz is only testing one side of the verdict.
    expect(accepted, 'mutations a decoder accepts').toBeGreaterThan(total / 50);
    expect(refused, 'mutations a decoder refuses').toBeGreaterThan(total / 50);
  }, 600_000);
});

/** One mutation of `source`: half the overwrites land in the first 48 bytes, where the header is. */
function mutate(source: Uint8Array, next: () => number): Uint8Array {
  const kind = next();
  if (kind < 0.7) {
    const bytes = source.slice();
    for (let n = 1 + Math.floor(next() * 3); n > 0; n--) {
      const span = next() < 0.5 ? Math.min(48, bytes.length) : bytes.length;
      bytes[Math.floor(next() * span)] = Math.floor(next() * 256);
    }
    return bytes;
  }
  if (kind < 0.85) return source.slice(0, Math.floor(next() * source.length));
  return new Uint8Array([
    ...source,
    ...Array.from({ length: 1 + Math.floor(next() * 8) }, () => Math.floor(next() * 256)),
  ]);
}
