import { normalizeKeyPrefix, validateAndQuoteTable } from '@/drivers/mysql/keys';
import { ValidationError } from '@/core/errors';

describe('MySQL identifier validation', () => {
  it('accepts a plain identifier and a db-qualified one, backtick-quoting each part', () => {
    expect(validateAndQuoteTable('cloud_roaring_warm')).toBe('`cloud_roaring_warm`');
    expect(validateAndQuoteTable('app.warm_chunks')).toBe('`app`.`warm_chunks`');
    expect(validateAndQuoteTable('_t0')).toBe('`_t0`');
  });

  it('rejects anything that could break out of the identifier (injection surface)', () => {
    for (const bad of [
      '',
      'a.b.c', // >2 parts
      'foo; DROP TABLE users', // statement injection
      'foo bar', // whitespace
      'foo`bar', // embedded backtick (MySQL's identifier quote)
      'foo-bar', // hyphen
      '1abc', // leading digit
      'a'.repeat(65), // > 64 chars (MySQL identifier max)
      'régime', // non-ASCII
      'tbl;', // trailing semicolon
    ]) {
      expect(() => validateAndQuoteTable(bad)).toThrow(ValidationError);
    }
  });
});

describe('MySQL keyPrefix normalization', () => {
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

  it('rejects a prefix longer than the VARCHAR(191) column (silent-truncation collision guard)', () => {
    expect(normalizeKeyPrefix('a'.repeat(191))).toBe('a'.repeat(191)); // exactly the limit is fine
    expect(() => normalizeKeyPrefix('a'.repeat(192))).toThrow(ValidationError);
    // counted by Unicode code point (matching MySQL's VARCHAR char count), not UTF-16 code units:
    // 96 astral chars = 96 code points ≤ 191 (but 192 UTF-16 units) — must be accepted.
    expect(() => normalizeKeyPrefix('😀'.repeat(96))).not.toThrow();
  });
});
