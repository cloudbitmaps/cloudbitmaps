import {
  coldObjectName,
  normalizeGcsPrefix,
  parseGenerationFromName,
  segmentObjectPrefix,
} from '@/drivers/gcs/keys';
import { ValidationError } from '@/core/errors';

/** Pure GCS object-name logic — the same `.crbm` scheme as S3/LocalFs, so a segment reads identically. */
describe('GCS keys', () => {
  it('builds the namespace-first .crbm object name', () => {
    expect(coldObjectName(undefined, { segment: 's', generation: 0 })).toBe(
      '_default/segments/s.0.crbm',
    );
    expect(
      coldObjectName('cloudroaring', { segment: 'seg1', generation: 42, namespace: 'ns' }),
    ).toBe('cloudroaring/ns/segments/seg1.42.crbm');
  });

  it('the segment prefix is the shared listing prefix', () => {
    expect(segmentObjectPrefix(undefined, { segment: 's' })).toBe('_default/segments/s.');
    expect(segmentObjectPrefix('p/', { segment: 's', namespace: 'ns' })).toBe('p/ns/segments/s.');
  });

  it('rejects a negative / non-integer generation', () => {
    expect(() => coldObjectName(undefined, { segment: 's', generation: -1 })).toThrow(
      ValidationError,
    );
    expect(() => coldObjectName(undefined, { segment: 's', generation: 1.5 })).toThrow(
      ValidationError,
    );
  });

  it('rejects a traversing / control-char prefix (containment)', () => {
    for (const p of ['..', 'a/../b', './x', 'a\tb']) {
      expect(() => normalizeGcsPrefix(p)).toThrow(ValidationError);
    }
    expect(normalizeGcsPrefix('a/b/c')).toBe('a/b/c');
    expect(normalizeGcsPrefix(undefined)).toBeUndefined();
  });

  describe('parseGenerationFromName', () => {
    const prefix = segmentObjectPrefix(undefined, { segment: 's' }); // "_default/segments/s."
    it('parses a canonical generation', () => {
      expect(parseGenerationFromName(prefix, `${prefix}7.crbm`)).toBe(7);
      expect(parseGenerationFromName(prefix, `${prefix}0.crbm`)).toBe(0);
    });
    it('rejects leading zeros (no aliasing 07 → 7)', () => {
      expect(parseGenerationFromName(prefix, `${prefix}07.crbm`)).toBeNull();
    });
    it('rejects a foreign / non-matching key', () => {
      expect(parseGenerationFromName(prefix, 'other/segments/x.1.crbm')).toBeNull();
      expect(parseGenerationFromName(prefix, `${prefix}1.txt`)).toBeNull();
      expect(parseGenerationFromName(prefix, `${prefix}abc.crbm`)).toBeNull();
    });
    it('rejects a different segment sharing the prefix string', () => {
      // segment "s.x" would be "_default/segments/s.x.<gen>.crbm" — its middle isn't all digits under "s."
      expect(parseGenerationFromName(prefix, '_default/segments/s.x.1.crbm')).toBeNull();
    });
  });
});
