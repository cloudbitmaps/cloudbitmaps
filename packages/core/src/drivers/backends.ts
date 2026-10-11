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
import type { IRegistryDriver, IStorageDriver, StorageBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from './memory';
import { LocalFsStorageDriver } from './localfs/storage';
import { LocalFsRegistryDriver } from './localfs/registry';
import { checkNow, refuseUnknownOptions } from './_shared/options';
import { ValidationError } from '@/core/errors';

const CLOCK_OPTION_KEYS = ['now'] as const;

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
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(options: MemoryStorageOptions = {}) {
    refuseUnknownOptions('MemoryStorage', options, CLOCK_OPTION_KEYS);
    checkNow('MemoryStorage', options.now);
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
 *
 * A root is for **one process**. Every instance in a process that names the same root shares one lock per
 * registry row, however the root is spelled (relative path, symlink), so they cannot both advance a row from
 * one token. Two processes on one root are **not** fenced from each other.
 */
export class LocalFsStorage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(
    readonly root: string,
    options: LocalFsStorageOptions = {},
  ) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new ValidationError(
        `LocalFsStorage needs a root directory: a non-empty string, got ${root === '' ? 'an empty string' : typeof root}`,
      );
    }
    refuseUnknownOptions('LocalFsStorage', options, CLOCK_OPTION_KEYS);
    checkNow('LocalFsStorage', options.now);
    this.storage = new LocalFsStorageDriver(join(root, 'storage'), { privateRoot: root });
    this.registry = new LocalFsRegistryDriver(
      join(root, 'registry'),
      options.now === undefined ? { privateRoot: root } : { now: options.now, privateRoot: root },
    );
    brandAsBackend(this);
  }
}
