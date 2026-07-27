/**
 * BitRouteSplitter — maps a 32-bit id to its chunk (top 16 bits) and remainder
 * (bottom 16 bits), per the data model.
 */
import { ValidationError } from './errors';

export const U32_MAX = 0xffff_ffff;
export const CHUNK_COUNT = 0x1_0000; // 65,536 possible chunk keys
const LOW_16 = 0xffff;

export interface BitRoute {
  /** Top 16 bits — the chunk key (0..65535). */
  readonly chunkKey: number;
  /** Bottom 16 bits — the value within the chunk (0..65535). */
  readonly remainder: number;
}

/** Split a u32 id into `{ chunkKey, remainder }`. Throws `ValidationError` for non-u32 input. */
export function splitId(id: number): BitRoute {
  if (!Number.isInteger(id) || id < 0 || id > U32_MAX) {
    throw new ValidationError(`id must be an integer in 0..${U32_MAX}; got ${id}`);
  }
  return { chunkKey: id >>> 16, remainder: id & LOW_16 };
}

/**
 * Recombine a chunk key + remainder back into the u32 id. Precondition: `chunkKey` is a validated
 * 16-bit value (tier-derived keys are validated upstream in the engine before reaching here, per
 * invariant 5); `remainder` is masked to 16 bits.
 */
/**
 * Largest legal value inside a chunk payload. A chunk covers `CHUNK_COUNT` ids, so remainders run
 * `[0, CHUNK_COUNT - 1]`. Exported so the engine can assert it on untrusted tier bytes.
 */
export const MAX_REMAINDER = CHUNK_COUNT - 1;

export function joinId(chunkKey: number, remainder: number): number {
  return (((chunkKey & LOW_16) << 16) >>> 0) + (remainder & LOW_16);
}
