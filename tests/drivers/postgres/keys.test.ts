import { normalizeKeyPrefix, validateAndQuoteTable } from '@/drivers/postgres/keys';
import { ValidationError } from '@/core/errors';

describe('Postgres identifier validation', () => {
  it('accepts a plain identifier and a schema-qualified one, quoting each part', () => {
    expect(validateAndQuoteTable('cloud_roaring_warm')).toBe('"cloud_roaring_warm"');
    expect(validateAndQuoteTable('app.warm_chunks')).toBe('"app"."warm_chunks"');
    expect(validateAndQuoteTable('_t0')).toBe('"_t0"');
  });

  it('rejects anything that could break out of the identifier (injection surface)', () => {
    for (const bad of [
      '',
      'a.b.c', // >2 parts
      'foo; DROP TABLE users', // statement injection
      'foo bar', // whitespace
      'foo"bar', // embedded quote
      'foo-bar', // hyphen
      '1abc', // leading digit
      'a'.repeat(64), // > 63 chars
      'régime', // non-ASCII
      'tbl;', // trailing semicolon
    ]) {
      expect(() => validateAndQuoteTable(bad)).toThrow(ValidationError);
    }
  });
});

describe('Postgres keyPrefix normalization', () => {
  it('passes a clean prefix through and maps undefined/empty to empty', () => {
    expect(normalizeKeyPrefix('tenant-a')).toBe('tenant-a');
    expect(normalizeKeyPrefix(undefined)).toBe('');
    expect(normalizeKeyPrefix('')).toBe('');
  });

  it('rejects control characters', () => {
    for (const bad of ['a\tb', 'a\nb', 'a\0b']) {
      expect(() => normalizeKeyPrefix(bad)).toThrow(ValidationError);
    }
  });
});
