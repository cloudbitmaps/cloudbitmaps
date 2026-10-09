/**
 * `S3Storage` — the S3 backend as one object: the generations and the pointer, in one bucket, stated once.
 *
 * Replaces two constructor calls that each repeated `client`, `bucket` and `prefix`. Repeating them is how
 * they come apart: point the registry at one prefix and the objects at another and the store answers *empty*
 * rather than *misconfigured*, which is the hardest kind of wrong answer to debug. Here the location is written
 * once and shared, so the mismatch cannot be expressed.
 *
 * **It will build a client for you**, which is the common case — `new S3Storage({ bucket })` picks up the
 * ambient credential chain and region exactly as the SDK would. Pass `client` instead when you need a
 * credential chain the SDK cannot infer (SSO, an assumed role, a custom retry strategy); pass `endpoint` +
 * `pathStyle` + `credentials` for an S3-compatible store (MinIO, Ceph, R2). Both halves stay reachable as `.storage` and
 * `.registry` for anyone wiring something the facade does not cover. `maxObjectBytes` and `partBytes` size the
 * multipart upload, and `readTimeoutMs`, when set, bounds each read both halves make.
 */
import { STORAGE_BACKEND, ValidationError, brandAsBackend } from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from './storage';
import { S3RegistryDriver } from './registry';
import { describe } from './read-timeout';
import { SocketAdvisory, type PooledHandler } from './socket-advisory';
import type { IMetricsSink } from '@cloudbitmaps/core/driver-kit';

