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

Full README, guides, [benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md) (with
the method and what the numbers do *not* establish), and the design corpus live in the
[repository](https://github.com/cloudbitmaps/cloudbitmaps). Licensed Apache-2.0.
