import { chunkDocId, normalizeKeyPrefix, segmentScope } from '@/drivers/mongodb/keys';
import { ValidationError } from '@/core/errors';

describe('MongoDB keys', () => {
  it('builds a deterministic composite _id and a matching scope', () => {
    expect(chunkDocId('', { segment: 's', chunkKey: 7 })).toBe('|_default|s|7');
    expect(chunkDocId('p', { segment: 's', namespace: 'ns', chunkKey: 3 })).toBe('p|ns|s|3');
    expect(segmentScope('p', { segment: 's', namespace: 'ns' })).toEqual({
      kp: 'p',
      ns: 'ns',
      seg: 's',
    });
  });

  it('rejects an out-of-range / non-integer chunk key via the ref validator', () => {
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      expect(() => chunkDocId('', { segment: 's', chunkKey: bad })).toThrow(ValidationError);
    }
  });

  it('rejects a prefix with the "|" id delimiter or control chars', () => {
    for (const bad of ['a|b', 'a\tb', 'a\0b']) {
      expect(() => normalizeKeyPrefix(bad)).toThrow(ValidationError);
    }
    expect(normalizeKeyPrefix('tenant-a')).toBe('tenant-a');
    expect(normalizeKeyPrefix(undefined)).toBe('');
    expect(normalizeKeyPrefix('')).toBe('');
  });
});
