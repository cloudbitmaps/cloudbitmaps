# Observability

Metrics and the audit trail.

## Observability: metrics

CloudBitmaps can report what it's doing — storage GETs and bytes, cache hit rate, retries, intersection efficiency,
and op latency — through an optional **metrics sink**. It's **off by default** (a no-op — emission is skipped
entirely when unused); pass one and the library pushes typed events to it:

```ts
import { CloudRoaring, CountingMetricsSink } from '@cloudbitmaps/roaring';

const metrics = new CountingMetricsSink(); // a ready-made tally sink
const store = new CloudRoaring({ storage: backend, metrics });

await store.segment('users').has(42);
console.log(metrics.snapshot());
// { storage: { gets, bytes, totalMs }, cache: { hits, misses }, retries: { transient },
//   intersect: { calls, fetchedChunks, skippedChunks }, ops: { has, count, intersectInto, unionInto, andNotInto } }
```

The library emits **vendor-neutral events** — five kinds — so it isn't coupled to any telemetry system; you map
the handful you care about:

| Event | Carries | Fired |
| --- | --- | --- |
| `storage.get` | `segment`, `namespace?`, `bytes`, `ms` | one chunk read from Storage (a cache miss) |
| `cache` | `hit` | every cache lookup |
| `retry` | `reason: 'transient'`, `attempt`, `delayMs` | before each transient-retry backoff wait |
| `intersect` | `op` (`intersect` / `union` / `andNot`), `operands`, `fetchedChunks`, `skippedChunks` | per combine — `skippedChunks` is the chunk-skipping saving (distinct keys never fetched) |
| `op` | `name` (`has` / `count` / `intersectInto` / `unionInto` / `andNotInto`), `ms` | per timed segment op |

A quick look in dev is one line:

```ts
const store = new CloudRoaring({ storage: backend, metrics: { onEvent: (e) => console.log(e) } });
```

**OpenTelemetry** (or Datadog, CloudWatch, …) is a ~12-line adapter you write — CloudBitmaps adds no telemetry
dependency of its own:

```ts
import { metrics as otel } from '@opentelemetry/api';
import { CloudRoaring } from '@cloudbitmaps/roaring';
const meter = otel.getMeter('cloudbitmaps');
const storageBytes = meter.createCounter('cloudbitmaps.storage.bytes');
const cacheHits = meter.createCounter('cloudbitmaps.cache.hits');

const store = new CloudRoaring({
  storage: backend, // S3Storage, GcsStorage, …
  metrics: {
    onEvent(e) {
      if (e.kind === 'storage.get') storageBytes.add(e.bytes); // NB: see the label caveat below
      if (e.kind === 'cache' && e.hit) cacheHits.add(1);
      // …map the events you want to chart
    },
  },
});
```

Events carry **raw observations** (bytes, counts, ms); turning those into dollars is the cost estimator's job
(see [cost](cost.md#cost-estimate-it-then-ground-it)). Two things to keep in mind:

- **`onEvent` runs synchronously on the I/O path** — keep it cheap and non-blocking; offload batching or
  network calls to your own async queue.
- **`segment` / `namespace` are your own strings** — they may be PII and are unbounded-cardinality. Don't map
  them to per-series metric labels/tags unless your names are known low-cardinality and PII-free (aggregate,
  bucket, or scrub inside the sink instead). Events never contain bitmap contents or ids — only names, counts,
  bytes, and timings.

A sink that throws can never break a read — its exceptions are swallowed (best-effort).

## Audit trail: security & compliance events

Separate from metrics — which reports *volume* (bytes, latency, hit rate) — the **audit sink** records the
handful of **compliance-relevant state changes** an auditor cares about: when a segment's data was published or
a load of it refused, when its pointer was rolled back, and when it was **rewritten**, **erased** or disposed of.
It's the natural feed for an append-only audit log / SIEM, and doubles as your
GDPR Art. 30 "record of processing" for the erasure path. Like metrics, it's an injected `IAuditSink`, it's
**off by default** (a no-op), and a throwing sink can never break the operation it observes.

Unlike metrics, audit isn't a store-constructor option — the events fire from the **operations that write**,
which are separate entry points, so you pass `audit` to each: a load (`store.load`), an `*Into`
materialisation, a rollback (`store.rollback`), an erasure (`store.eraseSubject`), a drop (`store.dropSegment`), a
crypto-shred (`destroySegment`, `eraseNamespace`) and the retention sweep (`store.retireExpired`):

```ts
import { RecordingAuditSink, destroySegment } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink(); // a ready-made in-memory recorder (or bring your own onEvent)

// A generation is published (the segment is encrypted — a keystore is wired on the store, see encryption):
await store.load({ segment: 'users' }, ids, { audit });
// A subject erasure — a rewrite of the current generation without one id:
await store.eraseSubject(userId, { namespace: 'eu', audit });
// A GDPR crypto-shred — the key wrappings are dropped:
await destroySegment({ segment: 'users' }, { registry: backend.registry }, { confirmSegment: 'users', audit });

audit.snapshot();
// [ { kind: 'segment.publish', segment: 'users', generation: 0 },
//   { kind: 'segment.rewrite', namespace: 'eu', segment: '…', fromGeneration: 4, generation: 5 },
//   { kind: 'segment.erase',   segment: 'users' } ]
// (segment.erase fires only for an ENCRYPTED segment — a cleartext tombstone leaves the bytes readable.)
```

The events are **vendor-neutral** — seven kinds, each carrying the segment's name and namespace, or, for
`namespace.erase`, the namespace's:

| Event | Fired when | Extra fields |
| --- | --- | --- |
| `segment.publish` | a load — `store.load` or an `*Into` verb — makes a generation the current one | `generation` |
| `segment.load-refused` | a load did not publish: a guard refused its result, the segment's row changed while it wrote, or another load took its generation number first, in which case it wrote nothing and `cardinality` is `0` | `generation`, `reason`, `cardinality` |
| `segment.rollback` | `store.rollback` moved the pointer to a generation it names, still in the bucket: **backwards**, or forward with `allowForward` — the one pointer move no automatic path makes | `fromGeneration`, `generation` |
| `segment.rewrite` | a generation derived from the segment itself became current in place of `fromGeneration` — today, an erasure rewrite (`eraseSubject`), emitted at the publish, before the superseded generation is collected | `fromGeneration`, `generation` |
| `segment.erase` | a **genuine crypto-shred** — not the idempotent re-run, and not a cleartext tombstone (bytes stay readable) | — |
| `segment.dispose` | `dropSegment` tombstoned a segment and swept its storage — the weaker, storage-reclamation attestation; an encrypted drop emits **both** this and `segment.erase` | `generationsDeleted` |
| `namespace.erase` | `eraseNamespace` runs; also one `segment.erase` per segment actually shredded | `segmentsShredded` |

Same two caveats as metrics apply: **`onEvent` runs synchronously** on the operation (keep it cheap; offload
network writes to your own queue), and **`segment`/`namespace` are your own strings** — treat them as
potentially-PII when you forward them. Events never contain ids or bitmap contents.

> **Not yet emitted — KEK rotation.** Rotating the key-encryption key here is *operator-side keystore
> reconfiguration* (wrappings are key-id-tagged and need no data re-encryption), so there's no library call to
> hook a `kek.rotate` event onto. Audit key changes at your keystore/KMS layer; a future per-segment
> `rewrapSegment()` op would add a library-side rotation event.

For a worked example that routes metrics, cost, and audit to real dashboards, see the
[dashboards guide](./dashboards.md).
