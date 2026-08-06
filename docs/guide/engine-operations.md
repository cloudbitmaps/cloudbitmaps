# Running the lifecycle engine

The background half of CloudBitmaps — retire what expired, compact what grew dirty, collect superseded
generations — repeated forever, on as many processes as you like, with no coordinator and no per-process config.
This page is the operational contract: **what the engine guarantees, what it cannot do, what you own, and what to
alarm on.**

It is deliberately blunt about the failure modes. A background job that nobody watches is the easiest kind of
software to have silently stopped working for a month, and most of what follows exists because that was true of
an earlier version of this code.

## Table of contents

- [The shape](#the-shape)
- [What you own — the five things the library cannot do for you](#what-you-own--the-five-things-the-library-cannot-do-for-you)
- [The interval and the lease TTL are one decision](#the-interval-and-the-lease-ttl-are-one-decision)
- [What to alarm on](#what-to-alarm-on)
- [Scale: where the ceilings are](#scale-where-the-ceilings-are)
- [Changing `partitions` on a live fleet](#changing-partitions-on-a-live-fleet)
- [Schedulers and Lambda: one loop per invocation](#schedulers-and-lambda-one-loop-per-invocation)
- [Shutdown](#shutdown)

## The shape

```ts
import { createEngineLoop } from '@cloudbitmaps/core';

const loop = createEngineLoop(
  { warm, cold, registry, clock, codec, rng },
  {
    owner: `${host}:${pid}:${uuid}`, // unique per PROCESS — see below
    partitions: 8, // how many ways to split the fleet's WORK
  },
);

await loop.start(); // resolves when stop() is called
```

Every process runs that identical call. **Partition leases** decide who does what: one registry row per
partition, claimed and renewed by conditional write, stolen when a holder stops renewing. There is no leader
election to configure and no shard index to hand out.

Two things about `partitions` that are easy to over-read:

- It splits the **work**, not the **scan**. Each worker still enumerates the registry, because the shard filter
  needs a segment key and only the enumeration yields it. Raise `partitions` when per-segment work dominates, not
  to make the scan cheaper.
- A worker holding **zero** partitions is healthy and normal — it is what every worker beyond the first does when
  partitions are scarce.

## What you own — the five things the library cannot do for you

Ordered by how much damage the omission does. The first matters more than the rest combined.

### 1. A request timeout on the SDK client you inject

**There is no `AbortSignal` anywhere in this library, and no per-call deadline.** That is deliberate: a homegrown
timeout would abandon in-flight requests mid-write, which is worse than waiting. The consequence for a *loop* is
specific — a black-holed connection hangs a cycle **forever**. The process stays alive, nothing throws, and work
silently stops.

Without a client timeout the engine **cannot bound a cycle**, and `stop()` cannot drain. Set one on your AWS SDK
client, your Postgres pool, your Redis client — whatever you injected.

`status().healthy` is defined to catch exactly this state (a cycle that never settles), so it is your backstop.
But a backstop is not a fix.

### 2. `SIGTERM` has to actually arrive

A shell-form `CMD` puts a shell at PID 1, and it does not forward signals. The container then never receives
`SIGTERM`, so **every** stop becomes a `SIGKILL` after the grace period — which is the window that produces the
[unstamped-tombstone repair](disaster-recovery.md#repair-an-unstamped-tombstone-after-a-hard-kill). Use exec-form
`CMD`, or an init that forwards.

### 3. A grace period longer than your stop timeout

`terminationGracePeriodSeconds` (or ECS `stopTimeout`) **≥ the `timeoutMs` you pass `stop()` + a margin**, and
that `timeoutMs` **≥ your p99 cycle**. Otherwise every deploy abandons work mid-flight.

### 4. A unique `owner` per process

Per **process**, not per host. A bare hostname is shared by every process on the box, and two live workers
sharing an owner id is a genuine failure — each reads the other's leases as its own. `${host}:${pid}:${uuid}` is
the shape.

### 5. NTP

Skew larger than `leaseMs / 2` causes compaction-lease thrash. Note that the *partition* lease is immune by
design — it decides liveness from the registry's OCC token, never by comparing another machine's clock — but the
per-segment compaction lease still compares wall clocks.

## The interval and the lease TTL are one decision

**The gap between cycles _is_ the gap between lease renewals.** A worker that renews less often than its own TTL
has its live leases judged dead and stolen — every cycle, forever. Nothing throws; the fleet just churns and each
worker does a fraction of its work while abandoning the rest mid-flight.

This is not hypothetical. An earlier version shipped `DEFAULT_INTERVAL_MS` and `DEFAULT_LEASE_TTL_MS` both equal
to 60 s — set in different modules, so nothing compared them — and the loop's own jitter then pushed the renew
gap past the deadline. Reproduced, holder on its slowest legal sleep against an observer on the plain interval:

```
  h4 o1 o4 h0 o4 h1 o3 h2 o2 h2 o2 h2 o2 h2 o2 h2 o2  →  o4 h0 o4 h1 o3 h2 o2 …
                  ↑
  a HEALTHY worker judged dead: loses all four partitions, abandons what it was
  mid-way through, reconverges, and does it again — periodically, forever
```

**You get this right by default now**: omit `leaseTtlMs` and it is derived as
`derivedLeaseTtlMs(intervalMs, jitter)` — the longest legal cycle gap × 3, so three renewals fit inside one TTL
(198 s at the default 60 s interval). An explicit `leaseTtlMs` that allows fewer than two renewals is **refused at
construction**, with the reason in the message.

The trade, stated: a longer TTL means a **crashed** worker's slice idles longer before a healthy replica takes it
— up to ~200 s at the defaults rather than ~60 s. For retention and compaction that is the right direction.
Nothing here is latency-sensitive; a segment retired three minutes later is fine, and a fleet that reshuffles
every minute is not.

**Driving cycles from your own scheduler?** Then you own this arithmetic. Call
`derivedLeaseTtlMs(yourIntervalMs, 0)` and pass `cycleIntervalMs` so the repair cadence is derived too:

```ts
import { derivedLeaseTtlMs, runLifecycleCycle } from '@cloudbitmaps/core';

const intervalMs = 5 * 60_000; // your cron cadence
await runLifecycleCycle(state, deps, {
  owner,
  cycleIntervalMs: intervalMs, // schedules nothing — it derives `repairEvery`
  leaseTtlMs: derivedLeaseTtlMs(intervalMs, 0),
});
```

## What to alarm on

`status()` is the whole observability surface. Three fields carry almost all the signal.

| Alarm on | Why |
|---|---|
| `healthy === false` | The composite. False before the first cycle, once a cycle has not **settled** recently, once `consecutiveFailedCycles` reaches `unhealthyAfterFailedCycles` (3), or while `lease.pollingTooSlowly`. |
| `phaseFailures.retention` / `.compaction` / `.lease` sustained | *Which* half is broken. Retention failing while compaction succeeds is a different problem from the reverse, and one aggregate counter cannot tell you which. |
| `lease.lost` non-empty **in steady state** | Fleet churn. Convergence churn right after a deploy is normal and bounded; a worker still losing partitions once the fleet has settled means something is taking its leases. |

Two things about `healthy` that are easy to get wrong in a probe:

- **Zero partitions is healthy.** Do not alarm on `partitionsHeld.length === 0`; that is the normal state of
  every worker beyond the first.
- **Use it for liveness carefully.** `staleAfterMs` widens with the backoff on purpose, so a backed-off worker in
  an outage stays healthy rather than being restarted into a tighter loop. But `unhealthyAfterFailedCycles` will
  turn it false during a sustained backend outage — which is correct as a *signal* and wrong as a *restart
  trigger*. Prefer readiness, or set a generous `failureThreshold`.

`healthy` deliberately means more than "the process is up". It means *a cycle settled recently, the cycles are
getting somewhere, and this worker is keeping up with its own leases.* An earlier version meant only the first,
and treated sustained failure as "a separate signal" — which in practice meant no signal, because nothing forces
anyone to read `lastErrors`.

## Scale: where the ceilings are

One cycle performs **two** fleet enumerations — the retention sweep and compaction discovery — and both
materialize their candidate set. Both are capped by `maxScanSegments` (default 250,000) and both **fail loudly**
past it rather than exhausting the heap.

Measured peak heap per scan, in-memory driver, so treat the shape rather than the absolute figures as the finding:

| fleet | compaction discovery | retention fleet scan |
|---|---|---|
| 100k | +81 MB | +68 MB |
| 250k | +128 MB | +123 MB |
| 500k | +209 MB (uncapped) | `BudgetExceededError` |
| 1M | +362 MB (uncapped) | `BudgetExceededError` |

The uncapped column is what an earlier version did, and it is why the ceiling now exists on both. A background
process that OOMs is worse than one reporting that it cannot proceed, because the restart replays the same scan —
and **the first cycle after every restart is the complete fleet repair.**

Above the default, raise it on **both** phases, or the ceiling on one is not a ceiling on the cycle:

```ts
createEngineLoop(deps, {
  owner,
  retention: { maxScanSegments: 1_000_000 },
  compaction: { maxScanSegments: 1_000_000 },
});
```

…and size the container for it. A registry record is a few hundred bytes resident, so a million segments is a few
hundred MB **on top of** the roaring addon, the LRU and your SDK clients.

Most cycles do not pay this. Retention runs the **due index** — cost tracks what is *expiring*, not what the
fleet *holds* — and only the periodic repair pass runs the complete scan. That cadence is derived from your
interval to land about daily; `DEFAULT_REPAIR_EVERY` counts **cycles**, so pass `cycleIntervalMs` (the loop does)
or it cannot be right.

## Changing `partitions` on a live fleet

**A rolling deploy that changes `partitions` has a transient coverage gap.** Two workers running different values
partition the same key space with different moduli, and the lease table cannot express that. Measured on a
P=4 → P=8 rollout: **75 of 200 segments (37.5%) were owned by nobody for two cycles**, then coverage returned.

Nothing is corrupted and nothing is lost — retention and compaction for those segments are simply **delayed** by
the gap window (~2 minutes at the default interval). If that is acceptable, roll and move on.

If it is not, either:

- **Quiesce first.** Stop the fleet, deploy the new `partitions`, start it again. The window becomes the deploy
  itself, and nothing runs with two moduli at once.
- **Roll in one step**, not gradually. The gap lasts as long as the two generations coexist, so a fast cutover is
  a short gap.

**Shrinking `partitions` has a second, permanent effect** and is a recorded deferral: rows for partitions above
the new count are ignored by every worker configured with the smaller value (deliberately — shrinking must not
delete another deployment's leases), so once the last large-`partitions` worker is gone those rows are orphaned.
They are inert, but they linger. Prefer growing, or clean the reserved namespace by hand after a shrink.

## Schedulers and Lambda: one loop per invocation

`runOnce()` is the shape for anything that owns its own schedule — cron, EventBridge, Step Functions. It runs one
cycle and resolves, with no timer, so nothing can silently fail to fire.

**Build the loop inside the handler, not at module scope.**

```ts
export async function handler() {
  const loop = createEngineLoop(deps, { owner: `${ctx.awsRequestId}`, cycleIntervalMs: 60_000 });
  return await loop.runOnce(); // construction is free and side-effect free
}
```

Two reasons, and the second is the sharp one:

- **A loop is single-use.** After `stop()`, `start()` and `runOnce()` throw. Construction is cheap, so a fresh
  loop per invocation is the intended pattern — and it is the only way to get a clean `LifecycleState` rather
  than a half-released lease view.
- **A module-scope loop is poisoned by one timed-out invocation.** `runOnce()` refuses to overlap a cycle,
  because two cycles on one loop share state. If a cycle is still in flight when Lambda freezes or times out, the
  in-flight marker never clears, and **every later invocation on that warm container throws.** Per-invocation
  construction makes that impossible.

`start()` is the wrong call under Lambda regardless: a frozen container does not fire timers, so the loop would
appear to run and do nothing.

## Shutdown

```ts
process.on('SIGTERM', async () => {
  const { drained, released } = await loop.stop({ timeoutMs: 30_000 });
  if (!drained) log.warn('cycle abandoned mid-flight');
  process.exit(0); // the abandoned cycle keeps the loop ref'd
});
```

`stop()` **races** the in-flight cycle against `timeoutMs` rather than awaiting it — nothing here is cancellable,
so an unconditional await is a deadlock dressed as a graceful shutdown. It is idempotent (a second `SIGTERM` does
not start a second shutdown), and the interval sleep is wakeable, so a stop one second into a 30 s interval does
not burn 29 s of your grace period.

Two fields on the result:

- **`drained: false`** means work was abandoned and is unbounded. The usual cause is finding 1 above — no client
  timeout.
- **`released`** may be a **subset** of what was held. An abandoned cycle keeps running and can move a lease row's
  token under the release, whose conditional write then loses; those partitions fall back to ordinary TTL expiry.
  Reported rather than assumed, so it is visible.

After a graceful stop, another worker picks up the released partitions on its next cycle instead of waiting out a
whole TTL.
