# @cloudbitmaps/roaring

**Distributed, cloud-native Roaring Bitmaps.** Query and intersect billion-scale integer sets straight out of
object storage — a bounded RAM cache over immutable `.crbm` objects in your own bucket — at a fraction of an
always-on cache, with the familiar bitmap API: `has`, `count`, `iterate`, `intersect`, `union`, `andNot`.

This is the **flagship flavor** of the [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps) family: the
roaring codec (CRoaring, via `roaring`) plus the `CloudRoaring` facade, on top of the codec-agnostic
[`@cloudbitmaps/core`](https://www.npmjs.com/package/@cloudbitmaps/core) engine — which arrives **transitively**,
so this is the only package you install.

```bash
npm i @cloudbitmaps/roaring @aws-sdk/client-s3   # + only the SDK(s) you use
```

```ts
import { CloudRoaring, bulkLoadCrbmGeneration } from '@cloudbitmaps/roaring';
import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';
```

Every storage driver is re-exported on a matching subpath (`/s3`, `/gcs`, `/azure`, `/dynamodb`); each backend SDK
is an optional peer dependency, so the main entry stays lean. Ships one CLI: `export-segments`.

## The model in one paragraph

A segment is a set of **write-once `.crbm` generations** in your bucket behind one small registry row saying which
generation is current. Data gets in by **loading** a new generation — you compute the set upstream (a warehouse
query, a batch job, a combine of other segments) and `bulkLoadCrbmGeneration` streams it into a single immutable
object, then advances the pointer forward-only. Nothing mutates a stored bitmap, so a crash before the publish
leaves the previous generation authoritative, a rerun is idempotent, and there is no partially-visible write.
Reads (`has`, `count`, `iterate`, `intersect`, `union`, `andNot`) see one whole, checksum-verified generation.

```ts
const cold = new S3ColdDriver({ client: s3, bucket: 'bitmaps' });
const registry = new S3RegistryDriver({ client: s3, bucket: 'bitmaps' }); // one bucket is the whole deployment

await bulkLoadCrbmGeneration(cold, { segment: 'high-value', generation: 0 }, idsFromWarehouse(), { registry });

const store = new CloudRoaring({ cold, registry });
const seg = store.segment('high-value');

await seg.has(1_234_567_890); // one chunk — from the hot cache after the first read
await seg.count(); // exact, and summed from the index with 0 payload reads
for await (const id of seg.intersect([store.segment('eu-residents')], { exclude: [store.segment('opted-out')] })) {
  /* streamed ascending; only the chunks that can contribute are ever fetched */
}
```

`intersectInto`, `unionInto` and `andNotInto` write the result as a **new generation of the destination** rather
than streaming it to you, using the same write-once-then-publish protocol.

## Measured, not modeled

Benchmarked against **real** S3 + DynamoDB in `us-east-1`, not an emulator: **$0.14 per million** `count()`s and
**$5.88 per million** segment publishes — against an always-on Redis-HA line of **$346/month, standing**, and
**$0.03/month** for 1.2 GiB of segments at rest. Request counts are read off the AWS SDK layer rather than
estimated from sizes. `count()` on a published segment does **0 payload reads**, and intersecting two
2,000,000-id segments fetches only the shared chunks.

The trade is stated plainly rather than buried: a membership check that misses the hot cache costs a ranged GET
against object storage, where an in-process RAM store costs a memory read. If you need a sub-millisecond p99 on a
working set that fits a bounded hot cache, use Redis. If your sets are large, mostly read, and shouldn't cost
$346/month to keep warm, use this.

## Coming from Redis bitmaps?

**A durable home for set-shaped work** — audiences, dedup, suppression, membership, eligibility — where the sets
are large, mostly read, must survive a restart, and are **computed in batches** upstream. You are not giving up
the bitmap either: past **4,096 ids** in a 65,536-id chunk — 6.25% of it — Roaring stores that chunk *as* a flat
bit array, byte for byte what you have now. It just stops paying for the chunks you never wrote to.

The read side carries over one-for-one:

| Redis | Here |
|---|---|
| `GETBIT` | `has(id)` |
| `BITCOUNT` | `count()` — exact, served from the index with no payload reads |
| `BITOP AND` / `OR` / `DIFF` | `intersect` / `union` / `andNot` — streamed, and `intersect` skips chunks that cannot contribute. `intersectInto` / `unionInto` / `andNotInto` publish the result as a new generation of the destination |
| `SETBIT` | **no equivalent — there is no per-id write.** Build the set upstream and load it; remove one id everywhere with `eraseSubject` (a generation rewrite for compliance, not a hot-path verb) |
| `EXPIRE` | **`setRetention(ref, { expiresAt })` + `retireExpired()`** — a per-segment expiry the writer sets, and a sweep **you** schedule (this library starts no timer, so it works the same in a Lambda and a server). No per-**id** TTL: a bitmap stores ids, not timestamps |

**It is not a drop-in replacement, and the difference is the write model.** Redis mutates one bit in place per
call; here a segment changes only by getting a new generation. So a `SETBIT` loop has nothing to port to: if your
set is defined by a query, run the query and load the result; if it is defined by events arriving one at a time,
accumulate them where they arrive (Redis is good at that) and load the set on a cadence. A load bills per
**object**, not per id — ten million ids are a handful of PUTs.

**What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array, so anything reading your
Redis bitmap's underlying string — a job that `GET`s the key and indexes into it, a byte-for-byte backup — will
not read ours. `BITFIELD`, `BITPOS`, `BITOP NOT` and byte-range `BITCOUNT` have no equivalent either: this is a
set of ids, not an addressable bit buffer, and `NOT` in particular has no bounded universe to complement against.
Raw bit-position import/export is unbuilt;
[say so in an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) if you need it, because that is what
decides whether it gets built.

## Compliance is built in, not bolted on

- `subjectReport(id)` — which segments an id is in (GDPR Art. 15).
- `eraseSubject(id)` — rewrites every segment holding the id without it and deletes the generation that held the
  bit, so it is **physically gone from the bucket when the call returns**; you get an erasure ledger back and a
  `segment.rewrite` audit event per segment (Art. 17).
- `destroySegment` / `eraseNamespace` — **crypto-shred**: drop the segment's wrapped data key so its encrypted
  bytes are unreadable *everywhere, including backups*.
- `dropSegment(ref, { confirmSegment, dryRun })` — retire a segment and reclaim its storage.
- `checkConsistency()` — after a restore, verify every pointer's object is actually present.
- `exportSegments(sink, { format })` — eject every segment to portable `roaring` or `ndjson`. Your exit path.

## Retiring data: a per-segment expiry, and a sweep you schedule

A **segment** can expire; an individual **id** cannot (a bitmap stores ids, not `(id, timestamp)` pairs — a
timestamp per id costs more than the compression saves).

```ts
const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: '2026-08-05' };

await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // once, when you create the bucket
```

`expiresAt` is an absolute instant **you** compute, not a duration derived from anything observed: every load
rewrites the basis such a duration would use, so "30 days since the last write" would keep a busy bucket alive
precisely *because* it is being refreshed. `getRetention` reads the policy back and `clearRetention` cancels it.

Then, from whatever schedule your deployment already has — an EventBridge rule, a Kubernetes `CronJob`, `cron`, a
queue job — run the sweep. **This library starts no background timer**, deliberately: the same code has to behave
identically in a Lambda, an edge isolate and a long-lived server, and a timer that only works in one of those is
worse than none.

```ts
const swept = await store.retireExpired({ namespace: 'active-daily' });
for (const e of swept.entries) if (e.action === 'skipped') console.warn(e.segment, e.reason);
if (swept.limited) scheduleAnotherPassSoon(); // the per-cycle cap deferred some; re-run
```

Each retirement goes through `dropSegment`, so the registry → object-store ordering is one implementation rather
than two. The sweep is bounded (`limit`, default 100), previewable (`dryRun`), and returns a per-segment ledger
rather than throwing — a fault on one segment must not decide the fate of the other ninety-nine. Once a day is
enough for daily buckets. Full walkthrough:
[getting-started §13.5](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#135-retention-ttl-and-pruning--what-exists-and-what-doesnt).

## No background process, and nothing to seed

There is no daemon, no compaction pass and no lifecycle worker to run: a segment exists once you have loaded a
generation into it, and the only scheduled work is the retention sweep above (plus `gcOrphanGenerations` if you
want superseded generations collected sooner than the sweep does it). A store built with just `cold` reads
whatever the bucket holds; add a `registry` to resolve generations with one strong read, to read encrypted
segments, and to unlock the lifecycle helpers.

Full README, guides, [benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md) (with
the method and what the numbers do *not* establish), and the design corpus live in the
[repository](https://github.com/cloudbitmaps/cloudbitmaps). Licensed Apache-2.0.
