/**
 * The 0.9.x option spellings this release no longer accepts, and what to tell someone who passes one.
 *
 * NOT part of the public API. It lives in its own module — rather than as an `export` from the barrel — so
 * that the gates which must agree with it (the doc-fence scan, the harness scan, and the test that diffs this
 * table against `CloudRoaringOptions` at the previous tag) can all read ONE copy, without the migration
 * table becoming a permanent public export in the same release whose point was to shrink that surface.
 *
 * Retyping it was tried and is what this replaces: the hand-maintained copies had drifted to naming three
 * spellings no release ever shipped while omitting the five that actually went away with the live tier.
 */

export type MovedOptionKind = 'group' | 'renamed' | 'gone';

/** `[the 0.9.x key, what to do instead, which kind of answer that is]`. */
export const MOVED_OPTIONS: ReadonlyArray<readonly [string, string, MovedOptionKind]> = [
  ['cacheMaxChunks', 'cache.maxChunks', 'group'],
  ['cacheTtlMs', 'cache.ttlMs', 'group'],
  // The `cold*` spellings are what `0.9.x` ACTUALLY had. The `storage*` ones below never appeared in any
  // release — they existed between two unreleased commits of this cycle — and for a while they were the only
  // ones here, so the guard written to catch an upgrader missed every real upgrader and caught nobody.
  ['coldGenTtlMs', 'cache.genTtlMs', 'group'],
  ['coldReaderCacheMax', 'cache.readerMax', 'group'],
  ['coldReaderCacheMaxBytes', 'cache.readerMaxBytes', 'group'],
  ['storageGenTtlMs', 'cache.genTtlMs', 'group'],
  ['storageReaderCacheMax', 'cache.readerMax', 'group'],
  ['storageReaderCacheMaxBytes', 'cache.readerMaxBytes', 'group'],
  ['keystore', 'encryption.keystore', 'group'],
  ['requireEncryption', 'encryption.required', 'group'],
  ['onRetry', 'retry.onRetry', 'group'],
  ['clock', 'seams.clock', 'group'],
  ['rng', 'seams.rng', 'group'],
  [
    'registry',
    'the backend passed as `storage` (S3Storage, GcsStorage, …), which carries it',
    'renamed',
  ],
  ['cold', 'storage', 'renamed'],
  // The live (warm) tier and its knobs. `warm` was REQUIRED in `0.9.x`, so every upgrader passes one — and
  // an upgrader who fixes `cold` first meets this next. None has a successor, so none is offered.
  ['warm', 'the live tier is gone', 'gone'],
  ['warmReadConsistency', 'it tuned the live tier', 'gone'],
  ['maxWarmScanBytes', 'it tuned the live tier', 'gone'],
  ['writeConcurrency', 'it bounded the live tier’s flusher', 'gone'],
  ['occBackoff', 'it tuned the live tier’s read-modify-write', 'gone'],
];
