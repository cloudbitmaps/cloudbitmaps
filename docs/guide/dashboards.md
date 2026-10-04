# Dashboards & audit: wiring the three signals

CloudBitmaps exposes three independent observability surfaces. They answer different questions and belong on
different screens — don't collapse them into one:

| Surface | Question it answers | Audience | Where it goes |
| --- | --- | --- | --- |
| **Metrics** (`IMetricsSink`) | *Is it healthy and fast?* — volume, latency, cache hit rate | on-call / SRE | ops dashboard (Grafana, Datadog, CloudWatch) |
| **Cost** (`costReport()`) | *What is it costing vs. Redis?* — dollars, crossover | you / FinOps | a cost gauge, reviewed weekly |
| **Audit** (`IAuditSink`) | *Who changed the data, when?* — publish / rewrite / **erase** / dispose | security / compliance | append-only audit log / SIEM |

All three are **off by default**, **vendor-neutral** (CloudBitmaps ships no telemetry dependency — you write a
short adapter), and **exception-safe** (a throwing sink can never break a read, a load, or a lifecycle op). This
guide shows a worked adapter for each. The [observability](./observability.md) and [cost](./cost.md) guides
carry the API reference.

---

## 1. Operational dashboard (metrics → OpenTelemetry)

The metrics sink pushes raw observations on the I/O path. There are five event kinds:

| `kind` | When | Payload |
| --- | --- | --- |
| `storage.get` | one object-store GET for a chunk | `bytes` (0 if the chunk was absent — a GET still happened), `ms` (includes any retry backoff) |
| `cache` | one cache lookup (only when a cache is configured) | `hit`. With a cache, a miss that waits on a read another caller already has open adds no `storage.get`, so `misses` can exceed the `storage.get` count; `storage.get` is the number of requests |
| `retry` | a transient infrastructure fault (throttling, 5xx, a dropped connection) is about to be retried — the one kind of retry the store does | `reason: 'transient'`, `attempt`, `delayMs` |
| `intersect` | one chunk-aligned combine | `op` (`intersect` / `union` / `andNot`; absent means `intersect`), `operands`, `fetchedChunks`, `skippedChunks` |
| `op` | one timed segment operation | `name` (`has` / `count` / `intersectInto` / `unionInto` / `andNotInto`), `ms` |

Map the handful you chart to counters/histograms:

```ts
import { metrics as otel } from '@opentelemetry/api';
import { CloudRoaring } from '@cloudbitmaps/roaring';

const meter = otel.getMeter('cloudbitmaps');
const storageGets = meter.createCounter('cloudbitmaps.storage.gets');
const storageBytes = meter.createCounter('cloudbitmaps.storage.bytes');
const cacheHit = meter.createCounter('cloudbitmaps.cache.hits');
const cacheMiss = meter.createCounter('cloudbitmaps.cache.misses');
const retries = meter.createCounter('cloudbitmaps.retries');
const skippedChunks = meter.createCounter('cloudbitmaps.intersect.skipped_chunks');
const fetchedChunks = meter.createCounter('cloudbitmaps.intersect.fetched_chunks');
const opLatency = meter.createHistogram('cloudbitmaps.op.ms');

const store = new CloudRoaring({
  storage, // a backend — S3Storage, GcsStorage, …
  metrics: {
    onEvent(e) {
      switch (e.kind) {
        case 'storage.get':
          storageGets.add(1);
          storageBytes.add(e.bytes);
          break;
        case 'cache':
          (e.hit ? cacheHit : cacheMiss).add(1);
          break;
        case 'retry':
          retries.add(1); // e.reason is always 'transient'
          break;
        case 'intersect': {
          const op = e.op ?? 'intersect'; // a fixed enum — safe as a label
          skippedChunks.add(e.skippedChunks, { op });
          fetchedChunks.add(e.fetchedChunks, { op });
          break;
        }
        case 'op':
          opLatency.record(e.ms, { op: e.name }); // `op` name is a fixed enum — safe as a label
          break;
      }
    },
  },
});
```

**Panels worth having:** cache hit rate (`hits / (hits + misses)` — the single biggest cost lever), storage GETs and bytes
read/min, `has` / `count` p50/p99 latency, `*Into` latency on its own panel (each one writes a whole generation,
so it lives on a different scale from a read), the chunk-skipping ratio
(`skipped / (skipped + fetched)` per `op` — the number that says whether your intersections are actually cheap;
a plain `union` is expected to skip nothing), and retry rate (a rising `transient` count means your object
store is throttling).

`CountingMetricsSink` (exported) tallies all five kinds into a `MetricsSnapshot` —
`{ storage, cache, retries: { transient }, intersect, ops }` — which is enough for a test or a quick script.

> **Label caveat.** `segment` / `namespace` are *your* strings — unbounded-cardinality and possibly PII. Never
> map them straight to metric labels; the `op` **name** is a safe fixed enum, segment names are not. A name
> may be any non-empty string, so it can also contain characters your metrics backend treats specially —
> another reason to hash rather than pass through.

---

## 2. Cost gauge (costReport → a scheduled sample)

