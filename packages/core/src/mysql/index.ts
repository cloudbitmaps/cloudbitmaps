/**
 * `cloud-roaring/mysql` — the MySQL / MariaDB warm-tier driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `mysql2` is an **optional
 * peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { MysqlWarmDriver, mysqlWarmTableDDL } from 'cloud-roaring/mysql';
 * ```
 */
export { MysqlWarmDriver, mysqlWarmTableDDL } from '../drivers/mysql/warm';
export type { MysqlWarmDriverOptions } from '../drivers/mysql/warm';
