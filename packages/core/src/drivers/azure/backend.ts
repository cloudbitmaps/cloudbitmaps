/**
 * `AzureBlobStorage` — the Azure Blob backend as one object: generations and pointer, one container, stated once.
 *
 * See {@link StorageBackend} for why the two halves are configured together rather than separately.
 *
 * Azure's shape differs from S3's and GCS's in one way worth knowing: the unit both halves share is a
 * **container client**, not an account client plus a container name, because a `ContainerClient` is already
 * scoped. Supply `containerClient` directly, or give a `connectionString` + `container` and one is built.
 */
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { IRegistryDriver, IStorageDriver, StorageBackend } from '@/core/ports';
import { ValidationError } from '@/core/errors';
import { AzureBlobStorageDriver } from './storage';
import { AzureBlobRegistryDriver } from './registry';

export interface AzureBlobStorageOptions {
  /** A container-scoped client. Supply this, or `connectionString` + `container`. */
  readonly containerClient?: ContainerClient;
  /** Account connection string, used with `container` when `containerClient` is absent. */
  readonly connectionString?: string;
  /** Container name, used with `connectionString` when `containerClient` is absent. */
  readonly container?: string;
  /** Optional blob-name prefix under which everything lives — generations and the registry alike. */
  readonly prefix?: string;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class AzureBlobStorage implements StorageBackend {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The container client both halves share — built here unless one was supplied. */
  readonly containerClient: ContainerClient;

  constructor(options: AzureBlobStorageOptions) {
    if (options.containerClient !== undefined) {
      this.containerClient = options.containerClient;
    } else if (options.connectionString !== undefined && options.container !== undefined) {
      this.containerClient = BlobServiceClient.fromConnectionString(
        options.connectionString,
      ).getContainerClient(options.container);
    } else {
      // Fail here rather than at the first read: a half-specified backend is a wiring mistake, and the
      // alternative is a store that constructs fine and then cannot say why it has nothing in it.
      throw new ValidationError(
        'AzureBlobStorage needs either `containerClient`, or both `connectionString` and `container`',
      );
    }
    const shared = {
      containerClient: this.containerClient,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.storage = new AzureBlobStorageDriver(shared);
    this.registry = new AzureBlobRegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
}
