import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { registryConformance, warmConformance } from '@/testing/conformance';
import { DynamoDbWarmDriver } from '@/drivers/dynamodb/warm';
import { DynamoDbRegistryDriver } from '@/drivers/dynamodb/registry';
import { NO_ROW } from '@/core/ports';
import { WriteConflictError } from '@/core/errors';

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

let n = 0;
// Each makeDriver() call gets a unique key prefix → isolated within the shared table (makeDriver is sync,
// so per-call table creation isn't an option; the keyPrefix is the isolation seam).
warmConformance(
  'DynamoDbWarmDriver (DynamoDB-Local)',
  () => new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: `conf${n++}` }),
);

// Registry rows co-locate with warm rows in the same single table; a unique keyPrefix per
// driver isolates each conformance run. A monotonic clock keeps updatedAt advancing.
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

describe('DynamoDbWarmDriver specifics (DynamoDB-Local)', () => {
  const fresh = (): DynamoDbWarmDriver =>
    new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: `spec${n++}` });
  const ref = (chunkKey: number) => ({ segment: 's', chunkKey });
  const bytes = (...b: number[]): Uint8Array => Uint8Array.of(...b);

  it('does real cross-process OCC: a second driver instance sees the conflict', async () => {
    // Two independent driver instances (no shared in-process lock) racing the same row — only one wins.
    const a = new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: 'xproc' });
    const b = new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: 'xproc' });
    const { token } = await a.putConditional(ref(1), bytes(1), NO_ROW);
    await a.putConditional(ref(1), bytes(2), token); // advances the token
    // b still holds the stale token → its conditional update must fail.
    await expect(b.putConditional(ref(1), bytes(9), token)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('keeps the OCC token monotonic across delete→recreate (ABA-safe)', async () => {
    const d = fresh();
    const { token: t0 } = await d.putConditional(ref(1), bytes(1), NO_ROW);
    await d.deleteConditional(ref(1), t0);
    expect(await d.get(ref(1))).toBeNull(); // tombstoned
    const { token: t1 } = await d.putConditional(ref(1), bytes(2), NO_ROW); // recreate over the tombstone
    expect(Number(t1)).toBeGreaterThan(Number(t0)); // never reused
    await expect(d.putConditional(ref(1), bytes(9), t0)).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('isolates rows by keyPrefix within the one table', async () => {
    const a = new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: 'isoA' });
    const b = new DynamoDbWarmDriver({ client, tableName: TABLE, keyPrefix: 'isoB' });
    await a.putConditional(ref(1), bytes(7), NO_ROW);
    expect(await b.get(ref(1))).toBeNull(); // b's prefix space is independent
    expect((await a.get(ref(1)))!.bytes).toEqual(bytes(7));
  });
});
