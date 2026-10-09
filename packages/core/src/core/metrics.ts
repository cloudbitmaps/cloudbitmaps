/**
 * Metrics seam — an injected sink the engine pushes typed events to, exactly like the `Clock`/driver seams
 * keep `core/` pure and storage-agnostic.
 *
 * Design: the library emits **neutral domain events** and stays vendor-agnostic — you (or a ~12-line
 * adapter) map them to OpenTelemetry / Datadog / a log line. The default is a **no-op**, and emission is
 * skipped entirely when no sink is wired (near-zero overhead, no telemetry dependency). Events carry **raw
 * observations** (bytes, counts, ms); turning those into billable units / dollars is left to whoever reads them,
 * which keeps rates out of the library (`@cloudbitmaps/tools` prices a workload you give it).
 *
 * Two caveats for sink authors: `onEvent` runs **synchronously on the I/O path**, so keep it cheap and
 * non-blocking (offload batching/network to your own async queue); and `segment`/`namespace` are
 * caller-controlled strings that may be PII and are **unbounded-cardinality** — do not map them to
 * per-series metric labels unless they're known low-cardinality and PII-free. See the observability
 * guide.
 */

import { ignoreRejection } from './audit';
import { ValidationError } from './errors';

/**
 * The operations that emit an `op` latency event (timed with the injected clock, at the facade). `materializeMany` is
 * timed from its first request, the pins, to its last publish: a call its input checks refuse emits none.
 *
 * A name added here stops two kinds of code compiling: a sink that switches on `name` with an exhaustive `never` check
 * (add a case, or use a `default` branch, which needs no change), and a `Record<MetricOpName, …>` built by hand, a
 * `MetricsSnapshot` literal among them (add the key).
 */
export type MetricOpName =
  'has' | 'count' | 'intersectInto' | 'unionInto' | 'andNotInto' | 'materializeMany';

/**
 * One observability event. A discriminated union on `kind` — new variants can be added over time without
 * breaking consumers (they switch on the kinds they care about). `namespace` is the segment's namespace
 * (absent ⇒ the default namespace). Segment names are identifiers, never bitmap contents (threat model:
 * never log PII / bitmap bits).
 */
export type MetricEvent =
  | {
      readonly kind: 'storage.get';
      readonly namespace?: string;
      readonly segment: string;
      /**
       * One event per request for chunks: a range request of a combine, `iterate` or `materializeMany`, which carries
       * every chunk the read needs from a stretch of the object, or the one chunk of a read made on its own, however
       * many callers were waiting on it. A `materializeMany` range serves every output of its group, so its events
       * count the requests the call sent, not requests per output. Bytes returned: the range's, the gaps between its
       * chunks included (0 if a single chunk was absent — a GET still happened).
       */
      readonly bytes: number;
      /**
       * Elapsed wall time of the request — includes any transient-retry backoff on the storage call. From the
       * injected clock, clamped to ≥ 0 (0 under the no-wait test clock). For a range of a stream, the time from the
       * range being asked for to its answer, which the source measures.
       */
      readonly ms: number;
    }
  | {
      /**
       * One decoded-chunk cache lookup (emitted only when a cache is configured). `hit: false` means the lookup found
       * no cached chunk. A combine or `iterate` looks up every chunk it needs when it opens its streams. A caller that
       * missed while another caller's read of the same chunk was open waits on that read and adds no `storage.get`, and a
       * range carries several chunks, so the misses can outnumber the `storage.get` events; the `storage.get` count is
       * the number of requests for chunks. `materializeMany` never looks up the cache, so it emits none.
       */
      readonly kind: 'cache';
      readonly hit: boolean;
    }
  | {
      readonly kind: 'retry';
      /** Infrastructure-fault backoff (throttling, 5xx, a dropped connection) — the one kind of retry the store does. */
      readonly reason: 'transient';
      /** 1-based number of the attempt about to be retried. */
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      /**
       * One per chunk-aligned combine of one operator. `materializeMany` emits none: an output is an expression over
       * several operators, and the call's `stats.chunks.pruned` counts the index keys it did not read.
       */
      readonly kind: 'intersect';
      /**
       * Which chunk-aligned combine this was. **Optional** — absent means `'intersect'`.
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
       * **Keys, not requests.** The actual storage GETs are roughly `fetchedChunks × operands`, plus one per
       * `exclude` that holds a given key, which is why this number is smaller than what the per-op budget
       * charges for the same call. The two are different units by design; if you are reconciling a bill, the
       * budget's accounting is the one that models requests.
       */
      readonly fetchedChunks: number;
      /**
       * **Distinct** chunk-keys pruned — never fetched (the chunk-skipping saving). Counts distinct keys,
       * not per-operand GETs, so it under-states the true GET saving when 3+ operands partially overlap.
       *
       * On a read bounded by `after` / `through`, this and `fetchedChunks` count only the keys inside the range:
       * the keys outside it are never considered, so they are not counted as pruned either. Both count the keys the
       * call would fetch if read to the end, so a page that stops early reports every key up to `through`, or to the
       * end of the segment when `through` is left out.
       */
      readonly skippedChunks: number;
    }
  | { readonly kind: 'op'; readonly name: MetricOpName; readonly ms: number }
  | {
      /**
       * A once-only note that a setting looks too small for how the store is used. It is not a fault: nothing failed.
       * Emitted by a backend that can read the setting, never on a request's path after the first, and silent for
       * anything the backend cannot read, so no event does not mean the setting is large enough.
       *
       * `'socket-pool-below-window'`: the S3 client's pool is smaller than `threshold` sockets, twice `concurrency`.
       * `concurrency` is the default window of a combine (32), since a combine's own `concurrency` is chosen per call
       * and the backend cannot see it: a store that always passes a lower one can ignore the event. `maxSockets` is
       * the `maxSockets` of the agent for the scheme of the client's endpoint, or, when the client does not expose an
       * endpoint, the larger of the agents its handler has made (the event fires only when all are below `threshold`).
       * `driver` and `bucket` say which backend the pool
       * belongs to; they never carry a credential, an endpoint or a key.
       *
       * A sink that switches on `kind` with an exhaustive `never` check stops compiling at this variant: add a case
       * for `'advisory'` (ignoring it is fine). A sink with a `default` branch needs no change.
       */
      readonly kind: 'advisory';
      readonly code: 'socket-pool-below-window';
      readonly driver: string;
      readonly bucket: string;
      readonly maxSockets: number;
      readonly threshold: number;
      readonly concurrency: number;
    };

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
  // One without an `onEvent` method would receive nothing and say nothing: the swallow below hides the throw.
  if (typeof (sink as { onEvent?: unknown } | null)?.onEvent !== 'function') {
    throw new ValidationError(
      'metrics must be a sink with an onEvent(event) method, such as a CountingMetricsSink',
    );
  }
  return {
    onEvent(event: MetricEvent): void {
      try {
        ignoreRejection(sink.onEvent(event) as unknown);
      } catch {
        /* swallow — a metrics sink must never break a read, an async one's rejection included */
      }
    },
  };
}

