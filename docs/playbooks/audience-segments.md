# Audience segments from a warehouse, end to end

Seed audiences from a warehouse export, refresh them on a schedule, compose a campaign audience, count it, send it page by page and read one fixed point in time.

An audience here is a set of integer user ids, one canonical unsigned 32-bit id per person, kept as a segment in object
storage. The warehouse decides who is in each set and a job loads the answer; everything after that is reading: a
campaign is a combine of segments (in this list and in that one, and not in the opt-out list), and a send walks the
result in pages. This page runs the whole path on `MemoryStorage` with invented ids, and every `Output` is what the
repo's tests print when they run the blocks as written.

Use it when your segmentation is a scheduled job (a nightly query, a pipeline step) and the reads that follow, "how big
is this audience" and "send to these people", are what need to be cheap, without an always-on cache holding every set.
It does not take a write per event: see [Limits](#limits).

## Seed segments from a warehouse export

Each audience is a segment, and suppression lists sit in their own namespace so a query for "every opt-out" is
`store.segments({ namespace: 'suppression' })`. The warehouse export is any sync or async iterable of ids: here an async
generator stands in for the query's cursor.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

// Your function: yields the user ids a warehouse query returns, in any order, duplicates allowed.
async function* warehouse(ids: number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

const exportsByName = {
  buyers90d: [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
  newsletter: [1002, 1003, 1004, 1007, 1009, 1010, 1011],
  euResidents: [1001, 1003, 1005, 1007, 1009, 1011],
};
for (const [segment, ids] of Object.entries(exportsByName)) {
  const result = await store.load({ segment }, warehouse(ids), { guard: { minRetained: 0.5 } });
  console.log(segment, result.published, result.cardinality);
}
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, [1004, 1010]);
```

Output:

<!-- output -->
```text
buyers90d true 8
newsletter true 7
euResidents true 6
```

`published` is the result of a load, not an exception: a refusal is a normal answer with a `reason`. The guard says what
counts as too small to publish, which the next block meets.

## Refresh them by a load

A refresh is the same call with the new export. It replaces the segment as one new generation; readers keep reading the
old one until they see the new pointer, and there is never a half-loaded audience.

<!-- typecheck -->
```ts
// Tomorrow's export: one buyer left the window and one joined.
const fresh = await store.load({ segment: 'buyers90d' }, warehouse([1002, 1003, 1004, 1005, 1006, 1007, 1008, 1012]));
console.log(fresh.published, fresh.cardinalityBefore, '->', fresh.cardinality);

// A broken export, a truncated query that returned two rows, is refused instead of replacing the audience.
const broken = await store.load({ segment: 'buyers90d' }, warehouse([1002, 1003]), { guard: { minRetained: 0.5 } });
console.log(broken.published, broken.reason, broken.cardinalityBefore, '->', broken.cardinality);
console.log(await store.segment('buyers90d').count());
```

Output:

<!-- output -->
```text
true 8 -> 8
false min-retained 8 -> 2
8
```

Always branch on `published`. An empty result over a non-empty segment is refused without a guard unless the call says
`allowEmpty: true`.

## Compose a campaign audience

Name the sets and let the store combine them. A combine streams ids in ascending order and reads only the chunks that can
contribute, so the cost follows the chunks, not the audience size.

<!-- typecheck -->
```ts
const buyers = store.segment('buyers90d');
const newsletter = store.segment('newsletter');
const eu = store.segment('euResidents');
const optOut = store.segment('global-opt-out', { namespace: 'suppression' });

async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const ids: number[] = [];
  for await (const id of stream) ids.push(id);
  return ids;
}

// Buyers on the newsletter, not opted out: the suppression is folded into the same pass.
console.log('buyers and newsletter, not opted out', await collect(buyers.intersect([newsletter], { exclude: [optOut] })));
// Newsletter readers who have not bought: a win-back audience.
console.log('newsletter, not buyers', await collect(newsletter.andNot([buyers, optOut])));
// Everyone in either list.
console.log('buyers or newsletter', await buyers.unionCount([newsletter]));
// Buyers in the EU, and on the newsletter.
console.log('eu buyers on the newsletter', await collect(buyers.intersect([newsletter, eu], { exclude: [optOut] })));
```

Output:

<!-- output -->
```text
buyers and newsletter, not opted out [ 1002, 1003, 1007 ]
newsletter, not buyers [ 1009, 1011 ]
buyers or newsletter 11
eu buyers on the newsletter [ 1003, 1007 ]
```

Pass `exclude` instead of chaining a second combine: it folds the subtraction into one pass and reads the suppression list
only where the result survives. Every segment a combine names has to exist, which the last block of this page shows.

## Count an audience before you send it

`intersectCount`, `unionCount` and `andNotCount` count one combine, as the block above counts the union. To know how many
people each of several audiences holds before sending, and whether each would publish, run the same expressions through
`materializeMany` as a dry run: it computes every output and writes nothing.

<!-- typecheck -->
```ts
const operands = { buyers, newsletter, eu, optOut };
const outputs = [
  { dest: store.segment('campaign-a'), expr: { and: ['buyers', 'newsletter'] }, exclude: ['optOut'] },
  { dest: store.segment('campaign-b'), expr: { andNot: ['newsletter', 'buyers'] }, exclude: ['optOut'] },
  { dest: store.segment('campaign-c'), expr: { and: ['buyers', 'newsletter', 'eu'] }, exclude: ['optOut'] },
];
const preview = await store.materializeMany({ operands, outputs, keep: 2, dryRun: true });
for (const [i, outcome] of preview.outputs.entries()) {
  if ('error' in outcome) throw outcome.error;
  console.log(`campaign ${i}`, outcome.cardinality, 'would publish:', outcome.wouldRefuse === undefined);
}
```

Output:

<!-- output -->
```text
campaign 0 3 would publish: true
campaign 1 2 would publish: true
campaign 2 2 would publish: true
```

Review the numbers, then call again without `dryRun` to publish every output from one pass over the operands: each is a
segment of its own (`dest`), so it can be read, counted and paged like any other.

<!-- typecheck -->
```ts
const run = await store.materializeMany({ operands, outputs, keep: 2 });
for (const outcome of run.outputs) {
  if ('error' in outcome) throw outcome.error;
  console.log(outcome.published, outcome.cardinality);
}
console.log(await store.segment('campaign-a').count());
```

Output:

<!-- output -->
```text
true 3
true 2
true 2
3
```

## Send, page by page

A send can take longer than a refresh, so read one generation for the whole send with `pin()`: a refresh that lands
mid-send changes the live segment and leaves the pin alone. A lease keeps that generation in storage while the send runs.
A page is a range, `(after, through]`, so workers can take pages in any order, and a pinned handle's `everyNth` finds the
page ends without reading every id.

<!-- typecheck -->
```ts
const campaign = await store.segment('campaign-a').pin({ leaseUntil: Date.now() + 3_600_000 });

// A refresh lands during the send.
await store.load({ segment: 'campaign-a' }, [1002, 1003, 1007, 1099]);
console.log('live now', await store.segment('campaign-a').count(), 'pinned', await campaign.count());

// Page ends: every 2nd id of the pinned audience, then the end of the id space.
const ends: number[] = [];
for await (const id of campaign.everyNth(2)) ends.push(id);
ends.push(4_294_967_295);

let after: number | undefined;
for (const through of ends) {
  const page = await collect(campaign.iterate({ after, through }));
  console.log('send', page);
  after = through;
}
await campaign.release();
```

Output:

<!-- output -->
```text
live now 4 pinned 3
send [ 1002, 1003 ]
send [ 1007 ]
```

A pin is a hold, not a copy. Without a lease, a later load whose collection passes the pinned generation deletes it, and
the pinned reads then fail with `NotFoundError` rather than serve another generation, so a long send either takes a lease
(`leaseUntil`, at most 14 days out) or sizes `keep` past the loads that can land meanwhile. See [reading one fixed point in
time](../guide/reading.md#read-one-fixed-point-in-time). The first page leaves `after` out, which is the only way to
include id 0.

## Many audiences in one pass

A refresh that rebuilds hundreds of audiences from the same operands should not read the operands hundreds of times.
`materializeMany` takes the operand names once and reads each operand once per group of outputs: one group while the outputs
fit the call's memory budget (`maxBufferedBytes`, 256 MiB by default), more when they do not, as the blocks above did for three
outputs in one. By default it pins each stored operand and, just before publishing, re-reads every pinned operand an output
subtracts (an `exclude`, or an entry after the first of an `andNot`): an output whose subtracted list moved during the call is
not published and carries a `StaleOperandError`, so a suppression list that changes during a long call never ships a send that
ignores the change ([what it re-checks](../guide/loading.md#many-outputs-from-one-pass-materializemany)).

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // A mistyped suppression list: it would suppress nobody, so the combine refuses it.
  await collect(buyers.intersect([newsletter], { exclude: [store.segment('global-optout', { namespace: 'suppression' })] }));
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
| `published: false` with `reason: 'min-retained'`, `'min-cardinality'`, `'max-growth'` or `'empty'` | The guard held the line. Look at the export before you loosen it: a smaller audience than yesterday's is usually a broken query. |
| `published: false` with `reason: 'superseded'` | Another load got there first. Run yours again; it takes a fresh generation. |
| `ValidationError` from a combine | An operand names no segment (a typo, a missing `namespace`, a segment that was dropped), or an option is wrong. Fix the call: it is raised before any read. `allowAbsentOperands: true` reads a segment that may legitimately not exist yet as empty. |
| `WriteConflictError` | Two writers raced on one segment and this one lost every retry. Run the operation again. |
| `TransientError`, `BudgetExceededError`, `StaleOperandError`, `NotFoundError` | Throttling or a fault after the store's own retries, a call that would exceed its request budget, an operand that moved under a `materializeMany`, a generation collected under a pin. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which to retry. |

## Limits

- **No per-id write.** A segment changes only by loading a new generation, so a person who signs up this minute is in the
  audience after the next load, and freshness is your refresh cadence. A read sees a new generation within `cache.genTtlMs`
  of the load (2 seconds by default, [how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).
  Events that arrive one at a time belong in the system that receives them; load the set on a cadence.
- **Counting a combine is its own call.** `count()` answers for one stored segment from its registry row, and a combine
  returns ids; `intersectCount`, `unionCount` and `andNotCount` return the size of one
  without streaming it, and trust the index for keys they do not decode. The other ways are the dry run above, an `*Into`
  followed by `count()`, or streaming the ids into a `RoaringBitmap` (`batches()` yields `Uint32Array`s) and reading its
  `size` ([the counting page](counting.md) compares them).
- **One id space.** Ids are unsigned 32-bit integers, the same space in every namespace. Mapping an email or a device id to
  a stable integer is the warehouse's job; the library never sees the identifier.
- **Not a join.** A segment holds ids only: no attributes, no order, no time. "Bought in the last 90 days" is a query in the
  warehouse that loads a segment; the set algebra starts after it.
- **An intersect of more than two operands is unmeasured on S3.** The page intersects three; its correctness is tested, its
  request counts and latency at that width are not published.
- **Scale and tenancy.** The validated envelope is single-tenant and single-region on S3, up to about 100,000 segments, and
  it lists `materializeMany` and the other combine shapes as outside it: [what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt). This page ran on
  `MemoryStorage`, so it says nothing about latency or cost; for those, see [the cost guide](../guide/cost.md) and
  [the benchmarks](../benchmarks.md).
