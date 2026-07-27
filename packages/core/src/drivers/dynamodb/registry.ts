/**
 * `DynamoDbRegistryDriver` — an {@link IRegistryDriver} over DynamoDB (Phase 4c).
 *
 * One item per segment, **co-located with that segment's warm rows** in the single table (DECISIONS #15):
 * `PK = ns#…|seg#…`, `SK = reg#`. OCC mirrors the warm tier — a conditional `UpdateItem` with `ADD v :one`
 * gives a monotonic, never-reused token; a delete **tombstones** (`del=true`, counter advances) so a
 * recreate's token is always greater (ABA-safe). The record body is stored as a JSON string (`r`); the OCC
 * token is the counter `v` (so the body never has to encode its own token).
 *
 * `compareAndSwap` is a read-merge-conditional-write: it fetches the current body to apply the caller's
 * `patch`, then writes under `#v = :expected` — so a concurrent change between the read and the write fails
 * the condition (no lost update), exactly like the engine's chunk OCC.
 *
 * `list` is a `Scan` with a `reg#` filter (discovery is infrequent — the compaction daemon, Phase 4d). On a
 * large shared table that reads every partition; a namespace-keyed GSI is the scale-up, deferred until a
 * deployment needs it (YAGNI). `@aws-sdk/client-dynamodb` is an optional peer dependency (DECISIONS #13).
 */
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  ScanCommand,
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
import type {
  IRegistryDriver,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
} from '@/core/ports';
import {
  applyRegistryPatch,
  assertRegistrySchemaVersion,
  assertStoredRecordShape,
  recordFromNew,
  REGISTRY_SCHEMA_VERSION,
  validateNewRegistryRecord,
  validateRegistryPatch,
} from '../_shared/registry';
import { isTransient } from './dynamodb-errors';
import { assertValidKeyPrefix, partitionKey, registryKeyPair, registrySortKey } from './keys';

// Only the names each command's expressions reference (DynamoDB rejects unused declared placeholders).
const MUTATE_NAMES = { '#v': 'v', '#r': 'r', '#del': 'del' } as const;
const SCAN_NAMES = { '#sk': 'SK', '#del': 'del', '#pk': 'PK' } as const;
const ONE: AttributeValue = { N: '1' };
const TRUE: AttributeValue = { BOOL: true };
const FALSE: AttributeValue = { BOOL: false };

