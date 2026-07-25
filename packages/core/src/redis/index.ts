/**
 * `cloud-roaring/redis` — the Redis warm-tier driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `ioredis` is an **optional
 * peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { RedisWarmDriver } from 'cloud-roaring/redis';
 * ```
 */
export { RedisWarmDriver } from '../drivers/redis/warm';
export type { RedisWarmDriverOptions } from '../drivers/redis/warm';
