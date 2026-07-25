import {
  chunkHashKey,
  normalizeRedisPrefix,
  parseIndexMember,
  segmentIndexKey,
} from '@/drivers/redis/keys';
import { ValidationError } from '@/core/errors';

describe('Redis keys', () => {
  it('shares one hash tag between a segment index and its chunk hashes (cluster slot-safety)', () => {
    expect(segmentIndexKey('', { segment: 's' })).toBe('{|_default|s}idx');
    expect(chunkHashKey('', { segment: 's', chunkKey: 7 })).toBe('{|_default|s}c:7');
    // Same `{…}` tag ⇒ same slot for the index + every chunk hash of the segment.
    expect(segmentIndexKey('p', { segment: 's', namespace: 'ns' })).toBe('{p|ns|s}idx');
    expect(chunkHashKey('p', { segment: 's', namespace: 'ns', chunkKey: 3 })).toBe('{p|ns|s}c:3');
  });

  it('rejects an out-of-range / non-integer chunk key via the ref validator', () => {
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      expect(() => chunkHashKey('', { segment: 's', chunkKey: bad })).toThrow(ValidationError);
    }
  });

  it('rejects a prefix containing tag/key delimiters or control chars', () => {
    for (const bad of ['a{b', 'a}b', 'a|b', 'a:b', 'a\tb']) {
      expect(() => normalizeRedisPrefix(bad)).toThrow(ValidationError);
    }
    expect(normalizeRedisPrefix('tenant-a')).toBe('tenant-a');
    expect(normalizeRedisPrefix(undefined)).toBe('');
    expect(normalizeRedisPrefix('')).toBe('');
  });

  it('parseIndexMember accepts canonical decimals in range, rejects the rest', () => {
    expect(parseIndexMember('0')).toBe(0);
    expect(parseIndexMember('65535')).toBe(65_535);
    expect(parseIndexMember('07')).toBeNull(); // no leading zeros
    expect(parseIndexMember('70000')).toBeNull(); // > u16
    expect(parseIndexMember('x')).toBeNull();
    expect(parseIndexMember('-1')).toBeNull();
  });
});
