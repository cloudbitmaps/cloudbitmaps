# Subject access and erasure

GDPR access and erasure.

## Subject access & erasure (GDPR Art. 15 / 17)

Two admin helpers answer "what do you hold about this person?" and "forget this person everywhere." Both scan
the **registered** segments (no reverse index — nothing taxes the hot path), so they're complete over what's
registered — every loaded segment has a row, so build the store on the backend the loads used — and cost
`O(registered segments)` per call for `subjectReport`. `eraseSubject` costs more: a segment whose current
generation lacks the id is searched generation by generation, one open for each other generation in its bucket, so
it is `O(registered segments + superseded generations)`, and a fleet that keeps long histories pays for every one
(the per-op budget is charged for them). The scan fans out at a **bounded `concurrency`** (default 8; pass `{ concurrency }`) —
parallel enough to stay quick over a large fleet, bounded so it can't stampede your backend; `eraseSubject`
isolates a per-segment fault so one bad segment never aborts the ledger.

**Scope is explicit.** Ids live in one **global u32 space shared across namespaces**, so a namespace-less call is
a *fleet-wide* sweep over every tenant. To keep that from being the accidental default, both helpers require
either a `namespace` (scope to one tenant) **or** an explicit `{ allNamespaces: true }` acknowledgement — a call
with neither throws `ValidationError`.

```ts
// Art. 15 — which segments is this id in? (scope to one tenant)
const report = await store.subjectReport(userId, { namespace: 'eu' });
report.segments; // [{ segment, namespace }, …]   report.scannedSegments — the completeness denominator

// Art. 17 — remove the id everywhere, across all tenants (explicit fleet-wide ack)
const audit = new RecordingAuditSink(); // from '@cloudbitmaps/roaring' — see the audit trail
const ledger = await store.eraseSubject(userId, { allNamespaces: true, audit });
ledger.erasedFrom; // [{ segment, namespace, erased: true, fromGeneration: 4, generation: 5 }, …]
```

**An erasure is a rewrite.** There is no per-id delete on an immutable object and no mutable tier to hold a
tombstone, so `eraseSubject` does what every other write in the library does: for each registered segment the id
is a member of, it streams the current generation through — every chunk decoded and re-encoded, the one holding
the id with that bit cleared — verifies the new object, publishes it **fenced on the generation it streamed**, and then **deletes the
generation that held the bit** (a collection with `keep: 0`). The bit is physically gone from the
bucket when the call returns, constant memory, one chunk in flight. Segments the id is not in are not listed.

**Every generation that holds the id goes, not only the current one.** A re-seed that drops someone leaves their
bit in the generation `keep` retains, and a `store.rollback` leaves the generations it rolled back from *above*
the pointer, where a later rollback can make them current again. So the call searches every generation in the
segment's bucket: a holder below the pointer goes with the `keep: 0` collection, each holder above it is deleted
one by one, and a generation up there that never held the id stays as a rollback target when the current
generation does not hold the id (a rewrite is numbered above everything, so its `keep: 0` collection takes every
older generation, above the pointer or below). An entry says
`erased: true` only once the call has listed the bucket and read what is left: **no generation of the segment
holds the id**, above the pointer or below it. When the current generation does not hold the id, nothing is
rewritten, so the entry carries no `generation` and no `segment.rewrite` event is emitted.

