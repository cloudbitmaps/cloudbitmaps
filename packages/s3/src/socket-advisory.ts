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
import type { IMetricsSink } from '@cloudbitmaps/core/driver-kit';

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
  /** True from `attach` until the one check has run: the only thing a request pays for after the first. */
  private pending = false;
  private sink: IMetricsSink | undefined;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  /** Start watching: the next request to finish is the one that reads the pool. */
  attach(sink: IMetricsSink): void {
    this.sink = sink;
    this.pending = true;
  }

  /**
   * Called as a request finishes. The first call reads the pool, never throws and never rejects; every later one costs
   * one boolean. Returns the pending check (for a test to await), or `undefined` once it has run.
   */
  afterRequest(): Promise<void> | undefined {
    if (!this.pending) return undefined;
    this.pending = false;
    return this.check();
  }

  private async check(): Promise<void> {
    try {
      const maxSockets = await this.pool();
      if (maxSockets === undefined || maxSockets >= THRESHOLD) return;
      this.sink?.onEvent({
        kind: 'advisory',
        code: 'socket-pool-below-window',
        driver: 's3',
        bucket: this.bucket,
        maxSockets,
        threshold: THRESHOLD,
        concurrency: SOCKET_ADVISORY_CONCURRENCY,
      });
    } catch {
      // A handler of another shape, or a sink that threw: the advisory is best-effort and never fails a read.
    }
  }

  /**
   * The `maxSockets` of the agent for the scheme the client talks, or `undefined` when it cannot be read. The scheme is
   * the client's endpoint when it has one, else https (the SDK's own endpoints). The other agent is not the pool the
   * reads use, and one the SDK made with its default would otherwise read as a small pool.
   */
  private async pool(): Promise<number | undefined> {
    const handler = this.client.config.requestHandler as unknown as PooledHandler | undefined;
    if (typeof handler?.httpHandlerConfigs !== 'function') return undefined;
    const endpoint = await this.client.config.endpoint?.();
    const agents = handler.httpHandlerConfigs();
    const agent = endpoint?.protocol === 'http:' ? agents?.httpAgent : agents?.httpsAgent;
    const n = agent?.maxSockets;
    return typeof n === 'number' && !Number.isNaN(n) ? n : undefined;
  }
}