export interface S3StorageOptions {
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which everything lives — generations and the registry alike. */
  readonly prefix?: string;
  /**
   * A constructed client. Supply one for a credential chain the SDK cannot infer; otherwise one is built. Its retry
   * applies to every request except the conditional writes, which the driver sends with that retry off whatever it is
   * configured to do: a registry row once, and a generation's object again only after a throttle, under its own backoff.
   */
  readonly client?: S3Client;
  /** Region for the client built when `client` is absent (refused beside `client`). Falls back to the SDK's own resolution. */
  readonly region?: string;
  /** Endpoint for an S3-compatible store (MinIO, Ceph, R2). Refused beside `client`, which carries its own. */
  readonly endpoint?: string;
  /** Path-style addressing, which most S3-compatible stores require. Refused beside `client`, which carries its own. */
  readonly pathStyle?: boolean;
  /**
   * Static credentials, for the S3-compatible stores that issue them (MinIO, Ceph, R2).
   *
   * On AWS itself, leave this unset — the SDK's own chain (instance role, SSO, environment, profile) is what
   * you want, and hard-coding keys to reach it would be a downgrade. It exists because the alternative for a
   * MinIO user was to construct an `S3Client` purely to carry two strings, which is the ergonomics this class
   * is here to remove. Refused beside `client`, which carries its own.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /**
   * Most sockets the built client opens at once to one scheme, for `https` and for a plain-`http` endpoint alike
   * (default 128). The AWS SDK's own default is 50, which a window of 32 reads per operand outgrows on the first
   * two-operand `intersect`. Only this limit differs from the SDK's own client: its request handler, keep-alive,
   * timeouts and retry are the SDK's. If a future SDK changes its handler, the built client keeps the SDK's own
   * limit rather than failing to build. A positive safe integer. Release a built client's sockets with
   * `store.client.destroy()`. Refused beside `client`, which carries its own request handler. A deployment
   * that runs `eraseSubject`'s 256 reads at once needs `256`, or a lower `concurrency`.
   */
  readonly maxSockets?: number;
  /**
   * Largest object the backend will write and advertise. Default = `partBytes × 10,000` (≈ 80 GiB at the default
   * 8 MiB part) — the honest ceiling reachable within S3's 10,000-part limit. Set it higher and `partBytes`
   * auto-grows so 10,000 parts still cover it (raising peak write memory to ~one part); up to the 5 TiB S3 max, and a
   * larger cap, or a `partBytes` above S3's 5 GiB part limit, is refused with `ValidationError`.
   * Must be a positive safe integer.
   */
  readonly maxObjectBytes?: number;
  /** Multipart part size in bytes (default 8 MiB; a smaller value is raised to the S3 5 MiB minimum). Must be a
   * positive safe integer. Tunes peak write memory. */
  readonly partBytes?: number;
  /**
   * How long one read may take before it is abandoned, in ms. `0`, the default, sets no timeout. When set, it bounds
   * each `GetObject` and `HeadObject` either half sends, the response body included, so a connection that stops
   * answering part-way through a body is cut off too. A read that runs out of time throws `TransientError`, which the
   * store's read retry runs again. AWS's S3 guidance is to retry a GET of under 512 KB that has not answered in about
   * 2 seconds. Must be a non-negative safe integer no larger than 2,147,483,647.
   *
   * The clock starts when the read is handed to the SDK, so it also counts the time the read waits for one of the
   * client's sockets (128 by default, `maxSockets`) and the time spent fetching credentials, and under `retryMode:
   * 'adaptive'` the SDK's rate-limiter wait. A burst of concurrent reads larger than the socket pool can therefore time
   * out with nothing slow on the wire: size the timeout above the worst queueing your concurrency implies, or raise
   * `maxSockets` (the client you pass carries its own). On a client built with `cacheMiddleware: true`, a timed read
   * resolves its middleware each time.
   *
   * Writes and listings are never timed: a write that hangs needs a timeout on the client (its `requestHandler`). The
   * timeout is applied per request, so a `client` you pass gets it without being changed.
   */
  readonly readTimeoutMs?: number;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Whether the store applies `If-Match` on a `DeleteObject`, which both halves rely on when it is on: the registry
   * removes a deleted row for good rather than leaving a tombstone a full listing reads forever, and the storage half
   * removes an erasure's holder only while it is the object the erasure searched, by its ETag. Defaults to `true` when
   * the host the client resolves is an AWS S3 host, whichever way its endpoint was set (`endpoint`,
   * `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, the shared config file), and to `false` for any other host: set it for an
   * S3-compatible store only once you know the store applies `If-Match` on a delete. MinIO, for one, ignores it. It is
   * never `true` for an SDK that does not send the header.
   */
  readonly conditionalDelete?: boolean;
}

/**
 * The keys `new S3Storage(options)` takes. Any other is refused by name rather than ignored: an ignored client or
 * endpoint key builds a client from ambient credentials against the **public** endpoint, and for a store pointed at
 * MinIO that is production traffic from a wiring typo.
 */
export const S3_STORAGE_OPTION_KEYS = [
  'bucket',
  'prefix',
  'client',
  'region',
  'endpoint',
  'pathStyle',
  'credentials',
  'maxSockets',
  'maxObjectBytes',
  'partBytes',
  'readTimeoutMs',
  'now',
  'conditionalDelete',
] as const;

/** The settings that build a client, which a supplied `client` already carries and so cannot be given beside. */
const CLIENT_SETTINGS = ['region', 'endpoint', 'pathStyle', 'credentials', 'maxSockets'] as const;

/** Default socket limit of a client the store builds: two operands at the default window of 32 reads each, doubled. */
const DEFAULT_MAX_SOCKETS = 128;

/**
 * Cap the sockets the SDK's own request handler opens, and change nothing else about it. The handler stays the SDK's
 * default one, so its other defaults hold: its defaults-mode connection timeout, keep-alive, and a request that
 * sends `Expect: 100-continue` (a part of 2 MiB or more) still goes on its own connection outside this pool. Only the
 * `maxSockets` of its two pooled agents is set, before the first request goes out. The handler makes its agents on
 * that first request (the http one even later, per request, so a first burst to a plain-http endpoint would get one
 * pool each), so the first request first runs an aborted one through it, which makes them, then sets the limit on
 * the agents it made.
 */
export function limitSockets(client: S3Client, maxSockets: number): void {
  const handler = client.config.requestHandler as unknown as PooledHandler;
  // A handler of another shape is left as it is: a tuning setting never stops the store from being built, and the
  // client then keeps the SDK's own limit.
  if (typeof handler?.handle !== 'function' || typeof handler.httpHandlerConfigs !== 'function')
    return;
  const handle = handler.handle.bind(handler);
  const agents = handler.httpHandlerConfigs.bind(handler);
  let ready: Promise<void> | undefined;
  const warm = async (): Promise<void> => {
    const abort = new AbortController();
    abort.abort();
    try {
      // An `http:` request makes the handler build both agents; on a client that only ever speaks https the http
      // agent stays idle, and `client.destroy()` frees it with the rest.
      await handle({ protocol: 'http:' }, { abortSignal: abort.signal }).catch(() => undefined);
      const { httpAgent, httpsAgent } = agents();
      if (httpAgent) httpAgent.maxSockets = maxSockets;
      if (httpsAgent) httpsAgent.maxSockets = maxSockets;
    } catch {
      // The handler is not the shape this expects: the limit stays the SDK's own.
    }
  };
  handler.handle = async (request, options) => {
    ready ??= warm();
    await ready;
    return handle(request, options);
  };
}

/** Refuse an options bag that is not an object, or that holds a key not in `keys`, naming each such key. */
function refuseUnknown(
  name: string,
  options: unknown,
  keys: readonly string[],
  hint: string,
): void {
  if (options === null || typeof options !== 'object') {
    throw new ValidationError(
      `${name} needs an options object — got ${options === null ? 'null' : typeof options}`,
    );
  }
  const unknown = Object.keys(options).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    const list = (ks: readonly string[]): string => ks.map((k) => `\`${k}\``).join(', ');
    throw new ValidationError(
      `${name} does not take ${list(unknown)}. It takes ${list(keys)}; ${hint}.`,
    );
  }
}

