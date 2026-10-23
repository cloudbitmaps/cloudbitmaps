import {
  STORAGE_BACKEND,
  ValidationError,
  brandAsBackend,
  normalizeObjectPrefix,
  prefixPart,
  refuseUnknownOptions,
  requireNonEmptyString,
} from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  LifecycleVerdict,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { Storage as GcsClient } from '@google-cloud/storage';
import { defined } from './defined';
import { checkGcsLifecycle } from './lifecycle';
import { resolveReadTimeoutMs } from './read-timeout';
import { GcsStorageDriver } from './storage';
import { GcsRegistryDriver } from './registry';
import { downloadClient } from './read-client';

/**
 * What {@link GcsStorage} takes: a `bucket`, and either a `client` or the two settings that build one (`projectId`,
 * `apiEndpoint`), never both.
 */
export interface GcsStorageOptions {
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which everything lives — generations and the registry alike. A string, else `ValidationError`. */
  readonly prefix?: string;
  /**
   * A constructed `@google-cloud/storage` client. One is built from the ambient credentials when absent. Its retry
   * options apply to every request except the single-request conditional writes, which the driver sends without
   * that retry whatever they say (a registry row once, and a generation's object again only after a throttle, under
   * its own backoff), and the downloads. In `@google-cloud/storage` 8.x, and in 7.x (which the driver's range does not admit), a download the SDK retries after a 408,
   * 429, 500, 502, 503 or 504 can crash the process with `ERR_STREAM_UNABLE_TO_PIPE`, so downloads go through a twin of
   * this client, built from its own class with the same credentials object, endpoint and settings and the SDK's retries
   * off over any its class set, and the driver retries them itself. A client whose twin would use other credentials or
   * another endpoint (a subclass that builds from options of its own), whose class overrides `bucket` (a test double
   * built on `Storage`), or whose `bucket` is replaced on the instance (a test stub; stub `Storage.prototype` instead)
   * is refused at construction. A test double that is not a `Storage` client is used as it is when it has
   * `retryOptions: { autoRetry: false }`, and refused without it. What is set on the client after the backend was
   * built, other than an interceptor, is not carried to the twin.
   */
  readonly client?: GcsClient;
  /**
   * Project id for the client built when `client` is absent (refused beside `client`): a non-empty string, else
   * `ValidationError`. Falls back to the SDK's own resolution.
   */
  readonly projectId?: string;
  /**
   * Endpoint override — point it at fake-gcs-server locally: a non-empty string, since an empty one would send
   * requests to the public endpoint, else `ValidationError`. Refused beside `client`, which carries its own.
   */
  readonly apiEndpoint?: string;
  /** Largest object the backend will write and advertise (default = GCS's 5 TiB max). Must be a positive safe integer. */
  readonly maxObjectBytes?: number;
  /** Bytes at/under which a single non-resumable upload is used instead of a resumable stream (default 8 MiB).
   * Must be a positive safe integer. */
  readonly simpleUploadThresholdBytes?: number;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Cut off a read that has run this long, in milliseconds. `0`, the default, sets no timeout. A client's own `timeout`
   * does not bound a download on `@google-cloud/storage` 8.x (the SDK hands it to an HTTP client that has no such
   * option), so this is what does.
   *
   * It bounds each read as a whole — a generation's tail (with the metadata read it falls back on for an empty
   * object), a range of it, a registry row — with one deadline across every attempt the driver makes and the backoff
   * between them. The clock starts at the call into the driver, so a credential fetch and any wait for a socket count
   * (Node's agents set no socket limit unless your process sets one), and runs until the whole body has arrived. It
   * counts time the process spends busy too: Node runs a due timer before it reads a socket, so a synchronous stretch
   * longer than the timeout fails the reads in flight even when their responses have arrived. When it passes, the read
   * throws `TransientError` naming the read and the timeout and no further attempt starts, for the store's read retry
   * to run again: about 8.35 s in all at `2_000` with the default retry policy. Uploads, deletes, listings and the
   * conditional writes are not timed. The SDK cannot cancel a request whose response has not begun, so a read timed
   * out before its server answers leaves that connection open until the server answers or closes it: one per read, up
   * to four per call through the store's retry. A non-negative safe integer no larger than 2,147,483,647.
   */
  readonly readTimeoutMs?: number;
  /**
   * Whether the service applies `ifGenerationMatch` on an object delete, which both halves rely on when it is set: the
   * registry removes a deleted row for good rather than leaving a tombstone a full listing reads forever, and the
   * storage half removes an erasure's holder only while it is the object the erasure searched, by its generation.
   * Defaults to `false`, on the public endpoint too: whether real GCS applies `ifGenerationMatch` to a delete has not
   * been verified by a run against the service, and fake-gcs-server accepts the precondition and ignores it, so CI
   * cannot show it. Set `true` once you know it does. Until then, the window in which an erasure's stalled delete
   * takes a generation a load put under the number since stays open on GCS.
   */
  readonly conditionalDelete?: boolean;
}

/**
 * The keys `new GcsStorage(options)` takes. Any other is refused by name rather than ignored: an ignored client key
 * — `storage`, as the lower-level storage driver calls it — falls back to ambient credentials and the **public** endpoint, and
 * for a client pointed at an emulator that is production traffic from a wiring typo.
 */
export const GCS_STORAGE_OPTION_KEYS = [
  'bucket',
  'prefix',
  'client',
  'projectId',
  'apiEndpoint',
  'maxObjectBytes',
  'simpleUploadThresholdBytes',
  'now',
  'readTimeoutMs',
  'conditionalDelete',
] as const;

