/**
 * Metrics seam (Phase 5a) — an injected sink the engine pushes typed events
 * to, exactly like the `Clock`/`Rng`/driver seams keep `core/` pure and storage-agnostic.
 *
 * Design: the library emits **neutral domain events** and stays vendor-agnostic — you (or a ~12-line
 * adapter) map them to OpenTelemetry / Datadog / a log line. The default is a **no-op**, and emission is
 * skipped entirely when no sink is wired (near-zero overhead, no telemetry dependency). Events carry **raw
 * observations** (bytes, counts, ms); turning those into billable units / dollars is the cost model's job
 * (Phase 5b), which keeps rates pluggable.
 *
 * Two caveats for sink authors: `onEvent` runs **synchronously on the I/O path**, so keep it cheap and
 * non-blocking (offload batching/network to your own async queue); and `segment`/`namespace` are
 * caller-controlled strings that may be PII and are **unbounded-cardinality** — do not map them to
 * per-series metric labels unless they're known low-cardinality and PII-free. See the getting-started
 * "Observability" section.
 */

/** The segment operations that emit an `op` latency event (timed with the injected clock, at the facade). */
export type MetricOpName =
  | 'add'
  | 'remove'
  | 'addMany'
  | 'removeMany'
  | 'claimMany'
  | 'has'
  | 'count'
  | 'intersectInto'
  | 'unionInto'
  | 'andNotInto';

/**
 * One observability event. A discriminated union on `kind` — new variants can be added over time without
 * breaking consumers (they switch on the kinds they care about). `namespace` is the segment's namespace
 * (absent ⇒ the default namespace). Segment names are identifiers, never bitmap contents (threat model:
 * never log PII / bitmap bits).
 */
export type MetricEvent =
  | {
      readonly kind: 'cold.get';
      readonly namespace?: string;
      readonly segment: string;
      /** Bytes returned (0 if the chunk was absent — a GET still happened). */
      readonly bytes: number;
      /**
       * Elapsed wall time of the read — includes any transient-retry backoff on the cold call. From the
       * injected clock, clamped to ≥ 0 (0 under the no-wait test clock).
       */
      readonly ms: number;
    }
  | { readonly kind: 'cache'; readonly hit: boolean }
  | {
      readonly kind: 'warm.read';
      readonly namespace?: string;
      readonly segment: string;
      /** Bytes read — a single-row get, or the summed rows of a list scan. */
      readonly bytes: number;
    }
  | {
      readonly kind: 'warm.write';
      readonly namespace?: string;
      readonly segment: string;
      /** Bytes of the committed delta row (emitted only on a successful conditional write). */
      readonly bytes: number;
    }
  | {
      readonly kind: 'retry';
      /** `occ` = optimistic-concurrency conflict backoff; `transient` = infrastructure-fault backoff. */
      readonly reason: 'occ' | 'transient';
      /** 1-based number of the attempt about to be retried. */
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      readonly kind: 'intersect';
      /**
       * Which chunk-aligned combine this was. **Optional for backward compatibility** — absent means
       * `'intersect'`, which is all this event reported before `union`/`andNot` existed.
       *
       * For `'union'` over its *include* operands alone, `skippedChunks` is 0 by construction — union reads
       * every chunk of every operand, so there is nothing to prune. It can still be non-zero when a union
       * carries `exclude` operands, because a suppression list may hold keys no include does and those are
       * legitimately never fetched. So: 0 is the expected shape for a plain union, not a guarantee.
       */
      readonly op?: 'intersect' | 'union' | 'andNot';
      /** Operand count, including any `exclude` (suppression) operands. */
      readonly operands: number;
      /**
       * Distinct chunk **keys** selected to fetch — for `'intersect'`, those present in every operand.
       *
       * **Keys, not requests.** The actual cold GETs are roughly `fetchedChunks × operands`, plus one per
       * `exclude` that holds a given key, which is why this number is smaller than what the per-op budget
       * charges for the same call. The two are different units by design; if you are reconciling a bill, the
       * budget's accounting is the one that models requests.
       */
      readonly fetchedChunks: number;
      /**
       * **Distinct** chunk-keys pruned — never fetched (the chunk-skipping saving). Counts distinct keys,
       * not per-operand GETs, so it under-states the true GET saving when 3+ operands partially overlap.
       */
      readonly skippedChunks: number;
    }
  | {
      readonly kind: 'compaction';
      readonly namespace?: string;
      readonly segment: string;
      /** True iff this call committed a new generation. */
      readonly compacted: boolean;
      /** Why nothing was committed (when `compacted` is false) — the `CompactionResult.reason` (Phase D). */
      readonly reason?: string;
      /** Dirty Warm chunks pinned at scan time. */
      readonly dirtyChunks: number;
      /** Archived Warm rows actually purged (≤ dirtyChunks). */
      readonly purged: number;
      /** Elapsed wall time of the attempt (injected clock, ≥ 0; 0 under the no-wait test clock). */
      readonly ms: number;
    }
  | { readonly kind: 'op'; readonly name: MetricOpName; readonly ms: number };

/**
 * The sink you plug in. One method, synchronous, fire-and-forget. It must never throw back into the
 * caller — `CloudRoaring` wraps a user sink with {@link safeMetrics} so a buggy sink can't break I/O.
 */
export interface IMetricsSink {
  onEvent(event: MetricEvent): void;
}

