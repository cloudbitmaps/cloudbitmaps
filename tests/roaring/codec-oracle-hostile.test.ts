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
