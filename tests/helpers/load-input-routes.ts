/**
 * Which test files run a second time with their id loads handed to core's load as `{ serialized }`.
 *
 * `vitest.config.ts` builds its `serialized` project from {@link ROUTED}, and `tests/arch/load-input-coverage.test.ts`
 * holds both lists to the tree: every test file matching {@link LOAD_CALL} is on exactly one of them.
 */

/** What makes a test file a load test: it calls a store's or a fixture's load, core's load, or an `*Into` verb. */
export const LOAD_CALL = /\.load\(|\bloadSegment\(|\b(?:intersect|union|andNot)Into\(/;

/** The vitest project that routes id loads through `{ serialized }`. */
export const ROUTED_PROJECT = 'serialized';

/** The setup file that does the routing. */
export const ROUTING_SETUP = 'tests/setup-load-via-serialized.ts';

/** Run under ids and again under `{ serialized }`. */
export const ROUTED: readonly string[] = [];

/** Run under ids only, each with the reason routing would change what the file tests. */
export const IDS_ONLY: Readonly<Record<string, string>> = {};
