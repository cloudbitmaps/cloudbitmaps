import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  dropSegment,
  gcOrphanGenerations,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  NotFoundError,
  UnsupportedError,
  ValidationError,
  WriteConflictError,
} from '@/core/errors';
import type { IKeystore, SegmentRef } from '@/index';

/**
 * `dropSegment` — the operational sibling of crypto-shred: it deletes the objects.
 *
 * The reason this function exists is that the ORDER of its three steps is easy to get catastrophically wrong,
 * and the wrong order fails silently. So the tests below are mostly about order and about the states each
 * ordering produces, not about the happy path:
 *
 *   Warm first    — a `destroyed` tombstone with live Warm deltas still answers `true`, because Warm is read
 *                   separately from and earlier than Cold.
 *   Registry next — after the tombstone nothing resolves a generation, so no reader can reach bytes that are
 *                   about to vanish.
 *   Cold last     — and best-effort, so a partial failure leaves orphaned bytes (a billing problem) rather
 *                   than a live pointer into a hole (a correctness problem).
 *
 * The `leaves no torn pointer` test is the one that would have caught the workaround this function replaces:
 * an object-store lifecycle rule deleting the bytes while the registry still points at them.
 */

// NOTE the shape: a colon is NOT legal in a name (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`), so the obvious
// `active:2026-08-01` throws. The dated-bucket pattern belongs in the NAMESPACE/segment split instead, which is
// also strictly more useful — `registry.list(namespace)` then enumerates exactly the buckets a retention sweep
// should consider.
const SEG: SegmentRef = { namespace: 'active-daily', segment: '2026-08-01' };
const CONFIRM = { confirmSegment: SEG.segment };

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const store = new CloudRoaring({
    warm,
    cold: new CrbmColdChunkSource(cold, { registry, keystore }),
    retry: false,
  });
  return { cold, warm, registry, store, deps: { cold, warm, registry } };
}

async function seed(
  w: ReturnType<typeof world>,
  ids: number[],
  keystore?: IKeystore,
  generation = 0,
): Promise<void> {
  await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation }, ids, {
    registry: w.registry,
    keystore,
  });
}

/** The segment handle — namespace INCLUDED, because it is part of the identity and omitting it silently
 *  addresses a different segment in the default namespace. (Which it did, while writing these tests.) */
const handle = (w: ReturnType<typeof world>) =>
  w.store.segment(SEG.segment, { namespace: SEG.namespace });

async function generationsInCold(w: ReturnType<typeof world>): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of w.cold.list(SEG)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

