/**
 * How a store's storage and read retry are wired from its options:
 *
 * ```
 *   options.storage ──> resolveStorageSource ──> source (what the engine reads), driver, registry
 *                              │ backend: CrbmStorageChunkSource over its storage half, pinned to its registry
 *                              │ driver:  CrbmStorageChunkSource, no registry (list-scan, cleartext, read-only)
 *                              └ source:  used as-is
 *   source ──> retry on (default) ──> RetryingStorageChunkSource(source, policy)  = storage
 *          └─> retry: false ───────> storage = source
 * ```
 *
 * The constructor keeps what it builds itself (cache, engine, budget); this file owns only the storage half.
 */
import {
  CrbmStorageChunkSource,
  DEFAULT_RETRY_POLICY,
  NOOP_METRICS,
  RetryingStorageChunkSource,
  ValidationError,
  isStorageBackend,
} from '@cloudbitmaps/core';
import type { Clock, IMetricsSink, RetryPolicy, RetryingOptions, Rng } from '@cloudbitmaps/core';
import type {
  IKeystore,
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
  StorageChunkSource,
} from '@cloudbitmaps/core/driver-kit';

/** The slice of a store's options the wiring reads; `CloudRoaringOptions` satisfies it. */
interface StoreWiring {
  readonly storage: unknown;
  readonly encryption?: { readonly keystore?: IKeystore; readonly required?: boolean };
  readonly cache?: {
    readonly genTtlMs?: number;
    readonly readerMax?: number;
    readonly readerMaxBytes?: number;
  };
  readonly retry?:
    | (Partial<RetryPolicy> & {
        readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
      })
    | false;
}

/** What {@link wireStore} builds for the constructor. */
interface WiredStore {
  /** What the engine reads through: the source, wrapped in the read retry unless it is off. */
  readonly storage: StorageChunkSource;
  /** The resolved source before the retry wrapper. */
  readonly source: StorageChunkSource;
  readonly driver: IStorageDriver | undefined;
  readonly registry: IRegistryDriver | undefined;
  /** The backend the store was given, for its optional lifecycle check; `undefined` for a bare driver or a source. */
  readonly backend: StorageBackend | undefined;
  /** The read retry the store shares with its lifecycle reads; `undefined` when retry is off. */
  readonly retryOptions: RetryingOptions | undefined;
}

/**
 * A caller's partial policy, completed from {@link DEFAULT_RETRY_POLICY}, so tuning one field does not mean restating
 * all five.
 *
 * Each field is read with `??`, not by spreading over the default: a key that is present with the value
 * `undefined` (the ordinary shape of a value read from env or JSON, which `exactOptionalPropertyTypes`
 * being off lets through) must fall back to the default. A spread would let it replace the default with
 * `undefined`, giving `NaN` delays that `SystemClock.sleep` turns into a ~1 ms hot retry loop, with the
 * backoff bound and the herd protection gone and no error to show it.
 *
 * An omitted `maxDelayMs` is the default cap, or the `baseDelayMs` given when that is larger, so tuning only the
 * base delay never leaves a cap below it. A `maxDelayMs` given below the `baseDelayMs` is refused when the retrying
 * source checks the policy.
 */
