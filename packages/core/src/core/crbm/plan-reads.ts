/**
 * The read planner for coalesced chunk reads: from the index entries of the chunks a read needs, the fewest byte
 * ranges of one `.crbm` object that cover them, each read in one storage request.
 *
 * Pure format arithmetic over numbers: no I/O, no clock, no randomness, and no parsing of the bytes it plans reads
 * for. The reader that executes a plan ({@link CrbmReader.getChunks}) slices each needed chunk out of the bytes a
 * range returns and checks it exactly as a read of that chunk alone is checked; the bytes in a gap between two
 * needed chunks are fetched and never looked at.
 *
 * The rule is the one every range-coalescing reader uses. Walk the needed chunks in object order and extend the
 * current read while the unneeded bytes between it and the next chunk are at most {@link MAX_COALESCE_GAP_BYTES}
 * and the read stays at most {@link MAX_COALESCED_READ_BYTES}. A chunk that is larger than that bound by itself is
 * read alone, since a chunk is never split.
 */
import { IntegrityError } from '../errors';
import { DEFAULT_MAX_BITMAP_BYTES } from './format';

/**
 * The most unneeded bytes one read may carry between two needed chunks: reading 256 KiB that nothing wants costs
 * a few milliseconds of transfer, while the request it saves costs a round trip.
 */
export const MAX_COALESCE_GAP_BYTES = 256 * 1024;

/**
 * The most bytes one read may span, unless it holds a single chunk. It equals the decode cap, so a window of
 * coalesced reads holds the window's width times the per-chunk cap that bounds a window of single-chunk reads.
 */
export const MAX_COALESCED_READ_BYTES: number = DEFAULT_MAX_BITMAP_BYTES;

/** One needed chunk, as its index entry places it in the object. */
export interface ChunkExtent {
  readonly key: number;
  readonly offset: number;
  readonly length: number;
}

/** One byte range to read, and the needed chunks inside it, in object order. */
export interface PlannedRead {
  readonly offset: number;
  readonly length: number;
  readonly chunks: readonly ChunkExtent[];
}

/** The part of an object that holds chunk payloads: `[start, end)`. */
export interface ChunkRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Plan the reads for `extents`: the needed chunks of one object, ascending by offset (the index lists chunks in key
 * order, which is object order), each at least a byte long, none overlapping another. The reads come back
 * ascending and disjoint, each covering one or more of the chunks, every chunk in exactly one read.
 *
 * Throws {@link IntegrityError} for an extent outside `region`, or out of order, or overlapping the one before it:
 * the index a plan is made from is untrusted bytes, and a read is never planned outside the chunk region.
 */
export function planChunkReads(
  extents: readonly ChunkExtent[],
  region: ChunkRegion,
): readonly PlannedRead[] {
  const reads: PlannedRead[] = [];
  let chunks: ChunkExtent[] = [];
  let start = 0;
  let end = 0;
  const flush = (): void => {
    if (chunks.length > 0) reads.push({ offset: start, length: end - start, chunks });
    chunks = [];
  };
  let previousEnd = region.start;
  for (const extent of extents) {
    const extentEnd = extent.offset + extent.length;
    if (extent.length < 1 || extent.offset < previousEnd || extentEnd > region.end) {
      throw new IntegrityError(`chunk ${extent.key} is not inside the chunk region, in order`);
    }
    previousEnd = extentEnd;
    if (
      chunks.length > 0 &&
      extent.offset - end <= MAX_COALESCE_GAP_BYTES &&
      extentEnd - start <= MAX_COALESCED_READ_BYTES
    ) {
      chunks.push(extent);
      end = extentEnd;
      continue;
    }
    flush();
    chunks.push(extent);
    start = extent.offset;
    end = extentEnd;
  }
  flush();
  return reads;
}
