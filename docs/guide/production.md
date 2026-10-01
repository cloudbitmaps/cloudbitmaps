# Before production

What to set up before a deployment takes real traffic.

## Cloud registry requirements

> **S3 registry requirements:** the bucket backend must honor `If-Match` conditional writes (AWS S3; recent
> MinIO), the IAM principal needs **`s3:ListBucket`** (else a missing key returns `403` not `404`, and
> discovery can't list), and **don't put a rule on the `registry/` prefix that expires a current version** (deleted rows are
> tombstoned for the pointer's ABA-safety; a rule on noncurrent versions only is safe, and is the optional recipe in the
> [disaster-recovery guide](disaster-recovery.md#optional-make-a-shred-durable-with-a-registry-expiry-rule)).

## Lifecycle rule for incomplete uploads

**GCS and Azure Blob work exactly the same way**, each using its own cloud's conditional write —
`ifGenerationMatch` on GCS, `If-None-Match` / `If-Match` on Azure — so the compare-and-swap is enforced by the
service rather than by the client. The same caveat applies to all three: no lifecycle rule on the `registry/` prefix that deletes a current
version.

> **One lifecycle rule you should add:** **`AbortIncompleteMultipartUpload`**, on the bucket holding storage
> objects (a few days is plenty). A large generation is written as a multipart upload; the library aborts it on
> any error it survives to handle, but it cannot abort one whose process no longer exists — a killed container
> or an OOM leaves the parts behind. Those parts are **billed and invisible**: they never appear in an object
> listing, so nothing but the bill will tell you. This is the one case where cost can accumulate quietly, which
> matters more here than it would elsewhere, because a low idle bill is the point of the library.

## Reliability: retries, backoff & timeouts

Cloud storage throttles, returns 5xx, and drops connections. CloudBitmaps handles that for you on the read path:
**every read that answers a query automatically retries transient faults** (throttling, 5xx, dropped connections,
request timeouts) with bounded exponential backoff + full jitter — `has`, `count`, `iterate` and the combines (the
`*Into` verbs' reads of their operands included), a pinned handle's reads and `pin()` itself. An erasure's reads
and a load's guard read go to the drivers directly, and are not retried. It's **on by
default** — you don't have to do anything:

```ts
const store = new CloudRoaring({ storage: backend }); // retries already enabled
```

Tune it, or turn it off, per store:

```ts
const store = new CloudRoaring({
  storage: backend, // S3Storage, GcsStorage, …
  // Tune the policy — it is a PARTIAL, so name only what you are changing. Everything else keeps its
  // default, and `onRetry` goes in the same group.
  // …or `retry: false` to turn the read retry off (e.g. your client already retries).
  retry: {
    maxAttempts: 6,
    onRetry: ({ attempt, delayMs }) => log.warn({ attempt, delayMs }, 'retrying transient fault'),
  },
});
```

**What's retried vs not.** Only **transient** infrastructure faults are retried — surfaced as
`TransientError`. Deterministic errors are **never** retried (retrying them
can't help or would be wrong): `ValidationError` (bad input), `IntegrityError` (corrupt bytes),
`NotFoundError`, and `WriteConflictError` (a write-once generation number was reused, or the registry pointer
was contended past its own re-read-and-retry loop).

**Set a timeout on your client.** CloudBitmaps intentionally has no homegrown timeout (it would abandon
in-flight requests). Instead, give your injected storage client a request timeout — on a read, the resulting
timeout is treated as transient and retried:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ requestTimeout: 3_000, connectionTimeout: 1_000 }),
});
```

**Your client's own retry, and the writes it does not reach.** Each cloud SDK retries a failed request itself,
under the store's retry. For a conditional write — a generation's write-once put, and the registry's create,
compare-and-swap and delete, which writes a tombstone — that retry gives the wrong answer: a write that lands and then loses its response is sent again,
meets itself, and fails its own precondition, which reads as a lost race for a write that won. So the S3 and GCS
packages send a conditional write once where the SDK lets them, with its retry off for that request alone, and
the Azure Blob package, whose retry has no per-request switch, tags each write and settles a conflict by reading
it back, as the GCS package does for an object above `simpleUploadThresholdBytes`, which uploads as a resumable session. The client is otherwise
left as it is, a client you pass in included, and every other request it makes keeps the retry rules the SDK gives
it. A transient failure of a conditional write reaches its caller as `TransientError`, and the write may or may not
have landed. Where each package stands:

| package | conditional writes |
|---|---|
| `@cloudbitmaps/s3` | every one is sent once: the write-once `PutObject`, a multipart upload's `CompleteMultipartUpload`, and the registry's create, compare-and-swap and delete |
| `@cloudbitmaps/gcs` | the registry's writes, and an object up to `simpleUploadThresholdBytes` (8 MiB by default), are each one request, sent once. A larger object is a resumable upload, a session of requests that the SDK retries within, under the client's retry options; it and every Azure Blob write are tagged with a random id in metadata, as described below |
| `@cloudbitmaps/azure-blob` | sent through the client's retry policy, which sends a request again after a network error or a 500 or 503. Each write is tagged with a random id in blob metadata, and a conflict is settled by reading the stored blob back, as described below |

**Writes that are tagged instead.** Azure Blob's retry is a policy on the client's pipeline, and a GCS resumable
upload is a session the SDK retries within, so neither has a per-request switch. Each of their conditional writes
carries a random id in the object's metadata (`cbwid`), outside the `.crbm` bytes and outside the registry row's
body. When such a write reports a conflict, the driver reads the stored blob or object back, one metadata request,
and reports success when it carries the write's own id and `WriteConflictError` otherwise. The read is made only on a
conflict, works with a client you pass, and adds no option. A read-back that fails transiently throws
`TransientError`. A generation's `.crbm` object is never overwritten, so its read-back is definitive. A registry row
is overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before the read-back,
makes that write report `WriteConflictError`: the store's callers re-read the row on it, and none deletes a
generation because of it.

**Your data is safe across a transient fault.** Generations are write-once (no half-written object a reader could
pick up); a publish only moves the pointer forward, and each attempt of its own conflict loop re-reads the row
first, so no publish can regress it; and all bytes are checksum-verified before use. A fault costs a read some
latency and a write a re-run, never correctness.

**Writes are yours to retry.** `load`, the write half of the `*Into` verbs and the lifecycle helpers (`eraseSubject`,
`dropSegment`, `retireExpired`, `rollback`, …) run over the raw drivers **without** the retry wrapper, on purpose, and
so do the calls that read the registry or list the bucket directly: `exists`, `segments`, `generations`
and `getRetention`, and the registry scan that `subjectReport`, `exportSegments` and `checkConsistency` start from
(`checkConsistency` records a fault on one segment in `report.errored` and throws only from that scan). A write that lands and then loses its response looks, from the error alone,
like one that failed, and replaying its conditional put or compare-and-swap would find that write already there and
report it as a conflict. So a transient fault on a write reaches its caller (as a ledger entry or a throw), and the
retry is yours: re-run the call. The `retry` option tunes the reads alone.

A re-run `load` takes a fresh generation number and re-reads the row, so once the first attempt has settled it
publishes whenever that attempt would have, whether or not it landed, with the same ids and options, under every
guard setting and with or without a row ([publish is forward-only](loading.md#loading-a-segment)). Three things to know:

- **Pass the ids again, fresh.** An iterator the first attempt consumed yields nothing the second time, and an empty
  load can publish: with `allowEmpty: true`, or onto a segment that holds no data.
- **A late write reads as a lost race.** A request that timed out on your client can still land while the re-run is
  under way, and the re-run then reports `superseded`, with nothing new current when what landed late was the
  object. So on a `superseded` right after a transient fault, check before you re-derive,
  and run the load again if your ids are not current.
- **Every attempt that landed takes a `keep` slot.** An attempt whose object landed, published or not, is one more
  generation below the re-run's pointer, so the default `keep: 1` keeps the latest of them and collects the
  generation the segment held before the load. To keep that one as a `rollback` or pin target, pass a `keep` one
  above the number of attempts that landed: `keep: 2` after one ([sizing `keep`](loading.md#sizing-keep)).

To learn whether an attempt landed, check rather than replay the request: compare `store.generations(ref)` with what
it listed before the call. A new current generation is a publish that landed, and a new one above the current is an
object that landed unpublished; while another writer is active on the segment, the listing cannot say whose either
is. `generations` is not retried either, so a fault there means asking again.

> Writing your own driver? Start from what a driver must do: a storage driver's `putImmutable` is write-once and
> throws `WriteConflictError` on a collision; `getRange` and `getTail` throw `NotFoundError` for a missing object and
> `ValidationError` for an out-of-range read; `delete` is idempotent; `list` is strongly consistent, read-after-delete.
> A registry driver's `create` and `compareAndSwap` are atomic conditional writes, and its `delete(ref, expected?)`
> lands only while the row carries `expected` when one is given, which keeps a stale delete from taking a row
> created after it was decided. No driver may replay a conditional write without telling the replay apart: send it
> once, or recognise your own write on the read-back. The [driver kit](api-reference.md#driver-kit--what-you-need-to-implement-a-driver)
> lists each with the reason a caller depends on it. Throw `TransientError` for your backend's retryable faults: the store's read retry
> rides them out, and a write's caller can tell them from a deterministic failure. A registry's `get` is held to it too: a pointer refresh rides out only a `TransientError`, so a custom registry that throws a plain `Error` for an outage makes the read that meets it fail. The store wraps the source it
> reads through, a `StorageChunkSource` you pass as `storage` included, so do not wrap one before handing it over:
> that multiplies each read's attempts. A call of your own is yours to retry: loop over it, and back off before the
> next attempt when `isTransientError(err)` is true. The retry primitives a flavor or driver author builds on are on
> `@cloudbitmaps/core`.
>
> Want a backend made of halves of your own — a driver wrapped for auditing, metrics or tenant scoping, or paired
> with a registry in a database you already run? That is a driver author's job, and it goes through
> `@cloudbitmaps/core/driver-kit`: build each half against `IStorageDriver` and `IRegistryDriver`, then
> `brandAsBackend({ storage, registry })`, which checks that each half is a driver and returns the object the
> store accepts as `storage`. It cannot check that the two halves point at the same place — the driver interfaces
> expose no location — so branding them is you taking that on. To wrap a backend's half, pass its `.storage` or
> `.registry` as the half you wrap.

## Cost ceiling: the per-op fan-out budget

On a shared/serverless backend, one pathological call — an `intersect` over two enormous barely-overlapping
segments, a wide `union`, or a fleet-wide `eraseSubject` — can quietly run up a large bill (a "denial-of-wallet").
CloudBitmaps caps the **number of backend calls a single operation may fan out to** (Storage chunk fetches, or
segments scanned, and for `eraseSubject` the generations it opens as well) and refuses (throws
`BudgetExceededError`) rather than running away:

```ts
import { CloudRoaring, BudgetExceededError } from '@cloudbitmaps/roaring';

// on by default — generous (1,000,000 units); set your own store-wide ceiling:
const store = new CloudRoaring({ storage: backend, budget: { maxRequests: 50_000 } });
await store.load({ segment: 'huge' }, hugeIds);
await store.load({ segment: 'other' }, otherIds);

try {
  for await (const id of store.segment('huge').intersect([store.segment('other')])) {
    /* … */
  }
} catch (e) {
  if (e instanceof BudgetExceededError) {
    /* the op would have fanned out past the ceiling — it was refused before doing the work */
  }
}
```

The store-level `budget` guards `count` / `iterate` / `intersect` / `union` / `andNot` / `subjectReport` /
`eraseSubject` — the operations whose cost scales with data size. `eraseSubject` charges one unit per registered
segment and one for each generation it opens beyond the one the segment's row names: a segment whose current
generation lacks the id is searched in every generation still in its bucket, which with the keep-everything default
of the `*Into` verbs is one per generation it ever had. Its own rewrite of a segment that holds the id is not
charged beyond the segment's unit. Only the enumeration can refuse the whole call: a segment that runs the budget
out during the scan is listed in the ledger with `erased: false` and an `error:` note, before it deletes
anything (the one refusal that can come after a rewrite is the last check for a generation a concurrent writer left
behind, and it carries the same note), and the scan carries on (a member segment still erases, since it opens nothing more), so the
ledger of the erasures that did happen is never lost. Re-run it with a higher `budget` to finish those segments. The ops that take options — the combines,
`subjectReport`, `eraseSubject` — also accept a **per-op override** (a partial override inherits the store ceiling;
it never resets it to the generous default):

```ts
// tighten or lift the ceiling for a specific call:
await store.subjectReport(userId, { namespace: 'eu', budget: { maxRequests: 5_000 } });
for await (const _ of store.segment('huge').intersect([store.segment('other')], { budget: false })) {
  /* trusted batch job — no ceiling for this call */
}
```

The ceiling is checked **once, before fan-out**, against the already-known work size, so it adds **nothing to the
hot path** (`has` is single-call and never budgeted). The units are the chunk reads the op will actually issue —
for an `intersect`, the surviving keys × the operands present at each, plus only those excludes that hold the
key, so a large suppression list is not charged for keys it cannot affect. Byte volume needs no separate limit:
every chunk read is size-capped by the safe deserializer, so bounding the fan-out transitively bounds bytes too.
`count` on a loaded segment is summed from the `.crbm` index with zero reads, so it only approaches the ceiling on
a source that can't serve cardinalities. Leave it on; lower it on
untrusted/multi-tenant surfaces; raise it (or `budget: false`) for trusted bulk jobs.

### Two different limits: `budget` (cost) and the memory ceilings

They are separate on purpose, and it is worth knowing which one you just hit.

| | `budget` | the memory ceilings |
| --- | --- | --- |
| bounds | **cost** — backend requests a single op may fan out into | **memory** — what a process holds resident, whatever the segments' size |
| knobs | `budget: { maxRequests }`; `false` disables it | `cache.maxChunks` (decoded cached chunks, default 1024) · `cache.readerMax` / `cache.readerMaxBytes` (open `.crbm` indices, default 1024 / 64 MiB) · the combines' `concurrency` window · the per-chunk decode cap — **`budget: false` lifts none of them** |
| covers | `count` · `iterate` · the combines · `subjectReport` · `eraseSubject` | every read, on every backend |

Why not one control? Because `intersect`'s budget is a *product* — surviving keys × operands — while its memory is
the *window*: `concurrency × operands × chunk`, independent of segment size. A request budget cannot express a
memory bound, and `budget: false` is a reasonable choice ("I know my fan-out") that must not silently also mean
"unbounded RAM". A wide segment's parsed index can be several MB, which is why the reader cache is bounded by
bytes as well as by count — lower `cache.readerMaxBytes` for a memory-tight deployment (a 128 MB Lambda) that
reads across many wide segments.

**Neither limits how many ids a segment can hold.** A segment holds up to the full 32-bit id space — ~4.29
billion members — and no ceiling here changes that. `maxScanSegments` — an option of `store.retireExpired`,
while `store.checkConsistency` holds the default of 250,000 — counts **segments**, distinct
named bitmaps in the registry, not members: 500 audience segments count as 500, whatever their size.

## What blocks the event loop, and where to run it

Node is single-threaded, so CPU-heavy work stalls **every** other request on that instance. Most of this library
is network-bound and irrelevant here — a `has()` spends a negligible fraction of its time on bit math — but a
**load** and an **erasure rewrite** are genuinely CPU-heavy, because each one touches a whole generation. Measured
on an M3 Pro:

| path | cost | longest single stall | where it belongs |
| --- | --- | --- | --- |
| a load, `store.load()` (1M ids spread across the id space, in-memory storage) | ~405 ms | **~22 ms** (26 ms at worst) | a batch job or worker; survivable off the request path |
| `eraseSubject` | decodes and re-encodes every chunk of the segment — same order of work as a load | yields on the same cadence | an admin job, never a request handler |
| `has` / `count` / `intersect` / `union` / `andNot` | microseconds of CPU; dominated by network | — | anywhere |

The **stall** column is the number that decides whether co-resident work survives, and it is not the same as
cost. A load yields the event loop periodically, so its ~405 ms is spent in slices — the longest ~22 ms in the
median run and 26 ms in the worst — with the loop free in between: other requests interleave rather than
queueing behind the whole load. Without a clock to yield
through, the two columns are the same number: the same 1M-id load holds the loop for **~408 ms straight**, long
enough for a health check to time out and the instance to be pulled from its load balancer. Both figures are the
median of seven runs, measured on the same machine.

Yielding is on by default for `@cloudbitmaps/roaring` users; there is nothing to configure. It needs a `Clock`,
which the store passes to its loads and its erasures. If you call
`@cloudbitmaps/core` directly, pass one (`clock`) or the work runs uninterrupted.

**The rule:** anything that touches a whole generation belongs out of the request path. Yielding makes a load a
well-behaved neighbour, not a cheap one — it still burns a core for a fraction of a second, holds the whole
generation in memory, and streams a multipart upload. Use a job runner, a queue consumer, or a short-lived task —
and keep `has`, `count` and `intersect` where the requests are.

## Deploying to AWS Lambda

CloudBitmaps' crown jewel is serverless chunk-skipping intersection, so Lambda is a first-class target — with
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
