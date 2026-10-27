# Is this the right tool?

Six places where bitmaps are used and CloudBitmaps is not the answer, what to use instead, and the one case in each where it still helps.

CloudBitmaps stores large sets of unsigned 32-bit integer ids as write-once generations in object storage and combines them
on demand. Roaring bitmaps are used in many other places, and several of them look like the same problem and are not.
This page names those places so you can stop early. It has no walkthrough to run: each section says what the job is, what to
reach for, and what, if anything, the library adds. For the jobs it does fit, start from [the playbooks index](README.md).

The rule behind every section: the library holds a set that is computed in batches, is read often, and has to outlive the
process and the query that made it. A set that is built per event, owned by an engine, or private to one user is another
shape.

## An index inside an OLAP or search engine

Analytical and search engines keep a bitmap per value of a column (which rows hold this tag) as part of their own index,
build it when data is ingested and use it for their own filters and counts: Apache Druid
([segments](https://druid.apache.org/docs/latest/design/segments)) and Apache Pinot
([inverted index](https://docs.pinot.apache.org/indexing/inverted-index)) are two that document it. The ids are row positions
inside the engine's own segments, and the index is read by the engine's query planner.

**Use instead:** the engine's own index and its own aggregate functions. Do not rebuild an engine's index in object storage,
and do not export one to filter with.

**Where the library still helps:** the engine answers a question and the answer is a set that another service needs, such as
the people a query selected. Load that result as a segment, and any service can check membership or combine it with other
audiences without running the query again.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

// The result of a warehouse query (invented ids), kept as a set another service can read.
await store.load({ segment: 'selected-by-query' }, [3, 17, 42, 1_000_000]);
console.log(await store.segment('selected-by-query').has(42), await store.segment('selected-by-query').count());
```

Output:

<!-- output -->
```text
true 4
```

## Deletion vectors in a table format

Table formats mark deleted rows with a bitmap per data file, stored with the table's own metadata and committed with the table:
the Iceberg format's deletion vectors, described in its [Puffin specification](https://iceberg.apache.org/puffin-spec/) and
[in the Iceberg v3 summary](https://opensource.googleblog.com/2025/08/whats-new-in-iceberg-v3.html), are an example. The
positions are row positions within one file, in a format that carries 64-bit positions.

**Use instead:** the table format's own mechanism, through the engine that writes the table. A deletion vector is part of the
table's snapshot, and a bitmap kept anywhere else would not be part of it.

**Where the library still helps:** nowhere for the vectors themselves: it holds 32-bit ids, not file positions, and it is not a
place the table reads from.

## Tag indexes in a time-series database

A metrics database keeps, for each tag value, the set of series that carry it, in memory, built at ingest, over a very large
number of series and read in milliseconds for every query. It is the database's own index.

**Use instead:** the database's index. It is built for that write rate and that read path, and a store that changes only by
loading a new generation cannot follow it.

**Where the library still helps:** none for the index. The in-process `RoaringBitmap` is the same data structure and is
available for your own in-memory sets ([the standalone page](roaring-bitmap.md)).

## Geospatial cells

A set of map cells (the cells a region covers, the cells a fleet visited) is a set of cell ids. Hierarchical grids ([H3](https://carto.com/glossary/h3-spatial-index/)
is one) give every cell an identifier of its own, which is not a small dense integer you chose, and a segment holds integers
from 0 to 4,294,967,295 only: an id above that is refused.

**Use instead:** a geospatial index or the database's geospatial types for "what is near this point" and "what is inside this
shape". A bitmap answers set questions, not geometry.

**Where the library still helps:** when the cells in play are few enough to give each one a dense local number (the cells of one
city, mapped to 0, 1, 2 and so on), a set of cells is a set of small integers, and combining sets of cells is the library's job.
The mapping is yours ([getting your ids into dense integers](id-mapping.md)), and it is the part that makes this a project and
not a recipe.

## Per-event counters and writes on the hot path

A counter per event (a page view, an impression, a login, one bit per user per day set as events arrive) is a write per event.
A segment has no `add`, no `remove` and no `SETBIT`: it changes by loading a new generation, which replaces the whole segment
([the README's "when not"](../../README.md#use-it-when-and-when-not)).

**Use instead:** a store built for writes at that rate, where the events arrive. Redis bitmaps and counters are the usual choice,
and Redis's own [analytics tutorial](https://redis.io/tutorials/building-an-analytics-dashboard-app-using-redis/) shows the shape.

**Where the library still helps:** after the writes. Collect the events where they arrive, and load each day's set as a segment
once the day is over, so that the combines, the counts and the sends read an object in a bucket and no always-on memory. The
playbooks on [dedup](dedup-seen-sets.md) and [audience segments](audience-segments.md) are that shape.

## Millions of sets, one per user

A set for every user (the items they have seen, the accounts they follow) is millions of segments, each tiny and each written
whenever its owner acts. The validated envelope is about 100,000 segments, read-mostly
([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)), and every segment carries
its own registry row and its own object.

**Use instead:** a key-value store, with one record per user. [The next page](per-user-sets.md) works the shape through.

**Where the library still helps:** the in-memory `RoaringBitmap` can hold many sets inside one process, and a set that is shared
rather than per user (the items in a category, the accounts of a verified list) is an ordinary segment.

## What none of these is

None of these is a verdict on bitmaps: the structure is not at fault in any section above, and it is built into the engines that
use it. The question is where the set lives, who writes it, and how often. If your answer is "computed in a batch, read by
many, kept in a bucket", the [playbooks index](README.md) lists what is written for it.

## Limits

- **The links above are for orientation, not endorsement.** Each names one place the structure is documented, and none says what
  an engine will accept or how it performs. This page makes no claim about any engine's compatibility with the bytes a segment
  holds.
- **No figure here is measured.** The page has no run: it says where the job lives, and the numbers for the jobs the library does
  fit are in [the benchmarks](../benchmarks.md) and [the cost guide](../guide/cost.md).
