import {
  normalizeObjectPrefix,
  parseRegistryKey,
  prefixPart,
  registryListPrefix,
  registryObjectKey,
} from '@/drivers/_shared/object-registry-keys';
import { ValidationError } from '@/core/errors';

/**
 * The registry key layout is the one thing all three object-store registries share byte for byte, so a
 * regression here desynchronizes S3, GCS and Azure at once — and does it silently, as segments that simply
 * cannot be found rather than as an error.
 */
describe('normalizeObjectPrefix — containment', () => {
  it('rejects every spelling of a traversal that a bucket-walking tool would resolve', () => {
    const bad: readonly string[] = [
      '..',
      'a/../b',
      './x',
      'a\tb', // C0 control
      'a\u007fb', // DEL — not covered by a bare `< 0x20` check
      'a\\..\\b', // backslash separator (ADLS Gen2, Windows-side tooling)
      'a/%2E%2E/b', // percent-encoded `..`, decoded by gsutil / s3fs / gcsfuse / azcopy
    ];
    for (const prefix of bad) {
      expect(() => normalizeObjectPrefix(prefix), JSON.stringify(prefix)).toThrow(ValidationError);
    }
  });

  it('accepts ordinary prefixes, including ones that merely contain a percent', () => {
    for (const prefix of ['cr', 'cloudbitmaps/v1', 'a/b/c', 'tenant-acme', '100%', 'a.b']) {
      expect(() => normalizeObjectPrefix(prefix), JSON.stringify(prefix)).not.toThrow();
    }
    expect(normalizeObjectPrefix(undefined)).toBeUndefined();
  });
});

describe('prefixPart — slashes trimmed from both ends', () => {
  it('builds the same prefix as a trim of leading and trailing slashes', () => {
    const cases: ReadonlyArray<readonly [string | undefined, string]> = [
      [undefined, ''],
      ['', ''],
      ['/', ''],
      ['///', ''],
      ['cr', 'cr/'],
      ['/cr/', 'cr/'],
      ['//a/b//', 'a/b/'],
      ['a//b', 'a//b/'],
      ['/a/ /', 'a/ /'],
    ];
    for (const [prefix, expected] of cases) {
      expect(prefixPart(prefix), JSON.stringify(prefix)).toBe(expected);
    }
  });

  it('matches the regex trim on every short string of slashes and letters', () => {
    const alphabet = ['/', 'a', 'b'];
    let strings = [''];
    for (let length = 1; length <= 6; length++) {
      strings = strings.flatMap((s) => alphabet.map((c) => s + c));
      for (const s of strings) {
        const trimmed = s.replace(/^\/+|\/+$/g, '');
        expect(prefixPart(s), JSON.stringify(s)).toBe(trimmed === '' ? '' : `${trimmed}/`);
      }
    }
  });

  it('is linear in a long run of inner slashes', () => {
    // The trailing-slash regex this replaced took about 23 s here (quadratic); the trim is linear and this takes
    // under a millisecond. The regex blocks the event loop, so the timeout is reported once it returns.
    const inner = '/'.repeat(200_000);
    expect(prefixPart(`/a${inner}x//`)).toBe(`a${inner}x/`);
  });
});

describe('parseRegistryKey — only keys a legitimate write could have produced', () => {
  it('round-trips the keys registryObjectKey builds', () => {
    for (const ref of [
      { segment: 's:v1' },
      { namespace: 'ns', segment: 'a/b' },
      { segment: 'user@example.com' },
      { namespace: 'tenant', segment: '100%' },
    ]) {
      const key = registryObjectKey('cr', ref);
      expect(parseRegistryKey('cr', key), key).toEqual({
        namespace: ref.namespace,
        segment: ref.segment,
      });
    }
  });

  // Without the SegmentRef validation, these parse into refs no write could ever have produced, and are
  // then handed to sweeps that throw ValidationError on every method they reach — a corrupt-looking failure
  // far from its cause.
  it('rejects a key whose parsed ref could not be valid', () => {
    expect(parseRegistryKey(undefined, 'registry//a.reg')).toBeNull(); // empty namespace
    expect(parseRegistryKey(undefined, `registry/_default/${'a'.repeat(300)}.reg`)).toBeNull();
    expect(parseRegistryKey(undefined, 'registry/_default/.reg')).toBeNull(); // empty segment
  });

  it('rejects foreign objects and keys outside the configured prefix', () => {
    expect(parseRegistryKey('cr', 'cr/registry/_default/a.txt')).toBeNull(); // wrong suffix
    expect(parseRegistryKey('cr', 'other/registry/_default/a.reg')).toBeNull(); // wrong prefix
    expect(parseRegistryKey('cr', 'cr/_default/segments/a.0.crbm')).toBeNull(); // a storage object
  });

  // A name whose encoding does not round-trip must not resolve: it would name a DIFFERENT segment than the
  // one whose bytes are in the object.
  it('rejects a key carrying a name that does not re-encode to itself', () => {
    expect(parseRegistryKey(undefined, 'registry/_default/a%2Fb.reg')).not.toBeNull();
    expect(parseRegistryKey(undefined, 'registry/_default/a/b.reg')).toBeNull();
  });
});

