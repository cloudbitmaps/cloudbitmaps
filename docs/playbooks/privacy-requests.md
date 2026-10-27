# Privacy requests, end to end

Answer an access request, erase a person from every set, keep the receipt and the audit trail, shred a whole segment, and know what each result does and does not prove.

A person asks what you hold on them, or asks you to delete it. For the sets in a store that means three things: find
every segment that holds their id, remove the id from all of them, and be able to show afterwards what you did. This page
walks that path on `MemoryStorage` with invented ids and a placeholder key, and ends with what a user of the call sees for
each error and what the guarantee leaves out. Every `Output` is what the repo's tests print when they run the blocks as
written. The guide it condenses is [subject access and erasure](../guide/erasure.md).

Use it when the ids in your segments identify people and a request has to be answered inside a stated time. The id is an
integer your own system maps to a person ([the id-mapping page](id-mapping.md)): the request starts there, and the store
only knows the integer.

## A store that can be shredded

The store is built with a keystore so every segment is sealed under a key of its own, which is what makes a whole segment
destroyable in one step later. The key below is a placeholder; in production it comes from your secrets manager.

<!-- typecheck -->
```ts
import { CloudRoaring, InProcessKeystore, MemoryStorage, RecordingAuditSink } from '@cloudbitmaps/roaring';

const backend = new MemoryStorage();
const keystore = new InProcessKeystore({ keys: { k1: new Uint8Array(32).fill(7) }, activeKeyId: 'k1' });
const store = new CloudRoaring({ storage: backend, encryption: { keystore, required: true } });
const audit = new RecordingAuditSink();

// Invented data: two audiences in the EU namespace, and a segment that exists for one purpose.
await store.load({ namespace: 'eu', segment: 'newsletter' }, [4101, 4102, 4103]);
await store.load({ namespace: 'eu', segment: 'buyers' }, [4102, 4104]);
await store.load({ namespace: 'eu', segment: 'case-77-attachments' }, [4900, 4901, 4902]);
await store.load({ namespace: 'us', segment: 'newsletter' }, [4102, 5000]);
const names: string[] = [];
for await (const info of store.segments({ namespace: 'eu' })) names.push(info.segment);
console.log(names.sort());
```

Output:

<!-- output -->
```text
[ 'buyers', 'case-77-attachments', 'newsletter' ]
```

## Access: which segments hold this id

`subjectReport` lists every segment of the scope whose current generation holds the id. A call needs a scope: a `namespace`,
or `allNamespaces: true` to say you mean the whole store. A call with neither throws `ValidationError`, because ids are one
space across every namespace and a call that forgot its scope would otherwise sweep every tenant.

<!-- typecheck -->
```ts
const report = await store.subjectReport(4102, { allNamespaces: true });
console.log('scanned', report.scannedSegments, 'segments');
console.log(report.segments.map((s) => `${s.namespace}/${s.segment}`).sort());
console.log('left in destroyed segments:', report.tombstones.length);
```

Output:

<!-- output -->
```text
scanned 4 segments
[ 'eu/buyers', 'eu/newsletter', 'us/newsletter' ]
left in destroyed segments: 0
```

`scannedSegments` is the denominator: how many segments the call looked in. A report that says "found in three" with no
denominator cannot be told from one that looked in three. `tombstones` lists destroyed segments whose leftover objects still
hold the id, which is a finding about the bucket and not about any live segment. The report reads each segment's current
generation, as a reader would; it is the answer to "what is in the sets", and the ledger below is where the older generations
come in.

## Erasure: remove the id everywhere

`eraseSubject` rewrites every segment that holds the id without it, deletes every older generation that still held it, and
returns the ledger. Pass an audit sink to get an event per segment as well.

<!-- typecheck -->
```ts
const ledger = await store.eraseSubject(4102, { allNamespaces: true, audit });
for (const entry of ledger.erasedFrom) console.log(`${entry.namespace}/${entry.segment}`, entry.erased);
console.log(audit.snapshot().map((event) => event.kind));
console.log((await store.subjectReport(4102, { allNamespaces: true })).segments.length);
```

Output:

<!-- output -->
```text
eu/newsletter true
eu/buyers true
us/newsletter true
[ 'segment.rewrite', 'segment.rewrite', 'segment.rewrite' ]
0
```

`erased: true` for a segment means the call listed the segment's storage and read what was left, and **no generation of it
holds the id**, above the pointer or below it. That is the receipt, and it is a return value only: keep it, or route the
audit events to an append-only log, because the library keeps neither. A segment the id was not in is not listed at all.

An entry with `erased: false` is not a failure to read and not a statement that the id is still there: its `note` says why
(`'superseded'` when a load or another erasure moved the segment while the call worked, or an `error:` note), and the call
is safe to run again. Run it until no entry carries a note, then run `subjectReport` once more as the check.

## What the receipt proves, and what it leaves out

It proves that, in the storage the store lists and for the generations that exist there, the id was not in any generation of
that segment when the call finished. It does not prove, and the page must not be read as saying:

