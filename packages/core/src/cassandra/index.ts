/**
 * `cloud-roaring/cassandra` — the Cassandra / ScyllaDB warm-tier driver subpath entry (Phase 7).
 *
 * Kept out of the main entry point so the core package stays SDK-free: `cassandra-driver` is an **optional
 * peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { CassandraWarmDriver, cassandraWarmTableDDL } from 'cloud-roaring/cassandra';
 * ```
 */
export { CassandraWarmDriver, cassandraWarmTableDDL } from '../drivers/cassandra/warm';
export type { CassandraWarmDriverOptions } from '../drivers/cassandra/warm';