/** Accumulated totals — the shape returned by {@link CountingMetricsSink.snapshot}. */
export interface MetricsSnapshot {
  readonly storage: { readonly gets: number; readonly bytes: number; readonly totalMs: number };
  readonly cache: { readonly hits: number; readonly misses: number };
  readonly retries: { readonly transient: number };
  readonly intersect: {
    readonly calls: number;
    readonly fetchedChunks: number;
    readonly skippedChunks: number;
  };
  readonly ops: Readonly<
    Record<MetricOpName, { readonly count: number; readonly totalMs: number }>
  >;
}

const OP_NAMES: readonly MetricOpName[] = [
  'has',
  'count',
  'intersectInto',
  'unionInto',
  'andNotInto',
  'materializeMany',
];

/**
 * A ready-made sink that tallies events into a {@link MetricsSnapshot} — handy for tests, quick scripts, and for
 * reading the request rates a cost model is given. `snapshot()` returns an independent copy; `reset()` zeroes the
 * counters.
 */
export class CountingMetricsSink implements IMetricsSink {
  private storage = { gets: 0, bytes: 0, totalMs: 0 };
  private cache = { hits: 0, misses: 0 };
  private retries = { transient: 0 };
  private intersect = { calls: 0, fetchedChunks: 0, skippedChunks: 0 };
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
      case 'storage.get':
        this.storage.gets += 1;
        this.storage.bytes += event.bytes;
        this.storage.totalMs += event.ms;
        break;
      case 'cache':
        if (event.hit) this.cache.hits += 1;
        else this.cache.misses += 1;
        break;
      case 'retry':
        this.retries.transient += 1;
        break;
      case 'intersect':
        this.intersect.calls += 1;
        this.intersect.fetchedChunks += event.fetchedChunks;
        this.intersect.skippedChunks += event.skippedChunks;
        break;
      case 'op': {
        // A name outside `OP_NAMES` (a JS caller) is counted nowhere rather than crashing the sink.
        const op = this.ops[event.name] as { count: number; totalMs: number } | undefined;
        if (op === undefined) break;
        op.count += 1;
        op.totalMs += event.ms;
        break;
      }
      case 'advisory':
        // A note for the sink's author, not a quantity to total.
        break;
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
      storage: { ...this.storage },
      cache: { ...this.cache },
      retries: { ...this.retries },
      intersect: { ...this.intersect },
      ops,
    };
  }

  reset(): void {
    this.storage = { gets: 0, bytes: 0, totalMs: 0 };
    this.cache = { hits: 0, misses: 0 };
    this.retries = { transient: 0 };
    this.intersect = { calls: 0, fetchedChunks: 0, skippedChunks: 0 };
    this.ops = CountingMetricsSink.zeroOps();
  }
}
