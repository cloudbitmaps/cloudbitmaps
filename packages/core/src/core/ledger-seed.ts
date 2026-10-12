/**
 * A ledger's first window. A row with no usable ledger does not say which generations below its pointer are kept, and a
 * ledger once written cannot say "not known": a publish that wrote the new generation alone would be read by the next
 * one as a complete, empty window, and its collection would delete what a count by `keep` keeps. So a publish that
 * makes a generation current over such a row seeds the ledger from the bucket with the window that count keeps: the
 * generation the row named as current first, when it is there, then the newest by number ({@link keptWindow}), each
 * with the footer checksum its object stores, and the new generation last. The publish then collects by that count,
 * which keeps exactly the seed.
 *
 * It seeds wherever a row that recorded a window by a compare-and-swap after its listing would have recorded one:
 * the first publish over a pointed row with no usable ledger, whatever `keep` (a written ledger cannot be "not
 * known"); a publish with `keep` at most {@link MAX_KEPT_GENERATIONS} and below the generation numbered, over a ledger
 * with an entry at or above its pointer (a rollback left one, so the window is not known); one whose guard found the
 * current object gone; and the first publish of an incarnation above generation 0.
 */
import { generationsOf } from './generation-list';
import { footerCrcUnder } from './crbm-open';
import { fingerprintParts } from './crbm/fingerprint';
import { isIntegrityError, isNotFoundError } from './errors';
import { MAX_KEPT_GENERATIONS, keptWindow, usableKnownGens, windowOf } from './known-generations';
import type { IStorageDriver, KnownGeneration, RegistryRecord, SegmentRef } from './ports';

/** The most generations below the new one a seed names: what the writer cap leaves beside the new one and 64 leases. */
const SEED_SPAN = 127;

/** Whether a publish of `generation` over `row` seeds its ledger. */
export function wantsSeed(
  row: RegistryRecord | null,
  generation: number,
  keep: number,
  currentGone: boolean,
): boolean {
  const small = keep <= MAX_KEPT_GENERATIONS;
  // An incarnation's first publish: no row, or a row with no pointer.
  if (row === null || row.currentGen === null) return small && generation > 0;
  if (row.status !== 'active') return false;
  if (usableKnownGens(row) === undefined) return true;
  if (small && currentGone) return true;
  return small && keep < generation && windowOf(row) === undefined;
}

/**
 * The entries a seed names, oldest first by number and the generation the row named as current last. `listed` is the
 * listing the load's numbering made, when it made one; otherwise the bucket is listed once. A generation gone from the
 * bucket, or whose footer fails its own checks, is left out; any other failed read throws, before anything is published.
 */
export async function readSeed(
  storage: IStorageDriver,
  ref: SegmentRef,
  row: RegistryRecord | null,
  generation: number,
  keep: number,
  listed: readonly number[] | undefined,
): Promise<KnownGeneration[]> {
  const present = listed ?? (await generationsOf(storage, ref));
  const superseded = row?.currentGen ?? undefined;
  const below = present.filter((g) => g < generation);
  const { kept } = keptWindow(below, superseded, Math.min(keep, SEED_SPAN));
  const order = [...kept.filter((g) => g !== superseded), ...kept.filter((g) => g === superseded)];
  const summary = row?.summary;
  const entries: KnownGeneration[] = [];
  for (const g of order) {
    const known =
      g === superseded &&
      summary !== undefined &&
      summary.generation === g &&
      'fingerprint' in summary
        ? fingerprintParts(summary.fingerprint)?.footerCrc
        : undefined;
    if (known !== undefined) {
      entries.push({ generation: g, footerCrc: known });
      continue;
    }
    try {
      entries.push({
        generation: g,
        footerCrc: await footerCrcUnder(storage, { ...ref, generation: g }),
      });
    } catch (err) {
      if (!isNotFoundError(err) && !isIntegrityError(err)) throw err;
    }
  }
  return entries;
}
