/**
 * `AzureBlobStorage` — the Azure Blob backend as one object: generations and pointer, one container, stated once.
 *
 * See {@link StorageBackend} for why the two halves are configured together rather than separately.
 *
 * Azure's shape differs from S3's and GCS's in one way worth knowing: the unit both halves share is a
 * **container client**, not an account client plus a container name, because a `ContainerClient` is already
 * scoped. Supply `containerClient` directly, or give a `connectionString` + `container` and one is built.
 */
import { STORAGE_BACKEND, ValidationError, brandAsBackend } from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
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
  /**
   * Largest blob the backend will write and advertise. Default = `blockBytes × 50,000` (≈ 400 GiB at the default
   * 8 MiB block) — the honest ceiling reachable within Azure's 50,000-block limit. Set it higher and
   * `blockBytes` auto-grows so 50,000 blocks still cover it (raising peak write memory to ~one block).
   * Must be a positive safe integer.
   */
  readonly maxObjectBytes?: number;
  /** Staged block size in bytes (default 8 MiB). Tunes peak write memory. Must be a positive safe integer. */
  readonly blockBytes?: number;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The keys `new AzureBlobStorage(options)` takes. Any other is refused by name rather than ignored: an ignored
 * client key leaves the backend without the container the caller meant.
 */
export const AZURE_BLOB_STORAGE_OPTION_KEYS = [
  'containerClient',
  'connectionString',
  'container',
  'prefix',
  'maxObjectBytes',
  'blockBytes',
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

export class AzureBlobStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The container client both halves share — built here unless one was supplied. */
  readonly containerClient: ContainerClient;

  constructor(options: AzureBlobStorageOptions) {
    refuseUnknown(
      'AzureBlobStorage',
      options,
      AZURE_BLOB_STORAGE_OPTION_KEYS,
      'a container client goes in `containerClient`',
    );
    if (options.containerClient !== undefined && options.containerClient !== null) {
      // `containerClient` already names the account AND the container, so anything that also names them is
      // either redundant or a contradiction — and the contradiction loses silently, leaving a store pointed
      // at a container the caller did not ask for. Refuse instead of picking one.
      if (options.connectionString !== undefined || options.container !== undefined) {
        throw new ValidationError(
          'AzureBlobStorage takes `containerClient` OR `connectionString` + `container`, not both — ' +
            'the `containerClient` already determines the account and container',
        );
      }
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
    this.storage = new AzureBlobStorageDriver({
      ...shared,
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.blockBytes === undefined ? {} : { blockBytes: options.blockBytes }),
    });
    this.registry = new AzureBlobRegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    brandAsBackend(this);
  }
}
