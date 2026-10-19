# @cloudbitmaps/azure-blob

**Azure Blob Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One container holds your generations and their pointers, so there is
no second service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. On npm these docs match the version they ship in; on GitHub they describe `main`, and the changelog says what each release changed.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/azure-blob
```

Install the same version of every `@cloudbitmaps/*` package: they release together, and each pins the exact version of `core` it was built with.

`roaring` needs its one install script to fetch its native binary, and newer clients run a dependency's script only if you allow it. Allow it before you install:

- **npm 12:** add `{ "allowScripts": { "roaring": true } }` to your `package.json`. Without it the install exits 0 and the package throws at `import`. npm 11 runs the script but warns until you allow it the same way.
- **pnpm 11 and later:** put `allowBuilds: { roaring: true }` in a `pnpm-workspace.yaml` beside your `package.json`. Those versions no longer read the `package.json` `pnpm` key. Without it the install exits 1 with `ERR_PNPM_IGNORED_BUILDS`.
- **pnpm 10:** add `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }` to your `package.json`. Without it the install exits 0 and the package throws at `import`.
- **pnpm 9:** nothing extra.

[Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

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
| `blockBytes` | the staged block size (default 8 MiB; the upload buffers one block at a time and copies it into one body to stage it, so it holds up to about twice the block size at a flush, 16 MiB at the default, derived from the driver's code). Above Azure's 4,000 MiB block limit is a `ValidationError` |
| `maxObjectBytes` | the largest blob (default `blockBytes` × 50,000, about 390 GiB). Above 50,000 blocks of 4,000 MiB, about 190.7 TiB, is a `ValidationError` |
| `readTimeoutMs` | how long each read request may take, its body included, before it is cut off with a `TransientError` the store's read retry repeats (default `0`, off) |
| `conditionalDelete` | whether the service applies `ifMatch` on a Delete Blob: the registry then removes a deleted row rather than leaving a tombstone every full listing reads, and the storage half deletes an erasure's holder only while it is the blob the erasure read, by its ETag. On by default: Azure Blob applies the precondition, and so does Azurite. A blob with a snapshot refuses the delete (`409 SnapshotsPresent`), which the sweep counts in `purgeFaults`. Needs a role that may delete blobs on the registry prefix |

## Before production

- **This backend is outside the validated envelope.** It passes the same conformance suites as S3, but the proven
  scale and the calibration were done on S3. You are an early user.
- **Run `await store.preflight()` once before the first load.** It writes, tries to write again, reads, lists and deletes one probe
  blob and reads the registry, and answers `{ ok, checks }`. Its lifecycle check is always `unchecked` here (see below), so a run still needs that rule checked by hand. It
  does not check a read after a delete or versioning, among others: [the full list](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#what-preflight-does-not-check).
- **Grant the container's data permissions.** The library writes blocks, commits block lists, reads blobs and their
  properties, lists and deletes. `Storage Blob Data Contributor` on the container covers all of them. A connection
  string carries the account key, which grants far more: prefer a `containerClient` built from a managed identity.
- **The write-once guarantee rides blob ETags and `If-None-Match: *`**, so nothing else needs enabling.
- **Never add a lifecycle rule that expires current blobs or the `registry/` prefix.**
- **`await backend.checkLifecycle()` is always `unchecked` here.** A lifecycle management policy belongs to the storage
  account, on the management plane, which a blob client cannot read, and this package takes no management dependency.
  Its `detail` gives the `az storage account management-policy show` command and what to look for, including a rule with no `prefixMatch`
  ([check the lifecycle rules from code](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#check-the-lifecycle-rules-from-code)).
- **A transient failure of a write throws `TransientError`, and the write may or may not have landed.** Re-run the call,
  or check `store.generations(ref)`. Every write is tagged with a random id and, on a conflict, the stored blob is read
  back: one that carries the write's own id is a success, and any other is a `WriteConflictError`. A registry row's
  read-back is not definitive, since a writer that swaps in over a write that landed, before the read-back, makes it
  report a conflict, so the registry throws every conflict of a row write as `unsettledConflict`. A load's publish then
  reads the row again, and finds its write only while the pointer still names its generation and the row's `pointerId`
  is its own write's; overtaken by a newer load, it reports `superseded`, and its `segment.load-refused` event carries
  `unanswered: true`, as after a write with no answer. So does the refusal of a load that lost an ordinary race at the
  registry, since the driver cannot see its client's retry. A rollback reads the row again too, and goes on only when
  the pointer is at its target over a token it sent. The tag is there because the client's own retry has no per-request
  switch. That retry sends a write again after a `503 ServerBusy` or a `500 OperationTimedOut`. A load whose row write
  gets no answer reads the row and sends a fresh compare-and-swap from it, at most three times, and that policy runs
  under each: a registry that never answers costs up to four times the policy's tries before the load throws
  `TransientError` and keeps its object: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s
  between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that
  schedule, not measured).
- **Set `readTimeoutMs` to bound a read that stalls.** No client setting does: the SDK's per-try timer stops once the
  response headers arrive, so a body that stalls after them holds the read as long as the connection stays open. With
  `readTimeoutMs` set, each read request (a range read, a tail read's properties and its download, a registry row's
  read) that has not finished, body included, in that many ms is aborted and throws `TransientError`, which the
  store's read retry runs again. It is off unless you set it. The clock starts at the call into the SDK, so waiting
  for a socket or a credential's token counts. Writes, deletes and listings are not timed.
- **The driver redacts the credentials it recognises from an error before it throws it.** The SDK keeps the signed request on `err.request` and `err.response.request`: the `Authorization` header (`SharedKey <account>:<signature>`, or a bearer token), with a SAS credential the `sig=` in its URL, and any header your pipeline adds (a cookie, an API key, a customer-provided key). It puts the response's headers and the body it parsed in `err.details`, the fields it does not know included, and makes a body it does not parse (a proxy's HTML page) the error's message as it came, so a 403 can quote the string Azure signed, which lists every `x-ms-` header with its value, a 400 `InvalidHeaderValue` the value it refused, and a proxy's page or a gateway's body the request's headers. In the error the driver throws, the value under a credential's name is replaced by `[redacted]` (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-ms-copy-source-authorization`, `x-ms-encryption-key`, `x-ms-source-encryption-key`, `x-identity-header`, `signature`, `sig`, and the SDK's `encryptionKey`, `accountKey` and an access token's `token`, matched whole), and so are the value after one in a flat header list or under one in a map, and the value beside one in a record: the `...Value` beside a `...Name` (Azure's `HeaderName` and `HeaderValue`, a `{ name, value }` pair), in a record that describes an error a `value` beside a credential's name in any field, and, in a record that describes no error (no `code`, `errorCode` or `message`), a header table row's other cell (`{ th, td }`) and the same index of a parallel list, with a number, a boolean, `code`, `errorCode` and `message` kept. In its text these are redacted: a credential header line (`Authorization`, `Proxy-Authorization`, `x-ms-copy-source-authorization`, a cookie, `x-api-key`, `x-ms-encryption-key`, `x-ms-source-encryption-key`), at the start of any line, which is how the string to sign lists them; an `Authorization` value, a cookie, a customer-provided key, an API key or a connection string's `AccountKey` after its name anywhere (`name: value`, `name=value`, JSON); a `SharedKey` or `Bearer` value anywhere; a JWT on its own (an access token without its scheme); a SAS `sig=` value (percent-encoded, JSON-escaped or quoted too); the signature Azure quotes in a 403 body (`The MAC signature found in the HTTP request '…'`); and the text of the cell after one that names a credential (a `<th>`/`<td>` row, a `<dt>`/`<dd>` pair, an XML `<Name>`/`<Value>`, after a heading or a caption too). A key that quotes a credential is redacted as text. A credential in another form is not recognised (a header table laid out by column, a colon written as an HTML entity, an element named for a credential in a body the SDK did not parse, a `sig` percent-encoded twice, a user and password written into a URL), and a text too large for these patterns is replaced whole. An SDK error that carries its transport or shows a credential, and every error it reaches (its `cause` chain, an `AggregateError`'s `errors`), is thrown as a copy: a native error with the same prototype (`instanceof RestError` holds), message, stack, `code`, `statusCode` and `details`, so classification is unchanged, without `request` and `response`, any function or accessor property, a class instance other than an error, a named property of a list, map or set, or anything nested deeper than ten levels. The live error is never changed, and an error that holds only plain data and shows no credential is thrown as it is.
- **Price it with `storage.requestsPerSizedRead: 2`.** A pointer read is one GET here, as on S3 and GCS, but a
  segment's tail read is two requests, its properties and then its bytes, because Azure Blob takes no suffix range. The download is conditional on the properties' ETag, so a blob
  replaced between the two is read again once, and a second replacement is a `TransientError`. Set it in the pricing profile you give `estimateCost` or `groundedReport` from `@cloudbitmaps/tools`, and leave
  `requestsPerPointerRead` at 1.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item, and the ones every backend shares: a request timeout on your client, backups of the data and the registry, and a schedule for your loads.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
