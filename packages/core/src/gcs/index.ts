/**
 * `@cloudbitmaps/core/gcs` — the Google Cloud Storage driver subpath entry: the storage tier AND the registry.
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@google-cloud/storage` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { GcsStorageDriver, GcsRegistryDriver } from '@cloudbitmaps/roaring/gcs';
 * ```
 */
export { GcsStorageDriver } from '../drivers/gcs/storage';
export type { GcsStorageDriverOptions } from '../drivers/gcs/storage';
export { GcsRegistryDriver } from '../drivers/gcs/registry';
export type { GcsRegistryDriverOptions } from '../drivers/gcs/registry';
export { GcsStorage } from '../drivers/gcs/backend';
export type { GcsStorageOptions } from '../drivers/gcs/backend';
