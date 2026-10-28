# Moving a Redis bitmap or set workload to stored segments

Decide which Redis sets move, export a Redis bitmap or a Redis set into segments, check the answers side by side before you switch, and keep Redis for the writes.

A Redis bitmap (`SETBIT`, `GETBIT`, `BITOP`) or a set of integers (`SADD`, `SISMEMBER`, `SINTER`) often holds a list that a
job rebuilds and many services read: an audience, a suppression list, an allow list. That half moves to segments in object
storage, which cost only their storage while idle and survive a restart. The half that takes a write per event does not: a segment has
no per-id write. This page draws the line, runs the export and the load on invented data with a stand-in for Redis, and
ends in a check you run against your own Redis before the switch. Every `Output` is what the repo's tests print when they
run the blocks as written.

Use it when the sets in a Redis are built in batches or can be, and the reads are the load on it. If the sets change one id
at a time on the request path, read [what stays in Redis](#what-moves-and-what-stays) first.

## What moves and what stays

| In Redis today | Here |
|---|---|
| A set rebuilt on a schedule from a query or a pipeline, and read by many services | **Moves.** A segment, loaded on the same cadence |
| `GETBIT`, `BITCOUNT`, `SISMEMBER`, `SCARD` on that set | **Moves.** `has(id)` and `count()` |
| `BITOP AND`, `OR`, `DIFF`, `ANDOR`, `SINTER`, `SUNION`, `SDIFF` between those sets | **Moves.** `intersect`, `union`, `andNot` and `materializeMany` ([the command table](../guide/getting-started.md#coming-from-redis-bitmaps)) |
| `SETBIT` or `SADD` for each event, counters, rate limits, a key that expires | **Stays in Redis.** A segment changes only by a load of a new generation, and its expiry is per segment, never per id |
| `BITFIELD`, `BITPOS`, byte ranges of `BITCOUNT`, `BITOP NOT`, anything that reads the raw string | **No equivalent.** A segment is a set of ids, not an addressable bit buffer |

<!-- not-run: a diagram of where the data flows, not code -->
```text
 events --SETBIT/SADD--> Redis (writes, counters) --GET/SSCAN--> export job --store.load--> segments in object storage
                                                                                                  |
 services --------------------- has / count / intersect / union / andNot --------------------------+
```

The pattern is the one [the guide](../guide/getting-started.md#coming-from-redis-bitmaps) states: accumulate events in the
system that receives them, which Redis does well, and load the set on a cadence. The export job is yours.

## The ids

A Redis bitmap offset is already the id: `GETBIT key id` reads bit `id`, and both are unsigned 32-bit integers here. A Redis
set of integers is the same ids as members. A set of strings (emails, UUIDs) is not: it needs dense integer ids first, which
is [its own playbook](id-mapping.md). The block below stands in for Redis with a function that leaves a byte string exactly
as `SETBIT` does, high bit first, and one that reads one back.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

/** Stands in for `GET key`: what `SETBIT key offset 1` leaves in a Redis string. Offset 0 is the high bit of byte 0. */
function redisString(offsets: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.floor(Math.max(...offsets) / 8) + 1);
  for (const offset of offsets) bytes[offset >> 3] = (bytes[offset >> 3] ?? 0) | (0x80 >> (offset & 7));
  return bytes;
}

/** The offsets of the set bits of a Redis string, ascending. Zero bytes are skipped, so a sparse bitmap is quick to scan. */
function* setBits(bytes: Uint8Array): Generator<number> {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (0x80 >> bit)) !== 0) yield i * 8 + bit;
    }
  }
}