export class S3Storage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: S3Client;
  private readonly sockets: SocketAdvisory;

  constructor(options: S3StorageOptions) {
    refuseUnknown('S3Storage', options, S3_STORAGE_OPTION_KEYS, 'an S3 client goes in `client`');
    if (typeof options.bucket !== 'string' || options.bucket.length === 0) {
      throw new ValidationError('S3Storage needs a `bucket`: the name of one, a non-empty string');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new ValidationError(
        "S3Storage's `now` must be a function that returns epoch milliseconds",
      );
    }
    if (options.client !== undefined && options.client !== null) {
      // A supplied client already carries its region, endpoint, addressing style and credentials, so a setting
      // beside it is ignored, and ignoring it leaves the store talking to somewhere the caller did not mean:
      // an `endpoint` meant for MinIO, silently dropped, is production traffic from a client that was built
      // for AWS. Refuse instead of picking one.
      const ignored = CLIENT_SETTINGS.filter((k) => options[k] !== undefined);
      if (ignored.length > 0) {
        throw new ValidationError(
          `S3Storage takes \`client\` OR ${CLIENT_SETTINGS.map((k) => `\`${k}\``).join(' / ')}, not both — ` +
            `got \`client\` with ${ignored.map((k) => `\`${k}\``).join(', ')}; ` +
            'the `client` already carries them, so configure them on the client, or drop `client`',
        );
      }
      this.client = options.client;
    } else {
      const { maxSockets = DEFAULT_MAX_SOCKETS } = options;
      if (!Number.isSafeInteger(maxSockets) || maxSockets < 1) {
        throw new ValidationError(
          `maxSockets must be a positive safe integer; got ${describe(options.maxSockets)}`,
        );
      }
      this.client = new S3Client({
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.pathStyle === undefined ? {} : { forcePathStyle: options.pathStyle }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      });
      limitSockets(this.client, maxSockets);
    }
    this.sockets = new SocketAdvisory(this.client, options.bucket);
    const shared = {
      client: this.client,
      bucket: options.bucket,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    };
    this.storage = new S3StorageDriver({
      ...shared,
      sockets: this.sockets,
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
      ...(options.conditionalDelete === undefined
        ? {}
        : { conditionalDelete: options.conditionalDelete }),
    });
    this.registry = new S3RegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.conditionalDelete === undefined
        ? {}
        : { conditionalDelete: options.conditionalDelete }),
    });
    brandAsBackend(this);
  }

  /**
   * Called by a store given a metrics sink. After the first read, a client whose socket pool is smaller than twice the
   * default window (64) sends the sink one `advisory` event, once; see the production guide's socket sizing.
   */
  attachMetrics(sink: IMetricsSink): void {
    this.sockets.attach(sink);
  }
}
