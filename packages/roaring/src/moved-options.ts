/**
 * Option spellings the store does not take and a caller may still pass, and what to tell someone who passes one.
 *
 * NOT part of the public API. It lives in its own module — rather than as an `export` from the barrel — so that
 * the gates which must agree with it (the doc-fence scan and the harness scan) read ONE copy rather than each
 * keeping a hand-maintained list that drifts.
 */

export type MovedOptionKind = 'group' | 'renamed' | 'gone';

/** `[the key, what to do instead, which kind of answer that is]`. */
export const MOVED_OPTIONS: ReadonlyArray<readonly [string, string, MovedOptionKind]> = [
  ['cacheMaxChunks', 'cache.maxChunks', 'group'],
  ['cacheTtlMs', 'cache.ttlMs', 'group'],
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
  // None of these has a counterpart, so none is offered.
  ['warm', 'nothing replaces it', 'gone'],
  ['warmReadConsistency', 'nothing replaces it', 'gone'],
  ['maxWarmScanBytes', 'nothing replaces it', 'gone'],
  ['writeConcurrency', 'nothing replaces it', 'gone'],
  ['occBackoff', 'nothing replaces it', 'gone'],
];
