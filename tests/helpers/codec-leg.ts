/**
 * The store runs the TypeScript codec in every project. A test that needs the native codec behind the store (it spies
 * on the native decoder, or compares with a native `Buffer`) runs through {@link withNativeCodec}, which flips the
 * store's internal codec switch for that test alone. `tests/arch/native-store-files.test.ts` lists the files that do.
 */

/** Runs `body` with the native codec behind every store built inside it, and puts the previous codec back after. */
export function withNativeCodec<A extends unknown[]>(
  body: (...args: A) => unknown,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const { setFlagshipCodec } = await import('@/roaring-codec');
    const { roaringCodec } = await import('@/native-codec');
    const previous = setFlagshipCodec(roaringCodec);
    try {
      await body(...args);
    } finally {
      setFlagshipCodec(previous);
    }
  };
}
