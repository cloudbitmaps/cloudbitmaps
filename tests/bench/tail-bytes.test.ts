import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The helper the at-scale bench and the /demo replay check share: the reader's first-read size parsed from the format
// source, and the bytes of both objects' first reads.
const { readTailBytes, tailsRead } = createRequire(import.meta.url)(
  '../../bench/lib/tail-bytes.cjs',
) as {
  readTailBytes: (root: string) => number;
  tailsRead: (tail: number, objectBytes: { A: number; B: number }) => number;
};
const FORMAT = 'packages/core/src/core/crbm/format.ts';
const dirs: string[] = [];

function rootWith(declaration: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tail-bytes-'));
  dirs.push(dir);
  mkdirSync(dirname(join(dir, FORMAT)), { recursive: true });
  writeFileSync(join(dir, FORMAT), `${declaration}\n`);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('tailsRead', () => {
  it('counts one tail for an object over it and the whole object for one under it', () => {
    const tail = 256 * 1024;
    expect(tailsRead(tail, { A: 4_000_000, B: 4_000_000 })).toBe(2 * tail);
    expect(tailsRead(tail, { A: 100_000, B: 4_000_000 })).toBe(100_000 + tail);
    expect(tailsRead(tail, { A: 100_000, B: 50_000 })).toBe(150_000);
    expect(tailsRead(tail, { A: tail, B: tail + 1 })).toBe(2 * tail);
  });
});

describe('readTailBytes', () => {
  it('reads a product, a plain number and `_` digit separators', () => {
    expect(readTailBytes(rootWith('export const DEFAULT_TAIL_BYTES = 256 * 1024;'))).toBe(262144);
    expect(readTailBytes(rootWith('export const DEFAULT_TAIL_BYTES = 262144;'))).toBe(262144);
    expect(readTailBytes(rootWith('export const DEFAULT_TAIL_BYTES = 256 * 1_024;'))).toBe(262144);
    expect(readTailBytes(rootWith('export const DEFAULT_TAIL_BYTES = 262_144;'))).toBe(262144);
  });

  it.each(['0', '1.5 * 1024', '2 ** 18', 'SOMETHING'])('fails naming the file for %s', (value) => {
    expect(() => readTailBytes(rootWith(`export const DEFAULT_TAIL_BYTES = ${value};`))).toThrow(
      FORMAT,
    );
  });
});
