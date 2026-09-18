/**
 * `@cloudbitmaps/s3` — S3 and every S3-compatible service — Cloudflare R2, MinIO, Ceph, Wasabi, Backblaze B2.
 *
 * One package per storage SERVICE, with `@aws-sdk/client-s3` as a real dependency. Install it alongside a
 * flavor package and wire the backend in one line:
 *
 * ```ts
 * import { CloudRoaring } from '@cloudbitmaps/roaring';
 * import { S3Storage } from '@cloudbitmaps/s3';
 *
 * const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'cr' }) });
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
export { S3StorageDriver } from './storage';
export type { S3StorageDriverOptions } from './storage';
export { S3RegistryDriver } from './registry';
export type { S3RegistryDriverOptions } from './registry';
export { S3Storage } from './backend';
export type { S3StorageOptions } from './backend';
