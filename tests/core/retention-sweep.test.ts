import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  DEFAULT_RETIRE_LIMIT,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  MIN_EXPIRES_AT_MS,
  bulkLoadCrbmGeneration,
  compactSegment,
  destroySegment,
  retireExpired,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { BudgetExceededError, UnsupportedError, ValidationError } from '@/core/errors';
import { clearSegmentRetention } from '@/index';
import type { CompactionDeps, DropDeps, RetireEntry, SegmentRef } from '@/index';
import type { IColdDriver, IRegistryDriver } from '@/core/ports';

/**
 * The retention **sweep** — the piece that acts on the policies. Part 3 of 3.
 *
 * What these tests hold it to, in order of how much damage the alternative does:
 *
 *  - **It retires only what expired.** A segment with no policy, an unexpired one, and one whose policy is
 *    malformed are all left alone — and the malformed one is *reported*, because reading as "never expires" on a
 *    segment someone believes is expiring is the silence that costs a retention commitment.
 *  - **It delegates to `dropSegment`.** The Warm → registry → Cold ordering and the re-sweep are load-bearing;
 *    a second implementation of them in a loop is how a sweep loses data. The tests assert the *effects* that
 *    ordering produces (Warm rows gone, generations gone, the tombstone in place).
 *  - **A fault is a ledger entry, not an exception.** One unreadable segment must not decide the fate of the
 *    other 99, and must not leave the caller unable to say which were retired.
 *  - **`limit` and `dryRun` actually bound it.** These are the two things standing between a bad `expiresAt`
 *    backfill and a deleted fleet.
 *  - **Purging a tombstone cannot strand storage or resurrect data.** Deleting the row makes the segment
 *    invisible to `gcOrphanGenerations` and makes late Warm rows readable again, so both tiers must be provably
 *    empty first.
 */

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY; // "now" in these tests
const EXPIRED = T0 - DAY;
const FUTURE = T0 + DAY;

function world() {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  // A fake clock on the registry too: `updatedAt` is what the tombstone-grace window is measured from, so a
  // real-time stamp against a synthetic `now` would make every grace comparison meaningless.
  const registry = new MemoryRegistryDriver({ now: () => T0 });
  const dropDeps: DropDeps = { registry, warm, cold };
  const compactionDeps: CompactionDeps = { cold, warm, registry, clock: { now: () => T0 } };
  const clock = { now: () => T0, sleep: (): Promise<void> => Promise.resolve() };
  const store = (): CloudRoaring => new CloudRoaring({ warm, cold, registry, retry: false, clock });
  return { cold, warm, registry, dropDeps, compactionDeps, store };
}

async function warmRowCount(warm: MemoryWarmDriver, ref: SegmentRef): Promise<number> {
  let n = 0;
  for await (const row of warm.listChunks(ref)) {
    void row;
    n += 1;
  }
  return n;
}

async function coldGenerations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

const bySegment = (entries: readonly RetireEntry[]): Map<string, RetireEntry> =>
  new Map(entries.map((e) => [e.segment, e]));

