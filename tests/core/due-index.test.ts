/**
 * The due index — the structure that makes a retention cycle cost what is EXPIRING rather than what the fleet
 * HOLDS. Foundation only: encoding, bucket maths and the reserved-namespace rules. Wiring it into the sweep is
 * the next PR.
 *
 * The property under test throughout is **reversibility**: an index row's name is the only place the original
 * ref is recorded, so if `decode(encode(ref))` is ever not `ref`, the sweep retires the wrong segment or none.
 */
import { describe, expect, it } from 'vitest';
import {
  DUE_BUCKET_MS,
  DUE_NAMESPACE_PREFIX,
  MAX_NAME_LENGTH,
  canIndex,
  decodeDueName,
  dueBucket,
  dueBucketsAt,
  dueIndexRef,
  dueNamespace,
  encodeDueName,
  isDueIndexRow,
} from '@/index';
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/index';

const NAME_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

describe('due index — encoding round-trips', () => {
  const refs = [
    { segment: 'vips' },
    { namespace: 'prod', segment: 'vips' },
    // Every character the grammar allows appears in both parts — no separator could be unambiguous on its own,
    // which is exactly why the encoding is length-prefixed rather than delimited.
    { namespace: 'a.b-c_d', segment: 'e.f-g_h' },
    { namespace: 'd-2026-08-05', segment: 'd-2026-08-05' },
    { namespace: '0', segment: '0' },
    { namespace: '9.9.9', segment: '1.2.3' },
    // A namespace that looks like the length prefix itself.
    { namespace: '12', segment: '34' },
    { segment: 'x'.repeat(200) },
    { namespace: 'n'.repeat(120), segment: 's'.repeat(120) },
  ];

  for (const ref of refs) {
    it(`round-trips ${JSON.stringify(ref)}`, () => {
      const name = encodeDueName(ref);
      expect(NAME_GRAMMAR.test(name)).toBe(true); // the encoded name must itself be a legal segment name
      expect(name).not.toContain('..');
      expect(decodeDueName(name)).toEqual(ref);
    });
  }

  it('distinguishes refs that a naive delimiter would collide', () => {
    // Classic ambiguity: "a.b" + "c" vs "a" + "b.c" both concatenate to "a.bc" under a dot delimiter.
    const left = encodeDueName({ namespace: 'a.b', segment: 'c' });
    const right = encodeDueName({ namespace: 'a', segment: 'b.c' });
    expect(left).not.toBe(right);
    expect(decodeDueName(left)).toEqual({ namespace: 'a.b', segment: 'c' });
    expect(decodeDueName(right)).toEqual({ namespace: 'a', segment: 'b.c' });
  });

  it('a decoded ref is always a valid segment ref', () => {
    for (const ref of refs) {
      const decoded = decodeDueName(encodeDueName(ref));
      expect(decoded).not.toBeNull();
      expect(() => validateSegmentRef(decoded!)).not.toThrow();
    }
  });

  it('an absent namespace and an empty-string namespace encode identically and decode to absent', () => {
    expect(encodeDueName({ segment: 'x' })).toBe(encodeDueName({ namespace: '', segment: 'x' }));
    expect(decodeDueName(encodeDueName({ namespace: '', segment: 'x' }))).toEqual({ segment: 'x' });
  });
});

describe('due index — rejects what we did not write', () => {
  it('returns null rather than guessing', () => {
    for (const bad of [
      'vips', // no length prefix
      '.abc', // empty prefix
      'x.abc', // non-numeric prefix
      '01.abc', // leading zero — one encoding per ref, or two rows could mean one segment
      '99.abc', // prefix longer than the remainder
      '3.abc', // consumes the whole remainder, leaving no segment
      '', // empty
      '5', // no dot at all
    ]) {
      expect(decodeDueName(bad)).toBeNull();
    }
  });
});

describe('due index — buckets', () => {
  it('maps an instant to its day index, with no calendar and no ambient time', () => {
    expect(dueBucket(0)).toBe(0);
    expect(dueBucket(DUE_BUCKET_MS - 1)).toBe(0);
    expect(dueBucket(DUE_BUCKET_MS)).toBe(1);
    expect(dueBucket(1_754_000_000_000)).toBe(Math.floor(1_754_000_000_000 / DUE_BUCKET_MS));
  });

  it('the bucket namespace obeys the locked grammar', () => {
    for (const at of [0, 1_754_000_000_000, 4_102_444_800_000]) {
      const ns = dueNamespace(dueBucket(at));
      expect(NAME_GRAMMAR.test(ns)).toBe(true);
      expect(ns).not.toContain('..');
      expect(ns.startsWith(DUE_NAMESPACE_PREFIX)).toBe(true);
    }
  });

  it('reads past buckets too, so a sweep that did not run leaves nothing stranded', () => {
    const now = 1_754_000_000_000;
    const current = dueBucket(now);
    expect(dueBucketsAt(now, 0)).toEqual([current]);
    expect(dueBucketsAt(now, 3)).toEqual([current - 3, current - 2, current - 1, current]);
  });

  it('bounds the lookback, so a long outage costs a bounded number of list calls', () => {
    const now = 1_754_000_000_000;
    expect(dueBucketsAt(now, 7)).toHaveLength(8);
    expect(() => dueBucketsAt(now, -1)).toThrow(ValidationError);
    expect(() => dueBucketsAt(now, 1.5)).toThrow(ValidationError);
  });
});

describe('due index — reserved rows', () => {
  it('recognises its own rows and nothing else', () => {
    expect(isDueIndexRow({ namespace: 'cbm.due.20356' })).toBe(true);
    expect(isDueIndexRow({ namespace: 'prod' })).toBe(false);
    expect(isDueIndexRow({ namespace: undefined })).toBe(false);
    // Near-misses must not be swept up: these are legal user namespaces.
    expect(isDueIndexRow({ namespace: 'cbm.dues' })).toBe(false);
    expect(isDueIndexRow({ namespace: 'cbm.du' })).toBe(false);
  });

  it('builds a pointer ref whose parts are both legal names', () => {
    const ref = dueIndexRef(20_356, { namespace: 'prod', segment: 'vips' });
    expect(ref.namespace).toBe('cbm.due.20356');
    expect(ref.segment).toBe('4.prodvips');
    expect(() => validateSegmentRef(ref)).not.toThrow();
  });
});

describe('due index — the length limit degrades, it does not fail', () => {
  it('refuses to index a ref whose encoding would break the grammar', () => {
    const huge = { namespace: 'n'.repeat(250), segment: 's'.repeat(250) };
    expect(canIndex(huge)).toBe(false);
    expect(() => dueIndexRef(1, huge)).toThrow(ValidationError);
  });

  it('accepts a ref exactly at the limit and rejects one character more', () => {
    // "3." + 3 + 251 = 256 exactly.
    const atLimit = { namespace: 'abc', segment: 'x'.repeat(251) };
    expect(encodeDueName(atLimit)).toHaveLength(MAX_NAME_LENGTH);
    expect(canIndex(atLimit)).toBe(true);
    expect(() => validateSegmentRef(dueIndexRef(1, atLimit))).not.toThrow();

    const overLimit = { namespace: 'abc', segment: 'x'.repeat(252) };
    expect(canIndex(overLimit)).toBe(false);
  });

  it('ordinary refs are comfortably indexable', () => {
    expect(canIndex({ namespace: 'active-daily', segment: 'd-2026-08-05' })).toBe(true);
    expect(canIndex({ segment: 'vips' })).toBe(true);
  });
});
