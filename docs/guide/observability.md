# Observability

Two optional sinks report what the library does: a **metrics sink** for volume and latency, and an **audit sink** for
compliance-relevant state changes. Both are off by default, both are vendor-neutral, and a throwing sink never breaks
the operation it observes. For a worked example that routes both to real dashboards, see the
[dashboards guide](dashboards.md). To turn raw counts into dollars, see [cost](cost.md#cost-estimate-it-then-ground-it).

## Metrics

CloudBitmaps can report storage GETs and bytes, cache hit rate, retries, intersection efficiency and op latency
through a **metrics sink**. It is off by default (a no-op: emission is skipped entirely when unused). Pass one and the
library pushes typed events to it:

```ts
import { CloudRoaring, CountingMetricsSink } from '@cloudbitmaps/roaring';

const metrics = new CountingMetricsSink(); // a ready-made tally sink
const store = new CloudRoaring({ storage: backend, metrics });

await store.load({ segment: 'users' }, [42]);
await store.segment('users').has(42);
console.log(metrics.snapshot());
// { storage: { gets, bytes, totalMs }, cache: { hits, misses }, retries: { transient },
//   intersect: { calls, fetchedChunks, skippedChunks }, ops: { has, count, intersectInto, unionInto, andNotInto, materializeMany } }
```

The library emits six kinds of vendor-neutral events, so it is not coupled to any telemetry system. You map the
handful you care about:

| Event | Carries | Fired |
| --- | --- | --- |
| `storage.get` | `segment`, `namespace?`, `bytes`, `ms` | one request for chunks to Storage: a range request of a combine, `iterate` or `store.materializeMany`, which carries every chunk the read needs from a stretch of the object (`bytes` is the range's, the gaps between chunks it reads across included), or the one chunk of a point read — the number of chunk GETs, one per request however many callers were waiting on a point read. Pointer and index reads are not counted. A range a read had already requested when the caller stopped is reported too, when it settles, since it is billed. One event is one request's outcome, its retries included, and one that failed reports 0 `bytes`. A chunk a small generation's reader kept from its open is no request and reports none |
| `cache` | `hit` | every cache lookup, when a cache is configured. A miss is a lookup that found no cached chunk; it is counted even when the caller then waits on a point read another caller already has open, and a combine or `iterate` looks up every chunk it needs when it opens, so misses can exceed `storage.get` events, which are fewer than the chunks when a range carries several |
| `retry` | `reason: 'transient'`, `attempt`, `delayMs` | before each transient-retry backoff wait |
| `intersect` | `op` (`intersect` / `union` / `andNot`), `operands`, `fetchedChunks`, `skippedChunks` | per combine — `skippedChunks` is the chunk-skipping saving (distinct keys never fetched) |
| `op` | `name` (`has` / `count` / `intersectInto` / `unionInto` / `andNotInto` / `materializeMany`), `ms` | per timed op |
| `advisory` | `code` (`'socket-pool-below-window'`), `driver`, `bucket`, `maxSockets`, `threshold`, `concurrency` | once, after the first S3 read finishes (even one that fails), when the client's socket pool is smaller than `threshold` (twice the default `concurrency` of 32, so 64); see [socket sizing](production.md#reliability-retries-backoff--timeouts). Not a fault, and silent for a handler the store cannot read. `bucket` is your own string: do not use it as a metric label unless your bucket names are fixed |

`store.materializeMany` emits one `op` event per call, `name: 'materializeMany'`, timed from its first request (the
pins) to its last publish, and a `storage.get` event per range request it sends. The `op` event fires when the call
ends, also when it throws after its first request (a budget refusal, a failed pin), and not when its input checks
refuse it; a fed call's time includes the time spent waiting on the feed. A range serves every output of its group,
so the events count the call's requests, not requests per output. It emits no `cache`
event, since it never looks up the chunk cache, and no `intersect` event, since an output is an expression over
several operators. A dry run (`dryRun: true`) emits the same `op` event and the same `storage.get` events, and no
audit event, since it publishes nothing. So an `*Into` call that moves into a batch leaves its own name's op series and the chunk-skipping
and cache-hit series: the batch's latency is one series for the whole call, not comparable with a per-output `*Into`
one, and its reads stay in the request series. The `stats` on its result carry the rest (bytes, chunks pruned, memory
high-water mark), and its `audit` sink fires per output.

A quick look in dev is one line:

```ts
const store = new CloudRoaring({ storage: backend, metrics: { onEvent: (e) => console.log(e) } });
```

**OpenTelemetry** (or Datadog, CloudWatch, ...) is a 12-line adapter you write. CloudBitmaps adds no telemetry
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

Events carry raw observations (bytes, counts, ms). Two things to keep in mind:

- **`onEvent` runs synchronously on the I/O path** — keep it cheap and non-blocking; offload batching or
  network calls to your own async queue.
- **`segment` / `namespace` are your own strings** — they may be PII and are unbounded-cardinality. Don't map
  them to per-series metric labels/tags unless your names are known low-cardinality and PII-free (aggregate,
  bucket, or scrub inside the sink instead). Events never contain bitmap contents or ids — only names, counts,
  bytes, and timings.

A sink that switches on `kind` with a `never` check in its default branch, as `CountingMetricsSink` does, stops
compiling at `advisory` until it has a case for it: ignoring the event is fine. A sink with an ordinary default branch needs no change.

A sink that throws can never break a read: its exceptions are swallowed, and so is the rejection of an `async onEvent`,
which would otherwise be an unhandled rejection that ends a Node process.

## Audit trail: security & compliance events

Metrics report volume (bytes, latency, hit rate). The **audit sink** records the handful of compliance-relevant state
changes an auditor cares about: when a segment's data was published or a load of it refused, when its pointer was
rolled back, and when it was rewritten, erased or disposed of. It is the natural feed for an append-only audit log or
SIEM, and doubles as your GDPR Art. 30 "record of processing" for the erasure path. Like metrics, it is an injected
`IAuditSink`, it is off by default (a no-op), and a throwing sink, or an async one that rejects, can never break the
operation it observes.

Unlike metrics, audit is not a store option. The events fire from the operations that write, which are separate entry
points, so you pass `audit` to each: a load (`store.load`), an `*Into` materialization, a rollback (`store.rollback`),
an erasure (`store.eraseSubject`), a drop (`store.dropSegment`), a crypto-shred (`destroySegment`, `eraseNamespace`)
and the retention sweep (`store.retireExpired`):

```ts
import { RecordingAuditSink, destroySegment } from '@cloudbitmaps/roaring';

// Your values: the ids to load and the subject to erase.
declare const ids: Iterable<number>;
declare const userId: number;

const audit = new RecordingAuditSink(); // a ready-made in-memory recorder (or bring your own onEvent)

// A generation is published (the segment is encrypted: a keystore is wired on the store, see encryption):
await store.load({ segment: 'users' }, ids, { audit });
// A subject erasure — a rewrite of the current generation without one id:
await store.eraseSubject(userId, { namespace: 'eu', audit });
// A GDPR crypto-shred — the key wrappings are dropped:
await destroySegment({ segment: 'users' }, { registry: backend.registry }, { confirmSegment: 'users', audit });

audit.snapshot();
// [ { kind: 'segment.publish', segment: 'users', incarnation: '3f9c…', generation: 0 },
//   { kind: 'segment.rewrite', namespace: 'eu', segment: '…', incarnation: 'a71e…', fromGeneration: 4, generation: 5 },
//   { kind: 'segment.erase',   segment: 'users', incarnation: '3f9c…' } ]
// (segment.erase fires only for an ENCRYPTED segment — a cleartext tombstone leaves the bytes readable.)
```

The events are vendor-neutral. There are eight kinds, each carrying the segment's name and namespace, or, for
`namespace.erase`, the namespace's.

Every `segment.*` event also carries `incarnation`, the id of the segment's registry row as the operation found or
wrote it. A segment whose row was purged and created again starts its generations at `0` again, so a name and a
generation number can belong to two different lives of the segment; the incarnation tells them apart. Every write of a
row keeps its incarnation, so all the events of one life of a segment share it. Within one life a generation number
still does not name one object for good: a number whose object was deleted, such as a refused load's or one an erasure
deleted above the pointer, can be taken again by a later load, so read a segment's events in the order they arrived.
It is absent when the row's token carries no incarnation id, for example from a registry of your own that issues
tokens in another form, and on a `segment.load-refused` from a load that found no row.

| Event | Fired when | Extra fields |
| --- | --- | --- |
| `segment.publish` | a load — `store.load`, an `*Into` verb or an output of `store.materializeMany` — makes a generation the current one | `generation` |
| `segment.load-refused` | a load did not publish (a `materializeMany` dry run emits none, nor any other audit event): a guard refused its result, the segment's row changed while it wrote, or another load took its generation number first, in which case it wrote nothing and `cardinality` is `0`. `unanswered: true` marks a refusal that follows a registry write that got no answer: that write may have landed first, so the generation may have been current for a while before it was replaced | `generation`, `reason`, `cardinality`, and `unanswered` when it applies |
| `segment.rollback` | `store.rollback` moved the pointer to a generation it names, still in the bucket: **backwards**, or forward with `allowForward` — the one pointer move no automatic path makes | `fromGeneration`, `generation` |
| `segment.rewrite` | a generation derived from the segment itself became current in place of `fromGeneration` — today, an erasure rewrite (`eraseSubject`), emitted at the publish, before the superseded generation is collected | `fromGeneration`, `generation` |
| `segment.collect` | an erasure (`eraseSubject`) found the id only outside the current generation, in a retained older generation, above the pointer after a rollback, or in an object left under a tombstone, and deleted the generations holding it without rewriting any; emitted once a listing of the bucket shows no generation holding the id | `fromGeneration` (the newest generation that held it), `collected` (every generation the call deleted, ascending) |
| `segment.erase` | a **genuine crypto-shred** — not the idempotent re-run, and not a cleartext tombstone (bytes stay readable) | — |
| `segment.dispose` | `dropSegment` tombstoned a segment and swept its storage — the weaker, storage-reclamation attestation; an encrypted drop emits **both** this and `segment.erase` | `generationsDeleted` |
| `namespace.erase` | `eraseNamespace` runs, after every segment is done; also one `segment.erase` per segment actually shredded, emitted as each finishes (segments are shredded eight at a time, so those arrive in no fixed order) | `segmentsShredded` |

The same two caveats as metrics apply. **`onEvent` runs synchronously** on the operation, so keep it cheap and offload
network writes to your own queue. **`segment` and `namespace` are your own strings**, so treat them as potentially PII
when you forward them. Events never contain ids or bitmap contents.

> **Not yet emitted: KEK rotation.** Rotating the key-encryption key is operator-side keystore reconfiguration
> (wrappings are key-id-tagged and need no data re-encryption), so there is no library call to hook a `kek.rotate`
> event onto. Audit key changes at your keystore or KMS layer. A future per-segment `rewrapSegment()` would add a
> library-side rotation event.
