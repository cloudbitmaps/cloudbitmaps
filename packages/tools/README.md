# @cloudbitmaps/tools

**Offline tools for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps) that need nothing internal from a
store.** Today that is the cost model: what a store costs a month on object storage, term by term, set against the
always-on Redis that would hold the same data, with a verdict that says where Redis wins.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API can still change. On npm these docs match the version they ship in; on GitHub they describe
> `main`, and the changelog says what each release changed.

## Install

```bash
pnpm add @cloudbitmaps/tools
```

It reads and writes no store, and runs with nothing else installed: plan a deployment before you have one. Its one
dependency is `@cloudbitmaps/core`, for the `ValidationError` every refusal throws, so a caller classifies a refusal
with `isValidationError` as it does the library's. No cloud SDK, no native addon.

## Plan: `estimateCost`

Price segments you describe, under the workload you expect:

```ts
import { estimateCost } from '@cloudbitmaps/tools';

const report = estimateCost({
  segments: [{ sizeBytes: 4_000_000, count: 5_000 }], // or { cardinality }, at 2 bytes an id
  workload: {
    readsPerSec: 50,
    cacheHitRate: 0.8, // hits are free
    intersectsPerSec: 1, // priced cold: each operand's pointer and index are read too
    chunksPerIntersect: 2, // the range requests each intersect makes for its chunks, both operands
    loadsPerMonth: 150_000,
  },
});
report.monthlyUSD.byOp; // reads, intersects, storage, loads, pointerRefresh, retention
report.redisBaseline; // the cheapest Redis cluster that holds the data, and what it costs a month
report.verdict; // 'win-big' | 'win' | 'lose-zone' — never hides the lose case
report.assumptions.notes; // what it modeled, and what it did not
```

## Ground: `groundedReport` from `stat().size`

Price a store you run, from what it really holds. A segment handle's `stat()` reports `size`, the bytes of its
current generation's object, read from the object's footer and index with no payload read:

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';
import { groundedReport } from '@cloudbitmaps/tools';

const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'prod' }) });
const { size } = await store.segment('active-us').stat();
const report = groundedReport({
  storageBytes: size,
  workload: { readsPerSec: 200, cacheHitRate: 0.8 },
});
report.assumptions.grounded; // true — storage is the segment's measured size
```

`size` is `null` for a segment with no generation, and on a store whose source cannot report one; `groundedReport`
then prices storage at $0, sets `assumptions.grounded` to `false` and says in the notes that nothing was measured.
Sum several segments' sizes to price them together, checking each for `null` first (JavaScript adds `null` as `0`):
a report sizes its Redis to its own bytes, so one report of the sum is the store's, and the sum of per-segment reports
is not. If your store sets `cache.genTtlMs`, pass the same
value as `workload.genTtlMs`.

## Prices

The default profile, `AWS_US_EAST_1_ONDEMAND`, is AWS's us-east-1 on-demand object-storage prices, with Redis priced
from `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND`, ElastiCache for Redis OSS node prices from AWS's public price list (its
`source` names the version). `ONE_REDIS_HA_CLUSTER` is the one fixed cluster the benchmarks page charts, to pass as
`pricing.redis` when you want that comparison whatever the data size.

**It is a planning tool, and its prices are as old as the release that ships them.** Cloud prices move, and differ by
region, cloud and term. For a decision that turns on the price, pass your own `PricingProfile`: on Azure Blob,
`storage.requestsPerSizedRead: 2` for its two-request tail read.

The [cost guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/cost.md) is the whole model: what
each term counts, what the verdict compares against, and where the estimate is low. The
[API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md#offline-tools--cloudbitmapstools)
lists every export.

## More

- [Estimate your own cost](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/cost.md)
- [What it costs at your size](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/sizing.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
