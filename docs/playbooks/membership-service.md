# A membership check in a long-running service

Open a few segments when a service starts, answer "is this id in the set" on each request from memory, follow new loads by themselves, and hold a fixed point when a check needs it.

A service that gates a request on a set (is this account in the beta, is this device on the blocklist, may this user see
this document) keeps its segments open for as long as it runs. This page builds that service's shape on `MemoryStorage`
with invented ids: the options that bound its memory, the check a request makes, how it picks up a new load without a restart,
and a fixed point for a request that must look at one instant. Every `Output` is what the repo's tests print when they
run the blocks as written.

Use it when the sets are loaded elsewhere, on a schedule, and many requests read them. It is not a place to write: a
change reaches the service as a load, and it takes up to the refresh time stated under [Limits](#limits) to be seen.

## Build the store once, with the cache you can afford

Build one store per process and share it: every handle, reader and chunk lives under it, so a second store is a second cache.
The cache is what turns a membership check into a read of memory. Its settings and their defaults, from
[the API reference](../guide/api-reference.md#build-a-store--new-cloudroaringoptions):

| Option | Default | Bounds |
|---|---|---|
| `cache.maxChunks` | 1,024 | decoded chunks held in RAM, across every segment |
| `cache.readerMax` | 1,024 | open segment readers (each holds its parsed index) |
| `cache.readerMaxBytes` | 64 MiB | the readers' indexes and the chunk bytes a reader keeps of a small generation |
| `cache.genTtlMs` | 2,000 ms | how long a reader serves the generation it has before it checks for a newer one |
| `cache.ttlMs` | off | the longest a decoded chunk is kept; a chunk otherwise stays until the count bound evicts it |

The block below states every one of them. Leave out the ones you do not need to change: the defaults are the values in the
table. The clock is the same hand-moved clock the permissions page uses, so the page needs no waiting.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';
import type { Clock } from '@cloudbitmaps/roaring';

const backend = new MemoryStorage();

// The job that loads the sets (another process in production).
const loader = new CloudRoaring({ storage: backend });
await loader.load({ segment: 'beta' }, [101, 102, 103]);
await loader.load({ segment: 'blocklist' }, [900, 901]);

// The service.
let now = Date.UTC(2026, 9, 26, 9, 0, 0);
const clock: Clock = { now: () => now, sleep: async () => {} };
const service = new CloudRoaring({
  storage: backend,
  cache: { maxChunks: 1024, readerMax: 1024, readerMaxBytes: 64 * 1024 * 1024, genTtlMs: 2000 },
  seams: { clock },
});

// Open the segments when the service starts, and keep the handles: a handle is cheap and holds nothing but its name.
const beta = service.segment('beta');
const blocklist = service.segment('blocklist');
console.log(await service.exists({ segment: 'beta' }), await service.exists({ segment: 'blocklist' }));
console.log(await beta.count(), await blocklist.count());
```

Output:

<!-- output -->
```text
true true
3 2
```

`exists` reads the segment's registry row (one point read) and `count` usually answers from the row's summary, so a service
can check at start that every segment it needs is there before it takes traffic. A segment that does not exist reads as
empty, and an empty set fails in opposite directions: a missing **allow** set denies everyone, which is safe, and a missing
**deny** set admits everyone, which is not ([what goes wrong](#what-goes-wrong)).

## The check a request makes

<!-- typecheck -->
```ts
async function mayEnter(accountId: number): Promise<boolean> {
  if (await blocklist.has(accountId)) return false;
  return beta.has(accountId);
}

console.log(await mayEnter(102), await mayEnter(500), await mayEnter(900));
```

Output:

<!-- output -->
```text
true false false
```

A deny set needs a gate of its own, because nothing in the check notices that it is missing. The block below refuses to
report ready unless both segments exist and the blocklist holds someone; run it at start, before each deploy and on a timer while the service runs (a
deny set can vanish or be emptied later), and alert when it turns false. Where a blocklist can legitimately be empty, drop the count test and keep the existence test. Pair it with a guard
on the load that refreshes the list (`guard: { minCardinality: 1 }`, or a `minRetained`), so a broken export is refused instead of
publishing an empty list ([when a load is refused](../guide/loading.md#when-a-load-is-refused)).

<!-- typecheck -->
```ts
async function ready(allow: string, deny: string): Promise<boolean> {
  if (!(await service.exists({ segment: allow })) || !(await service.exists({ segment: deny }))) return false;
  return (await service.segment(deny).count()) > 0; // an emptied blocklist would admit everyone
}

console.log(await ready('beta', 'blocklist'), await ready('beta', 'blocklst'));
```

Output:

<!-- output -->
```text
true false
```

`has` costs one read of the id's chunk the first time and then answers from the chunk cache, with no request to storage
while the cached chunk and the segment's resolution are fresh. The first `has` on a segment also reads its row and its
index. A check that must be one membership test, such as this one, should be one segment: compose "in the beta and not on the
blocklist" into a segment at load time and call `has` once, as [the permissions page](permissions.md#a-segment-per-resource-and-per-group) does.

## Follow a new load without a restart

A load from another process is seen within `cache.genTtlMs`: after that time the next read of a handle checks the segment's
pointer, and from then on it answers from the new generation. Nothing restarts and no handle is rebuilt.

<!-- typecheck -->
```ts
await loader.load({ segment: 'beta' }, [101, 102, 103, 500]); // the batch job publishes a new generation
console.log('before the refresh passes', await mayEnter(500));
now += 3_000;
console.log('after the refresh passes', await mayEnter(500));
console.log('serving generation', (await beta.stat()).generation);
```

Output:

<!-- output -->
```text
before the refresh passes false
after the refresh passes true
serving generation 1
```

`stat()` names the generation a handle reads, which is the thing to log or export as a gauge so that a service that has stopped
following loads is visible. A refresh that cannot reach the registry keeps serving the segment it has and tries again; the
exact rule is in [an outage of the registry stretches the bound](../guide/reading.md#how-soon-a-reader-sees-a-new-load).
Where "within two seconds" is too slow, lower `cache.genTtlMs` (each refresh is a registry read) or call
`service.invalidate({ segment: 'beta' })` on the service when your own channel says a load landed.

<!-- typecheck -->
```ts
await loader.load({ segment: 'beta' }, [101, 102, 103, 500, 501]);
service.invalidate({ segment: 'beta' }); // the next read resolves the current generation afresh
console.log(await mayEnter(501));
```

Output:

<!-- output -->
```text
true
```

## One fixed point for a request that needs one

A single `has` answers from whatever generation is current. A request that makes several checks against one set, or a job
that reads a set while loads land, should read one generation for its whole length: a pin.

<!-- typecheck -->
```ts
const betaAtStart = await beta.pin({ leaseUntil: now + 60_000 });
await loader.load({ segment: 'beta' }, [101]); // a load lands while the request is running
now += 3_000;
console.log('the pin sees', await betaAtStart.count(), 'and 102 is in it:', await betaAtStart.has(102));
console.log('the live handle sees', await beta.count());
await betaAtStart.release(); // ends the lease
```

Output:

<!-- output -->
```text
the pin sees 5 and 102 is in it: true
the live handle sees 1
```

A pin is a hold, not a copy. Without a lease, a later load whose collection passes the pinned generation deletes it, and a read of
the pin then fails with `NotFoundError` rather than serve another generation, so take a lease for anything longer than a
request, release it when the job ends, and size `keep` past the loads that can land meanwhile
([read one fixed point in time](../guide/reading.md#read-one-fixed-point-in-time)). A request-length pin on a store that
loads often is safe with a short lease; a lease is at most 14 days.

## Memory is bounded by the settings

The service's memory for sets is the sum of the bounds in the table at the top, nothing that grows with traffic: the chunk
cache stops at `cache.maxChunks` decoded chunks, the readers at `cache.readerMax` and `cache.readerMaxBytes`, and the kept
resolutions at 8 times `readerMax`, within a sixteenth of `readerMaxBytes`. [What each reader
holds](../guide/sizing.md#what-each-reader-holds) works the numbers for a service of a given size, and says what happens when the hot
set is larger than the cache: the reader evicts and opens again, a tail read per reopen, which is a cost the estimator
does not price. Size `cache.readerMaxBytes` from the segments you keep open, and size `cache.maxChunks` from how many distinct
chunks your requests touch.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

// A segment that was never loaded: a check against it answers "no" for everyone.
console.log(await service.segment('betta').has(102), await service.exists({ segment: 'betta' }));

try {
  await beta.has(-1);
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
false false
ValidationError
```

| You see | What to do |
|---|---|
| `has` answering `false` for everyone | The segment does not exist or was never loaded. For an allow set that denies everyone, which is safe and an outage all the same. For a **deny** set it admits everyone, so gate readiness on `service.exists(ref)` and a non-zero `count()` (the `ready` block above), and alert on that, not on the answer. A combine that names a missing segment refuses instead ([the suppression page](suppression.md#what-goes-wrong)). |
| `ValidationError` | The id is not an integer from 0 to 4,294,967,295. Map identifiers to dense integers before the call ([the id-mapping page](id-mapping.md)); it is raised before any read. |
| `LeaseExpiredError` from a pinned handle | The lease ended or was released. Never treated as an empty set. Take a pin with a longer lease. |
| `NotFoundError` | A pin without a lease whose generation was collected. Take a lease. |
| `TransientError`, `BudgetExceededError` | A fault after the store's retries, or a call past its request budget. Retry the request; [the errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which. |
| A change that never shows | `cache.genTtlMs: 0` turns the timed refresh off: another process's load then reaches the service with no bound at all. Leave it at its default, or invalidate on your own signal. |

## Limits

- **Freshness is stated, and it is not zero.** A reader that did not load the set sees a new generation within
  `cache.genTtlMs` (2,000 ms by default), and a running read can serve what it had already taken from the earlier generation
  ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load);
  [the bound in chunks](../guide/erasure.md#who-stops-seeing-the-id-and-when)). A pin has no refresh by design.
- **No write verb.** A service cannot add one id. A change is a load of the whole set, produced elsewhere, and each retained generation is a
  whole copy in storage ([generations and `keep`](../guide/loading.md#generations-and-keep)).
- **Not measured here.** This page ran on `MemoryStorage`, so it says nothing about a check's latency or about cost: see
  [the benchmarks](../benchmarks.md) for what has been timed (one shape of cold read, in one region on S3) and what has not.
- **The validated envelope is narrow.** Single-tenant, single-region, S3, read-mostly, up to about 100,000 segments:
  [what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt). A service outside it is
  yours to test.
- **A cold start pays for its first reads.** A new process has no readers open and no chunks cached: each segment's first
  check reads its row, its index and a chunk. A service that cannot take that on its first requests should warm the segments it
  needs (a `has` or a `count` each) before it reports ready.