describe('dropSegment', () => {
  it('deletes the Cold objects — which crypto-shred does not', async () => {
    const w = world();
    await seed(w, [1, 2, 3, 70_000]);
    expect(await generationsInCold(w)).toHaveLength(1);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
    // The whole point: the bytes are gone from the store, not merely unreadable.
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('works on a CLEARTEXT segment — crypto-shred refuses one', async () => {
    // destroySegment rejects a cleartext segment (no key to discard) unless you pass allowCleartext, and even
    // then leaves the Cold bytes readable. Disposal has no such requirement, and most segments are cleartext.
    const w = world();
    await seed(w, [5, 6]);
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.dropped).toBe(true);
    expect(result.cryptoShredded).toBe(false);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('ALSO crypto-shreds an encrypted segment, so it is a strict superset there', async () => {
    // Deleting an object does not reach a noncurrent version, a replica or a PITR snapshot; discarding the key
    // does. On an encrypted segment we want both, and the result has to say which happened.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, [7, 8], keystore);
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.cryptoShredded).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
  });

  it('leaves NO torn pointer — the segment reads as empty, not as an error', async () => {
    // THE load-bearing test. The workaround this replaces (a lifecycle rule deleting objects while the registry
    // still points at them) produces `missing-cold-generation`: reads throw NotFoundError, intermittently,
    // because the hot cache masks it until eviction. Ordering the tombstone BEFORE the delete is what converts
    // that into a benign empty read, so assert the benign outcome rather than the ordering directly.
    const w = world();
    await seed(w, [1, 2, 3]);
    await dropSegment(SEG, w.deps, CONFIRM);

    const seg = handle(w);
    await expect(seg.has(1)).resolves.toBe(false);
    await expect(seg.count()).resolves.toBe(0);
    const listed: number[] = [];
    for await (const id of seg.iterate()) listed.push(id);
    expect(listed).toEqual([]);
  });

  it('proves the inverse order is what breaks: delete Cold first and reads throw', async () => {
    // A control for the test above — BUT NOTE ITS LIMIT, which mutation testing exposed: it never calls
    // `dropSegment`. It hand-deletes Cold and asserts the engine throws, so it is a control on the ENGINE, and it
    // cannot fail if `dropSegment`'s ordering regresses. The real ordering proof is the mid-drop observation in
    // the `ordering` describe below; this one only establishes that the torn state is in fact observable.
    const w = world();
    await seed(w, [1, 2, 3]);
    for (const generation of await generationsInCold(w)) {
      await w.cold.delete({ ...SEG, generation });
    }
    // Registry still points at the deleted generation → the torn state.
    await expect(handle(w).has(1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes the Warm deltas, so a tombstone cannot still answer true', async () => {
    // Warm is consulted separately from and earlier than Cold, so a `destroyed` row with live Warm adds would
    // report membership for ids in those deltas — a deleted segment answering `true`. Warm must go first.
    const w = world();
    await seed(w, [1]);
    await handle(w).addMany([500, 501, 502]); // warm adds, not yet compacted

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.warmRowsDeleted).toBeGreaterThan(0);
    await expect(handle(w).has(500)).resolves.toBe(false);
  });

  it('dryRun reports what would go and changes nothing', async () => {
    // The confirmSegment guard protects a hand-typed literal. In the loop this function is for, the same
    // variable appears twice and the guard is ceremony — a dry run is the guard that survives automation.
    const w = world();
    await seed(w, [1, 2]);

    const preview = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });

    expect(preview.dropped).toBe(false);
    expect(preview.wouldDelete).toHaveLength(1);
    expect(preview.generationsDeleted).toEqual([]);
    // Nothing touched: the data still reads, and the objects are still there.
    expect(await generationsInCold(w)).toHaveLength(1);
    await expect(handle(w).has(1)).resolves.toBe(true);
  });

  it('is idempotent — a second drop is a no-op that says so', async () => {
    const w = world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);
    const again = await dropSegment(SEG, w.deps, CONFIRM);
    expect(again.dropped).toBe(true);
    expect(again.reason).toBe('already');
    expect(again.generationsDeleted).toEqual([]);
  });

  it('reports an absent segment rather than throwing', async () => {
    // A retention loop will inevitably name a bucket that was already collected. That is not an error.
    const w = world();
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.dropped).toBe(false);
    expect(result.reason).toBe('absent');
  });

  it('refuses a mismatched confirmSegment', async () => {
    const w = world();
    await seed(w, [1]);
    await expect(
      dropSegment(SEG, w.deps, { confirmSegment: 'something-else' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // And refusing means refusing: the data is untouched.
    expect(await generationsInCold(w)).toHaveLength(1);
  });

  it('deletes every generation, not just the current one', async () => {
    // A segment that has been compacted holds superseded generations too. Disposal that left them behind would
    // keep billing for the bytes it claimed to remove — the exact complaint that motivated this function.
    const w = world();
    await seed(w, [1, 2]);
    await seed(w, [3, 4], undefined, 1);
    expect((await generationsInCold(w)).length).toBeGreaterThan(1);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.generationsDeleted.length).toBeGreaterThan(1);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('tolerates a Cold delete failure, leaving orphaned bytes rather than a torn pointer', async () => {
    // Cold deletion is last and best-effort on purpose. Once the tombstone is written the segment reads as
    // empty and is CORRECT, so a failure here is a billing problem; failing the whole call instead would leave
    // callers retrying a drop that already succeeded semantically.
    const w = world();
    await seed(w, [1, 2]);
    w.cold.delete = (): Promise<void> => Promise.reject(new Error('S3 is having a day'));

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.dropped).toBe(true); // the segment IS disposed of, semantically
    expect(result.generationsDeleted).toEqual([]); // ...but the bytes leaked
    await expect(handle(w).has(1)).resolves.toBe(false); // and reads stay benign
  });

  it('does NOT emit `segment.erase` for a cleartext drop — that event means crypto-shred', async () => {
    // Caught by an adversarial docs review, and it was a real bug: the first version fired on
    // `cryptoShredded || generationsDeleted.length > 0`, so a cleartext drop emitted the event that four
    // documents — dashboards.md calls it the compliance *receipt* — define as proof of irreversible destruction.
    // Deleting an object is weaker than discarding a key: a noncurrent version, a replica or a PITR snapshot
    // still holds the cleartext. A dashboard built on our own docs would have over-attested.
    const w = world();
    await seed(w, [1, 2]);
    const events: unknown[] = [];
    const audit = { onEvent: (e: unknown): void => void events.push(e) };

    const result = await dropSegment(SEG, w.deps, { ...CONFIRM, audit });

    expect(result.generationsDeleted).toHaveLength(1); // bytes really went
    expect(result.cryptoShredded).toBe(false);
    // It attests the DISPOSAL and nothing stronger. `segment.erase` must not appear — that is the whole point.
    // (Originally this asserted `[]`, because silence was the honest interim state before `segment.dispose`
    // existed. The gap it documented is now closed; the prohibition it enforces is not relaxed.)
    expect((events as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['segment.dispose']);
    expect((events as Array<{ kind: string }>).some((e) => e.kind === 'segment.erase')).toBe(false);
  });

  it('DOES emit `segment.erase` when the drop genuinely crypto-shreds', async () => {
    // The positive control for the test above. Without it, "no event" could be true because the audit sink is
    // never called at all, and the assertion above would pass against a `dropSegment` that audits nothing ever.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, [1, 2], keystore);
    const events: Array<{ kind: string }> = [];

    await dropSegment(SEG, w.deps, { ...CONFIRM, audit: { onEvent: (e) => void events.push(e) } });

    // Both, on an encrypted segment: the key shred AND the storage reclamation each genuinely happened.
    expect(events.map((e) => e.kind)).toEqual(['segment.erase', 'segment.dispose']);
  });

  it('is only eventually empty to a reader that had already cached the segment', async () => {
    // The docs said "afterwards the segment reads as empty", full stop. False for up to `coldGenTtlMs`
    // (default 2s): a resolved generation is cached and decoded chunks sit in the hot LRU, so a store that
    // touched the segment BEFORE the drop keeps answering from cache. My original tests all passed only because
    // none of them read first — the blind spot was in the fixture, not the assertion.
    //
    // Asserted as a bound rather than a timing: a FRESH store over the same drivers must see empty at once,
    // which pins the cause on caching rather than on the drop having failed.
    const w = world();
    await seed(w, [1, 2, 3]);
    await expect(handle(w).has(1)).resolves.toBe(true); // warms the snapshot + LRU

    await dropSegment(SEG, w.deps, CONFIRM);

    // Same store: still answers from cache. Asserted as an exact value, not `toBeTypeOf('boolean')` — that
    // matcher's domain IS the declared return type of `has`, so it could only fail by rejecting, and the test's
    // own title ("only EVENTUALLY empty") went unasserted. If caching ever stopped masking this, the weak version
    // would have passed identically.
    await expect(handle(w).has(1)).resolves.toBe(true);

    // A reader that never cached it sees the truth immediately — so the data really is gone.
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });
});

/**
 * Forward every method to the real driver, overriding one.
 *
 * A Proxy rather than a spread-and-override: driver methods live on the prototype and touch private fields, so a
 * spread copies none of them. `receiver = target` keeps `this` bound to the real instance.
 */
function hook<T extends object>(target: T, prop: string, impl: (...args: never[]) => unknown): T {
  return new Proxy(target, {
    get(t, p) {
      if (p === prop) return impl;
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

async function warmRowCount(w: ReturnType<typeof world>): Promise<number> {
  let n = 0;
  for await (const _row of w.warm.listChunks(SEG)) {
    void _row;
    n += 1;
  }
  return n;
}

/**
 * ORDERING — the tests that were missing, and whose absence let three separate ordering inversions through.
 *
 * Every test in the suite above asserts the POST-HOC steady state, and the steady state is identical whichever
 * order the three steps run in: the tombstone lands either way, so reads end up empty either way. Mutation
 * testing confirmed it — deleting the Cold objects BEFORE the tombstone (the exact `missing-cold-generation`
 * failure this function exists to prevent) passed all 17 tests here and all 1238 in the repo.
 *
 * The torn state is only observable *during* the window. So these observe mid-drop.
 */
describe('dropSegment ordering (observed mid-drop, not after)', () => {
  it('at the instant the tombstone lands, Warm is already clear and Cold is still intact', async () => {
    // One observation point pins the whole contract, because each inversion moves it a different way:
    //   registry-before-Warm  → warmRows would be 1
    //   Cold-before-registry  → coldGens would be []
    const w = world();
    await seed(w, [1, 2, 3]);
    await handle(w).addMany([500]); // a live Warm row that step 1 must clear

    let atCas: { warmRows: number; coldGens: number[] } | null = null;
    const registry = hook(w.registry, 'compareAndSwap', async (...args: never[]) => {
      const [ref, expected, patch] = args as unknown as [SegmentRef, string, { status?: string }];
      if (patch.status === 'destroyed') {
        atCas = { warmRows: await warmRowCount(w), coldGens: await generationsInCold(w) };
      }
      return w.registry.compareAndSwap(ref, expected, patch as never);
    });

    await dropSegment(SEG, { ...w.deps, registry }, CONFIRM);

    expect(atCas).toEqual({ warmRows: 0, coldGens: [0] });
  });

  it('no reader can ever see a live pointer into a deleted object — observed at each delete', async () => {
    // A reader arriving at the exact instant an object vanishes must see EMPTY, never NotFoundError. With the
    // tombstone already written it resolves no generation at all, so it never reaches for the missing bytes.
    const w = world();
    await seed(w, [1, 2, 3]);

    const observations: Array<{ ok: boolean; err?: string }> = [];
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      await w.cold.delete(args[0] as never);
      const fresh = new CloudRoaring({
        warm: w.warm,
        cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
        retry: false,
      });
      try {
        await fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(1);
        observations.push({ ok: true });
      } catch (err) {
        observations.push({ ok: false, err: (err as Error).constructor.name });
      }
    });

    await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);

    expect(observations).toEqual([{ ok: true }]);
  });
});

describe('dropSegment vs a concurrent writer', () => {
  it('sweeps again to catch a generation staged by a compaction already in flight', async () => {
    // A compaction that took its lease before the drop still finishes STAGING, from data it read beforehand. Its
    // commit then fails on the lease the tombstone voided — but the object it wrote survives, and it holds the
    // COMPLETE effective set including the Warm deltas the drop just deleted. For a cleartext segment those bytes
    // are readable, and nothing in the library reclaims them: gcOrphanGenerations only looks below currentGen and
    // checkConsistency skips destroyed segments. A single list-then-delete missed it entirely.
    //
    // Simulated at the driver, not by racing a real daemon: a `put` that lands during the sweep is exactly what a
    // late staging is, and it keeps the test deterministic.
    const w = world();
    await seed(w, [1, 2, 3]);

    let staged = false;
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      await w.cold.delete(args[0] as never);
      if (!staged) {
        staged = true; // one late staging, as a single in-flight worker would produce
        await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 7 }, [1, 2, 3, 500], {});
      }
    });

    const result = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);

    // The re-sweep collected it, so nothing is left billed or readable.
    expect(await generationsInCold(w)).toEqual([]);
    expect(result.generationsDeleted).toEqual([0, 7]);
    expect(result.generationsRemaining).toEqual([]);
  });

  it('reports what it could not reclaim instead of implying a clean drop', async () => {
    // The residual has to be visible. `dropped: true` with a populated generationsDeleted and no reason used to
    // be returned while an object holding the full effective set sat in the bucket.
    const w = world();
    await seed(w, [1, 2, 3]);
    const cold = hook(w.cold, 'delete', async () => {
      throw new Error('bucket unreachable');
    });

    const result = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);

    expect(result.dropped).toBe(true); // the tombstone DID land — the segment reads as empty
    expect(result.generationsDeleted).toEqual([]);
    expect(result.generationsRemaining).toEqual([0]); // ...but the storage was NOT reclaimed
  });

  it('keeps the generations it did delete when only some deletes fail', async () => {
    const w = world();
    await seed(w, [1], undefined, 0);
    await seed(w, [2], undefined, 1);
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      const key = args[0] as unknown as { generation: number };
      if (key.generation === 1) throw new Error('this one only');
      await w.cold.delete(args[0] as never);
    });

    const result = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);

    expect(result.generationsDeleted).toEqual([0]); // not `[]` — a partial result is not a failed one
    expect(result.generationsRemaining).toEqual([1]);
  });

  it('a Warm write landing after the drop does not make the segment answer true forever', async () => {
    // The write path is deliberately uncoupled from the tombstone, so a late write DOES land. What made it a bug
    // rather than a scope note is that the row was IMMORTAL: compaction returns `destroyed` before it can fold or
    // purge it, so nothing ever reaped it and a FRESH reader (no cache involved) reported the dropped segment as
    // non-empty forever. A second Warm pass after the tombstone converges for anything in flight at drop time.
    const w = world();
    await seed(w, [1]);

    let wrote = false;
    const registry = hook(w.registry, 'compareAndSwap', async (...args: never[]) => {
      const [ref, expected, patch] = args as unknown as [SegmentRef, string, { status?: string }];
      const out = await w.registry.compareAndSwap(ref, expected, patch as never);
      if (patch.status === 'destroyed' && !wrote) {
        wrote = true; // a writer that had not yet noticed, landing just after the tombstone
        await handle(w).add(999);
      }
      return out;
    });

    const result = await dropSegment(SEG, { ...w.deps, registry }, CONFIRM);

    expect(result.warmRowsDeleted).toBeGreaterThan(0);
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(999)).resolves.toBe(
      false,
    );
  });

  it('re-dropping a tombstoned segment clears warm rows that landed after the tombstone', async () => {
    // So a second drop is NOT a no-op, and must not be — it is the recovery path for a writer that kept going.
    const w = world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);
    await handle(w).add(600); // a late write against a destroyed segment

    const again = await dropSegment(SEG, w.deps, CONFIRM);

    expect(again.reason).toBe('already');
    expect(again.warmRowsDeleted).toBeGreaterThan(0);
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(600)).resolves.toBe(
      false,
    );
  });

  it('counts every warm row it deleted, even when the tombstone CAS has to retry', async () => {
    // The tally used to be declared INSIDE the CAS retry loop, so only the last attempt's count survived: one
    // benign concurrent registry write made attempt 1 conflict, attempt 2 re-listed an empty Warm set, and the
    // call reported 0 rows deleted after physically deleting all of them. Under-attesting on an erasure record.
    const w = world();
    await seed(w, [1]);
    await handle(w).addMany([500, 501, 502, 70_000]);
    const realCount = await warmRowCount(w);
    expect(realCount).toBeGreaterThan(0);

    let conflicted = false;
    const registry = hook(w.registry, 'compareAndSwap', async (...args: never[]) => {
      const [ref, expected, patch] = args as unknown as [SegmentRef, string, { status?: string }];
      if (!conflicted && patch.status === 'destroyed') {
        conflicted = true;
        throw new WriteConflictError('a lease acquisition advanced the row');
      }
      return w.registry.compareAndSwap(ref, expected, patch as never);
    });

    const result = await dropSegment(SEG, { ...w.deps, registry }, CONFIRM);

    expect(conflicted).toBe(true);
    expect(result.dropped).toBe(true);
    expect(result.warmRowsDeleted).toBe(realCount);
  });

  it('refuses to report a drop it could not finish — warm rows contended on every pass', async () => {
    // Strictly worse than the destroySegment bug this mirrors: swallowing the conflict would leave the cleartext
    // Warm rows readable AND delete the Cold bytes AND attest success. It must throw with nothing destroyed.
    const w = world();
    await seed(w, [1]);
    await handle(w).add(500);
    const warm = hook(w.warm, 'deleteConditional', async () => {
      throw new WriteConflictError('row rewritten mid-erase');
    });

    await expect(dropSegment(SEG, { ...w.deps, warm }, CONFIRM)).rejects.toBeInstanceOf(
      WriteConflictError,
    );

    expect((await w.registry.get(SEG))?.status).toBe('active'); // NOT tombstoned
    expect(await generationsInCold(w)).toEqual([0]); // bytes NOT deleted — the drop is retryable
    await expect(handle(w).has(500)).resolves.toBe(true);
  });

  it('two concurrent drops converge — one drops, one reports already', async () => {
    const w = world();
    await seed(w, [1, 2]);
    const [a, b] = await Promise.all([
      dropSegment(SEG, w.deps, CONFIRM),
      dropSegment(SEG, w.deps, CONFIRM),
    ]);
    expect([a.dropped, b.dropped]).toEqual([true, true]);
    expect([a.reason, b.reason].filter((r) => r === 'already')).toHaveLength(1);
    expect(await generationsInCold(w)).toEqual([]);
    expect((await w.registry.get(SEG))?.status).toBe('destroyed');
  });
});

