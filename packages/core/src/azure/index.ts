/**
 * `@cloudbitmaps/core/azure` — the Azure Blob Storage driver subpath entry: cold storage AND the registry.
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@azure/storage-blob` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { AzureBlobColdDriver, AzureBlobRegistryDriver } from '@cloudbitmaps/roaring/azure';
 * ```
 */
export { AzureBlobColdDriver } from '../drivers/azure/cold';
export type { AzureBlobColdDriverOptions } from '../drivers/azure/cold';
export { AzureBlobRegistryDriver } from '../drivers/azure/registry';
export type { AzureBlobRegistryDriverOptions } from '../drivers/azure/registry';
