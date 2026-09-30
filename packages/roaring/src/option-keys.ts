/**
 * The keys `new CloudRoaring(options)` takes: at the top level, and inside each group whose value is an object. The
 * constructor refuses any other key by name, because an option it ignored would do nothing and look as if it had,
 * and the gates that read the docs' samples and the harnesses' option bags hold them to the same table. A test
 * holds the table to the option interfaces, in both directions.
 *
 * NOT part of the public API. It is its own module, rather than an `export` from the barrel, so the constructor
 * and those gates read one copy.
 */
export const OPTION_KEYS = {
  top: ['storage', 'cache', 'encryption', 'retry', 'metrics', 'budget', 'seams'],
  cache: ['maxChunks', 'ttlMs', 'genTtlMs', 'readerMax', 'readerMaxBytes'],
  encryption: ['keystore', 'required'],
  retry: ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'backoffFactor', 'jitter', 'onRetry'],
  budget: ['maxRequests'],
  seams: ['clock', 'rng'],
} as const satisfies Record<string, readonly string[]>;

/** The groups: the top-level keys whose value, when it is an object, has keys of its own. */
export type OptionGroup = Exclude<keyof typeof OPTION_KEYS, 'top'>;
