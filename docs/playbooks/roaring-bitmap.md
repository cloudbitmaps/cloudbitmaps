# Sets of integers without a store: the standalone RoaringBitmap

Build, combine, count, serialize and load sets of unsigned 32-bit ids in memory, with no storage and no native addon.

`RoaringBitmap` is the bitmap the store runs on, exposed as a class you can use by itself. This page builds one, changes
it, combines it with others, counts without building a result, round-trips it through the portable Roaring bytes and
hands it to a store. Every block runs as written, on invented data, in the repo's tests, and each `Output` is what that
run prints.

The blocks on this page use `RoaringBitmap` (0.25.0 and later).

Use it when a job needs set math on integer ids (who is in both lists, who is in this one and not that one) and a
`Set<number>` is too large, when you build a set before a `store.load`, or when you read Roaring bytes some
other process wrote. It is not a store: it keeps nothing, and a set you want to survive a restart is a segment.

## Build a set

A bitmap holds ids from 0 to 4,294,967,295. Build one from any iterable, then add and remove.

<!-- typecheck -->
```ts
import { RoaringBitmap } from '@cloudbitmaps/roaring';

// Invented data: the ids of people who opened a newsletter.
const opened = new RoaringBitmap([101, 205, 205, 70_000, 4_000_000_000]);
console.log(opened.size, opened.has(205), opened.has(206));

opened.add(300);
opened.addMany([301, 302, 303]);
console.log(opened.remove(205), opened.remove(999));
console.log(opened.size, opened.minimum(), opened.maximum());
console.log(opened.toArray());
```

Output:

<!-- output -->
```text
4 true false
true false
7 101 4000000000
[ 101, 300, 301, 302, 303, 70000, 4000000000 ]
```

A duplicate is one id, `remove` says whether the id was there, and an empty bitmap has no `minimum` or `maximum`
(`undefined`, not a number that could be an id). The ids come back ascending.

## Combine sets

The static combines return a new bitmap and change neither operand. The `InPlace` forms change the bitmap they are called
on and return it.

<!-- typecheck -->
```ts
const clicked = new RoaringBitmap([101, 300, 301, 5_000]);
const unsubscribed = new RoaringBitmap([301, 70_000]);

const both = RoaringBitmap.and(opened, clicked);
const either = RoaringBitmap.or(opened, clicked);
const onlyOne = RoaringBitmap.xor(opened, clicked);
const openedNotClicked = RoaringBitmap.andNot(opened, clicked);
console.log('and', both.toArray());
console.log('or', either.size);
console.log('xor', onlyOne.size);
console.log('andNot', openedNotClicked.toArray());

// Many at once: the union of a list of bitmaps.
const everyone = RoaringBitmap.orMany([opened, clicked, unsubscribed]);
console.log('orMany', everyone.size);

// In place: change the bitmap you hold, keep the operand.
const sendList = opened.clone();
sendList.andNotInPlace(unsubscribed).orInPlace(new RoaringBitmap([42]));
console.log('sendList', sendList.toArray());
console.log('opened is unchanged', opened.size);
```

Output:

<!-- output -->
```text
and [ 101, 300, 301 ]
or 8
xor 5
andNot [ 302, 303, 70000, 4000000000 ]
orMany 8
sendList [ 42, 101, 300, 302, 303, 4000000000 ]
opened is unchanged 7
```

`xorInPlace` is the fourth in-place form. `clone()` is copy-on-write: it costs the key list, not the ids, and the first
write to a shared container copies that container once.

## Count and compare without building a result

A count answers from the two bitmaps' containers and builds no bitmap you keep. Use it for "how many would this send to"
before you decide to build the list.

<!-- typecheck -->
```ts
console.log(opened.andCardinality(clicked), opened.orCardinality(clicked));
console.log(opened.xorCardinality(clicked), opened.andNotCardinality(clicked));
console.log(opened.intersects(unsubscribed), clicked.intersects(new RoaringBitmap([7])));
console.log(new RoaringBitmap([101]).isSubset(opened), opened.isSubset(clicked));
console.log(opened.isEqual(opened.clone()), opened.isEqual(clicked));
```

Output:

<!-- output -->
```text
3 8
5 4
true false
true false
true false
```

