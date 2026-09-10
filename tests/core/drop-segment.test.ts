import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  dropSegment,
  gcOrphanGenerations,
  publishGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  NotFoundError,
  UnsupportedError,
  ValidationError,
  WriteConflictError,
} from '@/core/errors';
import type { DropDeps, IKeystore, SegmentRef } from '@/index';
import { loadedStore } from '../helpers/loaded';

/**
 * `dropSegment` — the operational sibling of crypto-shred: it deletes the objects.
 *
 * The reason this function exists is that the ORDER of its two steps is easy to get catastrophically wrong,
 * and the wrong order fails silently. So the tests below are mostly about order and about the states each
 * ordering produces, not about the happy path:
 *
 *   Registry first — after the tombstone nothing resolves a generation, so no reader can reach bytes that are
 *                    about to vanish, and no writer can publish onto the name (`publishGeneration` and
 *                    `bulkLoadCrbmGeneration` both refuse a `destroyed` row).
 *   Cold last      — and best-effort, re-swept, so a partial failure leaves orphaned bytes (a billing problem)
 *                    rather than a live pointer into a hole (a correctness problem).
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

async function world(keystore?: IKeystore) {
  const w = await loadedStore({}, { keystore, retry: false });
  const deps: DropDeps = { cold: w.cold, registry: w.registry };
  return { ...w, deps };
}
type World = Awaited<ReturnType<typeof world>>;

/** Load `ids` as the segment's next generation (through the fixture's keystore when the world has one). */
const seed = (w: World, ids: number[]): Promise<unknown> => w.load(SEG, ids);

/** The segment handle — namespace INCLUDED, because it is part of the identity and omitting it silently
 *  addresses a different segment in the default namespace. (Which it did, while writing these tests.) */
const handle = (w: World) => w.store.segment(SEG.segment, { namespace: SEG.namespace });

/** A reader that has cached nothing — sees the truth at once (see the "only eventually empty" test). */
const fresh = (w: World): CloudRoaring =>
  new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });

async function generationsInCold(w: World): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of w.cold.list(SEG)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

