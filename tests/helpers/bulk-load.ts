/**
 * The loader `store.load()` is built on, bound to the roaring codec and a real clock, for tests that write a
 * generation at a number they choose, or without publishing through the store. The library does not export it:
 * applications load through `store.load()`.
 *
 * In the `serialized` project it hands the loader its ids as `{ serialized }`, decoded the way core's load decodes
 * one (`tests/helpers/load-routing.ts`), so every test that seeds a segment through it, `loaded.ts`'s fixtures
 * included, writes through the bitmap path there. In the `sorted` project it hands the loader the same ids sorted, as
 * the sorted input a load with `sorted: true` writes from, so the same tests write through the sorted path.
 */
import { bulkLoadCrbmGeneration as coreBulkLoad } from '@/core/bulk-load';
import { DecodedLoadInput, SortedLoadInput, prepareLoadInput } from '@/core/load-input';
import type { LoadInput } from '@/core/load-input';
import { roaringCodec } from '@/roaring-codec';
import { SystemClock } from '@/system-clock';
import { testEntropy } from './entropy';
import {
  kindOf,
  routedProject,
  routing,
  sortedProject,
  toSerialized,
  toSorted,
} from './load-routing';

export type { BulkLoadResult } from '@/core/bulk-load';

/** `store.load()`'s loader with the codec, clock and entropy the store would pass; an explicit option wins. */
export const bulkLoadCrbmGeneration: typeof coreBulkLoad = async (
  driver,
  key,
  ids,
  options = {},
) => {
  const codec = options.codec ?? roaringCodec;
  let input = ids;
  if (routedProject() && !(ids instanceof DecodedLoadInput)) {
    const converted = await toSerialized(ids);
    routing.received.push(kindOf(converted));
    input = prepareLoadInput(converted as LoadInput, codec) as typeof ids;
  } else if (sortedProject() && !(ids instanceof DecodedLoadInput)) {
    const sorted = await toSorted(ids);
    routing.received.push(sorted === undefined ? kindOf(ids) : 'sorted');
    if (sorted !== undefined) input = new SortedLoadInput(sorted);
  }
  return coreBulkLoad(driver, key, input, {
    ...options,
    codec,
    clock: options.clock ?? new SystemClock(),
    entropy: options.entropy ?? testEntropy,
  });
};