describe('registryListPrefix — namespace scoping', () => {
  it('scopes to one namespace without matching a prefix sibling', () => {
    const ns = registryListPrefix('cr', 'ns');
    expect(registryObjectKey('cr', { namespace: 'ns', segment: 'a' }).startsWith(ns)).toBe(true);
    expect(registryObjectKey('cr', { namespace: 'ns2', segment: 'a' }).startsWith(ns)).toBe(false);
    expect(registryObjectKey('cr', { namespace: 'nsextra', segment: 'a' }).startsWith(ns)).toBe(
      false,
    );
  });

  it('spans every namespace when unscoped', () => {
    const all = registryListPrefix('cr', undefined);
    for (const ref of [{ segment: 'a' }, { namespace: 'ns', segment: 'a' }]) {
      expect(registryObjectKey('cr', ref).startsWith(all)).toBe(true);
    }
  });
});

describe('registry keys: exact layout', () => {
  it('maps a ref to <prefix>registry/<ns>/<segment>.reg', () => {
    expect(registryObjectKey(undefined, { segment: 's' })).toBe('registry/_default/s.reg');
    expect(registryObjectKey('cr', { namespace: 't1', segment: 's' })).toBe('cr/registry/t1/s.reg');
  });

  it('scopes the list prefix registry-wide or to one namespace', () => {
    expect(registryListPrefix('cr')).toBe('cr/registry/');
    expect(registryListPrefix('cr', 't1')).toBe('cr/registry/t1/');
    expect(registryListPrefix(undefined, undefined)).toBe('registry/');
  });

  it('round-trips key → ref (mapping _default back to the absent namespace)', () => {
    for (const ref of [{ segment: 's' }, { namespace: 't1', segment: 'seg-2' }]) {
      expect(parseRegistryKey('cr', registryObjectKey('cr', ref))).toEqual({
        segment: ref.segment,
        namespace: (ref as { namespace?: string }).namespace,
      });
    }
  });

  it('returns null for a foreign / malformed key (not parsed as a ref)', () => {
    for (const key of [
      'cr/registry/not-a-registry-object.txt', // wrong suffix
      'cr/registry/no-slash.reg', // no <ns>/<segment> split
      'cr/segments/_default/s.reg', // not under registry/
      'cr/registry/_default/.reg', // empty segment
      'cr/registry/_default/../escape.reg', // grammar-invalid segment
    ]) {
      expect(parseRegistryKey('cr', key)).toBeNull();
    }
  });

  it('refuses a key whose encoding does not ROUND-TRIP, so one segment cannot wear two names', () => {
    // A foreign object placed under our prefix could spell a name two ways; reporting both would hand a
    // sweep one segment under two identities. The driver only ever writes the canonical spelling.
    expect(parseRegistryKey(undefined, 'registry/_default/a%2Fb.reg')).toEqual({
      segment: 'a/b',
      namespace: undefined,
    });
    // Lowercase escape — decodes to the same name, but we never wrote it.
    expect(parseRegistryKey(undefined, 'registry/_default/a%2fb.reg')).toBeNull();
    // A literal `%` that is not an escape we emit.
    expect(parseRegistryKey(undefined, 'registry/_default/a%b.reg')).toBeNull();
    // Same rule on the namespace half.
    expect(parseRegistryKey(undefined, 'registry/a%2fb/s.reg')).toBeNull();
    // …and the sentinel is not impersonable: `%5Fdefault` is the namespace literally named `_default`.
    expect(parseRegistryKey(undefined, 'registry/%5Fdefault/s.reg')).toEqual({
      segment: 's',
      namespace: '_default',
    });
  });
});
