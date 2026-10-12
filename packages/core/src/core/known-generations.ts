/**
 * The generations a segment's row knows it published: its known-generations ledger, `knownGens`. Each entry is a
 * generation's number and the footer checksum of its object, in the order the generations were made current, oldest
 * first and the current one last. The kept window a load collects by name is derived from it: the entries numbered
 * below the pointer, so a load deletes what its publish pushed out of that window by name instead of listing the
 * bucket.
 *
 * The record is a cache of what a listing would keep, never an inventory of the bucket: a generation can be named here
 * and gone from the bucket (a lifecycle rule took it, or a load with a smaller `keep` collected it), and the bucket
 * can hold one the row does not name. A row with no ledger is correct, and its load lists. A patch that moves the
 * pointer without naming the ledger drops it (see `applyRegistryPatch`), so a writer that forgets the ledger leaves a
 * row that lists, never one that vouches for a generation it should not. Pure: no I/O, time or randomness.
 */
import { ascending } from './order';
import { fingerprintParts } from './crbm/fingerprint';
import type { KnownGeneration, RegistryRecord } from './ports';

/**
 * The most generations a load that collects by name records as its window. A `keep` above it collects by listing.
 */
export const MAX_KEPT_GENERATIONS = 64;

/**
 * A writer keeps entries that nothing protects and no lease holds only while the ledger holds fewer than this many.
 */
export const KNOWN_FILL = 128;

/** The most entries a writer writes, and the most the shared validator accepts at a write. */
export const MAX_KNOWN_GENERATIONS = 192;

/** The most entries a stored row may hold: twice what a writer writes. */
export const MAX_STORED_KNOWN_GENERATIONS = 384;

/**
 * The row's ledger when a collection or a rollback may rely on it: present and not empty, on an active row with a
 * pointer, its last entry the pointer, and, where the row's summary is in the clear and describes that generation, its
 * checksum the one the summary's fingerprint carries. A well-formed ledger that disagrees with its row is read but not
 * used (the row counts as one with no ledger), as a summary that names another generation is.
 */
export function usableKnownGens(
  record: RegistryRecord | null,
): readonly KnownGeneration[] | undefined {
  const known = record?.knownGens;
  if (
    record === null ||
    known === undefined ||
    known.length === 0 ||
    record.status !== 'active' ||
    record.currentGen === null
  ) {
    return undefined;
  }
  const last = known[known.length - 1]!;
  if (last.generation !== record.currentGen) return undefined;
  const summary = record.summary;
  if (
    summary !== undefined &&
    summary.generation === record.currentGen &&
    'fingerprint' in summary &&
    fingerprintParts(summary.fingerprint)?.footerCrc !== last.footerCrc
  ) {
    return undefined;
  }
  return known;
}

/**
 * The generations the row keeps as its window: the ledger's numbers other than the pointer, when the ledger is usable
 * and none of them is above the pointer (an entry above it is one a rollback left, and the window is then not
 * known). `undefined` otherwise, and the load lists.
 */
export function windowOf(record: RegistryRecord | null): readonly number[] | undefined {
  const known = usableKnownGens(record);
  if (known === undefined) return undefined;
  const pointer = record!.currentGen!;
  const below = known.slice(0, -1).map((e) => e.generation);
  return below.some((g) => g >= pointer) ? undefined : below;
}

