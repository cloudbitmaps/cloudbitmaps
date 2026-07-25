// Runs against the MongoDB service from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. A real MongoDB, not an emulator — OCC is per-document (deterministic-_id insert +
// token-fenced updateOne/deleteOne).
import { MongoClient } from 'mongodb';
import { warmConformance } from '@/testing/conformance';
import { MongoWarmDriver, ensureMongoWarmIndexes } from '@/drivers/mongodb/warm';
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

const URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DB = 'cloud_roaring_it';
const COLLECTION = 'cloud_roaring_warm';
const client = new MongoClient(URL, { serverSelectionTimeoutMS: 2000 });

beforeAll(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.connect();
      await client.db(DB).command({ ping: 1 });
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const db = client.db(DB);
  await db.collection(COLLECTION).deleteMany({}); // clean slate on a reused container
  await ensureMongoWarmIndexes(db, COLLECTION);
}, 30_000);

afterAll(async () => {
  await client.close();
});

let n = 0;
const freshDriver = (): IWarmDriver =>
  new MongoWarmDriver({ db: client.db(DB), collection: COLLECTION, keyPrefix: `conf-${n++}` });

// The Mongo driver must pass the SAME warm contract as in-memory + LocalFs + DynamoDB + Postgres + Redis
// (finding V8) — against real per-document OCC.
warmConformance('MongoWarmDriver (mongo:7)', freshDriver);

describe('MongoWarmDriver specifics (mongo:7)', () => {
  const ref = (chunkKey: number) => ({ segment: 's', chunkKey });
  const driver = () =>
    new MongoWarmDriver({ db: client.db(DB), collection: COLLECTION, keyPrefix: `sp-${n++}` });

  it('isolates logical stores by keyPrefix', async () => {
    const a = new MongoWarmDriver({
      db: client.db(DB),
      collection: COLLECTION,
      keyPrefix: `iso-a-${n}`,
    });
    const b = new MongoWarmDriver({
      db: client.db(DB),
      collection: COLLECTION,
      keyPrefix: `iso-b-${n}`,
    });
    n++;
    await a.putConditional(ref(0), Uint8Array.of(1), NO_ROW);
    expect(await b.get(ref(0))).toBeNull();
    await b.putConditional(ref(0), Uint8Array.of(2), NO_ROW);
    expect([...(await a.get(ref(0)))!.bytes]).toEqual([1]);
    expect([...(await b.get(ref(0)))!.bytes]).toEqual([2]);
  });

  it('lists many chunks in numeric ascending order (not _id-string order)', async () => {
    const d = driver();
    // 9 vs 10/100 would mis-sort if ordered by the _id string; the numeric `ck` sort must win.
    const keys = [0, 9, 10, 100, 65_535];
    for (const k of keys) await d.putConditional(ref(k), Uint8Array.of(k & 0xff), NO_ROW);
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 9, 10, 100, 65_535]);
  });

  it('round-trips a full-byte-range and an empty payload (BSON binary fidelity)', async () => {
    const d = driver();
    const full = new Uint8Array(256);
    for (let i = 0; i < 256; i++) full[i] = i;
    await d.putConditional(ref(1), full, NO_ROW);
    await d.putConditional(ref(2), new Uint8Array(0), NO_ROW);
    expect([...(await d.get(ref(1)))!.bytes]).toEqual([...full]);
    expect((await d.get(ref(2)))!.bytes.length).toBe(0);
  });

  it('matches case-sensitively even under a case-INSENSITIVE collection collation', async () => {
    // The driver pins {locale:'simple'} (binary) on every op, so it stays correct even when the warm
    // collection was created with a case-insensitive DEFAULT collation. Without that pin, findOne would
    // inherit the ci collation and a lowercase query would match an uppercase row → cross-segment leak.
    // (MongoDB's default collation is already binary, so we must force a ci default here to exercise the
    // guard — mirrors MySQL's utf8mb4_bin case-sensitivity test.)
    const db = client.db(DB);
    const ciName = `cr_warm_ci_${n++}`;
    await db.createCollection(ciName, { collation: { locale: 'en', strength: 2 } }); // case-insensitive
    try {
      const d = new MongoWarmDriver({ db, collection: ciName, keyPrefix: 'p' });
      await d.putConditional({ segment: 'Seg', chunkKey: 0 }, Uint8Array.of(7), NO_ROW);
      expect(await d.get({ segment: 'Seg', chunkKey: 0 })).not.toBeNull(); // exact case is found
      expect(await d.get({ segment: 'seg', chunkKey: 0 })).toBeNull(); // 'seg' must NOT match 'Seg'
      // A case-differing keyPrefix is likewise distinct.
      const upper = new MongoWarmDriver({ db, collection: ciName, keyPrefix: 'Case' });
      const lower = new MongoWarmDriver({ db, collection: ciName, keyPrefix: 'case' });
      await upper.putConditional({ segment: 's', chunkKey: 0 }, Uint8Array.of(1), NO_ROW);
      expect(await lower.get({ segment: 's', chunkKey: 0 })).toBeNull();
    } finally {
      await db.dropCollection(ciName).catch(() => {});
    }
  });
});

describe('MongoWarmDriver end-to-end through the engine (mongo:7)', () => {
  // Proves the real driver works behind a `CloudRoaring` store doing genuine tier-merged bitmap ops — a cold
  // base (immutable `.crbm`) with live warm deltas layered on top via real per-document OCC.
  it('tier-merges a cold base with live warm add/remove + chunk-skipping intersect', async () => {
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [2, 3, 4, 200_000]);
    const store = new CloudRoaring({
      warm: new MongoWarmDriver({
        db: client.db(DB),
        collection: COLLECTION,
        keyPrefix: `e2e-${n++}`,
      }),
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
    // N > 2 default cursor batches (500) so the sorted `find` cursor crosses several real batch boundaries at
    // width — guards a dropped/duplicated/mis-ordered chunk at a batch seam on a wide segment. (At this N the
    // small payloads sort in memory regardless; the `{ kp, ns, seg, ck }` index that keeps a truly large
    // segment's sort off Mongo's 32 MB ceiling — see the driver's operational note — is created in beforeAll.)
    const d = new MongoWarmDriver({
      db: client.db(DB),
      collection: COLLECTION,
      keyPrefix: `scale-${n++}`,
    });
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
    expect(seen).toEqual(keys); // complete + strictly ascending (numeric, not _id-string), no gaps
    expect(payloadsMatch).toBe(true); // every payload paired with its own chunkKey across all cursor batches
  }, 60_000);
});
