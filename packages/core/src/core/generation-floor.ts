/**
 * Which listed generation numbers a load numbers past, and which it ignores. A row names generations three ways: its
 * pointer, its `knownGens` ledger and its leases. A number listed in the bucket far above everything the row names is
 * not one this library wrote under the row (an orphan of a crashed load, or of one in flight, sits within a few
 * numbers of the pointer, and a rolled-back ledger spans at most its own length), so a load does not climb to it:
 * a single object put at a huge number would otherwise make every later load take a number above it, or fail
 * once none is left. The load never deletes or takes such a number; it reports it.
 */
import type { RegistryRecord } from './ports';

/**
 * How far above the highest number a row names a listed number can be and still count as one a load numbers past.
 * More than this is a stray. A constant, not an option: the largest ledger a row stores is 384 entries, and a crash
 * loop of a few hundred failed loads still fits.
 */
export const STRAY_MARGIN = 1024;

/** The most strays a load reports by number; the count carries the rest. */
export const MAX_REPORTED_STRAYS = 64;

/** What a load reports about the generations it ignored: the count, and the lowest {@link MAX_REPORTED_STRAYS}. */
export interface Strays {
  readonly count: number;
  readonly generations: readonly number[];
}

/** What a load that did not list reports. */
export const NO_STRAYS: Strays = Object.freeze({
  count: 0,
  generations: Object.freeze([]) as readonly number[],
});

/**
 * The highest number `row` names: its pointer, any `knownGens` entry (usable or not) and any `leases` entry (live or
 * ended); -1 when it names none (no row, or no pointer and no entries).
 */
export function floorOf(row: RegistryRecord | null): number {
  let floor = row?.currentGen ?? -1;
  for (const e of row?.knownGens ?? []) if (e.generation > floor) floor = e.generation;
  for (const e of row?.leases ?? []) if (e.generation > floor) floor = e.generation;
  return floor;
}

/** The listed numbers more than {@link STRAY_MARGIN} above {@link floorOf}`(row)`, in the order listed. */
export function straysOf(listed: readonly number[], row: RegistryRecord | null): number[] {
  const limit = floorOf(row) + STRAY_MARGIN;
  return listed.filter((g) => g > limit);
}

/** The report for `strays` (ascending or not): the count and the lowest {@link MAX_REPORTED_STRAYS}, ascending. */
export function reportStrays(strays: readonly number[]): Strays {
  if (strays.length === 0) return NO_STRAYS;
  const generations = [...strays].sort((a, b) => a - b).slice(0, MAX_REPORTED_STRAYS);
  return { count: strays.length, generations };
}
