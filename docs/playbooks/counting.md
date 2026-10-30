# Counting an intersection, union or difference of stored segments

Count what a combine of stored segments holds with the direct count calls, and the other ways for what they do not do, with what each reads and holds and which to pick.

"How many people are in both lists" is the question most reporting asks, and a combine answers a different one: it
returns the ids. `count()` answers for one stored segment, from the registry row. For a combine, `intersectCount`,
`unionCount` and `andNotCount` (0.26.0 and later; unreleased) return the size without streaming the ids. This page runs
them first, then the other ways to the same number, each correct and each with a price, for the jobs the direct count does
not do. Every block runs on `MemoryStorage` with invented ids, and every `Output` is what the repo's tests print when they
run the blocks as written.

Use it when you need a number, not the ids: an audience size, an overlap between two lists, a facet count, a monthly
total over day segments. The pages that need a count link here.

## Set up two segments

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });
await store.load({ segment: 'shoppers' }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
await store.load({ segment: 'subscribers' }, [4, 5, 6, 11, 12, 13, 14]);
const shoppers = store.segment('shoppers');
const subscribers = store.segment('subscribers');
console.log(await shoppers.count(), await subscribers.count());
```

Output:

<!-- output -->
```text
10 7
```

The two share ids 4, 5 and 6, so the answers to expect are 3 in both, 14 in either, 7 in the shoppers only and 4 in the
subscribers only.

## The direct count: `intersectCount`, `unionCount`, `andNotCount`

<!-- typecheck -->
```ts
console.log('both', await shoppers.intersectCount([subscribers]));
console.log('either', await shoppers.unionCount([subscribers]));
console.log('shoppers only', await shoppers.andNotCount([subscribers]));
```

Output:

<!-- output -->
```text
both 3
either 14
shoppers only 7
```

Each takes the options its stream takes (the range `after` and `through`, `concurrency`, `budget`, `allowAbsentOperands`,
and `exclude` on `intersectCount` and `unionCount`) and answers a `Promise<number>`. An intersection decodes every key
all its operands hold, so `intersectCount` is exact and makes the requests `intersect` makes. In a union or a difference,
a chunk key only one operand holds, that no exclude holds and that the range does not cut is answered from its index, as
`count()` is, and its chunk is not read; every other key is decoded and counted as the stream reads it. So `unionCount`
and `andNotCount` make no more requests than their streams and read fewer bytes where the operands share few chunks: in the bench's record, a union of two 10,000,000-id segments on the packed layout made 6 requests and read
2,165,888 bytes where its stream made 36 and read 33,339,872 ([what it costs](../guide/reading.md#count-a-combine)).
It writes nothing and holds no result: the memory is the stream's window of ranges.

`unionCount` and `andNotCount` trust what `count()` trusts: the index, for each key they answer without decoding
([what `count()` trusts](../guide/reading.md#what-count-trusts)); `intersectCount` trusts no index. A decoded key is exact.
On a pinned handle it counts the pinned generation, each pinned operand adding a footer read before the first key and at
each look, and a leased handle is checked at the start and at each look. `intersectCount([])` is refused as `intersect([])`
is, and `unionCount([])` and `andNotCount([])`, with no `exclude` and no range, are `count()`.

Use the other ways below for what this does not do: an exact count of a union or a difference, a figure that describes one instant
across calls (pin the operands first; the direct count of pins answers for their generations), many counts over the same
segments in one pass, and a result you keep.

The other ways follow.

## Way 1: stream the combine and count the arrays

A combine is a stream, and `.batches()` yields it one `Uint32Array` per chunk, so a count is the sum of the arrays'
lengths: one `await` per chunk, not one per id ([`batches()`](../guide/reading.md#read-a-chunk-at-a-time-batches)).

<!-- typecheck -->
```ts
/** The size of whatever a combine yields, counted an array at a time. */
async function countOf(batches: AsyncIterable<Uint32Array>): Promise<number> {
  let n = 0;
  for await (const ids of batches) n += ids.length;
  return n;
}

console.log('both', await countOf(shoppers.intersect([subscribers]).batches()));
console.log('either', await countOf(shoppers.union([subscribers]).batches()));
console.log('shoppers only', await countOf(shoppers.andNot([subscribers]).batches()));
```

Output:

<!-- output -->
```text
both 3
either 14
shoppers only 7
```

This is exact for every key, since it decodes every payload it reads; `intersectCount` is just as exact and makes the same requests, so use this way only for a union or a difference where exactness matters more than the request count, since `unionCount` and `andNotCount` trust the index for keys only one operand holds. It writes nothing. The array you receive is at most 65,536 ids (256 KiB); the combine
also holds the ranges it reads ahead (up to `concurrency` per operand, each up to 1 MiB) and one reader per operand
([the memory ceilings](../guide/production.md#the-memory-ceilings)). Its requests are the combine's own: an `intersect` reads only the chunks every operand holds (a cold intersect of
two segments that share 100 of their 1,999 chunks made 6 GETs in [the in-region run](../benchmarks.md#the-in-region-run--run-2026-10-13-b329d)),
an `andNot` reads all of the first segment and the others only where they overlap it, and a `union` reads every chunk of
every operand ([what each combine reads](../guide/reading.md#combine-segments-intersect-union-andnot)). So way 1 reads
no more than `intersectCount` for an intersection, which does the same without building the ids, and is the expensive way to count
a union.

## Way 2: two counts and one intersection, over pins

A union and a difference follow from the size of each segment and the size of what they share: the union is the size of
one plus the size of the other minus the size they share, and a difference is the size of the first minus the size they
share. Only the shared chunks are read, so a union is counted without reading every chunk. Take the three numbers from
pins, so they describe one instant. The pins are not free: each reads the segment's registry row and opens its generation
(a tail read), a lease is written to the row before the object is opened, and `release()` is one more registry read and
write ([what a lease costs](../guide/reading.md#hold-a-generation-for-a-job-a-lease)). So way 2 saves chunk reads, not
requests, and a pin without a lease writes nothing but can lose its generation.

<!-- typecheck -->
```ts
const lease = Date.now() + 60_000;
const [pinnedShoppers, pinnedSubscribers] = await Promise.all([
  shoppers.pin({ leaseUntil: lease }),
  subscribers.pin({ leaseUntil: lease }),
]);
try {
  const shared = await countOf(pinnedShoppers.intersect([pinnedSubscribers]).batches());
  const sizeA = await pinnedShoppers.count();
  const sizeB = await pinnedSubscribers.count();
  console.log('either', sizeA + sizeB - shared);
  console.log('shoppers only', sizeA - shared);
  console.log('subscribers only', sizeB - shared);
} finally {
  await Promise.all([pinnedShoppers.release(), pinnedSubscribers.release()]);
}
```

Output:

<!-- output -->
```text
either 14
shoppers only 7
subscribers only 4
```

The pins are the point. With live handles, each call resolves the generation current when it starts, so a load that lands
between the calls gives a number that describes two instants. The block below makes that happen on purpose, with a load
between the size of `left` and the intersection:

<!-- typecheck -->
```ts
const left = store.segment('left');
const right = store.segment('right');
await store.load({ segment: 'left' }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
await store.load({ segment: 'right' }, [4, 5, 6, 11, 12, 13, 14]);

const sizeLeft = await left.count();
await store.load({ segment: 'left' }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // a load lands between the calls
const sharedNow = await countOf(left.intersect([right]).batches());
console.log('live handles', sizeLeft + (await right.count()) - sharedNow);
console.log('the union now', await countOf(left.union([right]).batches()));
```

Output:

<!-- output -->
```text
live handles 13
the union now 14
```

13 is the union at neither instant: it was 14 before the load and is 14 after it. A pin without a lease is a hold only
while no later load collects its generation, so take a lease for the length of the count and release it
([a lease](../guide/reading.md#hold-a-generation-for-a-job-a-lease), [one fixed point in time](../guide/reading.md#read-one-fixed-point-in-time)).
Way 2 also trusts `count()` for the two sizes, as `count()` is trusted: from the registry row's summary or the index,
without decoding a payload ([what `count()` trusts](../guide/reading.md#what-count-trusts)). Where an exact answer matters
more than the request count, use way 1 for the union too.

## Way 3: read each operand into memory once

When the same operands are counted many times (one audience against forty others, or each facet against the current
filter), read each into a `RoaringBitmap` and count in memory. The cardinality methods build no result you can keep.

This block imports `RoaringBitmap` (0.25.0 and later).

<!-- typecheck -->
```ts
import { RoaringBitmap } from '@cloudbitmaps/roaring';
import type { Segment } from '@cloudbitmaps/roaring';

async function toBitmap(segment: Segment): Promise<RoaringBitmap> {
  const bitmap = new RoaringBitmap();
  for await (const ids of segment.iterate().batches()) bitmap.addMany(ids);
  return bitmap;
}

await store.load({ segment: 'recent' }, [1, 9, 15, 16]);
const audience = await toBitmap(shoppers);
for (const name of ['subscribers', 'recent']) {
  const other = await toBitmap(store.segment(name));
  console.log(
    name,
    'both',
    audience.andCardinality(other),
    'either',
    audience.orCardinality(other),
    'only shoppers',
    audience.andNotCardinality(other),
  );
}
```

Output:

<!-- output -->
```text
subscribers both 3 either 14 only shoppers 7
recent both 2 either 12 only shoppers 8
```

Each operand is read in full, once, and held decoded, so the memory is the operands' size; in return a count after the
first is no request at all, and it is exact. It reads every chunk of every operand, so for one count of an intersection it
costs more than way 1. A `RoaringBitmap` is synchronous: a large one holds the event loop while it combines
([where to run it](../guide/production.md#what-blocks-the-event-loop-and-where-to-run-it)).

## Way 4: a dry run of `materializeMany`

Many counts over the same few named segments, in one pass: a dry run computes each output and writes nothing.

<!-- typecheck -->
```ts
const operands = { shoppers, subscribers, recent: store.segment('recent') };
const scratch = (n: number): Segment => store.segment(`count-${n}`, { namespace: 'scratch' });
const outputs = [
  { dest: scratch(0), expr: { and: ['shoppers', 'subscribers'] }, allowEmpty: true },
  { dest: scratch(1), expr: { or: ['shoppers', 'subscribers', 'recent'] }, allowEmpty: true },
  { dest: scratch(2), expr: { andNot: ['shoppers', 'subscribers', 'recent'] }, allowEmpty: true },
  { dest: scratch(3), expr: { and: ['subscribers', 'recent'] }, allowEmpty: true },
];
const names = ['shoppers and subscribers', 'any of the three', 'shoppers in neither', 'subscribers and recent'];
const preview = await store.materializeMany({ operands, outputs, keep: 1, dryRun: true });
for (const [i, outcome] of preview.outputs.entries()) {
  if ('error' in outcome) throw outcome.error;
  console.log(names[i], outcome.cardinality);
}
```

Output:

<!-- output -->
```text
shoppers and subscribers 3
any of the three 16
shoppers in neither 5
subscribers and recent 0
```

Every operand is read once for all four outputs, every output may be any `and`, `or` or `andNot` expression over any number
of operands, and the answer is exact. The price is that each output needs a `dest` name even though nothing is written to
it, that the call pins every operand, and that it holds each output's result in memory while it runs (up to
`maxBufferedBytes`, 256 MiB by default); a dry run also reads each `dest` to judge it, one registry read each
([a dry run](../guide/loading.md#look-before-you-publish-a-dry-run), [many outputs from one pass](../guide/loading.md#many-outputs-from-one-pass-materializemany)).

## Way 5: keep the result as a segment

When the answer is a report that recurs ("active this month"), write it once a period as a segment and count it with
`count()`. An `*Into` verb returns the written size too.

<!-- typecheck -->
```ts
const overlap = store.segment('overlap-shoppers-subscribers');
const written = await shoppers.intersectInto(overlap, [subscribers], { keep: 2 });
console.log(written.published, written.cardinality, await overlap.count());

// A month from its days: counts of the days give no short formula for their union, so the report is written once and counted.
await store.load({ segment: 'day-1' }, [1, 2, 3]);
await store.load({ segment: 'day-2' }, [2, 3, 4]);
await store.load({ segment: 'day-3' }, [3, 4, 5, 6]);
const month = store.segment('active-this-month');
const monthly = await store.segment('day-1').unionInto(month, [store.segment('day-2'), store.segment('day-3')], { keep: 2 });
console.log(monthly.cardinality, await month.count());
```

Output:

<!-- output -->
```text
true 3 3
6 6
```

A recurring report costs one combine and one write a period, and each count after it is a registry read. A one-off
question costs a segment you did not want: it holds ids, so an erasure and a retention policy cover it, and it stays
until you drop it ([the `*Into` verbs](../guide/loading.md#write-a-result-into-another-segment-the-into-verbs),
[retiring a segment by hand](../guide/retention.md#retire-a-segment-by-hand-storedropsegment)). Name a standing report so
the next run replaces it, and set `keep` so the generations it leaves are collected.

## Which to pick

| You need | Pick | It reads | It holds | It writes |
|---|---|---|---|---|
| The size of an intersection, a union or a difference, once | `intersectCount`, `unionCount`, `andNotCount` | the intersect's requests; a union's or difference's chunks only where operands share keys | the ranges read ahead | nothing |
| The size of a union or a difference with every key decoded | way 1 | every chunk (a union), all of the first operand's and the excludes' where they overlap it (a difference) | the array you receive (256 KiB) and the ranges read ahead | nothing |
| The size of a union or a difference of two, from three numbers over pins | way 2 | the shared chunks, a row read and a tail read per pin, and two counts from the registry | the ranges read ahead | a lease on each segment (a registry write each, and one more on `release()`) |
| Many counts over the same few segments | way 4 | each operand's chunks once | the outputs' results, up to 256 MiB by default | nothing |
| One segment against many, or counts repeated | way 3 | every chunk of every operand, once | the operands | nothing |
| A union of many segments | way 4 (an `or` over any number of operands, one pass), way 5, or way 3 over every operand | every chunk | the results, the result, or every operand | nothing, a segment, or nothing |
| A number a report reads every period | way 5 | the combine's chunks, once a period | the result | a segment, once a period |

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // A mistyped name: the combine refuses an operand that was never loaded rather than count it as empty.
  await countOf(shoppers.intersect([store.segment('shopers')]).batches());
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
ValidationError
```

| You see | What to do |
|---|---|
| `ValidationError` from a combine | An operand names no segment (a typo, a missing `namespace`, a dropped segment), an option is wrong, or an operand belongs to another store. Fix the call: it is raised before the combine reads a chunk. `allowAbsentOperands: true` counts a segment that may not exist yet as empty. |
| `NotFoundError` from a pinned handle | The pin had no lease and a load collected its generation. Take a lease for the length of the count. |
| `LeaseExpiredError` from a pinned handle | The lease ended or was released. Take a pin with a longer lease; it is never read as an empty set. |
| `BudgetExceededError` | The combine would issue more chunk reads than its budget allows; raise `budget` with room to spare or count in ranges (`after`, `through`). |
| `TransientError` | A fault after the store's retries. Run the count again. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which errors to retry. |
| An output of a dry run with `error` set | That output would have failed its publish (a damaged operand, a moved exclude); the others are counted. Read `outcome.error`. |

## Limits

- **`unionCount` and `andNotCount` trust the index for keys only one operand holds**, as `count()` does, and have no
  option that decodes them all; `intersectCount` is exact, and for a union or a difference way 1 is the exact count. Each other way costs reads, memory or a write.
- **Counts across several segments are as fresh as the handles they read.** Live handles can describe two instants; pins
  describe one. The bound on what a long call serves of an earlier generation is
  [how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load).
- **An `andNot` and a `union` read more than an `intersect`.** Only an intersection skips chunks; `unionCount` and
  `andNotCount` read fewer bytes than their streams where the operands share few chunks, but still read the shared ones.
- **Overlap matrices.** N audiences against each other is N(N-1)/2 combines. Read each audience once (way 3 or way 4);
  never stream one combine per pair.
- **Some shapes are unmeasured on S3.** An intersect, a union, an `andNot` and the `*Into` verbs are measured on real S3
  for two operands; more than two operands, other overlaps and `materializeMany` (way 4, counted in memory only) are not
  ([what is still owed](../benchmarks.md#what-is-still-owed), [the validated envelope](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)).
- **Not measured here.** This page ran on `MemoryStorage`, so it says nothing about the latency or cost of a count; see
  [the cost guide](../guide/cost.md) and [the benchmarks](../benchmarks.md).
