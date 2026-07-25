// Runs against the Cassandra service from docker-compose (see docker-compose.yml): `docker compose up -d`
// then `pnpm test:integration`. A real Cassandra (also covers ScyllaDB — same CQL + LWT), not an emulator —
// OCC is a lightweight transaction. Cassandra is slow to start, so the readiness poll is generous.
import { Client } from 'cassandra-driver';
import { warmConformance } from '@/testing/conformance';
import { CassandraWarmDriver, cassandraWarmTableDDL } from '@/drivers/cassandra/warm';
import { CloudRoaring, MemoryColdDriver } from '@/index';
import { CrbmColdChunkSource } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import type { IWarmDriver } from '@/core/ports';
import { NO_ROW } from '@/core/ports';

// Run `put` for each key with a bounded number of writes in flight. Kept LOW for Cassandra: every write is an
// LWT (Paxos) to the SAME partition (one segment = one partition), so high concurrency just piles on Paxos
// contention/retries — a modest cap keeps the wide-segment scale test both fast and non-flaky.
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

const CONTACT = process.env.CASSANDRA_CONTACT ?? '127.0.0.1:9042';
const DC = process.env.CASSANDRA_DC ?? 'datacenter1';
const KEYSPACE = 'cloud_roaring_it';
const TABLE = 'cloud_roaring_warm';
const client = new Client({ contactPoints: [CONTACT], localDataCenter: DC });

