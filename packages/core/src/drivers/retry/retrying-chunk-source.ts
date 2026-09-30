/**
 * The store's read retry.
 *
 * {@link RetryingStorageChunkSource} wraps a {@link StorageChunkSource} so every read it serves retries
 * **transient** faults with bounded, jittered backoff, through the one shared `core/retry` primitive, so every
 * backend (S3, GCS, Azure Blob, LocalFS, …) inherits the same policy instead of each rolling its own. `CloudRoaring`
 * wraps the source it reads segment data through in one — a `StorageChunkSource` passed as `storage` included, so
 * wrapping that one first multiplies each read's attempts — and a pinned handle's source too, unless it is built
 * with `retry: false`.
 * Pure composition over the port (no SDK, no I/O of its own); the driver under the source is responsible for
 * *classifying* its transient faults (raising {@link TransientError}), and this wrapper decides *whether and when*
 * to retry.
 *
 * **Reads only, on purpose.** A read changes nothing, so running it again is safe. A write is not: a conditional put
 * or compare-and-swap that lands and then loses its response would, replayed, find its own write already there and
 * report it as a conflict. So nothing here wraps a write, and the store's writes and admin calls report a transient
 * fault to their caller, who re-runs the call or checks what landed.
 *
 * What is **not** retried: every deterministic error (`ValidationError`/`IntegrityError`/`NotFoundError`/…).
 * Default classifier: {@link isTransientError}.
 */
import type { Clock, Rng } from '../../core/determinism';
import { withRetry, DEFAULT_RETRY_POLICY } from '../../core/retry';
import { isTransientError } from '../../core/errors';
import type { RetryPolicy } from '../../core/retry';
import type { ChunkRef, StorageChunkSource, SegmentRef, SegmentSize } from '../../core/ports';

export interface RetryingOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  /** Defaults to {@link DEFAULT_RETRY_POLICY}. */
  readonly policy?: RetryPolicy;
  /** Override which errors are retryable. Default: {@link isTransientError} (any `TransientError`). */
  readonly isRetryable?: (err: unknown) => boolean;
  /** Observability hook fired before each backoff wait. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

/** Internal: resolve the options into the `core/retry` shape once, at construction. */
function toRetry(opts: RetryingOptions): {
  policy: RetryPolicy;
  deps: {
    clock: Clock;
    rng: Rng;
    isRetryable: (e: unknown) => boolean;
    onRetry?: RetryingOptions['onRetry'];
  };
} {
  return {
    policy: opts.policy ?? DEFAULT_RETRY_POLICY,
    deps: {
      clock: opts.clock,
      rng: opts.rng,
      isRetryable: opts.isRetryable ?? isTransientError,
      onRetry: opts.onRetry,
    },
  };
}

/** Wrap a storage chunk source so its reads retry transient faults. */
export class RetryingStorageChunkSource implements StorageChunkSource {
  private readonly inner: StorageChunkSource;
  private readonly policy: RetryPolicy;
  private readonly deps: ReturnType<typeof toRetry>['deps'];
  /** Present only when the inner source supports it — so capability detection stays honest. */
  readonly sizeOf?: (ref: SegmentRef) => Promise<SegmentSize | null>;
  readonly cardinalities?: (ref: SegmentRef) => Promise<ReadonlyMap<number, number> | null>;
  readonly currentGeneration?: (ref: SegmentRef) => Promise<number | null>;
  readonly invalidate?: (ref: SegmentRef) => void;
  readonly exists?: (ref: SegmentRef) => Promise<boolean>;
  readonly currentVersion?: (ref: SegmentRef) => Promise<string | null>;

  /**
   * Forwarded, not retried: a property, with no request behind it. Without it the grounded cost report priced a
   * retrying store's refresh at the default TTL whatever the store was configured with.
   */
  get pointerRefreshMs(): number | undefined {
    return this.inner.pointerRefreshMs;
  }

  constructor(inner: StorageChunkSource, opts: RetryingOptions) {
    this.inner = inner;
    const r = toRetry(opts);
    this.policy = r.policy;
    this.deps = r.deps;
    const innerSizeOf = inner.sizeOf;
    if (innerSizeOf) {
      this.sizeOf = (ref) => withRetry(() => innerSizeOf.call(inner, ref), this.policy, this.deps);
    }
    const innerCardinalities = inner.cardinalities;
    if (innerCardinalities) {
      this.cardinalities = (ref) =>
        withRetry(() => innerCardinalities.call(inner, ref), this.policy, this.deps);
    }
    const innerCurrentGeneration = inner.currentGeneration;
    if (innerCurrentGeneration) {
      this.currentGeneration = (ref) =>
        withRetry(() => innerCurrentGeneration.call(inner, ref), this.policy, this.deps);
    }
    // Forwarded, NOT retried: it is synchronous and cannot fail, and dropping memoized state has no transient
    // mode to back off from. Forgetting to forward it would be silent — the wrapper would satisfy the port
    // while the invalidation stopped one layer short of the source that holds the snapshot and the DEK.
    const innerInvalidate = inner.invalidate;
    if (innerInvalidate) {
      this.invalidate = (ref) => {
        innerInvalidate.call(inner, ref);
      };
    }
    // Retried, unlike `invalidate`: this one reads the registry, so it has a transient mode to back off from.
    const innerExists = inner.exists;
    if (innerExists) {
      this.exists = (ref) => withRetry(() => innerExists.call(inner, ref), this.policy, this.deps);
    }
    const innerCurrentVersion = inner.currentVersion;
    if (innerCurrentVersion) {
      this.currentVersion = (ref) =>
        withRetry(() => innerCurrentVersion.call(inner, ref), this.policy, this.deps);
    }
  }

  getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    return withRetry(() => this.inner.getChunk(ref), this.policy, this.deps);
  }

  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return withRetry(() => this.inner.listChunkKeys(ref), this.policy, this.deps);
  }
}
