/**
 * `DynamoDbWarmDriver` — an {@link IWarmDriver} over DynamoDB (Phase 4a).
 *
 * The production warm tier: real **cross-process** optimistic concurrency via DynamoDB conditional writes
 * (unlike the LocalFs driver's in-process mutex). Each chunk is one item in a **single table** (DECISIONS
 * #15): `PK = ns#…|seg#…`, `SK = chunk#<key>`, with attributes `v` (the OCC token — a monotonic counter),
 * `b` (the delta payload), `del` (tombstone flag). Every mutation is a conditional `UpdateItem` that does
 * the compare-and-set server-side: `ADD v :one` makes the counter strictly increasing and **never reused**,
 * even across delete→recreate (ABA-safe, D3), because a delete *tombstones* (`del=true`, counter advances)
 * rather than removing the item.
 *
 * `@aws-sdk/client-dynamodb` is an **optional peer dependency** (DECISIONS #13) — only consumers of
 * `cloud-roaring/dynamodb` install it; the client is injected. Drivers may use cloud SDKs; only `core/` is
 * SDK-free (lint-enforced).
 */
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  IntegrityError,
  TransientError,
  WriteConflictError,
  isIntegrityError,
} from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type {
  ChunkRef,
  IWarmDriver,
  NoRow,
  SegmentRef,
  Token,
  WarmReadOptions,
  WarmRow,
} from '@/core/ports';
import { isTransient } from './dynamodb-errors';
import {
  assertValidKeyPrefix,
  chunkKeyPair,
  chunkSortKeyPrefix,
  parseChunkSortKey,
  partitionKey,
} from './keys';

export interface DynamoDbWarmDriverOptions {
  /** A constructed DynamoDB client (point its `endpoint` at DynamoDB-Local for tests). */
  readonly client: DynamoDBClient;
  /** The single table holding warm rows (and, in Phase 4b, registry rows). Must already exist. */
  readonly tableName: string;
  /** Optional partition-key prefix so several logical stores can share one table. */
  readonly keyPrefix?: string;
}

// Attribute names are aliased in every expression (defense against DynamoDB reserved words). DynamoDB
// rejects any name placeholder that is declared but unreferenced ("ExpressionAttributeNames unused in
// expressions"), so each command declares ONLY the names its own expressions use — no shared catch-all map.
const MUTATE_NAMES = { '#v': 'v', '#b': 'b', '#del': 'del' } as const; // put/delete expressions
const QUERY_NAMES = { '#pk': 'PK', '#sk': 'SK', '#del': 'del' } as const; // listChunks key + filter
const ONE: AttributeValue = { N: '1' };
const TRUE: AttributeValue = { BOOL: true };
const FALSE: AttributeValue = { BOOL: false };

export class DynamoDbWarmDriver implements IWarmDriver {
  private readonly client: DynamoDBClient;
  private readonly table: string;
  private readonly keyPrefix: string | undefined;

  constructor(options: DynamoDbWarmDriverOptions) {
    assertValidKeyPrefix(options.keyPrefix); // fail fast: a prefix with PK delimiters could alias stores
    this.client = options.client;
    this.table = options.tableName;
    this.keyPrefix = options.keyPrefix;
  }