console.log(Array.from(redisString([0, 9])).join(' '));
console.log([...setBits(redisString([3, 5, 8, 13]))]);
```

Output:

<!-- output -->
```text
128 64
[ 3, 5, 8, 13 ]
```

Redis numbers a byte's bits from the most significant, which is why offset 0 is 128, and Roaring numbers them from the least
significant. The two layouts are the same set and not the same bytes, so a segment is never loaded from a Redis string
as it is: the bits are read out as ids and the ids are loaded ([what does not carry over](../guide/getting-started.md#coming-from-redis-bitmaps)).
The library has no importer for the raw layout; `setBits` is a function you own.

## Export, then load

Read each key from Redis and load its ids. The real calls are the two below, which need a running Redis, so they are shown and
not run.

<!-- not-run: needs a running Redis server and its client library, which the tests do not start -->
```js
// With ioredis: a bitmap is one GET, and a set is read a page at a time with SSCAN.
// A GET is atomic. SSCAN is not a snapshot: a member added or removed during the scan may or may not come back.
const bytes = await redis.getBuffer('audience:buyers');
let cursor = '0';
const members = [];
do {
  const [next, page] = await redis.sscan('audience:newsletter', cursor, 'COUNT', 1000);
  members.push(...page);
  cursor = next;
} while (cursor !== '0');
```

A bitmap's bits come out ascending, so the load can stream them with `sorted: true`, which holds one chunk at a time. A set's
members come in any order with repeats, which a load accepts. Both are loaded here from the same invented sets, each with
`guard: { minRetained: 0.5 }` (use your own bound), so an export that comes back short is refused rather than published.
Without a guard the only protection is that an empty result is refused over a segment that has ids; a cut-off `GET` that
returns a fraction of the ids would replace yesterday's set.

Two cautions about the export itself. Its memory is the Redis string's size (up to 512 MB for one `GET`), or read it in
`GETRANGE` slices. And `SSCAN` can return a set that never existed at one instant when something writes to it during the
scan: scan a copy (`COPY` or `SUNIONSTORE` to a temporary key, then `SSCAN` it and `DEL` it; the copy is itself one command that blocks the server for the set's size, like `BITOP`), or accept it when the set is
rebuilt whole on each cadence and nothing writes while the job runs.

<!-- typecheck -->
```ts
/** A Redis set's members (what `SSCAN` returns, as strings) as ids: an unsigned 32-bit integer each, or an error. */
function idsOfSet(members: string[]): number[] {
  return members.map((member, i) => {
    const id = Number(member);
    if (!/^\d+$/.test(member) || id > 4_294_967_295) {
      throw new RangeError(`member ${i} is not an unsigned 32-bit integer: map identifiers to ids first`);
    }
    return id;
  });
}

const guard = { minRetained: 0.5 };
const buyersBytes = redisString([3, 5, 8, 13, 21, 34, 55]);
const newsletterBytes = redisString([5, 8, 13, 89, 144]);

const buyers = await store.load({ segment: 'buyers' }, setBits(buyersBytes), { sorted: true, guard });
console.log('buyers', buyers.published, buyers.cardinality);
const newsletter = await store.load({ segment: 'newsletter' }, idsOfSet(['8', '5', '13', '89', '144', '5']), { guard });
console.log('newsletter', newsletter.published, newsletter.cardinality);
```

Output:

<!-- output -->
```text
buyers true 7
newsletter true 5
```

`published` is the answer of a load, never an exception: branch on it ([why a load is refused](../guide/loading.md#when-a-load-is-refused)).
A load writes the whole set as a new generation, so each refresh is a full export; the freshness block below shows the guard
refusing an export that came back short.

## Check side by side before you switch

Before a reader moves, run the same question against both and compare the members, not only the sizes. `BITOP AND dest a b`
followed by `GET dest` gives the Redis answer; the stand-in below does the same on the byte strings, and `BITCOUNT` is a count of set
bits. For each combine and each count a service relies on, ask both and require equal answers.

Run the real `BITOP` on a staging copy, never on the primary (a replica refuses it: `BITOP` writes `dest`, and a replica is
read-only): it reads whole strings and blocks the server
while it runs, it creates the `dest` key (delete it afterwards, and on a cluster all three keys must share a hash slot), and
`GET dest` pulls the whole result. For large bitmaps, compare `BITCOUNT` on both sides plus a sampled set of `GETBIT` and
`has` answers instead of a full `BITOP`.

<!-- typecheck -->
```ts
/** Stands in for `BITOP AND dest a b` then `GET dest`: a shorter string is padded with zeros. */
function bitopAnd(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) out[i] = (a[i] ?? 0) & (b[i] ?? 0);
  return out;
}

/** Stands in for `BITCOUNT key`. */
function bitcount(bytes: Uint8Array): number {
  return [...setBits(bytes)].length;
}

async function idsOf(stream: AsyncIterable<Uint32Array>): Promise<number[]> {
  const ids: number[] = [];
  for await (const batch of stream) ids.push(...batch);
  return ids;
}
const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

const buyersSegment = store.segment('buyers');
const newsletterSegment = store.segment('newsletter');
const viaRedis = [...setBits(bitopAnd(buyersBytes, newsletterBytes))];
const viaStore = await idsOf(buyersSegment.intersect([newsletterSegment]).batches());
console.log('BITOP AND', viaRedis, 'intersect', viaStore, same(viaRedis, viaStore));
console.log('BITCOUNT', bitcount(buyersBytes), 'count()', await buyersSegment.count());
```

Output:

<!-- output -->
```text
BITOP AND [ 5, 8, 13 ] intersect [ 5, 8, 13 ] true
BITCOUNT 7 count() 7
```

Both answers match, and a match on the members is the check that matters: equal sizes can hide different ids.

A difference you will see while both run is freshness, not a bug: Redis answers for now, and a segment answers for its last
load. The next block sets one more bit in Redis after the export, then loads, and then refuses an export that was cut short.

<!-- typecheck -->
```ts
const later = redisString([3, 5, 8, 13, 21, 34, 55, 89]); // a SETBIT landed in Redis after the export
console.log('before the next load', bitcount(later), await buyersSegment.count());
await store.load({ segment: 'buyers' }, setBits(later), { sorted: true, guard });
console.log('after the next load', bitcount(later), await buyersSegment.count());

