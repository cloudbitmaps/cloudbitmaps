import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import { requireFiniteNumber, requireInteger, requirePositiveInteger } from '@/core/check';

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as Error).message;
  }
  throw new Error('did not throw');
}

describe('requireInteger', () => {
  const bounds = { min: 1, max: 8, what: 'width' };

  it('returns an integer on and between its bounds', () => {
    expect(requireInteger(1, bounds)).toBe(1);
    expect(requireInteger(5, bounds)).toBe(5);
    expect(requireInteger(8, bounds)).toBe(8);
    expect(requireInteger(0, { min: 0, what: 'x' })).toBe(0);
    expect(requireInteger(-3, { min: -5, max: -1, what: 'x' })).toBe(-3);
  });

  it('refuses a value just outside either bound', () => {
    expect(message(() => requireInteger(0, bounds))).toBe(
      'width must be an integer from 1 to 8; got 0',
    );
    expect(message(() => requireInteger(9, bounds))).toBe(
      'width must be an integer from 1 to 8; got 9',
    );
  });

  it('words a bound-less maximum as "at least"', () => {
    expect(message(() => requireInteger(-1, { min: 0, what: 'keep' }))).toBe(
      'keep must be an integer of at least 0; got -1',
    );
  });

  it('refuses a fraction, NaN and the infinities', () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity]) {
      expect(message(() => requireInteger(bad, bounds))).toBe(
        `width must be an integer from 1 to 8; got ${String(bad)}`,
      );
    }
  });

  it('refuses 2^53 and above, and accepts the largest safe integer', () => {
    const min = { min: 1, what: 'n' };
    expect(requireInteger(Number.MAX_SAFE_INTEGER, min)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => requireInteger(2 ** 53, min)).toThrow(ValidationError);
    expect(() => requireInteger(1e300, min)).toThrow(ValidationError);
    expect(() => requireInteger(2 ** 53, { min: 1, max: 2 ** 60, what: 'n' })).toThrow(
      ValidationError,
    );
  });

  it('shows a string quoted and any other type by its name', () => {
    expect(message(() => requireInteger('3', bounds))).toBe(
      'width must be an integer from 1 to 8; got "3"',
    );
    expect(message(() => requireInteger(null, bounds))).toBe(
      'width must be an integer from 1 to 8; got null',
    );
    expect(message(() => requireInteger(undefined, bounds))).toBe(
      'width must be an integer from 1 to 8; got undefined',
    );
    expect(message(() => requireInteger({}, bounds))).toContain('got object');
    expect(message(() => requireInteger(3n, bounds))).toContain('got 3');
    expect(message(() => requireInteger(true, bounds))).toContain('got true');
  });
});

describe('requirePositiveInteger', () => {
  it('accepts 1 and refuses 0, negatives and non-integers', () => {
    expect(requirePositiveInteger(1, 'limit')).toBe(1);
    expect(requirePositiveInteger(Number.MAX_SAFE_INTEGER, 'limit')).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [0, -1, 0.5, NaN, Infinity, '1', null, undefined, 2 ** 53]) {
      expect(() => requirePositiveInteger(bad, 'limit')).toThrow(ValidationError);
    }
    expect(message(() => requirePositiveInteger(0, 'limit'))).toBe(
      'limit must be an integer of at least 1; got 0',
    );
  });
});

describe('requireFiniteNumber', () => {
  it('accepts a fraction and both bounds', () => {
    expect(requireFiniteNumber(0.5, { min: 0, max: 1, what: 'x' })).toBe(0.5);
    expect(requireFiniteNumber(0, { min: 0, max: 1, what: 'x' })).toBe(0);
    expect(requireFiniteNumber(1, { min: 0, max: 1, what: 'x' })).toBe(1);
    expect(requireFiniteNumber(-1e9, { what: 'x' })).toBe(-1e9);
  });

  it('words each combination of bounds', () => {
    expect(message(() => requireFiniteNumber(2, { min: 0, max: 1, what: 'x' }))).toBe(
      'x must be a finite number from 0 to 1; got 2',
    );
    expect(message(() => requireFiniteNumber(-1, { min: 0, what: 'x' }))).toBe(
      'x must be a finite number of at least 0; got -1',
    );
    expect(message(() => requireFiniteNumber(5, { max: 1, what: 'x' }))).toBe(
      'x must be a finite number of at most 1; got 5',
    );
    expect(message(() => requireFiniteNumber('1', { what: 'x' }))).toBe(
      'x must be a finite number; got "1"',
    );
  });

  it('refuses NaN, the infinities, null and undefined', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
      expect(() => requireFiniteNumber(bad, { what: 'x' })).toThrow(ValidationError);
    }
  });
});
