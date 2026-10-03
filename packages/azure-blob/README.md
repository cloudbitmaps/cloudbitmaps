# @cloudbitmaps/azure-blob

**Azure Blob Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One container holds your generations and their pointers, so there is
no second service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/azure-blob
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

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
| `blockBytes` | the staged block size (default 8 MiB; the upload buffers one block at a time) |
| `maxObjectBytes` | the largest blob (default `blockBytes` × 50,000, about 400 GiB) |
| `readTimeoutMs` | how long each read request may take, its body included, before it is cut off with a `TransientError` the store's read retry repeats (default `0`, off) |
| `conditionalDelete` | whether the registry removes a deleted row with Delete Blob under `ifMatch`, rather than leaving a tombstone every full listing reads. On by default: Azure Blob applies the precondition, and so does Azurite. A blob with a snapshot refuses the delete (`409 SnapshotsPresent`), which the sweep counts in `purgeFaults`. Needs a role that may delete blobs on the registry prefix |

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
- **Set `readTimeoutMs` to bound a read that stalls.** No client setting does: the SDK's per-try timer stops once the
  response headers arrive, so a body that stalls after them holds the read as long as the connection stays open. With
  `readTimeoutMs` set, each read request (a range read, a tail read's properties and its download, a registry row's
  read) that has not finished, body included, in that many ms is aborted and throws `TransientError`, which the
  store's read retry runs again. It is off unless you set it. The clock starts at the call into the SDK, so waiting
  for a socket or a credential's token counts. Writes, deletes and listings are not timed.
- **Price it with `storage.requestsPerSizedRead: 2`.** A pointer read is one GET here, as on S3 and GCS, but a
  segment's tail read is two requests, its properties and then its bytes, because Azure Blob takes no suffix range.
  Set it in the pricing profile you give `estimateCost` or `costReport`, and leave `requestsPerPointerRead` at 1.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item, and the ones every backend shares: a request timeout on your client, backups of the data and the registry, and a schedule for your loads.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
