/**
 * `cloud-roaring/postgres` — the PostgreSQL warm-tier driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `pg` is an **optional peerDependency**
 * that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { PostgresWarmDriver, postgresWarmTableDDL } from 'cloud-roaring/postgres';
 * ```
 */
export { PostgresWarmDriver, postgresWarmTableDDL } from '../drivers/postgres/warm';
export type { PostgresWarmDriverOptions } from '../drivers/postgres/warm';
