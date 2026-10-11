/**
 * The generations a segment's row records as kept: the grace window below its pointer, so a load collects what its
 * publish pushed out of the window by name instead of listing the bucket.
 *
 * The record is a cache of what a listing would keep, never an inventory of the bucket. Absent means the row does not
 * know, and the load lists; an empty list means nothing below the pointer is kept. A patch that moves the pointer
 * without naming the list drops it (see `applyRegistryPatch`), so a writer that forgets the list leaves a row that
 * lists, never one that deletes a generation it should keep. Pure: no I/O, time or randomness.
 */
import type { RegistryRecord } from './ports';

/**
 * The most generations a writer records. A `keep` above it records none, and the load lists on every publish. A
 * reader accepts up to {@link MAX_STORED_KEPT_GENERATIONS}, so a release can write more than this without a new row
 * schema.
 */
export const MAX_KEPT_GENERATIONS = 64;

/** The most entries a stored row may hold: four times what a writer writes. */
export const MAX_STORED_KEPT_GENERATIONS = 256;

/**
 * The row's list when a collection may rely on it: present, on a row with a pointer, and every entry below that
 * pointer. A well-formed list that disagrees with the pointer is read but not used (the load lists instead), as a
 * summary that names another generation is.
 */
export function usableKeptGens(record: RegistryRecord | null): readonly number[] | undefined {
  const list = record?.keptGens;
  if (record === null || list === undefined || record.currentGen === null) return undefined;
  for (const g of list) if (g >= record.currentGen) return undefined;
  return list;
}

/** Which generations below a new pointer a grace window holds, and which it lets go: both ascending. */
export interface KeptWindow {
  readonly kept: number[];
  readonly evict: number[];
}

/**
 * The generations below a new pointer that a grace window of `keep` holds, out of `below`: the generation the publish
 * superseded first, when it is among them, then the newest of the rest by number. When it is not among them (no
 * generation was current, or its object has gone from the bucket), the newest `keep`.
 *
 * The superseded generation is the one reads were on until the publish, and, after a rollback, the one the operator
 * restored, which a pin taken since reads, and the one to roll back to if the new load is bad too. The
 * generations a rollback moved away from are newer by number, so a window by number alone would keep those and delete
 * it. Every window a load keeps comes from here: the one its publish records in the row ({@link nextKept}), and the one
 * a listing keeps when the row records none.
 */
export function keptWindow(
  below: readonly number[],
  superseded: number | undefined,
  keep: number,
): KeptWindow {
  const first =
    keep > 0 && superseded !== undefined && below.includes(superseded) ? superseded : undefined;
  const newest = below.filter((g) => g !== first).sort((a, b) => b - a);
  const held = new Set(newest.slice(0, first === undefined ? keep : keep - 1));
  if (first !== undefined) held.add(first);
  const ascending = [...below].sort((a, b) => a - b);
  return {
    kept: ascending.filter((g) => held.has(g)),
    evict: ascending.filter((g) => !held.has(g)),
  };
}

/** What a publish of a generation writes into the row, and which names it pushes out of the window. */
export interface KeptAfter {
  /** The list to write, or `undefined` to write none (the row then does not know, and the next load lists). */
  readonly list: readonly number[] | undefined;
  /** The generations the window no longer keeps, ascending: the names to delete. */
  readonly evict: readonly number[];
}

/**
 * The list a publish of `generation` over `prev` writes: the window of `keep` ({@link keptWindow}) over the row's list
 * and the generation that was current, which it superseded, and the names that fell out of it. Every entry of a usable
 * list is below the pointer, so the superseded generation is the newest of them, and the window is the newest `keep`.
 * Only generations that were current are named, so a number a refused or crashed load took is never in it.
 *
 * No list is written when the row has no usable list to extend (except for generation 0, which has nothing below it),
 * when `keep` is above {@link MAX_KEPT_GENERATIONS}, or when no `keep` is given.
 */
export function nextKept(
  prev: RegistryRecord | null,
  generation: number,
  keep: number | undefined,
): KeptAfter {
  const none: KeptAfter = { list: undefined, evict: [] };
  if (keep === undefined || keep > MAX_KEPT_GENERATIONS) return none;
  if (generation === 0) return { list: [], evict: [] };
  const previous = prev?.currentGen ?? null;
  const known = usableKeptGens(prev);
  if (previous === null || known === undefined) return none;
  const { kept, evict } = keptWindow([...known, previous], previous, keep);
  return { list: kept, evict };
}
