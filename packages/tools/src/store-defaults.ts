/**
 * The figures of a store the cost model prices what they cause. Core keeps them internal, so they are copied here
 * rather than imported: this package reaches `@cloudbitmaps/core` through its public entry alone.
 * `tests/tools/store-defaults.test.ts` holds each equal to core's own, so a change there fails until this copy moves
 * with it.
 */

/** A load that could collect by name lists the segment instead on every generation divisible by this. */
export const LIST_COLLECTION_CADENCE = 16;

/** How long, in ms, a reader trusts a segment's pointer before it reads it again: the store's `cache.genTtlMs`. */
export const DEFAULT_CURRENT_GEN_TTL_MS = 2000;

/** How many segments a store keeps open by default: the store's `cache.readerMax`. */
export const DEFAULT_MAX_OPEN_SEGMENTS = 1024;
