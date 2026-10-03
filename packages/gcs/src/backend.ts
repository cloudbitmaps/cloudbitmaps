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
import { STORAGE_BACKEND, ValidationError, brandAsBackend } from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { Storage as GcsClient } from '@google-cloud/storage';
import { GcsStorageDriver } from './storage';
import { GcsRegistryDriver } from './registry';

export interface GcsStorageOptions {
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which everything lives — generations and the registry alike. */
  readonly prefix?: string;
  /**
   * A constructed `@google-cloud/storage` client. One is built from the ambient credentials when absent. Its retry
   * options apply to every request except the single-request conditional writes, which are sent once whatever they
   * say. In `@google-cloud/storage` 7.x and 8.x a download the SDK retries after a 408, 429, 500, 502, 503 or 504 can crash the process
   * with `ERR_STREAM_UNABLE_TO_PIPE`, so build it with `retryOptions: { autoRetry: false }`; the driver retries
   * downloads itself. That also turns off the SDK's retries of listings, metadata reads and resumable uploads on
   * this client, which the store does not retry. The client built here needs none of this: only its downloads are sent once.
   */
  readonly client?: GcsClient;
  /** Project id for the client built when `client` is absent (refused beside `client`). Falls back to the SDK's own resolution. */
  readonly projectId?: string;
  /** Endpoint override — point it at fake-gcs-server locally. Refused beside `client`, which carries its own. */
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
] as const;

/** The settings that build a client, which a supplied `client` already carries and so cannot be given beside. */
const CLIENT_SETTINGS = ['projectId', 'apiEndpoint'] as const;

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

export class GcsStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: GcsClient;

  constructor(options: GcsStorageOptions) {
    let readClient: GcsClient;
    refuseUnknown(
      'GcsStorage',
      options,
      GCS_STORAGE_OPTION_KEYS,
      'a @google-cloud/storage client goes in `client`',
    );
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
      readClient = options.client;
    } else {
      const settings = {
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
      };
      this.client = new GcsClient(settings);
      // A second client, for downloads only. `@google-cloud/storage` 7.x and 8.x retry a failed download by default, and
      // when the retried request succeeds they throw `ERR_STREAM_UNABLE_TO_PIPE` outside any promise, which ends the
      // process whatever the caller wrote around the call. A download is sent once instead, and the driver retries it
      // itself (`download-retry.ts`). Everything else keeps the default retries: a resumable upload's session, a
      // listing, a metadata read, none of which the store retries on its own. Two clients mean two `GoogleAuth`
      // instances: lazy, so the first download makes a second token fetch, and a second hourly refresh follows.
      readClient = new GcsClient({ ...settings, retryOptions: { autoRetry: false } });
    }
    const shared = {
      storage: this.client,
      readStorage: readClient,
      bucket: options.bucket,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    };
    this.storage = new GcsStorageDriver({
      ...shared,
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.simpleUploadThresholdBytes === undefined
        ? {}
        : { simpleUploadThresholdBytes: options.simpleUploadThresholdBytes }),
    });
    this.registry = new GcsRegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    brandAsBackend(this);
  }
}
