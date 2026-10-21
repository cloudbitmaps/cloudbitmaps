/**
 * The window of ids a read with a range is cut to, held against the plain definition of `(after, through]`: an id is in
 * the window when it is above `after` and at most `through`, and a chunk key is in its span when some id of the chunk is.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHUNK_COUNT, joinId, MAX_REMAINDER, U32_MAX } from '@/core/bit-route';
import {
  assertIdBound,
  cutToWindow,
  edgeIds,
  firstAbove,
  isEdge,
  keysAbove,
  keysWithin,
  remaindersWithin,
  WHOLE_ID_SPACE,
  windowOf as windowOfVerb,
} from '@/core/id-window';
import type { IdWindow } from '@/core/id-window';

/** The window for a read that no error is expected of: the verb only matters to a refusal. */
const windowOf = (range: Parameters<typeof windowOfVerb>[0]) => windowOfVerb(range, 'iterate');
import { ValidationError } from '@/core/errors';
import { roaringCodec } from '@/native-codec';

const inWindow = (id: number, after: number | undefined, through: number | undefined): boolean =>
  (after === undefined || id > after) && (through === undefined || id <= through);

/** Ids that land on and around chunk boundaries as often as inside a chunk. */
const anId = fc.oneof(
  fc.integer({ min: 0, max: U32_MAX }),
  fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.constantFrom(0, 1, MAX_REMAINDER - 1, MAX_REMAINDER))
    .map(([k, r]) => joinId(k, r)),
  fc.constantFrom(0, U32_MAX, U32_MAX - 1),
);
const aBound = fc.option(anId, { nil: undefined });
const ascendingKeys = fc
  .uniqueArray(fc.integer({ min: 0, max: 8 }), { maxLength: 9 })
  .map((k) => k.sort((a, b) => a - b));
const remainders = fc
  .uniqueArray(
    fc.oneof(fc.integer({ min: 0, max: MAX_REMAINDER }), fc.constantFrom(0, 5, 6, MAX_REMAINDER)),
    { maxLength: 40 },
  )
  .map((r) => r.sort((a, b) => a - b));

describe('windowOf', () => {
  it('is null for no range, so a read without one does no extra work', () => {
    expect(windowOf(undefined)).toBeNull();
    expect(windowOf({})).toBeNull();
    expect(windowOf({ after: undefined, through: undefined })).toBeNull();
  });

  it("is 'empty' when no id can be in it, and otherwise holds each end's chunk key and remainder", () => {
    fc.assert(
      fc.property(aBound, aBound, (after, through) => {
        const w = windowOf({ after, through });
        const lo = after === undefined ? 0 : after + 1;
        const hi = through ?? U32_MAX;
        if (after === undefined && through === undefined) expect(w).toBeNull();
        else if (lo > hi) expect(w).toBe('empty');
        else {
          expect(w).toEqual({
            loKey: Math.floor(lo / CHUNK_COUNT),
            loRem: lo % CHUNK_COUNT,
            hiKey: Math.floor(hi / CHUNK_COUNT),
            hiRem: hi % CHUNK_COUNT,
          });
        }
      }),
    );
  });

  it('refuses a bound that is not an id, naming the bound and never its value', () => {
    for (const [range, name] of [
      [{ after: -1 }, 'after'],
      [{ after: 1.5 }, 'after'],
      [{ after: U32_MAX + 1 }, 'after'],
      [{ through: -1 }, 'through'],
      [{ through: Number.NaN }, 'through'],
      [{ after: 3, through: U32_MAX + 1 }, 'through'],
    ] as const) {
      expect(() => windowOfVerb(range, 'iterate')).toThrow(ValidationError);
      for (const verb of [
        'iterate',
        'intersect',
        'union',
        'andNot',
        'everyNth',
        'materializeMany',
      ]) {
        expect(() => windowOfVerb(range, verb)).toThrow(
          `${verb}: ${name} must be an integer from 0 to ${U32_MAX}`,
        );
      }
    }
    // The ends of the id space are ids.
    expect(windowOf({ after: 0, through: U32_MAX })).not.toBe('empty');
    expect(windowOf({ after: U32_MAX })).toBe('empty');
    expect(() => assertIdBound('after', undefined, 'iterate')).not.toThrow();
    expect(() => assertIdBound('through', U32_MAX, 'iterate')).not.toThrow();
  });

  it('describes every id with the whole id space', () => {
    expect(windowOf({ after: undefined, through: U32_MAX })).toEqual(WHOLE_ID_SPACE);
  });
});

