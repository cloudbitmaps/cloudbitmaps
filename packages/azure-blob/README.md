# @cloudbitmaps/azure-blob

**Azure Blob Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One container holds your generations and their pointers, so there is
no second service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/azure-blob
```

On pnpm 10 and later, allow the one build script first, or the package throws at `import` while the install exits 0. Put this in your `package.json`: `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm and pnpm 9 need nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

`@azure/storage-blob` (`^12`) is a real dependency of this package, so installing it is the whole step.
`@cloudbitmaps/core`, the engine underneath, arrives with it and you never name it.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';

const store = new CloudRoaring({
  storage: new AzureBlobStorage({
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    container: 'bitmaps',
    prefix: 'cr',
  }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
await store.segment('active-users').has(2); // true
```

Any other key is refused by name.

| Option | What it does |
|---|---|
| `connectionString` and `container` | build a container client for you |
| `containerClient` | your own container-scoped client, instead of the two above; giving both is refused |
| `prefix` | a key prefix for everything this store writes |
| `blockBytes` | the staged block size (default 8 MiB, which is also the peak write memory) |
| `maxObjectBytes` | the largest blob (default `blockBytes` × 50,000, about 400 GiB) |

## Before production

- **This backend is outside the validated envelope.** It passes the same conformance suites as S3, but the proven
  scale and the calibration were done on S3. You are an early user.
- **Grant the container's data permissions.** The library writes blocks, commits block lists, reads blobs and their
  properties, lists and deletes. `Storage Blob Data Contributor` on the container covers all of them. A connection
  string carries the account key, which grants far more: prefer a `containerClient` built from a managed identity.
- **The write-once guarantee rides blob ETags and `If-None-Match: *`**, so nothing else needs enabling.
- **Never add a lifecycle rule that expires current blobs or the `registry/` prefix.**
- **A transient failure of a write throws `TransientError`, and the write may or may not have landed.** Re-run the
  call, or check `store.generations(ref)`. Every write is tagged with a random id and a conflict is settled by reading
  it back, because the client's own retry has no per-request switch.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
