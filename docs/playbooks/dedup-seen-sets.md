# Dedup against what you have already processed, by day

Drop the ids a batch pipeline has already handled, keep a window of recent days as one set per day, and let old days expire.

A pipeline that must not send, charge or index the same person twice in a few days can keep, for each day, the set of ids
it processed that day. A new batch is then a set subtraction: the batch, minus the days in the window. This page runs the
loop on `MemoryStorage` with invented ids, and every `Output` is what the repo's tests print when they run the blocks as
written.

Use it when dedup happens per batch (a nightly send, an hourly ETL step) and "seen in the last N days" is the rule. It is
not a per-message claim: see [Limits](#limits).

## Day buckets and one batch

Each day is a segment in the `seen` namespace, named by its date. A batch is loaded as a segment of its own, and the fresh
ids are the batch minus the recent days. A day that has no bucket yet (the first run, or a day the job did not run) is not
an error when the combine says so with `allowAbsentOperands`.

This block imports `RoaringBitmap`.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage, RoaringBitmap } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

const day = (date: string) => store.segment(date, { namespace: 'seen' });

async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const ids: number[] = [];
  for await (const id of stream) ids.push(id);
  return ids;
}

type Segment = ReturnType<typeof day>;

/** The ids of a batch that none of `against` holds. The batch lives in its own segment while it is judged. */
async function freshAgainst(batchId: string, ids: number[], against: Segment[]): Promise<number[]> {
  const ref = { namespace: 'batches', segment: batchId };
  await store.load(ref, ids);
  const batch = store.segment(batchId, { namespace: 'batches' });
  // A throw here leaves the batch segment behind: a job that can fail drops it in a `finally`.
  const fresh = await collect(batch.andNot(against, { allowAbsentOperands: true }));
  await store.dropSegment(ref, { confirmSegment: batchId });
  return fresh;
}
const freshIds = (batchId: string, ids: number[], window: string[]) =>
  freshAgainst(batchId, ids, window.map(day));

/** Record `fresh` in `date`'s bucket: the bucket is the ids already there plus the new ones, loaded as one generation. */
async function record(date: string, fresh: number[]): Promise<number> {
  const bucket = new RoaringBitmap(fresh);
  for await (const batch of day(date).iterate().batches()) bucket.addMany(batch);
  // A bucket only grows within its day, so a load that would shrink it is refused.
  const result = await store.load({ namespace: 'seen', segment: date }, bucket, { guard: { minRetained: 1 } });
  return result.cardinality;
}

const window = ['2026-10-24', '2026-10-25', '2026-10-26'];

const first = await freshIds('run-1', [101, 102, 103, 103, 104], window);
console.log('run 1 fresh', first, 'bucket', await record('2026-10-26', first));

const second = await freshIds('run-2', [103, 104, 105, 106], window);
console.log('run 2 fresh', second, 'bucket', await record('2026-10-26', second));
```

Output:

<!-- output -->
```text
run 1 fresh [ 101, 102, 103, 104 ] bucket 4
run 2 fresh [ 105, 106 ] bucket 6
```

A duplicate inside a batch is one id, an id seen by an earlier run today is dropped, and `record` reads the day's bucket
back before it writes, because a load replaces a segment: the bucket is rebuilt as the ids already in it plus the new
ones. The pipeline's side effect (the send, the insert) happens between `freshIds` and `record`. Which order you choose
decides whether a crash in between repeats a batch or skips one: see [Limits](#limits).

## The window moves

Tomorrow's window is the last three days. The ids of days outside it are simply not in the subtraction.

<!-- typecheck -->
```ts
await record('2026-10-25', [101, 107]); // the bucket of an earlier day, written late
const nextWindow = ['2026-10-25', '2026-10-26', '2026-10-27'];
console.log('next day fresh', await freshIds('run-3', [101, 103, 107, 108], nextWindow));
console.log('a window with no buckets', await freshIds('run-4', [101, 103, 107, 108], ['2026-11-02', '2026-11-03']));
```

Output:

<!-- output -->
```text
next day fresh [ 108 ]
a window with no buckets [ 101, 103, 107, 108 ]
```

Run 3 drops 101, 103 and 107, each seen on a day still in the window, and keeps 108. Run 4 shows what a window with no
buckets means: nothing is subtracted, so every id is fresh. An id is new again once its day has left the window, which is
the point of a window: dedup lasts as long as the rule says.

## Fewer reads: the union of recent days

Subtracting seven days reads seven segments. When a window is wide, or many batches share it, materialize the union of the
window once and subtract that:

<!-- typecheck -->
```ts
const [oldest, ...rest] = window.map(day);
const merged = await (oldest as ReturnType<typeof day>).unionInto(
  store.segment('window-3d', { namespace: 'seen-windows' }),
  rest,
  { allowAbsentOperands: true, keep: 2 },
);
console.log('window holds', merged.cardinality);