describe('dropSegment on a segment with no registry row', () => {
  it('clears the cleartext Warm rows of an all-warm segment', async () => {
    // A never-compacted segment has NO registry row — the write path never creates one. Its rows are the
    // cleartext ones, so this is the case where "absent" must still do work.
    const w = world();
    await handle(w).addMany([500, 501, 70_000]);
    expect(await w.registry.get(SEG)).toBeNull();

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.reason).toBe('absent');
    expect(result.warmRowsDeleted).toBeGreaterThan(0);
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(500)).resolves.toBe(
      false,
    );
  });

  it('leaves NO registry row behind when the segment truly does not exist', async () => {
    // The typo case the facade docs warn about. Claiming the identity here would be registry litter — and worse,
    // a `destroyed` row would refuse a later legitimate load of that name forever.
    const w = world();
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.reason).toBe('absent');
    expect(result.dropped).toBe(false);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('claims the identity before deleting orphaned objects, so a racing writer is fenced', async () => {
    // Objects in Cold with no registry row is a real state: `bulkLoadCrbmGeneration` writes the object, THEN
    // publishes, and those are minutes apart on a large load. This used to delete every generation while writing
    // no tombstone at all — skipping the one step that makes the ordering safe while still running the
    // destructive one. Two measured outcomes: a dangling `currentGen: 0, status: 'active'` pointer at no object
    // (the forbidden `missing-cold-generation` state), or a full resurrection when the racing writer published.
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {}); // no registry → no row
    expect(await w.registry.get(SEG)).toBeNull();
    expect(await generationsInCold(w)).toEqual([0]);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toEqual([0]);
    expect(result.reason).toBeUndefined(); // NOT 'absent' — something existed and was disposed of
    // The tombstone is what fences the racing publisher.
    expect((await w.registry.get(SEG))?.status).toBe('destroyed');
    // ...and it really does refuse the publish that would have resurrected the segment.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: w.registry,
      }),
    ).rejects.toThrow();
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });
});