/** The settings that build a client, which a supplied `client` already carries and so cannot be given beside. */
const CLIENT_SETTINGS = ['projectId', 'apiEndpoint'] as const;

/**
 * `GcsStorage` — the Google Cloud Storage backend as one object: generations and pointer, one bucket, stated once.
 *
 * See {@link StorageBackend} for why the two halves are configured together rather than separately.
 *
 * **A note on the word.** `@google-cloud/storage` names its own client class `Storage`, so the driver option
 * that takes it is also called `storage` — which, since this library calls its durable tier storage too, reads
 * as the same word meaning two things. That is why this class builds the client itself: `new GcsStorage({ bucket })`
 * never makes you write `{ storage: storage }`. Supply `client` when you need your own.
 */
export class GcsStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: GcsClient;
  private readonly bucket: string;
  /** The name prefix every object sits under: `''`, or `trimmed/`. */
  private readonly keyPrefix: string;
  private readonly readTimeoutMs: number;

  /**
   * Builds the GCS backend over one bucket, which `bucket` names. Pass `client`, or `projectId` and `apiEndpoint` to
   * have one built, not both. `prefix` puts every object under a name prefix. Throws `ValidationError` for an unknown
   * option, no bucket, a `now` that is not a function, a client setting beside `client`, a `maxObjectBytes` or
   * `simpleUploadThresholdBytes` that is not a positive integer, a `conditionalDelete` that is not a boolean, an
   * empty or non-string `apiEndpoint` or `projectId`, or an invalid `prefix` or `readTimeoutMs`.
   */
  constructor(options: GcsStorageOptions) {
    let readClient: GcsClient;
    refuseUnknownOptions(
      'GcsStorage',
      options,
      GCS_STORAGE_OPTION_KEYS,
      'a @google-cloud/storage client goes in `client`',
    );
    if (typeof options.bucket !== 'string' || options.bucket.trim().length === 0) {
      throw new ValidationError('GcsStorage needs a `bucket`: the name of one, a non-empty string');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new ValidationError(
        "GcsStorage's `now` must be a function that returns epoch milliseconds",
      );
    }
    if (options.client !== undefined && options.client !== null) {
      // A supplied client already carries its project and endpoint, so a setting beside it is ignored, and
      // ignoring it leaves the store talking to somewhere the caller did not mean: an `apiEndpoint` meant for an
      // emulator, silently dropped, is production traffic from a client that was built for the public endpoint.
      // Refuse instead of picking one.
      const ignored = CLIENT_SETTINGS.filter((k) => options[k] !== undefined);
      if (ignored.length > 0) {
        throw new ValidationError(
          `GcsStorage takes \`client\` OR ${CLIENT_SETTINGS.map((k) => `\`${k}\``).join(' / ')}, not both — ` +
            `got \`client\` with ${ignored.map((k) => `\`${k}\``).join(', ')}; ` +
            'the `client` already carries them, so configure them on the client, or drop `client`',
        );
      }
      this.client = options.client;
      readClient = downloadClient(options.client, true);
    } else {
      // An empty `apiEndpoint` is no endpoint: the client would send to the public cloud, not the service meant.
      const apiEndpoint = requireNonEmptyString('GcsStorage: `apiEndpoint`', options.apiEndpoint);
      // A bare scheme names no host; the client's own refusal of it talks about an environment variable instead.
      if (apiEndpoint !== undefined && /^[a-z][a-z0-9+.-]*:\/*$/i.test(apiEndpoint.trim())) {
        throw new ValidationError(
          'GcsStorage: `apiEndpoint` must name a host, such as "http://localhost:4443" or "storage.googleapis.com"',
        );
      }
      requireNonEmptyString('GcsStorage: `projectId`', options.projectId);
      this.client = new GcsClient(
        defined({ projectId: options.projectId, apiEndpoint: options.apiEndpoint }),
      );
      // Downloads go through a twin that sends each once (see `read-client.ts`); it shares this client's credentials
      // object, so one token fetch and one hourly refresh serve both.
      readClient = downloadClient(this.client, false);
    }
    this.bucket = options.bucket;
    this.keyPrefix = prefixPart(normalizeObjectPrefix(options.prefix));
    this.readTimeoutMs = resolveReadTimeoutMs(options.readTimeoutMs);
    const shared = {
      storage: this.client,
      readStorage: readClient,
      bucket: options.bucket,
      ...defined({ prefix: options.prefix, readTimeoutMs: options.readTimeoutMs }),
    };
    this.storage = new GcsStorageDriver({
      ...shared,
      ...defined({
        maxObjectBytes: options.maxObjectBytes,
        simpleUploadThresholdBytes: options.simpleUploadThresholdBytes,
        conditionalDelete: options.conditionalDelete,
      }),
    });
    this.registry = new GcsRegistryDriver({
      ...shared,
      ...defined({ now: options.now, conditionalDelete: options.conditionalDelete }),
    });
    brandAsBackend(this);
  }

  /**
   * Reads the bucket's metadata (one request, plus the SDK's own retries, bounded by `readTimeoutMs` when it is set) and
   * reports a lifecycle rule with a `Delete` action (or one it does not know) that applies to live
   * objects whose names can be this store's: generations and registry rows alike. Needs `storage.buckets.get`, which
   * a load never uses (`store.preflight()`'s lifecycle step does) and `roles/storage.objectAdmin` does not include: without it the answer is
   * `unchecked`, naming the permission. Never rejects; a `detail` carries no credential. Rule reading: see the
   * production guide.
   */
  checkLifecycle(): Promise<LifecycleVerdict> {
    return checkGcsLifecycle(this.client, this.bucket, this.keyPrefix, this.readTimeoutMs);
  }
}
