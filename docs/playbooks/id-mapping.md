# Getting your ids into dense unsigned 32-bit integers

Map emails, UUIDs and other keys to small integers once, keep the map beside your segments, and translate back when you send.

A segment holds integers from 0 to 4,294,967,295 and nothing else: it never sees an email address or a UUID. Whatever
names your people has to become an integer before a load and become a name again after a read, and that translation is
yours. This page is a recipe, not a feature: a small table you own, three rules for assigning ids, and the translation in
both directions. It runs on `MemoryStorage` with invented keys, and every `Output` is what the repo's tests print when
they run the blocks as written.

Use it when your people are known by a string (an email, a device id, a UUID) or by a number that is far larger than the
people you have. If your ids are already small integers handed out by one counter, you are done: load them.

## Why dense integers

A segment is stored as chunks, each holding the ids that share their upper 16 bits: at most 65,536 ids per chunk
([`batches()`](../guide/reading.md#read-a-chunk-at-a-time-batches) yields one chunk at a time). An `intersect` reads only the chunks
that every operand holds, so sets whose ids sit in the same low range share few chunks, while ids scattered across the whole
32-bit range fall in many (a `union` reads every chunk of every operand, and an `andNot` every chunk of the set it subtracts
from: [what each combine reads](../guide/reading.md#combine-segments-intersect-union-andnot)). Handing out ids one after another
from 0 keeps the whole id space in as few chunks as the people number, and keeps every id well inside the 32-bit limit; it does
not make any one audience minimal, since a scattered subset of the people still spans the chunks its members fall in. A hash of an email is the other common choice, and the wrong one here: it spreads people
evenly across the range, and two different people can share a hash.

## A table you own

The table is a key-value store you already run: a database table, a key-value service, a file. It has two columns, the key
and the integer, and one counter. The class below is that table on a `Map`, so the page runs; swap the `Map` for your store and
keep the three rules in `assign`.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

class IdTable {
  private readonly ids = new Map<string, number>();
  private readonly keys: string[] = [];
  private readonly erased = new Set<string>();

  /** The id of a key, handing out the next unused integer the first time the key is seen. */
  assign(key: string): number {
    if (this.erased.has(key)) throw new Error('this key was erased and must not be loaded again');
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.keys.length; // the counter only grows: an id is never handed out twice
    this.ids.set(key, id);
    this.keys.push(key);
    return id;
  }

  /** The id of a key that was already assigned, without assigning one. */
  lookup(key: string): number | undefined {
    return this.ids.get(key);
  }

  /** Marks an erased key: its id stays spent, and the key is refused from now on. */
  retire(key: string): void {
    this.erased.add(key);
  }

  /** The key behind an id, or undefined for an id this table never handed out. */
  keyOf(id: number): string | undefined {
    return this.keys[id];
  }

  get size(): number {
    return this.keys.length;
  }
}

const table = new IdTable();
const store = new CloudRoaring({ storage: new MemoryStorage() });

// Invented export: the people who bought this week, as the warehouse names them.
const buyers = ['ana@example.com', 'ben@example.com', 'caro@example.com', 'ana@example.com'];
const buyerIds = buyers.map((email) => table.assign(email));
console.log(buyerIds);

const loaded = await store.load({ segment: 'buyers' }, buyerIds);
console.log(loaded.published, loaded.cardinality);
```

Output:

<!-- output -->
```text
[ 0, 1, 2, 0 ]
true 3
```

The id of a key never changes once it is assigned, so a key you meet again in next week's export gets the same integer and
the segments you loaded last week still mean what they meant.

## Three rules for assigning

1. **A key gets one id, once.** Look the key up first, assign only on a miss, and make the lookup and the assignment one
   atomic step in your table (a unique key on the column, an insert that returns the existing row). Two jobs that assign the
   same new key at the same moment must end with one integer.
2. **The counter only grows.** Never fill a gap and never reuse an id, including the id of a person you erased. A reused id
   would put a new person into every segment that still holds the old one, in segments you cannot see and in
   generations that are still in storage.
3. **Keep the table as long as any segment that uses it.** A segment of integers means nothing without the table that made
   them: back the table up with the same care as the segments ([disaster recovery](../guide/disaster-recovery.md)).

Rule 2 is the one that fails quietly, so here it is acted out. A person asks to be erased: remove the id from every
segment, and keep the table's row, marked: the key keeps its id, that id is never given to another key, and `assign`
refuses the key from then on.

<!-- typecheck -->
```ts
for (const email of ['dev@example.com', 'eli@example.com']) table.assign(email);
await store.load({ segment: 'newsletter' }, [0, 1, 3]);

const erasedId = table.lookup('ben@example.com');
if (erasedId === undefined) throw new Error('no such key');
const report = await store.subjectReport(erasedId, { allNamespaces: true });
console.log('ben is id', erasedId, 'and is in', report.segments.map((s) => s.segment).sort());

const ledger = await store.eraseSubject(erasedId, { allNamespaces: true });
console.log(ledger.erasedFrom.map((e) => [e.segment, e.erased]));

// The table keeps the row, marked: a new key takes the next integer, and the erased key is refused.
table.retire('ben@example.com');
console.log('next new key gets', table.assign('fay@example.com'), 'not', erasedId);
try {
  table.assign('ben@example.com'); // a later export that still lists the person
} catch (error) {
  console.log((error as Error).message);
}
```

Output:

<!-- output -->
```text
ben is id 1 and is in [ 'buyers', 'newsletter' ]
[ [ 'buyers', true ], [ 'newsletter', true ] ]
next new key gets 5 not 1
this key was erased and must not be loaded again
```

The erased person is gone from the segments, and their integer stays spent in the table. The marker holds the raw key, and so does the row (`keys[]` and `ids`, and `keyOf` returns it), so removing the marker alone does
not remove the address. The key is itself personal data: if the law you work under says to remove it, replace it with a keyed hash you can match at import (the
advice on [the suppression page](suppression.md#when-an-opt-out-is-also-an-erasure), which the library does not implement), but
never give up the counter's position: that is the number the next person must not take.

## Translate back for a send

A combine returns integers. The send needs addresses, so every page of ids goes through the table on its way out.

<!-- typecheck -->
```ts
const newsletter = store.segment('newsletter');
const buying = store.segment('buyers');

const addresses: string[] = [];
for await (const id of buying.intersect([newsletter])) {
  const email = table.keyOf(id);
  if (email === undefined) throw new Error(`id ${id} is not in the table`); // a segment and a table that disagree
  addresses.push(email);
}
console.log(addresses);
```

Output:

<!-- output -->
```text
[ 'ana@example.com' ]
```

An id with no key is a fault worth stopping for: it means a segment was loaded from a table you no longer have, or from a
different one. Do not skip it and send to the rest.

## A table rebuilt with each load

The other shape is a table with no memory: each load sorts that load's keys and numbers them from 0. It needs no
table beyond the run, and it has one cost that decides whether you can use it. Every id means something only within the load
that made it, so two segments can be combined only if the same run built both from the same dictionary.

<!-- typecheck -->
```ts
function rebuild(keys: string[]): Map<string, number> {
  return new Map([...new Set(keys)].sort().map((key, index) => [key, index]));
}

const monday = rebuild(['ana@example.com', 'caro@example.com']);
const tuesday = rebuild(['ana@example.com', 'ben@example.com', 'caro@example.com']);
console.log('caro on monday', monday.get('caro@example.com'), 'on tuesday', tuesday.get('caro@example.com'));
```

Output:

<!-- output -->
```text
caro on monday 1 on tuesday 2
```

The same person is a different integer on each day. Use this only when one job builds every segment it will ever combine,
all from one dictionary, and throws the dictionary away after. Anything that composes segments loaded on different days
needs the persistent table above.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // A value past the 32-bit range: a phone number or a hash that was never turned into a dense id.
  await store.load({ segment: 'too-big' }, [4_294_967_296]);
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
| `ValidationError` from a load or a read | An id is not an integer from 0 to 4,294,967,295 (a fraction, a negative, a string, or a value past the range). Map the identifier to a dense integer before the call. The message never repeats the value, because a refused id is often an identifier that was never meant to be one. |
| An id that `keyOf` cannot translate | The segment was built from another table, or the table lost rows. Restore the table that made the segment; do not guess. |
| `published: false` from a load | Not an id problem: the guard or another writer refused it. [Loading in depth](../guide/loading.md#when-a-load-is-refused) lists the reasons. |

## Limits

- **The table is yours.** The library stores integers and never the table: it does not assign, look up, back up or erase
  rows of it, and it cannot tell that two integers are the same person. A mistake in the table is a mistake in every
  audience built on it.
- **Unsigned 32-bit only.** An id above 4,294,967,295 is refused, and so is a negative one: the format is 32-bit. A source
  that is 64-bit has to be remapped to dense integers first; there is no 64-bit segment.
- **One id space.** Ids are the same space in every namespace, so one table serves every segment of a store. Two tables on
  one store give the same integer to two people.
- **Erasing is two jobs.** `eraseSubject` removes an integer from the segments; removing the key from your table, and from
  any copy of it, is yours ([what an erasure does not reach](../guide/erasure.md#what-an-erasure-does-not-reach)).
- **This page ran on `MemoryStorage`**, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
