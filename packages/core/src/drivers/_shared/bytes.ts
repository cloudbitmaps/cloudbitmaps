/** Byte-buffer helpers shared by the drivers. */

/**
 * The chunks of `parts`, in order, copied into one new `Uint8Array` that owns its bytes: no view of any part survives in
 * it, so a part's buffer can be reused or let go once this returns.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