function resolveRetryPolicy(partial: Partial<RetryPolicy>): RetryPolicy {
  const baseDelayMs = partial.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  return {
    maxAttempts: partial.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs,
    maxDelayMs:
      partial.maxDelayMs ??
      (typeof baseDelayMs === 'number' && baseDelayMs > DEFAULT_RETRY_POLICY.maxDelayMs
        ? baseDelayMs
        : DEFAULT_RETRY_POLICY.maxDelayMs),
    backoffFactor: partial.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor,
    jitter: partial.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
}

/**
 * Resolve the storage seam, hand a backend the metrics sink, and wrap the source in the read retry. Refusals come in
 * that order: a bad `storage` first, then a bad `retry`.
 */
export function wireStore(
  options: StoreWiring,
  clock: Clock,
  rng: Rng,
  metrics: IMetricsSink,
): WiredStore {
  // Resolve the Storage seam to a StorageChunkSource: a raw IStorageDriver is wrapped into the `.crbm` storage source
  // here (with the store's registry/keystore) so drivers are wired once; a pre-built source is used as-is.
  const resolved = resolveStorageSource(options, clock);
  // A backend that can say something about its own setup is handed the sink, never a no-op one.
  if (metrics !== NOOP_METRICS && isStorageBackend(options.storage)) {
    options.storage.attachMetrics?.(metrics);
  }
  let storage: StorageChunkSource = resolved.source;
  let retryOptions: RetryingOptions | undefined;
  // Resilience on by default: wrap the source so transient faults retry with jittered backoff. `false` opts
  // out (e.g. the injected client already retries); a RetryPolicy tunes it.
  if (options.retry !== false) {
    const { onRetry: userOnRetry, ...ov } = options.retry ?? {};
    if (userOnRetry !== undefined && typeof userOnRetry !== 'function') {
      throw new ValidationError('retry.onRetry must be a function');
    }
    retryOptions = {
      clock,
      rng,
      policy: resolveRetryPolicy(ov),
      // Bridge transient-fault retries into the metrics stream, then call the user's own hook.
      onRetry: (info) => {
        metrics.onEvent({
          kind: 'retry',
          reason: 'transient',
          attempt: info.attempt,
          delayMs: info.delayMs,
        });
        userOnRetry?.(info);
      },
    };
    storage = new RetryingStorageChunkSource(storage, retryOptions);
  }
  return {
    storage,
    source: resolved.source,
    driver: resolved.driver,
    registry: resolved.registry,
    backend: isStorageBackend(options.storage) ? options.storage : undefined,
    retryOptions,
  };
}

/**
 * Resolve the `storage` option to a {@link StorageChunkSource} at construction (wiring-time only — no hot-path cost).
 *
 * `storage` is discriminated by a **brand** for the backend arm and structurally for the other two, never by
 * `instanceof`, so a backend or driver from a different copy of the package still works (the same reason the error
 * predicates are brand-based): a raw {@link IStorageDriver} exposes `putImmutable`
 * (the byte-mover seam); a pre-built {@link StorageChunkSource} exposes `getChunk` (the engine's read seam). The
 * two interfaces are deliberately **disjoint** on these methods (an invariant the driver SDK maintains, pinned
 * by a test) — an object exposing *both* is ambiguous and rejected, as is one exposing *neither* (incl. a
 * nullish/non-object value from a JS caller): fail fast with a typed error rather than crash on a probe.
 *
 * A backend is wrapped into a {@link CrbmStorageChunkSource} over its storage half, pinned to its registry,
 * with the config's `encryption` group; a bare driver is wrapped the same way but without a
 * registry; a pre-built source is used as-is. `keystore`/`requireEncryption` are meaningful **only** where the
 * store builds the source itself — pairing either with a pre-built source is a wiring mistake, so reject it
 * rather than silently ignore it. The `CrbmStorageChunkSource` constructor enforces the rest (a keystore /
 * `requireEncryption` needs a registry, so they need a backend; the driver needs range reads).
 *
 * Returns the resolved `source` (what the engine reads through) **and** the raw `driver` when one was passed —
 * the store keeps the raw driver so its lifecycle helpers and the `*Into` verbs can write generations without
 * you re-passing drivers. `driver` is `undefined` for a pre-built source (there's no underlying `IStorageDriver` to
 * write through, so its writes throw {@link UnsupportedError}).
 */
function resolveStorageSource(
  options: StoreWiring,
  clock: Pick<Clock, 'now'>,
): {
  source: StorageChunkSource;
  driver: IStorageDriver | undefined;
  registry: IRegistryDriver | undefined;
} {
  const storage: unknown = options.storage;
  if (storage === null || typeof storage !== 'object') {
    throw new ValidationError(
      '`storage` must be a StorageBackend, an IStorageDriver, or a StorageChunkSource',
    );
  }
  const asBackend = storage as Partial<StorageBackend>;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object';
  const hasGetChunk = typeof (storage as Partial<StorageChunkSource>).getChunk === 'function';
  const hasPutImmutable = typeof (storage as Partial<IStorageDriver>).putImmutable === 'function';

  // The BRAND decides, not the shape. `{ storage, registry }` is also the shape of core's free-function deps
  // object, so before the brand any literal satisfied it — including one holding halves from two unrelated
  // stores, which the store accepted and then answered empty for a segment that holds data.
  const isBackend = isStorageBackend(storage);

  // A branded backend that ALSO quacks like a driver or a source is genuinely ambiguous. Unreachable for the
  // five classes, kept because the alternative to refusing is guessing.
  if (isBackend && (hasGetChunk || hasPutImmutable)) {
    throw new ValidationError(
      '`storage` is a StorageBackend that also exposes ' +
        `${hasGetChunk ? '`getChunk`' : '`putImmutable`'} — ambiguous. A backend must not also be a driver ` +
        'or a source; pass whichever one you mean.',
    );
  }

  // Unbranded, but carrying both halves. Three sub-cases, and they want different things said.
  const hasStorageHalf = isObject(asBackend.storage);
  const hasRegistryHalf = isObject(asBackend.registry);

  // (a) A DRIVER that also carries a registry — the audit/metrics/tenant-scoping wrapper. Without this it
  // falls through to the bare-driver path, where there is no pointer at all: generations resolve by
  // list-scan, so the store answers from the HIGHEST object in the bucket rather than the published one, and
  // a load that wrote an object but never published it is served as if it had been. Silently, and with the
  // wrapper's registry sitting right there unused.
  if (!isBackend && hasPutImmutable && hasRegistryHalf) {
    throw new ValidationError(
      '`storage` looks like a driver that also carries a `registry`. Passed as a bare driver it would have ' +
        'no pointer at all — generations would resolve by list-scan, so reads could serve a generation that ' +
        'was written but never published. If you meant a backend, use a backend class — S3Storage, GcsStorage, ' +
        'AzureBlobStorage, LocalFsStorage or MemoryStorage — or, to pair a driver of your own with a registry, ' +
        'brand the pair with `brandAsBackend` from `@cloudbitmaps/core/driver-kit`.',
    );
  }

  // (b) Both halves, neither of them a driver or a source: the hand-assembled literal, or a spread of a real
  // backend with one half swapped. Name the classes AND the door — the five classes cannot express an
  // instrumented half or a foreign registry, which is exactly the case that lands here.
  if (!isBackend && !hasGetChunk && !hasPutImmutable && hasStorageHalf && hasRegistryHalf) {
    const storageOk =
      typeof (asBackend.storage as Partial<IStorageDriver>).putImmutable === 'function';
    const registryOk =
      typeof (asBackend.registry as Partial<IRegistryDriver>).compareAndSwap === 'function';
    // (c) …and if a half is not actually a driver, say THAT rather than lecturing about buckets.
    if (!storageOk || !registryOk) {
      const bad = !storageOk
        ? '`storage` half is not an IStorageDriver (no `putImmutable`)'
        : '`registry` half is not an IRegistryDriver (no `compareAndSwap`)';
      throw new ValidationError(
        '`storage` looks like a backend but its ' +
          bad +
          ' — use a backend class, or brand a pair of drivers with `brandAsBackend` from ' +
          '`@cloudbitmaps/core/driver-kit`.',
      );
    }
    throw new ValidationError(
      '`storage` must be a backend — S3Storage, GcsStorage, AzureBlobStorage, LocalFsStorage or ' +
        'MemoryStorage. An object with `.storage` and `.registry` is not one: a backend builds both halves ' +
        'from a single bucket and prefix, so they cannot disagree, and hand-assembling them re-opens exactly ' +
        'that mismatch — a store whose pointer and generations live in different places reads as empty ' +
        'rather than failing. A driver author who genuinely wants halves of their own — an instrumented driver, ' +
        'a registry in a database you already run — brands the pair with `brandAsBackend` from ' +
        '`@cloudbitmaps/core/driver-kit`, which is taking on that they agree.',
    );
  }

  if (isBackend) {
    const backend = storage as StorageBackend;
    return {
      source: new CrbmStorageChunkSource(backend.storage, {
        registry: backend.registry,
        keystore: options.encryption?.keystore,
        requireEncryption: options.encryption?.required,
        clock,
        currentGenTtlMs: options.cache?.genTtlMs,
        maxOpenSegments: options.cache?.readerMax,
        maxOpenIndexBytes: options.cache?.readerMaxBytes,
      }),
      driver: backend.storage,
      registry: backend.registry,
    };
  }

  if (hasGetChunk && hasPutImmutable) {
    throw new ValidationError(
      '`storage` exposes both `getChunk` and `putImmutable` — ambiguous; pass a StorageBackend, an IStorageDriver, or a StorageChunkSource, not a hybrid',
    );
  }
  if (!hasGetChunk && !hasPutImmutable) {
    throw new ValidationError(
      '`storage` must be a StorageBackend, an IStorageDriver, or a StorageChunkSource',
    );
  }
  if (hasGetChunk) {
    // Already a StorageChunkSource — used as-is. `keystore`/`requireEncryption` only apply when the store
    // builds the source itself; with a source of the caller's own they are inert, so reject them rather than mislead.
    if (options.encryption?.keystore !== undefined || options.encryption?.required === true) {
      throw new ValidationError(
        'keystore/requireEncryption apply only when the store builds its own read path: a StorageChunkSource of ' +
          'your own reads an encrypted segment by itself, if it must; to have the store decrypt, pass a backend',
      );
    }
    return { source: storage as StorageChunkSource, driver: undefined, registry: undefined };
  }
  // A bare IStorageDriver: no pointer, so generations resolve by list-scan. Cleartext, read-only.
  const driver = storage as IStorageDriver;
  return {
    source: new CrbmStorageChunkSource(driver, {
      keystore: options.encryption?.keystore,
      requireEncryption: options.encryption?.required,
      clock,
      currentGenTtlMs: options.cache?.genTtlMs,
      maxOpenSegments: options.cache?.readerMax,
      maxOpenIndexBytes: options.cache?.readerMaxBytes,
    }),
    driver,
    registry: undefined,
  };
}
