# @cloudbitmaps/s3

**S3 storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One bucket holds your generations and their pointers, so there is no second
service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

`@aws-sdk/client-s3` (`>=3.700.0 <4`) is a real dependency of this package, so installing it is the whole step.
`@cloudbitmaps/core`, the engine underneath, arrives with it and you never name it.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({ bucket: 'bitmaps', prefix: 'cr', region: 'us-east-1' }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
await store.segment('active-users').has(2); // true
```

It builds its own client from your usual AWS credentials. Any other key is refused by name.

| Option | What it does |
|---|---|
| `bucket` (required) | the bucket |
| `prefix` | a key prefix for everything this store writes |
| `client` | your own `S3Client`; it carries its own region, endpoint and credentials |
| `region`, `endpoint`, `pathStyle`, `credentials` | build a client for you, such as one for MinIO; refused beside `client` |
| `partBytes`, `maxObjectBytes` | multipart sizing: part size (default 8 MiB; the upload buffers one part at a time) and the largest object (about 80 GiB by default, up to S3's 5 TiB) |
| `readTimeoutMs` | how long one read (a `GetObject` or `HeadObject`, its body included) may take before it throws `TransientError` and the store retries it; `0`, the default, sets no timeout. Writes are not timed |
| `conditionalDelete` | whether the registry removes a deleted row with a `DeleteObject` under `If-Match` rather than leaving a tombstone. On by default when the host the client resolves is an AWS S3 host, however its endpoint was set (`endpoint`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, the shared config file); off for any other host: set it for an S3-compatible store only once you know it applies the header (MinIO ignores it) |

## Before production

- **The bucket must honor conditional writes**: `If-None-Match: *` for a write-once generation and `If-Match` for the
  pointer. AWS S3 does, and the test suite runs against MinIO. Another S3-compatible service that ignores the headers
  turns write-once into overwrite, so check yours before you depend on it.
- **Use `@aws-sdk/client-s3` 3.700.0 or later** if you pin the SDK or pass your own `client`. This floor is a
  correctness floor, not a preference. An SDK sends only the conditional headers it models, and drops one it does
  not, without an error. `If-None-Match`, which write-once is built on, is modelled from 3.641.0: measured against
  MinIO, 3.640.0 silently overwrites an existing object, which loses a published generation. `If-Match` on
  `PutObject`, which the registry's compare-and-swap is built on, is modelled from 3.700.0: 3.699.0's serializer
  omits it, so a fenced row write goes out unconditionally and can land over a concurrent writer's. This package's
  own range never resolves below 3.700.0. The registry also checks, before its first request, that the client it is given sends `If-Match` on
  `PutObject` and `DeleteObject`, and refuses a write it would send without its precondition.
- **Grant `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListBucket`.** Without
  `s3:ListBucket`, S3 answers a missing key with `403` instead of `404`.
- **Add a lifecycle rule that aborts incomplete multipart uploads**, and never one that expires current objects or the
  `registry/` prefix.
- **A transient failure of a write throws `TransientError`, and the write may or may not have landed.** Re-run the
  call, or check `store.generations(ref)`. The SDK's own retry is off for conditional writes, so a write that landed
  is not reported as a conflict.
- **Reads can be timed, and writes are not.** Nothing is timed unless you set `readTimeoutMs`. Set, a read that has
  not finished in that many ms throws `TransientError`, and the store runs it again; AWS's guidance is to retry a GET
  of under 512 KB after about 2 seconds. The timer covers the body as well, so a connection that sends its headers and
  then stalls is cut off too. It starts when the read is handed to the SDK, so a burst of reads larger than the
  client's socket pool (50 by default) can time out while queued: set it above that queueing, or raise `maxSockets`.
  For the writes and listings, give your client a timeout of its own.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item, with a sample IAM policy, and the ones every backend shares: a request timeout on your client for the requests the library does not time, backups of the data and the registry, and a schedule for your loads.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
