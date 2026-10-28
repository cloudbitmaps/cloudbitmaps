# Serverless intersection in AWS Lambda

Run an intersection of stored segments in a Lambda function: the handler's shape, one store per container, the cache against the function's memory, cold starts and packaging, with no measured figure because none exists yet.

Chunk-skipping intersection is the reason the library exists, and a Lambda function is the place it is meant to run: no
cluster to keep warm, a read that fetches only the chunks every operand holds. This page builds the handler's logic and runs it
on `MemoryStorage` with a fake event, then says what changes on AWS: what to create once per container, how the cache
competes with the function's memory, what a cold container pays, and how to package it. **This page states no latency,
cold-start or cost figure: none has been measured from inside a function** ([what the benchmarks still owe](../benchmarks.md#what-is-still-owed)).
Every `Output` is what the repo's tests print when they run the blocks as written.

Use it when requests ask "which ids are in all of these sets" and each call is short, with the sets loaded by a job elsewhere.
A function that must answer in single-digit milliseconds from a cold start is not what this page can promise.

## The shape

<!-- not-run: a diagram of one container, not code -->
```text
 scheduled job --store.load--> bucket (segments)        read-only below this line
                                    ^
 event --> handler --> store --> S3Storage (GETs, ranged)
            (per call)   |
                         +-- cache in the container's RAM: readers and chunks, bounded
```

The store lives for the container, and the handler runs once per invocation. A container serves one invocation at a time and
another container has its own store and its own cache, so there is no shared warm copy ([Limits](#limits)).

## The handler's logic

The handler below takes two to eight segment names, an optional `after` and a `limit`, intersects the segments and returns
one page of ids with the id to continue from. It stops reading once it has the page. The event shape is the minimum the page
needs, not the AWS type; a loader job fills the segments, here with invented ids.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage, errorKind } from '@cloudbitmaps/roaring';

interface LambdaEvent {
  body: string | null;
}
interface LambdaReply {
  statusCode: number;
  body: string;
}
const MAX_SEGMENTS = 8;
const NAME_SHAPE = /^[a-z0-9-]{1,64}$/;

interface Query {
  segments: string[];
  after: number | undefined;
  limit: number;
}

/** Reads the JSON body, or `null` when it is not what the handler takes. */
function parseRequest(body: string | null): Query | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { segments, after, limit } = parsed as Record<string, unknown>;
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > MAX_SEGMENTS) return null;
  if (!segments.every((s) => typeof s === 'string' && NAME_SHAPE.test(s))) return null;
  if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 0)) return null;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) return null;
  return { segments: segments as string[], after: after as number | undefined, limit: limit as number };
}

function makeHandler(store: CloudRoaring): (event: LambdaEvent) => Promise<LambdaReply> {
  return async (event) => {
    const request = parseRequest(event.body);
    if (request === null) return { statusCode: 400, body: JSON.stringify({ error: 'BadRequest' }) };
    const [first, ...rest] = request.segments.map((name) => store.segment(name));
    if (first === undefined) return { statusCode: 400, body: JSON.stringify({ error: 'BadRequest' }) };
    try {
      const ids: number[] = [];
      for await (const id of first.intersect(rest, { after: request.after })) {
        ids.push(id);
        if (ids.length > request.limit) break; // one more than the page says there is a next one; the read stops here
      }
      const page = ids.slice(0, request.limit);
      const next = ids.length > request.limit ? (page[page.length - 1] ?? null) : null;
      return { statusCode: 200, body: JSON.stringify({ ids: page, next }) };
    } catch (error) {
      // The caller learns the kind of the failure, never a message: a message can name a segment.
      const kind = errorKind(error) ?? 'Error';
      return { statusCode: kind === 'ValidationError' ? 400 : 500, body: JSON.stringify({ error: kind }) };
    }
  };
}

// The loader job's part, and the store a container builds once (a cache sized for a small function, see below).
const store = new CloudRoaring({
  storage: new MemoryStorage(),
  cache: { maxChunks: 256, readerMax: 64, readerMaxBytes: 16 * 1024 * 1024 },
});
await store.load({ segment: 'eu' }, [10, 20, 30, 40, 50, 60]);
await store.load({ segment: 'paid' }, [20, 40, 60, 80]);
await store.load({ segment: 'active' }, [40, 60, 90]);
const handler = makeHandler(store);

