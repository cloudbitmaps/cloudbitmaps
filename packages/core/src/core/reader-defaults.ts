/**
 * The storage reader's defaults, stated once for the two modules that need them: the reader, which applies them,
 * and the cost model, which prices what they cause. The cost model once imported them from the reader itself,
 * which pulled the whole read path into a module that is otherwise arithmetic.
 */

/** Default TTL (ms) for re-resolving a segment's `currentGen` — the bound on post-publish read staleness. */
export const DEFAULT_CURRENT_GEN_TTL_MS = 2000;

/**
 * How long (ms) a reader keeps serving after a pointer refresh failed transiently, before the next read asks the
 * registry again. Short, so an outage ends the stale serving soon after the registry answers; fixed, so a registry
 * that is down is asked at most once per this interval per segment being read (the refresh is coalesced per
 * segment). Never longer than the TTL itself.
 */
export const REFRESH_RETRY_MS = 500;

/** Default ceiling on cached segment readers (each holds a parsed `.crbm` index) — the steady-state count bound. */
export const DEFAULT_MAX_OPEN_SEGMENTS = 1024;

/** Default aggregate ceiling (bytes) on resident parsed indices in the reader cache — the steady-state byte bound. */
export const DEFAULT_MAX_OPEN_INDEX_BYTES = 64 * 1024 * 1024;
