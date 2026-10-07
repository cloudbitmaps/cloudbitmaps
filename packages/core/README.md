# @cloudbitmaps/core

**Most people do not install this package.** It is the engine underneath [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps), and it arrives on its own
when you install the two packages you want. Install those instead:

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3   # the store, and the storage you have (or /gcs, or /azure-blob)
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

Depend on `@cloudbitmaps/core` directly only to write a flavor or a driver.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. On npm these docs match the version they ship in; on GitHub they describe `main`, and the changelog says what each release changed.

## What it is

The codec-agnostic cloud engine: a bounded in-memory cache over immutable `.crbm` objects, chunk-skipping
intersection, the segment registry, the write-once load-and-publish path, generation collection, encryption at rest
and crypto-shred, erasure by rewrite, retention, and the in-memory and local-filesystem backends. It has **zero runtime
dependencies and no cloud SDK**. The cloud backends are their own packages, built against
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
