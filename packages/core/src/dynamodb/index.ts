/**
 * `cloud-roaring/dynamodb` — the DynamoDB driver subpath entry (warm tier Phase 4a, registry Phase 4c).
 *
 * Kept out of the main entry so the core package stays SDK-free: `@aws-sdk/client-dynamodb` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { DynamoDbWarmDriver, DynamoDbRegistryDriver } from 'cloud-roaring/dynamodb';
 * ```
 */
export { DynamoDbWarmDriver } from '../drivers/dynamodb/warm';
export type { DynamoDbWarmDriverOptions } from '../drivers/dynamodb/warm';
export { DynamoDbRegistryDriver } from '../drivers/dynamodb/registry';
export type { DynamoDbRegistryDriverOptions } from '../drivers/dynamodb/registry';