Both helpers **reuse the store's own drivers** — no `registry`/deps to re-pass. `eraseSubject` needs the store
built with a **backend** (it writes generations); `subjectReport` needs one too, for the registry it
enumerates before it calls `has()`. A store missing what a helper needs throws `UnsupportedError` — a
pre-built-`StorageChunkSource` store can't run `eraseSubject`; build the store on a backend class instead
(`MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or `AzureBlobStorage`). The returned `erasedFrom` list is your **erasure ledger**
(proof of deletion) — a return value only, so persist it or route it to your audit sink (a `segment.rewrite` event
is also emitted per rewrite when you pass `audit`).

**An `erased: false` entry means this run did not erase the id from that segment** — which is not the same as
"the id is still there" — and `note` says why:

- `'superseded'` — another writer moved the pointer off the generation the rewrite was derived from, so the
  rewrite is not a valid successor to what is now current. That writer is usually a load; it can also be
  **another erasure**, which collects with `keep: 0` and so can delete the generation this rewrite was still
  streaming, or the object it had just written — or an operator's `rollback`, landing while the call was deleting
  generations above the pointer. Two erasures of different ids racing on one segment are safe: the loser's
  rewrite still holds the winner's id, and when it sits above the winner's pointer the loser deletes it before
  returning. Re-run against the new generation: it erases the id if the id
  is still present, and lists nothing for the segment if the racing writer was an erasure of the same id that
  already removed it. The outcome is read off the registry row, so a segment whose row is tombstoned or purged
  mid-rewrite is left out of the ledger, as a fresh call would leave it out — you never have to care at which
  point it was discovered.
- `` `error: <message>` `` — an isolated per-segment fault. Causes worth telling apart: a transient storage
  fault (re-run), the call's `budget` running out before the segment's generations were all searched (re-run with a
  higher `budget`), a missing keystore for an encrypted segment (wire it), an `IntegrityError` naming a chunk
  whose values are out of range — that segment is **corrupt**, the rewrite refused to copy the corruption into a
  new generation, and no erasure happened on it, so it needs investigating rather than re-running — and a
  `WriteConflictError`, which means the erasure could not remove a generation holding the id and refused to
  claim it had. Usually that follows a rewrite that already **published**, so part of the work landed — a
  rollback onto a generation that still holds the id, landing while the rewrite collects, is one way — but it
  also fires on the collect-only path, where the bit is taken out of generations other than the current one and
  nothing is published at all. Either way, see what a re-run reports rather than assuming it finished the job.

Re-running is safe and idempotent: a segment the id is no longer in is simply not listed — but "not listed" is
not by itself proof the id is gone, because a segment whose **registry row** has been purged is not scanned
either, and its objects outlive it as orphans. `store.generations(ref)` lists those, since it reads the bucket
whether or not a row exists, and `store.dropSegment(ref, { confirmSegment })` deletes them, writing a `destroyed`
row first as it always does, which then fences the name. `store.checkConsistency()` and the collection a load
runs start from the rows, so neither reaches them. **One contract the
library cannot check: do not load the segment while erasing from it.** A load that lands *after* the rewrite
carries whatever its source held, and the library cannot know that source was meant to exclude the id — quiesce
loads of the affected segments for the duration, or fix the source first and load after. A writer that lands
*during* the rewrite is caught and reported as a reason rather than an error (`'superseded'` for a load or a
racing erasure).

**Do not roll the segment back while erasing from it.** A rollback that lands mid-erasure can move the pointer onto
a generation the erasure did not rewrite. What the call reports depends on where it lands. Before the publish, the
entry says `'superseded'`. After it, while the call collects, the generation it replaced can be left above the
lowered pointer, or be the one the pointer now names: a generation that still holds the id stays in the bucket, and
the call reports an `error: …` note instead of `erased: true`. When the id was not in the current generation and
nothing was published, a rollback while the call deletes generations above the pointer is reported as
`'superseded'` if a holder is left, and one while it collects is an `error: …` note. In the last instant before a
delete, a rollback onto the generation being deleted leaves the pointer on a missing object, which
`checkConsistency()` reports. Re-run any of these once the pointer is where you want it. Roll back before the
erasure starts or after it returns.

**Who stops seeing the id, and when.** The erasure is immediate in storage and immediate in the store that
performed it — that store drops what it had cached about the segment before returning, so it cannot keep
answering from memory. Every other store is a different question, in this process or another, and this library
ships nothing that could answer it for you: there is no daemon, no bus, and no connection between two stores that
happen to point at the same bucket.

| | when the id stops being readable |
|---|---|
| storage | on return — the generation holding it is deleted |
| the store that performed the erasure | on return, and its pins then fail |
| another store, with a registry and a `cache.genTtlMs` above 0 | within `cache.genTtlMs` (default 2 s), while the registry can be read: a transient fault in reading it keeps the store serving what it holds and retries 500 ms later |
| a pinned handle (`seg.pin()`) in another store | **no bound** — until that store's reader cache evicts the pin's reader and its chunk cache evicts the chunks the pin decoded, or `store.invalidate(ref)` is called there |
| another store with **no registry** (a bare `IStorageDriver`), with `cache: { genTtlMs: 0 }`, or on a storage source built with **no clock** | **no bound** — only when its caches happen to let the segment go, or something tells it |

A refresh that fails with anything but a transient fault (an access denial, a row that will not parse) does not
keep serving: the read that meets it throws, and the reader is dropped with the key it unwrapped.

`cache: { genTtlMs: 0 }` turns the timed refresh off, and is a reasonable setting for a read-only replica of
immutable data — but a store set that way has no bound on when it observes an erasure or a crypto-shred. `store.invalidate(ref)` is the hook;
fanning the reference out to your fleet is yours, because the transport is yours. The same applies to
`destroySegment` and `eraseNamespace`, which are free functions over raw drivers and invalidate no store: every
store beside them, in the same process or not, is one of the other stores in the table above, and keeps the
**unwrapped** key for as long as that table's row for it says.

**What a rewrite does not reach.** Backups, replicas and noncurrent object versions hold the old object until
their own lifecycle removes it. For an at-rest guarantee that survives those, encrypt and crypto-shred
(`destroySegment` / `eraseNamespace`, see encryption) — which is per segment: a per-**id** shred is infeasible because one DEK
covers the whole segment. See [`PRIVACY.md`](../../PRIVACY.md).
