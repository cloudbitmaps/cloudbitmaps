# Opt-outs, bounces and consent at send time

Subtract suppression lists from any audience at the moment of the send, hold the lists you subtracted fixed, and remove a person from every set when an opt-out must also be an erasure.

A suppression list is a set of ids that must not be contacted: people who opted out, addresses that bounced, people whose
consent lapsed. Each list is a segment of its own, and a send is an audience with those segments taken away. This page
builds the lists, subtracts them in one pass, holds them fixed for the length of a send, proves afterwards which list a send
used, and covers the opt-out that must also be erased. It runs on `MemoryStorage` with invented ids, and every `Output` is
what the repo's tests print when they run the blocks as written.

Use it when the audience and the suppression come from different places and have to meet at send time, so a person who
opts out between the audience build and the send is still left out. It is not a consent management platform: see
[Limits](#limits).

## One list per reason, subtracted at send time

Keep each reason in its own segment, in a namespace of its own, so a list can be refreshed, counted and erased on its own.
A send names the lists it honours.

<!-- typecheck -->
```ts
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });
const list = (segment: string) => store.segment(segment, { namespace: 'suppression' });

await store.load({ segment: 'newsletter' }, [11, 12, 13, 14, 15, 16, 17, 18]);
await store.load({ namespace: 'suppression', segment: 'opt-out' }, [12, 18]);
await store.load({ namespace: 'suppression', segment: 'hard-bounce' }, [14, 99]);

async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const ids: number[] = [];
  for await (const id of stream) ids.push(id);
  return ids;
}

const newsletter = store.segment('newsletter');
console.log('audience', await newsletter.count());
console.log('send to', await collect(newsletter.andNot([list('opt-out'), list('hard-bounce')])));
```

Output:

<!-- output -->
```text
audience 8
send to [ 11, 13, 15, 16, 17 ]
```

`andNot` reads the audience in full and each suppression list only where it overlaps the audience, so a long list
that mostly names people who are not in this audience costs little ([what each combine reads](../guide/reading.md#combine-segments-intersect-union-andnot)).
When the audience is itself an intersection, pass the lists as `exclude` instead of chaining a second combine: the
subtraction folds into one pass and reads each list only where the result survives.

<!-- typecheck -->
```ts
await store.load({ segment: 'recent-buyers' }, [12, 13, 14, 15, 40]);
const targeted = newsletter.intersect([store.segment('recent-buyers')], {
  exclude: [list('opt-out'), list('hard-bounce')],
});
console.log('buyers on the newsletter, suppressed', await collect(targeted));
```

Output:

<!-- output -->
```text
buyers on the newsletter, suppressed [ 13, 15 ]
```

## Keep the lists fresh

A suppression list changes by a load of the whole list, like any segment: load the list with the new opt-outs and the old
ones, as one new generation. A refresh that went wrong must never replace a good list with a short one, so give it a
guard.

<!-- typecheck -->
```ts
const today = [12, 18, 15]; // yesterday's opt-outs plus one new one
const refreshed = await store.load({ namespace: 'suppression', segment: 'opt-out' }, today, { guard: { minRetained: 0.9 } });
console.log(refreshed.published, refreshed.cardinalityBefore, '->', refreshed.cardinality);

// A broken export that lost most of the list is refused instead of un-suppressing everyone it dropped.
const broken = await store.load({ namespace: 'suppression', segment: 'opt-out' }, [12], { guard: { minRetained: 0.9 } });
console.log(broken.published, broken.reason);
console.log('send to', await collect(newsletter.andNot([list('opt-out'), list('hard-bounce')])));
```

Output:

<!-- output -->
```text
true 2 -> 3
false min-retained
send to [ 11, 13, 16, 17 ]
```

Branch on `published` every time. How fresh the list is, to a process that reads it and did not write it, is the reader's
pointer refresh, which is `cache.genTtlMs` (2 seconds by default): a reader that is not the process that loaded the list
sees the new opt-out within that time ([how soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load)).
For a send that must not miss an opt-out that arrived a moment ago, load the list, wait longer than the refresh, then start
the send; or call `store.invalidate(ref)` on every reader.

## Hold the lists fixed for the length of a send

A send that takes an hour should not honour one version of the opt-out list at the start and another at the end, and it
should be able to say afterwards which one it honoured. Pin each list and the audience for the whole send; a pin holds one
generation, and a lease keeps it in storage while the send runs.

<!-- typecheck -->
```ts
const lease = { leaseUntil: Date.now() + 3_600_000 };
const audience = await newsletter.pin(lease);
const optOut = await list('opt-out').pin(lease);
const bounced = await list('hard-bounce').pin(lease);

// An opt-out arrives while the send is running.
await store.load({ namespace: 'suppression', segment: 'opt-out' }, [12, 18, 15, 16]);

console.log('this send honours', optOut.pinnedAt?.generation, 'and sends to', await collect(audience.andNot([optOut, bounced])));
console.log('the next send sees', await collect(newsletter.andNot([list('opt-out'), list('hard-bounce')])));
console.log('a pin names what it held:', audience.pinnedAt?.generation, optOut.pinnedAt?.generation, bounced.pinnedAt?.generation);
```

Output:

<!-- output -->
```text
this send honours 1 and sends to [ 11, 13, 16, 17 ]
the next send sees [ 11, 13, 17 ]
a pin names what it held: 0 1 0
```

Record the three generation numbers with the send. They are the answer to "what did you suppress against?", and the pin's
`pinnedAt` carries the fingerprint that names the exact object as well, for a reopen with `pinAt` ([reopen a pinned
generation](../guide/reading.md#reopen-a-pinned-generation-pinat)). A pin is a hold, not a copy, and a lease is the thing that
keeps its generation in storage; release both when the send ends.

<!-- typecheck -->
```ts
await audience.release();
await optOut.release();
await bounced.release();
```

A send that is late on the lists starts again from a fresh pin: it takes the new opt-out, and its record says so.

## When an opt-out is also an erasure

Most opt-outs only mean "do not contact": the id stays in the list so that it keeps being subtracted. Some mean "forget
me", and then the id has to leave every set that holds it, including the audiences you built before the request. That is
`subjectReport` to see where the id is, and `eraseSubject` to remove it.

<!-- typecheck -->
```ts
const where = await store.subjectReport(16, { allNamespaces: true });
console.log('16 is in', where.segments.map((s) => `${s.namespace ?? '-'}/${s.segment}`).sort());

const ledger = await store.eraseSubject(16, { allNamespaces: true });
console.log(ledger.erasedFrom.map((e) => [e.segment, e.erased]));
console.log('still suppressed?', await list('opt-out').has(16));
```

Output:

<!-- output -->
```text
16 is in [ '-/newsletter', 'suppression/opt-out' ]
[ [ 'newsletter', true ], [ 'opt-out', true ] ]
still suppressed? false
```

Notice what that did to the suppression list: the erasure removed 16 from `opt-out` as well, so the erased person is no longer
subtracted, and a later import that brings them back would contact them. Keep the fact of the opt-out where the erasure does not
reach: a do-not-contact record of a **keyed** value (a salted hash of the address, in your own table), never the raw id in a segment
that an erasure sweeps. The ledger is your proof of deletion and exists only as the return value, so keep it. An erasure does not
reach backups or noncurrent object versions ([what it does not reach](../guide/erasure.md#what-an-erasure-does-not-reach)).

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // A mistyped list name: it would subtract nobody, so the combine refuses it instead of sending to everyone.
  await collect(newsletter.andNot([list('opt-outs')]));
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
| `ValidationError` from a combine | A suppression list names no segment (a typo, the wrong `namespace`, a list that was dropped). Fix the call: it is raised before any read, and it is what keeps a mistake from sending to everyone. `allowAbsentOperands: true` reads a list that may legitimately not exist yet as empty: never set it for a list that must exist. |
| `LeaseExpiredError` from a pinned list | The lease ended before the send did. Never treat it as an empty list. Start the send again from a fresh pin with a longer lease (at most 14 days). |
| `NotFoundError` from a pinned read | A pin without a lease whose generation was collected by a later load. Take a lease, or size `keep` past the loads that can land meanwhile. |
| `published: false` with a `reason` | The guard held the line on a refresh. Look at the export before you loosen the guard. |
| `TransientError`, `BudgetExceededError`, `WriteConflictError` | A fault after the store's own retries, a call past its request budget, or a racing writer. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) says which to retry. |

## Limits

- **Freshness is the reader's pointer refresh.** A list reaches a reader that did not load it within `cache.genTtlMs`,
  and a running read can serve a little of the earlier generation within the bound in [who stops seeing an id, and
  when](../guide/erasure.md#who-stops-seeing-the-id-and-when). A pin has no refresh at all, by design: a pinned send honours the list it pinned.
- **Not a consent management platform.** A segment holds ids. It does not record who consented to what, when, or on which
  channel; it has no per-person history and no policy. Those live in the system you collect consent in, and this page is
  where the result of that system is applied at send time.
- **A suppression list is only as complete as its load.** The send subtracts what is in the list now, so an opt-out the
  upstream system has not loaded yet is not subtracted.
- **Erasure and suppression pull in opposite directions.** See the block above: erasing an id from the suppression list stops
  it being suppressed.
- **This page ran on `MemoryStorage`**, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
