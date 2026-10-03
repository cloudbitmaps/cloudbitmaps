import { canonicalMetadataJson, MAX_METADATA_BYTES, MAX_METADATA_KEY_BYTES } from '@/core/metadata';

/**
 * Generation metadata's canonical JSON is a byte contract: what its cap is measured on, and what a sealed copy and a
 * byte-for-byte comparison of two copies rest on. These pin the bytes themselves, and the rules for what a value may
 * be, independent of any registry.
 */

class Refused extends Error {}
const fail = (message: string): never => {
  throw new Refused(message);
};
const canonical = (value: unknown): string => canonicalMetadataJson(value, fail);
/** UTF-8 bytes of `s`. */
const utf8 = (s: string): number => new TextEncoder().encode(s).length;

describe('canonical metadata JSON: the bytes', () => {
  it('sorts keys, so key order never changes the bytes', () => {
    expect(canonical({ b: 1, a: 'x', c: 'y' })).toBe('{"a":"x","b":1,"c":"y"}');
    expect(canonical({ c: 'y', a: 'x', b: 1 })).toBe('{"a":"x","b":1,"c":"y"}');
  });

  it('sorts by UTF-16 code unit, not by code point', () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFEF by code unit and after it by code point.
    const keys = { '\uffef': 1, '\u{1F600}': 2, '\u00e9': 3, z: 4, Z: 5 };
    expect(canonical(keys)).toBe('{"Z":5,"z":4,"\u00e9":3,"\u{1F600}":2,"\uffef":1}');
  });

  it('writes numbers as JSON does', () => {
    expect(canonical({ a: -0, b: 1e21, c: 0.1, d: 1e-7, e: -1.5, f: 2 ** 53, g: 123.456 })).toBe(
      '{"a":0,"b":1e+21,"c":0.1,"d":1e-7,"e":-1.5,"f":9007199254740992,"g":123.456}',
    );
  });

  it('escapes strings as JSON does', () => {
    expect(canonical({ q: '"', b: '\\', n: '\n', c: '\u0001', s: '\u2028', u: '\u65e5' })).toBe(
      '{"b":"\\\\","c":"\\u0001","n":"\\n","q":"\\"","s":"\u2028","u":"\u65e5"}',
    );
  });

  it('gives the empty object as {}, for the caller to decide on', () => {
    expect(canonical({})).toBe('{}');
  });

  it('accepts an object with a null prototype', () => {
    expect(canonical(Object.assign(Object.create(null) as object, { b: 2, a: 1 }))).toBe(
      '{"a":1,"b":2}',
    );
  });
});

describe('canonical metadata JSON: the caps are in UTF-8 bytes', () => {
  it('caps a key at 128 bytes', () => {
    expect(MAX_METADATA_KEY_BYTES).toBe(128);
    const euro = '\u20ac'; // three UTF-8 bytes, one UTF-16 unit
    const at = `${euro.repeat(42)}ab`;
    expect(utf8(at)).toBe(128);
    expect(() => canonical({ [at]: 'v' })).not.toThrow();
    expect(() => canonical({ [`${at}c`]: 'v' })).toThrow(Refused);
    expect(() => canonical({ [euro.repeat(43)]: 'v' })).toThrow(/129B/);
  });

  it('caps the whole at 1 KiB', () => {
    expect(MAX_METADATA_BYTES).toBe(1024);
    const euro = '\u20ac';
    const at = { k: `${euro.repeat(338)}ab` }; // 8 bytes of frame, 1,014 of euros, 2
    expect(utf8(canonical(at))).toBe(1024);
    expect(() => canonical({ k: `${euro.repeat(338)}abc` })).toThrow(/1025B/);
  });
});

describe('canonical metadata JSON: what a value may be', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 5],
    ['an array', ['a']],
    ['a Map', new Map([['a', 'b']])],
    ['a Date', new Date(0)],
    ['a boxed string', Object('x') as object],
    [
      'a class instance',
      new (class Meta {
        a = 'b';
      })(),
    ],
  ])('refuses %s as the container', (_, value) => {
    expect(() => canonical(value)).toThrow(Refused);
  });

  it.each([
    ['a boolean', { a: true }],
    ['null', { a: null }],
    ['undefined', { a: undefined }],
    ['an object', { a: { b: 1 } }],
    ['an array', { a: [1] }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['a lone surrogate', { a: '\ud800' }],
  ])('refuses %s as a value', (_, value) => {
    expect(() => canonical(value)).toThrow(Refused);
  });

  it.each([
    ['the empty key', { '': 'v' }],
    ['__proto__', JSON.parse('{"__proto__":"v"}') as object],
    ['a lone surrogate', { '\udc00': 'v' }],
    ['a symbol', { [Symbol('s')]: 'v' }],
  ])('refuses %s as a key', (_, value) => {
    expect(() => canonical(value)).toThrow(Refused);
  });

  it('refuses an accessor and a non-enumerable property', () => {
    const getter = Object.defineProperty({}, 'a', { get: () => 'x', enumerable: true });
    expect(() => canonical(getter)).toThrow(/enumerable data property/);
    const hidden = Object.defineProperty({}, 'a', { value: 'x', enumerable: false });
    expect(() => canonical(hidden)).toThrow(/enumerable data property/);
  });

  it('raises the error the caller passes', () => {
    class Mine extends Error {}
    expect(() =>
      canonicalMetadataJson({ a: true }, (m) => {
        throw new Mine(m);
      }),
    ).toThrow(Mine);
  });
});
