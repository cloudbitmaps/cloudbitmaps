# Daily and monthly active users, and retention by cohort

Keep one segment per day of the ids that were active, count daily and monthly actives from the stored days, and read retention as the size of a signup cohort's overlap with a later day.

A product's activity numbers come down to sets of user ids: who was active on a day, who was active in the last 30 days, and
how many of the people who signed up on one day came back on a later one. With one stored segment per day, each number is a
count of a combine of segments, which `unionCount` and `intersectCount` return without streaming the ids. This page runs the
loop on `MemoryStorage` with invented ids, and every `Output` is what the repo's tests print when they run the blocks as
written.

Use it when the day's set is built upstream (an events pipeline or a warehouse query that ends in "these ids were active
on this day") and you want the aggregates from stored sets. It is not an event store: see [Limits](#limits).

## The layout: one segment per day

Each day is a segment in the `active` namespace, named by its date, and a signup cohort is a segment in the `cohorts`
namespace, named by the signup date. The ids are your user ids as unsigned 32-bit integers (if yours are emails or UUIDs,
[map them first](id-mapping.md)). A day is loaded once, when its set is complete; a later load replaces it.

This block invents 30 days of activity for 300 users. Users 1 to 120 signed up on the first day and form its cohort. Each
user is active on a day by a fixed rule, so the numbers are the same on every run.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

const DAY = 86_400_000;
const FIRST = Date.parse('2026-10-01T00:00:00Z');
const dateOf = (n: number) => new Date(FIRST + n * DAY).toISOString().slice(0, 10);
const days = Array.from({ length: 30 }, (_, n) => dateOf(n));

const dayRef = (date: string) => ({ namespace: 'active', segment: date });
const day = (date: string) => store.segment(date, { namespace: 'active' });

// An invented rule: the earlier a user's id, the likelier the user is active, and activity thins out over the month.
function activeOn(n: number): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= 300; id++) {
    const base = id <= 120 ? 60 : id <= 240 ? 25 : 4; // percent chance on the first day
    const roll = (Math.imul(id, 2654435761) ^ Math.imul(n + 1, 40503)) >>> 0;
    if (roll % 100 < base * (1 - n / 45)) ids.push(id);
  }
  return ids;
}

for (const [n, date] of days.entries()) await store.load(dayRef(date), activeOn(n));
await store.load({ namespace: 'cohorts', segment: days[0] as string }, Array.from({ length: 120 }, (_, i) => i + 1));

const cohort = store.segment(days[0] as string, { namespace: 'cohorts' });
console.log('days loaded', days.length, 'cohort', await cohort.count());
```

Output:

<!-- output -->
```text
days loaded 30 cohort 120
```

## Daily active users

A day's number is `count()` of its segment, read from the registry row and the object's index, with no chunk read
([what `count()` trusts](../guide/reading.md#what-count-trusts)).

<!-- typecheck -->
```ts
for (const n of [0, 1, 7, 29]) console.log(days[n], 'DAU', await day(days[n] as string).count());
```

Output:

<!-- output -->
```text
2026-10-01 DAU 103
2026-10-02 DAU 106
2026-10-08 DAU 95
2026-10-30 DAU 39
```

## Monthly active users: the union of the days

MAU is the number of distinct ids in any of the last 30 days: the size of the union of the day segments. `unionCount`
returns that size without writing a segment and without streaming the ids.

<!-- typecheck -->
```ts
const [firstDay, ...otherDays] = days.map(day);
const mau = await (firstDay as ReturnType<typeof day>).unionCount(otherDays);
console.log('MAU over 30 days', mau);