/** The default sink: discards everything, zero overhead. Used whenever no sink is wired. */
export const NOOP_METRICS: IMetricsSink = {
  onEvent(): void {
    /* discard */
  },
};

/**
 * Wrap a sink so a throwing/buggy `onEvent` can never break the data path — observability is strictly
 * best-effort. `CloudRoaring` applies this to the user-supplied sink at construction.
 */
export function safeMetrics(sink: IMetricsSink): IMetricsSink {
  if (sink === NOOP_METRICS) return sink;
  return {
    onEvent(event: MetricEvent): void {
      try {
        sink.onEvent(event);
      } catch {
        /* swallow — a metrics sink must never break a read/write */
      }
    },
  };
}

/** Accumulated totals — the shape returned by {@link CountingMetricsSink.snapshot}. */
export interface MetricsSnapshot {
  readonly cold: { readonly gets: number; readonly bytes: number; readonly totalMs: number };
  readonly warm: {
    readonly reads: number;
    readonly readBytes: number;
    readonly writes: number;
    readonly writeBytes: number;
  };
  readonly cache: { readonly hits: number; readonly misses: number };
  readonly retries: { readonly occ: number; readonly transient: number };
  readonly intersect: {
    readonly calls: number;
    readonly fetchedChunks: number;
    readonly skippedChunks: number;
  };
  readonly compaction: {
    readonly attempts: number;
    readonly committed: number;
    readonly dirtyChunks: number;
    readonly purged: number;
    readonly totalMs: number;
  };
  readonly ops: Readonly<
    Record<MetricOpName, { readonly count: number; readonly totalMs: number }>
  >;
}

const OP_NAMES: readonly MetricOpName[] = [
  'add',
  'remove',
  'addMany',
  'removeMany',
  'has',
  'count',
  'intersectInto',
];

/**
 * A ready-made sink that tallies events into a {@link MetricsSnapshot} — handy for tests, quick scripts,
 * and (Phase 5b) as the grounded-request-cost source behind `costReport()`. `snapshot()` returns an
 * independent copy; `reset()` zeroes the counters.
 */
export class CountingMetricsSink implements IMetricsSink {
  private cold = { gets: 0, bytes: 0, totalMs: 0 };
  private warm = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
  private cache = { hits: 0, misses: 0 };
  private retries = { occ: 0, transient: 0 };
  private intersect = { calls: 0, fetchedChunks: 0, skippedChunks: 0 };
  private compaction = { attempts: 0, committed: 0, dirtyChunks: 0, purged: 0, totalMs: 0 };
  private ops: Record<MetricOpName, { count: number; totalMs: number }> =
    CountingMetricsSink.zeroOps();

  private static zeroOps(): Record<MetricOpName, { count: number; totalMs: number }> {
    // null-proto so a type-violating event.name (e.g. '__proto__') can never reach Object.prototype
    const ops = Object.create(null) as Record<MetricOpName, { count: number; totalMs: number }>;
    for (const name of OP_NAMES) ops[name] = { count: 0, totalMs: 0 };
    return ops;
  }

  onEvent(event: MetricEvent): void {
    switch (event.kind) {
      case 'cold.get':
        this.cold.gets += 1;
        this.cold.bytes += event.bytes;
        this.cold.totalMs += event.ms;
        break;
      case 'cache':
        if (event.hit) this.cache.hits += 1;
        else this.cache.misses += 1;
        break;
      case 'warm.read':
        this.warm.reads += 1;
        this.warm.readBytes += event.bytes;
        break;
      case 'warm.write':
        this.warm.writes += 1;
        this.warm.writeBytes += event.bytes;
        break;
      case 'retry':
        if (event.reason === 'occ') this.retries.occ += 1;
        else this.retries.transient += 1;
        break;
      case 'intersect':
        this.intersect.calls += 1;
        this.intersect.fetchedChunks += event.fetchedChunks;
        this.intersect.skippedChunks += event.skippedChunks;
        break;
      case 'compaction':
        this.compaction.attempts += 1;
        if (event.compacted) this.compaction.committed += 1;
        this.compaction.dirtyChunks += event.dirtyChunks;
        this.compaction.purged += event.purged;
        this.compaction.totalMs += event.ms;
        break;
      case 'op': {
        const op = this.ops[event.name];
        op.count += 1;
        op.totalMs += event.ms;
        break;
      }
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  snapshot(): MetricsSnapshot {
    const ops = Object.create(null) as Record<MetricOpName, { count: number; totalMs: number }>;
    for (const name of OP_NAMES) ops[name] = { ...this.ops[name] };
    return {
      cold: { ...this.cold },
      warm: { ...this.warm },
      cache: { ...this.cache },
      retries: { ...this.retries },
      intersect: { ...this.intersect },
      compaction: { ...this.compaction },
      ops,
    };
  }

  reset(): void {
    this.cold = { gets: 0, bytes: 0, totalMs: 0 };
    this.warm = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
    this.cache = { hits: 0, misses: 0 };
    this.retries = { occ: 0, transient: 0 };
    this.intersect = { calls: 0, fetchedChunks: 0, skippedChunks: 0 };
    this.compaction = { attempts: 0, committed: 0, dirtyChunks: 0, purged: 0, totalMs: 0 };
    this.ops = CountingMetricsSink.zeroOps();
  }
}
