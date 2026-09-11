import {
  assertValidKeyPrefix,
  partitionKey,
  registryKeyPair,
  registrySortKey,
} from '@/drivers/dynamodb/keys';
import { ValidationError } from '@/core/errors';

// The single-table key grammar. It used to carry `chunk#<key>` sort keys for the warm rows alongside the
// registry's `reg#`; the warm tier is gone and with it those helpers, but the *scheme* is deliberately
// unchanged — a table that still holds `chunk#…` items from an older build is simply never queried for them,
// rather than having its keys reinterpreted. So the prefix convention stays pinned here.
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

  describe('assertValidKeyPrefix', () => {
    it('accepts an absent or empty prefix, and any string free of the delimiters', () => {
      for (const ok of [undefined, '', 'shardA', 'tenant-7', 'a.b_c']) {
        expect(() => assertValidKeyPrefix(ok)).not.toThrow();
      }
    });
    it('rejects a prefix that could alias another prefix through the PK delimiters', () => {
      // Prefix isolation is structural, not conventional: a prefix containing the delimiters could make one
      // logical store's partition key equal another's, which is a cross-tenant read.
      for (const bad of ['a|b', 'a#b']) {
        expect(() => assertValidKeyPrefix(bad)).toThrow(ValidationError);
      }
    });
  });

  describe('registryKeyPair', () => {
    it('returns the (pk, sk) of a segment’s single registry row and validates the ref', () => {
      expect(registryKeyPair({ segment: 's' })).toEqual({
        pk: 'ns#_default|seg#s',
        sk: 'reg#',
      });
      expect(registryKeyPair({ namespace: 't1', segment: 's' }, 'shardA')).toEqual({
        pk: 'shardA|ns#t1|seg#s',
        sk: 'reg#',
      });
      for (const bad of ['..', 'a/b', '']) {
        expect(() => registryKeyPair({ segment: bad })).toThrow(ValidationError);
      }
    });

    it('the registry sort key is a constant, so a segment can hold exactly one row', () => {
      expect(registrySortKey()).toBe('reg#');
      expect(registryKeyPair({ segment: 'a' }).sk).toBe(registryKeyPair({ segment: 'b' }).sk);
    });

    it('a chunk row left by an older build cannot collide with the registry row', () => {
      // `list` filters on the `reg#` sort key, so legacy `chunk#…` items in the same partition are inert.
      // This is the property that makes them safe to leave behind rather than requiring a migration.
      expect(registrySortKey().startsWith('chunk#')).toBe(false);
      expect('chunk#00042'.startsWith(registrySortKey())).toBe(false);
    });
  });
});
