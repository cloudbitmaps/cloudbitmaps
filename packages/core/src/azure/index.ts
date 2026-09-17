/**
 * `@cloudbitmaps/core/azure` — the Azure Blob driver subpath entry: the storage tier AND the registry.
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@azure/storage-blob` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { AzureBlobStorageDriver, AzureBlobRegistryDriver } from '@cloudbitmaps/roaring/azure';
 * ```
 */
export { AzureBlobStorageDriver } from '../drivers/azure/storage';
export type { AzureBlobStorageDriverOptions } from '../drivers/azure/storage';
export { AzureBlobRegistryDriver } from '../drivers/azure/registry';
export type { AzureBlobRegistryDriverOptions } from '../drivers/azure/registry';
