/**
 * A ledger's first window. A row with no usable ledger does not say which generations below its pointer are kept, and a
 * ledger once written cannot say "not known": a publish that wrote the new generation alone would be read by the next
 * one as a complete, empty window, and its collection would delete what a count by `keep` keeps. So a publish that
 * makes a generation current over such a row seeds the ledger from the bucket with the window that count keeps: the
 * generation the row named as current first, when it is there, then the newest by number ({@link keptWindow}), each
 * with the footer checksum its object stores, and the new generation last. The publish then collects by that count,
 * which keeps exactly the seed.
 *
 * It seeds at a ledger's birth only: the first publish over a pointed row with no usable ledger, whatever `keep` (a
 * written ledger cannot be "not known"); the first publish of an incarnation above generation 0; and a publish with a
 * small `keep` over a ledger that names more than {@link MAX_KEPT_GENERATIONS} generations below the pointer that no live
 * lease holds (carried through publishes with a larger `keep`, so not a window a small `keep` extends). Every other
 * publish takes its window from the ledger ({@link nextKnown}). A generation a live lease holds, that is listed below the
 * new one, is seeded beside the window, so it stays a rollback target as it does when the ledger carries it.
 */
import { mapWithConcurrency } from './concurrency';
import { generationsOf } from './generation-list';
import { ascending } from './order';
import { footerCrcUnder } from './crbm-open';
import { fingerprintParts } from './crbm/fingerprint';
import { isIntegrityError, isNotFoundError } from './errors';
import {
  KNOWN_SPAN,
  MAX_KEPT_GENERATIONS,
  carriesWindow,
  keptWindow,
  usableKnownGens,
} from './known-generations';
import { type ReadRetry, retryRead } from './retry';
import type { IStorageDriver, KnownGeneration, RegistryRecord, SegmentRef } from './ports';

/** The most leased generations a seed names beside its window: the most live leases this build writes. */
const SEED_LEASED = 64;

/** Whether a publish of `generation` over `row` seeds its ledger. */
export function wantsSeed(
  row: RegistryRecord | null,
  generation: number,
  keep: number,
  leased: ReadonlySet<number>,
): boolean {
  const small = keep <= MAX_KEPT_GENERATIONS;
  // An incarnation's first publish: no row, or a row with no pointer.
  if (row === null || row.currentGen === null) return small && generation > 0;
  if (row.status !== 'active') return false;
  if (usableKnownGens(row) === undefined) return true;
  return small && keep < generation && !carriesWindow(row, leased);
}

/** How many footer reads a seed has in flight at once. */
const SEED_READS = 8;

/**
 * The entries a seed names: the listed generations below the new one that a live lease holds and the window does not
 * keep, then the window oldest first by number with the generation the row named as current last. `listed` is the
 * listing the load's numbering made, when it made one; otherwise the bucket is listed once. Every entry's checksum is
 * read from its object's footer (a 104-byte read, under the store's read retry, {@link SEED_READS} at a time), the
 * superseded generation's too: when a clear summary describes it with another checksum, the row and the bucket
 * disagree about that number and it is left out. A generation gone from the bucket, or whose footer fails its own
 * checks, is left out; any other failed read throws, before anything is published.
 */
export async function readSeed(
  storage: IStorageDriver,
  ref: SegmentRef,
  row: RegistryRecord | null,
  generation: number,
  keep: number,
  listed: readonly number[] | undefined,
  leased: ReadonlySet<number>,
  readRetry?: ReadRetry,
): Promise<KnownGeneration[]> {
  const present = listed ?? (await retryRead(() => generationsOf(storage, ref), readRetry));
  const superseded = row?.currentGen ?? undefined;
  const below = present.filter((g) => g < generation);
  const { kept } = keptWindow(below, superseded, Math.min(keep, KNOWN_SPAN));
  const inWindow = new Set(kept);
  const leasedOnly = below
    .filter((g) => leased.has(g) && !inWindow.has(g))
    .sort(ascending)
    .slice(-SEED_LEASED);
  const order = [
    ...leasedOnly,
    ...kept.filter((g) => g !== superseded),
    ...kept.filter((g) => g === superseded),
  ];
  const summary = row?.summary;
  const described =
    summary !== undefined && 'fingerprint' in summary
      ? {
          generation: summary.generation,
          footerCrc: fingerprintParts(summary.fingerprint)?.footerCrc,
        }
      : undefined;
  const read = await mapWithConcurrency(order, SEED_READS, async (g) => {
    try {
      const footerCrc = await retryRead(
        () => footerCrcUnder(storage, { ...ref, generation: g }),
        readRetry,
      );
      if (g === superseded && described?.generation === g && described.footerCrc !== footerCrc) {
        return undefined;
      }
      return { generation: g, footerCrc };
    } catch (err) {
      if (!isNotFoundError(err) && !isIntegrityError(err)) throw err;
      return undefined;
    }
  });
  return read.filter((e): e is KnownGeneration => e !== undefined);
}