Cost isn't an event stream — it's a *standing figure* you sample on a schedule (a cron, a Lambda) and push as a
gauge. Because the library owns the objects, the grounded report uses each segment's **real** measured size:

```ts
import { metrics as otel } from '@opentelemetry/api';

const meter = otel.getMeter('cloudbitmaps');
const monthlyUsd = meter.createObservableGauge('cloudbitmaps.cost.monthly_usd');
const shareOfRedis = meter.createObservableGauge('cloudbitmaps.cost.share_of_redis');
// What the Redis you would otherwise run for this store costs a month: your figure, not the library's.
const STORE_REDIS_USD = 900;
const SEGMENTS = ['active-us', 'active-eu'];

meter.addBatchObservableCallback(
  async (obs) => {
    let storeUsd = 0;
    for (const name of SEGMENTS) {
      const r = await store.segment(name).costReport({
        workload: { readsPerSec: 200, cacheHitRate: 0.8, loadsPerMonth: 30 },
      });
      obs.observe(monthlyUsd, r.monthlyUSD.total, { segment: name });
      storeUsd += r.monthlyUSD.total;
    }
    // One figure for the store: its pay-per-use bill as a share of the Redis that would replace all of it.
    obs.observe(shareOfRedis, storeUsd / STORE_REDIS_USD);
  },
  [monthlyUsd, shareOfRedis],
);
```

Alert when `share_of_redis` passes `1`: the store's pay-per-use bill now exceeds the Redis you would run instead,
usually because read volume outgrew the cache hit rate. Price the store, not each segment. A segment's own
`r.verdict` compares it with a Redis sized to that segment alone (`r.redisBaseline`), and a verdict against the
whole store's Redis would fire only when one segment alone cost more than all of it.

`r.monthlyUSD.byOp` breaks each segment's total into `reads` / `intersects` / `storage` / `loads` /
`pointerRefresh`, so you can see *what* pushed the store over. `r.redisCrossover.readsPerSec` is the read rate at
which one segment's economics flip against its own Redis, *at this report's cache-hit rate* (with the cache off,
against one $346 cluster it is about 329 reads/s; every cache hit moves it further out, and every hot segment's
pointer refresh moves it in). Loads are modelled only when you pass `loadsPerMonth` (and `requestsPerLoad` for a
multipart write; what `store.load()` adds around the object is counted for you), and the pointer refresh only when
you pass `hotSegments`; `r.assumptions.notes` says so when either is not.

---

## 3. Audit log (audit → append-only sink / SIEM)

Audit events are low-volume, high-value, and must be **durable and tamper-evident** — route them to an
append-only store (CloudWatch Logs, an S3 object-lock bucket, your SIEM), never to the same mutable place as
metrics. The sink adds the timestamp and actor (the library keeps its core free of ambient time/identity):

```ts
import { destroySegment } from '@cloudbitmaps/roaring';
import type { IAuditSink } from '@cloudbitmaps/roaring';

function siemAudit(actor: string): IAuditSink {
  return {
    onEvent(event) {
      // one structured, append-only line per compliance-relevant change
      auditLog.append({
        at: new Date().toISOString(), // the sink owns the clock
        actor, // …and the identity
        ...event, // kind + segment/namespace (+ generation / fromGeneration, reason + cardinality, generationsDeleted, or segmentsShredded)
      });
    },
  };
}

const audit = siemAudit('batch-loader@svc');

// Pass it to each lifecycle op (audit is not a store-constructor option — these are separate entry points):
await store.load({ segment: 'users' }, ids, { audit });
await store.eraseSubject(subjectId, { namespace: 'eu', audit }); // GDPR Art. 17 — one segment.rewrite per segment
await store.rollback({ segment: 'users' }, 4, { audit }); // an operator moving the pointer
await store.dropSegment({ segment: 'users' }, { confirmSegment: 'users', audit }); // retire + reclaim storage
await store.retireExpired({ audit }); // one segment.dispose per retirement
await destroySegment({ segment: 'users' }, { registry }, { confirmSegment: 'users', audit }); // crypto-shred
```

**What lands in the log** — seven kinds. `segment.publish` (a loaded generation became current),
`segment.rollback` (an operator moved the pointer to a generation they named: backwards, or forward — with
`allowForward: true` to undo an earlier rollback, or onto a segment that had no current generation, when
`fromGeneration` is `null`; the one event whose effect cannot be reconstructed from the
objects in the bucket, which is why the [disaster-recovery guide](disaster-recovery.md) treats it as the receipt
that matters, and emitted only on the sink passed to that `rollback` call),
`segment.load-refused` (a load that did not publish, with its `reason` and the refused generation's
`cardinality`: its guard refused the generation it wrote, the segment's row changed while it was writing, or
another load took its generation number first, in which case it wrote nothing and `cardinality` is 0 — without it
the absence of a `segment.publish` is not otherwise distinguishable from a job that never ran), `segment.rewrite` (a
generation derived from the segment itself replaced it — `fromGeneration` → `generation`; today the one
emitter is a subject erasure, and it fires at the publish, *before* the superseded generation is collected, so
the record exists the moment the generation without the id is authoritative — no `segment.publish`
accompanies it), and the erasure trail: `segment.erase` fires per segment on a **genuine crypto-shred** (not a
cleartext tombstone, whose bytes stay readable), `segment.dispose` fires per `dropSegment`, and
`eraseNamespace` adds one `namespace.erase` carrying `segmentsShredded` (the honest count actually destroyed,
which may be 0).