describe('dropSegment result fields', () => {
  it('reports generations ascending even when Cold lists them out of order', async () => {
    // Every other assertion in this file is `toHaveLength` — a count, never the contents or the order. So the
    // documented "ascending" was unproven, and the sort was unreachable by test because the fixture seeded in
    // order anyway.
    const w = world();
    await seed(w, [1], undefined, 2);
    await seed(w, [2], undefined, 0);
    await seed(w, [3], undefined, 1);

    const preview = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(preview.wouldDelete).toEqual([0, 1, 2]);

    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.generationsDeleted).toEqual([0, 1, 2]);
  });

  it('tombstones the registry row and discards the DEK wrappings', async () => {
    // Nothing in this file used to inspect the row itself — everything was asserted through read outcomes, which
    // is exactly why the ordering inversions hid.
    const keystore = new InProcessKeystore({
      keys: { k1: randomBytes(32) },
      activeKeyId: 'k1',
    });
    const w = world(keystore);
    await seed(w, [1, 2], keystore);
    expect((await w.registry.get(SEG))?.wrappedDeks).toHaveLength(1);

    await dropSegment(SEG, w.deps, CONFIRM);

    const row = await w.registry.get(SEG);
    expect(row?.status).toBe('destroyed');
    expect(row?.wrappedDeks).toBeUndefined();
  });

  it('dryRun distinguishes absent from already, and previews both irreversible facts', async () => {
    // `reason` on a dry run was entirely uncovered — both branches. A retention sweep dry-running yesterday's
    // already-collected bucket is the primary use case, and `reason` is how it tells "will delete" from "gone".
    const keystore = new InProcessKeystore({
      keys: { k1: randomBytes(32) },
      activeKeyId: 'k1',
    });
    const w = world(keystore);

    const before = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(before.reason).toBe('absent');
    expect(before.wouldDelete).toEqual([]);
    expect(before.wouldCryptoShred).toBe(false);

    await seed(w, [1, 2], keystore);
    await handle(w).addMany([500, 501]);
    const armed = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(armed.reason).toBeUndefined();
    expect(armed.wouldDelete).toEqual([0]);
    expect(armed.wouldDeleteWarmRows).toBeGreaterThan(0); // cleartext deltas, worth previewing
    expect(armed.wouldCryptoShred).toBe(true); // irreversible EVERYWHERE, backups included

    await dropSegment(SEG, w.deps, CONFIRM);
    const after = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(after.reason).toBe('already');
    expect(after.wouldDelete).toEqual([]);
    // Still nothing touched by any of the three previews.
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('propagates a Cold driver that cannot list — but still records a crypto-shred that happened', async () => {
    // The throw is right: a caller must re-run. But the shred is ALREADY irreversible by then, so emitting the
    // receipt after the sweep would mean no record of a destruction that really occurred — the exact mirror of
    // the over-attestation the audit condition was tightened to prevent.
    const keystore = new InProcessKeystore({
      keys: { k1: randomBytes(32) },
      activeKeyId: 'k1',
    });
    const w = world(keystore);
    await seed(w, [1, 2], keystore);

    const events: Array<{ kind: string }> = [];
    const cold = hook(w.cold, 'list', () => {
      // eslint-disable-next-line require-yield
      return (async function* (): AsyncGenerator<never> {
        throw new Error('LIST denied');
      })();
    });

    await expect(
      dropSegment(
        SEG,
        { ...w.deps, cold },
        { ...CONFIRM, audit: { onEvent: (e) => events.push(e) } },
      ),
    ).rejects.toThrow('LIST denied');

    expect((await w.registry.get(SEG))?.status).toBe('destroyed'); // it DID happen
    expect(events.map((e) => e.kind)).toEqual(['segment.erase']); // ...so it is on the record
  });
});

describe('store.dropSegment (facade)', () => {
  it('needs no drivers passed — the store already holds them', async () => {
    // The point of the facade wrapper: a user should not re-wire registry/warm/cold to delete a segment.
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({ warm, cold, registry, retry: false });
    const result = await store.dropSegment(SEG, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
    await expect(store.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });

  it('forwards the audit sink — an encrypted drop still emits the receipt', async () => {
    // Every audit assertion above uses the FREE function. `store.dropSegment` is the path users call, and
    // `segment.erase` is the documented compliance receipt, so a facade that silently dropped the sink would have
    // passed the whole suite.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry, keystore });

    const store = new CloudRoaring({ warm, cold, registry, keystore, retry: false });
    const events: Array<{ kind: string }> = [];
    const result = await store.dropSegment(SEG, {
      ...CONFIRM,
      audit: { onEvent: (e) => events.push(e) },
    });

    expect(result.cryptoShredded).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['segment.erase', 'segment.dispose']);
  });

  it('throws UnsupportedError when the store has no raw cold driver', async () => {
    // The docstring promises this, and nothing asserted it. Note the irony that this file's own `world()` helper
    // builds exactly such a store — which is why every test above uses the free function.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    });
    await expect(store.dropSegment(SEG, CONFIRM)).rejects.toBeInstanceOf(UnsupportedError);
    // ...and the message must name the operation the caller actually invoked.
    await expect(store.dropSegment(SEG, CONFIRM)).rejects.toThrow(/dropSegment/);
  });

  it('dry-runs through the facade too', async () => {
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1], { registry });

    const store = new CloudRoaring({ warm, cold, registry, retry: false });
    const preview = await store.dropSegment(SEG, { ...CONFIRM, dryRun: true });

    expect(preview.wouldDelete).toHaveLength(1);
    await expect(store.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      true,
    );
  });
});

