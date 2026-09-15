import fc from 'fast-check';
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import { encodeNameForKey, encodeNameForPath } from '@/core/name-codec';

// The validation contract, after the character allowlist was removed.
//
// This file replaces `name-grammar-colons.test.ts`, which pinned a grammar that no longer exists. That file
// asserted things like "still refuses a leading colon" and "%, /, \\ and .. stay out" — every one of which is
// now wrong on purpose. The encoding is what makes them safe (`core/name-codec.ts`); validation's remaining
// job is size.

const ok = (segment: string): void => validateSegmentRef({ segment });

describe('a name is any non-empty string', () => {
  it('accepts everything the old grammar refused', () => {
    for (const name of [
      'dedup:2026-08-01',
      ':leading',
      '_leading',
      '.hidden',
      '-leading',
      'a/b',
      '../etc/passwd',
      '..',
      '.',
      'a\\b',
      'a b',
      'a%3Ab',
      '100%',
      'user@example.com',
      'ns#1|seg#2',
      'con',
      'nul',
      'a.',
      'h\u00e9llo',
      '\u65e5\u672c\u8a9e',
      '\ud83c\udf89',
    ])
      expect(() => ok(name), name).not.toThrow();
  });

  it('accepts the same set in a namespace', () => {
    for (const ns of ['tenant:acme', '../etc', '_default', '\ud83c\udf89'])
      expect(() => validateSegmentRef({ segment: 's', namespace: ns }), ns).not.toThrow();
  });
});

describe('the two refusals no encoding can fix', () => {
  it('refuses an empty name — there is nothing to address', () => {
    expect(() => ok('')).toThrow(ValidationError);
    expect(() => validateSegmentRef({ segment: 's', namespace: '' })).toThrow(ValidationError);
  });

  it('refuses a non-string', () => {
    expect(() => ok(undefined as unknown as string)).toThrow(ValidationError);
    expect(() => ok(42 as unknown as string)).toThrow(ValidationError);
  });

  it('measures length on the ENCODED form, because that is what a key has to hold', () => {
    // 256 plain characters fit; 257 do not — unchanged from the old grammar, so nothing that was legal
    // becomes illegal.
    expect(() => ok('a'.repeat(256))).not.toThrow();
    expect(() => ok('a'.repeat(257))).toThrow(ValidationError);

    // …but an emoji is ONE character and TWELVE encoded, so a short-looking name can still be too long.
    // Measuring the input instead would let a key exceed what S3 accepts.
    expect(() => ok('\ud83c\udf89'.repeat(21))).not.toThrow(); // 252 encoded
    expect(() => ok('\ud83c\udf89'.repeat(22))).toThrow(ValidationError); // 264 encoded
  });

  it('says both numbers, because one of them is surprising', () => {
    try {
      ok('\ud83c\udf89'.repeat(22));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/once encoded/);
      // The name's own length is reported too — 44 UTF-16 units for 22 emoji — so the gap between what the
      // caller counted and what storage counts is visible rather than mysterious.
      expect((e as Error).message).toMatch(/44 characters/);
    }
  });

  it('refuses a lone surrogate — there is no UTF-8 for it, so it cannot be a key', () => {
    // Not a taste. TextEncoder maps every unpaired surrogate to U+FFFD, so `a\uD800b`, `a\uDC00b` and
    // `a\uFFFDb` would all encode to the same bytes — four distinct names claiming one key, which is the
    // property everything else rests on. Proven end to end before this check existed: two segments shared a
    // registry row.
    for (const bad of ['\uD800', '\uDC00', 'a\uD800b', 'tenant-\uDBFF'])
      expect(() => ok(bad), JSON.stringify(bad)).toThrow(ValidationError);
    // A PROPER pair is a perfectly good name — the check must not reject real astral characters.
    for (const good of ['\ud83c\udf89', 'a\ud83c\udf89b', '\uFFFD'])
      expect(() => ok(good), JSON.stringify(good)).not.toThrow();
  });

  it('measures the LONGER encoding, because a path escapes more than a key', () => {
    // `:` is key-safe (1 char) and path-escaped (3). Measuring the key form alone let this pass the boundary
    // and then fail inside the driver with a raw ENAMETOOLONG instead of a typed error at the edge.
    const colons = `a${':'.repeat(200)}`; // key-encoded 201, path-encoded 601
    expect(() => ok(colons)).toThrow(ValidationError);
    expect(() => ok(`a${':'.repeat(80)}`)).not.toThrow(); // path-encoded 241, still inside
  });

  it('property: any non-empty string of modest length is a legal name', () => {
    fc.assert(
      // `unit: 'binary'` and a length that can actually reach the cap: the previous version drew printable
      // ASCII of at most 50 characters, so the encoded form never exceeded 150 against a limit of 256 — the
      // assertion could not fail whatever the implementation did.
      fc.property(fc.string({ minLength: 1, maxLength: 80, unit: 'binary' }), (n) => {
        const tooLong = Math.max(encodeNameForKey(n).length, encodeNameForPath(n).length) > 256;
        if (tooLong) expect(() => ok(n)).toThrow(ValidationError);
        else expect(() => ok(n)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});
