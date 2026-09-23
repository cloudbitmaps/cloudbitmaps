/**
 * The storage reader's defaults, stated once for the two modules that need them: the reader, which applies them,
 * and the cost model, which prices what they cause. The cost model once imported them from the reader itself,
 * which pulled the whole read path into a module that is otherwise arithmetic.
 */

/** Default TTL (ms) for re-resolving a segment's `currentGen` — the bound on post-publish read staleness. */
export const DEFAULT_CURRENT_GEN_TTL_MS = 2000;

/** Default ceiling on cached segment readers (each holds a parsed `.crbm` index) — the steady-state count bound. */
export const DEFAULT_MAX_OPEN_SEGMENTS = 1024;

/** Default aggregate ceiling (bytes) on resident parsed indices in the reader cache — the steady-state byte bound. */
export const DEFAULT_MAX_OPEN_INDEX_BYTES = 64 * 1024 * 1024;
