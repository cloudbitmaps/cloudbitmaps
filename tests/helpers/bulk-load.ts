/**
 * The loader `store.load()` is built on, bound to the roaring codec and a real clock, for tests that write a
 * generation at a number they choose, or without publishing through the store. The library does not export it:
 * applications load through `store.load()`.
 *
 * In the `serialized` project it hands the loader its ids as `{ serialized }`, decoded the way core's load decodes
 * one (`tests/helpers/load-routing.ts`), so every test that seeds a segment through it, `loaded.ts`'s fixtures
 * included, writes through the bitmap path there.
 */
import { bulkLoadCrbmGeneration as coreBulkLoad } from '@/core/crbm-storage-source';
import { DecodedLoadInput, prepareLoadInput } from '@/core/load-input';
import type { LoadInput } from '@/core/load-input';
import { roaringCodec } from '@/roaring-codec';
import { SystemClock } from '@/system-clock';
import { kindOf, routedProject, routing, toSerialized } from './load-routing';

export type { BulkLoadResult } from '@/core/crbm-storage-source';

/** `store.load()`'s loader with the codec and clock the store would pass; an explicit option wins. */
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
  }
  return coreBulkLoad(driver, key, input, {
    ...options,
    codec,
    clock: options.clock ?? new SystemClock(),
  });
};
