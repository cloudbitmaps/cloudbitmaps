/**
 * `cloud-roaring/gcs` — the Google Cloud Storage cold-storage driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `@google-cloud/storage` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { GcsColdDriver } from 'cloud-roaring/gcs';
 * ```
 */
export { GcsColdDriver } from '../drivers/gcs/cold';
export type { GcsColdDriverOptions } from '../drivers/gcs/cold';
