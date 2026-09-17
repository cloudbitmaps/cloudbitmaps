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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '@/core/errors';
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
 *
 * **It refuses a store written before the tier was renamed**, because the alternative is much worse than an
 * error. Such a store keeps its generations in `<root>/cold`, where this class does not look, so the registry
 * half resolves a pointer the storage half cannot satisfy — and the store reports
 * `missing-storage-generation`, which is the signature of a **torn restore**. The runbook's remedies for that
 * include rolling `currentGen` back, which is destructive and would be applied to a store that was never
 * damaged. One `existsSync` at wiring time is a cheap price for not sending someone down that path.
 */
export class LocalFsStorage implements StorageBackend {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;

  constructor(
    readonly root: string,
    options: LocalFsStorageOptions = {},
  ) {
    if (!existsSync(join(root, 'storage')) && existsSync(join(root, 'cold'))) {
      throw new ValidationError(
        `${root} holds a "cold/" directory but no "storage/" — this store was written before the tier was ` +
          `renamed. Rename it (\`mv ${root}/cold ${root}/storage\`) and re-run; the objects inside are ` +
          `unchanged. Do NOT treat the "missing-storage-generation" you would otherwise see as a torn ` +
          `restore — the data is intact, it is the path that moved.`,
      );
    }
    this.storage = new LocalFsStorageDriver(join(root, 'storage'));
    this.registry = new LocalFsRegistryDriver(
      join(root, 'registry'),
      options.now === undefined ? {} : { now: options.now },
    );
  }
}
