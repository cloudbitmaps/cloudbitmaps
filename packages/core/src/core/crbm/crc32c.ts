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
const TABLE = ((): Uint32Array => {
  const POLY = 0x82f63b78; // bit-reflected 0x1EDC6F41
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32C of `bytes` (optionally continuing from a previous `seed`, for streaming over multiple
 * buffers). Returns an unsigned 32-bit integer.
 */
export function crc32c(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (TABLE[(crc ^ bytes[i]!)! & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