`intersects(b)` is `andCardinality(b) > 0`, `isSubset` is membership (the empty set is a subset of every set), and
`isEqual` compares ids, not how the containers are stored.

## Serialize, deserialize and hand it to a store

`serialize()` gives the portable Roaring bytes, the format every Roaring implementation reads. `deserialize` is the one
door for bytes you did not make: it caps the size, checks the layout and refuses anything that is not exactly one
bitmap. A store loads a bitmap as it is.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const bytes = sendList.serialize();
const received = RoaringBitmap.deserialize(bytes);
console.log(bytes.length > 0, received.isEqual(sendList));

const store = new CloudRoaring({ storage: new MemoryStorage() });
const loaded = await store.load({ segment: 'newsletter-send' }, received);
console.log(loaded.published, loaded.cardinality);
const segment = store.segment('newsletter-send');
console.log(await segment.count(), await segment.has(42), await segment.has(205));
```

Output:

<!-- output -->
```text
true true
true 6
6 true false
```

The load reads the bitmap and keeps no reference to it, so changing `received` afterwards does not change the segment. A
bitmap that serializes above the load's size cap is refused: call `runOptimize()` first.

## What goes wrong

Every id argument is checked, and a refusal never repeats the value, because an id that is refused is often an identifier
that was never meant to be one.

<!-- typecheck -->
```ts
import { ValidationError } from '@cloudbitmaps/roaring';

const attempts: Array<[string, () => unknown]> = [
  ['an id past 2^32 - 1', () => opened.add(2 ** 32)],
  ['a negative id', () => new RoaringBitmap([-1])],
  ['a fraction', () => opened.has(1.5)],
  ['bytes as ids', () => new RoaringBitmap(Uint8Array.from([1, 2, 3]))],
  ['an empty buffer', () => RoaringBitmap.deserialize(new Uint8Array(0))],
  ['bytes that are not a bitmap', () => RoaringBitmap.deserialize(Uint8Array.from([1, 2, 3, 4, 5]))],
];
for (const [what, attempt] of attempts) {
  try {
    attempt();
    console.log(what, 'was accepted');
  } catch (error) {
    console.log(what, '->', error instanceof ValidationError ? error.name : error);
  }
}
```

Output:

<!-- output -->
```text
an id past 2^32 - 1 -> ValidationError
a negative id -> ValidationError
a fraction -> ValidationError
bytes as ids -> ValidationError
an empty buffer -> ValidationError
bytes that are not a bitmap -> ValidationError
```

| You see | What to do |
|---|---|
| `ValidationError` from an id, a combine's operand or `deserialize` | Fix the call: it is raised before anything is changed, so the bitmap is as it was. Bytes that crossed a process boundary and fail `deserialize` are not a bitmap: refuse the message, do not retry it. |
| `TransientError`, `NotFoundError`, `WriteConflictError` from `store.load` | These are the store's, not the bitmap's: see [the errors table](../guide/api-reference.md#errors-typed--you-catch-these) for what each means and whether to retry. A load is safe to run again. |
| `RangeError` from `toArray` or `toUint32Array` | The set is too large to allocate as an array in this runtime: iterate it, or `serialize()` it. |

## Limits

- **Unsigned 32-bit ids only.** 64-bit ids are not provided; an id above 4,294,967,295 is refused.
- **Not provided:** ranges, `rank`, `select`, frozen views, Array-style helpers, `toSet`, `getSerializationSizeInBytes`,
  `xorMany` and `delete`. The [API reference](../guide/api-reference.md#build-and-combine-bitmaps-by-themselves--roaringbitmap)
  lists every difference from the `roaring` package.
- **Synchronous.** A large `deserialize`, `toArray` or combine holds the event loop for its duration: see
  [where to run it](../guide/production.md#what-blocks-the-event-loop-and-where-to-run-it).
- **Runtimes.** CI runs this on Node 22 and 24. No browser, edge isolate, Bun or Deno run of the class is claimed.
- **Speed.** What each operation costs next to the `roaring` package on the same data, losses included, is the table in
  [the TypeScript codec against native](../benchmarks.md#the-typescript-codec-against-native). No figure is stated here.
- **Not a store.** It keeps nothing; to keep a set, load it as a segment. For the store's side see
  [using it by itself](../guide/roaring-codec.md#using-it-by-itself).
