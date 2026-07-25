/**
 * `RedisWarmDriver` — an {@link IWarmDriver} over Redis (Phase 7).
 *
 * The "sub-millisecond writes, accept always-on" warm tier. Uses the official `ioredis`, an **optional peer
 * dependency** — only consumers of `cloud-roaring/redis` install it. An `ioredis` client is **injected**
 * (dependency injection): the driver owns no connection/credential logic, so it's thin and reuses the
 * caller's client.
 *
 * Each chunk is one Redis **hash** (`t` = opaque OCC token, a random UUID per write; `b` = delta payload).
 * Redis has no range scan, so each segment keeps a **sorted-set index** of its live chunk keys (scored by
 * chunkKey) that `listChunks` reads. Optimistic concurrency is a **server-side atomic compare-and-set**: a
 * Lua script (Redis runs it atomically, single-threaded — no `WATCH`/`MULTI` needed) checks the stored token
 * and only then writes, keeping the hash and the index consistent in one step:
 * - **create-if-absent** — fails if the hash exists ⇒ {@link WriteConflictError}.
 * - **token-fenced update / delete** — fails unless the stored `t` equals the expected token ⇒
 *   {@link WriteConflictError}.
 *
 * The hash and index for a segment share a Redis-Cluster **hash tag** so the multi-key script is slot-safe.
 * Tokens are not reused across delete→recreate (ABA-safe, D3): a delete removes the hash and a recreate mints
 * a fresh random UUID (probabilistic, like the Postgres driver; conformance D3 pins it). Drivers may use
 * `node:crypto`; only `core/` is bound by the determinism lint.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef, IWarmDriver, NoRow, SegmentRef, Token, WarmRow } from '@/core/ports';
import { chunkHashKey, normalizeRedisPrefix, parseIndexMember, segmentIndexKey } from './keys';
import { isTransient } from './redis-errors';

/** listChunks value-fetch batch — bounds resident payloads to ~this many rows on a very wide segment. */
const DEFAULT_LIST_BATCH = 500;

// Atomic OCC compare-and-set scripts. KEYS[1] = chunk hash, KEYS[2] = segment index (sorted set). Redis runs
// each atomically, so the check-then-write can't race. Return 1 = applied, 0 = OCC conflict. Redis scripts
// have no rollback, so the hash write is ordered before the index write (and DEL before ZREM): the only way
// the second command could fail is a WRONGTYPE from external tampering on the shared-tag keyspace — outside
// the driver's closed world, where hash and index are only ever these keys.
const PUT_LUA = `
if ARGV[1] == 'create' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
  redis.call('HSET', KEYS[1], 't', ARGV[3], 'b', ARGV[5])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[4])
  return 1
else
  local cur = redis.call('HGET', KEYS[1], 't')
  if not cur or cur ~= ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 't', ARGV[3], 'b', ARGV[5])
  return 1
end`;
const DEL_LUA = `
local cur = redis.call('HGET', KEYS[1], 't')
if not cur or cur ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1`;

/** ioredis client augmented with the two custom OCC commands defined in the constructor. */
type WarmRedis = Redis & {
  crWarmPut(
    hashKey: string,
    indexKey: string,
    mode: string,
    expected: string,
    token: string,
    member: string,
    payload: Buffer,
  ): Promise<number>;
  crWarmDel(hashKey: string, indexKey: string, expected: string, member: string): Promise<number>;
};

export interface RedisWarmDriverOptions {
  /**
   * A constructed `ioredis` client. The driver never connects/quits it — the caller owns its lifecycle.
   *
   * **The warm tier holds the only live copy of un-compacted deltas, so the instance must be configured for
   * durability + no silent loss:**
   * - `maxmemory-policy noeviction` (or no `maxmemory`). Under a key-evicting policy the chunk hash and its
   *   segment-index entry are independent keys and can evict independently → `listChunks` silently drops or
   *   ghosts a chunk (the hash-tag guarantees same-*slot*, not co-eviction). The driver sets no TTLs.
   * - Durable persistence (AOF, e.g. `appendfsync everysec`) if you rely on warm survival across a restart.
   * - **Reads must hit the master** — the OCC read-modify-write needs read-your-writes, so do NOT enable
   *   replica reads (`scaleReads: 'slave'` / a replica `readFrom`), which could serve stale rows and break OCC.
   */
  readonly client: Redis;
  /** Optional key prefix so several logical stores can share one Redis (no `{`,`}`,`|`,`:`, or control chars). */
  readonly keyPrefix?: string;
  /** Advanced: `listChunks` value-fetch batch size (default 500). Tunes peak memory on wide segments. */
  readonly listPageSize?: number;
}

export class RedisWarmDriver implements IWarmDriver {
  private readonly client: WarmRedis;
  private readonly keyPrefix: string;
  private readonly listBatch: number;

