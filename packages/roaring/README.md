# @cloudbitmaps/roaring

**Large sets of integer ids, stored in your own object storage and read from anywhere.** Load a set as one immutable
file, then ask `has`, `count`, `iterate`, `intersect`, `union` and `andNot`, with no server or cache to run. Part of
[CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps); this is the package you import from.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. On npm these docs match the version they ship in; on GitHub they describe `main`, and the changelog says what each release changed.

## Install

```bash
pnpm add @cloudbitmaps/roaring              # the store, with in-memory and local-disk backends
pnpm add @cloudbitmaps/s3                   # the storage you have: or @cloudbitmaps/gcs, or @cloudbitmaps/azure-blob
pnpm add @cloudbitmaps/tools                # optional: price a store, offline
```

Install the same version of every `@cloudbitmaps/*` package: they release together, and each pins the exact version of `core` it was built with.

The store's Roaring is written in TypeScript, with no native code: [what that means](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/roaring-codec.md).

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

`RoaringBitmap` is the codec's bitmap as a public class: a mutable set of unsigned 32-bit ids with the portable Roaring
bytes, in TypeScript with no native code. Import it from `@cloudbitmaps/roaring/bitmap` to load no store and no Node
builtin, or from `@cloudbitmaps/roaring`. A store loads one as it is, and `RoaringBitmap.deserialize(bytes)` is the one
door for bytes you did not write.

```ts
import { CloudRoaring, MemoryStorage, RoaringBitmap } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

const vip = new RoaringBitmap([5, 99_999, 1_234_567_890]); // any iterable of ids
vip.add(7);
vip.removeMany([99_999]);
vip.addMany(new RoaringBitmap([8, 9])); // another bitmap, or a Uint32Array, works too

await store.load({ segment: 'vip' }, vip); // read, never changed or kept

// Bytes from another process go through the one safe door: capped, checked, one whole bitmap.
const received = RoaringBitmap.deserialize(vip.serialize());
console.log(received.size, received.minimum(), received.maximum()); // 5 5 1234567890
```

[The API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md#build-and-combine-bitmaps-by-themselves--roaringbitmap)
has every method and where it differs from the `roaring` package.

There is no `add` or `remove`: a segment changes only by loading a new generation. A load is a batch job, not a
request handler. `store.exists(ref)` says whether a segment has been loaded. A load takes ids, or a bitmap you already
hold: `store.load(ref, bitmap)` for a `RoaringBitmap` (or a `RoaringBitmap32`), or `{ serialized }` for portable Roaring bytes, checked
before anything is written and loaded with no per-id work, into a generation holding chunk for chunk what its ids would write (its footer carries its own write identity).

To write many results over the same stored operands, `store.materializeMany` reads each operand once for a whole batch of
`and` / `or` / `andNot` outputs instead of once per `*Into` call, and a set you already hold in memory streams in as its
feed. [Many outputs from one pass](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/loading.md#many-outputs-from-one-pass-materializemany)
covers both.

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
| `seams` | `{ clock, rng, entropy }`: determinism, for tests and replayable jobs; the source of each generation's write identity is the last |

## What it costs

A cold `intersect` of two 500,000-id segments sharing 100 of their 1,999 chunks made 6 GETs and took 104.88 ms at the median, **$2.40 per
million** at list prices: measured on S3 in-region, in the run of 2026-10-13, whose client had 128 sockets. On a spread layout it reads more
bytes than it needs, which cross-region can cost more than the requests it saves. A segment's first single-part `store.load()` made
2 PUT + 3 GET, **$11.20 per million** at the default prices, pointer included: the requests are measured on S3 in-region, in the same run. A steady single-part `store.load()` at `keep: 12` that deletes a generation by name costs **$12.00 per million**, for 2 PUT + 5 GET and a free delete, the requests measured on S3 in-region, in the same run. A cold `count()` is one
pointer read: it reads no payload and no object.

The trade is stated plainly. A membership check that misses the cache costs a ranged GET against object storage,
where an in-process store costs a memory read. If you need sub-millisecond answers on a working set that fits a
bounded cache, use Redis. [The benchmarks](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md)
give the method and what the numbers do not establish. To price your own store, from the sizes `seg.stat()` reports, use
`@cloudbitmaps/tools` ([the cost guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/cost.md)).

## Before production

- Run `await store.preflight()` once before the first load. It reads the registry, writes, tries to write again, reads, lists and
  deletes one probe object and checks the backend's lifecycle rules, and answers `{ ok, checks }`; see [`store.preflight()`](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#check-the-setup-with-storepreflight).
  It does not check `s3:AbortMultipartUpload`, the registry's `If-Match`, or a read after a delete, among others: [the full list](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#what-preflight-does-not-check).
- Grant the permissions the library issues and add a lifecycle rule to abort incomplete uploads. The S3 and GCS
  backends' `checkLifecycle()` read the bucket's rules and say whether one would delete or archive what the store
  keeps; Azure Blob's answers `unchecked` and says how to check by hand; `MemoryStorage` and `LocalFsStorage` have no
  rules and answer `ok`.
- Use a bucket that honors conditional writes and is strongly consistent (a read or a listing made after a write or a
  delete sees it), and `@aws-sdk/client-s3` 3.700.0 or later if you pass your own S3 client. Preflight reports a second write that succeeds (which is how an SDK of 3.640.0 or older shows) and a read or listing
  that lags a write, but not an SDK from 3.641.0 to 3.699.0, which keeps `If-None-Match` but drops `If-Match`: the SDK floor stays yours to check.
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

## Credits

The Roaring Bitmap format and its algorithms are the work of Daniel Lemire and colleagues. See
[roaringbitmap.org](https://roaringbitmap.org/) and the [Roaring format specification](https://github.com/RoaringBitmap/RoaringFormatSpec),
which defines the portable bytes every chunk of a `.crbm` object holds. The store's codec implements that format and those
algorithms in TypeScript ([how it is held to CRoaring](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/roaring-codec.md#the-guarantee-the-same-bytes)); CRoaring, through the `roaring` binding, is the reference its tests compare it against. The papers:

- S. Chambi, D. Lemire, O. Kaser, R. Godin, "Better bitmap performance with Roaring bitmaps", *Software: Practice and
  Experience* 46(5), 2016. [arXiv:1402.6407](https://arxiv.org/abs/1402.6407)
- D. Lemire, G. Ssi-Yan-Kai, O. Kaser, "Consistently faster and smaller compressed bitmaps with Roaring", *Software:
  Practice and Experience* 46(11), 2016. [arXiv:1603.06549](https://arxiv.org/abs/1603.06549)
- D. Lemire, O. Kaser, N. Kurz, L. Deri, C. O'Hara, F. Saint-Jacques, G. Ssi-Yan-Kai, "Roaring Bitmaps: Implementation
  of an Optimized Software Library", *Software: Practice and Experience* 48(4), 2018.
  [arXiv:1709.07821](https://arxiv.org/abs/1709.07821)

## License

Apache-2.0