export interface DynamoDbRegistryDriverOptions {
  readonly client: DynamoDBClient;
  /** The single table holding warm + registry rows. Must already exist. */
  readonly tableName: string;
  /** Optional partition-key prefix so several logical stores can share one table. */
  readonly keyPrefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class DynamoDbRegistryDriver implements IRegistryDriver {
  private readonly client: DynamoDBClient;
  private readonly table: string;
  private readonly keyPrefix: string | undefined;
  private readonly now: () => number;

  constructor(options: DynamoDbRegistryDriverOptions) {
    assertValidKeyPrefix(options.keyPrefix);
    this.client = options.client;
    this.table = options.tableName;
    this.keyPrefix = options.keyPrefix;
    this.now = options.now ?? (() => Date.now());
  }

  capabilities(): RegCaps {
    return { strongRead: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    const { pk, sk } = registryKeyPair(ref, this.keyPrefix);
    let res;
    try {
      res = await this.client.send(
        new GetItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          ConsistentRead: true, // currentGen feeds correctness — must be the latest committed value
        }),
      );
    } catch (err) {
      throw this.mapError(err, ref);
    }
    if (res.Item === undefined || res.Item.del?.BOOL === true) return null;
    return rowToRecord(res.Item, ref);
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    validateNewRegistryRecord(record);
    const { pk, sk } = registryKeyPair(ref, this.keyPrefix);
    const now = this.now();
    const body = serializeBody(recordFromNew(ref, record, now, '')); // token derived from `v`, not stored
    try {
      const res = await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          ConditionExpression: 'attribute_not_exists(#v) OR #del = :true',
          UpdateExpression: 'ADD #v :one SET #r = :r, #del = :false',
          ExpressionAttributeNames: MUTATE_NAMES,
          ExpressionAttributeValues: {
            ':one': ONE,
            ':r': { S: body },
            ':true': TRUE,
            ':false': FALSE,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return { token: tokenOf(res.Attributes) };
    } catch (err) {
      throw this.mapError(err, ref, 'already exists');
    }
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    validateRegistryPatch(patch);
    const current = await this.get(ref); // fetch the body to merge; the conditional write fences concurrency
    if (current === null || current.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    const { pk, sk } = registryKeyPair(ref, this.keyPrefix);
    const body = serializeBody(applyRegistryPatch(current, patch, this.now(), ''));
    try {
      const res = await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          ConditionExpression: '#v = :expected AND #del = :false',
          UpdateExpression: 'ADD #v :one SET #r = :r',
          ExpressionAttributeNames: MUTATE_NAMES,
          ExpressionAttributeValues: {
            ':expected': { N: expected },
            ':one': ONE,
            ':r': { S: body },
            ':false': FALSE,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return { token: tokenOf(res.Attributes) };
    } catch (err) {
      throw this.mapError(err, ref);
    }
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    const filter = ['#sk = :reg', '#del = :false'];
    const values: Record<string, AttributeValue> = {
      ':reg': { S: registrySortKey() },
      ':false': FALSE,
    };
    // Scope by namespace (and/or this store's keyPrefix) via a PK begins_with — items still scanned, filtered.
    const pkPrefix = this.scanPkPrefix(namespace);
    if (pkPrefix !== undefined) {
      filter.push('begins_with(#pk, :pk)');
      values[':pk'] = { S: pkPrefix };
    }
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      let res;
      try {
        res = await this.client.send(
          new ScanCommand({
            TableName: this.table,
            FilterExpression: filter.join(' AND '),
            ExpressionAttributeNames:
              pkPrefix !== undefined ? SCAN_NAMES : { '#sk': 'SK', '#del': 'del' },
            ExpressionAttributeValues: values,
            ExclusiveStartKey: startKey,
            // Strong, to match `get()` on the same table. A Scan defaults to eventually consistent, and every
            // caller here treats the result as the COMPLETE segment set: `eraseSubject` builds its erasure
            // ledger from it (a segment registered seconds earlier would be silently absent — a GDPR Art. 17
            // miss with no error), `subjectReport` answers Art. 15 from it, and `runExport` writes its
            // manifest from it (a missed segment lands in neither the manifest nor `failed[]`, so "a manifest
            // exists ⇒ the run finished" would be false). `runConsistencyCheck` already re-read each row
            // strongly for exactly this reason; this makes the enumeration itself trustworthy instead.
            // Doubles this Scan's RCU cost, which is the correct trade for a correctness-critical enumeration.
            ConsistentRead: true,
          }),
        );
      } catch (err) {
        throw this.mapError(err);
      }
      for (const item of res.Items ?? []) {
        yield rowToRecord(item, namespaceOf(item));
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  async delete(ref: SegmentRef): Promise<void> {
    const { pk, sk } = registryKeyPair(ref, this.keyPrefix);
    // Tombstone (advance the counter, drop the body) — idempotent, and keeps the token monotonic (ABA-safe).
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { PK: { S: pk }, SK: { S: sk } },
          UpdateExpression: 'ADD #v :one SET #del = :true REMOVE #r',
          ExpressionAttributeNames: MUTATE_NAMES,
          ExpressionAttributeValues: { ':one': ONE, ':true': TRUE },
        }),
      );
    } catch (err) {
      throw this.mapError(err, ref);
    }
  }

  /** The PK prefix to scope a `list` scan, or `undefined` for an unscoped scan (no namespace, no keyPrefix). */
  private scanPkPrefix(namespace: string | undefined): string | undefined {
    if (namespace !== undefined) {
      // partitionKey for a sentinel segment, minus the segment, gives the `…|seg#` prefix shared by the ns.
      const full = partitionKey({ namespace, segment: 'x' }, this.keyPrefix);
      return full.slice(0, full.length - 'x'.length);
    }
    return this.keyPrefix !== undefined ? `${this.keyPrefix}|` : undefined;
  }

  /** Map a raw SDK error to the typed vocabulary (conflict / transient / passthrough). */
  private mapError(err: unknown, ref?: SegmentRef, conflictHint = 'OCC token mismatch'): unknown {
    if (isIntegrityError(err)) return err;
    if (
      err instanceof ConditionalCheckFailedException ||
      (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException'
    ) {
      return new WriteConflictError(
        `registry ${conflictHint}${ref ? ` for segment ${ref.segment}` : ''}`,
      );
    }
    if (isTransient(err)) {
      return new TransientError(
        `transient DynamoDB fault on registry${ref ? ` ${ref.segment}` : ''}: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}

/** The OCC token from an `UPDATED_NEW` response (the post-increment counter). */
function tokenOf(attrs: Record<string, AttributeValue> | undefined): Token {
  const token = attrs?.v?.N;
  if (token === undefined)
    throw new IntegrityError('DynamoDB registry UpdateItem returned no token');
  return token;
}

/** Serialize the record body (everything except the token, which is the OCC counter `v`). */
function serializeBody(record: RegistryRecord): string {
  const body: Omit<RegistryRecord, 'token'> = {
    namespace: record.namespace,
    segment: record.segment,
    currentGen: record.currentGen,
    wrappedDeks: record.wrappedDeks,
    keyId: record.keyId,
    dirtyChunkCount: record.dirtyChunkCount,
    status: record.status,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt,
    lastCompactedAt: record.lastCompactedAt,
    consecutiveFailures: record.consecutiveFailures,
    retention: record.retention,
    residency: record.residency,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  // `schemaVersion` stamps the persisted body (format freeze) alongside the LocalFs/S3 envelope. JSON.stringify
  // drops `undefined` fields (keyId/retention/residency).
  return JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, ...body });
}

/** Reconstruct the namespace from a scanned item's body (so `list` doesn't have to parse the PK). */
function namespaceOf(item: Record<string, AttributeValue>): SegmentRef {
  const body = parseBody(item.r?.S, 'scan');
  return { namespace: body.namespace, segment: body.segment };
}

/** Build a {@link RegistryRecord} from a live item: parse the JSON body, attach the token from `v`. */
function rowToRecord(item: Record<string, AttributeValue>, ref: SegmentRef): RegistryRecord {
  const token = item.v?.N;
  if (token === undefined) {
    throw new IntegrityError(`registry row for segment ${ref.segment} is missing its token`);
  }
  const body = parseBody(item.r?.S, ref.segment);
  return { ...body, token };
}

/** Parse + structurally validate the stored JSON body (untrusted bytes, invariant 5). */
function parseBody(json: string | undefined, ctx: string): Omit<RegistryRecord, 'token'> {
  if (json === undefined) throw new IntegrityError(`registry row ${ctx} is missing its body`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new IntegrityError(`registry row ${ctx} body is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new IntegrityError(`registry row ${ctx} body is malformed`);
  }
  // `schemaVersion` is a wire-only stamp (format freeze): validate it, then strip it so the in-memory record stays
  // pure (absent → legacy v1; a newer version → UnsupportedError).
  const { schemaVersion, ...body } = parsed as Record<string, unknown>;
  assertRegistrySchemaVersion(schemaVersion, ctx);
  assertStoredRecordShape(body, ctx);
  return body as Omit<RegistryRecord, 'token'>;
}