  constructor(options: RedisWarmDriverOptions) {
    this.keyPrefix = normalizeRedisPrefix(options.keyPrefix);
    const batch = options.listPageSize ?? DEFAULT_LIST_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new ValidationError(`listPageSize must be a positive safe integer; got ${batch}`);
    }
    this.listBatch = batch;
    const client = options.client as WarmRedis;
    // Register the OCC scripts once (idempotent across driver instances sharing a client). ioredis caches
    // them and dispatches via EVALSHA with an automatic EVAL fallback.
    if (typeof client.crWarmPut !== 'function') {
      client.defineCommand('crWarmPut', { numberOfKeys: 2, lua: PUT_LUA });
    }
    if (typeof client.crWarmDel !== 'function') {
      client.defineCommand('crWarmDel', { numberOfKeys: 2, lua: DEL_LUA });
    }
    this.client = client;
  }

  async get(ref: ChunkRef): Promise<WarmRow | null> {
    const hashKey = chunkHashKey(this.keyPrefix, ref); // validates ref
    let raw: Record<string, Buffer>;
    try {
      raw = await this.client.hgetallBuffer(hashKey);
    } catch (err) {
      throw this.mapError(err);
    }
    if (Object.keys(raw).length === 0) return null; // absent hash → ioredis returns {}
    return this.rowFrom(raw, ref.chunkKey); // present-but-token-less ⇒ IntegrityError (untrusted-data posture)
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    const hashKey = chunkHashKey(this.keyPrefix, ref); // validates ref
    const indexKey = segmentIndexKey(this.keyPrefix, ref);
    const token = randomUUID();
    const payload = Buffer.from(bytes); // copy: severs any caller-owned/reused input buffer
    const member = String(ref.chunkKey);
    let applied: number;
    try {
      applied =
        expected === NO_ROW
          ? await this.client.crWarmPut(hashKey, indexKey, 'create', '', token, member, payload)
          : await this.client.crWarmPut(
              hashKey,
              indexKey,
              'update',
              expected,
              token,
              member,
              payload,
            );
    } catch (err) {
      throw this.mapError(err);
    }
    if (applied !== 1) {
      throw new WriteConflictError(
        expected === NO_ROW
          ? `chunk ${ref.chunkKey} already exists (create-if-absent)`
          : `OCC conflict on chunk ${ref.chunkKey}`,
      );
    }
    return { token };
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    const hashKey = chunkHashKey(this.keyPrefix, ref); // validates ref
    const indexKey = segmentIndexKey(this.keyPrefix, ref);
    let applied: number;
    try {
      applied = await this.client.crWarmDel(hashKey, indexKey, expected, String(ref.chunkKey));
    } catch (err) {
      throw this.mapError(err);
    }
    if (applied !== 1) {
      throw new WriteConflictError(`fenced-delete conflict on chunk ${ref.chunkKey}`);
    }
  }

  async *listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
    const indexKey = segmentIndexKey(this.keyPrefix, ref); // validates ref
    let members: string[];
    try {
      // The index is a sorted set scored by chunkKey, so ZRANGE returns members ascending. It holds only small
      // integers, so reading it whole is cheap; the (larger) payloads are fetched in bounded batches below.
      members = await this.client.zrange(indexKey, 0, -1);
    } catch (err) {
      throw this.mapError(err);
    }
    for (let i = 0; i < members.length; i += this.listBatch) {
      const batch = members.slice(i, i + this.listBatch);
      // Resolve members → chunk keys first, dropping any foreign/corrupt member, then fetch that batch's
      // hashes in one pipeline (bounded resident payloads on a very wide segment).
      const keys = batch
        .map((m) => ({ chunkKey: parseIndexMember(m) }))
        .filter((x): x is { chunkKey: number } => x.chunkKey !== null);
      let results: [Error | null, unknown][] | null;
      try {
        const pipeline = this.client.pipeline();
        for (const { chunkKey } of keys) {
          pipeline.hgetallBuffer(chunkHashKey(this.keyPrefix, { ...ref, chunkKey }));
        }
        results = await pipeline.exec();
      } catch (err) {
        throw this.mapError(err);
      }
      results ??= [];
      for (let j = 0; j < keys.length; j++) {
        const [err, raw] = results[j] ?? [null, undefined];
        if (err) throw this.mapError(err);
        const row = raw as Record<string, Buffer> | undefined;
        // A member with no hash means a delete raced our snapshot — skip it (matches the moving-target
        // semantics of the DynamoDB/Postgres paginated lists).
        if (row === undefined || row.t === undefined) continue;
        yield { chunkKey: keys[j]!.chunkKey, ...this.rowFrom(row, keys[j]!.chunkKey) };
      }
    }
  }

  /** Build a {@link WarmRow} from a raw hash; reject a hash missing its fields (corrupt/foreign). */
  private rowFrom(raw: Record<string, Buffer>, chunkKey: number): WarmRow {
    const token = raw.t;
    if (token === undefined) {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its token`);
    }
    const payload = raw.b;
    if (payload === undefined) {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its payload`);
    }
    return { token: token.toString('utf8'), bytes: new Uint8Array(payload) };
  }

  /** Reclassify a transient Redis fault as a retryable {@link TransientError}; else propagate unchanged. */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient Redis fault: ${(err as { message?: unknown } | null)?.message ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}
