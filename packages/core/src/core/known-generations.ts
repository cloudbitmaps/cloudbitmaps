/**
 * The generations a segment's row knows it published: its known-generations ledger, `knownGens`. Each entry is a
 * generation's number and the footer checksum of its object, in the order the generations were made current, oldest
 * first and the current one last. The kept window a load collects by name is derived from it: each publish chooses
 * the most recently current of the entries numbered below its own generation, so a load deletes what its publish pushed
 * out of that window by name instead of listing the bucket.
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
 * The generations the row keeps as its window: the numbers of the usable ledger's entries below the pointer, in the order
 * they were made current, or `undefined` when the ledger is not usable. A collection compares against these. An entry
 * numbered above the pointer is one a rollback left; no collection can take it, so it is no part of the window.
 */
export function windowOf(record: RegistryRecord | null): readonly number[] | undefined {
  const known = usableKnownGens(record);
  if (known === undefined) return undefined;
  const pointer = record!.currentGen!;
  return known.filter((e) => e.generation < pointer).map((e) => e.generation);
}

/**
 * Whether the row's ledger is a window a load with a small `keep` can extend: usable, and naming no more than
 * {@link MAX_KEPT_GENERATIONS} generations below the pointer that no live lease holds. A ledger carried through
 * publishes with a larger `keep` (`*Into`, `materializeMany`) names up to 127, and a count by a small `keep` would keep
 * fewer than it names, so the next small-`keep` load seeds a window from the bucket instead of extending that one. A
 * generation held only for a lease is no part of the window and does not count toward the limit.
 */
export function carriesWindow(record: RegistryRecord | null, leased: ReadonlySet<number>): boolean {
  const below = windowOf(record);
  return below !== undefined && below.filter((g) => !leased.has(g)).length <= MAX_KEPT_GENERATIONS;
}

/**
 * How many generations below its own a publish vouches for at most: what the writer cap leaves beside the new
 * generation and the 64 generations live leases can hold.
 */
export const KNOWN_SPAN = 127;

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
 * it. The window a listing keeps when the row records no usable ledger comes from here, and so does a ledger's first window
 * (`ledger-seed.ts`).
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
 * The ledger is in the order the generations were made current, so the order says which were current most recently.
 * That ranks the window, and the window is drawn from the entries numbered below the new generation only: collection
 * can only take generations numbered below the pointer. The window is the `keep` most recently current of them (at most
 * {@link KNOWN_SPAN}), so the generation the publish superseded, the ledger's last entry, comes first, and after a
 * rollback the ones the operator restored outrank the ones the rollback moved away from.
 *
 * What it writes, in the order the entries were made current and the new generation last:
 *
 *  - the window;
 *  - the entries below the new generation that `leased` names (a generation a live lease holds stays known, so it stays a
 *    rollback target while the lease lives), whatever `keep` says;
 *  - the entries numbered above the new generation, which a rollback left and a load numbered under: they are carried and
 *    never evicted, and take no slot of `keep`, while the ledger holds fewer than {@link KNOWN_FILL} entries (see
 *    {@link capKnown});
 *  - the new generation. An entry already numbered `generation` is a stale one (its object went outside the ledger) and
 *    is replaced.
 *
 * `evict` is the entries below the new generation that it leaves out, ascending: never a name at or above the new
 * generation. With a `keep` of at most {@link MAX_KEPT_GENERATIONS} the publish collects by name, so `list` is the
 * generations of the ledger below the new one; above that, or with no `keep`, `list` is `undefined` and `evict` empty, and
 * a load lists. A row with a pointer and no usable ledger writes the new generation alone and lists, unless the caller
 * passes a `seed` (see `ledger-seed.ts`): the window a count keeps, read from the bucket, then the new generation, and
 * the publish collects by that count. A publish that clears leases is an erasure's rewrite, which deletes every older
 * generation, so its ledger is the new generation alone.
 */
export function nextKnown(
  prev: RegistryRecord | null,
  generation: number,
  footerCrc: number,
  keep: number | undefined,
  options: {
    readonly clearsLeases?: boolean;
    readonly seed?: readonly KnownGeneration[];
    readonly leased?: ReadonlySet<number>;
  } = {},
): KnownAfter {
  const self: KnownGeneration = { generation, footerCrc };
  const clears = options.clearsLeases === true;
  const byName = keep !== undefined && keep <= MAX_KEPT_GENERATIONS;
  if (options.seed !== undefined && !clears) {
    // The window a count keeps, read from the bucket: the ledger names it, and the publish collects by that count.
    const seed = options.seed.filter((e) => e.generation < generation);
    const protect = new Set([...seed.map((e) => e.generation), generation]);
    return { known: capKnown([...seed, self], protect), list: undefined, evict: [] };
  }
  const found = usableKnownGens(prev);
  if (found === undefined && prev !== null && prev.currentGen !== null) {
    // A row that dropped its ledger, or one that disagrees with its row: nothing says what it kept, so a load lists.
    return { known: [self], list: undefined, evict: [] };
  }
  const all = found ?? [];
  const below = all.filter((e) => e.generation < generation);
  const above = clears ? [] : all.filter((e) => e.generation > generation);
  const span = clears ? 0 : Math.min(keep ?? Number.MAX_SAFE_INTEGER, KNOWN_SPAN);
  const vouch = new Set((span === 0 ? [] : below.slice(-span)).map((e) => e.generation));
  const leased = clears ? new Set<number>() : (options.leased ?? new Set<number>());
  const held = below.filter((e) => !vouch.has(e.generation) && leased.has(e.generation));
  const chosen = new Set([
    ...vouch,
    ...held.map((e) => e.generation),
    ...above.map((e) => e.generation),
  ]);
  const known = capKnown(
    [...all.filter((e) => chosen.has(e.generation)), self],
    new Set([...vouch, generation]),
    leased,
  );
  if (!byName) return { known, list: undefined, evict: [] };
  const named = new Set(known.map((e) => e.generation));
  return {
    known,
    list: known
      .filter((e) => e.generation < generation)
      .map((e) => e.generation)
      .sort(ascending),
    evict: below
      .filter((e) => !named.has(e.generation))
      .map((e) => e.generation)
      .sort(ascending),
  };
}

/**
 * The ledger a rollback onto `target` writes over `prev`: the ledger it found with the target moved to the end, as the
 * most recently current. A rollback never starts a ledger: over a row with no usable ledger it writes none, and the
 * next publish seeds one. A target the ledger did not name
 * is an insert, and the ledger it makes is held to the cap with the target and the generation the rollback leaves
 * protected; a known target's ledger is written as read, unless another build wrote one that is past the writer's cap.
 */
export function rollbackKnown(
  prev: RegistryRecord,
  target: KnownGeneration,
): readonly KnownGeneration[] | undefined {
  const found = usableKnownGens(prev);
  if (found === undefined) return undefined;
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
