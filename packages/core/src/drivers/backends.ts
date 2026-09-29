/**
 * The two SDK-free backends, each as one object: `MemoryStorage` and `LocalFsStorage`.
 *
 * These live in the main entry because neither needs a cloud SDK — there is nothing to keep out of the
 * install, and it keeps the first five minutes to a single import. Their cloud siblings (`S3Storage`,
 * `GcsStorage`, `AzureBlobStorage`) ship in `@cloudbitmaps/s3`, `/gcs` and `/azure-blob` for the opposite
 * reason: each carries an SDK nobody should install for a service they do not use.
 *
 * Each one exists to state a location **once**. See {@link StorageBackend} for why that is worth a class.
 */
import { join } from 'node:path';
import { brandAsBackend, STORAGE_BACKEND } from '@/core/ports';
import type { StorageBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from './memory';
import { LocalFsStorageDriver } from './localfs/storage';
import { LocalFsRegistryDriver } from './localfs/registry';

export interface MemoryStorageOptions {
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * An in-process backend — nothing to install, nothing to clean up, and it disappears with the process.
 *
 * This is the one to reach for in tests and in the first five minutes. It is **not** a cache in front of
 * anything: it is the whole store, held in RAM, so a restart is a data loss.
 */
export class MemoryStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: MemoryStorageDriver;
  readonly registry: MemoryRegistryDriver;

  constructor(options: MemoryStorageOptions = {}) {
    this.storage = new MemoryStorageDriver();
    this.registry = new MemoryRegistryDriver(options.now === undefined ? {} : { now: options.now });
    brandAsBackend(this);
  }
}

export interface LocalFsStorageOptions {
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A local-filesystem backend rooted at one directory: generations under `<root>/storage`, pointers under
 * `<root>/registry`.
 *
 * The layout is stated here rather than by the caller, which is the point — two paths a caller wrote out
 * separately could name different roots, and nothing would stop them. It is also the layout
 * the `export-segments` CLI expects, so a store built this way can be ejected without being told where to look.
 */
export class LocalFsStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: LocalFsStorageDriver;
  readonly registry: LocalFsRegistryDriver;

  constructor(
    readonly root: string,
    options: LocalFsStorageOptions = {},
  ) {
    this.storage = new LocalFsStorageDriver(join(root, 'storage'));
    this.registry = new LocalFsRegistryDriver(
      join(root, 'registry'),
      options.now === undefined ? {} : { now: options.now },
    );
    brandAsBackend(this);
  }
}