async function call(request: unknown): Promise<void> {
  const reply = await handler({ body: typeof request === 'string' ? request : JSON.stringify(request) });
  console.log(reply.statusCode, reply.body);
}
await call({ segments: ['eu', 'paid'], limit: 2 });
await call({ segments: ['eu', 'paid'], after: 40, limit: 2 });
await call({ segments: ['eu', 'paid', 'active'], limit: 5 });
```

Output:

<!-- output -->
```text
200 {"ids":[20,40],"next":40}
200 {"ids":[60],"next":null}
200 {"ids":[40,60],"next":null}
```

The cap on the number of names matters because each streamed operand holds a reader outside the cache's bounds. The name
pattern only checks the shape (change it to match your naming: as written it refuses capitals, dots and underscores): the function's role can read everything under its prefix, so a caller who can send a request
can ask about any segment there. Decide who may combine which sets in the handler (an allow-list of names, or a prefix a
caller's identity maps to) before you put it behind a URL or a gateway.

The page size bounds the result, not the read: when few ids match, a sparse intersect reads every chunk the operands share
before the loop ends. Size the function's timeout and `budget` for that case, and cut it with `after` and `through` ranges.

The three calls are the first page, the second page after id 40 and a three-way intersection. The first page leaves `after`
out, which is the only way to include id 0 ([paging](../guide/reading.md#page-through-a-segment)).

## Wire it to S3

Everything outside the handler runs once, when the container starts. The wiring is the two lines that change, and it needs an
AWS account, a bucket and the Lambda runtime, so it is shown and not run.

<!-- not-run: needs an AWS account, a bucket and the Lambda runtime, which the tests never contact -->
```js
// handler.mjs: module scope runs once per container; makeHandler is the function above, written in JavaScript.
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({ bucket: process.env.SETS_BUCKET, prefix: 'sets', readTimeoutMs: 5000 }),
  cache: { maxChunks: 256, readerMax: 64, readerMaxBytes: 16 * 1024 * 1024 },
});

