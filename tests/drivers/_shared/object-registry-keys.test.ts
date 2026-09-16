import {
  normalizeObjectPrefix,
  parseRegistryKey,
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
    for (const prefix of ['cr', 'cloudroaring/v1', 'a/b/c', 'tenant-acme', '100%', 'a.b']) {
      expect(() => normalizeObjectPrefix(prefix), JSON.stringify(prefix)).not.toThrow();
    }
    expect(normalizeObjectPrefix(undefined)).toBeUndefined();
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
    expect(parseRegistryKey('cr', 'cr/_default/segments/a.0.crbm')).toBeNull(); // a cold object
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
