/** Type-level helpers for the tests that hold a runtime list to the type it mirrors, checked by `pnpm typecheck`. */

/** True when T is `any`, which would otherwise match every key set. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * True exactly when A and B are the same set of keys, and neither is `any`, so a mismatch fails to compile where
 * `true` is assigned.
 */
export type SameKeys<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false;

/**
 * The `any` guard, held by the compiler: without it `SameKeys<any, …>` is `true`, and this does not compile.
 */
export type AnyIsNotAKeySet = [
  Expect<false, SameKeys<Any, 'a'>>,
  Expect<false, SameKeys<'a', Any>>,
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` is the case under test
type Any = any;
type Expect<Want extends boolean, Got extends Want> = [Want, Got];