describe('gcOrphanGenerations on a destroyed segment', () => {
  it('collects EVERY generation, because a tombstoned segment has no reader to protect', async () => {
    // The grace window exists for readers pinned to a just-superseded generation. A destroyed segment resolves no
    // generation at all, so nothing is or can become pinned — and nothing else would ever collect these: the
    // reconcile path that deletes generations above `currentGen` returns early on a destroyed row. Without this,
    // a residual left by a drop whose sweep failed is billed forever.
    const w = world();
    await seed(w, [1], undefined, 0);
    const cold = hook(w.cold, 'delete', async () => {
      throw new Error('bucket unreachable');
    });
    const failed = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);
    expect(failed.generationsRemaining).toEqual([0]); // tombstoned, bytes still there
    // A late staging lands on top of the tombstone, exactly as an in-flight compaction would.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [1, 2], {});
    expect(await generationsInCold(w)).toEqual([0, 5]);

    const collected = await gcOrphanGenerations(SEG, w.deps, { keep: 1 });

    expect(collected.sort((a, b) => a - b)).toEqual([0, 5]);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('still honours the grace window on a live segment', async () => {
    // The negative control: the destroyed branch must not have widened the live one.
    const w = world();
    await seed(w, [1], undefined, 0);
    await seed(w, [2], undefined, 1);
    await seed(w, [3], undefined, 2); // currentGen = 2
    const collected = await gcOrphanGenerations(SEG, w.deps, { keep: 1 });
    expect(collected).toEqual([0]); // gen 1 kept as the window, gen 2 is current
    expect(await generationsInCold(w)).toEqual([1, 2]);
  });
});

describe('segment.dispose audit event', () => {
  it('a cleartext drop emits segment.dispose and NOT segment.erase', async () => {
    // Before this kind existed, a cleartext disposal was invisible to the audit sink entirely — because
    // `segment.erase` is defined by four documents as proof of an irreversible crypto-shred, and reusing it for an
    // object delete would make a compliance dashboard over-attest. Silence was the honest interim state; a
    // separate kind is the actual fix.
    const w = world();
    await seed(w, [1, 2, 3]);
    const events: Array<{ kind: string; generationsDeleted?: number }> = [];

    await dropSegment(SEG, w.deps, { ...CONFIRM, audit: { onEvent: (e) => events.push(e) } });

    expect(events.map((e) => e.kind)).toEqual(['segment.dispose']);
    expect(events[0]?.generationsDeleted).toBe(1);
  });

  it('an ENCRYPTED drop emits both — the shred and the reclamation each really happened', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, [1, 2], keystore);
    const events: Array<{ kind: string }> = [];

    const result = await dropSegment(SEG, w.deps, {
      ...CONFIRM,
      audit: { onEvent: (e) => events.push(e) },
    });

    expect(result.cryptoShredded).toBe(true);
    // Order matters: the shred is irreversible the moment the tombstone lands, the reclamation only after the
    // sweep. Attesting them in that order is what makes a replayed trail truthful.
    expect(events.map((e) => e.kind)).toEqual(['segment.erase', 'segment.dispose']);
  });

  it('an absent segment emits nothing at all — it disposed of nothing', async () => {
    const w = world();
    const events: Array<{ kind: string }> = [];
    const result = await dropSegment(SEG, w.deps, {
      ...CONFIRM,
      audit: { onEvent: (e) => events.push(e) },
    });
    expect(result.reason).toBe('absent');
    expect(events).toEqual([]);
  });

  it('a dry run emits nothing — it is a preview, not a state change', async () => {
    const w = world();
    await seed(w, [1]);
    const events: Array<{ kind: string }> = [];
    await dropSegment(SEG, w.deps, {
      ...CONFIRM,
      dryRun: true,
      audit: { onEvent: (e) => events.push(e) },
    });
    expect(events).toEqual([]);
  });
});

