# @cloudbitmaps/s3

**S3 storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One bucket holds your generations and their pointers, so there is no second
service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. On npm these docs match the version they ship in; on GitHub they describe `main`, and the changelog says what each release changed.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3
```

`roaring` needs its one install script to fetch its native binary, and newer clients run a dependency's script only if you allow it. Allow it before you install:

- **npm 12:** add `{ "allowScripts": { "roaring": true } }` to your `package.json`. Without it the install exits 0 and the package throws at `import`. npm 11 runs the script but warns until you allow it the same way.
- **pnpm 11 and later:** put `allowBuilds: { roaring: true }` in a `pnpm-workspace.yaml` beside your `package.json`. Those versions no longer read the `package.json` `pnpm` key. Without it the install exits 1 with `ERR_PNPM_IGNORED_BUILDS`.
- **pnpm 10:** add `{ "pnpm": { "onlyBuiltDependencies": ["roaring"] } }` to your `package.json`. Without it the install exits 0 and the package throws at `import`.
- **pnpm 9:** nothing extra.

[Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

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
| `maxSockets` | most sockets the client you do not pass opens at once, for `https` and plain `http` alike; a positive integer, default 128 (the SDK's own is 50; if a future SDK changes its handler, the built client keeps the SDK's own limit); refused beside `client` |
| `partBytes`, `maxObjectBytes` | multipart sizing: part size (default 8 MiB; the upload buffers one part at a time and copies it into one body to send it, so it holds up to about twice the part size at a flush, 16 MiB at the default, derived from the driver's code) and the largest object (about 78 GiB by default, up to S3's 5 TiB). A cap above 5 TiB, or a part above S3's 5 GiB part limit, is a `ValidationError` |
| `readTimeoutMs` | how long one read (a `GetObject` or `HeadObject`, its body included) may take before it throws `TransientError` and the store retries it; `0`, the default, sets no timeout. Writes are not timed |
| `conditionalDelete` | whether the store applies `If-Match` on a `DeleteObject`: the registry then removes a deleted row rather than leaving a tombstone, and the storage half deletes an erasure's holder only while it is the object the erasure read, by its ETag. On by default when the host the client resolves is an AWS S3 host, however its endpoint was set (`endpoint`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, the shared config file); off for any other host: set it for an S3-compatible store only once you know it applies the header (MinIO ignores it) |

## Before production

- **Run `await store.preflight()` once before the first load.** It reads the registry, writes one probe object, writes the
  same key again (which must be refused), reads it back, lists it, deletes it and checks the lifecycle rules, with
  `s3:ListBucket`, `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`, and `s3:GetLifecycleConfiguration` for the last. It does
  not check `s3:AbortMultipartUpload`, the registry's `If-Match`, or a read after a delete, among others: [the full list](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#what-preflight-does-not-check). It
  shows an SDK of 3.640.0 or older as a `write-once` problem, and cannot see one from 3.641.0 to 3.699.0, so the floor below stays yours to check. The probe sits at `<prefix>cbm.due.preflight/`, outside your application's namespaces: a grant scoped per namespace shows as a `write` problem, and as a `registry` problem too when the registry grant is scoped per namespace.
- **The bucket must honor conditional writes**: `If-None-Match: *` for a write-once generation and `If-Match` for the
  pointer. AWS S3 does, and the test suite runs against MinIO. Another S3-compatible service that ignores the headers
  turns write-once into overwrite, so check yours before you depend on it. It must also be strongly consistent: a read
  or a listing made after a write or a delete returns sees it. AWS S3 is.
- **Use `@aws-sdk/client-s3` 3.700.0 or later** if you pin the SDK or pass your own `client`. This floor is a
  correctness floor, not a preference. An SDK sends only the conditional headers it models, and drops one it does
  not, without an error. `If-None-Match`, which write-once is built on, is modelled from 3.641.0: measured against
  MinIO, 3.640.0 silently overwrites an existing object, which loses a published generation. `If-Match` on
  `PutObject`, which the registry's compare-and-swap is built on, is modelled from 3.700.0: 3.699.0's serializer
  omits it, so a fenced row write goes out unconditionally and can land over a concurrent writer's. This package's
  own range never resolves below 3.700.0. The registry also checks, before its first request, that the client it is given sends `If-None-Match` and
  `If-Match` on `PutObject`, and refuses a registry write it would send without its precondition; a client that does
  not send `If-Match` on `DeleteObject` turns `conditionalDelete` off.
- **Grant `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListBucket`.** Without
  `s3:ListBucket`, S3 answers a missing key with `403` instead of `404`.
- **Add a lifecycle rule that aborts incomplete multipart uploads**, and never one that expires current objects or the
  `registry/` prefix. An expired registry row takes the segment's pointer with it, and the token every publish is fenced
  on, so its generations look unreferenced; an expired generation makes a live segment unreadable
  ([bucket lifecycle](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#bucket-lifecycle)).
- **Check the bucket's lifecycle rules with `await backend.checkLifecycle()`.** It reads the configuration with one
  request (bounded by `readTimeoutMs`, when set) and answers `ok`, `problem` (an enabled, untagged rule over your prefix that expires current objects or moves
  them to `GLACIER`, `DEEP_ARCHIVE` or a class it does not know) or `unchecked`. It needs `s3:GetLifecycleConfiguration`, which a load never uses and
  `store.preflight()`'s lifecycle step does: without it the answer is `unchecked`, naming the permission. A missing abort-incomplete-upload rule is
  advice in `detail`, never a `problem`
  ([check the lifecycle rules from code](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md#check-the-lifecycle-rules-from-code)).
- **A transient failure of a write throws `TransientError`, and the write may or may not have landed.** Re-run the call,
  or check `store.generations(ref)`. The SDK's own retry is off for conditional writes, so a write that landed is not
  reported as a conflict. The driver [sends each registry write
  once](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/correctness.md#sdk-retry); a load that gets no
  answer [reads the row and sends a fresh compare-and-swap from
  it](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/correctness.md#row-write-settled), at most three
  times. A generation's object is sent again, up to three more times, only after a `503` (`SlowDown` is the usual one);
  it carries a random id in its user metadata (`x-amz-meta-cbwid`), so a first send that landed is told from another
  writer's object. A load whose row writes all go unanswered throws `TransientError` and keeps its object. The waits
  before an object's re-sends use real timers: the store's injected clock does not reach them, and `S3Storage` takes no
  clock, so a test that throttles one object write three times waits about 3.5 s at most (the publish's waits before a
  fresh row write do use the store's clock). **A bare `429`** (AWS S3 does not send one; some S3-compatible services do)
  **is not retried and is not classified transient**: it surfaces as the SDK's own error, so a layer of yours that keys
  on `TransientError` will not retry it.
- **Reads can be timed, and writes are not.** Nothing is timed unless you set `readTimeoutMs`. Set, a read that has
  not finished in that many ms throws `TransientError`, and the store runs it again; AWS's guidance is to retry a GET
  of under 512 KB after about 2 seconds. The timer covers the body as well, so a connection that sends its headers and
  then stalls is cut off too. It starts when the read is handed to the SDK, so a burst of reads larger than the
  built client's socket pool (128 by default) can time out while queued: set it above that queueing, or raise `maxSockets`
  (a `client` you pass carries its own pool).
  For the writes and listings, give your client a timeout of its own.

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item, with a sample IAM policy, and the ones every backend shares: a request timeout on your client for the requests the library does not time, backups of the data and the registry, and a schedule for your loads.
- **The driver redacts the credentials it recognises from an error before it throws it.** The AWS SDK keeps the
  response it got on the error (`$response`), and through its socket the request it sent, with the signed
  `Authorization` header and `x-amz-security-token`. It also puts every field of the error body on the error, and S3
  quotes the request back when it refuses it: its signature and canonical request (`SignatureDoesNotMatch`), or its
  session token (`Token-0`, on `ExpiredToken` and `InvalidToken`). In the error the driver throws, the value under a
  credential header or field name is replaced by `[redacted]` (`authorization`, `x-amz-security-token`,
  `x-amz-s3session-token`, an SSE-C key, `SignatureProvided`, `CanonicalRequest`, `Token-0` and the like; the access
  key id S3 names is kept), and so are the value beside a credential's name in a list or a record (a table row that
  parses to `{ th, td }` with one name and one value, a `{ name, value }` pair, `ArgumentName` and `ArgumentValue`), a credential header line, a SigV4 signature
  (`Signature=`, `X-Amz-Signature=`) and a session token or SSE-C key after its header name, anywhere in its text. A
  credential in another form is not recognised, and a text too large for these patterns is replaced whole. An SDK
  error that carries its transport or shows a credential, and every error it reaches (its `cause` chain, an
  `AggregateError`'s `errors`), is thrown as a copy: a native error with the same prototype, name, message, stack,
  `$metadata`, `$fault`, `Code` and request id, so classification is unchanged, without `$response`, the body the SDK
  could not parse (`$responseBodyText`), any function or accessor property, or anything nested deeper than ten levels.
  The live error is never changed, and an error with no transport and no credential in it is thrown as it is.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
