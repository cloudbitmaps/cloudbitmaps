/** Type-level helpers for the tests that hold a runtime list to the type it mirrors, checked by `pnpm typecheck`. */

/** True exactly when A and B are the same set of keys, so a mismatch fails to compile where `true` is assigned. */
export type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