describe('dropSegment', () => {
  it('deletes the Cold objects — which crypto-shred does not', async () => {
    const w = await world();
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
    const w = await world();
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
    const w = await world(keystore);
    await seed(w, [7, 8]);
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.cryptoShredded).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
  });

  it('leaves NO torn pointer — the segment reads as empty, not as an error', async () => {
    // THE load-bearing test. The workaround this replaces (a lifecycle rule deleting objects while the registry
    // still points at them) produces `missing-cold-generation`: reads throw NotFoundError, intermittently,
    // because the hot cache masks it until eviction. Ordering the tombstone BEFORE the delete is what converts
    // that into a benign empty read, so assert the benign outcome rather than the ordering directly.
    const w = await world();
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
    const w = await world();
    await seed(w, [1, 2, 3]);
    for (const generation of await generationsInCold(w)) {
      await w.cold.delete({ ...SEG, generation });
    }
    // Registry still points at the deleted generation → the torn state.
    await expect(handle(w).has(1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('dryRun reports what would go and changes nothing', async () => {
    // The confirmSegment guard protects a hand-typed literal. In the loop this function is for, the same
    // variable appears twice and the guard is ceremony — a dry run is the guard that survives automation.
    const w = await world();
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
    const w = await world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);
    const again = await dropSegment(SEG, w.deps, CONFIRM);
    expect(again.dropped).toBe(true);
    expect(again.reason).toBe('already');
    expect(again.generationsDeleted).toEqual([]);
  });

  it('reports an absent segment rather than throwing', async () => {
    // A retention loop will inevitably name a bucket that was already collected. That is not an error.
    const w = await world();
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.dropped).toBe(false);
    expect(result.reason).toBe('absent');
  });

  it('refuses a mismatched confirmSegment', async () => {
    const w = await world();
    await seed(w, [1]);
    await expect(
      dropSegment(SEG, w.deps, { confirmSegment: 'something-else' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // And refusing means refusing: the data is untouched.
    expect(await generationsInCold(w)).toHaveLength(1);
  });

  it('deletes every generation, not just the current one', async () => {
    // A segment that has been reloaded holds superseded generations too until something collects them. Disposal
    // that left them behind would keep billing for the bytes it claimed to remove — the exact complaint that
    // motivated this function.
    const w = await world();
    await seed(w, [1, 2]);
    await seed(w, [3, 4]);
    expect((await generationsInCold(w)).length).toBeGreaterThan(1);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.generationsDeleted.length).toBeGreaterThan(1);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('tolerates a Cold delete failure, leaving orphaned bytes rather than a torn pointer', async () => {
    // Cold deletion is last and best-effort on purpose. Once the tombstone is written the segment reads as
    // empty and is CORRECT, so a failure here is a billing problem; failing the whole call instead would leave
    // callers retrying a drop that already succeeded semantically.
    const w = await world();
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
    const w = await world();
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
    const w = await world(keystore);
    await seed(w, [1, 2]);
    const events: Array<{ kind: string }> = [];

    await dropSegment(SEG, w.deps, { ...CONFIRM, audit: { onEvent: (e) => void events.push(e) } });

    // Both, on an encrypted segment: the key shred AND the storage reclamation each genuinely happened.
    expect(events.map((e) => e.kind)).toEqual(['segment.erase', 'segment.dispose']);
  });

  it('is only eventually empty to a reader that had already cached the segment', async () => {
    // The docs said "afterwards the segment reads as empty", full stop. False for up to `coldGenTtlMs`
    // (default 2s): a resolved generation is cached and decoded chunks sit in the hot LRU, so a store that
    // touched the segment BEFORE the drop keeps answering from cache. The original tests all passed only because
    // none of them read first — the blind spot was in the fixture, not the assertion.
    //
    // Asserted as a bound rather than a timing: a FRESH store over the same drivers must see empty at once,
    // which pins the cause on caching rather than on the drop having failed. (The fixture passes no clock, so
    // this store pins its snapshot for its lifetime — the documented `coldGenTtlMs: 0` case.)
    const w = await world();
    await seed(w, [1, 2, 3]);
    await expect(handle(w).has(1)).resolves.toBe(true); // warms the snapshot + LRU

    await dropSegment(SEG, w.deps, CONFIRM);

    // Same store: still answers from cache. Asserted as an exact value, not `toBeTypeOf('boolean')` — that
    // matcher's domain IS the declared return type of `has`, so it could only fail by rejecting, and the test's
    // own title ("only EVENTUALLY empty") went unasserted. If caching ever stopped masking this, the weak version
    // would have passed identically.
    await expect(handle(w).has(1)).resolves.toBe(true);

    // A reader that never cached it sees the truth immediately — so the data really is gone.
    await expect(fresh(w).segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
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

/**
 * ORDERING — the tests that were missing, and whose absence let ordering inversions through.
 *
 * Every test in the suite above asserts the POST-HOC steady state, and the steady state is identical whichever
 * order the two steps run in: the tombstone lands either way, so reads end up empty either way. Mutation
 * testing confirmed it — deleting the Cold objects BEFORE the tombstone (the exact `missing-cold-generation`
 * failure this function exists to prevent) passed every test here and every test in the repo.
 *
 * The torn state is only observable *during* the window. So these observe mid-drop.
 */
describe('dropSegment ordering (observed mid-drop, not after)', () => {
  it('at the instant the tombstone lands, Cold is still intact', async () => {
    // One observation point pins the contract: a Cold-before-registry inversion would show coldGens as [].
    const w = await world();
    await seed(w, [1, 2, 3]);

    let atCas: number[] | null = null;
    const registry = hook(w.registry, 'compareAndSwap', async (...args: never[]) => {
      const [ref, expected, patch] = args as unknown as [SegmentRef, string, { status?: string }];
      if (patch.status === 'destroyed') atCas = await generationsInCold(w);
      return w.registry.compareAndSwap(ref, expected, patch as never);
    });

    await dropSegment(SEG, { ...w.deps, registry }, CONFIRM);

    expect(atCas).toEqual([0]);
    expect(await generationsInCold(w)).toEqual([]); // and the sweep then took it
  });

  it('no reader can ever see a live pointer into a deleted object — observed at each delete', async () => {
    // A reader arriving at the exact instant an object vanishes must see EMPTY, never NotFoundError. With the
    // tombstone already written it resolves no generation at all, so it never reaches for the missing bytes.
    const w = await world();
    await seed(w, [1, 2, 3]);

    const observations: Array<{ ok: boolean; err?: string }> = [];
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      await w.cold.delete(args[0] as never);
      try {
        await fresh(w).segment(SEG.segment, { namespace: SEG.namespace }).has(1);
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
  it('sweeps again to catch an object a load already in flight finishes writing', async () => {
    // A load that was mid-write when the tombstone landed still finishes its object. Its publish is then refused
    // (the tombstone is the fence) — but the object survives, and it holds the COMPLETE set. For a cleartext
    // segment those bytes are readable, and nothing else reclaims them promptly: `gcOrphanGenerations` only runs
    // from the retention sweep and `checkConsistency` skips destroyed segments. A single list-then-delete missed
    // it entirely.
    //
    // Simulated at the driver, not by racing a real load: a `put` that lands during the sweep is exactly what a
    // late writer is, and it keeps the test deterministic.
    const w = await world();
    await seed(w, [1, 2, 3]);

    let staged = false;
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      await w.cold.delete(args[0] as never);
      if (!staged) {
        staged = true; // one late object, as a single in-flight writer would produce
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
    // be returned while an object holding the full set sat in the bucket.
    const w = await world();
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
    const w = await world();
    await seed(w, [1]);
    await seed(w, [2]);
    const cold = hook(w.cold, 'delete', async (...args: never[]) => {
      const key = args[0] as unknown as { generation: number };
      if (key.generation === 1) throw new Error('this one only');
      await w.cold.delete(args[0] as never);
    });

    const result = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);

    expect(result.generationsDeleted).toEqual([0]); // not `[]` — a partial result is not a failed one
    expect(result.generationsRemaining).toEqual([1]);
  });

  it('the tombstone fences every writer: a load and a bare publish onto it are refused', async () => {
    // The write path is coupled to the tombstone at exactly one point — the publish — and that point is what
    // makes the registry-first ordering safe: whatever a late writer finishes, it can never become current, so
    // a dropped segment cannot resurrect.
    const w = await world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);

    // A load with the registry wired refuses before writing anything.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: w.registry,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generationsInCold(w)).toEqual([]);
    // A writer that already had its object down (written before it saw the tombstone) is refused at the publish.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 2 }, [999], {});
    await expect(publishGeneration(w.registry, { ...SEG, generation: 2 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const row = (await w.registry.get(SEG))!;
    expect(row.status).toBe('destroyed');
    expect(row.currentGen).toBe(0); // the pointer never moved onto the late object
    await expect(
      fresh(w).segment(SEG.segment, { namespace: SEG.namespace }).has(999),
    ).resolves.toBe(false);
  });

  it('re-dropping a tombstoned segment collects an object a fenced writer left behind', async () => {
    // So a second drop is NOT a no-op, and must not be — it is the recovery path for a writer that kept going.
    const w = await world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 3 }, [600], {}); // late object, unpublishable

    const again = await dropSegment(SEG, w.deps, CONFIRM);

    expect(again.reason).toBe('already');
    expect(again.generationsDeleted).toEqual([3]);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('retries the tombstone CAS under contention and still sweeps Cold', async () => {
    // A benign concurrent registry write (a policy update) makes the first CAS conflict; the shred re-reads and
    // converges, and the sweep that follows must not be skipped or under-report because of the retry.
    const w = await world();
    await seed(w, [1]);
    await seed(w, [2, 70_000]);

    let conflicted = false;
    const registry = hook(w.registry, 'compareAndSwap', async (...args: never[]) => {
      const [ref, expected, patch] = args as unknown as [SegmentRef, string, { status?: string }];
      if (!conflicted && patch.status === 'destroyed') {
        conflicted = true;
        throw new WriteConflictError('a policy write advanced the row');
      }
      return w.registry.compareAndSwap(ref, expected, patch as never);
    });

    const result = await dropSegment(SEG, { ...w.deps, registry }, CONFIRM);

    expect(conflicted).toBe(true);
    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toEqual([0, 1]);
    expect((await w.registry.get(SEG))?.status).toBe('destroyed');
  });

  it('two concurrent drops converge — one drops, one reports already', async () => {
    const w = await world();
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
  it('leaves NO registry row behind when the segment truly does not exist', async () => {
    // The typo case the facade docs warn about. Claiming the identity here would be registry litter — and worse,
    // a `destroyed` row would refuse a later legitimate load of that name forever.
    const w = await world();
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
    const w = await world();
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
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(publishGeneration(w.registry, { ...SEG, generation: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(fresh(w).segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });
});

describe('dropSegment result fields', () => {
  it('reports generations ascending even when Cold lists them out of order', async () => {
    // Every other assertion in this file is `toHaveLength` — a count, never the contents or the order. So the
    // documented "ascending" was unproven, and the sort was unreachable by test because the fixture seeded in
    // order anyway. Written with explicit generation numbers: the pointer lands on 2 and the later 0/1 publishes
    // are forward-only no-ops, so the bucket holds three objects listed in write order 2, 0, 1.
    const w = await world();
    for (const generation of [2, 0, 1]) {
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation }, [generation + 1], {
        registry: w.registry,
      });
    }

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
    const w = await world(keystore);
    await seed(w, [1, 2]);
    expect((await w.registry.get(SEG))?.wrappedDeks).toHaveLength(1);

    await dropSegment(SEG, w.deps, CONFIRM);

    const row = await w.registry.get(SEG);
    expect(row?.status).toBe('destroyed');
    expect(row?.wrappedDeks).toBeUndefined();
  });

  it('dryRun distinguishes absent from already, and previews the irreversible half', async () => {
    // `reason` on a dry run was entirely uncovered — both branches. A retention sweep dry-running yesterday's
    // already-collected bucket is the primary use case, and `reason` is how it tells "will delete" from "gone".
    const keystore = new InProcessKeystore({
      keys: { k1: randomBytes(32) },
      activeKeyId: 'k1',
    });
    const w = await world(keystore);

    const before = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(before.reason).toBe('absent');
    expect(before.wouldDelete).toEqual([]);
    expect(before.wouldCryptoShred).toBe(false);

    await seed(w, [1, 2]);
    const armed = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });
    expect(armed.reason).toBeUndefined();
    expect(armed.wouldDelete).toEqual([0]);
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
    const w = await world(keystore);
    await seed(w, [1, 2]);

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
    // The point of the facade wrapper: a user should not re-wire registry/cold to delete a segment.
    const w = await world();
    await seed(w, [1, 2, 3]);

    const result = await w.store.dropSegment(SEG, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
    await expect(handle(w).has(1)).resolves.toBe(false);
  });

  it('forwards the audit sink — an encrypted drop still emits the receipt', async () => {
    // Every audit assertion above uses the FREE function. `store.dropSegment` is the path users call, and
    // `segment.erase` is the documented compliance receipt, so a facade that silently dropped the sink would have
    // passed the whole suite.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await seed(w, [1, 2]);

    const events: Array<{ kind: string }> = [];
    const result = await w.store.dropSegment(SEG, {
      ...CONFIRM,
      audit: { onEvent: (e) => events.push(e) },
    });

    expect(result.cryptoShredded).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['segment.erase', 'segment.dispose']);
  });

  it('throws UnsupportedError when the store has no raw cold driver', async () => {
    // The docstring promises this, and nothing asserted it.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const store = new CloudRoaring({
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    });
    await expect(store.dropSegment(SEG, CONFIRM)).rejects.toBeInstanceOf(UnsupportedError);
    // ...and the message must name the operation the caller actually invoked.
    await expect(store.dropSegment(SEG, CONFIRM)).rejects.toThrow(/dropSegment/);
  });

  it('dry-runs through the facade too', async () => {
    const w = await world();
    await seed(w, [1]);

    const preview = await w.store.dropSegment(SEG, { ...CONFIRM, dryRun: true });

    expect(preview.wouldDelete).toHaveLength(1);
    await expect(handle(w).has(1)).resolves.toBe(true);
  });
});

describe('gcOrphanGenerations on a destroyed segment', () => {
  it('collects EVERY generation, because a tombstoned segment has no reader to protect', async () => {
    // The grace window exists for readers pinned to a just-superseded generation. A destroyed segment resolves no
    // generation at all, so nothing is or can become pinned — and nothing else would ever collect these: the
    // reconcile path that deletes generations above `currentGen` returns early on a destroyed row. Without this,
    // a residual left by a drop whose sweep failed is billed forever.
    const w = await world();
    await seed(w, [1]);
    const cold = hook(w.cold, 'delete', async () => {
      throw new Error('bucket unreachable');
    });
    const failed = await dropSegment(SEG, { ...w.deps, cold }, CONFIRM);
    expect(failed.generationsRemaining).toEqual([0]); // tombstoned, bytes still there
    // A late object lands on top of the tombstone, exactly as a load already in flight would leave.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [1, 2], {});
    expect(await generationsInCold(w)).toEqual([0, 5]);

    const collected = await gcOrphanGenerations(SEG, w.deps, { keep: 1 });

    expect(collected.sort((a, b) => a - b)).toEqual([0, 5]);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('still honours the grace window on a live segment', async () => {
    // The negative control: the destroyed branch must not have widened the live one.
    const w = await world();
    await seed(w, [1]);
    await seed(w, [2]);
    await seed(w, [3]); // currentGen = 2
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
    const w = await world();
    await seed(w, [1, 2, 3]);
    const events: Array<{ kind: string; generationsDeleted?: number }> = [];

    await dropSegment(SEG, w.deps, { ...CONFIRM, audit: { onEvent: (e) => events.push(e) } });

    expect(events.map((e) => e.kind)).toEqual(['segment.dispose']);
    expect(events[0]?.generationsDeleted).toBe(1);
  });

  it('an ENCRYPTED drop emits both — the shred and the reclamation each really happened', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await seed(w, [1, 2]);
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
    const w = await world();
    const events: Array<{ kind: string }> = [];
    const result = await dropSegment(SEG, w.deps, {
      ...CONFIRM,
      audit: { onEvent: (e) => events.push(e) },
    });
    expect(result.reason).toBe('absent');
    expect(events).toEqual([]);
  });

  it('a dry run emits nothing — it is a preview, not a state change', async () => {
    const w = await world();
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
