/**
 * `cloud-roaring/azure` — the Azure Blob Storage cold-storage driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@azure/storage-blob` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { AzureBlobColdDriver } from 'cloud-roaring/azure';
 * ```
 */
export { AzureBlobColdDriver } from '../drivers/azure/cold';
export type { AzureBlobColdDriverOptions } from '../drivers/azure/cold';