export const handler = makeHandler(store);
```

- **One store per container, shared by every invocation.** A store is its cache: a second store is a second cache, and a
  store built inside the handler starts every call cold. `store.segment(name)` is cheap, so the handler can open a handle
  per call.
- **Region and credentials.** `S3Storage` builds its own client from your usual AWS credentials, or takes your own `S3Client`;
  the library sets neither, so the SDK's usual resolution applies in the function.
- **Read-only permissions.** A function that only reads needs `s3:ListBucket` on the bucket and `s3:GetObject` on the objects
  under its prefix; the write and delete actions are the loader's. If the bucket encrypts with a KMS key, grant that key's
  use as well ([permissions](../guide/production.md#permissions)).
- **A read timeout.** `readTimeoutMs` is `0`, no timeout, unless you set it. A stuck read fails as a `TransientError` that
  the store retries, so the worst case is the attempts times the timeout: with the default of 4 attempts, `readTimeoutMs:
  5000` costs about 20 seconds plus backoff before the call fails. The 5,000 here assumes a function timeout of 30 seconds
  or more; set the function's timeout from that product, or lower the attempts with `retry: { maxAttempts: 2 }`
  ([retries, backoff and timeouts](../guide/production.md#reliability-retries-backoff--timeouts)).
- **No loads here.** A load holds a whole generation and burns a core, and belongs to a scheduled job or a queue consumer
  ([what blocks the event loop](../guide/production.md#what-blocks-the-event-loop-and-where-to-run-it)).

## The cache against the function's memory

The container's memory holds the runtime and your bundle, the store's caches, and the readers of a combine while it runs. The
caches are bounded by settings, and their defaults suit a server:

| Holds | Bounded by | Default |
|---|---|---|
| Decoded chunks, each up to 65,536 ids | `cache.maxChunks` | 1,024 |
| Open segment readers, each with its parsed index (a wide segment's can reach about 1.3 MB) | `cache.readerMax` and `cache.readerMaxBytes` | 1,024 readers, 64 MiB |
| The ranges a running combine reads ahead (up to 1 MiB each) | the combine's `concurrency` window, `concurrency × operands × 1 MiB`; the handler runs at the default | 32 |
| The readers a running combine holds, one per streamed operand, for as long as it runs | nothing in the cache: outside both bounds | |

The guide gives no byte figure for one cached decoded chunk, only the count and the 65,536-id ceiling, so leave room for
that ceiling times `maxChunks`. The page's own store gives a small function a share of the defaults, which is a starting
point to measure and not a measured setting. Size the caches from the function's memory setting minus what the runtime and your bundle take, keep room for the
widest combine you allow, and lower `cache.readerMaxBytes` first for a function that reads many wide segments
([the memory ceilings](../guide/production.md#the-memory-ceilings), [what each reader holds](../guide/sizing.md#what-each-reader-holds)).
A hot set larger than the cache evicts and reopens: each reopen is a tail read the cost estimator does not price.

## Cold starts

A cold container has no readers and no chunks. Its first intersect of two segments waits on a chain of requests: both
operands' pointers, then both indexes, then each operand's ranges of shared chunks, which is `4 + 2r` GETs for `r` range
requests of each segment ([the cold intersect](../guide/cost.md)). A warm container answers a repeat from its cache and pays
only the pointer refresh, at most one GET per segment every `cache.genTtlMs` (2 seconds by default) while the segment is read.
The library starts no timer ([schedule the work](../guide/production.md#schedule-the-work)): the refresh is decided when a read
happens, so a container that sat frozen reads the pointer at its first read after it thaws (derived from that, not measured).

What a function's cold start and initialisation cost against a real bucket, from inside a function, is **not measured**. Two
choices are open and neither has a figure: keep containers initialised with an AWS setting such as provisioned concurrency, or
warm the segments the function needs (a `has` or a `count` each) in module scope before its first request.

## Packaging

The packages have no native addon and no install script, so a `node_modules` installed anywhere loads on Lambda (the S3
driver, `@cloudbitmaps/s3`, is a package of its own and is bundled too); match only
the Node version, `nodejs22.x` or later (Node 22.12 or later is required). Package it as a zip, a container image or a layer.
The repository checks the path on `x86_64` on every push and runs no job on `arm64`, where the packages are the same
JavaScript. `pnpm build-lambda-layer`, run from a clone, builds a layer of core and the roaring flavor and nothing compiled;
the script is in the repository and no layer is published. A layer is found by `require()` through `NODE_PATH` and not by an
ESM `import`, so an ESM handler bundles its dependencies or reads them from the zip
([deploying to AWS Lambda](../guide/production.md#deploying-to-aws-lambda)).

## What goes wrong

<!-- typecheck -->
```ts
await call({ segments: ['eu', 'nope'], limit: 2 });
await call({ segments: ['eu'], limit: 2 });
await call('not json');
```

Output:

<!-- output -->
```text
400 {"error":"ValidationError"}
400 {"error":"BadRequest"}
400 {"error":"BadRequest"}
```

| You see | What to do |
|---|---|
| `ValidationError` | A segment was never loaded (a typo, a missing `namespace`) or an option is wrong. The combine refuses an absent operand instead of reading it as empty, so a mistyped name cannot return everything. Fix the request. |
| `TransientError` after the store's retries | A throttled or timed-out read. Return a retryable status. If it recurs, raise the read timeout or the function's timeout, or look at the cache size: a thrashing cache reads more. |
| `BudgetExceededError` | The combine would issue more chunk reads than its budget allows. Page with `after` and `limit`, or raise `budget` with room to spare ([the budgets](../guide/production.md#limits-the-per-op-budget-and-the-memory-ceilings)). |
| A timeout of the function with no error | A cold container with a slow first read, or a read with no `readTimeoutMs`. Set the read timeout, and size the function's timeout for a cold intersect. |
| Out-of-memory | The caches, the combine's readers and its read-ahead window together exceed the function's memory. Lower `cache.maxChunks`, `cache.readerMaxBytes` and the combine's `concurrency`, or raise the memory. |

## Limits

- **No figure.** The page says nothing about latency, cold start or cost on AWS: a function's cold start and initialisation
  are not measured ([what the benchmarks still owe](../benchmarks.md#what-is-still-owed)).
- **The cache is per container.** Containers do not share a warm copy of the hot set, so a fleet pays each cold read once per
  container. A shared cache tier for a fleet of readers is planned, not built
  ([what is planned for each weakness](../guide/why-cloudbitmaps.md#what-is-planned-for-each-weakness)).
- **Freshness is stated, and it is not zero.** A container sees a new load within `cache.genTtlMs` after it next reads
  ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).
- **A wide intersect is unmeasured on S3.** The published requests are for two operands; more operands and other overlaps
  are not measured, and the validated envelope is single-tenant, single-region, S3, read-mostly
  ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)).
- **`arm64` is not run in CI.** The packages are the same JavaScript on both architectures; only `x86_64` is exercised.
- **Bytes outside the region cost.** A function in another region from the bucket pays for the bytes it reads, which can cost
  more than the requests saved ([reading ranges](../guide/production.md#reading-ranges-the-bytes-between-chunks)).
