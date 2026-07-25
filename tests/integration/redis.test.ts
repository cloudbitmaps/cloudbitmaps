// Runs against the Redis service from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. A real Redis, not an emulator — the OCC is an atomic Lua compare-and-set.
import Redis from 'ioredis';
import { warmConformance } from '@/testing/conformance';
import { RedisWarmDriver } from '@/drivers/redis/warm';
import { CloudRoaring, MemoryColdDriver } from '@/index';
import { CrbmColdChunkSource } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import type { IWarmDriver } from '@/core/ports';
import { NO_ROW } from '@/core/ports';

// Run `put` for each key with a bounded number of writes in flight — enough concurrency to keep a wide-segment
// scale test fast, capped so we don't overload the backend.
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

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const client = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

beforeAll(async () => {
  // Poll PING (which auto-connects a lazyConnect client) — idempotent, unlike a bare connect() loop which can
  // hit "already connecting" while ioredis is mid-reconnect. The compose healthcheck already gates readiness.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.ping();
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await client.flushdb(); // clean slate on a reused container
}, 30_000);

afterAll(async () => {
  await client.quit();
});

let n = 0;
const freshDriver = (): IWarmDriver => new RedisWarmDriver({ client, keyPrefix: `conf-${n++}` });

// The Redis driver must pass the SAME warm contract as in-memory + LocalFs + DynamoDB + Postgres (finding V8) —
// against a real atomic Lua CAS.
warmConformance('RedisWarmDriver (redis:7)', freshDriver);

describe('RedisWarmDriver specifics (redis:7)', () => {
  const ref = (chunkKey: number) => ({ segment: 's', chunkKey });

  it('isolates logical stores by keyPrefix', async () => {
    const a = new RedisWarmDriver({ client, keyPrefix: `iso-a-${n}` });
    const b = new RedisWarmDriver({ client, keyPrefix: `iso-b-${n}` });
    n++;
    await a.putConditional(ref(0), Uint8Array.of(1), NO_ROW);
    expect(await b.get(ref(0))).toBeNull();
    await b.putConditional(ref(0), Uint8Array.of(2), NO_ROW);
    expect([...(await a.get(ref(0)))!.bytes]).toEqual([1]);
    expect([...(await b.get(ref(0)))!.bytes]).toEqual([2]);
  });

  it('lists many chunks ascending across the value-fetch batch boundary', async () => {
    const d = new RedisWarmDriver({ client, keyPrefix: `page-${n++}`, listPageSize: 2 });
    const keys = [0, 1, 2, 5, 65_535];
    for (const k of keys) await d.putConditional(ref(k), Uint8Array.of(k & 0xff), NO_ROW);
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([...keys].sort((x, y) => x - y));
  });

  it('round-trips a full-byte-range and an empty payload through the real Lua path', async () => {
    const d = new RedisWarmDriver({ client, keyPrefix: `bin-${n++}` });
    const full = new Uint8Array(256);
    for (let i = 0; i < 256; i++) full[i] = i; // 0x00…0xFF incl. NUL + high bytes
    await d.putConditional(ref(1), full, NO_ROW);
    await d.putConditional(ref(2), new Uint8Array(0), NO_ROW); // empty payload
    expect([...(await d.get(ref(1)))!.bytes]).toEqual([...full]);
    expect((await d.get(ref(2)))!.bytes.length).toBe(0);
  });

  it('a delete removes both the hash and the index entry (no ghost in listChunks)', async () => {
    const d = new RedisWarmDriver({ client, keyPrefix: `del-${n++}` });
    const { token } = await d.putConditional(ref(4), Uint8Array.of(4), NO_ROW);
    await d.putConditional(ref(8), Uint8Array.of(8), NO_ROW);
    await d.deleteConditional(ref(4), token);
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([8]); // chunk 4 gone from the index, not just the hash
    expect(await d.get(ref(4))).toBeNull();
  });
});

describe('RedisWarmDriver end-to-end through the engine (redis:7)', () => {
  // Proves the real driver works behind a `CloudRoaring` store doing genuine tier-merged bitmap ops — a cold
  // base (immutable `.crbm`) with live warm deltas layered on top via the real atomic Lua CAS.
  it('tier-merges a cold base with live warm add/remove + chunk-skipping intersect', async () => {
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [2, 3, 4, 200_000]);
    const store = new CloudRoaring({
      warm: new RedisWarmDriver({ client, keyPrefix: `e2e-${n++}` }),
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
    // N > 2 default value-fetch batches (500). The sorted-set index is read whole (one ZRANGE), but the payload
    // pipeline fetches in batches of 500, so this crosses several real value-fetch-batch seams at width —
    // guarding a dropped/duplicated/mis-ordered chunk (and, with the payload check below, a mis-joined payload)
    // at a batch seam on a wide segment.
    const d = new RedisWarmDriver({ client, keyPrefix: `scale-${n++}` });
    const N = 1200;
    const keys = Array.from({ length: N }, (_, i) => i);
    await writeMany(keys, 64, (k) =>
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
    expect(seen).toEqual(keys); // complete + strictly ascending, no gaps at any batch seam
    expect(payloadsMatch).toBe(true); // every payload paired with its own chunkKey across all fetch batches
  }, 60_000);
});
