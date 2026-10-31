# Feature flags, rollouts and experiment cohorts by user set

Keep each flag and each experiment variant as a set of user ids, check it per request, roll out by percentage and expire an experiment's sets on a date.

A flag that is a list of people (a beta, a holdout, the arms of an experiment) is a set, and "is this person in it" is
the one read a request path makes. Here each flag is a segment, a check is `has`, and a change is a load. This page runs
on `MemoryStorage` with invented ids, and every `Output` is what the repo's tests print when they run the blocks as
written.

Use it when who is in a cohort is decided upstream (a query, a rollout job) and read at request time, and a flip that
takes effect within seconds is soon enough. It is not a flag service: there is no UI, no targeting rules and no write
per flip. See [Limits](#limits).

## A segment per flag and per variant

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const backend = new MemoryStorage();
const store = new CloudRoaring({ storage: backend });

const flag = (key: string) => store.segment(key, { namespace: 'flags' });
const variant = (experiment: string, arm: string) =>
  store.segment(`${experiment}:${arm}`, { namespace: 'experiments' });

await store.load({ namespace: 'flags', segment: 'beta-program' }, [11, 12, 13, 14, 15, 16]);
await store.load({ namespace: 'flags', segment: 'holdout' }, [14, 15]);
await store.load({ namespace: 'experiments', segment: 'checkout-copy:a' }, [21, 22, 23]);
await store.load({ namespace: 'experiments', segment: 'checkout-copy:b' }, [24, 25, 26]);

// The check a request makes.
async function inBeta(userId: number): Promise<boolean> {
  return (await flag('beta-program').has(userId)) && !(await flag('holdout').has(userId));
}
console.log(await inBeta(12), await inBeta(14), await inBeta(99));
console.log(await variant('checkout-copy', 'a').has(22), await variant('checkout-copy', 'b').has(22));
```

Output:

<!-- output -->
```text
true false false
true false
```

The first `has` of a segment reads its registry row, its object's index and the one chunk that could hold the id; after
that it answers from the store's cache. Build the store once per process and reuse it; building one does no I/O. The ids are the same unsigned 32-bit
integers everywhere, so a user id from a database goes in as it is.

For a list-shaped question over the whole cohort, the same sets combine: the people in the beta and not in the holdout are
one stream.

<!-- typecheck -->
```ts
const cohort: number[] = [];
for await (const id of flag('beta-program').andNot([flag('holdout')])) cohort.push(id);
console.log(cohort);
```

Output:

<!-- output -->
```text
[ 11, 12, 13, 16 ]
```

## A flip is a load, and a reader sees it on its next refresh

Changing who is in a set means loading the new set. A process that is reading sees the new generation within
`cache.genTtlMs` (2000 ms by default), not instantly. To see this without waiting, the next block gives a second store,
the reader, a clock the code moves by hand.

<!-- typecheck -->
```ts
import type { Clock } from '@cloudbitmaps/roaring';

let now = Date.UTC(2026, 9, 26, 12, 0, 0);
const clock: Clock = { now: () => now, sleep: async () => {} };
const reader = new CloudRoaring({ storage: backend, seams: { clock } }); // cache.genTtlMs: the default, 2000

console.log('reader before the flip', await reader.segment('beta-program', { namespace: 'flags' }).has(17));

// The rollout job adds user 17 to the beta.
await store.load({ namespace: 'flags', segment: 'beta-program' }, [11, 12, 13, 14, 15, 16, 17]);

console.log('writer after the flip', await flag('beta-program').has(17));
console.log('reader before its refresh passes', await reader.segment('beta-program', { namespace: 'flags' }).has(17));
now += 3_000;
console.log('reader after its refresh passes', await reader.segment('beta-program', { namespace: 'flags' }).has(17));
```

Output:

<!-- output -->
```text
reader before the flip false
writer after the flip true
reader before its refresh passes false
reader after its refresh passes true
```

The store that made the load sees it at once; every other store sees it once its refresh interval has passed. A lower
`cache.genTtlMs` makes flips visible sooner and costs more registry reads; `0` turns the timed refresh off, and a store set
that way sees another process's load only when something invalidates it ([how soon a reader sees a new
load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).

## A percentage rollout

There is no percentage verb, and none is needed: choose a stable hash, bucket every user id with it, and keep one segment
per range of buckets. A rollout step is then a union of ranges, and the same user stays in as the percentage grows, because
the hash does not change. The hash and the salt are yours; this one is FNV-1a, salted with the flag's key so two flags do
not roll out to the same people.

<!-- typecheck -->
```ts
function bucketOf(flagKey: string, userId: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${flagKey}:${userId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

// Your query: every user id the rollout applies to. Ten ranges of ten buckets each, loaded once.
const universe = Array.from({ length: 400 }, (_, i) => 5_000 + i);
const ranges: number[][] = Array.from({ length: 10 }, () => []);
for (const id of universe) (ranges[Math.floor(bucketOf('new-checkout', id) / 10)] as number[]).push(id);
for (const [i, ids] of ranges.entries()) {
  await store.load({ namespace: 'rollouts', segment: `new-checkout:${i}` }, ids, { allowEmpty: true });
}
const slice = (i: number) => store.segment(`new-checkout:${i}`, { namespace: 'rollouts' });

// A step: the flag is the union of the first `tenths` ranges, written as a new generation of the flag's segment.
async function rollOutTo(tenths: number): Promise<number> {
  const first = slice(0);
  const rest = Array.from({ length: tenths - 1 }, (_, i) => slice(i + 1));
  await first.unionInto(flag('new-checkout'), rest, { keep: 2 });
  return flag('new-checkout').count();
}
for (const tenths of [1, 3, 6]) console.log(`${tenths * 10}%`, await rollOutTo(tenths));
```

Output:

<!-- output -->
```text
10% 41
30% 124
60% 244
```

An `*Into` keeps every generation it writes unless told otherwise, and each retained generation is a whole copy in storage, so
the step passes `keep` (`keep: 2` leaves two older generations). A roll back is a step to a smaller number, and the check is the same `has` as before. Prove the property the recipe relies
on, that nobody leaves while the percentage grows, with the set comparisons of the standalone class:

This block imports `RoaringBitmap`.

<!-- typecheck -->
```ts
import { RoaringBitmap } from '@cloudbitmaps/roaring';

async function members(segment: ReturnType<typeof flag>): Promise<RoaringBitmap> {
  const bitmap = new RoaringBitmap();
  for await (const batch of segment.iterate().batches()) bitmap.addMany(batch);
  return bitmap;
}
const at60 = await members(flag('new-checkout'));
await rollOutTo(3);
const at30 = await members(flag('new-checkout'));
console.log('30% is a subset of 60%', at30.isSubset(at60), at30.size, at60.size);
```

Output:

<!-- output -->
```text
30% is a subset of 60% true 124 244
```

## A timed experiment

An experiment's sets should not outlive the experiment. Record when each expires, once, when you create it; a sweep that
you schedule retires every segment whose date has passed. Retention is per segment, never per id.

<!-- typecheck -->
```ts
const DAY = 86_400_000;
const start = Date.UTC(2026, 9, 26);
for (const arm of ['a', 'b']) {
  await store.setRetention({ namespace: 'experiments', segment: `checkout-copy:${arm}` }, { expiresAt: start + 14 * DAY });
}
console.log(await store.getRetention({ namespace: 'experiments', segment: 'checkout-copy:a' }));

// The sweep, run on day 7 and on day 15. `now` is passed so this page prints the same thing every time.
const early = await store.retireExpired({ namespace: 'experiments', now: start + 7 * DAY, dryRun: true });
const late = await store.retireExpired({ namespace: 'experiments', now: start + 15 * DAY });
console.log('day 7 would retire', early.wouldRetire, '- day 15 retired', late.retired);
console.log(await store.exists({ namespace: 'experiments', segment: 'checkout-copy:a' }));
```

Output:

<!-- output -->
```text
{ expiresAt: 1794182400000 }
day 7 would retire 0 - day 15 retired 2
false
```

The sweep is a call, not a timer: run it from a scheduled job, once a day is enough, and preview with `dryRun` first
([the sweep](../guide/retention.md#run-the-sweep-storeretireexpired)).

## What goes wrong

A direct read of a segment that was never loaded answers empty, so a mistyped flag key reads as "off for everyone", and
nothing throws. Check that the flags a service depends on exist when it starts.

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

const typo = store.segment('new-chekout', { namespace: 'flags' });
console.log(await typo.has(5_000), await store.exists({ namespace: 'flags', segment: 'new-chekout' }));

try {
  await flag('beta-program').has(Number('not-an-id'));
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
| `has` answering `false` for everyone | The segment does not exist or was never loaded: check `store.exists(ref)` at startup and alert when a flag you read is missing. A combine refuses a missing operand with `ValidationError`, where `has` answers empty. |
| `ValidationError` from `has` | The id is not an integer from 0 to 4,294,967,295 (a string, `NaN`, a negative, a 64-bit id). Map identifiers to a 32-bit integer before the call. |
| `published: false` with `reason: 'superseded'` from a load | Another job loaded the same flag first. Run yours again. |
| `TransientError` from `has` | The store already retried a throttle or a dropped connection. Decide what the request does with an unknown flag (usually: the default), and do not retry in a tight loop. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) has each error. |

## Limits

- **A flip is a load.** It is visible to the store that made it at once, and to every other store within `cache.genTtlMs`
  (default 2000 ms; `0` turns the refresh off). A flag that must flip faster than that is not served by this.
- **Not a flag service.** There is no UI, no targeting language, no audit of who changed what beyond the store's audit sink,
  and no per-flip write: a flip is a whole new generation of the set.
- **The percentage is a recipe, not a feature.** The hash, the salt, the ranges and the user universe are the caller's. A
  user created after the ranges were loaded is in no range until the next load.
- **Not for a sub-millisecond path without the cache.** A first `has` of a segment reads its registry row, its index and one
  chunk; after that it answers from memory. Keep one store per process.
- **Scale and tenancy.** One segment per flag and per variant is cheap, but the validated envelope is single-tenant and
  single-region on S3, up to about 100,000 segments, and it lists the `*Into` verbs and the other combine shapes as outside it
  ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)). This page ran on
  `MemoryStorage`, so it says nothing about latency; see [the benchmarks](../benchmarks.md).
