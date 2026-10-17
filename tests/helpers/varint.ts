/** The LEB128 encoder the library used to ship, kept as the reference the tests encode with: append a u32 to `out`. */
export function writeVarint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 0x1_0000_0000) {
    throw new RangeError(`varint value must be a u32; got ${value}`);
  }
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}
