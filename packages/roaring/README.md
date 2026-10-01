# @cloudbitmaps/roaring

**Large sets of integer ids, stored in your own object storage and read from anywhere.** Load a set as one immutable
file, then ask `has`, `count`, `iterate`, `intersect`, `union` and `andNot`, with no server or cache to run. Part of
[CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps); this is the package you import from.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## Install

```bash
pnpm add @cloudbitmaps/roaring              # the store, with in-memory and local-disk backends
pnpm add @cloudbitmaps/s3                   # the storage you have: or @cloudbitmaps/gcs, or @cloudbitmaps/azure-blob
```

On pnpm 10 and later, allow the one build script first, or the package throws at `import` while the install exits 0. Put this in your `package.json`: `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm and pnpm 9 need nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

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
| `GcsStorage({ bucket, prefix })` | `@cloudbitmaps/gcs` | Google Cloud Storage; outside the validated envelope |
| `AzureBlobStorage({ connectionString, container })` | `@cloudbitmaps/azure-blob` | Azure Blob Storage; outside the validated envelope |

There is no `add` or `remove`: a segment changes only by loading a new generation. A load is a batch job, not a
request handler. `store.exists(ref)` says whether a segment has been loaded.

## Options

`new CloudRoaring({ storage, ...options })`. Only `storage` is required. A key the store does not take is refused by
name.

| Option | What it holds |
|---|---|
| `storage` (required) | a backend (see above) |
| `cache` | `maxChunks`, `genTtlMs` (how soon a reader sees a new load, default 2000 ms), `readerMax`, `readerMaxBytes` |
| `encryption` | `{ keystore, required }`: encrypt segments at rest with your own key |
| `retry` | tune the retry of reads, or `false` to turn it off |
| `metrics` | a metrics sink; off by default |
| `budget` | `{ maxRequests }` or `false`: the per-call request ceiling |
| `seams` | `{ clock, rng }`: determinism, for tests |

## What it costs

Measured against real S3 in `us-east-1`, with the pointer in the same bucket as the data: the median cold `intersect`
of two 500,000-id segments sharing 100 of their 1,999 chunks made 206 GETs, **$82.40 per million**, requesting only
the shared chunks. Inside the region it is expected at 204 GETs, $81.60 per million. Writing and publishing a segment
is **$11.20 per million**, pointer included, from its measured requests at list prices. `count()` reads no payload.

The trade is stated plainly. A membership check that misses the cache costs a ranged GET against object storage,
where an in-process store costs a memory read. If you need sub-millisecond answers on a working set that fits a
bounded cache, use Redis. [The benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md)
give the method and what the numbers do not establish.

## Before production

- Grant the permissions the library issues and add a lifecycle rule to abort incomplete uploads.
- Use a bucket that honors conditional writes, and `@aws-sdk/client-s3` 3.645.0 or later if you pass your own S3 client.
- Set a request timeout on your storage client. Reads retry by themselves; a write that fails transiently is yours to re-run.
- Back up the registry with the data, and the keystore too if you encrypt. If you lose the key, the data is gone.
- Schedule your loads, and `retireExpired` if you use retention. Run loads off the request path.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item.

## Coming from Redis bitmaps?

`GETBIT` is `has`, `BITCOUNT` is `count`, and `BITOP AND` / `OR` / `DIFF` are `intersect` / `union` / `andNot`, with
`intersectInto`, `unionInto` and `andNotInto` publishing the result as a new generation. `EXPIRE` becomes
`setRetention` plus a `retireExpired` sweep you schedule, per segment, never per id. `SETBIT` has no equivalent:
there is no per-id write. Build the set upstream and load it, and do not loop one id at a time. Remove one id
everywhere with `eraseSubject`, a rewrite for compliance, not a hot-path verb. This is not a drop-in replacement, and
what does not carry over is the write model and the raw bytes. [The full mapping](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#coming-from-redis-bitmaps)
says what else differs.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)
- [Privacy and shared responsibility](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/PRIVACY.md)
## License

Apache-2.0
