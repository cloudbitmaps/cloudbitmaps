import {
  STORAGE_BACKEND,
  ValidationError,
  brandAsBackend,
  normalizeObjectPrefix,
  prefixPart,
  refuseUnknownOptions,
} from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  LifecycleVerdict,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { defined } from './defined';
import { AzureBlobStorageDriver } from './storage';
import { AzureBlobRegistryDriver } from './registry';

/**
 * What {@link AzureBlobStorage} takes: a `containerClient`, or a `connectionString` and a `container` to build one,
 * never both.
 */
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
   * Largest blob the backend will write and advertise. Default = `blockBytes × 50,000` (≈ 390 GiB at the default
   * 8 MiB block) — the honest ceiling reachable within Azure's 50,000-block limit. Set it higher and
   * `blockBytes` auto-grows so 50,000 blocks still cover it (raising peak write memory to ~one block).
   * Must be a positive safe integer.
   */
  readonly maxObjectBytes?: number;
  /** Staged block size in bytes (default 8 MiB). Tunes peak write memory. Must be a positive safe integer. */
  readonly blockBytes?: number;
  /**
   * How long each read request either half sends may take, in ms, its response body included, before it is aborted
   * and throws `TransientError` for the store's read retry: a range read, a tail read's properties and its ranged
   * download, each on its own, and a registry row's read. The clock starts at the call into the SDK, so time waiting
   * for a socket or a credential's token counts. Writes, deletes and listings are not timed. `0`, the default, sets no
   * timeout; an integer from 0 to 2,147,483,647.
   */
  readonly readTimeoutMs?: number;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Whether the service applies `ifMatch` on a Delete Blob, which both halves rely on when it is on: the registry
   * removes a deleted row for good rather than leaving a tombstone a full listing reads forever, and the storage half
   * removes an erasure's holder only while it is the blob the erasure searched, by its ETag. Defaults to `true`: Azure
   * Blob applies it, and Azurite does too.
   */
  readonly conditionalDelete?: boolean;
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
  'readTimeoutMs',
  'now',
  'conditionalDelete',
] as const;

/**
 * `AzureBlobStorage` — the Azure Blob backend as one object: generations and pointer, one container, stated once.
 *
 * See {@link StorageBackend} for why the two halves are configured together rather than separately.
 *
 * Azure's shape differs from S3's and GCS's in one way worth knowing: the unit both halves share is a
 * **container client**, not an account client plus a container name, because a `ContainerClient` is already
 * scoped. Supply `containerClient` directly, or give a `connectionString` + `container` and one is built.
 */
export class AzureBlobStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The container client both halves share — built here unless one was supplied. */
  readonly containerClient: ContainerClient;
  /** The blob-name prefix every object sits under: `''`, or `trimmed/`. */
  private readonly keyPrefix: string;

  /**
   * Builds the Azure Blob backend over one container: pass `containerClient`, or `connectionString` with `container`,
   * not both. `prefix` puts every object under a blob-name prefix. Throws `ValidationError` for an unknown option, a `now`
   * that is not a function, `containerClient` beside `connectionString` or `container`, neither `containerClient` nor
   * both `connectionString` and `container`, or an invalid `prefix` or `readTimeoutMs`.
   */
  constructor(options: AzureBlobStorageOptions) {
    refuseUnknownOptions(
      'AzureBlobStorage',
      options,
      AZURE_BLOB_STORAGE_OPTION_KEYS,
      'a container client goes in `containerClient`',
    );
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new ValidationError(
        "AzureBlobStorage's `now` must be a function that returns epoch milliseconds",
      );
    }
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
    this.keyPrefix = prefixPart(normalizeObjectPrefix(options.prefix));
    const shared = {
      containerClient: this.containerClient,
      ...defined({ prefix: options.prefix, readTimeoutMs: options.readTimeoutMs }),
    };
    this.storage = new AzureBlobStorageDriver({
      ...shared,
      ...defined({
        maxObjectBytes: options.maxObjectBytes,
        blockBytes: options.blockBytes,
        conditionalDelete: options.conditionalDelete,
      }),
    });
    this.registry = new AzureBlobRegistryDriver({
      ...shared,
      ...defined({ now: options.now, conditionalDelete: options.conditionalDelete }),
    });
    brandAsBackend(this);
  }

  /**
   * Always `unchecked`, and makes no request: an Azure storage account's lifecycle management policy belongs to the
   * management plane (Azure Resource Manager), which a blob client's credentials do not reach, and the package takes
   * no management SDK for it. The `detail` says how to read the policy by hand. Never rejects.
   */
  checkLifecycle(): Promise<LifecycleVerdict> {
    const scope = `${this.containerClient.containerName}/${this.keyPrefix}`;
    return Promise.resolve({
      status: 'unchecked',
      detail:
        'Azure lifecycle management policies are set on the storage account, outside what a blob client can read. ' +
        'Check by hand: `az storage account management-policy show --account-name <account> --resource-group <group>`, ' +
        'and confirm that every enabled rule with a baseBlob delete or tierToArchive action either has a blobIndexMatch ' +
        `filter or has a prefixMatch that overlaps nothing in ${JSON.stringify(scope)} (a prefixMatch overlaps it when ` +
        'one is a prefix of the other; a rule with no prefixMatch applies to every blob in the account, so it overlaps).',
    });
  }
}
