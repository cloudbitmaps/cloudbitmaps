/**
 * `GcsStorage` — the Google Cloud Storage backend as one object: generations and pointer, one bucket, stated once.
 *
 * See {@link StorageBackend} for why the two halves are configured together rather than separately.
 *
 * **A note on the word.** `@google-cloud/storage` names its own client class `Storage`, so the driver option
 * that takes it is also called `storage` — which, since our durable tier is now called storage too, reads as
 * the same word meaning two things. That is why this class builds the client itself: `new GcsStorage({ bucket })`
 * never makes you write `{ storage: storage }`. Supply `client` when you need your own.
 */
import { Storage as GcsClient } from '@google-cloud/storage';
import type { IRegistryDriver, IStorageDriver, StorageBackend } from '@/core/ports';
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

export class GcsStorage implements StorageBackend {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: GcsClient;

  constructor(options: GcsStorageOptions) {
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
  }
}
