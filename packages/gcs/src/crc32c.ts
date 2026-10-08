/**
 * CRC32C (Castagnoli) of some bytes, in the form GCS takes in an object's `crc32c` metadata: the 4-byte big-endian
 * value, base64-encoded. Computed here rather than through the SDK so it is the same on every major the driver accepts.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32cBase64(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const value = (crc ^ 0xffffffff) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out.toString('base64');
}
