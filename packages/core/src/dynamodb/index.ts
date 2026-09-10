/**
 * `@cloudbitmaps/core/dynamodb` — the DynamoDB registry driver subpath entry.
 *
 * Kept out of the main entry so the core package stays SDK-free: `@aws-sdk/client-dynamodb` is an
 * **optional peerDependency** that only consumers of this subpath install. Import as:
 *
 * ```ts
 * import { DynamoDbRegistryDriver } from '@cloudbitmaps/roaring/dynamodb';
 * ```
 */
export { DynamoDbRegistryDriver } from '../drivers/dynamodb/registry';
export type { DynamoDbRegistryDriverOptions } from '../drivers/dynamodb/registry';
