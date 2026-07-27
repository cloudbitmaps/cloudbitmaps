/**
 * CRC32C (Castagnoli, polynomial 0x1EDC6F41) — the pre-deserialize integrity screen for `.crbm`
 * payloads, index, and footer.
 *
 * Pure TypeScript, table-driven: `core/` may not import `crypto`/`node:crypto` (the determinism lint
 * enforces it), and a from-scratch implementation is what the cross-language golden corpus will be pinned
 * against. CRC32C (not CRC32) is the locked choice — it matches the hardware-accelerated checksum used
 * by SSE/iSCSI/Btrfs, and it is the algorithm the `.crbm` format locks in.
 */

/** Reflected CRC32C lookup table (256 entries), built once from the reflected polynomial. */
/**
 * Slicing-by-8 tables. `TABLES[0]` is the classic byte-at-a-time table; each subsequent table is the previous
 * one advanced by another byte position, which is what lets the loop below consume 8 bytes per iteration
 * instead of one.
 */
const TABLES = ((): Uint32Array[] => {
  const POLY = 0x82f63b78; // bit-reflected 0x1EDC6F41
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let k = 1; k < 8; k++) {
    const prev = tables[k - 1] as Uint32Array;
    const next = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      const v = prev[n] as number;
      next[n] = ((v >>> 8) ^ (t0[v & 0xff] as number)) >>> 0;
    }
    tables.push(next);
  }
  return tables;
})();
const T0 = TABLES[0] as Uint32Array;
const T1 = TABLES[1] as Uint32Array;
const T2 = TABLES[2] as Uint32Array;
const T3 = TABLES[3] as Uint32Array;
const T4 = TABLES[4] as Uint32Array;
const T5 = TABLES[5] as Uint32Array;
const T6 = TABLES[6] as Uint32Array;
const T7 = TABLES[7] as Uint32Array;

export function crc32c(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  let i = 0;
  // Eight bytes per iteration. Identical output to the byte-at-a-time form — this is the standard
  // slicing-by-8 arrangement of the same polynomial, not a different checksum — but it amortises the table
  // lookups and the loop overhead across eight bytes. That matters because this runs over the whole `.crbm`
  // index on every reader open, where the byte-at-a-time version measured ~3.3 ms/MiB and up to ~27 ms for a
  // maximally-sized index, all of it a synchronous stall on Node's only thread.
  const n8 = bytes.length - (bytes.length % 8);
  for (; i < n8; i += 8) {
    crc ^=
      (bytes[i] as number) |
      ((bytes[i + 1] as number) << 8) |
      ((bytes[i + 2] as number) << 16) |
      ((bytes[i + 3] as number) << 24);
    crc =
      ((T7[crc & 0xff] as number) ^
        (T6[(crc >>> 8) & 0xff] as number) ^
        (T5[(crc >>> 16) & 0xff] as number) ^
        (T4[(crc >>> 24) & 0xff] as number) ^
        (T3[bytes[i + 4] as number] as number) ^
        (T2[bytes[i + 5] as number] as number) ^
        (T1[bytes[i + 6] as number] as number) ^
        (T0[bytes[i + 7] as number] as number)) >>>
      0;
  }
  // Tail: whatever did not divide by 8, byte-at-a-time.
  for (; i < bytes.length; i++) {
    crc = ((T0[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
