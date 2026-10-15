import { crbmIntegrity } from '@/core/crbm/integrity';
import { MAX_COALESCED_READ_BYTES, MAX_COALESCE_GAP_BYTES } from '@/core/crbm/plan-reads';
import type { ChunkExtent, ChunkRegion, PlannedRead } from '@/core/crbm/plan-reads';

/**
 * The planner as it stood when it made every read at once: the reference the lazy walk is held to, copied rather than
 * imported so that a change to the walk cannot move it.
 */
export function planAllAtOnce(
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
    if (!(
      Number.isSafeInteger(extent.offset) &&
      Number.isSafeInteger(extent.length) &&
      extent.length >= 1 &&
      extent.offset >= previousEnd &&
      extentEnd <= region.end
    )) {
      throw crbmIntegrity(`chunk ${extent.key} is not inside the chunk region, in order`);
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
