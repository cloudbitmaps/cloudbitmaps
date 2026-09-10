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
guide shows a worked adapter for each. The observability, cost and audit sections of
[getting-started](./getting-started.md) carry the API reference.

---

## 1. Operational dashboard (metrics → OpenTelemetry)

The metrics sink pushes raw observations on the I/O path. There are five event kinds:

| `kind` | When | Payload |
| --- | --- | --- |
| `cold.get` | one object-store GET for a chunk | `bytes` (0 if the chunk was absent — a GET still happened), `ms` (includes any retry backoff) |
| `cache` | one hot-cache lookup | `hit` |
| `retry` | a transient infrastructure fault (throttling, 5xx, a dropped connection) is about to be retried — the one kind of retry the store does | `reason: 'transient'`, `attempt`, `delayMs` |
| `intersect` | one chunk-aligned combine | `op` (`intersect` / `union` / `andNot`; absent means `intersect`), `operands`, `fetchedChunks`, `skippedChunks` |
| `op` | one timed segment operation | `name` (`has` / `count` / `intersectInto` / `unionInto` / `andNotInto`), `ms` |

Map the handful you chart to counters/histograms:

```ts
import { metrics as otel } from '@opentelemetry/api';
import { CloudRoaring } from '@cloudbitmaps/roaring';

const meter = otel.getMeter('cloud-roaring');
const coldBytes = meter.createCounter('cloudroaring.cold.bytes');
const cacheHit = meter.createCounter('cloudroaring.cache.hits');
const cacheMiss = meter.createCounter('cloudroaring.cache.misses');
const retries = meter.createCounter('cloudroaring.retries');
const skippedChunks = meter.createCounter('cloudroaring.intersect.skipped_chunks');
const fetchedChunks = meter.createCounter('cloudroaring.intersect.fetched_chunks');
const opLatency = meter.createHistogram('cloudroaring.op.ms');

const store = new CloudRoaring({
  cold,
  registry,
  metrics: {
    onEvent(e) {
      switch (e.kind) {
        case 'cold.get':
          coldBytes.add(e.bytes);
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

**Panels worth having:** cache hit rate (`hits / (hits + misses)` — the single biggest cost lever), cold bytes
read/min, `has` / `count` p50/p99 latency, `*Into` latency on its own panel (each one writes a whole generation,
so it lives on a different scale from a read), the chunk-skipping ratio
(`skipped / (skipped + fetched)` per `op` — the number that says whether your intersections are actually cheap;
a plain `union` is expected to skip nothing), and retry rate (a rising `transient` count means your object
store is throttling).

`CountingMetricsSink` (exported) tallies all five kinds into a `MetricsSnapshot` —
`{ cold, cache, retries: { transient }, intersect, ops }` — which is enough for a test or a quick script.

> **Label caveat.** `segment` / `namespace` are *your* strings — unbounded-cardinality and possibly PII. Never
> map them straight to metric labels; the `op` **name** is a safe fixed enum, segment names are not.

---

## 2. Cost gauge (costReport → a scheduled sample)

Cost isn't an event stream — it's a *standing figure* you sample on a schedule (a cron, a Lambda) and push as a
gauge. Because the library owns the objects, the grounded report uses each segment's **real** measured size:

```ts
import { metrics as otel } from '@opentelemetry/api';

const meter = otel.getMeter('cloud-roaring');
const monthlyUsd = meter.createObservableGauge('cloudroaring.cost.monthly_usd');
// verdict is a 3-state enum → map to an ordinal so you can alert on it: 0 win-big, 1 win, 2 lose-zone.
const VERDICT_RANK = { 'win-big': 0, win: 1, 'lose-zone': 2 } as const;
const verdictRank = meter.createObservableGauge('cloudroaring.cost.verdict_rank');

meter.addBatchObservableCallback(
  async (obs) => {
    for (const name of ['active-us', 'active-eu']) {
      const r = await store.segment(name).costReport({
        workload: { readsPerSec: 200, cacheHitRate: 0.8, loadsPerMonth: 30 },
      });
      obs.observe(monthlyUsd, r.monthlyUSD.total, { segment: name });
      obs.observe(verdictRank, VERDICT_RANK[r.verdict], { segment: name });
    }
  },
  [monthlyUsd, verdictRank],
);
```

Alert when `verdict_rank` hits `2` — the segment has drifted into the **lose-zone** (pay-per-use now exceeds a
flat Redis node), usually because read volume outgrew the cache hit rate. `r.redisCrossover.readsPerSec` gives
the exact read rate where the economics flip *at this report's cache-hit rate* (with the cache off and the
default pricing profile it is about 329 reads/s; every cache hit moves it further out), so you can set the alarm
threshold honestly rather than guessing — and `r.monthlyUSD.byOp` breaks the total into `reads` / `intersects` /
`storage` / `loads` so you can see *what* pushed it over. Loads are modelled only when you pass
`loadsPerMonth` (and `requestsPerLoad` for a multipart upload); `r.assumptions.notes` says so when they are not.

---

## 3. Audit log (audit → append-only sink / SIEM)

Audit events are low-volume, high-value, and must be **durable and tamper-evident** — route them to an
append-only store (CloudWatch Logs, an S3 object-lock bucket, your SIEM), never to the same mutable place as
metrics. The sink adds the timestamp and actor (the library keeps its core free of ambient time/identity):

```ts
import { bulkLoadCrbmGeneration, destroySegment } from '@cloudbitmaps/roaring';
import type { IAuditSink } from '@cloudbitmaps/roaring';

