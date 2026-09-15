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
    it('rejects only the names no encoding can fix', () => {
      for (const bad of ['', 'a'.repeat(257)]) {
        expect(() => partitionKey({ segment: bad })).toThrow(ValidationError);
        expect(() => partitionKey({ namespace: bad, segment: 's' })).toThrow(ValidationError);
      }
    });

    it('escapes a name that spells the PK delimiters instead of rejecting it', () => {
      // `#` and `|` separate the fields of this key, so a name containing them used to be refused. It is now
      // encoded, which is strictly safer: refusing relied on the grammar staying narrow, while escaping holds
      // whatever the name contains.
      expect(partitionKey({ segment: 'a|b' })).toBe('ns#_default|seg#a%7Cb');
      expect(partitionKey({ segment: 'a#b' })).toBe('ns#_default|seg#a%23b');
      // The point of it: two different names can never produce one partition key.
      expect(partitionKey({ namespace: 'a', segment: 'b|seg#c' })).not.toBe(
        partitionKey({ namespace: 'a', segment: 'b' }),
      );
      // …and a name cannot straddle a delimiter to claim another tenant's partition.
      expect(partitionKey({ segment: 'x|ns#evil|seg#y' })).toBe(
        'ns#_default|seg#x%7Cns%23evil%7Cseg%23y',
      );
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
      for (const bad of ['', 'a'.repeat(257)]) {
        expect(() => registryKeyPair({ segment: bad })).toThrow(ValidationError);
      }
      // A traversal-shaped name is ordinary now — it is escaped, not refused.
      expect(registryKeyPair({ segment: '../etc/passwd' }).pk).toBe(
        'ns#_default|seg#..%2Fetc%2Fpasswd',
      );
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