- **Backups, replicas and noncurrent object versions.** They hold the old object until their own lifecycle removes it
  ([what an erasure does not reach](../guide/erasure.md#what-an-erasure-does-not-reach)). The tool for those is the crypto-shred below.
- **Copies you made.** A segment is the library's; an export, a spreadsheet, a composed audience written by `*Into` to a
  segment of another store, or an id kept in your own table are not. A composed segment of this store is a segment and the
  erasure reaches it.
- **A load that ran while the erasure did.** Run the erasure while no load of that id is in flight: a load that read the
  segment before the erasure began is refused, but a load that publishes after it from an export that still lists the person
  puts them back ([three rules while you erase](../guide/erasure.md#three-rules-while-you-erase)).
- **A reader that already had the id.** After the call, the store that ran it answers from the rewritten generation. Another
  store sees the rewrite within `cache.genTtlMs` (2 seconds by default), and a read in progress can still serve a bounded
  number of chunks it had already taken: [who stops seeing the id, and when](../guide/erasure.md#who-stops-seeing-the-id-and-when).

## Crypto-shred a whole segment

Some data has no per-person form: the attachments of a closed case, a tenant that leaves. Because each segment is sealed under
its own key, destroying the segment's wrapped key makes every copy of its objects unreadable, backups included, once no
retained copy of the registry row still holds the key. `destroySegment` does it for one segment and `eraseNamespace` for a
namespace; both ask you to name what you destroy.

<!-- typecheck -->
```ts
import { destroySegment } from '@cloudbitmaps/roaring';

const shred = await destroySegment(
  { namespace: 'eu', segment: 'case-77-attachments' },
  { registry: backend.registry },
  { confirmSegment: 'case-77-attachments', audit },
);
console.log(shred.destroyed, shred.cryptoShredded);
console.log(audit.snapshot().map((event) => event.kind));
const attachments = { namespace: 'eu', segment: 'case-77-attachments' };
console.log('this store, which had it open:', await store.segment(attachments.segment, { namespace: 'eu' }).count());
store.invalidate(attachments); // what the store's refresh does on its own within cache.genTtlMs
console.log('after it re-resolves:', await store.segment(attachments.segment, { namespace: 'eu' }).count());
```

Output:

<!-- output -->
```text
true true
[
  'segment.rewrite',
  'segment.rewrite',
  'segment.rewrite',
  'segment.erase'
]
this store, which had it open: 3
after it re-resolves: 0
```

The confirmation repeats the segment's **name only**, and does not check the namespace: build the ref from a value you have
checked. The call is a free function over the registry, so it invalidates no store: a store that already had the segment open (the second
line of the output) keeps answering from what it held until it refreshes, within `cache.genTtlMs`, or until you call
`store.invalidate(ref)` on it, after which the segment reads as empty. The shred removes a segment's key from its current registry row. It does not reach a backup of
the registry that holds the row from before, or the master key that wrapped it, until your own retention removes them
([disaster recovery](../guide/disaster-recovery.md#encryption--dr)). A shredded segment reads as empty and refuses a load.

## The audit

The audit sink is not a store option: each call that writes takes `audit`, so a request's trail is the sink you pass to
each call of it. What it holds is the list above: a `segment.rewrite` or `segment.collect` for each segment an erasure touched,
and `segment.erase` for a key shred. Send them to an append-only log (the sink is an object with an `onEvent` method:
[observability](../guide/observability.md)), and store the ledger beside them with the request's identifier. The ledger and the
events are what you show a regulator; nothing in the store records that a request happened.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

try {
  // No scope: the call refuses rather than sweep every tenant.
  await store.subjectReport(4102, {} as { allNamespaces: true });
} catch (error) {
  console.log(errorKind(error));
}

// A store with no keystore meets a sealed segment.
const bare = new CloudRoaring({ storage: backend });
try {
  await bare.subjectReport(4101, { allNamespaces: true });
} catch (error) {
  console.log(errorKind(error));
}
```

Output:

<!-- output -->
```text
ValidationError
KeyUnavailableError
```

| You see | What to do |
|---|---|
| `ValidationError` | The call had no scope, or both a `namespace` and `allNamespaces`, or the id is not an integer from 0 to 4,294,967,295. Fix the call; it is raised before any read. |
| `KeyUnavailableError` from `subjectReport` | A segment is sealed and this store has no keystore (or lacks the key), or the store requires encryption and a segment is cleartext. The report refuses to leave a segment out. Answer the request from a store that can read every segment. |
| An `error:` note on a ledger entry (`KeyUnavailableError`, `NotFoundError`, `IntegrityError`, `WriteConflictError`, a transient fault) | That segment was not erased: the note says why, and [reading the ledger](../guide/erasure.md#reading-the-ledger) has what to do for each. Run the call again after fixing the cause. |
| `erased: false` with `note: 'superseded'` | A load or another erasure moved the segment while the call ran. Run it again. |
| `BudgetExceededError` or `TransientError` | The scan ran past its request budget, or a fault came after the store's retries. Run the call again with a higher `budget`: an erasure is safe to repeat. |
| `destroyed: false` in a `destroySegment` or `eraseNamespace` result | The segment still holds data. `reason: 'cleartext'` means it had no key to shred; `'contended'` or `failed: …` means a fault, so run it again. |

## Limits

- **Backups and noncurrent versions are not reached.** An erasure rewrites and deletes what the store can list. Bucket versioning,
  replicas and backups keep older objects until their lifecycle ends; a crypto-shred reaches them once every retained copy of the
  row that held the key is gone ([what an erasure does not reach](../guide/erasure.md#what-an-erasure-does-not-reach)).
- **A per-person shred does not exist.** One key covers a whole segment, so crypto-shredding removes a segment, not one id from
  it; per-id removal is `eraseSubject`.
- **The in-flight bound is stated, not zero.** See [who stops seeing the id, and when](../guide/erasure.md#who-stops-seeing-the-id-and-when).
- **Cost grows with the segments scanned and the generations each holds.** An erasure scans the registry and rewrites each segment
  that holds the id, so a store with many segments pays for every one, whatever few the id is in ([what an erasure
  costs](../guide/erasure.md#find-an-id-and-erase-it)). Run it on a schedule that batches requests where the deadline allows.
- **The library keeps no record of a request.** The ledger and the audit events are return values and sink calls: persist them yourself.
- **This page ran on `MemoryStorage`**, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
