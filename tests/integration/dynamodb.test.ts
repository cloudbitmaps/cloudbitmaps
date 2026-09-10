import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { registryConformance } from '@/testing/conformance';
import { DynamoDbRegistryDriver } from '@/drivers/dynamodb/registry';
import { WriteConflictError } from '@/core/errors';
import { CloudRoaring, MemoryColdDriver, bulkLoadCrbmGeneration } from '@/index';

// Runs against DynamoDB-Local from docker-compose: `docker compose up -d` then `pnpm test:integration`.
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';
const TABLE = 'cloud-roaring-it';

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  maxAttempts: 5,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// `docker compose --wait` returns when the container is *running*, not when DynamoDB-Local's JVM has bound
// the port — so the first request can race startup and come back as a dropped connection ("socket hang up" /
// ECONNREFUSED / ETIMEDOUT). Retry table setup through that warmup window before giving up.
const TRANSIENT = new Set(['TimeoutError', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const isTransient = (err: unknown): boolean => {
  const e = err as { name?: string; code?: string; message?: string };
  return (
    TRANSIENT.has(e.name ?? '') ||
    TRANSIENT.has(e.code ?? '') ||
    /socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|hang up/i.test(e.message ?? '')
  );
};

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      await sleep(500); // ~15s total budget for the JVM to come up
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastErr)}`);
}

beforeAll(async () => {
  await withRetry('CreateTable', async () => {
    try {
      await client.send(
        new CreateTableCommand({
          TableName: TABLE,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceInUseException') throw err;
    }
  });
  // DynamoDB-Local creates synchronously, but confirm ACTIVE before the suite runs.
  for (let i = 0; i < 20; i++) {
    const { Table } = await withRetry('DescribeTable', () =>
      client.send(new DescribeTableCommand({ TableName: TABLE })),
    );
    if (Table?.TableStatus === 'ACTIVE') return;
    await sleep(100);
  }
});

// Each makeDriver() call gets a unique key prefix → isolated within the shared table (makeDriver is sync,
// so per-call table creation isn't an option; the keyPrefix is the isolation seam). A monotonic clock keeps
// updatedAt advancing.
let n = 0;
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
registryConformance(
  'DynamoDbRegistryDriver (DynamoDB-Local)',
  () =>
    new DynamoDbRegistryDriver({
      client,
      tableName: TABLE,
      keyPrefix: `regconf${n++}`,
      now: ticking(),
    }),
);

describe('DynamoDbRegistryDriver specifics (DynamoDB-Local)', () => {
  it('does real cross-process OCC: a second instance sees the conflict', async () => {
    const a = new DynamoDbRegistryDriver({ client, tableName: TABLE, keyPrefix: 'regx' });
    const b = new DynamoDbRegistryDriver({ client, tableName: TABLE, keyPrefix: 'regx' });
    const { token } = await a.create({ segment: 'r' }, { currentGen: 0 });
    await a.compareAndSwap({ segment: 'r' }, token, { currentGen: 1 }); // advances the token
    await expect(
      b.compareAndSwap({ segment: 'r' }, token, { currentGen: 9 }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect((await a.get({ segment: 'r' }))!.currentGen).toBe(1);
  });
});

describe('DynamoDbRegistryDriver row semantics (DynamoDB-Local)', () => {
  const fresh = (): DynamoDbRegistryDriver =>
    new DynamoDbRegistryDriver({ client, tableName: TABLE, keyPrefix: `spec${n++}` });
  const ref = { segment: 's' };

  it('keeps the OCC token monotonic across delete→recreate (ABA-safe)', async () => {
    // A delete tombstones the row and advances the counter, so a recreate can never hand back a token an
    // earlier holder still has — otherwise a stale token would authorise a write against a different row.
    const d = fresh();
    const { token: t0 } = await d.create(ref, { currentGen: 0 });
    await d.delete(ref);
    expect(await d.get(ref)).toBeNull(); // tombstoned
    const { token: t1 } = await d.create(ref, { currentGen: 0 }); // recreate over the tombstone
    expect(Number(t1)).toBeGreaterThan(Number(t0)); // never reused
    await expect(d.compareAndSwap(ref, t0, { currentGen: 9 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('isolates rows by keyPrefix within the one table', async () => {
    const a = new DynamoDbRegistryDriver({ client, tableName: TABLE, keyPrefix: 'isoA' });
    const b = new DynamoDbRegistryDriver({ client, tableName: TABLE, keyPrefix: 'isoB' });
    await a.create(ref, { currentGen: 7 });
    expect(await b.get(ref)).toBeNull(); // b's prefix space is independent
    expect((await a.get(ref))!.currentGen).toBe(7);
  });
});

describe('DynamoDbRegistryDriver as the store registry (DynamoDB-Local)', () => {
  // The registry is the store's generation pointer, so this is the read path over a REAL registry: every load
  // publishes through DynamoDB, and each read resolves `currentGen` from it with one strong get.
  it('a loaded generation is published to DynamoDB and read back through the store', async () => {
    const registry = new DynamoDbRegistryDriver({
      client,
      tableName: TABLE,
      keyPrefix: `store${n++}`,
    });
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3, 200_000], {
      registry,
    });
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [2, 3, 4, 200_000], {
      registry,
    });

    const store = new CloudRoaring({ cold, registry, retry: false });
    expect((await registry.get({ segment: 'a' }))!.currentGen).toBe(0);
    expect(await store.segment('a').count()).toBe(4);

    const got: number[] = [];
    for await (const id of store.segment('a').intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([2, 3, 200_000]);
  });

  it('a second load supersedes the first — reads follow the pointer forward', async () => {
    const registry = new DynamoDbRegistryDriver({
      client,
      tableName: TABLE,
      keyPrefix: `store${n++}`,
    });
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1, 2], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 1 }, [7, 8, 9], { registry });

    expect((await registry.get({ segment: 's' }))!.currentGen).toBe(1);
    // A FRESH store, so the generation is resolved after both loads rather than pinned before them.
    const store = new CloudRoaring({ cold, registry, retry: false });
    const ids: number[] = [];
    for await (const id of store.segment('s').iterate()) ids.push(id);
    expect(ids).toEqual([7, 8, 9]); // the superseded generation is never merged in
  });
});
