/**
 * Which codec the running vitest project puts behind the store: the TypeScript one, the store's default, in every
 * project. The `ts-codec` project also guards that leg (`tests/setup-codec-ts.ts`): a store must not reach the native
 * codec, which only the oracle and the tests that compare with CRoaring use.
 *
 * A test that needs the native codec behind the store (it spies on the native decoder, or compares with a native
 * `Buffer`) runs through {@link withNativeCodec}, which flips the store's internal codec switch for that test alone.
 */
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The codec the project puts behind the store; absent in a project that leaves the default (the TypeScript codec). */
    codec?: 'native' | 'ts';
  }
}

/** The codec this test file's project puts behind the store. */
export function codecLeg(): 'native' | 'ts' {
  return inject('codec') ?? 'ts';
}

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
