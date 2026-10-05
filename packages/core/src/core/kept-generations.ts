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

/** What a publish of a generation writes into the row, and which names it pushes out of the window. */
export interface KeptAfter {
  /** The list to write, or `undefined` to write none (the row then does not know, and the next load lists). */
  readonly list: readonly number[] | undefined;
  /** The generations the window no longer keeps, ascending: the names to delete. */
  readonly evict: readonly number[];
}

/**
 * The list a publish of `generation` over `prev` writes: the newest `keep` of the row's list and the generation that
 * was current, and the names that fell out of it. Only generations that were current are named, so a number a refused
 * or crashed load took is never in it.
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
  const all = [...known, previous];
  const cut = Math.max(0, all.length - keep);
  return { list: all.slice(cut), evict: all.slice(0, cut) };
}
