/**
 * The window of ids a read with a range is cut to, `(after, through]`, as the chunk key and the remainder at each end:
 * what `iterate`, every combine and a batch combine read with `after` or `through`. Pure: no I/O, time or randomness.
 *
 * ```
 *   after = 0x0001_0005, through = 0x0003_00ff     →  loKey 1, loRem 6, hiKey 3, hiRem 0xff
 *
 *   chunk key:   0         1               2           3               4
 *                skipped   edge: rem ≥ 6   whole       edge: rem ≤ 0xff   skipped
 * ```
 *
 * The chunk keys a read fetches are those inside the span `loKey..hiKey` ({@link keysWithin}); only the two edge chunks
 * are cut again, where the ids leave ({@link isEdge}, {@link edgeIds}, {@link cutToWindow}). A chunk the range covers
 * whole is read as it is.
 */
import { CHUNK_COUNT, joinId, MAX_REMAINDER, U32_MAX } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { ValidationError } from './errors';

/** A validated range: inclusive id bounds, as the chunk key and the remainder at each end. */
export interface IdWindow {
  readonly loKey: number;
  readonly loRem: number;
  readonly hiKey: number;
  readonly hiRem: number;
}

/** A range as a read is asked for it: each bound optional. */
interface IdBounds {
  readonly after?: number | undefined;
  readonly through?: number | undefined;
}

/**
 * Throws {@link ValidationError} unless `bound` is left out or is an id: an integer from 0 to 4294967295. The message
 * begins with the verb `op` that was asked, says what is wrong and never carries the value, which is an id.
 */
export function assertIdBound(
  name: 'after' | 'through',
  bound: number | undefined,
  op: string,
): void {
  if (bound !== undefined && (!Number.isInteger(bound) || bound < 0 || bound > U32_MAX)) {
    throw new ValidationError(`${op}: ${name} must be an integer from 0 to ${U32_MAX}`);
  }
}

/**
 * Validate a read's range for the verb `op`, which begins an error's message. `null` when none was asked for, so the
 * read does no extra work; `'empty'` when no id can be in it (`after >= through`, which is a cursor at the end of its
 * window, not an error).
 */
export function windowOf(range: IdBounds | undefined, op: string): IdWindow | 'empty' | null {
  const after = range?.after;
  const through = range?.through;
  if (after === undefined && through === undefined) return null;
  assertIdBound('after', after, op);
  assertIdBound('through', through, op);
  const lo = after === undefined ? 0 : after + 1;
  const hi = through ?? U32_MAX;
  if (lo > hi) return 'empty';
  return {
    loKey: Math.floor(lo / CHUNK_COUNT),
    loRem: lo % CHUNK_COUNT,
    hiKey: Math.floor(hi / CHUNK_COUNT),
    hiRem: hi % CHUNK_COUNT,
  };
}

/** The window a range with neither bound set describes: every id. */
export const WHOLE_ID_SPACE: IdWindow = {
  loKey: 0,
  loRem: 0,
  hiKey: CHUNK_COUNT - 1,
  hiRem: MAX_REMAINDER,
};

/**
 * Whether the window cuts inside `chunkKey`: one of its two edge chunks, and only where the bound falls inside the chunk
 * rather than on its boundary. A chunk the window covers whole is read as it is.
 */
export const isEdge = (chunkKey: number, w: IdWindow): boolean =>
  (chunkKey === w.loKey && w.loRem > 0) || (chunkKey === w.hiKey && w.hiRem < MAX_REMAINDER);

/** The ids of an edge chunk that lie inside the window. The chunk iterates ascending, so it stops at the top. */
export function* edgeIds(chunk: CodecBitmap, chunkKey: number, w: IdWindow): Generator<number> {
  const from = chunkKey === w.loKey ? w.loRem : 0;
  const to = chunkKey === w.hiKey ? w.hiRem : MAX_REMAINDER;
  for (const remainder of chunk) {
    if (remainder > to) return;
    if (remainder >= from) yield joinId(chunkKey, remainder);
  }
}

/** The index of the first of the ascending `keys` at or above `key`: a binary search. */
function firstAtLeast(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The ascending `keys` inside the window's chunk span, as a new array: two binary searches, no scan. */
export function keysWithin(keys: readonly number[], w: IdWindow): number[] {
  return keys.slice(firstAtLeast(keys, w.loKey), firstAtLeast(keys, w.hiKey + 1));
}

/**
 * The ascending `keys` inside the window's chunk span (every key, for `null`) and above the key `after`: what a read
 * that plans again after taking `after` still reads.
 */
export function keysAbove(keys: readonly number[], w: IdWindow | null, after: number): number[] {
  const span = w ?? WHOLE_ID_SPACE;
  return keysWithin(keys, after < span.loKey ? span : { ...span, loKey: after + 1, loRem: 0 });
}

/** The index of the first element of ascending `a` greater than `value`: a binary search. */
export function firstAbove(a: Uint32Array, value: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The part of an edge chunk's ascending remainders `rem` inside the window, as a view of `rem`. */
export function remaindersWithin(rem: Uint32Array, chunkKey: number, w: IdWindow): Uint32Array {
  const from = chunkKey === w.loKey ? w.loRem : 0;
  const to = chunkKey === w.hiKey ? w.hiRem : MAX_REMAINDER;
  return rem.subarray(firstAbove(rem, from - 1), firstAbove(rem, to));
}

/** An edge chunk cut to the window, as a new bitmap: the remainders {@link edgeIds} would yield. */
export function cutToWindow(
  codec: CodecInterface,
  chunk: CodecBitmap,
  chunkKey: number,
  w: IdWindow,
): CodecBitmap {
  const rem = chunk.toUint32Array ? chunk.toUint32Array() : Uint32Array.from(chunk);
  return codec.fromValues(remaindersWithin(rem, chunkKey, w));
}
