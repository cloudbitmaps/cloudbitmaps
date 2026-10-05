/**
 * The socket-pool advisory: once the first read has run, the SDK's own request handler has made its agents and its
 * public `httpHandlerConfigs()` reports their `maxSockets`. A pool smaller than twice the default window of a combine
 * (32 ranges held ahead per operand, two operands) makes reads queue for a socket, so one `advisory` event goes to the
 * store's metrics sink, once. Nothing is logged or printed.
 *
 * A handler this cannot read (a custom one, HTTP/2, Fetch, an agent class that hides `maxSockets`) gives no event and
 * no error. The window it compares against is the default, because a combine's `concurrency` is chosen per call.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import type { IMetricsSink, MetricEvent } from '@cloudbitmaps/core/driver-kit';

/** The default window of a combine, which the engine owns; a test holds the two equal. */
export const SOCKET_ADVISORY_CONCURRENCY = 32;

/** A two-operand combine holds up to this many requests open at the default window. */
const THRESHOLD = 2 * SOCKET_ADVISORY_CONCURRENCY;

/** What of the SDK's request handler the limit and the advisory need: its `handle` and the agents it exposes once it has run. */
export interface PooledHandler {
  handle(request: unknown, options?: unknown): Promise<unknown>;
  httpHandlerConfigs?: () => {
    httpAgent?: { maxSockets: number };
    httpsAgent?: { maxSockets: number };
  };
}

export class SocketAdvisory {
  /** True from the first `attach` until the one check has started: the only thing a request pays for after the first. */
  private pending = false;
  /** Every sink ever attached, so a sink is never given the event twice. */
  private readonly sinks = new Set<IMetricsSink>();
  /** The check's result, once it has started; a sink attached after that is given the result as it settles. */
  private outcome: Promise<MetricEvent | undefined> | undefined;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  /**
   * Hand a sink to the advisory. Each sink gets the event at most once: a sink attached before the check runs gets it
   * when the first read finishes, one attached later gets it as soon as the (single) check's result is known, and
   * one attached again is ignored.
   */
  attach(sink: IMetricsSink): void {
    if (this.sinks.has(sink)) return;
    this.sinks.add(sink);
    if (this.outcome === undefined) this.pending = true;
    else void this.outcome.then((event) => event && emit(sink, event));
  }

  /**
   * Called as a request finishes. The first call after a sink is attached reads the pool, never throws and never
   * rejects; every later one costs one boolean. Returns the pending check (for a test to await), or `undefined` once
   * it has run.
   */
  afterRequest(): Promise<void> | undefined {
    if (!this.pending) return undefined;
    this.pending = false;
    const first = [...this.sinks];
    const outcome = this.read();
    this.outcome = outcome;
    return outcome.then((event) => {
      if (event) for (const sink of first) emit(sink, event);
    });
  }

  private async read(): Promise<MetricEvent | undefined> {
    try {
      const maxSockets = await this.pool();
      if (maxSockets === undefined || maxSockets >= THRESHOLD) return undefined;
      return {
        kind: 'advisory',
        code: 'socket-pool-below-window',
        driver: 's3',
        bucket: this.bucket,
        maxSockets,
        threshold: THRESHOLD,
        concurrency: SOCKET_ADVISORY_CONCURRENCY,
      };
    } catch {
      // A handler of another shape: the advisory is best-effort and never fails a read.
      return undefined;
    }
  }

  /**
   * The pool the reads use, or `undefined` when it cannot be read. With an endpoint on the client, that is the
   * `maxSockets` of the agent for its scheme. Without one (the SDK's own endpoints, or an endpoint set by the
   * environment, which the client does not expose) the scheme is not known, so every agent the handler has made is
   * read and the pool counts as small only if all of them are: the larger one is returned. That never warns on a pool
   * the reads do not use, at the cost of a missed warning when only the unused agent is small.
   */
  private async pool(): Promise<number | undefined> {
    const handler = this.client.config.requestHandler as unknown as PooledHandler | undefined;
    if (typeof handler?.httpHandlerConfigs !== 'function') return undefined;
    const endpoint = await this.client.config.endpoint?.();
    const agents = handler.httpHandlerConfigs();
    const candidates =
      endpoint === undefined
        ? [agents?.httpsAgent, agents?.httpAgent]
        : [endpoint.protocol === 'http:' ? agents?.httpAgent : agents?.httpsAgent];
    let largest: number | undefined;
    for (const agent of candidates) {
      const n = agent?.maxSockets;
      if (typeof n !== 'number' || Number.isNaN(n)) continue;
      if (largest === undefined || n > largest) largest = n;
    }
    return largest;
  }
}

/** Give one sink the event; a sink that throws never reaches the read. */
function emit(sink: IMetricsSink, event: MetricEvent): void {
  try {
    sink.onEvent(event);
  } catch {
    // Best-effort, like every metrics sink.
  }
}
