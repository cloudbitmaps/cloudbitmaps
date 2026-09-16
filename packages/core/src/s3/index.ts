/**
 * `@cloudbitmaps/core/s3` — the S3 storage driver subpath entry.
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@aws-sdk/client-s3` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { S3StorageDriver } from '@cloudbitmaps/roaring/s3';
 * ```
 */
export { S3StorageDriver } from '../drivers/s3/storage';
export type { S3StorageDriverOptions } from '../drivers/s3/storage';
export { S3RegistryDriver } from '../drivers/s3/registry';
export type { S3RegistryDriverOptions } from '../drivers/s3/registry';
