# Retention, TTL and pruning

What exists for expiring data, and what does not.

## Retention, TTL and pruning — what exists and what doesn't

**Retention is per segment, and there is no per-`id` TTL.** Two separate statements, and the difference is the
whole shape of this section:

- **A segment can expire.** `store.setRetention(ref, { expiresAt })` records when it becomes eligible for
  retirement, and `store.retireExpired()` is the sweep that acts on it. Both are below.
- **An individual id cannot.** No `expireAfter`, no per-id age. That is a consequence of the data model, not a
  missing feature — a bitmap stores ids, not `(id, timestamp)` pairs — and it is explained next.
- **You schedule the sweep.** The *policy* is configuration; the *heartbeat* is yours, because this library starts
  no background timer (it has to behave identically in a Lambda, an edge isolate and a long-lived server). The
  hosting options are listed under [the sweep](#the-sweep--storeretireexpired).

If you arrived here asking "does it support TTL?", the answer is: **for a segment, yes; for an id, no, by design.**

### Why there is no per-id TTL

A bitmap stores **ids, not `(id, timestamp)` pairs.** Expiring individual ids means keeping a timestamp
per id — 4–8 bytes each — which destroys the compression the whole design exists for. A contiguous range of a
million ids is a few bytes as a Roaring run; the same million with per-id timestamps is megabytes, and worse
than a plain list. So per-id aging isn't deferred work, it's incompatible with the data model.

### The pattern that gives you the same outcome

Put time in the **name** instead of in the data, and let set algebra do the window. Use a **namespace per
family and the date as the segment** — not one long name — and load one bucket per day:

```ts
const bucket = (day: string) => store.segment(day, { namespace: 'active-daily' });

// Load today's bucket — a generation, from wherever today's ids come from.
const ref = { namespace: 'active-daily', segment: today };
await store.load(ref, idsSeenToday);

// "Active in the last 7 days" — a union over the buckets you still keep. A day whose bucket was never loaded (a
// job that did not run) names no segment, which a combine refuses; `allowAbsentOperands` reads it as empty instead.
// Leave it out to be told.
const [head, ...rest] = last7Days.map(bucket);
for await (const id of head.union(rest, { allowAbsentOperands: true })) { /* … */ }

// Retention = dropping whole buckets, not aging bits.
```

> **A name is any non-empty string.** `dedup:2026-08-01`, `orders/2026`, `user@example.com`, `日本語`, `100%` —
> all legal. There is no character allowlist, because each storage layer escapes what *it* cannot take
> literally, which is the library's problem rather than yours. The refusals are an **empty** name, one too long,
> and a **namespace that starts with `cbm.due.`**, which the library keeps its own bookkeeping rows in (below). The
> length limit is **256 characters once encoded**, measured on the longer of the object-key form and the
> filesystem-path form. Letters, digits, `.`, `_` and `-` are kept as they are (a leading `_` excepted), so a name of
> those gets all 256; every other character, ASCII included — a space, `/`, `@`, `%` — is escaped to three characters
> per byte, and so is `:`, which a filesystem path escapes though an object key does not. Such names reach the limit
> sooner (one emoji is twelve encoded characters).
>
> **The prefix `cbm.due.` is reserved for the namespace.** The retention index stores one pointer row per expiring
> segment in `cbm.due.<day>`, and every fleet-wide scan skips the rows of that namespace as bookkeeping, so a segment
> of yours there would be invisible to an erasure, a consistency check, an export, `segments()` and a retention
> sweep. Every call that takes a namespace, in a ref or as an option, throws `ValidationError` for one starting with
> `cbm.due.`. Only that exact prefix is reserved: `cbm.dueX`, `cbm.due` and `cbmdue.eu` are ordinary namespaces, and so
> is any segment *name*, `cbm.due.x` included.
>
> The namespace split is still the better shape for a *family*: `store.segments({ namespace: 'active-daily' })`
> enumerates exactly that family's buckets, and `eraseNamespace` can retire the whole family at once. With one
> flat name, finding "every daily bucket" means string-matching instead.

`union` reads every chunk of every operand — it can't skip, and the guide says so in
[the operations table](getting-started.md#the-operations). If a 7-way union per read is too much, materialize the window with
`unionInto` — into a dated target, or into one rolling target; either is correct, because an `*Into` verb
**supersedes** its destination rather than adding to it, so a rolling `active-7d` re-materialized each day holds
exactly that day's window:

```ts
const window = store.segment('active-7d', { namespace: 'windows' });
const days = last7Days.map(bucket);
// window's previous generation is superseded, not merged into
await days[0].unionInto(window, days.slice(1), { allowAbsentOperands: true });
```

Loading a bucket a day is the natural shape for a "seen this period" set: today's bucket is a different, empty set
until you load it, and the union is your window. A genuine rolling window — *"seen in the last 4 hours"*, exactly
— is a smaller bucket, loaded more often; there is no per-id write to age individual ids out with.

### Pruning a segment today — and the honest limits

**`store.dropSegment` is the one you want for a rolling window** — or `retireExpired`, which calls it for you once
you have recorded a policy. Four levers exist, and they answer different questions:

| | what it does | when |
|---|---|---|
| **`store.retireExpired({ … })`** | enumerates the registry and retires every segment whose recorded `expiresAt` has passed, **through `dropSegment`**. Bounded, previewable, returns a per-segment ledger. You schedule it | **a policy-driven rolling window** — the usual answer, [below](#the-sweep--storeretireexpired) |
| **`store.dropSegment(ref, { confirmSegment })`** | tombstones the segment, then deletes its Storage generations (re-swept, with any residual reported in `generationsRemaining`). Works on a cleartext segment; on an encrypted one it *also* discards the DEK, so it is a strict superset there. Afterwards the segment **reads as empty** — see the caveat below | **retiring a bucket and reclaiming the storage** |
| `destroySegment(ref, { registry }, { confirmSegment })` | **crypto-shred**: discards the DEK so the Storage bytes are unreadable *everywhere including backups and WORM* — but leaves the objects in your bucket, still billed. **Requires encryption**: a cleartext segment has no key to shred, and the call leaves it as it is and returns `reason: 'cleartext'` | erasure that must reach immutable copies |
| `store.load(ref, ids, { keep })`, or an `*Into` given `keep` | the write's own collection: deletes only **superseded** generations, keeping `keep` as a reader grace window | reclaiming what loads leave behind ([generation bookkeeping](loading.md#generation-bookkeeping-what-a-load-leaves-behind)), not live data |

Deleting an object does not reach a noncurrent version, a cross-region replica, or a PITR snapshot; discarding
the key does. So if your requirement is *"the data must become unreadable"* rather than *"stop paying for it"*,
encryption at rest is a prerequisite — and `dropSegment` on an encrypted segment gives you both at once.

### Retiring a bucket

`store.dropSegment` needs the store built with a **backend** (it has to enumerate and
delete generations, which a pre-built `StorageChunkSource` cannot do) — the same requirement as `eraseSubject` in
the erasure guide. Without it you get an `UnsupportedError`.

```ts
// The namespace is part of the identity. Omit it and you address a DIFFERENT segment, and the call is a
// silent no-op returning { dropped: false, reason: 'absent' } — no throw. Check `reason` in a sweep.
const ref = { namespace: 'active-daily', segment: oldDay };

// Look before you leap — reports the generations it WOULD delete, changes nothing.
const preview = await store.dropSegment(ref, { confirmSegment: ref.segment, dryRun: true });
// `wouldDelete` is unbounded — it lists every generation still in Storage, and a segment written daily by an `*Into`
// that is never given `keep` accumulates them. Log the count and a sample, not the whole array.
const gens = preview.wouldDelete ?? [];
console.log(`would delete ${gens.length} generation(s): ${gens.slice(0, 10).join(', ')}${gens.length > 10 ? ' …' : ''}`);

// Then do it.
const result = await store.dropSegment(ref, { confirmSegment: ref.segment });
// → { dropped: true, generationsDeleted: [0, 1], generationsRemaining: [], cryptoShredded: false }
```

**Reading the result.** Branch on `dropped`; use `reason` to understand *how*:

| `dropped` | `reason` | Meaning |
|---|---|---|
| `true` | `undefined` | An ordinary drop — tombstone written, Storage generations swept |
| `true` | `'already'` | Already tombstoned. **Not** a no-op: it re-sweeps Storage, so it is how a residual in `generationsRemaining` is collected |
| `false` | `'absent'` | **Nothing existed** — no row and no objects. The one case to alert on — usually a mistyped name or an omitted `namespace`, both of which address a *different* segment than you meant |

Then the whole retention job is a loop, and the dangerous part is inside the library — though if the cutoff is a
property of the *segment* rather than of your code, [`setRetention` + `retireExpired`](#recording-the-expiry-on-the-segment-itself)
is this loop with the decision moved to the writer and the bounds, preview and ledger already built:

```ts
// Names first, drops after: a drop writes the row, and a paged listing may or may not see its own writes.
const old: string[] = [];
for await (const s of store.segments({ namespace: 'active-daily' })) {
  if (s.status === 'active' && s.segment < cutoffDay) old.push(s.segment); // ISO dates sort lexicographically
}
for (const segment of old) {
  const ref = { namespace: 'active-daily', segment };
  const res = await store.dropSegment(ref, { confirmSegment: ref.segment });
  // Non-empty means bytes survived — a load that was already writing when the tombstone landed finished its
  // object. The segment reads as empty either way, so this is a billing leak, not a correctness one; re-run the
  // drop to collect it. The retention sweep will not: it purges only the tombstones it wrote itself.
  if (res.generationsRemaining.length > 0) {
    console.warn(`${ref.segment}: ${res.generationsRemaining.length} generation(s) not reclaimed`);
  }
}
```

**`confirmSegment` is a typo guard, not an authorization.** In the loop above the same value appears twice, so
it protects nothing — that is what `dryRun` is for. Run the sweep with `dryRun: true` first and log what it
would take; a retention bug you can read in a log is worth more than one you find in a bucket.

### Why the order inside it matters, and why you should not hand-roll it

`dropSegment` does registry → Storage, and each position is load-bearing:

1. **Registry first.** After the tombstone nothing resolves a generation, so no reader can reach for bytes about
   to disappear — and no writer can publish onto it: a load refuses
   a `destroyed` row, so a load racing the drop cannot resurrect the segment.
2. **Storage second, best-effort, and swept more than once.** Once the pointer is a tombstone the segment reads as
   empty and is *correct*, so a failure part-way through leaks **bytes, not correctness** — and re-running
   collects the remainder. The sweep repeats (up to three passes) because a load that was already writing its
   object when the tombstone landed still finishes the write: its publish is then refused, but the object
   survives and holds the complete set. **Check `generationsRemaining`** — non-empty means bytes are still there
   and the drop should be repeated: a re-drop of a tombstone re-sweeps its storage. The retention sweep collects
   them only for a tombstone it wrote itself, through `retireExpired`; one a hand-run `dropSegment` wrote is
   left to you.

Two limits worth knowing before you automate it:

- **A drop is final for the name.** The tombstone fences every later load of that segment (refused with
  `ValidationError`), which is what makes step 2 converge. To reuse a name, use a fresh dated name — which is the
  pattern anyway — or retire the segment through `retireExpired`, which purges the tombstones it wrote itself
  once their grace period has passed and their storage is empty (below). A tombstone a hand-run `dropSegment`
  wrote is never purged by the library; the
  [disaster-recovery runbook](disaster-recovery.md#repair-an-unstamped-tombstone-after-a-hard-kill) shows how to
  delete such a row by hand once its storage is empty.
- **"Reads as empty" needs a timed refresh.** The `cache.genTtlMs` bound applies to a reader with a registry *and* a
  positive TTL, on a storage source with a clock, which every source a store builds for itself has. With no registry
  (a bare `IStorageDriver`), or with `cache: { genTtlMs: 0 }`, a reader has no timed refresh: it notices the drop only
  when a read has to fetch from a deleted generation or its reader cache evicts the segment, and can answer `true`
  from its cache for a dropped segment indefinitely — call `store.invalidate(ref)` on it, or restart it.

> ⚠️ **The tempting shortcut breaks reads: an object-store lifecycle rule alone.** It deletes the bytes while
> the registry still points at them, which is exactly the state
> [`checkConsistency()`](disaster-recovery.md) reports as **`missing-storage-generation`** — the torn-restore
> failure the DR guide says not to serve traffic on.
>
> **And it presents intermittently.** A read checks the cache before Storage, so cached chunks answer correctly
> while uncached or evicted ones raise `NotFoundError`. It passes a warm-process test and starts failing after a
> restart or a deploy, looking like a transient cloud fault rather than a misconfiguration.
>
> A lifecycle rule is still a fine **backstop** for orphans left by a failed `dropSegment` — just set its
> expiry window comfortably longer than your retention window, so it can never get there first.

### Recording the expiry on the segment itself

The loop above works, and it hard-codes your retention rule in the sweeper: whoever writes the sweep has to know
that `active-daily` keeps 30 days and `dedup-wave` keeps 3. **`store.setRetention` moves that decision to the
writer**, who is the only one who actually knows what the segment means:

```ts
const DAY = 86_400_000;
const ref = { namespace: 'active-daily', segment: today };

await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY }); // before or after the load — either works
await store.load(ref, idsSeenToday);
```

That is **one registry write, and nothing else happens.** Nothing is deleted, and no timer starts — the sweep
that acts on the policy is a separate call you schedule (below). Call it once when you create the bucket, not on
every load; it is idempotent, so re-running is harmless, but it is a write.

**Why an absolute instant rather than `retentionDays`.** A duration has to be measured from *something*, and
every anchor the library could use is wrong. `updatedAt` and `currentGen` are both rewritten by every load, so
"expire 30 days after the last write" would push a daily-reloaded bucket's expiry forward on every refresh — the
segment would stay alive precisely *because* it is being kept fresh. The writer computes the instant; the
library stores it verbatim and never moves it.

**It works before the first load.** A segment with no registry row yet gets one (the result says `createdRow:
true`) with **no Storage generation** (`currentGen: null`), so the policy is recorded ahead of the data and the
segment is already enumerable by the sweep; the first load then publishes onto that row. Reads are unaffected —
a pointer-less row resolves exactly like a segment with no row.

Two guards worth knowing:

- **`expiresAt` is epoch-milliseconds**, and a value that looks like epoch *seconds* is rejected rather than
  stored. `Date.now() / 1000 + 30 * 86400` is a natural thing to type and lands in **1970** — already expired —
  so without the check it would not be an error, it would be a deletion on the next sweep.
- **A past instant is legal** and means "eligible on the next sweep". Backfilling a policy onto buckets that
  already exist is a normal migration, and refusing it would make that awkward for no safety gain.

Reading and cancelling:

```ts
await store.getRetention(ref); // → { expiresAt } | null | 'invalid'
await store.clearRetention(ref); // → true if a policy was actually removed
```

`getRetention` returns the string `'invalid'` for a row whose `expiresAt` is present but unusable, such as a
hand-edited one. That is deliberately not folded into `null`: a
malformed policy reading as "never expires" on a segment someone believes is expiring is exactly the kind of
silence that costs a compliance commitment. And cancelling is its **own verb**, because "never expire" passed
into the setter as a magic value is how a typo becomes a deletion.

**A deadline can also sit on a handle.** `store.segment(name, { namespace, expiresAt })` takes the same
epoch-milliseconds instant, and past it every read through **that handle** answers empty — `has` → `false`,
`count` → `0`, `iterate` → nothing — as one comparison against the store's clock, with no I/O. An expired operand
makes an `intersect` empty and drops out of a `union`. **An expired exclusion excludes nothing, in every shape**: in
an `andNot`, and as `exclude` on an `intersect` or a `union`, it is skipped without being read, so an opt-out list
that has lapsed suppresses nobody. An `*Into` that involves an expired handle, an exclusion included, throws
`ValidationError`. It reclaims nothing and binds no other handle, so `count()` answering `0`
while the objects are still in the bucket is expected: it is one reader's cut-off, not a policy. Record the
policy with `setRetention` to make the expiry durable, visible to the sweep and reclaimable. A seconds-shaped
value is refused at the handle, and `seg.expiresAt` reads it back.

### The sweep — `store.retireExpired()`

A policy is inert until something acts on it. `retireExpired` enumerates the registry, selects the segments whose
`expiresAt` has passed, and retires each one **through `dropSegment`** — so the registry → Storage ordering, the
re-sweep for an object a load was still writing, and the `generationsRemaining` report all come from one
implementation instead of two.

```ts
const swept = await store.retireExpired({ namespace: 'active-daily' });
// → { scanned, eligible, retired, wouldRetire, tombstonesPurged, limited, dryRun, entries }
```

**It is a call, not a daemon.** Nothing in this library schedules itself, and that is a deliberate limit rather
than an unfinished feature: the same code has to behave identically in a Lambda, an edge isolate and a long-lived
server, and a timer that only works in one of those is worse than none. **You own the heartbeat.** Any of these is
a correct answer:

| Where you already run things | How to run the sweep |
|---|---|
| **AWS Lambda** | an EventBridge (CloudWatch Events) schedule → a handler that builds the store and calls `retireExpired` |
| **Kubernetes** | a `CronJob` |
| **ECS / Fargate** | a scheduled task |
| **A plain VM / container** | `cron` calling a one-shot script |
| **A job queue you already have** | a recurring job — the one that runs your loads is a natural home |

> ⚠️ **Run the sweep from ONE process, or shard it.** N replicas each running the full sweep would contend over
> the same segments. Either call `retireExpired` from a job that runs once (a `CronJob`), or give each replica a
> disjoint slice with `shards` / `totalShards` — a stable hash of the segment key, so a worker owns the same slice
> across restarts.

**Once a day is enough** for daily buckets — retention windows are measured in days, so an hourly sweep just
re-scans the same registry 24 times. Match the cadence to the granularity of your policies, not to how fast you
want the deletion to feel. A fleet scan is a billed `LIST` over the registry prefix — the
default `'fleet'` scan costs what the fleet *holds*; `scan: 'index'` reads only the due buckets of the **due
index** and costs what is *expiring*. The index is a fast path, not the source of truth: each candidate's live
row is re-read before anything is decided, and a policy whose pointer write failed has no pointer, so run
the `'fleet'` scan periodically as the repair pass (`lookbackBuckets`, default 7, is how many past days a fast
scan also reads so a sweep that did not run leaves nothing stranded).

**Start with `dryRun`.** In a loop `dropSegment`'s `confirmSegment` guard protects nothing (it is the same
variable twice), so the sweep-level preview is the real safety net:

```ts
const preview = await store.retireExpired({ namespace: 'active-daily', dryRun: true });
// `wouldRetire`, not `retired` — `retired` counts actual deletions and is 0 in a dry run, deliberately, so a
// dashboard summing it can never report phantom deletions.
console.log(`would retire ${preview.wouldRetire} of ${preview.scanned} scanned`);
```

**Read the ledger.** A per-segment fault is an entry, never an exception — a throw from the middle of a fleet
sweep would leave you unable to say which segments were retired, having already retired some:

```ts
for (const e of swept.entries) {
  if (e.action === 'skipped') console.warn(`${e.segment}: ${e.reason}`);
  if (e.action === 'retired' && e.result.generationsRemaining.length > 0) {
    console.warn(`${e.segment}: storage not fully reclaimed — re-run`);
  }
}
if (swept.limited) scheduleAnotherPassSoon(); // more are still eligible
```

**Two bounds worth setting deliberately.** Retirements are **sequential** — several round trips each, so the
default `limit` of 100 is comfortably inside a Lambda; `limit` is therefore a *time* knob as much as a safety one,
and raising it by orders of magnitude after a backlog will time out mid-sweep (harmlessly — re-run). And
`maxScanSegments` (default 250,000) caps how many registry rows one sweep holds resident; past it the call throws
`BudgetExceededError` rather than half-sweeping, because a scan that cannot fit is not a partial result to be
mistaken for a complete one. Narrow with `namespace` before raising it.

Every `skipped` reason is worth an alert, for a different reason:

- **`invalid-policy`** — the row's `expiresAt` cannot be used. That segment is **not expiring**, and someone
  probably believes it is.
- **`limit`** — eligible, but this cycle's cap (default **100**) was spent; `limited: true` says the same at the
  top level. That cap is what stands between a bad `expiresAt` backfill (or clock skew) and a retired fleet, so it
  defers rather than drops — re-run to continue. The cap is charged on **attempts**, not successes, so a partial
  Storage outage cannot march through the fleet with the cap never engaging.
- **`policy-changed`** — the live row no longer says "expired": a `clearRetention`, a new `expiresAt`, or someone
  else's drop landed between the enumeration and this segment's turn. **Not an error** — the sweep re-reads the
  authoritative row immediately before every deletion, precisely so cancelling an expiry works on a sweep that is
  already running.
- **`tombstone-not-empty`** — see below.
- **`failed: …`** — that one segment's retirement threw. Note that `dropSegment` writes the tombstone *before* the
  Storage sweep, deliberately, so a fault there leaks **bytes, not correctness**; a fault *after* the tombstone landed
  is reported as `retired` with a `fault`, because that segment really is retired. Re-running collects the bytes.

**Tombstones are purged, narrowly.** A retired segment leaves a `destroyed` row behind, and one dead row per
retired daily bucket accumulates forever. The sweep deletes those rows too, but only when all three hold,
because deleting the row is what makes the name writable again:

1. the row carries the **sweep's own retirement stamp**. This is a positive marker `retireExpired` writes on the
   tombstones it creates, *not* an inference from "destroyed + an expired policy", which would be wrong, and
   dangerously so: a crypto-shred leaves `retention` untouched, so the ordinary ordering (set a 30-day policy, then
   a right-to-erasure request arrives mid-window and you `destroySegment`) produces a **GDPR tombstone carrying an
   expired policy**. Deleting that row would destroy the local attestation for an Art. 17 execution and un-fence
   the name. A marker cannot be forged that way, so a `destroyed` row the sweep did not create is never touched;
2. a **grace period** has passed since that stamp (default 24 h). While the row exists every writer refuses the
   segment, and that is what stops an in-flight load from resurrecting it;
3. Storage is provably empty for it. If Storage still holds a straggler generation — a load that was writing when the
   tombstone landed — the sweep **collects it first** (the collection takes every generation of a destroyed
   row, and nothing else would ever run it for a tombstoned segment), then purges. Only if the storage still
   cannot be proven gone does the row stay, with `tombstone-not-empty`: without the row the collection can
   no longer see the segment at all, and the objects would be billed forever. That reason also covers the case
   where the collection **declined** because the row changed under it — not a storage fault, and the next cycle
   simply retries.

Pass `purgeTombstones: false` to keep every tombstone — the right choice if something outside this library treats
the presence of a `destroyed` row as an attestation. That includes the row of a retirement whose drop found no
Storage generation to delete and left none behind: with the default, the sweep deletes that row in the same pass,
since it would only fence the name (a `setRetention` on a mistyped name mints such a row; if that delete fails, the
row is stamped and kept, and a later sweep deletes it); with `false` it stays,
stamped, and fences the name like any kept tombstone, until a sweep with purging on deletes it once its grace period
has passed. The ledger entry reports the retirement the same either way. (Two options rather than one `number | 'never'` on purpose:
`0` would have to mean "purge immediately" here while `cache.genTtlMs: 0` in this same library means "never refresh on a timer",
and one option whose zero is the opposite of another's is a trap for whoever tunes both.)
