# @cloudbitmaps/core

**Most people do not install this package.** It is the engine underneath [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps), and it arrives on its own
when you install the two packages you want. Install those instead:

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3   # the store, and the storage you have (or /gcs, or /azure-blob)
```

On pnpm 10 and later, allow the one build script first, or the package throws at `import` while the install exits 0. Put this in your `package.json`: `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm and pnpm 9 need nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

Depend on `@cloudbitmaps/core` directly only to write a flavor or a driver.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## What it is

The codec-agnostic cloud engine: a bounded in-memory cache over immutable `.crbm` objects, chunk-skipping
intersection, the segment registry, the write-once load-and-publish path, generation collection, encryption at rest
and crypto-shred, erasure by rewrite, retention, and the in-memory and local-filesystem drivers. It has **zero runtime
dependencies and no cloud SDK**. The cloud drivers are their own packages, built against
`@cloudbitmaps/core/driver-kit`, the declared contract a driver depends on. A third-party driver can use it too.

Its main entry is the flavor-author kit: the read engine, the standalone forms of the store's methods (`loadSegment`,
`dropSegment`, `retireExpired` and the rest), and the retry and budget internals. `@cloudbitmaps/roaring` re-exports,
by name, what an application uses.

## Documentation

- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md), including the
  [driver kit](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md#driver-kit--what-you-need-to-implement-a-driver)
- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