const week = days.slice(-7).map(day);
console.log('active in the last 7 days', await (week[0] as ReturnType<typeof day>).unionCount(week.slice(1)));
```

Output:

<!-- output -->
```text
MAU over 30 days 278
active in the last 7 days 176
```

A union reads, for each chunk key more than one day holds, the chunks it must decode, and answers a key only one day holds
from that day's index. Where the days share most keys (user ids dense in a small range, as here) every key is decoded; where
they share few, much of the answer comes from the indexes. Which one you have decides the bytes, not the request count: see
[What it costs](#what-it-costs).

A day the pipeline has not produced yet (today's, or one a job skipped) is a segment that does not exist, and a combine
refuses an operand that names none. For a window that ends today, say that a missing day is fine:

<!-- typecheck -->
```ts
const window = [...days, dateOf(30), dateOf(31)].map(day); // two days that were never loaded
console.log('MAU with two days missing', await (window[0] as ReturnType<typeof day>).unionCount(window.slice(1), { allowAbsentOperands: true }));
```

Output:

<!-- output -->
```text
MAU with two days missing 278
```

## Retention by cohort

Day-N retention is the share of a signup cohort that is active again N days later: the size of the cohort's intersection
with that day, over the size of the cohort. `intersectCount` returns the size.

<!-- typecheck -->
```ts
const size = await cohort.count();
for (const n of [1, 7, 14, 29]) {
  const back = await cohort.intersectCount([day(days[n] as string)]);
  console.log(`day ${n}`.padEnd(7), String(back).padStart(3), `of ${size}`, `${((100 * back) / size).toFixed(1)}%`);
}
```

Output:

<!-- output -->
```text
day 1    74 of 120 61.7%
day 7    65 of 120 54.2%
day 14   52 of 120 43.3%
day 29   28 of 120 23.3%
```

That is one count a row, so a table of many days makes one combine a row, each reading the cohort again. For a whole table
in one pass, a dry run of `materializeMany` names the cohort and the days as operands, reads each once and computes every
output without writing any:

<!-- typecheck -->
```ts
const retentionDays = [1, 7, 14, 29];
const operands = {
  cohort,
  ...Object.fromEntries(retentionDays.map((n) => [`d${n}`, day(days[n] as string)])),
};
const outputs = retentionDays.map((n) => ({
  dest: store.segment(`retained-${n}`, { namespace: 'scratch' }),
  expr: { and: ['cohort', `d${n}`] },
  allowEmpty: true,
}));
const table = await store.materializeMany({ operands, outputs, keep: 1, dryRun: true });
for (const [i, outcome] of table.outputs.entries()) {
  if ('error' in outcome) throw outcome.error;
  console.log(`day ${retentionDays[i]}`.padEnd(7), outcome.cardinality);
}
```

Output:

<!-- output -->
```text
day 1   74
day 7   65
day 14  52
day 29  28
```

The answers equal `intersectCount`'s. The price is that the call pins every operand, holds each result in memory while it
runs and reads a registry row for each `dest` to judge it ([many outputs from one pass](../guide/loading.md#many-outputs-from-one-pass-materializemany)).

When you need the people and not their number (to message the ones who came back, or the ones who did not), write the
result as a segment with `intersectInto` and read it, or subtract it with `andNot`:

<!-- typecheck -->
```ts
const retained = store.segment('retained-day-7', { namespace: 'reports' });
const written = await cohort.intersectInto(retained, [day(days[7] as string)], { keep: 1 });
console.log('retained on day 7', written.cardinality);

const lapsed: number[] = [];
for await (const ids of cohort.andNot([retained]).batches()) lapsed.push(...ids);
console.log('lapsed by day 7', lapsed.length, 'first', lapsed.slice(0, 5));
```

Output:

<!-- output -->
```text
retained on day 7 65
lapsed by day 7 55 first [ 1, 6, 12, 13, 16 ]
```

An `*Into` supersedes its destination and keeps every generation it writes unless told otherwise, so the call passes `keep`
([generations and `keep`](../guide/loading.md#generations-and-keep)).

## A rolling window that expires

Only the last 30 days matter for MAU, so record when each day may go and sweep from a scheduled job. Retention is per
segment: a day leaves when its whole segment is retired.

<!-- typecheck -->
```ts
for (const date of days) {
  await store.setRetention(dayRef(date), { expiresAt: Date.parse(`${date}T00:00:00Z`) + 30 * DAY });
}
const sweep = await store.retireExpired({ namespace: 'active', now: Date.parse('2026-11-03T06:00:00Z') });
console.log('retired', sweep.retired);

