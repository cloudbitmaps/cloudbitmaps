# @cloudbitmaps/gcs

**Google Cloud Storage for [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps).** One bucket holds your generations and their pointers, so there is no
second service to run.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. These docs describe `main`, ahead of the npm release.

## Install

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/gcs
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

`@google-cloud/storage` (`^7 || ^8`) is a real dependency of this package, so installing it is the whole step.
`@cloudbitmaps/core`, the engine underneath, arrives with it and you never name it.

## Use

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { GcsStorage } from '@cloudbitmaps/gcs';

const store = new CloudRoaring({
  storage: new GcsStorage({ bucket: 'bitmaps', prefix: 'cr' }),
});

await store.load({ segment: 'active-users' }, [1, 2, 3]);
await store.segment('active-users').has(2); // true
```

It builds its own client from Application Default Credentials. Any other key is refused by name.

| Option | What it does |
|---|---|
| `bucket` (required) | the bucket |
| `prefix` | a key prefix for everything this store writes |
| `client` | your own `Storage` client. Pass it as `client`; `storage` is refused, since in `CloudRoaring` that word means the backend. Build it with `retryOptions: { autoRetry: false }` (see below) |
| `projectId`, `apiEndpoint` | build a client for you, such as one for fake-gcs-server; refused beside `client` |
| `simpleUploadThresholdBytes`, `maxObjectBytes` | the size up to which an object is one simple request (default 8 MiB) and the largest object (default 5 TiB, GCS's maximum) |
| `readTimeoutMs` | cut off a read that has run this long, in milliseconds (see below); `0`, the default, sets no timeout |

## Before production

- **This backend is outside the validated envelope.** It passes the same conformance suites as S3, but the proven
  scale and the calibration were done on S3. You are an early user.
- **Grant the bucket's object permissions.** The library creates, reads, lists and deletes objects:
  `roles/storage.objectAdmin` covers all four.
- **The write-once guarantee rides GCS preconditions** (`ifGenerationMatch`), so nothing else needs enabling.
- **Never add a lifecycle rule that expires current objects or the `registry/` prefix.**
- **The SDK does not retry downloads; the driver does.** In `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0 and
  8.1.0), a download the SDK retries after any status it retries (408, 429, 500, 502, 503 or 504) can crash the process with
  `ERR_STREAM_UNABLE_TO_PIPE`, thrown outside any promise, even though the retried request succeeded. The client
  `GcsStorage` builds therefore sends each download once, and the driver runs a download again itself, up to three
  more times with backoff, after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504, and after nothing else (not a missing credentials file or a TLS failure). That holds for every
  caller, including a store built with `retry: false`. The client's other requests (uploads, listings, metadata reads)
  keep the SDK's retries. **A client you pass as `client` is used as it is, so build it with
  `retryOptions: { autoRetry: false }`.** That also turns off the SDK's retries of listings, metadata reads and
  resumable uploads on that client, which the library does not retry; the client `GcsStorage` builds keeps them.
- **A client `timeout` does not bound a download on `@google-cloud/storage` 8.x**, so a read whose server stalls waits
  for it. Measured against a local server that never answers: still pending after 12 s with `timeout: 2000`.
  **`readTimeoutMs` does, and it is off unless you set it.** It bounds each read as a whole: a generation's tail (with
  the metadata read it falls back on for an empty object), a range of it, or a registry row. One deadline covers every
  attempt the driver makes and the backoff between them, from the call into the driver (a credential fetch and any
  wait for a socket count) to the end of the body. It counts time the process spends busy too: Node runs a due timer
  before it reads a socket, so a synchronous stretch longer than the timeout fails the reads in flight even when their
  responses have arrived. When it passes, the read throws `TransientError` naming the read and the timeout, and no
  further attempt starts; the store's read retry runs it again, so with `readTimeoutMs: 2_000` a read that stalls on
  every attempt fails after about 8.35 s (4 × 2 s plus up to 0.35 s of backoff; measured: 8.1 to 8.2 s). Uploads,
  deletes and listings are not timed.
- **A read that times out before its server answers leaves its connection open.** The SDK cannot cancel a request
  whose response has not begun, so that request holds its connection until the server answers or closes it, and until
  then keeps a Node process from exiting: one per driver read, up to four per call through the store's retry, so an
  outage at N reads a second adds about 4N held connections each second. On 8.x a read cut off after its response
  began closes its own; on 7.x (checked on 7.22.0) it stays open too. A 404 whose error body arrives after the
  deadline is reported as a `TransientError`, not `NotFoundError`.
- **Downloads go out on Node's global agent, so one the driver cuts off or refuses resets nothing else.** When a
  download fails part-way, the SDK destroys the HTTP agent it went out on, and its own agent is one keep-alive pool the
  whole process shares, so every other request in flight would be reset with it, uploads included. The SDK never
  destroys the global agent. Measured on 8.1.0 with no timeout: a body cut off part-way reset a 64-byte upload and a
  registry write on a second backend on the SDK's agent, and on the global agent all of them completed. The cost: the
  global agent closes a connection idle for 5 seconds (the SDK's own pool does not), so a read after a longer pause
  opens a new connection, with its TCP and TLS handshake, and downloads share that agent with any other `http` or
  `https` request in the process. Raising `https.globalAgent.options.timeout` keeps idle connections longer.
- **A transient failure of a write throws `TransientError`, and the write may or may not have landed.** Re-run the
  call, or check `store.generations(ref)`. The driver sends each registry write once; a load that gets no answer reads
  the row and sends a fresh compare-and-swap from it, at most three times. A generation's object of up to
  `simpleUploadThresholdBytes` is sent again, up to three more times, only after a `429` or `503`; every object carries
  a random id in its metadata, so a first send that landed is told from another writer's object. A load whose row writes
  all go unanswered throws `TransientError` and keeps its object. The waits before an object's re-sends use real
  timers: the store's injected clock does not reach them, and `GcsStorage` takes no clock, so a test that throttles
  one object write three times waits about 3.5 s at most (the publish's waits before a fresh row write do use the
  store's clock).

The [production checklist](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md) covers each item, and the ones every backend shares: backups of the data and the registry, and a schedule for your loads.

## Documentation

- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Before production](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/production.md)
- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
