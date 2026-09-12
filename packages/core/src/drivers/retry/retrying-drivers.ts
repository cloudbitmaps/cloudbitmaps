/**
 * Retry decorators.
 *
 * Transparent wrappers that add bounded, jittered retry of **transient** faults to any driver, using the one
 * shared `core/retry` primitive — so every backend (S3, GCS, Azure, DynamoDB, LocalFS, …) inherits the same
 * policy instead of each rolling its own. Pure composition over the port interfaces (no SDK, no I/O of their
 * own); the wrapped driver is responsible for *classifying* its transient faults (raising {@link TransientError});
 * these decorators decide *whether and when* to retry.
 *
 * **Streaming methods buffer**, deliberately: a partially-consumed async iterator cannot be resumed mid-stream
 * (it would re-yield earlier items), so `RetryingColdDriver.list` and `RetryingRegistryDriver.list` collect the
 * whole enumeration inside `withRetry` and re-run it from the start on a fault. Both are discovery scans over a
 * generation or namespace listing, where the result set is small and whole-scan retry is worth the memory.
 *
 * Point methods are retried in place, with nothing to buffer.
 *
 * What is **not** retried here: {@link WriteConflictError} (OCC — the publish loop owns that; a blind replay
 * would re-apply against a stale token), and every deterministic error
 * (`ValidationError`/`IntegrityError`/`NotFoundError`/…). Default classifier: {@link isTransient}.
 */
import type { Clock, Rng } from '../../core/determinism';
import { withRetry, isTransient, DEFAULT_RETRY_POLICY } from '../../core/retry';
import type { RetryPolicy } from '../../core/retry';
import type {
  ChunkRef,
  ColdCaps,
  ColdChunkSource,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  SegmentSize,
  Token,
} from '../../core/ports';
import type { BlobSink } from '../../core/blob';

export interface RetryingOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  /** Defaults to {@link DEFAULT_RETRY_POLICY}. */
  readonly policy?: RetryPolicy;
  /** Override which errors are retryable. Default: {@link isTransient} (any `TransientError`). */
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
      isRetryable: opts.isRetryable ?? isTransient,
      onRetry: opts.onRetry,
    },
  };
}

/** Wrap a cold chunk source so its reads retry transient faults. */
export class RetryingColdChunkSource implements ColdChunkSource {
  private readonly inner: ColdChunkSource;
  private readonly policy: RetryPolicy;
  private readonly deps: ReturnType<typeof toRetry>['deps'];
  /** Present only when the inner source supports it — so capability detection stays honest. */
  readonly sizeOf?: (ref: SegmentRef) => Promise<SegmentSize | null>;
  readonly cardinalities?: (ref: SegmentRef) => Promise<ReadonlyMap<number, number> | null>;
  readonly currentGeneration?: (ref: SegmentRef) => Promise<number | null>;
  readonly invalidate?: (ref: SegmentRef) => void;
  readonly exists?: (ref: SegmentRef) => Promise<boolean>;
  readonly currentVersion?: (ref: SegmentRef) => Promise<string | null>;

  constructor(inner: ColdChunkSource, opts: RetryingOptions) {
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

/** Wrap a cold driver so its byte operations retry transient faults. */
export class RetryingColdDriver implements IColdDriver {
  private readonly inner: IColdDriver;
  private readonly policy: RetryPolicy;
  private readonly deps: ReturnType<typeof toRetry>['deps'];

  constructor(inner: IColdDriver, opts: RetryingOptions) {
    this.inner = inner;
    const r = toRetry(opts);
    this.policy = r.policy;
    this.deps = r.deps;
  }

  capabilities(): ColdCaps {
    return this.inner.capabilities(); // pure, local — no retry
  }

  putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    // Write-once + content-buffered: a retry re-runs `write` from scratch and re-issues the conditional put;
    // a phantom-success surfaces as WriteConflictError (not transient) and stops the retry. Safe to wrap.
    return withRetry(() => this.inner.putImmutable(key, write), this.policy, this.deps);
  }

  getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    return withRetry(() => this.inner.getRange(key, offset, length), this.policy, this.deps);
  }

  getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    return withRetry(() => this.inner.getTail(key, maxBytes), this.policy, this.deps);
  }

  delete(key: GenKey): Promise<void> {
    return withRetry(() => this.inner.delete(key), this.policy, this.deps);
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const keys = await withRetry(
      async () => {
        const out: GenKey[] = [];
        for await (const k of this.inner.list(ref)) out.push(k);
        return out;
      },
      this.policy,
      this.deps,
    );
    yield* keys;
  }
}

/** Wrap a registry driver so its calls retry transient faults. CAS conflicts are not retried (caller-owned). */
export class RetryingRegistryDriver implements IRegistryDriver {
  private readonly inner: IRegistryDriver;
  private readonly policy: RetryPolicy;
  private readonly deps: ReturnType<typeof toRetry>['deps'];

  constructor(inner: IRegistryDriver, opts: RetryingOptions) {
    this.inner = inner;
    const r = toRetry(opts);
    this.policy = r.policy;
    this.deps = r.deps;
  }

  capabilities(): RegCaps {
    return this.inner.capabilities();
  }

  get(ref: SegmentRef): Promise<RegistryRecord | null> {
    return withRetry(() => this.inner.get(ref), this.policy, this.deps);
  }

  create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    return withRetry(() => this.inner.create(ref, record), this.policy, this.deps);
  }

  compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    return withRetry(() => this.inner.compareAndSwap(ref, expected, patch), this.policy, this.deps);
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    const records = await withRetry(
      async () => {
        const out: RegistryRecord[] = [];
        for await (const r of this.inner.list(namespace)) out.push(r);
        return out;
      },
      this.policy,
      this.deps,
    );
    yield* records;
  }

  delete(ref: SegmentRef): Promise<void> {
    return withRetry(() => this.inner.delete(ref), this.policy, this.deps);
  }
}
