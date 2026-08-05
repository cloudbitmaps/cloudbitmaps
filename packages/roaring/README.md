# @cloudbitmaps/roaring

**Distributed, cloud-native Roaring Bitmaps.** Query and intersect billion-scale integer sets over tiered cloud
storage (RAM → NoSQL → object store) at a fraction of an always-on cache — with the fast, familiar in-memory API:
`add`, `has`, `remove`, `count`, `intersect`.

This is the **flagship flavor** of the [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps) family: the
roaring codec (CRoaring, via `roaring`) plus the `CloudRoaring` facade, on top of the codec-agnostic
[`@cloudbitmaps/core`](https://www.npmjs.com/package/@cloudbitmaps/core) engine — which arrives **transitively**,
so this is the only package you install.

```bash
npm i @cloudbitmaps/roaring @aws-sdk/client-s3 @aws-sdk/client-dynamodb   # + only the SDK(s) you use
```

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3ColdDriver } from '@cloudbitmaps/roaring/s3';
import { DynamoDbWarmDriver } from '@cloudbitmaps/roaring/dynamodb';
```

Every storage driver is re-exported on a matching subpath (`/s3`, `/gcs`, `/azure`, `/dynamodb`, `/postgres`,
`/redis`, `/mongodb`, `/cassandra`, `/mysql`); each backend SDK is an optional peer dependency, so the main entry
stays lean. Ships two CLIs: `compact-segments` and `export-segments`.

## Measured, not modeled

Benchmarked against **real** S3 + DynamoDB in `us-east-1`, not an emulator: **$0.75 per million** incremental
writes, **$0.14 per million** `count()`s, **$5.88 per million** segment publishes — against an always-on Redis-HA
line of **$346/month, standing**. DynamoDB capacity is taken from AWS's own `ConsumedCapacity` rather than
estimated. `count()` on a published segment does **0 payload reads**, and intersecting two 2,000,000-id segments
fetches only the shared chunks.

The trade is stated plainly rather than buried: a membership check that misses the hot cache costs a network
round trip to your warm tier, where an in-process RAM store costs a memory read. If you need a sub-millisecond
p99 on a working set that fits a bounded hot cache, use Redis. If your sets are large, mostly read, and shouldn't cost $346/month to keep warm, use this.

## Coming from Redis bitmaps?

**A durable alternative to Redis bitmaps for set-shaped work** — audiences, dedup, suppression, membership —
where the sets are large, mostly idle, must survive a restart, and are written in **batches**. You are not giving
up the bitmap either: past **4,096 ids** in a 65,536-id chunk — 6.25% of it — Roaring stores that chunk *as* a flat
bit array, byte for byte what you have now. It just stops paying for the chunks you never wrote to.

| Redis | Here |
|---|---|
| `SETBIT` / `GETBIT` | `add` / `addMany` · `remove` / `removeMany` · `has` |
| `prior = SETBIT` | `claimMany(ids)` — adds a batch and returns only the ids that were **not** already there, so an *"already sent to this id?"* check is exactly-once |
| `BITCOUNT` | `count()` — exact, served from the index with no payload reads |
| `BITOP AND` / `OR` / `DIFF` | `intersect` / `union` / `andNot` — and `intersect` skips chunks that cannot contribute |
| `EXPIRE` | **`setRetention(ref, { expiresAt })` + `retireExpired()`** — a per-segment expiry the writer sets, and a sweep **you** schedule (this library starts no timer, so it works the same in a Lambda and a server). No per-**id** TTL: a bitmap stores ids, not timestamps. And never enable your backend's own row expiry on the warm table — those rows are un-compacted deltas, so it discards writes silently |

**It is not a drop-in replacement, and two limits are worth knowing before you port anything.**

**1. Do not port a per-id write loop.** `SETBIT` flips one bit in place and is genuinely O(1). Here a warm write
re-serializes a whole 65,536-id chunk, so **5,000 ids added one at a time cost 5,000 writes and 23,762 KB, against
1 write and 8 KB for the same ids in one call** — roughly 3,000× the bytes. Batch and you are far cheaper than
Redis; port the loop literally and you are far more expensive. On a per-request-metered store (DynamoDB on-demand)
that is a line item; on an instance-priced one (ElastiCache, RDS) it surfaces as IOPS and latency headroom instead,
which makes it easier to miss rather than cheaper. `claimMany` takes a batch for exactly this reason.

**2. What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array, so anything reading your
Redis bitmap's underlying string — a job that `GET`s the key and indexes into it, a byte-for-byte backup —
will not read ours. `BITFIELD`, `BITPOS`, `BITOP NOT` and byte-range `BITCOUNT` have no equivalent either: this
is a set of ids, not an addressable bit buffer, and `NOT` in particular has no bounded universe to complement
against. Raw bit-position import/export is unbuilt;
[say so in an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) if you need it, because that is what
decides whether it gets built.

## Retiring data: a per-segment expiry, and a sweep you schedule

A **segment** can expire; an individual **id** cannot (a bitmap stores ids, not `(id, timestamp)` pairs — a
timestamp per id costs more than the compression saves).

```ts
const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: '2026-08-05' };

await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // once, when you create the bucket
```

`expiresAt` is an absolute instant **you** compute, not a duration derived from anything observed: compaction
rewrites every basis such a duration could use, so "30 days since the last write" would keep a busy bucket alive
precisely *because* the daemon was keeping it cheap.

Then, from whatever schedule your deployment already has — an EventBridge rule, a Kubernetes `CronJob`, `cron`, a
queue job — run the sweep. **This library starts no background timer**, deliberately: the same code has to behave
identically in a Lambda, an edge isolate and a long-lived server, and a timer that only works in one of those is
worse than none.

```ts
const swept = await store.retireExpired({ namespace: 'active-daily' });
for (const e of swept.entries) if (e.action === 'skipped') console.warn(e.segment, e.reason);
if (swept.limited) scheduleAnotherPassSoon(); // the per-cycle cap deferred some; re-run
```

Each retirement goes through `dropSegment`, so the Warm → registry → Cold ordering is one implementation rather
than two. The sweep is bounded (`limit`, default 100), previewable (`dryRun`), and returns a per-segment ledger
rather than throwing — a fault on one segment must not decide the fate of the other ninety-nine. Once a day is
enough for daily buckets. Full walkthrough:
[getting-started §13.5](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#135-retention-ttl-and-pruning--what-exists-and-what-doesnt).

## No seed step, and compaction is optional

A brand-new segment is usable the moment you construct the store: `addMany`, `has`, `remove`, `count`, `iterate`
and the whole set algebra work against a segment with **no cold generation and no registry row**, because a read
merges `(cold ∪ warm.adds) \ warm.removes` and an absent cold tier just makes that merge trivial. Bulk-load is an
**import** path for data you already have elsewhere, not an initialization step.

Compaction is a **cost** optimization, never a correctness requirement — it buys cheaper storage, smaller rewrites,
and a free index-only `count()`. For a write-once dated bucket you retire (with `dropSegment`, or by recording an
expiry as above), skip it entirely.

Redis stays first-class as a **warm tier** underneath this (`@cloudbitmaps/roaring/redis`) — the point above is
about replacing `SETBIT`-on-one-giant-key as your *data model*, not replacing Redis as infrastructure.

Full README, guides, [benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md) (with
the method and what the numbers do *not* establish), and the design corpus live in the
[repository](https://github.com/cloudbitmaps/cloudbitmaps). Licensed Apache-2.0.
