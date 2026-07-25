// Runs against the Postgres service from docker-compose (see docker-compose.yml): `docker compose up -d`
// then `pnpm test:integration`. A real Postgres, not an emulator — the OCC is plain SQL.
import { Pool } from 'pg';
import { warmConformance } from '@/testing/conformance';
import { PostgresWarmDriver, postgresWarmTableDDL } from '@/drivers/postgres/warm';
import { CloudRoaring, MemoryColdDriver } from '@/index';
import { CrbmColdChunkSource } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import type { IWarmDriver } from '@/core/ports';
import { NO_ROW } from '@/core/ports';

// Run `put` for each key with a bounded number of writes in flight — enough concurrency to keep a wide-segment
// scale test fast, capped so we don't exhaust the connection pool / overload the backend.
async function writeMany(
  keys: number[],
  concurrency: number,
  put: (k: number) => Promise<unknown>,
): Promise<void> {
  const queue = [...keys];
  const worker = async (): Promise<void> => {
    for (let k = queue.pop(); k !== undefined; k = queue.pop()) await put(k);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
}

const CONN =
  process.env.PG_URL ?? 'postgres://cloudroaring:cloudroaring@127.0.0.1:5432/cloudroaring';
const TABLE = 'cloud_roaring_warm';
const pool = new Pool({ connectionString: CONN, max: 8 });

beforeAll(async () => {
  // `docker compose up --wait` returns when healthy, but poll anyway so a cold start can't red the suite.
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await pool.query(postgresWarmTableDDL(TABLE));
  await pool.query(`TRUNCATE ${'"cloud_roaring_warm"'}`); // clean slate on a reused container
}, 30_000);

afterAll(async () => {
  await pool.end();
});

let n = 0;
const freshDriver = (): IWarmDriver =>
  new PostgresWarmDriver({ pool, table: TABLE, keyPrefix: `conf-${n++}` });

// The Postgres driver must pass the SAME warm contract as in-memory + LocalFs + DynamoDB (finding V8) —
// against real, cross-process SQL OCC.
warmConformance('PostgresWarmDriver (postgres:16)', freshDriver);

describe('PostgresWarmDriver specifics (postgres:16)', () => {
  const ref = (chunkKey: number) => ({ segment: 's', chunkKey });

  it('isolates logical stores by keyPrefix (same table, no cross-talk)', async () => {
    const a = new PostgresWarmDriver({ pool, table: TABLE, keyPrefix: `iso-a-${n}` });
    const b = new PostgresWarmDriver({ pool, table: TABLE, keyPrefix: `iso-b-${n}` });
    n++;
    await a.putConditional(ref(0), Uint8Array.of(1), NO_ROW);
    expect(await b.get(ref(0))).toBeNull(); // b's prefix can't see a's row
    await b.putConditional(ref(0), Uint8Array.of(2), NO_ROW); // b creates its own — no conflict
    expect([...(await a.get(ref(0)))!.bytes]).toEqual([1]);
    expect([...(await b.get(ref(0)))!.bytes]).toEqual([2]);
  });

  it('lists many chunks ascending across the keyset-pagination boundary', async () => {
    const d = freshDriver();
    // A handful spanning the u16 range, plus enough to cross a couple of realistic page reads.
    const keys = [0, 1, 500, 1000, 1001, 40_000, 65_535];
    for (const k of keys) await d.putConditional(ref(k), Uint8Array.of(k & 0xff), NO_ROW);
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([...keys].sort((x, y) => x - y));
  });

  it('postgresWarmTableDDL is idempotent (safe to run on every deploy)', async () => {
    await expect(pool.query(postgresWarmTableDDL(TABLE))).resolves.toBeDefined();
    await expect(pool.query(postgresWarmTableDDL(TABLE))).resolves.toBeDefined();
  });
});

describe('PostgresWarmDriver end-to-end through the engine (postgres:16)', () => {
  // Proves the real driver works behind a `CloudRoaring` store doing genuine tier-merged bitmap ops — a cold
  // base (immutable `.crbm`) with live warm deltas layered on top via real cross-process SQL OCC.
  it('tier-merges a cold base with live warm add/remove + chunk-skipping intersect', async () => {
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [2, 3, 4, 200_000]);
    const store = new CloudRoaring({
      warm: new PostgresWarmDriver({ pool, table: TABLE, keyPrefix: `e2e-${n++}` }),
      cold: new CrbmColdChunkSource(cold),
    });
    const a = store.segment('a');
    await a.add(5); // warm add over the cold base
    await a.remove(2); // warm tombstone over the cold base

    expect(await a.has(1)).toBe(true); // cold, untouched
    expect(await a.has(2)).toBe(false); // cold, tombstoned in warm
    expect(await a.has(5)).toBe(true); // warm add
    expect(await a.count()).toBe(4); // {1, 3, 5, 200000}

    const got: number[] = [];
    for await (const id of a.intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([3, 200_000]); // {1,3,5,200000} ∩ {2,3,4,200000}
  });

  it('lists a wide segment completely and in ascending order at the default page size', async () => {
    // N > 2 default keyset pages (1000) so the enumeration crosses several real page boundaries at width —
    // the failure mode this guards is a dropped/duplicated/mis-ordered row at a page seam on a wide segment.
    const d = new PostgresWarmDriver({ pool, table: TABLE, keyPrefix: `scale-${n++}` });
    const N = 2100;
    const keys = Array.from({ length: N }, (_, i) => i);
    await writeMany(keys, 8, (k) =>
      d.putConditional({ segment: 's', chunkKey: k }, Uint8Array.of(k & 0xff), NO_ROW),
    );
    const seen: number[] = [];
    let payloadsMatch = true;
    for await (const row of d.listChunks({ segment: 's' })) {
      seen.push(row.chunkKey);
      // Each row's one-byte payload must be the one written for THAT key — catches a seam that lists rows in
      // order but mis-joins payloads to keys on a wide segment.
      if (row.bytes.length !== 1 || row.bytes[0] !== (row.chunkKey & 0xff)) payloadsMatch = false;
    }
    expect(seen.length).toBe(N); // no truncation, no duplicates
    expect(seen).toEqual(keys); // complete + strictly ascending, no gaps at any page seam
    expect(payloadsMatch).toBe(true); // every payload paired with its own chunkKey across all page seams
  }, 60_000);
});
