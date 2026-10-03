# Before production

A first run on `MemoryStorage` needs none of this. A deployment that other people depend on does. This page is the
checklist: work down the table, and follow each link for the detail.

| Check | Why it matters | Where |
|---|---|---|
| Permissions are granted for the actions the library issues | A missing action fails a load or, on S3, turns a missing pointer into a `403` | [Permissions](#permissions) |
| An abort rule for incomplete uploads is on the bucket | A killed process leaves multipart parts that are billed but invisible | [Bucket lifecycle](#bucket-lifecycle) |
| Nothing expires current objects or the `registry/` prefix | An expired pointer or generation makes a live segment unreadable | [Bucket lifecycle](#bucket-lifecycle) |
| Versioning and backups cover the data and the pointers | A restore must bring both back to the same point in time | [Versioning and backups](#versioning-and-backups) |
| With versioning on, noncurrent versions expire after your restore window | Each generation a load collects is otherwise billed for as long as the bucket keeps it, out of sight | [Bucket lifecycle](#bucket-lifecycle) |
| The bucket honors conditional writes, and the S3 SDK is 3.645.0 or later | Otherwise a write-once generation can be silently overwritten | [Conditional writes and the S3 SDK](#conditional-writes-and-the-s3-sdk) |
| Your reads have a timeout | Without one a hung request hangs its call. `readTimeoutMs` on `S3Storage` and `AzureBlobStorage` bounds each read, and is off by default; on Azure Blob it is the only bound on a download's body, which no client setting reaches. On GCS 8.x nothing bounds a download's body. The library times no write, delete or listing | [Reliability](#reliability-retries-backoff--timeouts) |
| Your job re-runs a write after a transient error | Writes are never retried for you | [Reliability](#reliability-retries-backoff--timeouts) |
| You know the request budget and the memory ceilings | A runaway call is refused, not billed | [Limits](#limits-the-per-op-budget-and-the-memory-ceilings) |
| The keystore is backed up, if you encrypt | Losing the key makes the data permanently unreadable | [Encryption](encryption.md#before-you-encrypt) |
| Metrics and audit sinks are wired to your stack | Both are off by default | [Observability](observability.md) |
| Loads and the retention sweep are scheduled | Nothing in the library runs on a timer | [Schedule the work](#schedule-the-work) |
| Loads run off the request path, on a runtime with the native addon | A load uses a core and holds a whole segment in memory | [Where to run it](#what-blocks-the-event-loop-and-where-to-run-it) |

## Permissions

These lists are derived from the calls each storage package makes. Check them in staging under the identity you will
run with. A process that only reads can drop the write and delete actions.

**S3.** Five actions, on two resources:

| Resource | Actions |
|---|---|
| The bucket | `s3:ListBucket` |
| The objects under your `prefix` | `s3:GetObject` (also covers the metadata reads), `s3:PutObject` (also covers starting, uploading and completing a multipart upload), `s3:DeleteObject`, `s3:AbortMultipartUpload` |

In the policy, the bucket is the bucket's ARN, and the objects are that ARN followed by `/`, the `prefix` you pass to
`S3Storage`, and `/*`. `s3:ListBucket` matters even for readers: without it S3 answers a missing key with `403`
instead of `404`, and the library cannot list generations.

If the bucket encrypts with a KMS key, grant that key's use as well.

**GCS.** The library creates, reads, lists and deletes objects. `roles/storage.objectAdmin` on the bucket covers all
four; a custom role needs `storage.objects.create`, `storage.objects.get`, `storage.objects.list` and
`storage.objects.delete`. Credentials come from Application Default Credentials unless you pass a `client`.

**Azure Blob.** It writes blocks, commits block lists, reads blobs and their properties, lists and deletes. The
`Storage Blob Data Contributor` role on the container covers all of them. A connection string carries the account
key, which grants far more: prefer a `containerClient` built from a managed identity.

## Bucket lifecycle

Two rules to add, and one to never add.

**Add: abort incomplete multipart uploads.** A large generation is written as a multipart upload. The library aborts
it on any error it survives to handle. It cannot abort one whose process no longer exists, so a killed container or
an out-of-memory exit leaves the parts behind. Those parts are billed and never appear in an object listing, so only
the bill will tell you. On S3, with a few days as the grace period:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
    }
  ]
}
```

Applying a lifecycle configuration replaces the bucket's whole configuration, so merge this with any rules you have.
This rule is for S3. What a dead writer leaves on GCS and Azure Blob, and when each cloud removes it, is in [the backup checklist](disaster-recovery.md#backup-checklist).

**Add, if versioning is on: expire noncurrent versions.** With versioning on, every generation a load collects stays
in the bucket as a noncurrent version: billed, and absent from an ordinary listing. A rule that expires noncurrent
versions after a number of days removes them. A restore to a time `T` needs every object deleted since `T`, so those
days are also the oldest point you can restore to: set them at or above your restore window
([the backup checklist](disaster-recovery.md#backup-checklist)). On S3, as a second rule in the same configuration:

```json
{
  "ID": "expire-noncurrent-versions",
  "Status": "Enabled",
  "Filter": { "Prefix": "" },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
}
```

**Add, if versioning is on: remove expired delete markers on the registry prefix.** Where the registry removes a row
(`conditionalDelete`), a delete in a versioned bucket leaves a delete marker, not an absence. Once the noncurrent
versions beneath it expire, the marker is all that is left of the name: one per name ever purged, which every listing
of the prefix steps over. A rule that removes expired delete markers is the last piece of the recipe, scoped to the
registry prefix (`<prefix>registry/` on a backend built with a `prefix`), as a third rule in the same configuration:

```json
{
  "ID": "expire-registry-delete-markers",
  "Status": "Enabled",
  "Filter": { "Prefix": "registry/" },
  "Expiration": { "ExpiredObjectDeleteMarker": true }
}
```

It cannot touch a live row: S3 removes a delete marker only when no version remains under it. A create over a delete
marker (`If-None-Match: *`) is one the registry makes whenever a purged name is loaded again, and the probe in
`tests/integration/real-cloud-conditional-delete.test.ts`, run against a versioned bucket, checks that S3 and GCS accept
it.

**Never: expire current objects.** No rule may delete current generations, and no rule may delete current versions
under the `registry/` prefix. A rule cannot tell a live row from a tombstone or from a due-index pointer, and an
expired live row is a pointer lost: every generation it named looks unreferenced. Where the registry removes a row
itself, it removes only the version it judged, by a conditional delete. A rule on noncurrent versions only is safe, and is the optional recipe in
[the disaster-recovery guide](disaster-recovery.md#optional-make-a-shred-durable-with-a-registry-expiry-rule).

## Versioning and backups

The data, the pointers and, if you encrypt, the keys are three separate stores, and a restore must bring them back
at the same point in time. [The disaster-recovery backup checklist](disaster-recovery.md#backup-checklist) says what
to turn on for each, and [`checkConsistency()`](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic)
verifies a restore before you serve traffic.

## Conditional writes and the S3 SDK

The library's guarantee that a generation is write-once rests on conditional writes: `If-None-Match: *` for a new
object and `If-Match` for the pointer.

- **The bucket must honor them.** AWS S3 does, and the test suite runs against MinIO. Another S3-compatible service
  that ignores the headers turns write-once into overwrite, so check yours before you depend on it. GCS and Azure
  Blob use their own equivalents (`ifGenerationMatch`; `If-None-Match` and `If-Match`).
- **Use `@aws-sdk/client-s3` 3.645.0 or later if you pass your own `client`.** Measured against MinIO, 3.640.0
  silently overwrites an existing object, which loses a published generation without an error. `@cloudbitmaps/s3`
  never resolves its own SDK below the floor. If your own code imports the SDK, to build that `client`, add it to your own `package.json` too: pnpm does not let your code import a dependency of a dependency.
- **The registry checks the SDK for the other headers it sends.** That floor is measured for `If-None-Match` alone. The
  registry's compare-and-swap sends `If-Match` on `PutObject`, and its conditional delete sends `If-Match` on
  `DeleteObject`, and an SDK drops a member its model lacks without a word. Before its first request the registry
  serialises each of the three through your client, sending nothing, and refuses a write the SDK would send without its
  precondition (`ValidationError`, naming the header) and tombstones instead of deleting when a `DeleteObject` would go
  out without `If-Match`. If you see that error, upgrade `@aws-sdk/client-s3`.

## Reliability: retries, backoff & timeouts

**Reads retry by themselves.** Cloud storage throttles, returns 5xx and drops connections. Every read that answers a
query retries those transient faults with bounded exponential backoff and full jitter: `has`, `count`, `iterate`
and the combines (the `*Into` verbs' reads of their operands included), a pinned handle's reads, and `pin()` itself.
It is on by default.

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: backend }); // reads already retry
```

Tune the policy, or turn it off. The policy is partial, so name only what you change; `onRetry` goes in the same group:

```ts
const store = new CloudRoaring({
  storage: backend, // an S3Storage, GcsStorage, ...
  retry: {
    maxAttempts: 6,
    onRetry: ({ attempt, delayMs }) => log.warn({ attempt, delayMs }, 'retrying transient fault'),
  },
  // or `retry: false` when something else retries your reads (a GCS download is retried by the driver either way)
});
```

**On GCS the driver retries downloads, and the SDK should not.** In `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0
and 8.1.0), a download the SDK retries after any status it retries (408, 429, 500, 502, 503 or 504) can crash the process with
`ERR_STREAM_UNABLE_TO_PIPE`, thrown outside any promise, even though the retried request succeeded. The client
`GcsStorage` builds sends each download once, and the driver runs it again itself, up to three more times with
backoff, after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504, and after nothing else (not a missing credentials file or a TLS failure), so a download is retried whichever
call made it and whether or not the store's own `retry` is on. What still fails after those attempts is a
`TransientError`, which the store's read retry, above, can run again. The client's other requests keep the SDK's
retries. A `client` you pass is used as it is: build it with `retryOptions: { autoRetry: false }`. That also turns off
the SDK's retries of listings, metadata reads and resumable uploads on that client, which the library does not
retry; the client `GcsStorage` builds keeps them and needs nothing.

**A GCS client's `timeout` does not bound a download** on `@google-cloud/storage` 8.x: the SDK hands it to an HTTP
client that has no such option. Measured against a local server that accepts a read and never answers, a read through
a client built with `timeout: 2000` was still pending after 12 s, and one through the default client after 75 s. So
nothing bounds a stalled GCS read today; the timeouts below apply to S3 and Azure Blob.

**Nor does an Azure Blob client's timeout bound a body that stalls.** The SDK's per-try timer stops once the response
headers arrive, and `retryOptions.tryTimeoutInMs` is the timeout it asks the service to apply. Measured against a local
server that sends a registry pointer's headers and then nothing, a read through a client set with `tryTimeoutInMs: 500`
was still pending after 2.5 s.

**`readTimeoutMs` bounds an Azure Blob read, when you set it.** It is off by default. Set, each read request either
half of `AzureBlobStorage` sends, a range read, a tail read's properties and its ranged download, each on its own, and
a registry row's read, has that many ms to finish, the response body included, or it is aborted and throws
`TransientError`, which the store's read retry runs again. Measured against a local server that stalls before the
headers, after them or part-way through the body, a range read, a tail read and a registry read with
`readTimeoutMs: 300` each failed 300 to 321 ms after the call, and the server saw the connection close. The clock
starts at the call into the SDK, so time waiting for a socket and for a token credential's token counts; the HTTP agent
the SDK builds sets no limit on sockets (twenty reads at once opened twenty connections), so a client of the SDK's own
making does not queue a read for one. It counts time the process spends busy too: Node runs a due timer before it reads
a socket, so a synchronous stretch longer than the timeout fails the reads in flight even when their responses have
arrived. Writes, block commits, deletes and listings are not timed.

**The timer covers the client's own retries of a request, and the Azure SDK's are slow.** Its default policy retries a
500 or a 503 at once, then after 4 s, then after 12 s, so a `readTimeoutMs` under 4 s cuts it off after two tries,
and a throttled read throws the timeout rather than the 503. The store's read retry then runs the read again: against a
stub answering two 503s and then the data, a read with `readTimeoutMs: 2_000` timed out after 2.0 s, and `has()` through
the store returned after 4.0 s, as it did with the timeout off.

```ts
const backend = new AzureBlobStorage({ containerClient, readTimeoutMs: 2_000 });
```

Only transient faults (they surface as `TransientError`) are retried. Errors that retrying cannot fix are never
retried: `ValidationError`, `IntegrityError`, `NotFoundError` and `WriteConflictError`.

**S3 reads can be timed.** `@cloudbitmaps/s3` takes `readTimeoutMs`, which is off (`0`) unless you set it. Set, it
gives each read the backend sends, every `GetObject` and `HeadObject` of a generation or a pointer, that many ms to
finish, the SDK's own retries of it and the response body included, so a connection that sends its headers and then
stops is cut off as well. A read that runs out of time throws `TransientError`, which the store's read retry, above,
runs again, and its request is aborted, which frees the connection. AWS's S3 guidance is to retry a GET of under
512 KB that has not answered in about 2 seconds. With `readTimeoutMs: 2_000` and the default retry policy, a read
whose request stalls on every attempt fails with `TransientError` after 4 × 2,000 ms of timeouts plus up to 350 ms of
backoff, about 8.35 s, rather than hanging. That bound is derived, not measured: four attempts, waits of up to 50, 100
and 200 ms between them, and one timed-out request per attempt; any request earlier in the same attempt that did
answer adds its own time.

```ts
import { S3Storage } from '@cloudbitmaps/s3';

const backend = new S3Storage({ bucket: 'my-bitmaps', readTimeoutMs: 2_000 }); // 0, the default, sets no timeout
```

**The clock starts when the read is handed to the SDK**, not when it reaches the wire. It counts the time the read
waits for one of the client's sockets (50 by default) and the time spent fetching credentials, and under
`retryMode: 'adaptive'` the SDK's rate-limiter wait. So a burst of concurrent reads larger than the socket pool can
time out with nothing slow on the wire: measured against a local stub that answers each request in 50 ms, 8,000
concurrent `has()` calls with `readTimeoutMs: 2_000` lost most of their reads to the timeout. It counts time the process spends
busy too: Node runs a due timer before it reads a socket, so a synchronous stretch longer than the timeout fails the
reads in flight even when their responses have arrived. Size `readTimeoutMs` above the
worst queueing your concurrency implies, which is about the concurrent reads divided by the sockets, times what one
read takes (8,000 ÷ 50 × 50 ms is 8 s; derived), or raise the client's `maxSockets`:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ httpsAgent: { maxSockets: 200 } }),
});
```

Raise it too on a link too slow to deliver a read inside the timeout, since such a read fails on every attempt. The
timer is set on each request rather than on the client, so a `client` you pass gets it without being changed. On a
client built with `cacheMiddleware: true`, a timed read resolves its middleware each time, since the SDK reuses a
cached handler only for a request sent with no options.

**Set a timeout on your S3 client for the rest.** `readTimeoutMs`, above, times reads and nothing else: the library
times no write, because a write abandoned in flight can still land after it was given up on, and it times no delete
or listing on any backend, nor any GCS request. On S3 a timeout on your client turns a hung write or listing into a
transient fault, which for a write is yours to re-run. Build the client with the timeout and pass it to the backend:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ connectionTimeout: 1_000, socketTimeout: 30_000 }),
});
const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'my-bitmaps', client }) });
```

`socketTimeout` ends a request whose connection has carried nothing for that long, so an upload that is still sending is
left alone. `requestTimeout` on its own only logs a warning when it passes: checked on `@smithy/node-http-handler`
4.12.1 against a stub endpoint, it ends the request only with `throwOnRequestTimeout: true` beside it.
`@smithy/node-http-handler` comes with the AWS SDK; declare it in your own `package.json` as well, since your code
imports it. A `client` carries its own region and credentials, so passing `region` or `credentials` beside it is refused.

**Writes are yours to re-run.** What is retried for you:

| Calls | Retried for you? |
|---|---|
| Reads that answer a query: `has`, `count`, `iterate`, the combines (the `*Into` verbs' reads of their operands included), a pinned handle's reads, and `pin()` | Yes, with backoff; `retry` tunes it |
| Writes: `load`, the write half of the `*Into` verbs, and the lifecycle helpers (`eraseSubject`, `dropSegment`, `retireExpired`, `rollback` and the rest) | No: run the call again. The reads they make along the way are retried, with backoff: a load guard's read of the current generation, and an erasure's reads of the generation it rewrites, of the one it wrote, and of any other that may still hold the id |
| Registry reads and listings: `exists`, `segments`, `generations`, `getRetention`, and the registry scan that `subjectReport`, `exportSegments` and `checkConsistency` start from | No: call it again |

A write that lands and then loses its response looks, from the error alone, like a write that failed, and replaying it
would find itself already there and report a conflict. So a transient fault on a write reaches you, and the retry is
yours.

Re-running a `load` is safe. It takes a fresh generation number and re-reads the pointer, so it publishes whether or
not the first attempt landed, under every guard setting. Three things to know:

- **Pass the ids again, fresh.** An iterator the first attempt used up yields nothing the second time, and an empty
  load can publish: with `allowEmpty: true`, or onto a segment that holds no data.
- **A late write reads as a lost race.** A request that timed out on your client can still land while the re-run is
  under way, and the re-run then reports `superseded`. On a `superseded` right after a transient fault, check before
  you re-derive, and run the load again if your ids are not current.
- **Every attempt that landed takes a `keep` slot.** The default `keep: 1` then collects the generation the segment
  held before the load. To keep that one as a rollback or pin target, pass a `keep` one above the number of attempts
  that landed: `keep: 2` after one. See [Generations and `keep`](loading.md#generations-and-keep).

To learn whether an attempt landed, check instead of replaying: compare `store.generations(ref)` with what it listed
before the call. A new current generation is a publish that landed. A new one above the current is an object that
landed unpublished. While another writer is active on the segment, the listing cannot say whose either one is.
`generations` is not retried either, so a fault there means asking again.

## Schedule the work

The library starts no timer, so it behaves the same in a Lambda and on a server. Two things need a schedule from you:

- **Loads.** Run each `store.load` from a scheduled job or a queue consumer, at the cadence your data needs. A shorter
  cadence is how you get fresher data. See [Loading in depth](loading.md).
- **The retention sweep.** If you record expiries with `setRetention`, call `store.retireExpired()` on a schedule.
  Nothing else removes expired segments. See [Retention](retention.md).

## Limits: the per-op budget and the memory ceilings

Two separate limits protect you. It helps to know which one you hit.

| | `budget` | the memory ceilings |
| --- | --- | --- |
| bounds | **cost**: backend requests a single operation may fan out into | **memory**: what a process holds resident, whatever the segments' size |
| knobs | `budget: { maxRequests }`; `false` disables it | `cache.maxChunks` (decoded cached chunks, default 1024) · `cache.readerMax` / `cache.readerMaxBytes` (open `.crbm` indices, default 1024 / 64 MiB) · the combines' `concurrency` window · the per-chunk decode cap. **`budget: false` lifts none of them.** |
| covers | `count` · `iterate` · the combines · `subjectReport` · `eraseSubject` | every read, on every backend |

### The request budget

On a shared or serverless backend, one runaway call can quietly run up a large bill: an `intersect` over two enormous
barely-overlapping segments, a wide `union`, or a fleet-wide `eraseSubject`. The library caps the number of backend
calls one operation may fan out to and throws `BudgetExceededError` instead of running away. The cap is on by default
at 1,000,000 units. Lower it on untrusted or multi-tenant surfaces. Raise it, or pass `budget: false`, for trusted
bulk jobs.

```ts
import { CloudRoaring, BudgetExceededError } from '@cloudbitmaps/roaring';

// set your own store-wide ceiling:
const store = new CloudRoaring({ storage: backend, budget: { maxRequests: 50_000 } });
await store.load({ segment: 'huge' }, hugeIds);
await store.load({ segment: 'other' }, otherIds);

try {
  for await (const id of store.segment('huge').intersect([store.segment('other')])) {
    /* ... */
  }
} catch (e) {
  if (e instanceof BudgetExceededError) {
    // the operation would have fanned out past the ceiling; it was refused before doing the work
  }
}
```

The operations that take options (the combines, `subjectReport`, `eraseSubject`) accept a per-call override. A
partial override inherits the store ceiling; it never resets it to the default:

```ts
// tighten or lift the ceiling for one call:
await store.subjectReport(userId, { namespace: 'eu', budget: { maxRequests: 5_000 } });
for await (const _ of store.segment('huge').intersect([store.segment('other')], { budget: false })) {
  // a trusted batch job: no ceiling for this call
}
```

The ceiling is checked once, before the fan-out, against work whose size is already known, so it adds nothing to the
hot path. `has` is a single call and is never budgeted. The units are the chunk reads the operation will actually
issue. For an `intersect` that is the surviving keys times the operands present at each, plus only those excludes
that hold the key, so a large suppression list is not charged for keys it cannot affect. Bytes need no separate
limit, because every chunk read is size-capped by the safe deserializer. `count` on a loaded segment reads the
index with zero requests, so it approaches the ceiling only on a source that cannot serve cardinalities.

`eraseSubject` charges one unit per registered segment, and one for each generation it opens beyond the one the
row names. Only the enumeration can refuse the whole call. A segment that runs the budget out during the scan is
listed in the ledger with `erased: false` and an `error:` note, before anything of it is deleted, and the scan carries
on. Re-run with a higher `budget` to finish those segments. The ledger of the erasures that did happen is never lost.

### The memory ceilings

`intersect`'s budget is a product (surviving keys times operands), while its memory is a window
(`concurrency × operands × chunk`) that does not depend on segment size. A request budget cannot express a memory
bound, and `budget: false` ("I know my fan-out") must not silently also mean "unbounded RAM". A wide segment's parsed
index can reach about 1.3 MB (65,536 entries at 20 B), which is why the reader cache is bounded by bytes as well as by count. Lower
`cache.readerMaxBytes` for a memory-tight deployment, such as a 128 MB Lambda that reads across many wide segments.

**Neither limits how many ids a segment can hold.** A segment holds up to the full 32-bit id space, about 4.29
billion members. `maxScanSegments`, an option of `store.retireExpired` (`store.checkConsistency` holds the default of
250,000), counts segments, not members: 500 audience segments count as 500, whatever their size.

## What blocks the event loop, and where to run it

Node is single-threaded, so CPU-heavy work stalls **every** other request on that instance. Most of this library
is network-bound and irrelevant here — a `has()` spends a negligible fraction of its time on bit math — but a
**load** and an **erasure rewrite** are genuinely CPU-heavy, because each one touches a whole generation.
Measured on an Apple M3 Pro on 2026-09-30, the median of 20 runs, each in a fresh process:

| path | cost | longest single stall | where it belongs |
| --- | --- | --- | --- |
| a load, `store.load()` (1M ids spread across the id space, in-memory storage) | ~526 ms | **~24 ms** (47 ms at worst) | a batch job or worker; survivable off the request path |
| `eraseSubject` | decodes and re-encodes every chunk of the segment — same order of work as a load | yields on the same cadence | an admin job, never a request handler |
| `has` / `count` / `intersect` / `union` / `andNot` | microseconds of CPU; dominated by network | — | anywhere |

The **stall** column is the number that decides whether co-resident work survives, and it is not the same as
cost. A load yields the event loop periodically, so its ~526 ms is spent in slices — the longest ~24 ms in the
median run and 47 ms in the worst — with the loop free in between: other requests interleave rather than
queueing behind the whole load. Without a clock to yield through, the two columns are the same number: the same
1M-id load holds the loop for **~519 ms straight** (median), long enough for a health check to time out and the
instance to be pulled from its load balancer.

**Read these as a loaded machine's figures.** The machine was not idle: its one-minute load average was about 5
at the start and the end of the run, so the cost column in particular is likely higher than an idle machine would
give, and the worst stall is the figure a busy neighbour moves most. The two columns' proportions are the finding.
The harness, the per-run samples, the Node version and the load averages are in
[`bench/event-loop-results.json`](../../bench/event-loop-results.json), written by
[`bench/event-loop.cjs`](../../bench/event-loop.cjs); `pnpm bench:event-loop:check` fails in CI if this section's
figures are not the ones in that file.

Yielding is on by default for `@cloudbitmaps/roaring` users; there is nothing to configure. It needs a `Clock`,
which the store passes to its loads and its erasures. If you call
`@cloudbitmaps/core` directly, pass one (`clock`) or the work runs uninterrupted.

**The rule:** anything that touches a whole generation belongs out of the request path. Yielding makes a load a
well-behaved neighbour, not a cheap one — it still burns a core for a fraction of a second, holds the whole
generation in memory, and streams a multipart upload. Use a job runner, a queue consumer, or a short-lived task —
and keep `has`, `count` and `intersect` where the requests are.

## Deploying to AWS Lambda

Serverless chunk-skipping intersection is what CloudBitmaps is for, so Lambda is a first-class target, with
one thing to know. The bitmap math runs on **`roaring`, a native (C++) addon**, whose install fetches a binary for
the platform the install runs on. So a `node_modules` installed on a laptop and zipped up does not load on
Lambda: **install for the target** — Amazon Linux, your function's architecture, its Node version — as any native
addon needs. `roaring` publishes no prebuilt binary for Linux on arm64, so on a Graviton function the addon
compiles from source during that install, which needs a C/C++ toolchain. This is a one-time build step, not a
per-invocation cost. Every CloudBitmaps package needs Node 22.12 or later, so the function runs on `nodejs22.x`
or a later runtime.

Pick whichever you already use:

- **`sam build --use-container`** (or `--use-container` on your framework) — builds deps inside an Amazon
  Linux image matching the runtime, so `roaring` is installed for the target. The simplest path.
- **Container image Lambda** — `FROM public.ecr.aws/lambda/nodejs:22`, add a build toolchain
  (`dnf install -y gcc-c++ make python3`), `npm ci`, deploy the image.
- **A Lambda layer** — build `node_modules` once in an Amazon Linux 2023 container and ship it as a layer,
  reused across functions.

Match the **arch** (`arm64` Graviton vs `x86_64`) and **Node version** of your function when you build. Our
CI proves this path end-to-end with a `pnpm lambda-smoke` gate (builds `roaring` from source in an AL2023
container and loads the package under both ESM and CJS). The repository can also build a layer for you: from a
clone, `pnpm build-lambda-layer` produces `dist-lambda/cloudbitmaps-lambda-layer.zip`, holding core and the roaring
flavor with the addon compiled in an AL2023 container of the machine's own architecture. It is a script in the
repository, not a published artifact: nothing on npm or on a GitHub release carries it, though a manually
dispatched CI run can build one and attach it to that run.

## How it stays correct

**A fault costs a read some latency and a write a re-run, never correctness.** Generations are write-once, so no
reader can pick up a half-written object. A publish only moves the pointer forward, and each attempt of its conflict
loop re-reads the row first, so no publish can move it back. All bytes are checksum-verified before use.

**Your client's own retry, and the writes it does not reach.** Each cloud SDK retries a failed request itself, under
the store's retry. For a conditional write that retry gives the wrong answer. A write that lands and then loses its
response is sent again, meets itself, and fails its own precondition, which reads as a lost race for a write that
won. This covers a generation's write-once put and the registry's create, compare-and-swap and delete (a tombstone
write, or a delete under a precondition where the backend's `conditionalDelete` is on). So the S3 and GCS packages send a conditional write once where the SDK lets them, with its retry
off for that request alone. The Azure Blob package, whose retry has no per-request switch, tags each write and
settles a conflict by reading it back. The GCS package does the same for an object above
`simpleUploadThresholdBytes`, which uploads as a resumable session. The client is otherwise left as it is, a client
you pass in included, and every other request it makes keeps the SDK's retry rules. The one exception is a GCS
download on the client `GcsStorage` builds, which the SDK does not retry and the driver does
([why](#reliability-retries-backoff--timeouts)). A transient failure of a
conditional write reaches its caller as `TransientError`, and the write may or may not have landed. Where each
package stands:

| package | conditional writes |
|---|---|
| `@cloudbitmaps/s3` | every one is sent once: the write-once `PutObject`, a multipart upload's `CompleteMultipartUpload`, and the registry's create, compare-and-swap and delete, a `DeleteObject` under `If-Match` included |
| `@cloudbitmaps/gcs` | the registry's writes, and an object up to `simpleUploadThresholdBytes` (8 MiB by default), are each one request, sent once. A larger object is a resumable upload, a session of requests that the SDK retries within, under the client's retry options; it and every Azure Blob write are tagged with a random id in metadata, as described below. The registry's delete under `ifGenerationMatch` goes through the SDK's retry, which a precondition makes safe: a second copy removes nothing the first could not |
| `@cloudbitmaps/azure-blob` | sent through the client's retry policy, which sends a request again after a network error or a 500 or 503. Each write is tagged with a random id in blob metadata, and a conflict is settled by reading the stored blob back, as described below. The registry's delete under `ifMatch` is sent the same way, safe for the same reason as GCS's |

**Writes that are tagged instead.** Azure Blob's retry is a policy on the client's pipeline, and a GCS resumable
upload is a session the SDK retries within, so neither has a per-request switch. Each of their conditional writes
carries a random id in the object's metadata (`cbwid`), outside the `.crbm` bytes and outside the registry row's body.
When such a write reports a conflict, the backend reads the stored blob or object back with one metadata request. It
reports success when the object carries the write's own id, and `WriteConflictError` otherwise. The read happens only
on a conflict, works with a client you pass, and adds no option. A read-back that fails transiently throws
`TransientError`. A generation's `.crbm` object is never overwritten, so its read-back is definitive. A registry row
is overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before the read-back, makes
that write report `WriteConflictError`. The store's callers re-read the row on it, and none deletes a generation
because of it.