describe('retireExpired — selection', () => {
  it('retires the expired segments and leaves everything else alone', async () => {
    const w = world();
    const store = w.store();
    // An expired accumulator (warm-only), an expired Cold-backed segment, one not due yet, and one with no policy.
    await store.segment('gone-warm').addMany([1, 2, 100_000]);
    await store.setRetention({ segment: 'gone-warm' }, { expiresAt: EXPIRED });

    await bulkLoadCrbmGeneration(w.cold, { segment: 'gone-cold', generation: 0 }, [3, 4], {
      registry: w.registry,
    });
    await store.setRetention({ segment: 'gone-cold' }, { expiresAt: EXPIRED });

    await store.segment('later').add(5);
    await store.setRetention({ segment: 'later' }, { expiresAt: FUTURE });

    await bulkLoadCrbmGeneration(w.cold, { segment: 'forever', generation: 0 }, [6], {
      registry: w.registry,
    });

    const res = await retireExpired(w.dropDeps, { now: T0 });
    expect(res).toMatchObject({
      scanned: 4,
      eligible: 2,
      retired: 2,
      limited: false,
      dryRun: false,
    });

    const entries = bySegment(res.entries);
    expect(entries.get('gone-warm')).toMatchObject({ action: 'retired', expiresAt: EXPIRED });
    expect(entries.get('gone-cold')).toMatchObject({ action: 'retired', expiresAt: EXPIRED });
    expect(entries.has('later')).toBe(false); // not due — not in the ledger at all
    expect(entries.has('forever')).toBe(false); // no policy — not the sweep's business

    // The effects, not just the report: both retired segments are empty, the others untouched.
    expect(await warmRowCount(w.warm, { segment: 'gone-warm' })).toBe(0);
    expect(await coldGenerations(w.cold, { segment: 'gone-cold' })).toEqual([]);
    expect(await w.store().segment('gone-warm').count()).toBe(0);
    expect(await w.store().segment('gone-cold').count()).toBe(0);
    expect(await w.store().segment('later').count()).toBe(1);
    expect(await w.store().segment('forever').count()).toBe(1);
  });

  it('treats an expiry exactly at `now` as due (>= , not >)', async () => {
    const w = world();
    await w.store().segment('s').add(1);
    await w.store().setRetention({ segment: 's' }, { expiresAt: T0 });
    const res = await retireExpired(w.dropDeps, { now: T0 });
    expect(res.retired).toBe(1);
  });

  it('reports a malformed policy instead of silently treating it as "never expires"', async () => {
    const w = world();
    await w.registry.create(
      { segment: 'bad' },
      { currentGen: null, retention: { expiresAt: 'x' } },
    );
    await w.store().segment('bad').add(1);

    const res = await retireExpired(w.dropDeps, { now: T0 });
    expect(res).toMatchObject({ scanned: 1, eligible: 0, retired: 0 });
    expect(res.entries).toEqual([
      { segment: 'bad', namespace: undefined, action: 'skipped', reason: 'invalid-policy' },
    ]);
    expect(await w.store().segment('bad').count()).toBe(1); // and nothing was deleted
  });

  it('scopes to one namespace', async () => {
    const w = world();
    for (const namespace of ['a', 'b']) {
      await w.store().segment('day', { namespace }).add(1);
      await w.store().setRetention({ namespace, segment: 'day' }, { expiresAt: EXPIRED });
    }
    const res = await retireExpired(w.dropDeps, { now: T0, namespace: 'a' });
    expect(res.scanned).toBe(1);
    expect(res.retired).toBe(1);
    expect(await w.store().segment('day', { namespace: 'b' }).count()).toBe(1);
  });
});

