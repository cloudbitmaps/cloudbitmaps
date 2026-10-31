# Faceted filters: a segment per field and value

Keep a segment for each value of each field, filter with an AND across fields and an OR within one, count each facet and name the segments so that many stay manageable.

A faceted catalogue lets a shopper tick values (colour red or blue, size medium, in stock) and shows how many items each
value would leave. As sets of item ids it is plain algebra: one set per (field, value), an intersection across fields, a
union within one. This page builds that on `MemoryStorage` with an invented twelve-item catalogue, from naming the segments
to counting each facet, and ends with what it does not do: numeric ranges and ranking. Every `Output` is what the repo's tests
print when they run the blocks as written.

Use it when the filters are equalities over a few fields, the item ids are dense unsigned 32-bit integers, and the
catalogue is loaded in batches. It is not a search engine ([Limits](#limits)).

## Name the segments: a namespace per field

A segment is named by a name and an optional namespace. Put each field in its own namespace and each value's slug in the name:
`store.segments({ namespace })` then lists a field's values, which is the one catalogue the library keeps. A name is any
non-empty string whose encoded form is up to 256 characters: most characters other than letters, digits, `.`, `_`, `:` and
`-` are percent-encoded when the name becomes a storage key, and the limit counts the encoded name. So slug the value
(lowercase, hyphens), and refuse two values that make one slug.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';
import type { Expr, Segment } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

interface Item {
  id: number;
  color: string;
  size: string;
  stock: string;
}
const catalogue: Item[] = [
  { id: 1, color: 'red', size: 'small', stock: 'in stock' },
  { id: 2, color: 'red', size: 'small', stock: 'in stock' },
  { id: 3, color: 'red', size: 'medium', stock: 'in stock' },
  { id: 4, color: 'red', size: 'medium', stock: 'in stock' },
  { id: 5, color: 'red', size: 'large', stock: 'in stock' },
  { id: 6, color: 'red', size: 'large', stock: 'sold out' },
  { id: 7, color: 'blue', size: 'small', stock: 'in stock' },
  { id: 8, color: 'blue', size: 'medium', stock: 'in stock' },
  { id: 9, color: 'blue', size: 'large', stock: 'in stock' },
  { id: 10, color: 'blue', size: 'large', stock: 'sold out' },
  { id: 11, color: 'green', size: 'small', stock: 'in stock' },
  { id: 12, color: 'green', size: 'medium', stock: 'sold out' },
];
const FIELDS = ['color', 'size', 'stock'] as const;

/** A value's slug: lowercase letters, digits and hyphens, so it survives as a storage key. */
const slugOf = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** One segment per (field, value): the field is the namespace, the value's slug is the name. */
const seg = (field: string, value: string): Segment => store.segment(slugOf(value), { namespace: `facet-${field}` });
/** The name an expression uses for that segment. */
const operandName = (field: string, value: string): string => `${field}:${slugOf(value)}`;

const groups = new Map<string, { field: string; value: string; ids: number[] }>();
for (const item of catalogue) {
  for (const field of FIELDS) {
    const value = item[field];
    const key = operandName(field, value);
    let group = groups.get(key);
    if (group === undefined) {
      group = { field, value, ids: [] };
      groups.set(key, group);
    }
    if (group.value !== value) throw new Error(`two ${field} values make the name ${slugOf(value)}`);
    group.ids.push(item.id);
  }
}
for (const g of groups.values()) await store.load({ namespace: `facet-${g.field}`, segment: slugOf(g.value) }, g.ids);

console.log('segments', groups.size);
for (const field of FIELDS) {
  const names: string[] = [];
  for await (const row of store.segments({ namespace: `facet-${field}` })) names.push(row.segment);
  console.log(field, names.sort().join(' '));
}
```

Output:

<!-- output -->
```text
segments 8
color blue green red
size large medium small
stock in-stock sold-out
```

`store.segments()` is an admin call, a registry listing and not a request-path one: read a field's values once, when the
service starts, or keep the list in the job that builds the segments ([does this segment exist](../guide/loading.md#does-this-segment-exist)).

## AND across fields: an intersection

With one value ticked in each field, the filter is an `intersect`, which reads only the chunks every segment holds.

<!-- typecheck -->
```ts
async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const ids: number[] = [];
  for await (const id of stream) ids.push(id);
  return ids;
}

const red = seg('color', 'red');
console.log('red, medium, in stock', await collect(red.intersect([seg('size', 'medium'), seg('stock', 'in stock')])));
```

Output:

<!-- output -->
```text
red, medium, in stock [ 3, 4 ]
```

## OR within a field: an expression

"Red or blue" is a union, and the operands of an `intersect` are segments, not expressions. `materializeMany` takes an
expression over named segments: `and` across the fields and `or` within one, in one pass, written to a result segment that
can be read and paged like any other. A selection maps a field to the values ticked, and the expression follows from it.

<!-- typecheck -->
```ts
type Selection = Record<string, string[]>;

function exprOf(selection: Selection): Expr {
  const terms: Expr[] = [];
  for (const [field, values] of Object.entries(selection)) {
    const names = values.map((value) => operandName(field, value));
    const [first] = names;
    if (first !== undefined && names.length === 1) terms.push(first);
    else terms.push({ or: names });
  }
  return { and: terms };
}

const operands: Record<string, Segment> = {};
for (const [key, g] of groups) operands[key] = seg(g.field, g.value);

const query: Selection = { color: ['red', 'blue'], size: ['medium'], stock: ['in stock'] };
const saved = store.segment('search-1', { namespace: 'results' });
const run = await store.materializeMany({ operands, outputs: [{ dest: saved, expr: exprOf(query) }], keep: 1 });
for (const outcome of run.outputs) {
  if ('error' in outcome) throw outcome.error;
  console.log('matches', outcome.cardinality);
}
console.log('items', await collect(saved.iterate()));
```

Output:

<!-- output -->
```text
matches 3
items [ 3, 4, 8 ]
```

The call pins every operand by default, so a load that lands during the call does not change what it reads
([many outputs from one pass](../guide/loading.md#many-outputs-from-one-pass-materializemany)). It writes a generation to
the result segment on every call, so this shape is for a saved search or a cached query, not for each page view: name the
result by a hash of the query so repeats replace one segment rather than add one (two callers that write one fixed name such as `search-1` race, and the
loser gets `WriteConflictError`), and give it a retention so the sweep retires it ([retention](../guide/retention.md)),
because results otherwise fill the namespace toward the 100,000-segment envelope. A segment holds ids, and a result can be
paged with a range ([paging](../guide/reading.md#page-through-a-segment)). For a per-request filter with an OR inside a
field, run a dry run for the counts and stream the ids from the union of the ticked values instead of writing them.

With nothing ticked, `exprOf({})` is `{ and: [] }`, and a field with no values is `{ or: [] }`: a combine refuses an empty
list with `ValidationError`. Read the whole catalogue (a segment of every item) when nothing is selected, and never pass an
empty field.

## Count each facet

The number beside each value is what the filter would leave if the shopper ticked that value in its field and kept the rest.
That is one expression per value: the query with that field's selection replaced by the value. A combine returns ids and no
count, so the counts come from a dry run, which computes every output in one pass and writes nothing. It reads every chunk
of each `or` (a union reads everything), so on S3 the counts are not request-path cheap, and a facet screen with a budget of
tens of milliseconds needs a warm reader and a cached count. The ways to count a
combine, and what each costs, are [on the counting page](counting.md).

<!-- typecheck -->
```ts
const facets = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const outputs = facets.map(([, g], n) => ({
  dest: store.segment(`count-${n}`, { namespace: 'scratch' }),
  expr: exprOf({ ...query, [g.field]: [g.value] }),
  allowEmpty: true,
}));
const dry = await store.materializeMany({ operands, outputs, keep: 1, dryRun: true });
for (const [n, outcome] of dry.outputs.entries()) {
  if ('error' in outcome) throw outcome.error;
  console.log(facets[n]?.[0], outcome.cardinality);
}
```

Output:

<!-- output -->
```text
color:blue 1
color:green 0
color:red 2
size:large 2
size:medium 3
size:small 3
stock:in-stock 3
stock:sold-out 0
```

Every `dest` is a name for a segment that is never written, one per output, and each is read once to judge it. The segments do
not change between loads, so a count for a query is stable until a load: keep it, keyed by the query and the generation each
facet segment reads (`stat().generation`), and the dry run runs once per change and not once per page view.

## Refresh the catalogue

A facet segment changes by a load, so a catalogue change is a load of each value it touches: the whole id list of that value,
from the job that builds them. A value that has no item left is loaded empty with `allowEmpty: true`, or retired, and a
load that would shrink a value by more than you expect is held by a guard ([when a load is refused](../guide/loading.md#when-a-load-is-refused)).
Facets are loaded one at a time, so a filter can see one value reloaded and another not. Pinning stops a load that lands
during the `materializeMany` call from changing what it reads, but it is one generation per operand, not one instant: a
refresh that is half done when the call starts is still seen half done. Load every touched value and switch readers
after, or read results only when the job is idle.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // A value no segment holds: the expression names an operand the call does not have.
  await store.materializeMany({
    operands,
    outputs: [{ dest: store.segment('x', { namespace: 'scratch' }), expr: exprOf({ color: ['purple'] }) }],
    keep: 1,
    dryRun: true,
  });
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
| `ValidationError` from `materializeMany` or a combine | An expression names a value with no operand, a segment was never loaded (a typo, a missing `namespace`), or an option is wrong. Fix the call: it is raised before the combine reads a chunk. |
| `published: false` on a load, with `reason: 'min-retained'`, `'max-growth'` or `'empty'` | The guard held the line. Look at the export before you loosen it. |
| `WriteConflictError` | Two calls wrote one result segment at once and this one lost. Name results by a hash of the query, or run the call again. |
| `NotFoundError` | A generation collected under a pin without a lease. Take a lease for a long job. |
| `TransientError`, `BudgetExceededError` | A fault after the store's retries, or a call past its request budget; a filter over very many values may need `budget` raised with room to spare. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which to retry. |

## Limits

- **Numeric ranges have no API.** A price between 20 and 50 needs an ordered or bit-sliced structure that a segment does not
  have. The nearest thing is to bucket the value into bands you choose when you load, one segment per band, which answers
  those bands and no others.
- **Not a search engine.** No ranking, scoring or text, and no sort by anything: the result is a set of ids in ascending order.
- **One segment per value.** A field with many values costs a segment each, and the validated envelope is about 100,000
  segments in all ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)). A
  field of tens of thousands of values is a different design.
- **A facet count is a combine's size.** `intersectCount` answers it without streaming the ids,
  and a dry run answers many in one pass ([the counting page](counting.md) says what each costs).
- **Freshness is your load cadence.** A catalogue change is seen after the next load, and a reader in another process within
  `cache.genTtlMs` after that ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).
- **Single-valued fields.** An item with two colours is in two colour segments, so the counts of a field no longer sum to
  the total, and an item with no value for a field is in none of its segments.
- **Wide expressions are unmeasured on S3.** More than two operands, other overlaps and `materializeMany` (whose request
  counts are counted in memory, not measured) are not published, so the requests and latency of the counts and the `or`
  expressions across many facets are unknown ([what is still owed](../benchmarks.md#what-is-still-owed)).
- **Not measured here.** This page ran on `MemoryStorage`, so it says nothing about latency or cost; see
  [the cost guide](../guide/cost.md) and [the benchmarks](../benchmarks.md).