describe('the chunk keys a window reads', () => {
  it('keysWithin keeps exactly the keys of chunks that can hold an id of the window', () => {
    fc.assert(
      fc.property(ascendingKeys, anId, anId, (keys, x, y) => {
        const w = windowOf({
          after: Math.min(x, y) % (9 * CHUNK_COUNT),
          through: Math.max(x, y) % (9 * CHUNK_COUNT),
        });
        if (w === null || w === 'empty') return;
        expect(keysWithin(keys, w)).toEqual(keys.filter((k) => k >= w.loKey && k <= w.hiKey));
      }),
    );
  });

  it('keysWithin is a new array, so a caller may keep or change it', () => {
    const keys = [1, 2, 3];
    const got = keysWithin(keys, WHOLE_ID_SPACE);
    expect(got).toEqual(keys);
    expect(got).not.toBe(keys);
  });

  it('keysAbove keeps the keys inside the window and above the key a read last took', () => {
    fc.assert(
      fc.property(
        ascendingKeys,
        fc.option(fc.tuple(anId, anId), { nil: undefined }),
        fc.integer({ min: -1, max: 9 }),
        (keys, ends, after) => {
          const w =
            ends === undefined
              ? null
              : windowOf({ after: Math.min(...ends), through: Math.max(...ends) });
          if (w === 'empty') return;
          const span = w ?? WHOLE_ID_SPACE;
          expect(keysAbove(keys, w, after)).toEqual(
            keys.filter((k) => k > after && k >= span.loKey && k <= span.hiKey),
          );
        },
      ),
    );
  });
});

describe('the edge chunks of a window', () => {
  it('isEdge is true only where a bound falls inside the chunk', () => {
    fc.assert(
      fc.property(
        aBound,
        aBound,
        fc.integer({ min: 0, max: CHUNK_COUNT - 1 }),
        // Most keys are drawn at the window's edges and just outside them, where the answer turns.
        fc.constantFrom('any', 'lo-1', 'lo', 'hi', 'hi+1'),
        (after, through, any, at) => {
          const w = windowOf({ after, through });
          if (w === null || w === 'empty') return;
          const key = {
            any,
            'lo-1': w.loKey - 1,
            lo: w.loKey,
            hi: w.hiKey,
            'hi+1': w.hiKey + 1,
          }[at];
          if (key < 0 || key >= CHUNK_COUNT) return;
          const first = joinId(key, 0);
          const last = joinId(key, MAX_REMAINDER);
          const lo = after === undefined ? 0 : after + 1;
          const hi = through ?? U32_MAX;
          const whole = inWindow(first, after, through) && inWindow(last, after, through);
          const none = last < lo || first > hi;
          expect(isEdge(key, w)).toBe(!whole && !none);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('edgeIds, remaindersWithin and cutToWindow keep exactly the ids of the chunk inside the window', () => {
    fc.assert(
      fc.property(remainders, fc.integer({ min: 0, max: 3 }), aBound, aBound, (rem, key, x, y) => {
        const after = x === undefined ? undefined : x % (4 * CHUNK_COUNT);
        const through = y === undefined ? undefined : y % (4 * CHUNK_COUNT);
        const w = windowOf({ after, through });
        if (w === null || w === 'empty' || key < w.loKey || key > w.hiKey) return;
        const want = rem.filter((r) => inWindow(joinId(key, r), after, through));
        const chunk = roaringCodec.fromValues(Uint32Array.from(rem));
        expect([...edgeIds(chunk, key, w)]).toEqual(want.map((r) => joinId(key, r)));
        expect([...remaindersWithin(Uint32Array.from(rem), key, w)]).toEqual(want);
        expect([...cutToWindow(roaringCodec, chunk, key, w)]).toEqual(want);
      }),
    );
  });

  it('remaindersWithin is a view of the array it cuts, not a copy', () => {
    const rem = Uint32Array.from([1, 5, 9]);
    const w = windowOf({ after: 1, through: 8 }) as IdWindow;
    const view = remaindersWithin(rem, 0, w);
    expect([...view]).toEqual([5]);
    expect(view.buffer).toBe(rem.buffer);
  });

  it('firstAbove is the index of the first value greater than the one asked', () => {
    fc.assert(
      fc.property(remainders, fc.integer({ min: -1, max: MAX_REMAINDER }), (rem, v) => {
        const a = Uint32Array.from(rem);
        const i = firstAbove(a, v);
        expect(i).toBe(rem.filter((r) => r <= v).length);
      }),
    );
  });
});
