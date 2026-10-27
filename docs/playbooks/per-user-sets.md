# A set per user: seen items and follows

Why one set per user is the wrong shape for the store, what to use instead, and how to keep many small sets in one process with the standalone bitmap.

"Which of these items has this user already seen" and "who follows whom" both look like a set per user: a person's seen
items, a person's followers. A segment is a set, so the first idea is a segment per user. This page explains why that does
not fit, shows the two shapes that do, and runs the in-process one on invented ids. Every `Output` is what the repo's tests
print when they run the blocks as written.

Use it when you are about to create a segment for every user, account or device, or when you have a set per user and a
store that cannot hold them.

## Why a segment per user does not fit

A segment is a registry row and a write-once object in object storage, loaded as a whole, and a store is built and
validated for sets that are large, few and read often: up to about 100,000 segments, read-mostly, loaded in batches
([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)). A set per user inverts
every part of that:

- **There are too many.** A million users is a million rows and a million objects, ten times the validated count and each
  holding a handful of ids, so every set pays for the machinery that makes a large one safe. The store lists and
  erases by walking segments, and a retention sweep does too, so each of those grows with the count ([what an erasure
  costs](../guide/erasure.md#find-an-id-and-erase-it)).
- **They change one id at a time.** Seeing an item or following an account is a single-id write, and a segment has no `add`:
  it changes by loading a new generation of the whole set ([the README's "when not"](../../README.md#use-it-when-and-when-not)).
  One write per user action is one load per action.
- **They are read by a user, not combined at scale.** The library's strength is chunk-skipping over big shared sets. A
  per-user set is read whole, for one user, so there is nothing for the skipping to skip.

What does fit is the set that is shared and large: the items in a category, the accounts of a verified list, the day's
active users. The question "has this user seen item X" becomes "is X in this user's record", and the record belongs in
a key-value store.

## What to use instead

**A key-value store, one record per user.** The record is what the user has seen or follows, in whatever form the store keeps
best: a set type, or the bytes of a bitmap. The store gives you the per-key write rate, expiry and lookup that a per-user set needs.
The bitmap is a good value: it is compact and the same bytes load back into the standalone class. The block below does that with
a `Map` standing in for the key-value store, so the page runs.

<!-- typecheck -->
```ts
import { RoaringBitmap } from '@cloudbitmaps/roaring';

// Your key-value store: a Map stands in for it here. The value is the portable bytes of one user's set, with a version, as a
// store that offers conditional writes keeps one.
interface Entry {
  version: number;
  bytes: Uint8Array;
}
const kv = new Map<string, Entry>();

/** Writes only if the key is still at the version the caller read (undefined: no entry): the compare-and-set a real store offers. */
function putIf(key: string, expected: number | undefined, bytes: Uint8Array): boolean {
  const current = kv.get(key);
  if (current?.version !== expected) return false;
  kv.set(key, { version: (expected ?? 0) + 1, bytes });
  return true;
}

function markSeen(userId: number, itemId: number): void {
  const key = `seen:${userId}`;
  for (;;) {
    const current = kv.get(key);
    const seen = current ? RoaringBitmap.deserialize(current.bytes) : new RoaringBitmap();
    seen.add(itemId);
    if (putIf(key, current?.version, seen.serialize())) return; // another writer got there first: read again and retry
  }
}

function hasSeen(userId: number, itemId: number): boolean {
  const entry = kv.get(`seen:${userId}`);
  return entry ? RoaringBitmap.deserialize(entry.bytes).has(itemId) : false;
}

markSeen(7, 1001);
markSeen(7, 1002);
markSeen(8, 1001);
console.log(hasSeen(7, 1002), hasSeen(8, 1002), hasSeen(9, 1001));
console.log([...kv.keys()]);
```

Output:

<!-- output -->
```text
true false false
[ 'seen:7', 'seen:8' ]
```

The loop is the point. Reading a value, adding an id and writing it back is a read-modify-write: two workers acting for one user
at the same moment both read the same bytes, and with a plain `get` and `set` the later write drops the earlier worker's id. For
a seen-items filter that may be tolerable; for follows it is data loss. Use the store's native set add where it has one, or a
conditional write (a version, an ETag, a compare-and-set) with a retry, as above. The same race on the library's side is
refused rather than lost: two loads of one segment at once leave the loser with `published: false` and a `reason` of
`'superseded'`, or a `WriteConflictError` after its retries ([loading in depth](../guide/loading.md#when-a-load-is-refused)),
and it loads again.

Reading a value decodes it whole, so the record should stay small enough to read per request: a user's seen items over a
bounded window, not a lifetime. A bitmap is checked on load (`deserialize` caps and checks the bytes), so a value that is
damaged is refused and not misread.

## Many sets in one process

When the sets live inside one service (a follow graph an application holds in memory, a recommender's seen filters for the
users it serves right now), keep the bitmaps themselves in a `Map` and combine them there. The standalone `RoaringBitmap`
is the same structure the store runs on, in memory, with no storage and no write path.

<!-- typecheck -->
```ts
// Invented follow graph: the accounts each user follows, and the accounts that follow each user.
const following = new Map<number, RoaringBitmap>();
const followers = new Map<number, RoaringBitmap>();

function bitmapOf(index: Map<number, RoaringBitmap>, id: number): RoaringBitmap {
  let bitmap = index.get(id);
  if (!bitmap) {
    bitmap = new RoaringBitmap();
    index.set(id, bitmap);
  }
  return bitmap;
}

function follow(from: number, to: number): void {
  bitmapOf(following, from).add(to);
  bitmapOf(followers, to).add(from);
}

follow(1, 2);
follow(1, 3);
follow(2, 1);
follow(2, 3);
follow(3, 1);
follow(4, 1);
follow(1, 5);

console.log('followers of 1', bitmapOf(followers, 1).toArray());
console.log('mutuals of 1', RoaringBitmap.and(bitmapOf(following, 1), bitmapOf(followers, 1)).toArray());
console.log('followed by 1 and not following back', RoaringBitmap.andNot(bitmapOf(following, 1), bitmapOf(followers, 1)).toArray());
console.log('who follows both 2 and 3', bitmapOf(followers, 2).andCardinality(bitmapOf(followers, 3)));
```

Output:

<!-- output -->
```text
followers of 1 [ 2, 3, 4 ]
mutuals of 1 [ 2, 3 ]
followed by 1 and not following back [ 5 ]
who follows both 2 and 3 1
```

Each follow is two in-memory adds and a combine is a read of two bitmaps, with no request to storage. That is the whole benefit,
and it comes with the limits of a process: the sets last as long as it does, one process holds them, and nothing replicates them.

<!-- typecheck -->
```ts
// Persist the graph when the process must survive a restart: one value per user in the key-value store.
for (const [userId, bitmap] of followers) kv.set(`followers:${userId}`, { version: 1, bytes: bitmap.serialize() });
const restored = RoaringBitmap.deserialize((kv.get('followers:1') as Entry).bytes);
console.log(restored.isEqual(bitmapOf(followers, 1)), restored.size);
```

Output:

<!-- output -->
```text
true 3
```

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  follow(1, 4_294_967_296); // an account number past the 32-bit range
} catch (error) {
  console.log(errorKind(error));
}
try {
  RoaringBitmap.deserialize(new Uint8Array([1, 2, 3]));
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
ValidationError
ValidationError
```

| You see | What to do |
|---|---|
| `ValidationError` from `add` or the constructor | The id is not an integer from 0 to 4,294,967,295. Map account numbers to dense integers first ([the id-mapping page](id-mapping.md)). The bitmap is unchanged after a refused call. |
| `ValidationError` from `deserialize` | The bytes are not exactly one well-formed portable bitmap (an empty buffer, a truncated or damaged value, bytes past the end), or are over the size cap. It is `ValidationError` and never `IntegrityError`, which is for a damaged stored object. Treat the record as lost and rebuild it from your source of truth; never use a partial result. |
| A `RangeError` from `toArray` | The bitmap is too large to turn into an array. Iterate it or read it in pieces instead. |

## Limits

- **One process.** The in-memory bitmaps are not shared, replicated or durable. A second instance of the service has its own, and a restart
  starts empty unless you load them back from a key-value store.
- **Synchronous.** `RoaringBitmap` blocks the event loop for the length of a large `deserialize`, `toArray` or combine
  ([where to run it](../guide/production.md#what-blocks-the-event-loop-and-where-to-run-it)), so a service holding many large sets should
  not decode them on its request path.
- **Memory is yours to bound.** The store's cache has a ceiling; a `Map` of bitmaps does not. Evict users who are idle, and decide how
  many sets one process may hold before you fall back to the key-value store.
- **32-bit ids only.** An id above 4,294,967,295 is refused: no 64-bit social-graph ids, no 64-bit item ids until remapped.
- **No range, rank or select queries.** The class has no `rank`, `select` or range operations, so "the third-newest item this user saw" is
  not a bitmap question ([the standalone page](roaring-bitmap.md) lists what it does not provide).
- **This page ran in memory with no storage**, so it says nothing about latency, throughput or how many sets fit; see
  [the benchmarks](../benchmarks.md) for what has been measured.
