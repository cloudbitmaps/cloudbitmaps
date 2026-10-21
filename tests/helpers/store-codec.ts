import { flagshipCodec } from '@/roaring-codec';

/**
 * The codec the store runs: the one `CloudRoaring` hands the engine. Core's suites build their engines, bitmaps and
 * chunk bytes with it, so they test core on the codec users run. A test that needs the native codec on purpose imports
 * the native codec module and is listed in `tests/arch/native-store-files.test.ts` (or is the oracle or a
 * differential test).
 */
export const storeCodec = flagshipCodec();
