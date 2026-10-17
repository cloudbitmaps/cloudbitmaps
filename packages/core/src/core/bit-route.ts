/**
 * BitRouteSplitter — maps a 32-bit id to its chunk (top 16 bits) and remainder
 * (bottom 16 bits), per the data model.
 */
import { ValidationError } from './errors';

export const U32_MAX = 0xffff_ffff;
export const CHUNK_COUNT = 0x1_0000; // 65,536 possible chunk keys
const LOW_16 = 0xffff;

interface BitRoute {
  /** Top 16 bits — the chunk key (0..65535). */
  readonly chunkKey: number;
  /** Bottom 16 bits — the value within the chunk (0..65535). */
  readonly remainder: number;
}

/** Errors `splitId` threw, so a caller that adds the id's position can tell them from another ValidationError. */
const idErrors = new WeakSet<ValidationError>();

/** Was `err` thrown by {@link splitId} for an id outside the u32 range? */
export function isBadIdError(err: unknown): err is ValidationError {
  return err instanceof ValidationError && idErrors.has(err);
}

/** The error for an id that is not a u32. It names what is wrong with the id and never repeats its value. */
function badId(id: unknown): ValidationError {
  let got: string;
  if (id === null) got = 'null';
  else if (id === undefined) got = 'undefined';
  else if (typeof id === 'object') got = 'an object';
  else if (typeof id !== 'number') got = `${/^[aeiou]/.test(typeof id) ? 'an' : 'a'} ${typeof id}`;
  else if (!Number.isFinite(id)) got = 'NaN or an infinity';
  else if (id < 0) got = 'a negative number';
  else if (!Number.isInteger(id)) got = 'a number with a fraction';
  else got = `a number above ${U32_MAX} (ids are 32-bit)`;
  const err = new ValidationError(`an id must be an integer from 0 to ${U32_MAX}; got ${got}`);
  idErrors.add(err);
  return err;
}

/** The refusal {@link splitId} throws for a value that is not a u32 id, for a caller that checks the range itself. */
export function refusalOfId(id: unknown): ValidationError {
  return badId(id);
}

/** Split a u32 id into `{ chunkKey, remainder }`. Throws `ValidationError` for non-u32 input. */
export function splitId(id: number): BitRoute {
  if (!Number.isInteger(id) || id < 0 || id > U32_MAX) {
    throw badId(id);
  }
  return { chunkKey: id >>> 16, remainder: id & LOW_16 };
}

/**
 * Largest legal value inside a chunk payload. A chunk covers `CHUNK_COUNT` ids, so remainders run
 * `[0, CHUNK_COUNT - 1]`. Exported so the engine can assert it on untrusted tier bytes.
 */
export const MAX_REMAINDER = CHUNK_COUNT - 1;

/**
 * Recombine a chunk key + remainder back into the u32 id. Precondition: `chunkKey` is a validated
 * 16-bit value (tier-derived keys are validated upstream in the engine before reaching here, per
 * invariant 5); `remainder` is masked to 16 bits.
 */
export function joinId(chunkKey: number, remainder: number): number {
  return (((chunkKey & LOW_16) << 16) >>> 0) + (remainder & LOW_16);
}