  async get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    const { pk, sk } = chunkKeyPair(ref, this.keyPrefix);
    let res;
    try {
      res = await this.client.send(
        new GetItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          // Strong by default (the OCC read-modify-write must see the latest committed value); a read path
          // may opt into an eventually-consistent read (~½ RCU) via `warmReadConsistency: 'eventual'` (gap #9).
          ConsistentRead: opts?.consistent ?? true,
        }),
      );
    } catch (err) {
      throw this.mapError(err, ref.chunkKey);
    }
    if (res.Item === undefined || res.Item.del?.BOOL === true) return null;
    return this.rowFrom(res.Item, ref.chunkKey);
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    const { pk, sk } = chunkKeyPair(ref, this.keyPrefix);
    // Create-if-absent (or over a tombstone) vs token-fenced update — both server-side CAS via a condition.
    const command =
      expected === NO_ROW
        ? new UpdateItemCommand({
            TableName: this.table,
            Key: { PK: { S: pk }, SK: { S: sk } },
            ConditionExpression: 'attribute_not_exists(#v) OR #del = :true',
            UpdateExpression: 'ADD #v :one SET #b = :b, #del = :false',
            ExpressionAttributeNames: MUTATE_NAMES,
            ExpressionAttributeValues: {
              ':one': ONE,
              ':b': { B: bytes },
              ':true': TRUE,
              ':false': FALSE,
            },
            ReturnValues: 'UPDATED_NEW',
          })
        : new UpdateItemCommand({
            TableName: this.table,
            Key: { PK: { S: pk }, SK: { S: sk } },
            ConditionExpression: '#v = :expected AND #del = :false',
            UpdateExpression: 'ADD #v :one SET #b = :b',
            ExpressionAttributeNames: MUTATE_NAMES,
            ExpressionAttributeValues: {
              ':expected': { N: expected },
              ':one': ONE,
              ':b': { B: bytes },
              ':false': FALSE,
            },
            ReturnValues: 'UPDATED_NEW',
          });
    try {
      const res = await this.client.send(command);
      const token = res.Attributes?.v?.N;
      if (token === undefined) throw new IntegrityError('DynamoDB UpdateItem returned no token');
      return { token };
    } catch (err) {
      throw this.mapError(err, ref.chunkKey);
    }
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    const { pk, sk } = chunkKeyPair(ref, this.keyPrefix);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          // Tombstone (advance the counter, drop the payload) — keeps the token monotonic for ABA-safety.
          ConditionExpression: '#v = :expected AND #del = :false',
          UpdateExpression: 'ADD #v :one SET #del = :true REMOVE #b',
          ExpressionAttributeNames: MUTATE_NAMES,
          ExpressionAttributeValues: {
            ':expected': { N: expected },
            ':one': ONE,
            ':true': TRUE,
            ':false': FALSE,
          },
        }),
      );
    } catch (err) {
      throw this.mapError(err, ref.chunkKey);
    }
  }

  async *listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow> {
    const pk = partitionKey(ref, this.keyPrefix);
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      let res;
      try {
        res = await this.client.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            FilterExpression: '#del = :false', // exclude tombstones (server-side)
            ExpressionAttributeNames: QUERY_NAMES,
            ExpressionAttributeValues: {
              ':pk': { S: pk },
              ':prefix': { S: chunkSortKeyPrefix() },
              ':false': FALSE,
            },
            ConsistentRead: opts?.consistent ?? true, // strong by default; eventual when a read path opts in (gap #9)
            ExclusiveStartKey: startKey,
          }),
        );
      } catch (err) {
        // -1: a list error isn't scoped to one chunk. The decorator re-enumerates the whole listing on a
        // transient fault, so a mid-pagination blip is survived without re-yielding earlier pages downstream.
        throw this.mapError(err, -1);
      }
      // Query returns items in ascending SK order; zero-padded chunk# ⇒ ascending chunkKey.
      for (const item of res.Items ?? []) {
        const chunkKey = parseChunkSortKey(item.SK?.S ?? '');
        if (chunkKey === null) continue; // a reg#… or foreign row slipped the filter — skip
        yield { chunkKey, ...this.rowFrom(item, chunkKey) };
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  /**
   * Build a {@link WarmRow} from a raw item. Only ever called for a **live** row (callers filter
   * tombstones first), so both `v` and `b` MUST be present — a missing attribute means a corrupt or
   * foreign item, which we reject (untrusted-bytes posture, invariant 5) rather than paper over.
   */
  private rowFrom(item: Record<string, AttributeValue>, chunkKey: number): WarmRow {
    const token = item.v?.N;
    if (token === undefined) {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its token`);
    }
    const bytes = item.b?.B;
    if (bytes === undefined) {
      throw new IntegrityError(`live warm row for chunk ${chunkKey} is missing its payload`);
    }
    return { token, bytes };
  }

  /**
   * Translate a raw SDK/driver error to our typed vocabulary: a failed condition is an OCC conflict; a
   * throttle/5xx/dropped-connection is a (retryable) {@link TransientError}; everything else propagates
   * unchanged. Applied at every `client.send` site so callers (and the retry decorator) only ever see typed
   * errors. Order matters: a conflict is **never** transient (it's deterministic — the engine's OCC loop
   * owns that retry), so it's classified first.
   */
  private mapError(err: unknown, chunkKey: number): unknown {
    if (isIntegrityError(err)) return err;
    // `instanceof` is the primary check; the name fallback covers an SDK that re-wraps the error so the
    // class identity is lost — a conflict must never silently leak as a generic error.
    if (
      err instanceof ConditionalCheckFailedException ||
      (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException'
    ) {
      return new WriteConflictError(`OCC conflict on chunk ${chunkKey}`);
    }
    if (isTransient(err)) {
      return new TransientError(
        `transient DynamoDB fault on chunk ${chunkKey}: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}
