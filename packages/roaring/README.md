# @cloudbitmaps/roaring

**Large sets of integer ids, stored in your own object storage and read from anywhere.** Load a set as one immutable
file, then ask `has`, `count`, `iterate`, `intersect`, `union` and `andNot`, with no server or cache to run. Part of
[CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps); this is the package you import from.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. These docs ship with the release they are in; the changelog says what each release changed.

## Install

```bash
pnpm add @cloudbitmaps/roaring              # the store, with in-memory and local-disk backends
pnpm add @cloudbitmaps/s3                   # the storage you have: or @cloudbitmaps/gcs, or @cloudbitmaps/azure-blob
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

## Use

No setup needed: `MemoryStorage` keeps everything in the process, which is right for a first look and for tests.
Save this as `first-run.mjs` and run it with `node`:

```js
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

await store.load({ segment: 'shoppers' }, [5, 99_999, 1_234_567_890]); // a load replaces the segment
await store.load({ segment: 'active' }, [5, 7, 1_234_567_890]);

const shoppers = store.segment('shoppers');
console.log(await shoppers.has(99_999)); // true
console.log(await shoppers.count()); // 3
for await (const id of shoppers.intersect([store.segment('active')])) console.log(id); // 5, then 1234567890
```

To persist, pass a different **backend** as `storage`. Nothing else changes:

| Backend | From | Use it for |
|---|---|---|
| `MemoryStorage` | `@cloudbitmaps/roaring` | tests and a first look |
| `LocalFsStorage('./.cloudbitmaps')` | `@cloudbitmaps/roaring` | one process on one folder: a laptop or a CI job |
| `S3Storage({ bucket, prefix })` | `@cloudbitmaps/s3` | production: the validated one |
| `GcsStorage({ bucket, prefix })` | `@cloudbitmaps/gcs` | Google Cloud Storage; outside the [validated envelope](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt) |
| `AzureBlobStorage({ connectionString, container })` | `@cloudbitmaps/azure-blob` | Azure Blob Storage; outside the [validated envelope](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt) |

There is no `add` or `remove`: a segment changes only by loading a new generation. A load is a batch job, not a
request handler. `store.exists(ref)` says whether a segment has been loaded. A load takes ids, or a bitmap you already
hold: `store.load(ref, { bitmap })` for a `RoaringBitmap32`, or `{ serialized }` for portable Roaring bytes, checked
before anything is written and loaded with no per-id work, into the same bytes its ids would write.

To write many results over the same stored operands, `store.materializeMany` reads each operand once for a whole batch of
`and` / `or` / `andNot` outputs instead of once per `*Into` call, and `store.memory(ids)` holds a set you already have in
memory as an operand of that batch. [Many outputs from one pass](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/loading.md#many-outputs-from-one-pass-materializemany) and
[held operands](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/loading.md#operands-held-in-memory-storememory) cover both.

## Options

`new CloudRoaring({ storage, ...options })`. Only `storage` is required. A key the store does not take is refused by
name.

| Option | What it holds |
|---|---|
| `storage` (required) | a backend (see above) |
| `cache` | `maxChunks`, `ttlMs` (an optional age limit on a cached chunk; omitted, a chunk stays until evicted), `genTtlMs` (how soon a reader sees a new load, default 2000 ms), `readerMax`, `readerMaxBytes` |
| `encryption` | `{ keystore, required }`: encrypt segments at rest with your own key |
| `retry` | tune the retry of reads, or `false` to turn it off |
| `metrics` | a metrics sink; off by default |
| `budget` | `{ maxRequests }` or `false`: the per-call request ceiling |
| `seams` | `{ clock, rng }`: determinism, for tests |

## What it costs

A cold `intersect` of two 500,000-id segments sharing 100 of their 1,999 chunks made 6 GETs and took 99.80 ms at the median, **$2.40 per
million** at list prices: measured on S3 in-region, in the run of 2026-10-06, whose client had 128 sockets. On a spread layout it reads more
bytes than it needs, which cross-region can cost more than the requests it saves. A segment's first `store.load()` made
2 PUT + 3 GET, **$11.20 per million** at the default prices, pointer included: the requests are measured on S3 in-region, in the same run. A steady `store.load()` at `keep: 12` that deletes a generation by name made 2 PUT + 4 GET and a free delete, measured: **$11.60 per million**. A cold `count()` is one
pointer read: it reads no payload and no object.

The trade is stated plainly. A membership check that misses the cache costs a ranged GET against object storage,
where an in-process store costs a memory read. If you need sub-millisecond answers on a working set that fits a
bounded cache, use Redis. [The benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md)
give the method and what the numbers do not establish.

## Before production

- Grant the permissions the library issues and add a lifecycle rule to abort incomplete uploads.
- Use a bucket that honors conditional writes, and `@aws-sdk/client-s3` 3.700.0 or later if you pass your own S3 client.
- Set a request timeout on your storage client. Reads retry by themselves, and a read can be timed on every backend (`readTimeoutMs`); a write that fails transiently is yours to re-run.
- Back up the registry with the data, and the keystore too if you encrypt. If you lose the key, the data is gone.
- Schedule your loads, and `retireExpired` if you use retention. Run loads off the request path.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item.

## Coming from Redis bitmaps?

`GETBIT` is `has`, `BITCOUNT` is `count`, and `BITOP AND` / `OR` / `DIFF` are `intersect` / `union` / `andNot`, with
`intersectInto`, `unionInto` and `andNotInto` publishing the result as a new generation, and `materializeMany` publishing
many such results from one pass. `EXPIRE` becomes
`setRetention` plus a `retireExpired` sweep you schedule, per segment, never per id. `SETBIT` has no equivalent:
there is no per-id write. Build the set upstream and load it, and do not loop one id at a time. Remove one id
everywhere with `eraseSubject`, a rewrite for compliance, not a hot-path verb. This is not a drop-in replacement, and
what does not carry over is the write model and the raw bytes: `exportSegments` writes portable Roaring and ndjson, not Redis's layout. [The full mapping](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#coming-from-redis-bitmaps)
says what else differs.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)
- [Privacy and shared responsibility](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/PRIVACY.md)
## License

Apache-2.0