describe('store.compact collects the generation it supersedes (#47)', () => {
  /**
   * Cold generations are immutable and generation-keyed, so EVERY compaction leaves its predecessor on disk.
   * `runCompactionCycle` (the daemon) always collected them; `compactSegment` never did — so a deployment that
   * compacted in-process without running the daemon grew its Cold footprint without bound, forever, silently.
   * Reads stayed correct throughout, which is exactly why nothing surfaced it.
   */
  const wire = () => {
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    return {
      cold,
      warm,
      registry,
      store: new CloudRoaring({ cold, warm, registry, retry: false }),
    };
  };
  const gens = async (cold: MemoryColdDriver): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of cold.list(SEG)) out.push(k.generation);
    return out.sort((a, b) => a - b);
  };

  it('does not accumulate generations across repeated in-process compactions', async () => {
    const w = wire();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    const seg = w.store.segment(SEG.segment, { namespace: SEG.namespace });

    for (let round = 0; round < 4; round++) {
      await seg.add(1000 + round);
      await w.store.compact(SEG, { owner: 'test' });
    }

    // Without the GC this would be [0,1,2,3,4]: five objects, four of them dead.
    // The `keep: 1` grace window is deliberate — a reader that resolved the just-superseded generation a moment
    // ago must not have its object yanked away, so exactly one superseded generation survives.
    const present = await gens(w.cold);
    expect(present.length).toBeLessThanOrEqual(2);
    // ...and the data is intact, which is the thing a GC must never break.
    await expect(seg.has(1)).resolves.toBe(true);
    await expect(seg.has(1003)).resolves.toBe(true);
    await expect(seg.count()).resolves.toBe(7);
  });

  it('leaves the current generation alone when there is nothing superseded yet', async () => {
    const w = wire();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    const seg = w.store.segment(SEG.segment, { namespace: SEG.namespace });
    await seg.add(2);
    await w.store.compact(SEG, { owner: 'test' });
    // gen 1 is current, gen 0 is the single kept grace window — nothing has been lost.
    expect(await gens(w.cold)).toEqual([0, 1]);
    await expect(seg.count()).resolves.toBe(2);
  });

  it('a compaction that commits is not reported as failed when GC cannot run', async () => {
    // GC is housekeeping. A committed compaction must not surface as an error because cleanup failed — the next
    // cycle collects what this one missed.
    const w = wire();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    const seg = w.store.segment(SEG.segment, { namespace: SEG.namespace });
    await seg.add(2);
    await w.store.compact(SEG, { owner: 'test' }); // gen 1, so gen 0 becomes collectable
    await seg.add(3);

    let deletes = 0;
    const brittle = hook(w.cold, 'delete', async () => {
      deletes += 1;
      throw new Error('DELETE denied');
    });
    const store = new CloudRoaring({
      cold: brittle,
      warm: w.warm,
      registry: w.registry,
      retry: false,
    });

    const result = await store.compact(SEG, { owner: 'test' });

    expect(result.compacted).toBe(true); // the commit stands
    expect(deletes).toBeGreaterThan(0); // GC was attempted
    await expect(store.segment(SEG.segment, { namespace: SEG.namespace }).count()).resolves.toBe(3);
  });
});
