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
  /** A constructed `@google-cloud/storage` client. One is built from the ambient credentials when absent. */
  readonly client?: GcsClient;
  /** Project id for the client built when `client` is absent. Falls back to the SDK's own resolution. */
  readonly projectId?: string;
  /** Endpoint override — point it at fake-gcs-server locally. Ignored when `client` is supplied. */
  readonly apiEndpoint?: string;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The keys `new GcsStorage(options)` takes. Any other is refused by name rather than ignored: an ignored client key
 * — `storage`, as `GcsStorageDriver` calls it — falls back to ambient credentials and the **public** endpoint, and
 * for a client pointed at an emulator that is production traffic from a wiring typo.
 */
export const GCS_STORAGE_OPTION_KEYS = [
  'bucket',
  'prefix',
  'client',
  'projectId',
  'apiEndpoint',
  'now',
] as const;

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
    refuseUnknown(
      'GcsStorage',
      options,
      GCS_STORAGE_OPTION_KEYS,
      'a @google-cloud/storage client goes in `client`',
    );
    this.client =
      options.client ??
      new GcsClient({
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
      });
    const shared = {
      storage: this.client,
      bucket: options.bucket,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.storage = new GcsStorageDriver(shared);
    this.registry = new GcsRegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    brandAsBackend(this);
  }
}