/** Which generations below a new pointer a grace window holds, and which it lets go: both ascending. */
interface KeptWindow {
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
 * it. Every window a load keeps comes from here: the one its publish records in the row ({@link nextKnown}), and the one
 * a listing keeps when the row records none.
 */
export function keptWindow(
  below: readonly number[],
  superseded: number | undefined,
  keep: number,
): KeptWindow {
  const oldestFirst = [...below].sort(ascending);
  const first =
    keep > 0 && superseded !== undefined && oldestFirst.includes(superseded)
      ? superseded
      : undefined;
  const held = new Set<number>(first === undefined ? [] : [first]);
  // The rest of the window, newest first.
  for (let i = oldestFirst.length - 1, room = keep - held.size; i >= 0 && room > 0; i--) {
    if (oldestFirst[i] === first) continue;
    held.add(oldestFirst[i]!);
    room -= 1;
  }
  return {
    kept: oldestFirst.filter((g) => held.has(g)),
    evict: oldestFirst.filter((g) => !held.has(g)),
  };
}

/**
 * `known`, held to the cap, in the same order. It always keeps the entries numbered in `protect`, then the ones numbered
 * in `leased`, most recently current first, up to {@link MAX_KNOWN_GENERATIONS}, then the rest, most recently current
 * first, while the ledger holds fewer than {@link KNOWN_FILL}. So a protected or leased entry is never dropped for room,
 * and an unprotected one only when the ledger is full. "Most recently current" is the end of the list.
 */
export function capKnown(
  known: readonly KnownGeneration[],
  protect: ReadonlySet<number>,
  leased: ReadonlySet<number> = new Set(),
): KnownGeneration[] {
  const keep = new Set<number>();
  for (const e of known) if (protect.has(e.generation)) keep.add(e.generation);
  for (let i = known.length - 1; i >= 0 && keep.size < MAX_KNOWN_GENERATIONS; i--) {
    if (leased.has(known[i]!.generation)) keep.add(known[i]!.generation);
  }
  for (let i = known.length - 1; i >= 0 && keep.size < KNOWN_FILL; i--)
    keep.add(known[i]!.generation);
  return known.filter((e) => keep.has(e.generation));
}

/** `known` with `entry` made the most recent: any entry for its generation removed, and the entry added last. */
export function makeCurrent(
  known: readonly KnownGeneration[],
  entry: KnownGeneration,
): KnownGeneration[] {
  return [...known.filter((e) => e.generation !== entry.generation), entry];
}

/** What a publish of a generation writes into the row, and which names it pushes out of the window. */
export interface KnownAfter {
  /** The ledger to write: the generation published is its last entry. */
  readonly known: readonly KnownGeneration[];
  /** The window as numbers to collect by name, or `undefined` to collect by listing. */
  readonly list: readonly number[] | undefined;
  /** The generations the window no longer keeps, ascending: the names to delete. */
  readonly evict: readonly number[];
}

/**
 * What a publish of `generation` (its object's footer checksum `footerCrc`) over `prev` writes into the row.
 *
 * The window is today's rule: `keep` of the numbers the row's window names and the generation that was current, the
 * superseded one first ({@link keptWindow}), with the names that fell out of it. It is recorded, and collected by name,
 * only when the row has a usable window to extend (except for generation 0, which has nothing below it), when `keep` is
 * at most {@link MAX_KEPT_GENERATIONS}, and when a `keep` is given.
 *
 * The ledger is the window's entries in the order they were made current and the new generation last. When no window is
 * recorded, it carries the ledger it found (an entry for the new generation's number is a stale one and is replaced),
 * held to the cap with only the new generation protected; a row with no usable ledger starts one with the new
 * generation alone. A publish that clears leases is an erasure's rewrite, which deletes every older generation, so its
 * ledger is the new generation alone.
 */
export function nextKnown(
  prev: RegistryRecord | null,
  generation: number,
  footerCrc: number,
  keep: number | undefined,
  options: { readonly clearsLeases?: boolean } = {},
): KnownAfter {
  const self: KnownGeneration = { generation, footerCrc };
  const none = { list: undefined, evict: [] as number[] };
  let window: { list: readonly number[] | undefined; evict: readonly number[] } = none;
  const found = usableKnownGens(prev);
  if (keep !== undefined && keep <= MAX_KEPT_GENERATIONS) {
    if (generation === 0) {
      window = { list: [], evict: [] };
    } else {
      const previous = prev?.currentGen ?? null;
      const named = windowOf(prev);
      if (previous !== null && named !== undefined) {
        const { kept, evict } = keptWindow([...named, previous], previous, keep);
        window = { list: kept, evict };
      }
    }
  }
  if (options.clearsLeases === true) return { known: [self], ...window };
  if (window.list !== undefined) {
    const members = new Set(window.list);
    const entries = (found ?? []).filter((e) => members.has(e.generation));
    const all = new Set([...members, generation]);
    return { known: capKnown([...entries, self], all), ...window };
  }
  const carried = (found ?? []).filter((e) => e.generation !== generation);
  return { known: capKnown([...carried, self], new Set([generation])), ...window };
}

/**
 * The ledger a rollback onto `target` writes over `prev`: the ledger it found with the target moved to the end, as the
 * most recently current. A row with no usable ledger starts one with the target alone. A target the ledger did not name
 * is an insert, and the ledger it makes is held to the cap with the target and the generation the rollback leaves
 * protected; a known target's ledger is written as read, unless another build wrote one that is past the writer's cap.
 */
export function rollbackKnown(
  prev: RegistryRecord,
  target: KnownGeneration,
): readonly KnownGeneration[] {
  const found = usableKnownGens(prev);
  if (found === undefined) return [target];
  const moved = makeCurrent(found, target);
  const inserted = !found.some((e) => e.generation === target.generation);
  if (!inserted && moved.length <= MAX_KNOWN_GENERATIONS) return moved;
  return capKnown(moved, new Set([target.generation, prev.currentGen!]));
}

/**
 * The ledger that puts a row back as it was, for the undo of a rollback: the row's own when it is usable (the
 * generation it left is its last entry), held to the writer's cap when another build wrote one past it, with the
 * generation the undo leaves and the one it moves from protected; `undefined` for a row that had none to put back.
 */
export function describingKnown(
  record: RegistryRecord,
  movedTo: number,
): readonly KnownGeneration[] | undefined {
  const found = usableKnownGens(record);
  if (found === undefined || found.length <= MAX_KNOWN_GENERATIONS) return found;
  return capKnown(found, new Set([record.currentGen!, movedTo]));
}
