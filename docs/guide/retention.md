# Retention

How to expire and delete data: what exists, and what does not.

## Retention, TTL and pruning — what exists and what doesn't

**Retention is per segment, and there is no per-id TTL.**

- **A segment can expire.** `store.setRetention(ref, { expiresAt })` records when it becomes eligible for retirement,
  and `store.retireExpired()` is the sweep that acts on it. Both are below.
- **An individual id cannot.** There is no `expireAfter` and no per-id age. That follows from the data model, not from
  a missing feature: a bitmap stores ids, not `(id, timestamp)` pairs. [Why not](#there-is-no-per-id-ttl) is below.
- **You schedule the sweep.** The policy is configuration; the heartbeat is yours, because this library starts no
  background timer. It has to behave the same in a Lambda, an edge isolate and a long-lived server.

If you arrived here asking "does it support TTL?": for a segment, yes; for an id, no, by design.

**The usual setup is two calls.** Record an expiry when you create each segment, and run the sweep on a schedule:

```ts
// Your values: today's date as the segment name, and the ids seen today.
declare const today: string;
declare const idsSeenToday: Iterable<number>;

const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: today };
await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // once, when you first record the segment
await store.load(ref, idsSeenToday);

// Elsewhere, on a schedule (once a day is enough for daily segments):
const swept = await store.retireExpired({ namespace: 'active-daily' });
```

The rest of this page explains each call, then the manual alternative (`dropSegment`), then why there is no per-id TTL.

## Record when a segment expires: `store.setRetention`

The loop in [retire a segment by hand](#retire-a-segment-by-hand-storedropsegment) works, and it hard-codes your
retention rule in the sweeper: whoever writes the sweep has to know that `active-daily` keeps 30 days and
`dedup-wave` keeps 3. **`store.setRetention` moves that decision to the writer**, who is the only one who knows what
the segment means:

```ts
// Your values: today is the segment name for this run, idsSeenToday yields the ids to load.
declare const today: string;
declare const idsSeenToday: Iterable<number>;

const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: today };

await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // before or after the load: either works
await store.load(ref, idsSeenToday);
```

That is one registry write, and nothing else happens. Nothing is deleted and no timer starts. Call it once, when you first
record the segment, not on every load. It is idempotent, so re-running is harmless, but it is a write.

- **`expiresAt` is an absolute instant in epoch milliseconds**, which you compute. A duration would have to be measured
  from something, and every anchor the library could use is wrong. `updatedAt` and `currentGen` are rewritten by every
  load, so "expire 30 days after the last write" would push a daily-reloaded segment's expiry forward on every refresh.
  The segment would stay alive because it is being kept fresh. The library stores your instant verbatim and never
  moves it.
- **A value that looks like epoch seconds is rejected.** `Date.now() / 1000 + 30 * 86400` is a natural thing to type
  and lands in 1970, already expired. Without the check it would not be an error, it would be a deletion on the next
  sweep.
- **A past instant is legal** and means "eligible on the next sweep". Backfilling a policy onto segments that already
  exist is a normal migration.
- **A crypto-shredded segment is refused**, and the result's `indexed` says whether the due-index pointer was written.
  `indexed: false` is a degradation, not a failure: the fleet scan still retires the segment. The seconds check is a
  floor, `MIN_EXPIRES_AT_MS`.
- **It works before the first load.** A segment with no registry row yet gets one (the result says
  `createdRow: true`) with no storage generation (`currentGen: null`). The policy is recorded ahead of the data, the
  sweep can already see the segment, and the first load publishes onto that row. Reads are unaffected: a pointer-less
  row resolves exactly like a segment with no row.

Reading and cancelling:

```ts
const ref = { namespace: 'active-daily', segment: '2026-08-05' };
await store.getRetention(ref); // → { expiresAt } | null | 'invalid'
await store.clearRetention(ref); // → true if a policy was actually removed
```

`getRetention` returns the string `'invalid'` for a row whose `expiresAt` is present but unusable, such as a
hand-edited one. That is deliberately not folded into `null`: a malformed policy reading as "never expires" on a
segment someone believes is expiring is the kind of silence that costs a compliance commitment. Cancelling is its own
verb, because "never expire" passed into the setter as a magic value is how a typo becomes a deletion.

### A deadline on a set

A handle carries no deadline of its own (`expiresAt` among `store.segment`'s options throws
`ValidationError`). For a set that must stop being served after a deadline, use one of two shapes:

- **Durable, for every reader:** record it with `setRetention` (above) and run `retireExpired` on a schedule. The sweep
  drops the segment once the instant passes, so every process stops reading it and its bytes are reclaimed.
- **One reader's cut-off:** check the deadline where you read, against the same clock you would hand the store:

  ```ts
  const deadline = Date.parse('2026-12-31T18:00:00Z');
  const promo = store.segment('promo');
  const served = Date.now() < deadline ? await promo.has(id) : false;
  ```

  Keep the check beside an exclusion too: an opt-out list that should stop applying is a decision to make where it
  is used, not a list that quietly reads as empty.

## Run the sweep: `store.retireExpired()`

A policy is inert until something acts on it. `retireExpired` lists the registry, selects the segments whose
`expiresAt` has passed, and retires each one **through `dropSegment`**. The registry-then-storage order, the re-sweep
for an object a load was still writing, and the `generationsRemaining` report all come from one implementation.

```ts
const swept = await store.retireExpired({ namespace: 'active-daily' });
// → { scanned, eligible, retired, wouldRetire, tombstonesPurged, limited, purgeFaults, firstPurgeFault?, dryRun, entries }
```

A bad argument throws `ValidationError`. A per-segment fault is an `entries` row, never a throw.

**It is a call, not a daemon.** Nothing in this library schedules itself, and that is deliberate: the same code has
to behave identically in a Lambda, an edge isolate and a long-lived server, and a timer that only works in one of
those is worse than none. **You own the heartbeat.** Any of these is a correct answer:

| Where you already run things | How to run the sweep |
|---|---|
| **AWS Lambda** | an EventBridge (CloudWatch Events) schedule, calling a handler that builds the store and runs `retireExpired` |
| **Kubernetes** | a `CronJob` |
| **ECS / Fargate** | a scheduled task |
| **A plain VM / container** | `cron` calling a one-shot script |
| **A job queue you already have** | a recurring job; the one that runs your loads is a natural home |

> ⚠️ **Run the sweep from one process, or shard it.** N replicas each running the full sweep would contend over the
> same segments. Either call `retireExpired` from a job that runs once (a `CronJob`), or give each replica a
> disjoint slice with `shards` and `totalShards`. The slice is a stable hash of the segment key, so a worker owns the
> same slice across restarts.

**Once a day is enough** for daily segments: retention windows are measured in days, so an hourly sweep just re-scans
the same registry 24 times. Match the cadence to the granularity of your policies, not to how fast you want the
deletion to feel.

- A fleet scan is a billed `LIST` over the registry prefix. The default `'fleet'` scan costs what the fleet holds: its
  live segments, and the retired ones still inside their grace (see [what the purge removes](#how-it-stays-correct)).
- `scan: 'index'` reads only the due days of the due index and costs what is expiring, and what is due to be purged.
- The index is a fast path, not the source of truth. Each candidate's live row is re-read before anything is decided,
  and a policy whose pointer write failed has no index entry. So run the `'fleet'` scan periodically as the repair
  pass. `lookbackBuckets` (default 7) is how many past days a fast scan also reads, so a sweep that did not run leaves
  nothing stranded.

**Start with `dryRun`.** `dropSegment`'s `confirmSegment` guard protects nothing in a loop, because it is the same
variable twice, so the sweep-level preview is the real safety net. A retention bug you can read in a log is worth more
than one you find in a bucket:

```ts
const preview = await store.retireExpired({ namespace: 'active-daily', dryRun: true });
// `wouldRetire`, not `retired`: `retired` counts actual deletions and is 0 in a dry run, deliberately, so a
// dashboard summing it can never report phantom deletions.
console.log(`would retire ${preview.wouldRetire} of ${preview.scanned} scanned`);
```

**Read the ledger.** A per-segment fault is an entry, never an exception. A throw from the middle of a fleet sweep
would leave you unable to say which segments were retired, having already retired some:

```ts
// Your function: schedule another run of the sweep soon.
declare function scheduleAnotherPassSoon(): void;

const swept = await store.retireExpired({ namespace: 'active-daily' });
for (const e of swept.entries) {
  if (e.action === 'skipped') console.warn(`${e.segment}: ${e.reason}`);
  if (e.action === 'retired' && e.result.generationsRemaining.length > 0) {
    console.warn(`${e.segment}: storage not fully reclaimed, re-run`);
  }
}
if (swept.limited) scheduleAnotherPassSoon(); // more are still eligible
if (swept.purgeFaults > 0) console.error(`the registry refused ${swept.purgeFaults} delete(s): ${swept.firstPurgeFault}`);
```

**Check `purgeFaults`: a delete the registry refuses holds nothing else up, and says so only there.** A purge or a pointer
removal that fails for a reason other than a lost race (a policy that denies `s3:DeleteObject`, an Azure blob with a
snapshot, any raw provider error) leaves its row or pointer in place and is counted in `purgeFaults`, with the first
one's reason in `firstPurgeFault`. A refused purge is `skipped` in the ledger, with the provider's message, and is not
charged to `limit`, and the sweep goes on to retire what is eligible, so a tombstone that cannot be purged never holds
the segments behind it past their expiry. **Purging stops for the rest of the call after three refused purges in a
row**, and a purge that succeeds starts the count again. A blanket refusal (a policy that denies delete) costs three
attempts a call and no more. A refusal particular to one row (one blob with a snapshot, one object under a legal hold)
holds nothing behind it: the purges after it still go through, and the row is counted every call until it is cleared.
The next call tries again. A lost race (`failed: contended`) is not a fault: it is the fence working,
it is charged to `limit` as before, and the purges go on.

**Two bounds to set deliberately.**

- `limit` (default 100). Retirements are sequential, with several round trips each, so the default is comfortably
  inside a Lambda. `limit` is a time knob as much as a safety one. Raising it by orders of magnitude after a backlog
  will time out mid-sweep, harmlessly: re-run.
- `maxScanSegments` (default 250,000) caps how many registry rows one sweep holds resident. Past it the call throws
  `BudgetExceededError` instead of half-sweeping, because a scan that cannot fit is not a partial result to be mistaken
  for a complete one. Narrow with `namespace` before raising it.

**Every `skipped` reason is worth an alert, for a different reason:**

- **`invalid-policy`**: the row's `expiresAt` cannot be used. That segment is not expiring, and someone probably
  believes it is.
- **`limit`**: eligible, but this cycle's cap was spent, and `limited: true` says the same at the top level. That cap
  is what stands between a bad `expiresAt` backfill (or clock skew) and a retired fleet, so it defers instead of
  dropping: re-run to continue. The cap is charged on attempts, not successes, so a partial storage outage cannot march
  through the fleet with the cap never engaging.
- **`policy-changed`**: the live row no longer says "expired": a `clearRetention`, a new `expiresAt`, or someone else's
  drop landed between the listing and this segment's turn. This is not an error. The sweep re-reads the authoritative
  row immediately before every deletion, precisely so cancelling an expiry works on a sweep that is already running.
- **`tombstone-not-empty`**: see [Tombstones are purged, narrowly](#how-it-stays-correct).
- **`failed: ...`**: that one segment's retirement threw, or, on a tombstone, its purge did, and a purge the registry
  refuses is also counted in `purgeFaults` (above). `dropSegment` writes the tombstone before the storage sweep,
  deliberately, so a fault there leaks bytes, not correctness. A fault after the tombstone landed is reported as
  `retired` with a `fault`, because that segment really is retired. Re-running collects the bytes.

## Retire a segment by hand: `store.dropSegment`

**`store.dropSegment` is the one you want for a one-off**, and `retireExpired` calls it for you once you have recorded
a policy. Four levers exist, and they answer different questions:

| | what it does | when |
|---|---|---|
| **`store.retireExpired({ … })`** | lists the registry and retires every segment whose recorded `expiresAt` has passed, **through `dropSegment`**. Bounded, previewable, returns a per-segment ledger. You schedule it | **a policy-driven rolling window**: the usual answer, [above](#run-the-sweep-storeretireexpired) |
| **`store.dropSegment(ref, { confirmSegment })`** | tombstones the segment, then deletes its storage generations (re-swept, with any residual reported in `generationsRemaining`). Works on a cleartext segment; on an encrypted one it also discards the key, so it is a strict superset there. Afterwards the segment **reads as empty** | **retiring a bucket and reclaiming the storage** |
| `destroySegment(ref, { registry }, { confirmSegment })` | **crypto-shred**: discards the key so the storage bytes are unreadable everywhere, backups and WORM included, but leaves the objects in your bucket, still billed. **Requires encryption**: a cleartext segment has no key to shred, and the call leaves it as it is and returns `reason: 'cleartext'` | erasure that must reach immutable copies |
| `store.load(ref, ids, { keep })`, or an `*Into` given `keep` | the write's own collection: deletes only **superseded** generations, keeping `keep` as a reader grace window | reclaiming what loads leave behind ([generations and `keep`](loading.md#generations-and-keep)), not live data |

Deleting an object does not reach a noncurrent version, a cross-region replica, or a point-in-time snapshot. Discarding
the key does. So if your requirement is "the data must become unreadable" rather than "stop paying for it",
[encryption at rest](encryption.md) is a prerequisite, and `dropSegment` on an encrypted segment gives you both at
once.

`store.dropSegment` needs a store built on a **backend**, because it has to list and delete generations, which a
pre-built `StorageChunkSource` cannot do, and to update the registry row, which a bare `IStorageDriver` lacks. Without one you get an `UnsupportedError`.

```ts
// Your value: the name of the daily segment you want to retire.
declare const oldDay: string;

// The namespace is part of the identity. Omit it and you address a DIFFERENT segment, and the call is a
// silent no-op returning { dropped: false, reason: 'absent' }, with no throw. Check `reason` in a sweep.
const ref = { namespace: 'active-daily', segment: oldDay };

// Look before you leap: reports the generations it WOULD delete, changes nothing.
const preview = await store.dropSegment(ref, { confirmSegment: ref.segment, dryRun: true });
// `wouldDelete` is unbounded: it lists every generation still in storage, and a segment written daily by an `*Into`
// that is never given `keep` accumulates them. Log the count and a sample, not the whole array.
const gens = preview.wouldDelete ?? [];
console.log(`would delete ${gens.length} generation(s): ${gens.slice(0, 10).join(', ')}${gens.length > 10 ? ' …' : ''}`);

// Then do it.
const result = await store.dropSegment(ref, { confirmSegment: ref.segment });
// → { dropped: true, generationsDeleted: [0, 1], generationsRemaining: [], cryptoShredded: false }
```

**Reading the result.** Branch on `dropped`, and use `reason` to understand how:

| `dropped` | `reason` | Meaning |
|---|---|---|
| `true` | `undefined` | An ordinary drop: tombstone written, storage generations swept |
| `true` | `'already'` | Already tombstoned. **Not** a no-op: it re-sweeps storage, so it is how a residual in `generationsRemaining` is collected |
| `true` | any | On an encrypted segment the result also says `cryptoShredded: true`, because the drop discards the key. `dryRun` previews `wouldDelete` and `wouldCryptoShred` without touching anything |
| `false` | `'absent'` | **Nothing existed**: no row and no objects. The one case to alert on, usually a mistyped name or an omitted `namespace`, both of which address a different segment than you meant |

A whole retention job by hand is a loop. If the cutoff is a property of the segment rather than of your code,
[`setRetention` and `retireExpired`](#record-when-a-segment-expires-storesetretention) are this loop with the decision
moved to the writer and the bounds, preview and ledger already built:

```ts
// Your value: ISO dates before this one are retired.
declare const cutoffDay: string;

// Names first, drops after: a drop writes the row, and a paged listing may or may not see its own writes.
const old: string[] = [];
for await (const s of store.segments({ namespace: 'active-daily' })) {
  if (s.status === 'active' && s.segment < cutoffDay) old.push(s.segment); // ISO dates sort lexicographically
}
for (const segment of old) {
  const ref = { namespace: 'active-daily', segment };
  const res = await store.dropSegment(ref, { confirmSegment: ref.segment });
  // Non-empty means bytes survived: a load that had read the segment before the tombstone landed finished its
  // object. The segment reads as empty either way, so this is a billing leak, not a correctness one; re-run the
  // drop to collect it. The retention sweep will not: it purges only the tombstones it wrote itself.
  if (res.generationsRemaining.length > 0) {
    console.warn(`${ref.segment}: ${res.generationsRemaining.length} generation(s) not reclaimed`);
  }
}
```

**`confirmSegment` is a typo guard, not an authorization.** In the loop the same value appears twice, so it protects
nothing. That is what `dryRun` is for: run with `dryRun: true` first and log what would be taken.

Two limits to know before you automate it:

- **A drop is final for the name.** The tombstone fences every later load of that segment (refused with
  `ValidationError`), which is what makes the storage sweep converge. To reuse a name, use a fresh dated name, which
  is the pattern anyway, or retire the segment through `retireExpired`, which purges the tombstones it wrote itself
  once their grace period has passed and their storage is empty, and on a registry with a conditional delete removes
  them for good. A tombstone a hand-run `dropSegment` wrote is never
  purged by the library; the
  [disaster-recovery runbook](disaster-recovery.md#repair-an-unstamped-tombstone-after-a-hard-kill) shows how to
  delete such a row by hand once its storage is empty.
- **"Reads as empty" depends on a timed refresh.** See [how soon a reader sees a change](reading.md#how-soon-a-reader-sees-a-new-load).
  A reader with no timed refresh (no registry, or `cache: { genTtlMs: 0 }`) notices the drop only when a read has to
  fetch from a deleted generation or its reader cache evicts the segment. It can answer `true` from its cache for a
  dropped segment indefinitely: call `store.invalidate(ref)` on it, or restart it. Such a reader keeps no chunk bytes of
  a small generation, so a sweep is never hidden from it; a store with a timed refresh does serve a small generation's
  chunks from memory, and notices a drop within `cache.genTtlMs`.

> ⚠️ **The tempting shortcut breaks reads: an object-store lifecycle rule alone.** It deletes the bytes while the
> registry still points at them. That is exactly the state [`checkConsistency()`](disaster-recovery.md) reports as
> **`missing-storage-generation`**, the torn-restore failure the disaster-recovery guide says not to serve traffic on.
>
> **And it presents intermittently.** A read checks the cache before storage, so cached chunks answer correctly while
> uncached or evicted ones raise `NotFoundError`. It passes a warm-process test and starts failing after a restart or a
> deploy, looking like a transient cloud fault rather than a misconfiguration.
>
> A lifecycle rule is still a fine backstop for orphans left by a failed `dropSegment`. Set its expiry window
> comfortably longer than your retention window, so it can never get there first.

## Remove the deleted rows a release before 0.12 left

A release before 0.12 never removed a row it deleted. It kept a `{ deleted: true }` envelope, its token a bare counter
with no incarnation id, and a 0.12 or later release does the same when it deletes a row that was born before 0.12. No
call of this release removes one: `retireExpired` and `dropSegment` leave it as they found it, and every full listing of
the registry still reads it, one GET apiece, though no read of a segment ever returns it. A segment name that was
personal data also survives in it, in the row's record. Only a bucket a release before 0.12 wrote holds such rows.

To remove them, run the reaper the 0.18 releases ship, once, from a scratch directory, after the last process on a
release before 0.12 is gone:

```sh
mkdir reap && cd reap && npm init -y && npm install @cloudbitmaps/roaring@0.18 @cloudbitmaps/s3@0.18
```

```js
// reap.mjs: count first, then remove; `limit` (default 1,000) bounds each run, so run until it is not limited
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'my-bucket' }) });
const preview = await store.reapRegistryTombstones({ dryRun: true });
console.log(`would remove ${preview.wouldReap} of ${preview.examined} rows read`, preview.skipped);
let done;
do done = await store.reapRegistryTombstones({ confirmNoLegacyWriters: true });
while (done.limited);
```

Use the driver package of your storage (`@cloudbitmaps/gcs`, `@cloudbitmaps/azure-blob`) in place of S3.

- **What it removes:** a row that is `deleted: true` and whose token has no incarnation id, and nothing else. It never
  touches a live row, a `destroyed` row that is not `deleted` (the attestation of an erasure), a deleted row a 0.12 or
  later release wrote, or a generation, so it does not clean a bucket completely.
- **Every removal is fenced:** each delete is conditioned on the version it read, so a `create` that writes over the
  envelope first wins and the row is counted as `raced`. Where the registry cannot delete under that condition (GCS by
  default, S3 on a custom endpoint) it refuses before its first request, a dry run included.
- **`confirmNoLegacyWriters: true` is your statement** that no process on a release before 0.12 writes the registry. One
  that did, re-creating a removed name, would issue the removed row's tokens again.
- **A run is not resumable:** each lists and reads from the start, so a run costs a listing and one GET per row, plus a
  DELETE per removal.

## There is no per-id TTL

A bitmap stores ids, not `(id, timestamp)` pairs. Expiring individual ids means keeping a timestamp per id, 4 to 8
bytes each, which destroys the compression the whole design exists for. A contiguous range of a million ids is a few
bytes as a Roaring run; the same million with per-id timestamps is megabytes, and worse than a plain list. So per-id
aging is not deferred work. It is incompatible with the data model.

### The pattern that gives you the same outcome

Put time in the name instead of in the data, and let set algebra do the window. Use a **namespace per family and the
date as the segment**, not one long name, and load one segment per day:

```ts
// Your values: today's date as a string, the last seven dates, and the ids seen today.
declare const today: string;
declare const last7Days: string[];
declare const idsSeenToday: Iterable<number>;

const daily = (day: string) => store.segment(day, { namespace: 'active-daily' });

// Load today's segment: a generation, from wherever today's ids come from.
const ref = { namespace: 'active-daily', segment: today };
await store.load(ref, idsSeenToday);

// "Active in the last 7 days" is a union over the daily segments you still keep. A day whose segment was never loaded (a
// job that did not run) names no segment, which a combine refuses; `allowAbsentOperands` reads it as empty instead.
// Leave it out to be told.
const days = last7Days.map(daily);
for await (const id of days[0]!.union(days.slice(1), { allowAbsentOperands: true })) {
  /* ... */
}

// Retention is dropping whole daily segments, not aging bits.
```

`union` reads every chunk of every operand and cannot skip. If a 7-way union per read is too much, materialize the
window with `unionInto`, into a dated target or into one rolling target. Either is correct, because an `*Into` verb
supersedes its destination rather than adding to it, so a rolling `active-7d` re-materialized each day holds exactly
that day's window:

```ts
// last7Days and daily are as in the example above.
declare const last7Days: string[];
declare const daily: (day: string) => ReturnType<typeof store.segment>;

const window = store.segment('active-7d', { namespace: 'windows' });
const days = last7Days.map(daily);
// window's previous generation is superseded, not merged into
await days[0]!.unionInto(window, days.slice(1), { allowAbsentOperands: true });
```

Loading a segment a day is the natural shape for a "seen this period" set: today's segment is a different, empty set
until you load it, and the union is your window. A genuine rolling window, such as "seen in the last 4 hours",
exactly, is a shorter period's segment loaded more often. There is no per-id write to age individual ids out with.

**A name is any non-empty string.** `dedup:2026-08-01`, `orders/2026`, `user@example.com`, `日本語` and `100%` are all
legal. There is no character allowlist, because each storage layer escapes what it cannot take literally, which is the
library's problem rather than yours. The refusals are:

- an empty name;
- a name that is too long: the limit is 256 characters once encoded, measured on the longer of the object-key form and
  the filesystem-path form. Letters, digits, `.`, `_` and `-` are kept as they are (a leading `_` excepted), so a name
  of those gets all 256. Every other character, ASCII included (a space, `/`, `@`, `%`), is escaped to three characters
  per byte, and so is `:`, which a filesystem path escapes though an object key does not. One emoji is twelve encoded
  characters, so such names reach the limit sooner;
- a namespace that starts with `cbm.due.`, which the library keeps its own bookkeeping rows in.

**The prefix `cbm.due.` is reserved for namespaces.** The retention index stores one pointer row per expiring segment
in `cbm.due.<day>`, and every fleet-wide scan skips that namespace as bookkeeping, so a segment of yours there would be
invisible to an erasure, a consistency check, an export, `segments()` and a retention sweep. Every call that takes a
namespace, in a ref or as an option, throws `ValidationError` for one starting with `cbm.due.`. Only that exact prefix
is reserved: `cbm.dueX`, `cbm.due` and `cbmdue.eu` are ordinary namespaces, and so is any segment name, `cbm.due.x`
included.

The namespace split is still the better shape for a family: `store.segments({ namespace: 'active-daily' })` lists
exactly that family's daily segments, and `eraseNamespace` can retire the whole family at once. With one flat name, finding
"every daily segment" means string-matching.

## How it stays correct

**Why `dropSegment` does registry first, then storage.** Each position is load-bearing:

1. **Registry first.** After the tombstone, nothing resolves a generation, so no reader can reach for bytes about to
   disappear, and no writer can publish onto it: a load refuses a `destroyed` row, so a load racing the drop cannot
   resurrect the segment.
2. **Storage second, best-effort, and swept more than once.** Once the pointer is a tombstone, the segment reads as
   empty and is correct, so a failure part-way through leaks bytes, not correctness, and re-running collects the
   remainder. The sweep repeats (up to three passes) because a load that was already writing its object when the
   tombstone landed still finishes the write. Its publish is then refused, but the object survives and holds the
   complete set. **Check `generationsRemaining`**: non-empty means bytes are still there and the drop should be
   repeated, since a re-drop of a tombstone re-sweeps its storage. The retention sweep collects them only for a
   tombstone it wrote itself, through `retireExpired`; one a hand-run `dropSegment` wrote is left to you.

**Tombstones are purged, narrowly.** A retired segment leaves a `destroyed` row behind, and one dead row per retired
daily segment would accumulate forever. The sweep deletes those rows too, but only when all three of these hold,
because deleting the row is what makes the name writable again:

1. **The row carries the sweep's own retirement stamp.** This is a positive marker `retireExpired` writes on the
   tombstones it creates. It is not an inference from "destroyed plus an expired policy", which would be wrong, and
   dangerously so. A crypto-shred leaves `retention` untouched, so the ordinary ordering (set a 30-day policy, then a
   right-to-erasure request arrives mid-window and you call `destroySegment`) produces a GDPR tombstone that carries an
   expired policy. Deleting that row would destroy the local attestation for an Art. 17 execution and un-fence the
   name. A marker cannot be forged that way, so a `destroyed` row the sweep did not create is never touched.
2. **A grace period has passed since that stamp** (default 24 h). While the row exists every writer refuses the
   segment, and that is what stops an in-flight load from resurrecting it.
3. **Storage is provably empty for it.** If storage still holds a straggler generation, such as a load that was writing
   when the tombstone landed, the sweep collects it first, then purges. (The collection takes every generation of a
   destroyed row, and nothing else would ever run it for a tombstoned segment.) Only if storage still cannot be proven
   gone does the row stay, with `tombstone-not-empty`. Without the row the collection can no longer see the segment at
   all, and the objects would be billed forever. That reason also covers the case where the collection declined because
   the row changed under it. That is not a storage fault, and the next cycle simply retries.

**What the purge removes.** On a backend whose registry can delete a row only while it is unchanged, the purge removes
the row from the bucket for good (a removed row stays recoverable wherever the storage keeps a copy of it: with object
versioning on, until a noncurrent-version rule expires it, and with soft delete on, for its retention window: GCS, on by
default for a new bucket, 7 days; Azure Blob, where enabled. [`PRIVACY.md`](../../PRIVACY.md) says what a row holds), with a delete the store applies only to the version the sweep judged: S3
`DeleteObject` with `If-Match`, GCS with `ifGenerationMatch`, Azure Blob with `ifMatch`. The registry says which it is:
`backend.registry.capabilities().conditionalDelete`. It is on by default for S3 when the host the client resolves is an
AWS S3 host, for Azure Blob, and for the local-filesystem and in-memory backends. A full sweep then reads what is live and what is
inside its grace, not every name the namespace ever held: after 10,000 short-lived segments are created, retired and
purged, a sweep of that namespace makes one registry read, for the one segment still live.

Where the registry cannot, the purge leaves a small tombstone in the row's place, and every later full sweep reads it,
one request per row. That is the case:

- on an S3 client that sends to a host other than AWS S3 (MinIO, Ceph, R2), by default. Such a store may accept the
  precondition and ignore it, and MinIO does: there, a delete conditioned on a version that has moved on deletes
  anyway, and two sweepers and a re-create of the name could delete a live row. Set `conditionalDelete: true` on the
  backend only once you know your store applies it. The host is the one the SDK resolves, however the endpoint was set:
  a constructor `endpoint`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config file.
  An AWS regional, FIPS, dual-stack or VPC interface endpoint is an AWS S3 host, and AWS S3 applies the precondition
  there;
- on a GCS client, by default, the public endpoint included: whether real GCS applies `ifGenerationMatch` to a delete
  has not been verified by a run against the service, and fake-gcs-server accepts the precondition and ignores it, so
  CI cannot show it. Set `conditionalDelete: true` to remove rows for good;
- with `conditionalDelete: false` on any backend;
- for a row written by a release before 0.12, always. Its token is a bare counter, and a process still on that
  release, re-creating the name over nothing, would start the counter at 0 again and issue the deleted row's tokens,
  so its row could not be told apart from the deleted one. A row created by 0.12 carries a random incarnation id in
  its token, so a re-create is told apart from it, whatever is left of it, but for a collision of probability 2^-128
  per pair of incarnations. The legacy protection ends once a 0.12 process re-creates the name over the legacy
  tombstone: the new row has an incarnation, and when it is purged nothing keeps the legacy counter. It matters only for
  a 0.11 process that outlived the upgrade's stop-every-0.11-process step, which the upgrade does not support.

A `deleted: true` row already in the bucket stays: the purge never sees a row that is already deleted. To remove the ones
a release before 0.12 left, see [the recipe above](#remove-the-deleted-rows-a-release-before-012-left).

**An index scan purges too, where the registry removes rows.** Each retirement files a pointer in the due index under
the day its tombstone's grace ends, beside the expiry pointers, and `scan: 'index'` reads it with them, so a namespace
can sweep by index alone and keep the fleet scan as its repair pass. No field of the row records that day: the purge
works it out from the retirement's stamp and the grace. The purge removes every pointer it read to the row, and the one
its own grace would have filed. Where the registry only tombstones, no pointer is filed: nothing is removed for good, so
a pointer would only add a row for every scan to read, and the fleet scan purges, as it always did. A sweep run with a
longer grace than the one that filed a pointer finds it early and leaves it; once its day is older than
`lookbackBuckets`, the fleet scan purges the row.

**A pointer can outlive its row, and what removes it.** The pointer's key spells out the namespace and the segment name,
so until it goes the name is in the bucket, in a key. It lingers when the purge did not run to its end:

- the purge ran with another `tombstoneGraceMs` than the sweep that filed the pointer, so the day it computes holds
  none (a purge removes the pointers its scan read, whatever day they are under, but a scan limited to a `namespace`
  reads none);
- a delete landed and lost its response, so the sweep never learned the row was gone and kept the pointer, as it must;
- the registry refused the pointer's removal (`purgeFaults` counts it);
- the pointer's day has passed out of `lookbackBuckets`, where no index scan reads it.

The next scan that reads it removes it, once the segment's row is read again and still absent: an index scan removes
it from the days it reads, and an **unscoped** `'fleet'` scan (no `namespace`) removes it from every day, since the
listing it makes already reads every pointer. A scan limited to a `namespace` lists no pointers, so a deployment that
scopes every sweep, or runs only index scans, keeps such a pointer until an unscoped fleet scan runs: run one as the
repair pass. The removal is fenced on the pointer's token, so a pointer filed anew is kept; it covers the sweep's own
`shards` only, never runs under `dryRun`, and removes at most `limit` pointers per call, each a few reads and a delete
(a pointer an index scan reads costs four reads and a delete in all, the listing's read of it included; one a fleet
scan reads costs two reads and a delete more than the scan already paid).

One race stays, and the fleet scan repairs it. A name created again with a policy due on the very day a pointer to
nothing sits under (a same-day or back-dated expiry) can lose that pointer: `setRetention` takes the pointer already at
the key as its own, and a sweep that read the segment before its row existed can remove it in the two round trips that
follow. The purge's own pointer removal has the same window: it can remove a pointer a re-created name has just taken as
its own, when that name's policy is due on the pointer's day. The row is untouched and still expires; only its expiry pointer is gone, so an index scan never finds it, and
the default `'fleet'` scan, which reads every row, retires it. An index-only deployment is repaired only if it also
schedules a fleet scan, which is why the index is the fast half of a pair.

**What it costs.** Per segment, counted with a store that counts requests. Where the registry removes rows, a
retirement is 9 reads, 3 writes and a delete, and a purge 4 reads and 2 deletes: the pointer is filed with a create,
which is the one write the removal of the expiry pointer would otherwise have been, and the purge removes the row and
the pointer where a tombstone would have been written. On S3 a `DeleteObject` is not billed, and a `PutObject` is.
Where the registry only tombstones (`conditionalDelete: false`, or a backend that does not report it), no purge pointer
is filed or removed: a retirement is 8 reads and 3 writes, a purge 3 reads and 1 write, and two small objects stay per
segment, which every full scan reads (100 reads for 50 segments). The registry needs delete permission on its prefix
(`s3:DeleteObject`, `storage.objects.delete`, or a role that may delete blobs); without it a purge fails, the row stays,
the ledger entry and `purgeFaults` say why, and the retirements behind it still go on.

An unscoped sweep also lists the due index's pointers, one read each before it skips them, so give each sweep a
`namespace` where you can. So does every other unscoped enumeration: `checkConsistency`, `eraseSubject`,
`subjectReport`, `store.segments()` and the `export-segments` CLI read each pointer before they skip it, and where
pointers are filed each tombstone inside its grace holds a second row, so those calls read about twice the rows of the
grace period. (The [roadmap](../ROADMAP.md) lists an unscoped listing that skips the pointers before reading them.)

Pass `purgeTombstones: false` to keep every tombstone. That is the right choice if something outside this library
treats the presence of a `destroyed` row as an attestation. It includes the row of a retirement whose drop found no
storage generation to delete and left none behind:

- With the default, the sweep deletes that row in the same pass, since it would only fence the name. A `setRetention`
  on a mistyped name mints such a row. If that delete fails, the row is stamped and kept, and a later sweep deletes it.
- With `false`, it stays, stamped, and fences the name like any kept tombstone, until a sweep with purging on deletes
  it once its grace period has passed.

The ledger entry reports the retirement the same either way. There are two options rather than one
`number | 'never'` on purpose: `0` would have to mean "purge immediately" here while `cache.genTtlMs: 0` in this same
library means "never refresh on a timer", and one option whose zero is the opposite of another's is a trap for whoever
tunes both.
