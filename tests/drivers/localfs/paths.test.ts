import { coldObjectFilename, parseChunkRow, parseGeneration } from '@/drivers/localfs/paths';

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

  it('round-trips with coldObjectFilename for canonical generations', () => {
    for (const gen of [0, 1, 7, 65_535, 1_000_000]) {
      expect(parseGeneration('seg', coldObjectFilename('seg', gen))).toBe(gen);
    }
  });
});

describe('parseChunkRow', () => {
  it('parses canonical <chunkKey>.row filenames in range', () => {
    expect(parseChunkRow('0.row')).toBe(0);
    expect(parseChunkRow('7.row')).toBe(7);
    expect(parseChunkRow('65535.row')).toBe(65_535);
  });

  it('rejects non-canonical, out-of-range, and foreign names', () => {
    expect(parseChunkRow('00007.row')).toBeNull(); // leading zero spoof
    expect(parseChunkRow('65536.row')).toBeNull(); // past u16 range
    expect(parseChunkRow('7.row.tmp')).toBeNull(); // orphan temp
    expect(parseChunkRow('x.row')).toBeNull(); // non-numeric
    expect(parseChunkRow('7')).toBeNull(); // no suffix
    expect(parseChunkRow('README.txt')).toBeNull(); // foreign
  });
});
