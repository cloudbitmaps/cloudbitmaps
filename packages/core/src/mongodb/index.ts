/**
 * `cloud-roaring/mongodb` — the MongoDB / DocumentDB warm-tier driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `mongodb` is an **optional
 * peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { MongoWarmDriver, ensureMongoWarmIndexes } from 'cloud-roaring/mongodb';
 * ```
 */
export { MongoWarmDriver, ensureMongoWarmIndexes } from '../drivers/mongodb/warm';
export type { MongoWarmDriverOptions } from '../drivers/mongodb/warm';
