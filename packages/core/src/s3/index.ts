/**
 * `cloud-roaring/s3` — the S3 cold-storage driver subpath entry (Phase 3c).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@aws-sdk/client-s3` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { S3ColdDriver } from 'cloud-roaring/s3';
 * ```
 */
export { S3ColdDriver } from '../drivers/s3/cold';
export type { S3ColdDriverOptions } from '../drivers/s3/cold';
export { S3RegistryDriver } from '../drivers/s3/registry';
export type { S3RegistryDriverOptions } from '../drivers/s3/registry';
