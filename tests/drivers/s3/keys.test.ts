import {
  coldObjectKey,
  parseGenerationFromKey,
  parseRegistryKey,
  registryListPrefix,
  registryObjectKey,
  segmentObjectPrefix,
} from '@/drivers/s3/keys';
import { ValidationError } from '@/core/errors';

describe('S3 object-key grammar', () => {
  describe('coldObjectKey', () => {
    it('maps a GenKey to <ns>/segments/<segment>.<gen>.crbm', () => {
      expect(coldObjectKey(undefined, { segment: 's', generation: 3 })).toBe(
        '_default/segments/s.3.crbm',
      );
      expect(coldObjectKey(undefined, { namespace: 'tenant1', segment: 's', generation: 0 })).toBe(
        'tenant1/segments/s.0.crbm',
      );
    });

    it('applies a caller prefix, trimming stray slashes', () => {
      expect(coldObjectKey('cloudroaring', { segment: 's', generation: 1 })).toBe(
        'cloudroaring/_default/segments/s.1.crbm',
      );
      expect(coldObjectKey('/a/b/', { segment: 's', generation: 1 })).toBe(
        'a/b/_default/segments/s.1.crbm',
      );
      expect(coldObjectKey('', { segment: 's', generation: 1 })).toBe('_default/segments/s.1.crbm');
    });

    it('rejects a bad generation', () => {
      for (const gen of [-1, 1.5, NaN]) {
        expect(() => coldObjectKey(undefined, { segment: 's', generation: gen })).toThrow(
          ValidationError,
        );
      }
    });

    it('rejects a traversal / invalid segment or namespace name', () => {
      for (const bad of ['..', 'a/b', 'a..b', '', '.hidden']) {
        expect(() => coldObjectKey(undefined, { segment: bad, generation: 1 })).toThrow(
          ValidationError,
        );
        expect(() =>
          coldObjectKey(undefined, { namespace: bad, segment: 's', generation: 1 }),
        ).toThrow(ValidationError);
      }
    });
  });

  describe('parseGenerationFromKey', () => {
    const prefix = segmentObjectPrefix(undefined, { segment: 's' });

    it('round-trips coldObjectKey for many generations', () => {
      for (const gen of [0, 1, 7, 42, 1000, Number.MAX_SAFE_INTEGER]) {
        const key = coldObjectKey(undefined, { segment: 's', generation: gen });
        expect(parseGenerationFromKey(prefix, key)).toBe(gen);
      }
    });

    it('rejects non-canonical, non-matching, and unsafe keys', () => {
      expect(parseGenerationFromKey(prefix, '_default/segments/s.07.crbm')).toBeNull(); // leading zero
      expect(parseGenerationFromKey(prefix, '_default/segments/s.crbm')).toBeNull(); // no gen
      expect(parseGenerationFromKey(prefix, '_default/segments/s.1.txt')).toBeNull(); // wrong suffix
      expect(parseGenerationFromKey(prefix, '_default/segments/s.1.5.crbm')).toBeNull(); // dotted middle
      expect(
        parseGenerationFromKey(prefix, '_default/segments/s.99999999999999999999.crbm'),
      ).toBeNull(); // > MAX_SAFE_INTEGER
    });

    it('does not match a different segment that merely shares the prefix string', () => {
      // segment "s" prefix is "_default/segments/s."; a key for segment "s2" must not parse under it.
      const s2Key = coldObjectKey(undefined, { segment: 's2', generation: 4 });
      expect(s2Key).toBe('_default/segments/s2.4.crbm');
      expect(parseGenerationFromKey(prefix, s2Key)).toBeNull();
      // …and a key for segment "s.x" (dot allowed in names) won't alias segment "s"'s generations.
      const dottedKey = coldObjectKey(undefined, { segment: 's.x', generation: 4 });
      expect(parseGenerationFromKey(prefix, dottedKey)).toBeNull();
    });

    it('isolates by namespace', () => {
      const t1 = segmentObjectPrefix('p', { namespace: 't1', segment: 's' });
      const key = coldObjectKey('p', { namespace: 't1', segment: 's', generation: 9 });
      expect(parseGenerationFromKey(t1, key)).toBe(9);
      // a different namespace's key won't parse under t1's prefix
      const otherKey = coldObjectKey('p', { namespace: 't2', segment: 's', generation: 9 });
      expect(parseGenerationFromKey(t1, otherKey)).toBeNull();
    });
  });

  describe('registry keys', () => {
    it('maps a ref to <prefix>registry/<ns>/<segment>.reg', () => {
      expect(registryObjectKey(undefined, { segment: 's' })).toBe('registry/_default/s.reg');
      expect(registryObjectKey('cr', { namespace: 't1', segment: 's' })).toBe(
        'cr/registry/t1/s.reg',
      );
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
  });
});
