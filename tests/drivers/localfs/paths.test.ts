import { storageObjectFilename, storageObjectPath, parseGeneration } from '@/drivers/localfs/paths';
import { ValidationError } from '@/core/errors';

describe('parseGeneration', () => {
  it('parses the canonical <segment>.<gen>.crbm filename', () => {
    expect(parseGeneration('s', 's.0.crbm')).toBe(0);
    expect(parseGeneration('s', 's.7.crbm')).toBe(7);
    expect(parseGeneration('paying_users', 'paying_users.123.crbm')).toBe(123);
  });

  it('handles segments containing dots without ambiguity', () => {
    expect(parseGeneration('a.b', 'a.b.3.crbm')).toBe(3); // prefix is "a.b.", middle "3"
    expect(parseGeneration('a', 'a.b.3.crbm')).toBeNull(); // segment "a" must NOT match "a.b.3.crbm"
  });

  it('rejects non-canonical and non-matching names', () => {
    expect(parseGeneration('s', 's.crbm')).toBeNull(); // empty middle
    expect(parseGeneration('s', 's.07.crbm')).toBeNull(); // leading zero (would alias gen 7)
    expect(parseGeneration('s', 's.1.crbm.tmp')).toBeNull(); // orphan temp
    expect(parseGeneration('s', 's.x.crbm')).toBeNull(); // non-numeric
    expect(parseGeneration('s', 'README.txt')).toBeNull(); // foreign
    expect(parseGeneration('s', `s.${'9'.repeat(20)}.crbm`)).toBeNull(); // past safe-integer range
  });

  it('round-trips with storageObjectFilename for canonical generations', () => {
    for (const gen of [0, 1, 7, 65_535, 1_000_000]) {
      expect(parseGeneration('seg', storageObjectFilename('seg', gen))).toBe(gen);
    }
  });
});

describe('storageObjectPath', () => {
  it.each([-1, 1.5, 2 ** 53, Number.NaN])('refuses a generation of %s', (generation) => {
    expect(() => storageObjectPath('/root', { segment: 's', generation })).toThrow(ValidationError);
    expect(() => storageObjectPath('/root', { segment: 's', generation })).toThrow(
      `generation must be an integer of at least 0; got ${generation}`,
    );
  });

  it('takes generation 0 and the largest safe integer', () => {
    expect(storageObjectPath('/root', { segment: 's', generation: 0 })).toContain('s.0.crbm');
    expect(
      storageObjectPath('/root', { segment: 's', generation: Number.MAX_SAFE_INTEGER }),
    ).toContain(`s.${Number.MAX_SAFE_INTEGER}.crbm`);
  });
});
