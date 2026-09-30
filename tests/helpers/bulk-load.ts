/**
 * The loader `store.load()` is built on, bound to the roaring codec and a real clock, for tests that write a
 * generation at a number they choose, or without publishing through the store. The library does not export it:
 * applications load through `store.load()`.
 */
import { bulkLoadCrbmGeneration as coreBulkLoad } from '@/core/crbm-storage-source';
import { roaringCodec } from '@/roaring-codec';
import { SystemClock } from '@/system-clock';

export type { BulkLoadResult } from '@/core/crbm-storage-source';

/** `store.load()`'s loader with the codec and clock the store would pass; an explicit option wins. */
export const bulkLoadCrbmGeneration: typeof coreBulkLoad = (driver, key, ids, options = {}) =>
  coreBulkLoad(driver, key, ids, {
    ...options,
    codec: options.codec ?? roaringCodec,
    clock: options.clock ?? new SystemClock(),
  });
