import {
  normalizeObjectPrefix,
  parseGenerationFromKey,
  segmentObjectPrefix,
  storageObjectKey,
} from '@cloudbitmaps/core/driver-kit';
import { ValidationError } from '@/core/errors';
import { encodeNameForKey } from '@/core/name-codec';

/**
 * The storage object layout every object-store driver (S3, GCS, Azure Blob) builds its keys with: one definition, so a
 * segment written through one driver reads identically through another on the same bucket.
 */
describe('storage object keys', () => {
  describe('storageObjectKey', () => {
    it('maps a GenKey to <ns>/segments/<segment>.<gen>.crbm', () => {
      expect(storageObjectKey(undefined, { segment: 's', generation: 3 })).toBe(
        '_default/segments/s.3.crbm',
      );
      expect(
        storageObjectKey(undefined, { namespace: 'tenant1', segment: 's', generation: 0 }),
      ).toBe('tenant1/segments/s.0.crbm');
      expect(
        storageObjectKey('cloudbitmaps', { segment: 'seg1', generation: 42, namespace: 'ns' }),
      ).toBe('cloudbitmaps/ns/segments/seg1.42.crbm');
    });

    it('encodes the segment and namespace names, so a name that needs encoding stays one path part', () => {
      const key = storageObjectKey(undefined, { segment: 'A/b', generation: 1 });
      expect(key).toBe(`_default/segments/${encodeNameForKey('A/b')}.1.crbm`);
      expect(key.split('/')).toHaveLength(3);
      expect(segmentObjectPrefix('p', { namespace: 'N', segment: 'A/b' })).toBe(
        `p/${encodeNameForKey('N')}/segments/${encodeNameForKey('A/b')}.`,
      );
    });

    it('applies a caller prefix, trimming stray slashes', () => {
      expect(storageObjectKey('cloudbitmaps', { segment: 's', generation: 1 })).toBe(
        'cloudbitmaps/_default/segments/s.1.crbm',
      );
      expect(storageObjectKey('/a/b/', { segment: 's', generation: 1 })).toBe(
        'a/b/_default/segments/s.1.crbm',
      );
      expect(storageObjectKey('', { segment: 's', generation: 1 })).toBe(
        '_default/segments/s.1.crbm',
      );
    });

    it('rejects a generation that is not a whole number from 0', () => {
      for (const gen of [-1, 1.5, NaN]) {
        expect(() => storageObjectKey(undefined, { segment: 's', generation: gen })).toThrow(
          ValidationError,
        );
      }
    });

    it('rejects an invalid segment or namespace name', () => {
      for (const bad of ['', 'a'.repeat(257)]) {
        expect(() => storageObjectKey(undefined, { segment: bad, generation: 1 })).toThrow(
          ValidationError,
        );
        expect(() =>
          storageObjectKey(undefined, { namespace: bad, segment: 's', generation: 1 }),
        ).toThrow(ValidationError);
      }
    });
  });

  describe('segmentObjectPrefix', () => {
    it('is the listing prefix every generation key starts with', () => {
      expect(segmentObjectPrefix(undefined, { segment: 's' })).toBe('_default/segments/s.');
      expect(segmentObjectPrefix('p/', { segment: 's', namespace: 'ns' })).toBe('p/ns/segments/s.');
      const key = storageObjectKey('p', { namespace: 'ns', segment: 's', generation: 5 });
      expect(key.startsWith(segmentObjectPrefix('p', { namespace: 'ns', segment: 's' }))).toBe(
        true,
      );
    });
  });

  describe('normalizeObjectPrefix', () => {
    it('rejects a traversing or control-character prefix, and passes an ordinary one unchanged', () => {
      for (const p of ['..', 'a/../b', './x', 'a\tb']) {
        expect(() => normalizeObjectPrefix(p)).toThrow(ValidationError);
      }
      expect(normalizeObjectPrefix('a/b/c')).toBe('a/b/c');
      expect(normalizeObjectPrefix(undefined)).toBeUndefined();
    });
  });

  describe('parseGenerationFromKey', () => {
    const prefix = segmentObjectPrefix(undefined, { segment: 's' });

    it('round-trips storageObjectKey for many generations', () => {
      for (const gen of [0, 1, 7, 42, 1000, Number.MAX_SAFE_INTEGER]) {
        const key = storageObjectKey(undefined, { segment: 's', generation: gen });
        expect(parseGenerationFromKey(prefix, key)).toBe(gen);
      }
    });

    it('rejects non-canonical, non-matching, and unsafe keys', () => {
      expect(parseGenerationFromKey(prefix, '_default/segments/s.07.crbm')).toBeNull(); // leading zero
      expect(parseGenerationFromKey(prefix, '_default/segments/s.crbm')).toBeNull(); // no gen
      expect(parseGenerationFromKey(prefix, '_default/segments/s.1.txt')).toBeNull(); // wrong suffix
      expect(parseGenerationFromKey(prefix, '_default/segments/s.1.5.crbm')).toBeNull(); // dotted middle
      expect(parseGenerationFromKey(prefix, `${prefix}abc.crbm`)).toBeNull(); // not digits
      expect(parseGenerationFromKey(prefix, 'other/segments/x.1.crbm')).toBeNull(); // foreign key
      expect(
        parseGenerationFromKey(prefix, '_default/segments/s.99999999999999999999.crbm'),
      ).toBeNull(); // > MAX_SAFE_INTEGER
    });

    it('reads a key that does not end in .crbm as no generation, whatever is left of it', () => {
      expect(parseGenerationFromKey(prefix, '_default/segments/s.12.crbx')).toBeNull();
      expect(parseGenerationFromKey(prefix, '_default/segments/s.123456')).toBeNull();
      expect(parseGenerationFromKey(prefix, '_default/segments/s.12.crbm.')).toBeNull();
    });

    it('takes the segment prefix only at the start of the key, not anywhere inside it', () => {
      // A real segment prefix ends in `.`; a prefix ending in a digit shows a match found inside the key.
      expect(parseGenerationFromKey('1', '21.crbm')).toBeNull();
      expect(parseGenerationFromKey('1', '11.crbm')).toBe(1);
    });

    it('does not match a different segment that merely shares the prefix string', () => {
      // segment "s" prefix is "_default/segments/s."; a key for segment "s2" must not parse under it.
      const s2Key = storageObjectKey(undefined, { segment: 's2', generation: 4 });
      expect(s2Key).toBe('_default/segments/s2.4.crbm');
      expect(parseGenerationFromKey(prefix, s2Key)).toBeNull();
      // …and a key for segment "s.x" (dot allowed in names) won't alias segment "s"'s generations.
      const dottedKey = storageObjectKey(undefined, { segment: 's.x', generation: 4 });
      expect(parseGenerationFromKey(prefix, dottedKey)).toBeNull();
    });

    it('isolates by namespace', () => {
      const t1 = segmentObjectPrefix('p', { namespace: 't1', segment: 's' });
      const key = storageObjectKey('p', { namespace: 't1', segment: 's', generation: 9 });
      expect(parseGenerationFromKey(t1, key)).toBe(9);
      // a different namespace's key won't parse under t1's prefix
      const otherKey = storageObjectKey('p', { namespace: 't2', segment: 's', generation: 9 });
      expect(parseGenerationFromKey(t1, otherKey)).toBeNull();
    });
  });
});