const live = days.map(day);
const rolled = await (live[0] as ReturnType<typeof day>).unionCount(live.slice(1), { allowAbsentOperands: true });
console.log('MAU over what is left', rolled);
```

Output:

<!-- output -->
```text
retired 4
MAU over what is left 272
```

The first four days were retired, so the same 30-name window now counts the 26 that remain. `allowAbsentOperands` is what lets
a window name days that are gone, and it is also what hides a day that was never loaded, so a job that needs every day
present checks its days with `store.exists` first.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

// A day nobody loaded, without allowAbsentOperands.
try {
  await day(days[10] as string).unionCount([day('1999-01-01')]);
} catch (error) {
  console.log(errorKind(error));
}

// A union wider than a per-call budget allows.
try {
  await day(days[10] as string).unionCount(days.slice(11, 29).map(day), { budget: { maxRequests: 5 } });
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
ValidationError
BudgetExceededError
```

| You see | What to do |
|---|---|
| `ValidationError` from a count | A day in the window names no segment, and `allowAbsentOperands` was not passed. Pass it when a missing day is legitimate; leave it out to be told. |
| `BudgetExceededError` | The call needs more requests than its budget. Narrow the window, or raise `budget` for a trusted job ([the budget](../guide/production.md#the-request-budget)). |
| `WriteConflictError`, `TransientError` | A race or a fault the store did not settle. Run the operation again. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) has each error. |

## What it costs

Every count in this table is counted from the engine's own request model and the published figures, not measured by this page,
which ran on `MemoryStorage`. For a window of D days (D operands in one combine):

| Call | What it makes | Figure |
|---|---|---|
| `day.count()` | no chunk read; the registry row's summary or the index answers | derived: [what `count()` trusts](../guide/reading.md#what-count-trusts) |
| `unionCount` over D days | at least a pointer read and a tail read for each day, and the chunks of every key more than one day holds | counted in memory: 31 operands of 500,000 ids made 93 requests, 3 a day, and read 9,726,064 bytes where the stream read 40,102,468 ([the record](../benchmarks.md#counting-a-combine--counted-in-memory-and-measured-on-s3)) |
| `intersectCount` of a cohort and a day | the requests `intersect` makes: only the chunks both hold | measured on S3: 6 GETs at a million ids an operand, 8 at five million, 10 at ten million ([the S3 run](../benchmarks.md#large-operands--run-2026-11-03-fbbb8)) |

A 30-day MAU is therefore a call of order 90 requests, where a stream of the same union reads every chunk of every day. The
counts write nothing and hold no result. Over a day's retention, a table of N days by `intersectCount` is N combines; read
the cohort once with a dry run of `materializeMany` when N is large.

## Limits

- **Not measured on S3 for this shape.** The count verbs are measured on S3 for two operands, and the 31-operand union is
  counted in memory only. A 30-day union on S3 is therefore unmeasured: its request count is the model's, and its latency
  is not known ([what is still owed](../benchmarks.md#what-is-still-owed), [the validated envelope](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)).
- **Operands and budget.** A combine takes as many operands as you list, each charged to the per-op budget (1,000,000
  request units by default), and a wide union is refused rather than quietly billed. This page ran 30 days and one 32-name
  window; the largest measured is 31.
- **The numbers are as exact as `count()` is trusted.** `unionCount` answers a key only one day holds from that day's index;
  where that is not enough, stream the union with `.batches()` and add up the lengths, or use `intersectCount`, which decodes
  every key it counts ([what it trusts](../guide/reading.md#count-a-combine)).
- **A day is a snapshot.** The set is built upstream and loaded whole; a late event means loading the day again, which replaces it
  (read the day first and load the union of old and new, as [the dedup page](dedup-seen-sets.md) does with `record`).
- **Not an event store.** There is no time inside a day, no count of how often a user was active, no sequence ("came back
  after doing X"; see [the funnels page](funnels.md)). Per-user counters and building a day's set from events one at a
  time are a job for a system built for them, Redis for instance.
- **Counts across calls are not one instant.** Each call reads the days current when it starts. To report DAU, MAU and
  retention for one instant while loads continue, pin the days first and count over the pins ([a fixed point in
  time](../guide/reading.md#read-one-fixed-point-in-time)).
- **Expiry is per segment, never per id**, and the sweep is yours to schedule ([why there is no per-id expiry](../guide/retention.md#there-is-no-per-id-ttl)).
- **Latency and cost** were not measured by this page; see [the benchmarks](../benchmarks.md) and [the cost guide](../guide/cost.md).