describe('retireExpired — the guards that make it safe to point at a fleet', () => {
  it('dryRun reports what it would retire and deletes nothing', async () => {
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { segment: 'd', generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.store().segment('d').add(3); // a live Warm delta too
    await w.store().setRetention({ segment: 'd' }, { expiresAt: EXPIRED });

    const res = await retireExpired(w.dropDeps, { now: T0, dryRun: true });
    // `retired` counts DELETIONS, so it is 0 here; `wouldRetire` is the preview count. A single counter meaning
    // "deleted" in one mode and "would delete" in another puts phantom deletions on any dashboard that sums it —
    // and the CLI emits exactly this, in the mode the docs tell you to start with.
    expect(res).toMatchObject({ eligible: 1, retired: 0, wouldRetire: 1, dryRun: true });
    const entry = res.entries[0]!;
    expect(entry.action).toBe('would-retire');
    // The preview goes through `dropSegment` itself, so the numbers are the real ones, not a guess.
    expect(entry.action === 'would-retire' && entry.result.wouldDelete).toEqual([0]);
    expect(entry.action === 'would-retire' && entry.result.wouldDeleteWarmRows).toBe(1);

    expect(await coldGenerations(w.cold, { segment: 'd' })).toEqual([0]);
    expect(await warmRowCount(w.warm, { segment: 'd' })).toBe(1);
    expect((await w.registry.get({ segment: 'd' }))!.status).toBe('active');
    expect(await w.store().segment('d').count()).toBe(3);
  });

  it('caps a cycle at `limit`, says so, and names the deferred segments', async () => {
    // The guard against a bad backfill or clock skew retiring the whole fleet in one pass.
    const w = world();
    for (const day of ['d1', 'd2', 'd3']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    const res = await retireExpired(w.dropDeps, { now: T0, limit: 2 });
    expect(res).toMatchObject({ retired: 2, limited: true });
    // The sweep stops SCANNING at the cap rather than recording a deferral per remaining row: on a fleet behind a
    // bad backfill those entries scale with the fleet instead of the batch (250k rows ≈ 15 MB of ledger the caller
    // never asked for, which the CLI then tried to serialise into one log line). `limited` carries the signal.
    expect(res.entries.filter((e) => e.action === 'skipped')).toEqual([]);
    expect(res.entries).toHaveLength(2);
    // The ledger arithmetic an operator's re-run loop depends on for termination.
    expect(res.retired + res.wouldRetire).toBeLessThanOrEqual(2);
    expect(res.limited).toBe(res.eligible > res.retired);

    // Re-running finishes the job — the cap defers, it does not drop.
    const second = await retireExpired(w.dropDeps, { now: T0, limit: 2 });
    expect(second.retired).toBe(1);
    expect(second.limited).toBe(false);
  });

  it('isolates a per-segment fault into the ledger and keeps sweeping', async () => {
    const w = world();
    for (const day of ['ok1', 'boom', 'ok2']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    // A Cold driver that cannot enumerate one segment — the shape of a partial outage mid-sweep.
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      getTail: (k, m) => w.cold.getTail(k, m),
      delete: (k) => w.cold.delete(k),
      list: (ref) => {
        if (ref.segment !== 'boom') return w.cold.list(ref);
        // An iterable that rejects when drained — a cold tier that is up for most segments and not for this one.
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('cold list unavailable')),
          }),
        };
      },
    };

    const res = await retireExpired({ ...w.dropDeps, cold }, { now: T0 });
    expect(res.scanned).toBe(3);
    expect(res.retired).toBe(3); // all three ARE retired — see below
    const entries = bySegment(res.entries);
    // `boom` faulted, but AFTER `dropSegment` cleared Warm and wrote the tombstone — so the segment really is
    // retired and reads empty. Reporting it as `skipped` said the opposite of the truth, and the ledger's own
    // contract calls a skipped entry "a segment that still holds data". It is a retirement carrying a `fault`.
    expect(entries.get('boom')).toMatchObject({
      action: 'retired',
      fault: 'failed: cold list unavailable',
    });
    expect(await w.store().segment('ok1').count()).toBe(0);
    expect(await w.store().segment('ok2').count()).toBe(0);
    // `boom` is NOT intact, and that is `dropSegment`'s documented ordering rather than a sweep bug: Warm is
    // cleared and the tombstone flipped BEFORE the Cold sweep, precisely so a failure part-way leaks bytes
    // instead of leaving a segment that still answers `true`. What the sweep owes the caller is the entry above.
    expect((await w.registry.get({ segment: 'boom' }))!.status).toBe('destroyed');
    // And the leak is not silent on the next pass either: the tombstone carries the sweep's own retirement stamp,
    // so a later sweep re-examines it, cannot prove the storage is gone, and says so rather than purging the row.
    const followUp = await retireExpired({ ...w.dropDeps, cold }, { now: T0 + 2 * DAY });
    expect(bySegment(followUp.entries).get('boom')).toMatchObject({
      action: 'skipped',
      reason: 'failed: cold list unavailable',
    });
  });

  it('fails loudly rather than half-sweeping a fleet bigger than `maxScanSegments`', async () => {
    const w = world();
    for (const day of ['d1', 'd2', 'd3']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    await expect(retireExpired(w.dropDeps, { now: T0, maxScanSegments: 2 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(await w.store().segment('d1').count()).toBe(1); // nothing was retired before the throw
  });

  it('validates its arguments', async () => {
    const w = world();
    for (const bad of [0, -1, 1.5]) {
      await expect(retireExpired(w.dropDeps, { now: T0, limit: bad })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(retireExpired(w.dropDeps, { now: NaN })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      retireExpired(w.dropDeps, { now: T0, tombstoneGraceMs: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(retireExpired(w.dropDeps, { now: T0, maxScanSegments: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('defaults the per-cycle cap to a bounded batch', () => {
    // Named so a change to the default is a deliberate, reviewed edit rather than a silent widening.
    expect(DEFAULT_RETIRE_LIMIT).toBe(100);
  });
});

describe('retireExpired — what the adversarial review found', () => {
  it('bounds destruction when every drop faults — the limit must charge ATTEMPTS', async () => {
    // The finding two reviews reproduced independently, and the worst one in the set. `dropSegment` deletes Warm
    // and writes the tombstone BEFORE sweeping Cold, so a fault in the Cold phase is a segment that is already
    // retired. Charging the cap on *success* meant a partial cold outage marched through the entire fleet with the
    // limit never engaging, reporting `retired: 0, limited: false` — a "completed sweep that retired nothing" —
    // while every Warm row in the namespace was deleted. For an encrypted fleet each of those is an irreversible
    // crypto-shred, so a transient S3 5xx could have destroyed keys fleet-wide.
    const w = world();
    for (const day of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      getTail: (k, m) => w.cold.getTail(k, m),
      delete: (k) => w.cold.delete(k),
      list: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('cold list unavailable')),
        }),
      }),
    };

    const res = await retireExpired({ ...w.dropDeps, cold }, { now: T0, limit: 2 });
    expect(res.limited).toBe(true); // …and it says so, rather than looking like a clean pass
    let destroyed = 0;
    for (const day of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      if ((await w.registry.get({ segment: day }))?.status === 'destroyed') destroyed += 1;
    }
    expect(destroyed).toBe(2); // exactly the batch the caller authorised — not the fleet
  });

  it('never purges a GDPR crypto-shred tombstone, even one that carried a policy', async () => {
    // Attribution used to be INFERRED from "destroyed + an expired policy", and that inference is false:
    // `shredSegment` never touches `retention`, so the ordinary ordering — set a 30-day policy, then a
    // right-to-erasure request arrives mid-window and you `destroySegment` — leaves a crypto-shred tombstone
    // carrying an expired policy. Deleting that row destroys the local attestation for an Art. 17 execution and
    // un-fences the name for every writer. The sweep now purges only rows it stamped itself.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world();
    const minted = await keystore.createDek();
    await w.registry.create({ segment: 'gdpr' }, { currentGen: 0, wrappedDeks: minted.wrapped });
    await w.store().setRetention({ segment: 'gdpr' }, { expiresAt: EXPIRED });
    await destroySegment(
      { segment: 'gdpr' },
      { registry: w.registry, warm: w.warm },
      { confirmSegment: 'gdpr' },
    );
    const shredded = (await w.registry.get({ segment: 'gdpr' }))!;
    expect(shredded.status).toBe('destroyed');
    expect(shredded.retention).toMatchObject({ expiresAt: EXPIRED }); // the policy really does survive a shred

    const res = await retireExpired(w.dropDeps, { now: T0 + 365 * DAY });
    expect(res.tombstonesPurged).toBe(0);
    expect((await w.registry.get({ segment: 'gdpr' }))!.status).toBe('destroyed'); // attestation intact
  });

  it('honours a clearRetention that lands mid-sweep', async () => {
    // The enumeration is a snapshot, and on a fleet the gap between drawing it and reaching a given segment is the
    // whole sweep — minutes. Cancelling an expiry is precisely the operator's recovery action for a bad backfill,
    // and it did not work if a sweep was already running: the segment was retired from the stale copy.
    const w = world();
    for (const day of ['a', 'b']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    // Cancel `b`'s policy while the sweep is between segments — modelled by clearing it during `a`'s drop.
    const registry: IRegistryDriver = {
      capabilities: () => w.registry.capabilities(),
      get: (ref) => w.registry.get(ref),
      create: (ref, rec) => w.registry.create(ref, rec),
      compareAndSwap: async (ref, expected, patch) => {
        const res = await w.registry.compareAndSwap(ref, expected, patch);
        if (ref.segment === 'a' && patch.status === 'destroyed') {
          await clearSegmentRetention({ segment: 'b' }, { registry: w.registry });
        }
        return res;
      },
      list: (ns) => w.registry.list(ns),
      delete: (ref) => w.registry.delete(ref),
    };

    const res = await retireExpired({ ...w.dropDeps, registry }, { now: T0 });
    expect(res.retired).toBe(1);
    expect(bySegment(res.entries).get('b')).toMatchObject({
      action: 'skipped',
      reason: 'policy-changed',
    });
    expect(await w.store().segment('b').count()).toBe(1); // saved
  });

  it('does not brick a name whose segment never had any data', async () => {
    // `setRetention` mints a row for ANY name, including a typo'd or namespace-less one. Left as a tombstone that
    // row fences the name against every writer — permanently, if tombstones are kept. Nothing existed, so nothing
    // a row delete could resurrect: the sweep removes the row instead of bricking the name.
    const w = world();
    await w.store().setRetention({ segment: 'typo' }, { expiresAt: EXPIRED });

    const res = await retireExpired(w.dropDeps, { now: T0 });
    expect(res.retired).toBe(1);
    expect(await w.registry.get({ segment: 'typo' })).toBeNull(); // no tombstone left behind
    // And the name is usable again, rather than refused forever by a fence for data that never existed.
    await w.store().segment('typo').add(1);
    expect(await w.store().segment('typo').count()).toBe(1);
  });

  it('survives a malformed retention blob without abandoning the sweep', async () => {
    // A stored `retention: null` used to throw an untyped TypeError from `readRetentionPolicy` — called outside the
    // per-segment try — so one bad row aborted the fleet sweep and the healthy expired segment beside it was never
    // retired. Reproduced by two reviews.
    const w = world();
    await w.registry.create({ segment: 'bad' }, { currentGen: null });
    // Bypass the (now-strict) write boundary the way a hand-edit or an older writer would.
    const rec = (await w.registry.get({ segment: 'bad' }))!;
    (rec as { retention?: unknown }).retention = null;
    await w.store().segment('good').add(1);
    await w.store().setRetention({ segment: 'good' }, { expiresAt: EXPIRED });

    const res = await retireExpired(w.dropDeps, { now: T0 });
    expect(res.retired).toBe(1); // the healthy one still went
    expect(await w.store().segment('good').count()).toBe(0);
  });

  it('rejects a `now` that looks like epoch seconds', async () => {
    // The mirror of `MIN_EXPIRES_AT_MS` on the comparison side, and the dangerous direction: a clock in the wrong
    // units makes every policy in the fleet look expired.
    const w = world();
    await expect(retireExpired(w.dropDeps, { now: Math.floor(T0 / 1000) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('forwards the audit sink, and an encrypted retirement is a real crypto-shred', async () => {
    // Retiring an encrypted segment discards its DEK wrappings, which is irreversible and must emit
    // `segment.erase` — the receipt a compliance dashboard reads — on top of `segment.dispose`. Neither was
    // asserted anywhere, and deleting the `audit:` forward passed the whole suite.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world();
    const events: Array<{ kind: string; segment?: string }> = [];
    const audit = { onEvent: (e: { kind: string; segment?: string }) => void events.push(e) };

    await w.store().segment('plain').add(1);
    await w.store().setRetention({ segment: 'plain' }, { expiresAt: EXPIRED });
    const minted = await keystore.createDek();
    await w.registry.create({ segment: 'enc' }, { currentGen: null, wrappedDeks: minted.wrapped });
    await w.store().setRetention({ segment: 'enc' }, { expiresAt: EXPIRED });

    await retireExpired(w.dropDeps, { now: T0, dryRun: true, audit });
    expect(events).toEqual([]); // a preview attests to nothing

    await retireExpired(w.dropDeps, { now: T0, audit });
    expect(
      events
        .filter((e) => e.kind === 'segment.dispose')
        .map((e) => e.segment)
        .sort(),
    ).toEqual(['enc', 'plain']);
    // …and the irreversible one is distinguished, because `segment.erase` claims "unreadable everywhere".
    expect(events.filter((e) => e.kind === 'segment.erase').map((e) => e.segment)).toEqual(['enc']);
  });
});

describe('retireExpired — tombstone purge', () => {
  it('deletes its own retirement tombstone once the grace has passed', async () => {
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });

    // Pass 1 retires it. The row stays as a `destroyed` fence so an in-flight writer cannot resurrect it.
    const first = await retireExpired(w.dropDeps, { now: T0 });
    expect(first.retired).toBe(1);
    expect(first.tombstonesPurged).toBe(0);
    expect((await w.registry.get({ segment: 'day' }))!.status).toBe('destroyed');

    // Still inside the grace window: the row is kept, and this is not ledger noise.
    const soon = await retireExpired(w.dropDeps, { now: T0 + 60_000 });
    expect(soon.tombstonesPurged).toBe(0);
    expect(soon.entries).toEqual([]);

    // Past it: the row goes, so a fleet of retired daily buckets does not accumulate dead rows forever.
    const later = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY });
    expect(later.tombstonesPurged).toBe(1);
    expect(later.entries).toEqual([
      { segment: 'day', namespace: undefined, action: 'purged-tombstone' },
    ]);
    expect(await w.registry.get({ segment: 'day' })).toBeNull();
  });

  it('never touches a crypto-shred tombstone that carries no retention policy', async () => {
    // A `destroySegment` tombstone is a compliance artifact and the fence that stops the name being rewritten.
    // Purging is scoped to rows that still carry an EXPIRED policy, which makes them attributably ours.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world();
    const minted = await keystore.createDek();
    await w.registry.create({ segment: 'gdpr' }, { currentGen: 0, wrappedDeks: minted.wrapped });
    await destroySegment(
      { segment: 'gdpr' },
      { registry: w.registry, warm: w.warm },
      { confirmSegment: 'gdpr' },
    );

    const res = await retireExpired(w.dropDeps, { now: T0 + 30 * DAY });
    expect(res.tombstonesPurged).toBe(0);
    expect((await w.registry.get({ segment: 'gdpr' }))!.status).toBe('destroyed');
  });

  it('collects a straggler Cold generation itself instead of reporting it forever', async () => {
    // Measured by the review: NOTHING else would ever collect it. `gcOrphanGenerations` runs only after a
    // successful compaction, and a tombstone is never a compaction candidate (zero dirty rows) and is refused by
    // `compactSegment` anyway — so a generation staged after the tombstone landed stayed billed forever while the
    // sweep paid two list calls per cycle to report the same thing again. The sweep now collects it (the GC takes
    // *every* generation of a destroyed row) and then purges the row, so the state converges.
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await retireExpired(w.dropDeps, { now: T0 });
    await bulkLoadCrbmGeneration(w.cold, { segment: 'day', generation: 7 }, [1]); // a straggler object

    const res = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY });
    expect(res.tombstonesPurged).toBe(1);
    expect(await coldGenerations(w.cold, { segment: 'day' })).toEqual([]); // the billing leak is gone
    expect(await w.registry.get({ segment: 'day' })).toBeNull();
  });

  it('keeps the row when the storage cannot be proven gone', async () => {
    // The residual after the self-heal above: a Cold tier that will not answer. Deleting the row here would make
    // the segment invisible to `gcOrphanGenerations` forever, stranding whatever is out there.
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await retireExpired(w.dropDeps, { now: T0 });
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      getTail: (k, m) => w.cold.getTail(k, m),
      delete: (k) => w.cold.delete(k),
      list: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('cold list unavailable')),
        }),
      }),
    };

    const res = await retireExpired({ ...w.dropDeps, cold }, { now: T0 + 2 * DAY });
    expect(res.tombstonesPurged).toBe(0);
    expect(res.entries[0]).toMatchObject({ action: 'skipped' });
    expect((await w.registry.get({ segment: 'day' }))!.status).toBe('destroyed');
  });

  it('keeps the row when a late writer left Warm rows — deleting it would resurrect them', async () => {
    // Warm is consulted independently of the registry, so a row-less segment with live deltas is not empty: it
    // is an accumulator holding data. Purging the tombstone over one un-deletes exactly the ids the drop was
    // meant to remove.
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await retireExpired(w.dropDeps, { now: T0 });
    await w.store().segment('day').add(42); // a writer that did not stop

    const res = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY });
    expect(res.tombstonesPurged).toBe(0);
    expect(res.entries).toEqual([
      { segment: 'day', namespace: undefined, action: 'skipped', reason: 'tombstone-not-empty' },
    ]);
  });

  it('charges tombstone purges against the same per-cycle limit', async () => {
    // The purge branch used to sit outside the cap, so a sweep advertised as "one bounded batch" could delete
    // thousands of rows and issue two list calls for each — measured at 500 purges and 1,501 driver calls under
    // `limit: 1`. In `loop` mode that starves compaction for as long as it runs.
    const w = world();
    for (const day of ['d1', 'd2', 'd3']) {
      await w.store().segment(day).add(1);
      await w.store().setRetention({ segment: day }, { expiresAt: EXPIRED });
    }
    await retireExpired(w.dropDeps, { now: T0 }); // all three retired + stamped
    const res = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY, limit: 1 });
    expect(res.tombstonesPurged).toBe(1);
    expect(res.limited).toBe(true);
    // Re-running finishes the job, so the cap defers rather than dropping.
    const rest = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY, limit: 10 });
    expect(rest.tombstonesPurged).toBe(2);
  });

  it('purgeTombstones: false keeps every tombstone', async () => {
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await retireExpired(w.dropDeps, { now: T0 });

    const res = await retireExpired(w.dropDeps, {
      now: T0 + 365 * DAY,
      purgeTombstones: false,
    });
    expect(res.tombstonesPurged).toBe(0);
    expect((await w.registry.get({ segment: 'day' }))!.status).toBe('destroyed');
  });

  it('reports a purge under dryRun without deleting the row', async () => {
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await retireExpired(w.dropDeps, { now: T0 });

    const res = await retireExpired(w.dropDeps, { now: T0 + 2 * DAY, dryRun: true });
    expect(res.tombstonesPurged).toBe(0); // counts deletions only; the entry carries the preview
    expect(res.entries[0]).toMatchObject({ action: 'would-purge-tombstone' });
    expect((await w.registry.get({ segment: 'day' }))!.status).toBe('destroyed');
  });
});

describe('store.retireExpired', () => {
  it('takes `now` from the store clock and needs a raw cold driver + registry', async () => {
    const w = world();
    await w.store().segment('day').add(1);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });

    const res = await w.store().retireExpired();
    expect(res.retired).toBe(1); // the store's clock reads T0, so the policy is due

    const noRegistry = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(new MemoryColdDriver()),
      retry: false,
    });
    await expect(noRegistry.retireExpired()).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('a compacted segment retires exactly like an accumulator one', async () => {
    // Compaction changes where the bytes live, not whether the policy applies. Both shapes end empty.
    const w = world();
    await w.store().segment('day').addMany([1, 2, 100_000]);
    await w.store().setRetention({ segment: 'day' }, { expiresAt: EXPIRED });
    await compactSegment({ segment: 'day' }, w.compactionDeps, { owner: 'worker-1' });
    expect(await coldGenerations(w.cold, { segment: 'day' })).toEqual([0]);

    const res = await w.store().retireExpired();
    expect(res.retired).toBe(1);
    expect(await coldGenerations(w.cold, { segment: 'day' })).toEqual([]);
    expect(await warmRowCount(w.warm, { segment: 'day' })).toBe(0);
    expect(await w.store().segment('day').count()).toBe(0);
  });
});
