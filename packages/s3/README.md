# @cloudbitmaps/s3

**S3 and S3-compatible object storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).**

> **ESM-only, Node ≥ 22.12.** This package ships as ES modules; there is no CommonJS bundle.
> `require()` works on Node 22.12+ through `require(esm)`, but a runner with its own CommonJS loader
> (notably Jest in its default configuration) does not get that and needs `import` instead. On TypeScript,
> a CommonJS project needs `"module": "nodenext"` or `"node20"`. See the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points) for the details.

AWS S3 — and every S3-compatible service: Cloudflare R2, MinIO, Ceph, Wasabi, Backblaze B2.

## Install

```bash
npm i @cloudbitmaps/roaring @cloudbitmaps/s3
```

Two packages: the **codec** you want and the **storage** you have. `@aws-sdk/client-s3` (`>=3.645.0`) is a real dependency of
this package, so installing it is the whole step — there is no optional peer to remember. `@cloudbitmaps/core` is one
too, so the engine lands in your tree without you installing it — you never name it yourself.

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
of values. Need them apart? This package also exports the two drivers and their option types; see the
[API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md).

## What this package is

These drivers move opaque payload bytes, so they are codec-agnostic: the same package serves every codec
flavor. That is why storage is a package rather than a subpath of one — as a subpath, each flavor needed a
re-export barrel per service, and the count multiplied with every codec added.

Built against `@cloudbitmaps/core/driver-kit`, the declared contract for a driver — the same surface a
third-party driver would use.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