const viaWindow = await freshAgainst('run-5', [101, 105, 200, 201], [
  store.segment('window-3d', { namespace: 'seen-windows' }),
]);
console.log('run 5 fresh', viaWindow);
```

Output:

<!-- output -->
```text
window holds 7
run 5 fresh [ 200, 201 ]
```

An `*Into` supersedes its destination, so a rolling `window-3d` rebuilt each morning reads as exactly that day's window. It keeps
every generation it writes unless told otherwise, each one a whole copy in storage, so the call passes `keep`
([generations and `keep`](../guide/loading.md#generations-and-keep)).

## Let old days expire

Expiry is per segment. Record when a bucket may go when you create it, and run the sweep from a scheduled job. A policy
recorded for a segment that has no data yet (`2026-10-24` here was never loaded) is kept on an empty row, which the sweep then
retires like any other.

<!-- typecheck -->
```ts
const DAY = 86_400_000;
for (const date of window) {
  const expiresAt = Date.parse(`${date}T00:00:00Z`) + 3 * DAY;
  await store.setRetention({ namespace: 'seen', segment: date }, { expiresAt });
}
const sweep = await store.retireExpired({ namespace: 'seen', now: Date.parse('2026-10-28T06:00:00Z') });
console.log('retired', sweep.retired);
for (const date of window) console.log(date, await store.exists({ namespace: 'seen', segment: date }));
```

Output:

<!-- output -->
```text
retired 2
2026-10-24 false
2026-10-25 false
2026-10-26 true
```

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

// A truncated bucket: the guard refuses a load that would drop ids from a day's set.
const shrink = await store.load({ namespace: 'seen', segment: '2026-10-26' }, [101], { guard: { minRetained: 1 } });
console.log(shrink.published, shrink.reason);

// A window that names a day nobody loaded, without allowAbsentOperands: the combine refuses it.
await store.load({ namespace: 'batches', segment: 'run-6' }, [1, 2]);
try {
  await collect(store.segment('run-6', { namespace: 'batches' }).andNot([day('1999-01-01')]));
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
false min-retained
ValidationError
```

| You see | What to do |
|---|---|
| `published: false` with `reason: 'min-retained'` | The load would have dropped ids from a bucket. Rebuild the bucket from the ids already in it plus the new ones, as `record` does. |
| `published: false` with `reason: 'superseded'` | Two writers loaded one bucket and this one lost. Give each bucket one writer, or run `record` again: it reads the bucket afresh. |
| `ValidationError` from `andNot` | A day in the window names no segment and `allowAbsentOperands` was not passed. Pass it when a missing day is legitimate; leave it out to be told. |
| `WriteConflictError`, `TransientError` | A race or a fault the store did not settle. Run the operation again; a load is safe to repeat. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) has each error. |

## Limits

- **Not a per-message claim.** The buckets are written once per batch, not once per message, so two batches that run at the
  same time can both treat an id as fresh. A hot-path "claim this id now" write belongs in a system built for it, Redis
  for instance; the [Redis mapping](../guide/getting-started.md#coming-from-redis-bitmaps) says why there is no `SETBIT` here.
- **Not exactly once.** Whether a crash between the side effect and `record` repeats a batch or skips one depends on which
  you do first. Record first and you can skip; act first and you can repeat. If neither is acceptable, make the side effect
  itself idempotent.
- **Expiry is per segment, never per id.** An id leaves the window when its whole day's bucket is retired, and the sweep is
  yours to schedule ([the pattern, and why there is no per-id expiry](../guide/retention.md#there-is-no-per-id-ttl)).
- **A batch with no fresh ids changes nothing.** `record` rebuilds the bucket from its own ids, so skip the call. A load of no
  ids over a segment that has ids is refused unless it says `allowEmpty: true`.
- **One writer per bucket.** A load replaces a segment; two jobs recording into one day's bucket race, and the loser is
  told (`superseded`) rather than merged.
- **Scale and tenancy.** The validated envelope is single-tenant and single-region on S3, up to about 100,000 segments, and it lists the `*Into` verbs and the other combine shapes as outside it
  ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)). This page ran on
  `MemoryStorage`, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
