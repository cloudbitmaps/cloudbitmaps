# Funnels: what sets can answer and what they cannot

A page of limits: a set can say who did both steps of a funnel, it cannot say in which order or how far apart, and the rest needs events.

A funnel asks how many people viewed a product, then added it to a cart, then bought it, usually within a window. A segment
is a set of ids: it says whether an id did a thing, and nothing about when or in what order. So sets answer the part of a
funnel that is a question of membership, and the part that is a question of sequence needs the events. This page runs the first
on `MemoryStorage` with invented ids, shows the second failing on the same data, and says what to use. Every `Output` is what
the repo's tests print when they run the blocks as written.

Use it before you design a funnel on sets. It is a "no" page with one "yes" in it.

## What a set can answer: did both

Load one segment per step for a window (here, one week). "Did both" is an intersection, "bought without viewing" is a
difference, and a count of either is `intersectCount` or `andNotCount` (0.26.0 and later), or a stream counted an array at a time ([the counting page](counting.md) has the other ways).

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });
await store.load({ namespace: 'week-1', segment: 'viewed' }, [1, 2, 3, 4, 5, 6, 7, 8]);
await store.load({ namespace: 'week-1', segment: 'carted' }, [2, 3, 4, 5, 6]);
await store.load({ namespace: 'week-1', segment: 'purchased' }, [3, 4, 9]);
const viewed = store.segment('viewed', { namespace: 'week-1' });
const carted = store.segment('carted', { namespace: 'week-1' });
const purchased = store.segment('purchased', { namespace: 'week-1' });

console.log('viewed', await viewed.count());
console.log('viewed and carted', await viewed.intersectCount([carted]));
console.log('all three', await viewed.intersectCount([carted, purchased]));
console.log('bought without a view', await purchased.andNotCount([viewed]));
```

Output:

<!-- output -->
```text
viewed 8
viewed and carted 5
all three 2
bought without a view 1
```

These are the sizes of sets, and they are exact for the window they were built over. They are not conversion steps: id 9
bought without a view in this window, which a funnel would not count, and the sets cannot say whether the 5 who carted viewed
first.

## What a set cannot answer: order and time

"Carted within an hour of viewing" depends on two timestamps per person. Below are two event logs that differ in exactly that:
in the first, each person viewed and then carted, one within the hour and one not; in the second, each carted and then viewed.
Their step sets are the same.

This block imports `RoaringBitmap` (0.25.0 and later).

<!-- typecheck -->
```ts
import { RoaringBitmap } from '@cloudbitmaps/roaring';

interface LogEvent {
  user: number;
  step: string;
  at: number;
}
const viewThenCart: LogEvent[] = [
  { user: 21, step: 'viewed', at: 100 },
  { user: 21, step: 'carted', at: 200 },
  { user: 22, step: 'viewed', at: 100 },
  { user: 22, step: 'carted', at: 9_000 },
];
const cartThenView: LogEvent[] = [
  { user: 21, step: 'carted', at: 100 },
  { user: 21, step: 'viewed', at: 200 },
  { user: 22, step: 'carted', at: 100 },
  { user: 22, step: 'viewed', at: 9_000 },
];

/** The set of users that did each step: this is all a segment can hold. */
function stepSets(events: LogEvent[]): Map<string, RoaringBitmap> {
  const sets = new Map<string, RoaringBitmap>();
  for (const e of events) {
    const set = sets.get(e.step) ?? new RoaringBitmap();
    set.add(e.user);
    sets.set(e.step, set);
  }
  return sets;
}

const first = stepSets(viewThenCart);
const second = stepSets(cartThenView);
for (const step of ['viewed', 'carted']) {
  console.log(step, 'same in both logs:', first.get(step)?.isEqual(second.get(step) ?? new RoaringBitmap()));
}
```

Output:

<!-- output -->
```text
viewed same in both logs: true
carted same in both logs: true
```

Whatever a set is loaded with, it holds the same ids for the log in which the cart came first and the log in which it came
second, so no combine of step sets can tell them apart. "A then B", "within an hour of" and "A, then B, then C in that order"
are questions about events.

## What to use for the rest

- **A warehouse or an event engine** holds the events, one row per (id, step, time), and answers sequence and window
  questions with window functions or a funnel or sequence function, which is the tool for the funnel itself.
- **The library helps where the answer is a set that other services combine.** Compute the funnel in the warehouse, where order
  and time live, and load its result: the ids that carted within an hour of viewing are one segment, composed with an audience, a
  suppression list or another week like any other ([audience segments](audience-segments.md)). The step sets above are the same
  idea for the "did both" part: a query builds each, a load publishes it, and the intersections and counts are cheap.

## What goes wrong

| You see | What to do |
|---|---|
| `ValidationError` from a combine | A window has no segment yet (a step was not loaded for that week), or a name is mistyped. The combine refuses it instead of reading it as empty, so a missing step cannot report a funnel of zero. `allowAbsentOperands: true` reads it as empty, which hides a load that did not run ([combine segments](../guide/reading.md#combine-segments-intersect-union-andnot)). |
| A count that differs from the warehouse | The sets and the warehouse were built over different windows or at different times. A segment answers for its last load ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)). |
| `published: false` on a load | The guard held the line. Look at the export before you loosen it ([when a load is refused](../guide/loading.md#when-a-load-is-refused)). |

## Limits

- **No order, no time.** A set holds ids and nothing else, by design: "A then B within an hour" cannot be expressed.
- **A count of a combine reads the shared chunks.** `intersectCount` (0.26.0 and later) counts a step without
  streaming its ids; [the counting page](counting.md) says what each way costs, and a many-step funnel repeats reads of the shared steps.
- **One segment per step per window.** Weekly windows over a year of five steps are 260 segments, and the validated envelope is
  about 100,000 in all ([what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt)).
- **Ids are unsigned 32-bit integers.** Anonymous visitors need an id first ([id mapping](id-mapping.md)).
- **Not measured here.** This page ran on `MemoryStorage`, so it says nothing about latency or cost; see
  [the cost guide](../guide/cost.md) and [the benchmarks](../benchmarks.md).
