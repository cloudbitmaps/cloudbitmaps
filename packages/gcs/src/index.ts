/**
 * `@cloudbitmaps/gcs` — Google Cloud Storage.
 *
 * One package per storage SERVICE, with `@google-cloud/storage` as a real dependency. Install it alongside a
 * flavor package and wire the backend in one line:
 *
 * ```ts
 * import { CloudRoaring } from '@cloudbitmaps/roaring';
 * import { GcsStorage } from '@cloudbitmaps/gcs';
 *
 * const store = new CloudRoaring({ storage: new GcsStorage({ bucket: 'bitmaps', prefix: 'cr' }) });
 * ```
 *
 * These drivers move opaque payload bytes, so they are codec-agnostic: the same package serves every
 * flavor. That is why they are a package rather than a subpath of one — as a subpath, each flavor needed a
 * re-export barrel per service, and the count multiplied with every new codec.
 *
 * The engine, the `.crbm` format and the ports live in `@cloudbitmaps/core`, which arrives transitively and
 * is never installed directly. This package builds against `@cloudbitmaps/core/driver-kit`, the declared
 * contract for a driver — the same surface a third-party driver would use.
 */
export { GcsStorageDriver } from './storage';
export type { GcsStorageDriverOptions } from './storage';
export { GcsRegistryDriver } from './registry';
export type { GcsRegistryDriverOptions } from './registry';
export { GcsStorage } from './backend';
export type { GcsStorageOptions } from './backend';
