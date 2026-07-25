import {
  chunkKeyPair,
  chunkSortKey,
  chunkSortKeyPrefix,
  parseChunkSortKey,
  partitionKey,
} from '@/drivers/dynamodb/keys';
import { ValidationError } from '@/core/errors';

describe('DynamoDB single-table key grammar', () => {
  describe('partitionKey', () => {
    it('maps a segment ref to ns#…|seg#…', () => {
      expect(partitionKey({ segment: 'vips' })).toBe('ns#_default|seg#vips');
      expect(partitionKey({ namespace: 't1', segment: 'vips' })).toBe('ns#t1|seg#vips');
    });
    it('prepends an optional keyPrefix (table sharing / test isolation)', () => {
      expect(partitionKey({ segment: 'vips' }, 'shardA')).toBe('shardA|ns#_default|seg#vips');
      expect(partitionKey({ segment: 'vips' }, '')).toBe('ns#_default|seg#vips'); // empty == none
    });
    it('rejects an invalid segment/namespace name', () => {
      for (const bad of ['..', 'a/b', '', '.hidden']) {
        expect(() => partitionKey({ segment: bad })).toThrow(ValidationError);
        expect(() => partitionKey({ namespace: bad, segment: 's' })).toThrow(ValidationError);
      }
    });
  });

  describe('chunkSortKey', () => {
    it('zero-pads so lexicographic order == ascending chunkKey', () => {
      expect(chunkSortKey(0)).toBe('chunk#00000');
      expect(chunkSortKey(42)).toBe('chunk#00042');
      expect(chunkSortKey(65_535)).toBe('chunk#65535');
      // The property that matters: sorted strings == sorted numbers.
      const keys = [65_535, 0, 13, 9, 1024, 2];
      const bySk = [...keys].sort((a, b) => chunkSortKey(a).localeCompare(chunkSortKey(b)));
      expect(bySk).toEqual([...keys].sort((a, b) => a - b));
    });
  });

  describe('chunkKeyPair', () => {
    it('returns the (pk, sk) and validates the chunk ref', () => {
      expect(chunkKeyPair({ segment: 's', chunkKey: 7 })).toEqual({
        pk: 'ns#_default|seg#s',
        sk: 'chunk#00007',
      });
      for (const bad of [70_000, -1, 1.5, NaN]) {
        expect(() => chunkKeyPair({ segment: 's', chunkKey: bad })).toThrow(ValidationError);
      }
    });
  });

  describe('parseChunkSortKey', () => {
    it('round-trips chunkSortKey and ignores registry / foreign rows', () => {
      for (const k of [0, 1, 42, 65_535]) expect(parseChunkSortKey(chunkSortKey(k))).toBe(k);
      expect(parseChunkSortKey('reg#currentGen')).toBeNull(); // registry row, not a chunk
      expect(parseChunkSortKey('chunk#42')).toBeNull(); // not zero-padded (non-canonical)
      expect(parseChunkSortKey('chunk#000042')).toBeNull(); // 6 digits
      expect(parseChunkSortKey('chunk#abcde')).toBeNull();
      expect(parseChunkSortKey('garbage')).toBeNull();
    });
    it('the query prefix excludes registry rows', () => {
      expect('chunk#00001'.startsWith(chunkSortKeyPrefix())).toBe(true);
      expect('reg#currentGen'.startsWith(chunkSortKeyPrefix())).toBe(false);
    });
  });
});