beforeAll(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (attempt >= 60) throw err; // ~120s — Cassandra is slow to accept CQL
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await client.execute(
    `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} ` +
      `WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
  );
  await client.execute(cassandraWarmTableDDL(KEYSPACE, TABLE));
  await client.execute(`TRUNCATE ${KEYSPACE}.${TABLE}`); // clean slate on a reused container
  // Prime Paxos on BOTH paths the driver uses: a freshly-booted node passes the plain-CQL healthcheck BEFORE it
  // can complete an LWT (a SERIAL *write*) OR a linearizable LOCAL_SERIAL *read* round — the first of each can
  // time out server-side ("0 replica(s) responded over 1 required"). Retry a throwaway LWT write **and** a
  // LOCAL_SERIAL read of it, in the same attempt, until BOTH complete a Paxos round, then clean up. Priming the
  // read path matters: without it the concurrent-D4 conformance test's first LOCAL_SERIAL reads flake on a cold
  // GitHub-hosted node (that read timeout is exactly what reddened this lane before this warm-up was hardened).
  const LOCAL_SERIAL = 9; // cassandra-driver consistency code — matches the driver's read consistency
  for (let attempt = 0; ; attempt++) {
    try {
      await client.execute(
        `INSERT INTO ${KEYSPACE}.${TABLE} (kp, ns, seg, ck, tok, payload) VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
        ['_warmup', '_', '_', 0, 't', Buffer.from([0])],
        { prepare: true },
      );
      await client.execute(
        `SELECT tok FROM ${KEYSPACE}.${TABLE} WHERE kp = ? AND ns = ? AND seg = ? AND ck = ?`,
        ['_warmup', '_', '_', 0],
        { prepare: true, consistency: LOCAL_SERIAL },
      );
      break;
    } catch (err) {
      // 45 attempts, 1s apart. A *failing* attempt can itself block on a server-side Paxos timeout (seconds),
      // so real wall-clock grace exceeds 45s; the expected case succeeds in 1–3 attempts. The 180s hook timeout
      // (below) covers the connect loop + this warm-up together; neither is expected to saturate.
      if (attempt >= 45) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // Also warm Paxos for CONCURRENT LWT load: the D4 conformance test fires 15 concurrent compare-and-set writes,
  // and a cold single node can time out the first concurrent burst with a CAS write timeout ("0 peer(s)
  // acknowledged the write over 1 required") even after the serial warm-up above. Fire a comparable concurrent
  // INSERT … IF NOT EXISTS burst (distinct throwaway keys) and retry the WHOLE burst until it lands cleanly.
  for (let attempt = 0; ; attempt++) {
    try {
      await Promise.all(
        Array.from({ length: 15 }, (_v, i) =>
          client.execute(
            `INSERT INTO ${KEYSPACE}.${TABLE} (kp, ns, seg, ck, tok, payload) VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
            ['_warmupc', '_', '_', i, 't', Buffer.from([0])],
            { prepare: true },
          ),
        ),
      );
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // generous grace for cold-Paxos concurrency (each failure may itself time out server-side)
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await client.execute(`TRUNCATE ${KEYSPACE}.${TABLE}`); // drop all warm-up rows (serial + concurrent) — clean slate for the suite
}, 180_000);

afterAll(async () => {
  await client.shutdown();
});

let n = 0;
const freshDriver = (): IWarmDriver =>
  new CassandraWarmDriver({ client, keyspace: KEYSPACE, table: TABLE, keyPrefix: `conf-${n++}` });

// The Cassandra driver must pass the SAME warm contract as in-memory + LocalFs + DynamoDB + Postgres + Redis
// + Mongo (finding V8) — against real LWT compare-and-set.
warmConformance('CassandraWarmDriver (cassandra:5)', freshDriver);

describe('CassandraWarmDriver specifics (cassandra:5)', () => {
  const ref = (chunkKey: number) => ({ segment: 's', chunkKey });
  const driver = () =>
    new CassandraWarmDriver({ client, keyspace: KEYSPACE, table: TABLE, keyPrefix: `sp-${n++}` });

  it('isolates logical stores by keyPrefix', async () => {
    const a = new CassandraWarmDriver({
      client,
      keyspace: KEYSPACE,
      table: TABLE,
      keyPrefix: `iso-a-${n}`,
    });
    const b = new CassandraWarmDriver({
      client,
      keyspace: KEYSPACE,
      table: TABLE,
      keyPrefix: `iso-b-${n}`,
    });
    n++;
    await a.putConditional(ref(0), Uint8Array.of(1), NO_ROW);
    expect(await b.get(ref(0))).toBeNull();
    await b.putConditional(ref(0), Uint8Array.of(2), NO_ROW);
    expect([...(await a.get(ref(0)))!.bytes]).toEqual([1]);
    expect([...(await b.get(ref(0)))!.bytes]).toEqual([2]);
  });

  it('lists chunks ascending by the ck clustering key', async () => {
    const d = driver();
    const keys = [0, 9, 10, 100, 65_535];
    for (const k of keys) await d.putConditional(ref(k), Uint8Array.of(k & 0xff), NO_ROW);
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 9, 10, 100, 65_535]);
  });

  it('round-trips a full-byte-range and an empty payload (blob fidelity)', async () => {
    const d = driver();
    const full = new Uint8Array(256);
    for (let i = 0; i < 256; i++) full[i] = i;
    await d.putConditional(ref(1), full, NO_ROW);
    await d.putConditional(ref(2), new Uint8Array(0), NO_ROW);
    expect([...(await d.get(ref(1)))!.bytes]).toEqual([...full]);
    expect((await d.get(ref(2)))!.bytes.length).toBe(0);
  });
});

describe('CassandraWarmDriver end-to-end through the engine (cassandra:5)', () => {
  // Proves the real driver works behind a `CloudRoaring` store doing genuine tier-merged bitmap ops — a cold
  // base (immutable `.crbm`) with live warm deltas layered on top via real LWT (Paxos) OCC.
  it('tier-merges a cold base with live warm add/remove + chunk-skipping intersect', async () => {
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [2, 3, 4, 200_000]);
    const store = new CloudRoaring({
      warm: new CassandraWarmDriver({
        client,
        keyspace: KEYSPACE,
        table: TABLE,
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
  }, 60_000);

  it('lists a wide segment completely and in ascending order at the default page size', async () => {
    // N > 2 default fetch pages (500) so the auto-paging partition read crosses several real page boundaries
    // at width — guards a dropped/duplicated/mis-ordered chunk at a page seam on a wide (single-partition)
    // segment. Write concurrency is kept at 4 (not 8): every write is an LWT to the SAME partition, and too
    // many concurrent proposers just pile on Paxos contention (risking a non-retried CAS WriteTimeout on a
    // loaded CI node). The enumeration reads at `{ consistent: false }` (LOCAL_ONE) — on this RF=1 single node
    // the data is already fully consistent, so it stays complete while avoiding a heavier LOCAL_SERIAL read.
    const d = new CassandraWarmDriver({
      client,
      keyspace: KEYSPACE,
      table: TABLE,
      keyPrefix: `scale-${n++}`,
    });
    const N = 1100;
    const keys = Array.from({ length: N }, (_, i) => i);
    await writeMany(keys, 4, (k) =>
      d.putConditional({ segment: 's', chunkKey: k }, Uint8Array.of(k & 0xff), NO_ROW),
    );
    const seen: number[] = [];
    let payloadsMatch = true;
    for await (const row of d.listChunks({ segment: 's' }, { consistent: false })) {
      seen.push(row.chunkKey);
      // Each row's one-byte payload must be the one written for THAT key — catches a seam that lists rows in
      // order but mis-joins payloads to keys on a wide segment.
      if (row.bytes.length !== 1 || row.bytes[0] !== (row.chunkKey & 0xff)) payloadsMatch = false;
    }
    expect(seen.length).toBe(N); // no truncation, no duplicates
    expect(seen).toEqual(keys); // complete + strictly ascending (ck clustering order), no gaps at any page seam
    expect(payloadsMatch).toBe(true); // every payload paired with its own chunkKey across all fetch pages
  }, 120_000);
});
