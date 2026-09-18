/**
 * `@cloudbitmaps/azure-blob` — Azure Blob Storage.
 *
 * One package per storage SERVICE, with `@azure/storage-blob` as a real dependency. Install it alongside a
 * flavor package and wire the backend in one line:
 *
 * ```ts
 * import { CloudRoaring } from '@cloudbitmaps/roaring';
 * import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
 *
 * const store = new CloudRoaring({ storage: new AzureBlobStorage({ bucket: 'bitmaps', prefix: 'cr' }) });
 * ```
 *
 * These drivers move opaque payload bytes, so they are codec-agnostic: the same package serves every
 * flavor. That is why they are a package rather than a subpath of one — as a subpath, each flavor needed a
 * re-export barrel per service, and the count multiplied with every new codec.
 *
 * The engine, the `.crbm` format and the ports live in `@cloudbitmaps/core`, which is a real dependency of
 * THIS package: it lands in your tree without you installing it, and you never name it yourself. What this
 * package builds against is `@cloudbitmaps/core/driver-kit`, the declared contract for a driver — the same
 * surface a third-party driver would use.
 */
export { AzureBlobStorageDriver } from './storage';
export type { AzureBlobStorageDriverOptions } from './storage';
export { AzureBlobRegistryDriver } from './registry';
export type { AzureBlobRegistryDriverOptions } from './registry';
export { AzureBlobStorage } from './backend';
export type { AzureBlobStorageOptions } from './backend';
