# @cloudbitmaps/gcs

**Google Cloud Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).**

> **ESM-only, Node ≥ 22.12.** This package ships as ES modules; there is no CommonJS bundle.
> `require()` works on Node 22.12+ through `require(esm)`, but a runner with its own CommonJS loader
> (notably Jest in its default configuration) does not get that and needs `import` instead. On TypeScript,
> a CommonJS project needs `"module": "nodenext"` or `"node20"`. See the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points) for the details.

Google Cloud Storage. Compare-and-swap rides GCS object preconditions, so a deployment runs on **one bucket alone** — no second service holds the pointer.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/gcs
# npm i @cloudbitmaps/roaring @cloudbitmaps/gcs   # the same, with npm
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

Two packages: the **codec** you want and the **storage** you have. `@google-cloud/storage` (`^7 || ^8`) is a real dependency of
this package, so installing it is the whole step — there is no optional peer to remember. `@cloudbitmaps/core` is one
too, so the engine lands in your tree without you installing it — you never name it yourself.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { GcsStorage } from '@cloudbitmaps/gcs';

const store = new CloudRoaring({
  storage: new GcsStorage({ bucket: 'bitmaps', prefix: 'cr' }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
const seg = store.segment('active-users');
await seg.has(2); // true
```

`GcsStorage` configures both halves — the immutable generation objects and the registry pointer row — from one set
of values: `bucket`, `prefix`, and `client` or the `projectId` / `apiEndpoint` it builds one from. It refuses any
other key by name rather than ignoring it — `storage` included, which is what the lower-level driver calls the
client — so a mistyped option cannot quietly build a client against the public endpoint. A `client` carries its
own project and endpoint, so giving `projectId` or `apiEndpoint` beside it is refused too, and named: configure
them on the client, or drop `client`. Two more options size the upload: `simpleUploadThresholdBytes` (default 8 MiB) is the size up to which an object is one simple request and
above which it is a resumable stream, and `maxObjectBytes` is the largest object the backend will write (default
GCS's 5 TiB maximum). Either must be a positive safe integer. See the
[API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md).

## Conditional writes are sent once

The SDK sends an upload again when it does not get the response, and a conditional one sent again meets itself and
fails its precondition, which turns a write that landed into a reported conflict. So this package uploads the
registry's rows, and every object up to `simpleUploadThresholdBytes` (8 MiB by default), as one request sent once,
with no SDK retry around it. A client you pass keeps its configuration, and every other request it makes keeps its
retry. A larger object is a resumable upload: a session of requests that the SDK retries within, under the client's
retry options, with no per-request switch to turn that off. It carries a random id in the object's custom metadata
(`cbwid`), outside the `.crbm` bytes, and a `412` on its commit reads the stored object back: its own id is a
success, and any other, or none, is a `WriteConflictError`. The read is made only on that `412`, works with the
client you pass, and adds no option.

A transient failure of a single-request write, or of the read-back, throws `TransientError`, and the write may or may not have landed:
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
