import fc from 'fast-check';
import {
  decodeNameFromKey,
  decodeNameFromPath,
  encodeNameForKey,
  encodeNameForPath,
} from '@/core/name-codec';

// A name is any non-empty string. Three properties make that safe, and this file is their contract.
//
//   1. ROUND-TRIP — decode(encode(n)) === n, so a name read back off storage is the name that went in.
//   2. INJECTIVITY — a !== b implies encode(a) !== encode(b), so two segments can never claim one key.
//   3. BACKWARD COMPATIBILITY — every name legal under the old grammar encodes to ITSELF, so no stored key
//      moves and there is nothing to migrate. This is the property most easily broken by a later edit.

const OLD_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

describe('backward compatibility: the old alphabet is untouched', () => {
  it('every previously-legal name is its own object key', () => {
    for (const n of [
      'a',
      'users',
      'dedup:2026-08-01',
      'sent:daily:2026-08-01',
      'a.b-c_d',
      '0',
      'A.1-2',
    ])
      expect(encodeNameForKey(n)).toBe(n);
  });

  it('every previously-legal name is its own path component, except the colon', () => {
    // `:` was already escaped on a path before this change; the rest stay literal.
    expect(encodeNameForPath('a.b-c_d')).toBe('a.b-c_d');
    expect(encodeNameForPath('dedup:2026-08-01')).toBe('dedup%3A2026-08-01');
  });

  it('property: an old-grammar name is byte-identical as an object key', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,32}$/), (n) => {
        fc.pre(OLD_GRAMMAR.test(n));
        expect(encodeNameForKey(n)).toBe(n);
      }),
      { numRuns: 500 },
    );
  });
});

describe('names that used to be impossible', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a/b', 'a%2Fb'],
    ['a\\b', 'a%5Cb'],
    ['a b', 'a%20b'],
    ['user@example.com', 'user%40example.com'],
    ['ns#1', 'ns%231'],
    ['a|b', 'a%7Cb'],
    ['100%', '100%25'],
    ['héllo', 'h%C3%A9llo'],
    ['日本語', '%E6%97%A5%E6%9C%AC%E8%AA%9E'],
    ['🎉', '%F0%9F%8E%89'],
    ['_leading', '%5Fleading'], // a LEADING underscore is escaped — see the sentinel test below
  ];

  it.each(cases)('encodes %s for an object key', (raw, encoded) => {
    expect(encodeNameForKey(raw)).toBe(encoded);
    expect(decodeNameFromKey(encoded)).toBe(raw);
  });
});

describe('the reserved sentinel stays unreachable', () => {
  it('escapes a leading underscore, so no caller can name the no-namespace sentinel', () => {
    // `_default` is the physical stand-in for an absent namespace. The old grammar made it unreachable by
    // banning a leading `_`; dropping the grammar would have let a caller name a namespace `_default` and
    // resolve to everyone else's un-namespaced data. The encoding restores that by construction.
    expect(encodeNameForKey('_default')).toBe('%5Fdefault');
    expect(encodeNameForPath('_default')).toBe('%5Fdefault');
    expect(encodeNameForKey('_default')).not.toBe('_default');
    // Only the FIRST one — an underscore elsewhere is an ordinary character.
    expect(encodeNameForKey('a_b_c')).toBe('a_b_c');
    // …and it still round-trips, so the caller gets the name they asked for back.
    expect(decodeNameFromKey(encodeNameForKey('_default'))).toBe('_default');
    expect(decodeNameFromPath(encodeNameForPath('_x'))).toBe('_x');
  });
});

describe('the filesystem hazards, which are about the whole component', () => {
  it('escapes `.` and `..`, which are traversal', () => {
    expect(encodeNameForPath('.')).toBe('%2E');
    expect(encodeNameForPath('..')).toBe('%2E%2E');
    expect(decodeNameFromPath(encodeNameForPath('.'))).toBe('.');
    expect(decodeNameFromPath(encodeNameForPath('..'))).toBe('..');
  });

  it('defuses Windows reserved device names, which the OLD grammar permitted', () => {
    // `store.segment('con')` validated cleanly before this change and broke only on a user's Windows box.
    for (const n of ['con', 'CON', 'Nul', 'aux', 'prn', 'com1', 'COM9', 'lpt3']) {
      const enc = encodeNameForPath(n);
      expect(enc).not.toBe(n);
      expect(decodeNameFromPath(enc)).toBe(n);
    }
    // Reserved with an extension too: the object file is `<name>.<gen>.crbm`, so the stem is what matters.
    expect(encodeNameForPath('con.backup')).not.toMatch(/^con\./i);
    // ...but a name that merely STARTS with those letters is ordinary.
    for (const n of ['console', 'connection', 'nulls', 'com10', 'lpt'])
      expect(encodeNameForPath(n)).toBe(n);
  });

  it('escapes a trailing dot or space, which Windows silently strips', () => {
    // Without this, `a.` and `a` become the same directory and two segments quietly merge.
    expect(encodeNameForPath('a.')).toBe('a%2E');
    expect(encodeNameForPath('a ')).toBe('a%20');
    expect(encodeNameForPath('a.')).not.toBe(encodeNameForPath('a'));
    expect(decodeNameFromPath(encodeNameForPath('a.'))).toBe('a.');
  });

  it('never emits a character a path cannot hold', () => {
    for (const n of ['a/b', 'a\\b', 'a:b', '.', '..', 'con', 'a.', 'a ', '🎉', '%']) {
      const enc = encodeNameForPath(n);
      expect(enc).not.toMatch(/[/\\:]/);
      expect(enc.endsWith('.') || enc.endsWith(' ')).toBe(false);
    }
  });
});

describe('the three properties, over arbitrary strings', () => {
  const ANY_NAME = fc.string({ minLength: 1, maxLength: 40 });

  it('property: round-trips on both alphabets', () => {
    fc.assert(
      fc.property(ANY_NAME, (n) => {
        expect(decodeNameFromKey(encodeNameForKey(n))).toBe(n);
        expect(decodeNameFromPath(encodeNameForPath(n))).toBe(n);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: injective, so two different names never share one encoding', () => {
    fc.assert(
      fc.property(ANY_NAME, ANY_NAME, (a, b) => {
        fc.pre(a !== b);
        expect(encodeNameForKey(a)).not.toBe(encodeNameForKey(b));
        expect(encodeNameForPath(a)).not.toBe(encodeNameForPath(b));
      }),
      { numRuns: 1000 },
    );
  });

  it('property: a path encoding is always a safe path component', () => {
    fc.assert(
      fc.property(ANY_NAME, (n) => {
        const enc = encodeNameForPath(n);
        expect(enc).not.toMatch(/[/\\:]/);
        expect(enc === '.' || enc === '..').toBe(false);
        expect(enc.endsWith('.') || enc.endsWith(' ')).toBe(false);
        expect(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(enc.split('.')[0] ?? '')).toBe(
          false,
        );
      }),
      { numRuns: 1000 },
    );
  });
});
