/**
 * Retry decorators (Phase 4b).
 *
 * Transparent wrappers that add bounded, jittered retry of **transient** faults to any driver, using the one
 * shared `core/retry` primitive — so every backend (DynamoDB, S3, LocalFS, …) inherits the same, simulator-
 * replayable policy instead of each rolling its own. Pure composition over the port interfaces (no SDK, no
 * I/O of their own); the wrapped driver is responsible for *classifying* its transient faults (raising
 * {@link TransientError}); these decorators decide *whether and when* to retry.
 *
 * **Streaming methods** (`listChunks`, `list`) are retried by **re-enumerating from the start**, buffering
 * the result — a partially-consumed async iterator can't be safely resumed mid-stream (it would re-yield
 * earlier items). Their consumers in the engine already collect fully (the Warm dirty-set is small under
 * Topology-A; the cold `list` is a discovery scan), so buffering preserves current semantics. Point methods
 * are retried in place with no buffering.
 *
 * What is **not** retried here: {@link WriteConflictError} (OCC — the engine's read-modify-write loop owns
 * that; a blind replay would re-apply against a stale token), and every deterministic error
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
  IWarmDriver,
  NewRegistryRecord,
  NoRow,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  SegmentSize,
  Token,
  WarmReadOptions,
  WarmRow,
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

/** Wrap a warm driver so its calls retry transient faults. OCC conflicts are deliberately not retried here. */
export class RetryingWarmDriver implements IWarmDriver {
  private readonly inner: IWarmDriver;
  private readonly policy: RetryPolicy;
  private readonly deps: ReturnType<typeof toRetry>['deps'];

  constructor(inner: IWarmDriver, opts: RetryingOptions) {
    this.inner = inner;
    const r = toRetry(opts);
    this.policy = r.policy;
    this.deps = r.deps;
  }

  get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    return withRetry(() => this.inner.get(ref, opts), this.policy, this.deps);
  }

  putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    return withRetry(() => this.inner.putConditional(ref, bytes, expected), this.policy, this.deps);
  }

  deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    return withRetry(() => this.inner.deleteConditional(ref, expected), this.policy, this.deps);
  }

  /**
   * Stream the inner driver's rows, retrying only until the first one arrives.
   *
   * **This used to buffer the whole scan** — `for await (…) out.push(row)` inside `withRetry`, then
   * `yield* out` — which made the retry trivially safe and quietly defeated every bound above it. The engine's
   * `collectWarm` refuses *during* enumeration precisely so resident memory is `O(ceiling)` rather than
   * `O(segment)`; with the buffering wrapper in place (and it is wired by default) it saw its first row only
   * after the entire segment was already in memory. Measured on a 500-row segment under
   * `budget: { maxRequests: 3 }`: **500 rows materialised with the default wiring, 4 with `retry: false`**.
   * Both paths threw the same `BudgetExceededError`, which is why no test caught it — the error was never the
   * distinguishing observable, the row count was.
   *
   * **The trade this makes.** A mid-stream fault now propagates instead of being retried. It cannot be retried
   * honestly: rows have already been handed to the consumer, so restarting the iterator would re-yield them,
   * and the driver interface exposes no resumption token to continue from. Retry is kept where it pays —
   * establishing the scan, which is where transient connect/throttle failures actually land — and bounded
   * memory wins the conflict, because invariant 6 ("bounded memory & cost, always") is a hard invariant and
   * mid-scan retry is not. A caller who needs whole-scan retry can wrap the operation at their own level,
   * where re-reading from the start is safe.
   */
  async *listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow> {
    // Each attempt builds a FRESH iterator, so a retried establishment cannot duplicate rows.
    const started = await withRetry(
      async () => {
        const iterator = this.inner.listChunks(ref, opts)[Symbol.asyncIterator]();
        const first = await iterator.next();
        return { iterator, first };
      },
      this.policy,
      this.deps,
    );
    if (started.first.done === true) return;
    yield started.first.value;
    for (;;) {
      const next = await started.iterator.next();
      if (next.done === true) return;
      yield next.value;
    }
  }
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
