import { crc32c } from '@/core/crbm/crc32c';

/**
 * Four free bytes that make `bytes`' CRC32C equal `target`: CRC32C of a fixed length is affine over GF(2), so flipping
 * each of the 32 bits at `at` and recording what it does to the CRC gives a 32 x 32 linear system, solved by
 * elimination. Calculation, not search. Returns a copy of `bytes` with the four bytes at `at` set; throws if the
 * target is out of reach (the system is singular), which it never is for CRC32C.
 */
export function forgeCrc(bytes: Uint8Array, at: number, target: number): Uint8Array {
  const base = crc32c(bytes);
  const columns: number[] = [];
  for (let bit = 0; bit < 32; bit++) {
    const probe = Uint8Array.from(bytes);
    probe[at + (bit >> 3)]! ^= 1 << (bit & 7);
    columns.push((crc32c(probe) ^ base) >>> 0);
  }
  // Find which columns xor to `want`: reduce columns to a basis, remembering each one's combination as a bitmask.
  const want = (target ^ base) >>> 0;
  const basis: Array<{ value: number; mask: number }> = [];
  for (let i = 0; i < 32; i++) {
    let value = columns[i]!;
    let mask = 2 ** i;
    for (const b of basis) {
      if ((value ^ b.value) >>> 0 < value) {
        value = (value ^ b.value) >>> 0;
        mask = maskXor(mask, b.mask);
      }
    }
    if (value !== 0) basis.push({ value, mask });
    basis.sort((x, y) => y.value - x.value);
  }
  let rest = want;
  let chosen = 0;
  for (const b of basis) {
    if ((rest ^ b.value) >>> 0 < rest) {
      rest = (rest ^ b.value) >>> 0;
      chosen = maskXor(chosen, b.mask);
    }
  }
  if (rest !== 0) throw new Error('the target CRC is out of reach of these four bytes');
  const out = Uint8Array.from(bytes);
  for (let bit = 0; bit < 32; bit++) {
    if (Math.floor(chosen / 2 ** bit) % 2 === 1) out[at + (bit >> 3)]! ^= 1 << (bit & 7);
  }
  if (crc32c(out) !== target >>> 0) throw new Error('the forged bytes do not give the target CRC');
  return out;
}

/** XOR of two non-negative integers below 2^32, as an unsigned number. */
const maskXor = (a: number, b: number): number => (a ^ b) >>> 0;
