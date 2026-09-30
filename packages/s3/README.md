# @cloudbitmaps/s3

**S3 and S3-compatible object storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).**

> **ESM-only, Node ≥ 22.12.** This package ships as ES modules; there is no CommonJS bundle.
> `require()` works on Node 22.12+ through `require(esm)`, but a runner with its own CommonJS loader
> (notably Jest in its default configuration) does not get that and needs `import` instead. On TypeScript,
> a CommonJS project needs `"module": "nodenext"` or `"node20"`. See the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points) for the details.

AWS S3, and an S3-compatible service that honours conditional writes: `If-None-Match: *` for a write-once
generation and `If-Match` for the registry's compare-and-swap. A service that accepts those headers and ignores
them turns write-once into overwrite and the compare-and-swap into last-write-wins. The test suite runs against
MinIO; Cloudflare R2, Ceph, Wasabi and Backblaze B2 speak the S3 API too, so check that yours honours both
before you depend on it.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3
# npm i @cloudbitmaps/roaring @cloudbitmaps/s3   # the same, with npm
```

> **On pnpm 10+, allow the one build script.** pnpm 10 skips dependency build scripts by default, so
> the `roaring` native addon never downloads and the package throws at `import` — while the install
> itself prints a warning and **exits 0**. Add this to your `package.json`, then install:
>
> ```json
> { "pnpm": { "onlyBuiltDependencies": ["roaring"] } }
> ```
>
> pnpm 9 and npm run it already. [Full symptoms and fixes](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

Two packages: the **codec** you want and the **storage** you have. `@aws-sdk/client-s3` (`>=3.645.0 <4`) is a real dependency of
this package, so installing it is the whole step — there is no optional peer to remember. `@cloudbitmaps/core` is one
too, so the engine lands in your tree without you installing it — you never name it yourself.

> **The `>=3.645.0` floor is a correctness floor, not a preference.** The SDK models the conditional write
> this library's write-once guarantee is built on from 3.641.0: measured against MinIO, **3.640.0 silently
> overwrites** an existing object instead of refusing, which loses a published generation without an error,
> and 3.641.0 rejects correctly. The floor sits a small margin above that. This package's range never resolves
> below it; if you pin `@aws-sdk/client-s3` yourself, pin at least `3.645.0`, so the client you construct and
> pass as `client` comes from a version at or above the floor too.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({ bucket: 'bitmaps', prefix: 'cr', region: 'us-east-1' }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
const seg = store.segment('active-users');
await seg.has(2); // true
```

`S3Storage` configures both halves — the immutable generation objects and the registry pointer row — from one set
of values: `bucket`, `prefix`, and `client` or the `region` / `endpoint` / `pathStyle` / `credentials` it builds one
from. It refuses any other key by name rather than ignoring it, so a mistyped endpoint option cannot quietly build
a client against AWS. Need the halves apart, or a driver option such as `partBytes`? This package also exports the
two drivers and their option types, which `createBackend` joins; see the
[API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md).

## Conditional writes are sent once

The SDK sends a request again when it does not get the response. For a conditional write that turns a write that
landed into a reported conflict: the second send meets the first and fails its precondition. So this package sends
each conditional write once — the write-once `PutObject`, a multipart upload's `CompleteMultipartUpload`, and the
registry's create, compare-and-swap and delete, which writes a tombstone — with the SDK's retry off for that request
alone. A client you pass keeps its
configuration, and every other request it makes keeps its retry.

A transient failure of a conditional write throws `TransientError`, and the write may or may not have landed:
`store.generations(ref)` lists what the bucket holds, with the current generation marked. See
[the getting-started guide](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#6-reliability-retries-backoff--timeouts).

## What this package is

These drivers move opaque payload bytes, so they are codec-agnostic: the same package serves every codec
flavor. That is why storage is a package rather than a subpath of one — as a subpath, each flavor would need a
re-export barrel per service, and the count would multiply with every codec added.

Built against `@cloudbitmaps/core/driver-kit`, the declared contract for a driver — the same surface a
third-party driver would use.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
