/**
 * The two SDK-free backends, each as one object: `MemoryStorage` and `LocalFsStorage`.
 *
 * These live in the main entry rather than on a subpath because neither needs a cloud SDK — there is nothing
 * to keep out of the bundle, and it keeps the first five minutes to a single import. Their cloud siblings
 * (`S3Storage`, `GcsStorage`, `AzureBlobStorage`) live beside their drivers on the subpaths, for the opposite
 * reason.
 *
 * Each one exists to state a location **once**. See {@link StorageBackend} for why that is worth a class.
 */
import type { IRegistryDriver, IStorageDriver, StorageBackend } from '@/core/ports';
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
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(options: MemoryStorageOptions = {}) {
    this.storage = new MemoryStorageDriver();
    this.registry = new MemoryRegistryDriver(options.now === undefined ? {} : { now: options.now });
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
 * The layout is stated here rather than by the caller, which is the point — the two halves used to be two
 * paths a caller wrote out separately, and nothing stopped them naming different roots. It is also the layout
 * the `export-segments` CLI expects, so a store built this way can be ejected without being told where to look.
 */
export class LocalFsStorage implements StorageBackend {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(
    readonly root: string,
    options: LocalFsStorageOptions = {},
  ) {
    this.storage = new LocalFsStorageDriver(`${root}/storage`);
    this.registry = new LocalFsRegistryDriver(
      `${root}/registry`,
      options.now === undefined ? {} : { now: options.now },
    );
  }
}