function siemAudit(actor: string): IAuditSink {
  return {
    onEvent(event) {
      // one structured, append-only line per compliance-relevant change
      auditLog.append({
        at: new Date().toISOString(), // the sink owns the clock
        actor, // …and the identity
        ...event, // kind + segment/namespace (+ generation / fromGeneration, generationsDeleted, or segmentsShredded)
      });
    },
  };
}

const audit = siemAudit('batch-loader@svc');

// Pass it to each lifecycle op (audit is not a store-constructor option — these are separate entry points):
await bulkLoadCrbmGeneration(cold, { segment: 'users', generation: 0 }, ids, { registry, audit });
await store.eraseSubject(subjectId, { namespace: 'eu', audit }); // GDPR Art. 17 — one segment.rewrite per segment
await store.dropSegment({ segment: 'users' }, { confirmSegment: 'users', audit }); // retire + reclaim storage
await destroySegment({ segment: 'users' }, { registry }, { confirmSegment: 'users', audit }); // crypto-shred
```

**What lands in the log:** `segment.publish` (a loaded generation became current), `segment.rewrite` (a
generation derived from the segment itself replaced it — `fromGeneration` → `generation`; today the one
emitter is a subject erasure, and it fires at the publish, *before* the superseded generation is collected, so
the record exists the moment the generation without the id is authoritative — no `segment.publish`
accompanies it), and the erasure trail: `segment.erase` fires per segment on a **genuine crypto-shred** (not a
cleartext tombstone, whose bytes stay readable), `segment.dispose` fires per `dropSegment`, and
`eraseNamespace` adds one `namespace.erase` carrying `segmentsShredded` (the honest count actually destroyed,
which may be 0).

**Which event is the receipt.** An auditor asks "prove subject X's data was destroyed on date Y":

- For a whole segment or tenant, a `segment.erase` for that segment is the receipt.
- For one subject, it is the `segment.rewrite` for each segment the id was in, paired with the erasure ledger
  `eraseSubject` returned — `{ erased: true, fromGeneration, generation }` per segment. The event attests that
  the generation without the id became authoritative; the ledger attests that the generation which held it was
  deleted before the call returned. Keep both.
- A `segment.publish` is not a receipt for anything: it says a set was loaded, not what was removed from it.

**`segment.erase`, `segment.rewrite` and `segment.dispose` are deliberately different receipts, and conflating
them would make your dashboard over-attest.**

| Event | What it proves | What it does NOT prove |
|---|---|---|
| `segment.erase` | The wrapped DEK(s) are gone, so the segment's at-rest bytes are unreadable **everywhere — backups, replicas, PITR snapshots, WORM included**. The only erasure claim that survives immutable storage | — |
| `segment.rewrite` | A generation without the erased id is now current, derived from `fromGeneration`. With the ledger entry it came with, the object that held the bit is gone from the bucket | **Not** that every copy is gone. A noncurrent object version, a cross-region replica or a backup can still hold `fromGeneration` until its own lifecycle removes it — for a claim that survives those, the segment has to be encrypted and the receipt is `segment.erase` |
| `segment.dispose` | The segment was tombstoned and its storage reclaimed (`generationsDeleted` Cold generations). Emitted by `dropSegment` — including **every retirement a `retireExpired` sweep performs**, since the sweep forwards its `audit` sink through. A retention-driven fleet will therefore emit these in batches on whatever schedule you gave the sweep | **Not** that the bytes are unreadable. A noncurrent object version, a cross-region replica or a PITR snapshot can still hold the cleartext. Also not that reclamation is *complete* — check `DropResult.generationsRemaining` |

> **One gap worth knowing:** when a sweep later deletes a retired segment's tombstone **row** (registry
> housekeeping — it happens only once the segment's Cold generations are provably gone), **no audit event is
> emitted.** The `segment.dispose` above is the receipt for the data; the row removal is not separately
> attested. If your controls treat the presence of a `destroyed` row as the attestation, run the sweep with
> `purgeTombstones: false` so the rows are kept.

A **cleartext** `dropSegment` emits only `segment.dispose`. An **encrypted** one emits **both**, because both
things genuinely happened. So: count `segment.erase` for an Art. 17 destruction claim, `segment.rewrite` (with
its ledger) for a per-subject erasure, and `segment.dispose` for a retention/lifecycle trail. Never substitute
one for another.

> **KEK rotation is not in this stream** — rotating the key-encryption key is operator-side keystore
> reconfiguration (no library call to hook). Audit it at your KMS/keystore layer. See the audit section of
> [getting-started](./getting-started.md).

---

## Putting it together

A minimal production wiring: **metrics** → your existing OTel/Datadog pipeline (health), a **cron** sampling
`costReport()` → a cost gauge (spend), and an **audit** sink on every lifecycle call → an append-only bucket
(compliance). Three sinks, three screens, one library — and each stays a no-op until you opt in, so the default
hot path pays nothing.