// An export that stopped early would replace the audience with a fragment of it; the guard refuses.
const cut = await store.load({ segment: 'buyers' }, setBits(later.slice(0, 1)), { guard });
console.log(cut.published, cut.reason, cut.cardinalityBefore, '->', cut.cardinality);
```

Output:

<!-- output -->
```text
before the next load 8 7
after the next load 8 8
false min-retained 8 -> 2
```

## How reads change

- **Freshness is stated, and it is not zero.** The process that loads sees the new generation at once. Another process sees
  it within `cache.genTtlMs` (2,000 ms by default), and `invalidate` shortens that where you have your own signal
  ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).
- **A read is a cache hit or a ranged GET.** `has` answers from memory once the chunk and the segment's resolution are
  fresh and costs one ranged read of the id's chunk when they are not. [A membership check in a long-running
  service](membership-service.md) builds the shape and bounds its memory.
- **A combine reads what can contribute.** `intersect` fetches only the chunks every operand holds, so a combine over big
  sets reads only the chunks every operand holds, in range requests whose number follows how far apart those chunks lie, not
  how many there are, where `BITOP` reads and writes whole strings
  ([what each combine reads](../guide/reading.md#combine-segments-intersect-union-andnot)).

## What it costs against the Redis it replaces

In the project's cost model, against one three-node Redis-HA cluster at $346 a month, pay-per-use reads cost less below about
329 sustained object reads a second with the cache off, and more above it; the figure is modelled, not measured, and moves with
the cache-hit rate, the data size and the cluster ([the crossover](../benchmarks.md) and [the estimator](../guide/cost.md)).
[What it saves, and where it doesn't](../guide/why-cloudbitmaps.md#where-it-loses) says where Redis wins: small data queried
hard, and an answer from memory that a cold read of object storage does not match. This page makes no claim about speed.

## What goes wrong

<!-- typecheck -->
```ts
try {
  idsOfSet(['17', 'u-1001']);
} catch (error) {
  if (error instanceof RangeError) console.log(error.message);
}
```

Output:

<!-- output -->
```text
member 1 is not an unsigned 32-bit integer: map identifiers to ids first
```

| You see | What to do |
|---|---|
| `published: false` with `reason: 'min-retained'`, `'min-cardinality'`, `'max-growth'` or `'empty'` | The guard held the line. Look at the export before you loosen it: a smaller set than yesterday's is usually a broken export. |
| `published: false` with `reason: 'superseded'` | Another load got there first. Run yours again. |
| `ValidationError` from a load | An id is not an integer from 0 to 4,294,967,295, or an option is wrong. Map identifiers to ids ([the id-mapping playbook](id-mapping.md)); it is raised before anything is written. |
| `WriteConflictError` | Two writers raced on one segment and this one lost every retry. Run the load again. |
| `ValidationError` from a combine | An operand names no segment (a typo, a missing `namespace`). Fix the call: it is raised before the combine reads a chunk. |
| `TransientError`, `BudgetExceededError` | A fault after the store's retries, or a call past its request budget. Retry; [the errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which. |

## Limits

- **No per-id write.** A person who signs up this minute is in the set after the next load: freshness is your refresh cadence.
  Events that arrive one at a time stay in Redis ([what the guide says of the write model](../guide/getting-started.md#coming-from-redis-bitmaps)).
- **The raw bytes do not carry over.** A job that reads the Redis string, a byte-for-byte backup or a service that parses its
  layout has no equivalent here; `exportSegments` writes portable Roaring and ndjson ([export](../guide/export.md)).
- **Every refresh is a whole set.** Each retained generation is a whole copy in storage
  ([generations and `keep`](../guide/loading.md#generations-and-keep)).
- **Ids are unsigned 32-bit.** A set of anything else is mapped first ([id mapping](id-mapping.md)).
- **Not measured here.** This page ran on `MemoryStorage` with a stand-in for Redis, so it says nothing about the speed of an
  export, a load or a read, or about what a bucket costs. The validated envelope is narrow: single-tenant, single-region,
  S3, read-mostly ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)).
