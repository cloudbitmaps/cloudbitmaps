# @cloudbitmaps/azure-blob

**Azure Blob Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).**

> **ESM-only, Node ≥ 22.12.** This package ships as ES modules; there is no CommonJS bundle.
> `require()` works on Node 22.12+ through `require(esm)`, but a runner with its own CommonJS loader
> (notably Jest in its default configuration) does not get that and needs `import` instead. On TypeScript,
> a CommonJS project needs `"module": "nodenext"` or `"node20"`. See the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points) for the details.

Azure Blob Storage. Write-once rides `If-None-Match: *`, and the registry rides blob ETags, so a deployment runs on **one container alone**.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/azure-blob
# npm i @cloudbitmaps/roaring @cloudbitmaps/azure-blob   # the same, with npm
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

Two packages: the **codec** you want and the **storage** you have. `@azure/storage-blob` (`^12`) is a real dependency of
this package, so installing it is the whole step — there is no optional peer to remember. `@cloudbitmaps/core` is one
too, so the engine lands in your tree without you installing it — you never name it yourself.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';

const store = new CloudRoaring({
  storage: new AzureBlobStorage({ connectionString, container: 'bitmaps', prefix: 'cr' }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
const seg = store.segment('active-users');
await seg.has(2); // true
```

`AzureBlobStorage` configures both halves — the immutable generation objects and the registry pointer row — from one set
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
