import { normalizeKeyPrefix, validateAndQuoteTable } from '@/drivers/cassandra/keys';
import { ValidationError } from '@/core/errors';

describe('Cassandra identifier validation', () => {
  it('validates + quotes keyspace.table', () => {
    expect(validateAndQuoteTable('my_ks', 'cloud_roaring_warm')).toBe(
      '"my_ks"."cloud_roaring_warm"',
    );
    expect(validateAndQuoteTable('_ks', 't0')).toBe('"_ks"."t0"');
  });

  it('rejects an unsafe keyspace or table identifier (CQL-injection surface)', () => {
    for (const bad of ['', 'a b', 'a;b', 'a-b', 'a"b', '1abc', 'a'.repeat(49), 'a.b']) {
      expect(() => validateAndQuoteTable(bad, 't')).toThrow(ValidationError);
      expect(() => validateAndQuoteTable('ks', bad)).toThrow(ValidationError);
    }
  });

  it('normalizes the keyPrefix and rejects control chars', () => {
    expect(normalizeKeyPrefix('tenant-a')).toBe('tenant-a');
    expect(normalizeKeyPrefix(undefined)).toBe('');
    for (const bad of ['a\tb', 'a\0b'])
      expect(() => normalizeKeyPrefix(bad)).toThrow(ValidationError);
  });
});
