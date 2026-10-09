/**
 * The storage reader's defaults. `@cloudbitmaps/tools` prices what two of them cause and keeps its own copies, which
 * `tests/tools/store-defaults.test.ts` holds equal to these.
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

/**
 * How many segments' resolutions a store keeps per reader it keeps open: the resolution cache's count bound is this
 * times `cache.readerMax` (8,192 by default). A resolution is the few hundred bytes of a row a read resolves through,
 * kept for `cache.genTtlMs` whether or not the segment's reader is still open, so a store reading more segments at once
 * than its readers hold keeps more of them than it keeps readers.
 */
export const RESOLUTIONS_PER_OPEN_SEGMENT = 8;

/**
 * The resolution cache's byte bound is `cache.readerMaxBytes` divided by this (4 MiB by default): what it holds is a
 * sixteenth of what the readers may.
 */
export const RESOLUTION_BYTES_DIVISOR = 16;
