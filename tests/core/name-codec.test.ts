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

  it('property: an old-grammar name keeps its PATH too, except the two documented classes', () => {
    // The claim "no stored key moves" was only ever property-tested on the KEY alphabet; the path side had two
    // hand-picked cases that happened to avoid the classes that DO move. This asserts the whole old grammar
    // against what `main` actually wrote, and names the exceptions explicitly rather than letting them hide.
    const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const moves = (n: string): boolean => DEVICE.test(n.split('.')[0] ?? '') || n.endsWith('.');
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,32}$/), (n) => {
        fc.pre(OLD_GRAMMAR.test(n) && !n.includes('..'));
        if (moves(n)) return; // covered by the explicit list below
        expect(encodeNameForPath(n)).toBe(LEGACY_PATH(n));
      }),
      { numRuns: 1000 },
    );
  });

  it('names the exact set whose PATH changes — the breaking half of the upgrade', () => {
    // These were legal before and are written differently now. On a localfs store they become unreadable
    // until migrated, which is why they are enumerated here and in the CHANGELOG rather than discovered.
    for (const n of [
      'con',
      'CON',
      'nul',
      'aux',
      'prn',
      'com1',
      'lpt9',
      'con.backup',
      'a.',
      'backup.',
    ])
      expect(encodeNameForPath(n), n).not.toBe(LEGACY_PATH(n));
    // Everything else in the old grammar is untouched on a path.
    for (const n of ['users', 'a.b-c_d', 'com0', 'console', 'dedup:2026-08-01'])
      expect(encodeNameForPath(n), n).toBe(LEGACY_PATH(n));
  });

  // What `main` wrote for a path: the colon escape, and nothing else. Inlined rather than imported, because
  // the point is to compare against a FROZEN historical behaviour, not against whatever the codec does now.
  const LEGACY_PATH = (n: string): string => n.replaceAll(':', '%3A');

  it('property: an old-grammar name is byte-identical as an OBJECT KEY', () => {
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
    // Control characters: a literal newline breaks the XML an S3 LIST returns, and a NUL truncates a
    // POSIX path. These were in the old BAD_NAMES and have to land somewhere now that nothing is banned.
    ['a\tb', 'a%09b'],
    ['a\nb', 'a%0Ab'],
    ['a\u0000b', 'a%00b'],
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
    for (const n of ['console', 'connection', 'nulls', 'com10', 'lpt', 'com0', 'lpt0'])
      expect(encodeNameForPath(n)).toBe(n);
    // `com0`/`lpt0` matter in the other direction: they are NOT device names, they WERE legal under the
    // old grammar, and widening the table to `COM\\d` would move them on disk for no safety gain.
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
  // `fc.string()` defaults to printable ASCII. Measured over 20,000 draws it produced 95 distinct code points,
  // all U+0020–U+007E: zero non-ASCII, zero control characters, zero surrogate pairs, and a device-name stem
  // roughly once in 20,000. So the properties below were proving round-trip and injectivity over precisely the
  // alphabet this change did NOT need to widen — `日本語` and `🎉`, the headline examples, were never drawn.
  //
  // The unit is therefore explicit, and mixes the characters with special handling, whole device-name tokens
  // (a character-level bias never assembles `com1`), and binary strings for the astral/control cases.
  const HOSTILE_UNIT = fc.constantFrom(
    '%',
    '.',
    '_',
    ':',
    '/',
    '\\',
    ' ',
    '#',
    '|',
    '\u0000',
    '\u0009',
    '\u202E',
    'a',
    'A',
    'c',
    'o',
    'n',
    '1',
    '2',
    '5',
    'E',
    'F',
    '\u00e9',
    '\u0301',
    '\u65e5',
    '\ud83c\udf89',
  );
  const ANY_NAME = fc.oneof(
    { arbitrary: fc.string({ minLength: 1, maxLength: 40, unit: HOSTILE_UNIT }), weight: 3 },
    { arbitrary: fc.string({ minLength: 1, maxLength: 40, unit: 'binary' }), weight: 2 },
    {
      arbitrary: fc.constantFrom(
        'con',
        'CON',
        'nul',
        'com1',
        'com0',
        'lpt9',
        'con.backup',
        '.',
        '..',
        'a.',
        '_x',
      ),
      weight: 1,
    },
  );

  it('property: round-trips on both alphabets', () => {
    fc.assert(
      fc.property(ANY_NAME, (n) => {
        expect(decodeNameFromKey(encodeNameForKey(n))).toBe(n);
        expect(decodeNameFromPath(encodeNameForPath(n))).toBe(n);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: injective — swept with a seen-map, not by drawing two random strings', () => {
    // Drawing two independent strings and asserting they differ proves almost nothing: over a 95-character
    // alphabet the chance of drawing a colliding PAIR is ~0 even if collisions were common. It is also a
    // corollary of round-trip above (a left inverse implies injectivity), so it added no power at all.
    //
    // A seen-map over one stream is what actually finds a collision CLASS — this is the shape that surfaced
    // the lone-surrogate bug, where every unpaired surrogate encoded to the same replacement bytes.
    for (const encode of [encodeNameForKey, encodeNameForPath]) {
      const seen = new Map<string, string>();
      fc.assert(
        fc.property(ANY_NAME, (n) => {
          const enc = encode(n);
          const prior = seen.get(enc);
          if (prior !== undefined && prior !== n) {
            throw new Error(
              `collision: ${JSON.stringify(prior)} and ${JSON.stringify(n)} both → ${enc}`,
            );
          }
          seen.set(enc, n);
        }),
        { numRuns: 5000 },
      );
    }
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