**Which event is the receipt.** An auditor asks "prove subject X's data was destroyed on date Y":

- For a whole segment or tenant, a `segment.erase` for that segment is the receipt, on the terms its row in the
  table below sets out: it attests that the key left the segment's current registry row, and the destruction is
  complete once no other copy of that row still holds it.
- For one subject, it is the `segment.rewrite` for each segment that had to be **rewritten**, paired with the
  erasure ledger `eraseSubject` returned — `{ erased: true, fromGeneration, generation }` per segment. The event
  attests that the generation without the id became authoritative; the ledger attests that the generation which
  held it was deleted before the call returned. Keep both.
  > **One erasure emits no event**, so do not reconcile on "an event per ledger entry". When the id is not in
  > the current generation but survives in a **retained superseded** one — an ex-member dropped by a re-seed —
  > nothing is rewritten and nothing is published: the generation holding it is simply collected. The ledger
  > entry is then `{ erased: true, fromGeneration }` with **no `generation`**, and it is the whole receipt.
- A `segment.publish` is not a receipt for anything: it says a set was loaded, not what was removed from it.

**`segment.erase`, `segment.rewrite` and `segment.dispose` are deliberately different receipts, and conflating
them would make your dashboard over-attest.**

| Event | What it proves | What it does NOT prove |
|---|---|---|
| `segment.erase` | The wrapped DEK(s) are gone from the segment's **current** registry row, so nothing that opens the segment through that row from then on can decrypt its bytes — in the bucket, or in any backup, replica, PITR snapshot or WORM copy of its objects. The one erasure event whose claim reaches immutable copies of the objects | **Not** that no copy of the wrapped key survives. A shred is one compare-and-swap on the row and destroys no KEK: a noncurrent version, a backup or a PITR copy of the registry row still holds the wrapped DEK(s), which decrypt the segment with a KEK that wrapped them, and a registry restore to a point before the event makes the segment readable again. The destruction is complete once no retained copy of the row holds them, or once every KEK that wrapped them is destroyed |
| `segment.rewrite` | A generation without the erased id is now current, derived from `fromGeneration`. With the ledger entry it came with, the object that held the bit is gone from the bucket | **Not** that every copy is gone. A noncurrent object version, a cross-region replica or a backup can still hold `fromGeneration` until its own lifecycle removes it — for a claim that reaches those, the segment has to be encrypted and the receipt is `segment.erase`, on the terms in its row |
| `segment.dispose` | The segment was tombstoned and its storage reclaimed (`generationsDeleted` Storage generations). Emitted by `dropSegment` — including **every retirement a `retireExpired` sweep performs**, since the sweep forwards its `audit` sink through. A retention-driven fleet will therefore emit these in batches on whatever schedule you gave the sweep | **Not** that the bytes are unreadable. A noncurrent object version, a cross-region replica or a PITR snapshot can still hold the cleartext. Also not that reclamation is *complete* — check `DropResult.generationsRemaining` |

> **One gap worth knowing:** when a sweep deletes a retired segment's tombstone **row**, **no audit event is
> emitted.** It deletes one in two cases: the tombstone of an earlier retirement, once `tombstoneGraceMs` (default
> 24 h) has passed and the segment's Storage generations are provably gone; and, in the same pass, the tombstone
> of a retirement whose drop found no Storage generation to delete and left none behind, since that row would only
> fence the name. The `segment.dispose` above is the receipt for the data (for such a retirement it carries
> `generationsDeleted: 0`); the row removal is not separately attested. If your controls treat the presence of a
> `destroyed` row as the attestation, pass `purgeTombstones: false`: the sweep then deletes neither kind. The
> second kind's row stays, stamped like the first, until a sweep with purging on deletes it.

A **cleartext** `dropSegment` emits only `segment.dispose`. An **encrypted** one emits **both**, because both
things genuinely happened. So: count `segment.erase` for an Art. 17 destruction claim (on the terms in its row
above), `segment.rewrite` (with its ledger) for a per-subject erasure, and `segment.dispose` for a
retention/lifecycle trail. Never substitute one for another.

> **KEK rotation is not in this stream** — rotating the key-encryption key is operator-side keystore
> reconfiguration (no library call to hook). Audit it at your KMS/keystore layer. See the audit section of
> [observability](./observability.md).

---

## Putting it together

A minimal production wiring: **metrics** → your existing OTel/Datadog pipeline (health), a **cron** sampling
`costReport()` → a cost gauge (spend), and an **audit** sink on every lifecycle call → an append-only bucket
(compliance). Three sinks, three screens, one library — and each stays a no-op until you opt in, so the default
hot path pays nothing.
