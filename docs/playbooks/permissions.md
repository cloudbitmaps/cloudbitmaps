# Who may see what: permission sets per resource and group

Keep a set of user ids for each resource and group, check access with one membership read, revoke by loading, remove a person everywhere and shred a tenant that leaves.

An access list is a set of ids, and a check is "is this id in it". Here each resource and each group is a segment, a check
is `has`, a revoke is a load, and a person who must disappear is removed from every set by one call. Each tenant's segments
live in a namespace of its own, which also makes a tenant's departure one call. This page runs on `MemoryStorage` with
invented ids, and every `Output` is what the repo's tests print when they run the blocks as written.

Use it when permissions are computed upstream (from a directory, a billing system, a rules job), are read often, and a
change may take a few seconds to be seen everywhere. It is not a policy engine, and a revoke is not instant: see
[Limits](#limits).

## A segment per resource and per group

The store is built with a keystore, so every segment is sealed under its own key. That is what makes a tenant that leaves
unreadable in one step, and it costs nothing in the code that checks access. The key below is a placeholder: in production
it comes from your secrets manager.

<!-- typecheck -->
```ts
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@cloudbitmaps/roaring';

const backend = new MemoryStorage();
const keystore = new InProcessKeystore({ keys: { k1: new Uint8Array(32).fill(7) }, activeKeyId: 'k1' });
const store = new CloudRoaring({ storage: backend, encryption: { keystore, required: true } });

const acl = (tenant: string, name: string) => store.segment(name, { namespace: `tenant:${tenant}` });

// Directory export for one tenant: two groups and the people named on two documents.
await store.load({ namespace: 'tenant:acme', segment: 'group:finance' }, [7001, 7002, 7003]);
await store.load({ namespace: 'tenant:acme', segment: 'group:eng' }, [7004, 7005]);
await store.load({ namespace: 'tenant:acme', segment: 'doc:1001:direct' }, [7006]);
await store.load({ namespace: 'tenant:acme', segment: 'doc:1002:direct' }, [7004]);

// A document's access list is its direct names plus the groups it is shared with, written as one segment.
await acl('acme', 'doc:1001:direct').unionInto(acl('acme', 'doc:1001'), [acl('acme', 'group:finance')], { keep: 2 });
await acl('acme', 'doc:1002:direct').unionInto(acl('acme', 'doc:1002'), [acl('acme', 'group:finance'), acl('acme', 'group:eng')], { keep: 2 });

// The check a request makes.
const canView = (tenant: string, doc: number, userId: number) => acl(tenant, `doc:${doc}`).has(userId);
console.log(await canView('acme', 1001, 7002), await canView('acme', 1001, 7004), await canView('acme', 1002, 7005));
console.log(await acl('acme', 'doc:1002').count());
```

Output:

<!-- output -->
```text
true false true
5
```

The check is one `has`: the first call reads the segment's registry row and index, decrypts the chunk that could hold the
id, and later calls answer from the store's cache. Composing the groups into the document's own segment at refresh time
keeps the request path to one membership read; a stream of the same sets, `intersect` or `union`, is for reports, not for
the check.

## Revoke by loading

Removing someone is a load of the list without them. The store that made the load sees it at once. A store in another
process sees it within `cache.genTtlMs` (2000 ms by default). The block below gives a second store, the checker, a clock
the code moves by hand so it needs no waiting.

<!-- typecheck -->
```ts
import type { Clock } from '@cloudbitmaps/roaring';

let now = Date.UTC(2026, 9, 26, 12, 0, 0);
const clock: Clock = { now: () => now, sleep: async () => {} };
const checker = new CloudRoaring({ storage: backend, encryption: { keystore, required: true }, seams: { clock } });
const checks = (userId: number) => checker.segment('doc:1001', { namespace: 'tenant:acme' }).has(userId);

console.log('checker before the revoke', await checks(7002));
await store.load({ namespace: 'tenant:acme', segment: 'group:finance' }, [7001, 7003]); // 7002 left the group
await acl('acme', 'group:finance').unionInto(acl('acme', 'doc:1001'), [acl('acme', 'doc:1001:direct')], { keep: 2 });
console.log('the revoking store', await canView('acme', 1001, 7002));
console.log('the checker, before its refresh passes', await checks(7002));
now += 3_000;
console.log('the checker, after its refresh passes', await checks(7002));
```

Output:

<!-- output -->
```text
checker before the revoke true
the revoking store false
the checker, before its refresh passes true
the checker, after its refresh passes false
```

Until the checker's refresh passes it still answers from the old generation, so a revoke takes up to `cache.genTtlMs` to
reach a reader that is not the writer, and a longer read that was already running can serve a little of the old set: the
bound, in chunks, is stated in [who stops seeing an id, and
when](../guide/erasure.md#who-stops-seeing-the-id-and-when). Where that is too slow, lower `cache.genTtlMs` (it costs
registry reads), or call `store.invalidate(ref)` on every reader when you revoke; fanning that out is yours, because the
library has no channel between processes.

## One consistent answer for a review

An access review walks many resources and should describe one instant, not whatever each load made current while it ran.
A pin holds a segment at the generation current when it was taken.

<!-- typecheck -->
```ts
const finance = await acl('acme', 'group:finance').pin();
await store.load({ namespace: 'tenant:acme', segment: 'group:finance' }, [7001]); // a change lands mid-review
console.log('pinned review sees', await finance.count(), '- live now', await acl('acme', 'group:finance').count());
await finance.release(); // a no-op for a pin with no lease
```

Output:

<!-- output -->
```text
pinned review sees 2 - live now 1
```

A pin is a hold, not a copy: a later load's collection can delete the generation it names, so a long review takes a lease
([reading one fixed point in time](../guide/reading.md#read-one-fixed-point-in-time)).

## Remove a person everywhere

When someone must go from every list at once (an offboarding, a deletion request), `subjectReport` lists the segments that
hold the id and `eraseSubject` rewrites each one without it, and deletes every older generation that still held it.

<!-- typecheck -->
```ts
const report = await store.subjectReport(7004, { namespace: 'tenant:acme' });
console.log('7004 is in', report.segments.map((s) => s.segment).sort());

const ledger = await store.eraseSubject(7004, { namespace: 'tenant:acme' });
console.log('erased from', ledger.erasedFrom.filter((e) => e.erased).map((e) => e.segment).sort());
console.log(await canView('acme', 1002, 7004), await acl('acme', 'group:eng').has(7004));
```

Output:

<!-- output -->
```text
7004 is in [ 'doc:1002', 'doc:1002:direct', 'group:eng' ]
erased from [ 'doc:1002', 'doc:1002:direct', 'group:eng' ]
false false
```

The ledger is your proof of deletion and exists only as the return value, so keep it. Run it while no load of that id is in
flight, and know it does not reach backups, replicas or noncurrent object versions, which keep the old object until their
lifecycle removes it ([what an erasure does not reach](../guide/erasure.md#what-an-erasure-does-not-reach)); a crypto-shred is
the tool for those. The scope is the tenant here; a call
with `allNamespaces: true` sweeps every tenant. The cost grows with the segments scanned and the generations each holds
([what an erasure costs](../guide/erasure.md#find-an-id-and-erase-it)). The direct lists `doc:1002:direct` and the composed
`doc:1002` are both segments, so both are rewritten: a composed list is a copy of the id, and an erasure reaches every
copy that is a segment of this store.

## A tenant leaves

Because every segment is sealed under its own key, a tenant's namespace can be made unreadable by removing those keys from
the registry. The objects stay in the bucket, and no store can open them through the current row.

<!-- typecheck -->
```ts
import { eraseNamespace } from '@cloudbitmaps/roaring';

await store.load({ namespace: 'tenant:globex', segment: 'group:all' }, [8001, 8002]);
const before = await store.segment('group:all', { namespace: 'tenant:globex' }).count();

const { destroyed } = await eraseNamespace('tenant:globex', { registry: backend.registry }, { confirmNamespace: 'tenant:globex' });
console.log(before, destroyed.map((r) => [r.segment, r.destroyed, r.cryptoShredded]));

now += 3_000; // the checker's refresh passes
console.log(await checker.segment('group:all', { namespace: 'tenant:globex' }).count());
```

Output:

<!-- output -->
```text
2 [ [ 'group:all', true, true ] ]
0
```

`backend.registry` is the registry half of the backend the store was built on: with a real driver, pass the `registry` of the
`S3Storage` (or the GCS or Azure Blob backend) you gave the store, as [the encryption
guide](../guide/encryption.md#erase-a-segment-or-a-namespace-crypto-shred) shows. All tenants here share one keystore and one
key id: the shred removes each segment's wrapped key from its registry row, never the master key.

The call takes the namespace's name as a confirmation, shreds eight segments at a time and reports one result per segment:
a segment with `destroyed: false` still holds data and needs a look. A store that already had the segment open keeps
decrypting until its refresh passes, within `cache.genTtlMs`; [the encryption guide](../guide/encryption.md#erase-a-segment-or-a-namespace-crypto-shred)
has the rest, including what a retained backup of the registry still holds.

## What goes wrong

<!-- typecheck -->
```ts
import { errorKind } from '@cloudbitmaps/roaring';

// A store with no keystore meets a sealed segment.
const bare = new CloudRoaring({ storage: backend });
try {
  await bare.segment('doc:1001', { namespace: 'tenant:acme' }).has(7001);
} catch (error) {
  console.log(errorKind(error));
}

// A typo in a resource name: a direct read is empty, so the check answers "no", and a combine refuses.
console.log(await canView('acme', 9999, 7001), await store.exists({ namespace: 'tenant:acme', segment: 'doc:9999' }));
```

Output:

<!-- output -->
```text
KeyUnavailableError
false false
```

| You see | What to do |
|---|---|
| `KeyUnavailableError` | The segment is sealed and this store has no keystore, or its keystore lacks the key. Wire the keystore the segments were written with, and keep every key that wrapped a live segment when you rotate. A segment that was shredded on purpose does not raise this: it reads as empty. |
| `has` answering `false` for every user of a resource | The segment does not exist, was never loaded, or its tenant was shredded. Check `store.exists(ref)` where a missing resource should be an alert, not a denial. Denying is the safe default for a check; know that it is the default. |
| `ValidationError` | The id is not an integer from 0 to 4,294,967,295, or an option is wrong. Fix the call; it is raised before any read. Map identifiers to a 32-bit integer before the call. |
| `published: false` with `reason: 'superseded'` from a load, `WriteConflictError` | Another writer got to the list first, or an erasure ran. Re-derive the list and load again. |
| `TransientError`, `BudgetExceededError` on `subjectReport` or `eraseSubject` | A fault after the store's retries, or a scan past its request budget. Run the call again: an erasure is safe to repeat, and its ledger says what each pass did. [The errors table](../guide/api-reference.md#errors-typed--you-catch-these) has each. |

## Limits

- **A revoke is not instant.** A reader that is not the writer sees a load within `cache.genTtlMs` (2000 ms by default;
  `0` turns the refresh off, which leaves no bound at all for another process's loads). A running read can serve what it
  had already taken, within the bound in [who stops seeing an id, and
  when](../guide/erasure.md#who-stops-seeing-the-id-and-when), and a pin or a lease in another store has none until it
  ends. [How soon a reader sees a new load](../guide/reading.md#how-soon-a-reader-sees-a-new-load) is where the refresh is
  stated.
- **Not a policy engine.** A set says who is in it. Roles, inheritance, deny rules and conditions are computed upstream
  and loaded as sets, as the group union above was; the library evaluates none of them.
- **A namespace is a name, not a wall.** Any store with the bucket's credentials, and for sealed segments the keystore's
  key, reads every namespace it is pointed at; one keystore here covers every tenant. A tenant that must
  be isolated needs a prefix or a bucket and credentials of its own. Multi-tenant isolation is outside the validated
  envelope, which is single-tenant and single-region on S3 and up to about 100,000 segments, so a design with one segment
  per resource per tenant has to stay under that count: [what is proven and what is not](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt).
- **Each composed list is a copy.** An id in a resource's composed list stays there until the list is rebuilt or the id is
  erased; derive lists from the sources on a schedule, and use `eraseSubject` for a removal that cannot wait.
- **Shredding is per segment and per key.** A retained copy of the registry (a backup, a noncurrent object version) still
  holds the wrapped key until your storage expires it ([disaster recovery](../guide/disaster-recovery.md#encryption--dr)).
- **This page ran on `MemoryStorage`**, so it says nothing about latency or cost; see [the benchmarks](../benchmarks.md).
