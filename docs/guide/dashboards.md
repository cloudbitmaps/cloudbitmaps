# Dashboards & audit: wiring the three signals

CloudBitmaps exposes three independent observability surfaces. They answer different questions and belong on
different screens — don't collapse them into one:

| Surface | Question it answers | Audience | Where it goes |
| --- | --- | --- | --- |
| **Metrics** (`IMetricsSink`) | *Is it healthy and fast?* — volume, latency, cache hit rate | on-call / SRE | ops dashboard (Grafana, Datadog, CloudWatch) |
| **Cost** (`costReport()`) | *What is it costing vs. Redis?* — dollars, crossover | you / FinOps | a cost gauge, reviewed weekly |
| **Audit** (`IAuditSink`) | *Who changed the data, when?* — publish / compact / **erase** | security / compliance | append-only audit log / SIEM |

All three are **off by default**, **vendor-neutral** (CloudBitmaps ships no telemetry dependency — you write a
short adapter), and **exception-safe** (a throwing sink can never break a read, write, or lifecycle op). This
guide shows a worked adapter for each. See [getting-started §10–12](./getting-started.md#10-observability-metrics)
for the API reference.

---

## 1. Operational dashboard (metrics → OpenTelemetry)

The metrics sink pushes raw observations on the I/O path. Map the handful you chart to counters/histograms:

```ts
import { metrics as otel } from '@opentelemetry/api';
import { CloudRoaring } from '@cloudbitmaps/roaring';

const meter = otel.getMeter('cloud-roaring');
const coldBytes = meter.createCounter('cloudroaring.cold.bytes');
const cacheHit = meter.createCounter('cloudroaring.cache.hits');
const cacheMiss = meter.createCounter('cloudroaring.cache.misses');
const opLatency = meter.createHistogram('cloudroaring.op.ms');

const store = new CloudRoaring({
  warm,
  cold,
  metrics: {
    onEvent(e) {
      switch (e.kind) {
        case 'cold.get':
          coldBytes.add(e.bytes);
          break;
        case 'cache':
          (e.hit ? cacheHit : cacheMiss).add(1);
          break;
        case 'op':
          opLatency.record(e.ms, { op: e.name }); // `op` name is a fixed enum — safe as a label
          break;
        // …retry / warm.read / warm.write / intersect as you need them
      }
    },
  },
});
```

**Panels worth having:** cache hit rate (`hits / (hits + misses)` — the single biggest cost lever), cold bytes
read/min, op p50/p99 latency, retry rate (a rising `transient` count means your cloud tier is throttling).

> **Label caveat.** `segment` / `namespace` are *your* strings — unbounded-cardinality and possibly PII. Never
> map them straight to metric labels; the `op` **name** is a safe fixed enum, segment names are not.

---

## 2. Cost gauge (costReport → a scheduled sample)

Cost isn't an event stream — it's a *standing figure* you sample on a schedule (a cron, a Lambda) and push as a
gauge. Because the library owns storage + cache, the grounded report uses each segment's **real** measured size:

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
        workload: { readsPerSec: 200, cacheHitRate: 0.8 },
      });
      obs.observe(monthlyUsd, r.monthlyUSD.total, { segment: name });
      obs.observe(verdictRank, VERDICT_RANK[r.verdict], { segment: name });
    }
  },
  [monthlyUsd, verdictRank],
);
```

Alert when `verdict_rank` hits `2` — the segment has drifted into the **lose-zone** (pay-per-use now exceeds a
flat Redis node), usually from a write-heavy spike. `r.redisCrossover` gives the exact read/write rate where the
economics flip (at this report's cache-hit rate), so you can set the alarm threshold honestly rather than
guessing — and `r.monthlyUSD.byOp` breaks the total into reads / writes / intersects / storage so you can see
*what* pushed it over.

---

## 3. Audit log (audit → append-only sink / SIEM)

Audit events are low-volume, high-value, and must be **durable and tamper-evident** — route them to an
append-only store (CloudWatch Logs, an S3 object-lock bucket, your SIEM), never to the same mutable place as
metrics. The sink adds the timestamp and actor (the library keeps its core free of ambient time/identity):

```ts
import { bulkLoadCrbmGeneration, compactSegment, destroySegment } from '@cloudbitmaps/roaring';
import type { IAuditSink } from '@cloudbitmaps/roaring';

function siemAudit(actor: string): IAuditSink {
  return {
    onEvent(event) {
      // one structured, append-only line per compliance-relevant change
      auditLog.append({
        at: new Date().toISOString(), // the sink owns the clock
        actor, // …and the identity
        ...event, // kind + segment/namespace (+ generation, or segmentsShredded)
      });
    },
  };
}

const audit = siemAudit('batch-loader@svc');

// Pass it to each lifecycle op (audit is not a store-constructor option — these are separate entry points):
await bulkLoadCrbmGeneration(cold, { segment: 'users', generation: 0 }, ids, { registry, audit });
await compactSegment({ segment: 'users' }, deps, { owner: 'worker-1', audit });
await destroySegment({ segment: 'users' }, deps, { confirmSegment: 'users', audit }); // GDPR erasure
```

**What lands in the log:** `segment.publish` (a generation became current), `segment.compact` (a generation was
committed), and — the compliance payoff — an erasure trail: `segment.erase` fires per segment on a **genuine
crypto-shred** (not a cleartext tombstone, whose bytes stay readable), and `eraseNamespace` adds one
`namespace.erase` carrying `segmentsShredded` (the honest count actually destroyed, which may be 0). An auditor
asks "prove subject X's data was destroyed on date Y" — a `segment.erase` for X's segment is that receipt.

> **KEK rotation is not in this stream** — rotating the key-encryption key is operator-side keystore
> reconfiguration (no library call to hook). Audit it at your KMS/keystore layer. See the note in
> [getting-started §12](./getting-started.md#12-audit-trail-security--compliance-events).

---

## Putting it together

A minimal production wiring: **metrics** → your existing OTel/Datadog pipeline (health), a **cron** sampling
`costReport()` → a cost gauge (spend), and an **audit** sink on every lifecycle call → an append-only bucket
(compliance). Three sinks, three screens, one library — and each stays a no-op until you opt in, so the default
hot path pays nothing.
