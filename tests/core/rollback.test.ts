import { listGenerations, rollbackSegment } from '@/core/rollback';
import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, ValidationError } from '@/core/errors';
import { destroySegment } from '@/core/erasure';
import { InProcessKeystore } from '@/drivers/crypto';
import { randomBytes } from 'node:crypto';
import { MemoryStorage, CloudRoaring, RecordingAuditSink } from '@/index';
import { WriteConflictError } from '@/core/errors';
import { openGenerationReader } from '@/core/crbm-storage-source';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * `listGenerations` / `rollbackSegment` — see what a segment has been, and put it back.
 *
 * Immutable generations mean the previous version of a segment is usually still in the bucket: the load that
 * replaced it wrote a new object and moved a pointer rather than overwriting anything. Recovering from a bad load
 * is therefore moving the pointer back — which every other write path in the library refuses to do, because
 * forward-only is what stops a slow loader silently undoing a fast one. These tests pin that the refusal stays
 * exactly where it belongs (on writers) and that the one call which overrides it refuses rather than guesses.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  return {
    backend,
    storage,
    registry,
    deps: { storage, registry },
    load: { storage, registry, codec: roaringCodec },
  };
}

describe('listGenerations', () => {
  it('lists what the bucket holds, ascending, with the current one marked', async () => {
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    expect(await listGenerations(SEG, w.deps)).toEqual([
      { generation: 0, current: false },
      { generation: 1, current: false },
      { generation: 2, current: true },
    ]);
  });

  it('reflects collection — it is what remains, not what ever was', async () => {
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 0 });
    expect(await listGenerations(SEG, w.deps)).toEqual([{ generation: 2, current: true }]);
  });

  it('is empty for a segment that does not exist', async () => {
    const w = world();
    expect(await listGenerations(SEG, w.deps)).toEqual([]);
  });
});

describe('rollbackSegment', () => {
  it('moves the pointer back, and the segment reads as the older generation', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 });
    await loadSegment(SEG, [9], w.load, { keep: 9 });

    const store = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1);

    const r = await rollbackSegment(SEG, 0, w.deps);
    expect(r).toEqual({ fromGeneration: 1, generation: 0 });

    const after = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    expect(await after.segment('s', { namespace: 'ns' }).count()).toBe(3);
  });

  it('deletes nothing, so the rollback is itself reversible', async () => {
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    await rollbackSegment(SEG, 0, w.deps);
    // Everything is still there — including the generations now ABOVE the pointer, which is what lets an
    // operator who rolled back too far roll forward again.
    expect((await listGenerations(SEG, w.deps)).map((g) => g.generation)).toEqual([0, 1, 2]);
    // Undoing the rollback needs the opt-in: above the pointer is also where never-published objects live.
    await rollbackSegment(SEG, 2, w.deps, { allowForward: true });
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
  });

  it('refuses an above-pointer target by default — that is where never-published objects live', async () => {
    // A load that wrote its object and died before publishing, and a guard-refused load whose cleanup was
    // skipped because the row had changed, both leave an object ABOVE the pointer. Rolling onto one makes
    // current the very generation a guard refused. Without this refusal, `store.load`'s empty guard could be
    // undone by a rollback that looks entirely routine.
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.load);
    // An orphan above the pointer, never published — exactly what a crashed loader leaves behind.
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 7 }, [], { codec: roaringCodec });

    await expect(rollbackSegment(SEG, 7, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(rollbackSegment(SEG, 7, w.deps)).rejects.toThrow(/above the current pointer/);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);

    // The opt-in is for an operator who knows what they are doing.
    const r = await rollbackSegment(SEG, 7, w.deps, { allowForward: true });
    expect(r.generation).toBe(7);
  });

  it('puts the pointer back when the target is collected while the pointer is moving', async () => {
    // The target is by construction at or below the old pointer — which is exactly generation collection's
    // range — and a collector never writes the registry row, so the token fence cannot see it coming. A listing
    // taken before the swap therefore proves nothing. Without the post-swap check, the swap lands and the
    // segment is left pointing at an object that has just been deleted.
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });

    // Collect generation 0 in the window between the pre-swap listing and the post-swap verification.
    let fired = false;
    const racing = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'compareAndSwap') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.registry, args);
          if (!fired) {
            fired = true;
            await w.storage.delete({ ...SEG, generation: 0 });
          }
          return out;
        };
      },
    }) as typeof w.registry;

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry: racing })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(fired).toBe(true);
    // The pointer is back where it was, naming an object that exists — not the forbidden state.
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(2);
    expect((await listGenerations(SEG, w.deps)).map((g) => g.generation)).toContain(
      row.currentGen!,
    );
  });

  it('does not claim the pointer was left on the collected generation when the undo landed and lost its response', async () => {
    // The undo is a swap like any other, and a swap can apply and still throw — a response lost on the way back. The
    // rollback cannot tell that from a swap that never applied, so what it reports has to hold for both: here the
    // pointer IS back where it was, and a message saying it could not be put back would be false.
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });

    let swaps = 0;
    const flaky = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'compareAndSwap') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.registry, args);
          swaps += 1;
          if (swaps === 1) await w.storage.delete({ ...SEG, generation: 0 }); // collected while the pointer moved
          if (swaps === 2) throw new Error('response lost'); // the undo applied, and its answer never arrived
          return out;
        };
      },
    }) as typeof w.registry;

    const err = await rollbackSegment(SEG, 0, { ...w.deps, registry: flaky }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NotFoundError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(2); // the undo did land
    expect((err as Error).message).not.toMatch(/could NOT be put back/);
    expect((err as Error).message).toMatch(/may still name 0/);
  });

  it('refuses a generation that is not in the bucket, and names what is', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 0 });
    // Generation 0 was collected. Pointing at it would be the one state the design exists to avoid.
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toBeInstanceOf(NotFoundError);
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toThrow(/present: 1/);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('refuses a generation that never existed', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load);
    await expect(rollbackSegment(SEG, 99, w.deps)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a crypto-shredded segment — every generation of it is unreadable', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    await loadSegment(SEG, [1], { storage, registry, codec: roaringCodec, keystore });
    await loadSegment(SEG, [2], { storage, registry, codec: roaringCodec, keystore }, { keep: 9 });
    await destroySegment(SEG, { registry }, { confirmSegment: 's' });

    await expect(rollbackSegment(SEG, 0, { storage, registry })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses a segment with no registry row', async () => {
    const w = world();
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rolling to the generation already current is a reported no-op', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load);
    const audit = new RecordingAuditSink();
    const r = await rollbackSegment(SEG, 0, w.deps, { audit });
    expect(r).toEqual({ fromGeneration: 0, generation: 0 });
    // Nothing moved, so nothing is audited: the log records pointer moves, not requests.
    expect(audit.snapshot()).toEqual([]);
  });

  it('audits the move, because no other record of it exists', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 0, w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.rollback',
        namespace: 'ns',
        segment: 's',
        fromGeneration: 1,
        generation: 0,
      },
    ]);
  });

  it('rejects a non-integer or negative generation before touching storage', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load);
    await expect(rollbackSegment(SEG, -1, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(rollbackSegment(SEG, 1.5, w.deps)).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });
});

describe('rollback and the forward-only rule', () => {
  it('leaves ordinary publishing forward-only — a later load still wins', async () => {
    // The refusal this call overrides has to stay in place for everything else, or a slow loader could undo a
    // fast one. After a rollback, the next load must still move the pointer FORWARD, past everything present.
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    await rollbackSegment(SEG, 0, w.deps);

    const r = await loadSegment(SEG, [7], w.load, { keep: 9 });
    expect(r.published).toBe(true);
    // `nextGeneration` numbers above everything in the bucket, not above the pointer — so it cannot collide with
    // the generations the rollback left sitting above `currentGen`.
    expect(r.generation).toBe(3);
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
  });

  it('is fenced on the row it read — a concurrent write is not silently undone', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 9 });

    // A load lands between the rollback's row read and its compare-and-swap.
    let fired = false;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'list') return Reflect.get(t, p, rx) as unknown;
        return async function* (ref: SegmentRef) {
          if (!fired) {
            fired = true;
            await loadSegment(SEG, [42], w.load, { keep: 9 });
          }
          yield* w.storage.list(ref);
        };
      },
    }) as typeof w.storage;

    await expect(rollbackSegment(SEG, 0, { ...w.deps, storage: racing })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(fired).toBe(true);
    // The concurrent load stands: a rollback is the most derived write there is, so publishing it into a row
    // that moved since would undo whatever moved it — the opposite of what the operator asked for.
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
  });
});

describe('rollback and erasure — a rollback must not resurrect an erased id', () => {
  it('an erasure reaches a holder ABOVE the pointer, which a rollback made reachable', async () => {
    // The hazard rollback introduces, and it needs no race: roll back, then erase, and an erasure that scans
    // only below the pointer answers `'not-member'` — which `eraseSubject` uses to filter the segment out of the
    // ledger entirely, i.e. a clean Art. 17 receipt — while the subject's bit sits in a generation one rollback
    // away from being served again. Under forward-only alone, nothing above the pointer could ever come back;
    // rollback removes that premise.
    const w = world();
    await loadSegment(SEG, [111, 222], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [111, 222, 999], w.load, { keep: 9 }); // gen 1 — holds the subject
    await rollbackSegment(SEG, 0, w.deps); // gen 1 is now ABOVE the pointer

    const res = await eraseIdFromSegment(SEG, 999, { ...w.load });
    expect(res.erased).toBe(true);
    expect(res.collected).toContain(1); // the above-pointer holder was taken

    // And the rollback that would have resurrected it now cannot: the object is gone.
    await expect(rollbackSegment(SEG, 1, w.deps, { allowForward: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const store = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    expect(await store.segment('s', { namespace: 'ns' }).has(999)).toBe(false);
  });

  it('reaches EVERY holder above the pointer, not only the newest one', async () => {
    // Two rolled-back generations both hold the subject. An erasure that takes the first holder it finds and
    // reports `erased: true` leaves the other one a single `rollback` away from being served again, under a
    // ledger entry that says the id is gone. Driven through the facade, because the ledger is the receipt.
    const w = world();
    await loadSegment(SEG, [111, 222], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [111, 222, 999], w.load, { keep: 9 }); // gen 1 — holds the subject
    await loadSegment(SEG, [111, 222, 999], w.load, { keep: 9 }); // gen 2 — holds the subject
    await rollbackSegment(SEG, 0, w.deps); // gens 1 and 2 are now ABOVE the pointer

    const store = new CloudRoaring({ storage: w.backend, retry: false });
    const ledger = await store.eraseSubject(999, { namespace: 'ns' });
    expect(ledger.erasedFrom).toEqual([
      { segment: 's', namespace: 'ns', erased: true, fromGeneration: 2, generation: undefined },
    ]);

    // The receipt is true: no generation in the bucket holds the id, and neither rollback can bring it back.
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await generationsOf(w.deps)).toEqual([0]);
    for (const g of [1, 2]) {
      await expect(rollbackSegment(SEG, g, w.deps, { allowForward: true })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    expect(await store.segment('s', { namespace: 'ns' }).has(999)).toBe(false);
  });

  it('takes a holder above AND below the pointer, and keeps the rollback targets that never held it', async () => {
    // Only the generations that hold the id are owed a delete above the pointer; the others are an operator's
    // rollback targets and stay. Below the pointer, `keep: 0` takes the whole grace window, as it always has.
    const w = world();
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 0 — holds it (below, after the rollback)
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // gen 1 — the rollback target
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 2 — holds it (above)
    await loadSegment(SEG, [111, 333], w.load, { keep: 9 }); // gen 3 — does NOT hold it (above)
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 4 — holds it (above)
    await rollbackSegment(SEG, 1, w.deps);

    const res = await eraseIdFromSegment(SEG, 999, w.load);
    expect(res).toMatchObject({ erased: true, fromGeneration: 4 });
    expect(res.generation).toBeUndefined(); // nothing to rewrite: the current generation never held it
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await generationsOf(w.deps)).toEqual([1, 3]); // the current one, and the clean rollback target
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a rollback onto a holder mid-scan is reported, and the now-current holder is not deleted', async () => {
    // The race the above-pointer deletes have to survive. Each one is re-proved against the row first, as
    // generation collection re-proves before every delete: once an operator has rolled the pointer onto a
    // generation this call queued for deletion, deleting it would leave the pointer naming a missing object.
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 1
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 2
    await rollbackSegment(SEG, 0, w.deps);

    const storage = onFirstOpenOf(
      w.storage,
      (g) => g > 0,
      () => rollbackSegment(SEG, 1, w.deps, { allowForward: true }),
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage: storage.driver });
    expect(storage.fired()).toBe(true);
    expect(res).toMatchObject({ erased: false, reason: 'superseded' });

    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    expect(await generationsOf(w.deps)).toContain(1); // the pointer names an object that exists

    // Superseded means "re-run", and the re-run settles it: gen 1 is current now, so it is rewritten.
    const rerun = await eraseIdFromSegment(SEG, 999, w.load);
    expect(rerun).toMatchObject({ erased: true, fromGeneration: 1 });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
  });

  it('a load that publishes mid-scan stops the above-pointer deletes, and the bucket decides the receipt', async () => {
    // The pointer moving is a reason to stop deleting above it, not by itself a reason to refuse: a forward
    // publish puts every holder BELOW the new pointer, where the `keep: 0` collection takes them. What is left in
    // the bucket decides, exactly as it does when nothing raced.
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 1
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 2
    await rollbackSegment(SEG, 0, w.deps);

    const storage = onFirstOpenOf(
      w.storage,
      (g) => g > 0,
      async () => {
        await loadSegment(SEG, [111, 222], w.load, { keep: 9 }); // gen 3, published forward-only
      },
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage: storage.driver });
    expect(storage.fired()).toBe(true);
    expect(res).toMatchObject({ erased: true, fromGeneration: 2 });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await generationsOf(w.deps)).toEqual([3]);
  });

  it('a rewrite takes every older generation, the clean ones above the pointer included', async () => {
    // The other half of the rule above. When the current generation holds the id, the rewrite is numbered above
    // everything in the bucket and its `keep: 0` collection takes every generation below that: a clean rollback
    // target above the old pointer is no exception, unlike when the current generation is clean.
    const w = world();
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 0 — holds it, and is current after the rollback
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // gen 1 — clean, above the pointer
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 2 — holds it, above the pointer
    await rollbackSegment(SEG, 0, w.deps);

    const res = await eraseIdFromSegment(SEG, 999, w.load);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 3 });
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(await generationsOf(w.deps)).toEqual([3]);
    expect(await holdersOf(w.storage, 999)).toEqual([]);
  });

  it('a holder that appears above the pointer after the deletes is not attested over', async () => {
    // The receipt on the path where the current generation is clean. The scan found its holder below the pointer
    // and collected it; then a writer that had derived its object from an older generation lands one above the
    // pointer. The bucket, not the call's own list of deletes, decides.
    const w = world();
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 0 — the holder the call finds
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // gen 1 — current, clean

    const late = afterFirstDelete(w.storage, () =>
      bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 9 }, [111, 999]),
    );
    await expect(eraseIdFromSegment(SEG, 999, { ...w.load, storage: late })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(await holdersOf(w.storage, 999)).toEqual([9]); // exactly why it could not say `erased: true`

    // The re-run finds it above the pointer and deletes it.
    const rerun = await eraseIdFromSegment(SEG, 999, w.load);
    expect(rerun).toMatchObject({ erased: true, fromGeneration: 9, collected: [9] });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
  });

  it('…and one that appears without the id does not trip it', async () => {
    const w = world();
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 });
    await loadSegment(SEG, [111], w.load, { keep: 9 });

    const late = afterFirstDelete(w.storage, () =>
      bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 9 }, [111, 333]),
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage: late });
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [0] });
    expect(await generationsOf(w.deps)).toEqual([1, 9]);
  });

  it('a rollback onto a holder between the rewrite’s publish and its collect is not attested', async () => {
    // The rewrite path: the current generation holds the id, and so does a generation a rollback left above
    // it. The rewrite publishes, and before its collection runs an operator rolls back onto that holder —
    // backwards, because the rewrite numbered above everything. Collection takes the lower pointer as its
    // bound, so it takes the old current generation and stops; checking only that one would call this erased
    // while the segment serves the id.
    const w = world();
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // gen 1
    await rollbackSegment(SEG, 0, w.deps);

    let fired = false;
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'compareAndSwap') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.registry, args);
          if (!fired) {
            fired = true; // the rewrite's own publish has just landed
            await rollbackSegment(SEG, 1, w.deps);
          }
          return out;
        };
      },
    }) as typeof w.registry;

    await expect(eraseIdFromSegment(SEG, 999, { ...w.load, registry })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(fired).toBe(true);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await holdersOf(w.storage, 999)).toEqual([1]); // exactly why it could not say `erased: true`

    const rerun = await eraseIdFromSegment(SEG, 999, w.load);
    expect(rerun.erased).toBe(true);
    expect(await holdersOf(w.storage, 999)).toEqual([]);
  });
});

/** Every generation in the bucket, ascending. */
async function generationsOf(deps: { storage: IStorageDriver; registry: IRegistryDriver }) {
  return (await listGenerations(SEG, deps)).map((g) => g.generation);
}

/** The generations still in the bucket whose chunk 0 holds `id` — the ground truth a receipt is checked against. */
async function holdersOf(storage: IStorageDriver, id: number): Promise<number[]> {
  const out: number[] = [];
  for await (const key of storage.list(SEG)) {
    const bytes = await (await openGenerationReader(storage, key, undefined)).getChunk(0);
    if (bytes !== null && roaringCodec.safeDeserialize(bytes, 1 << 20).has(id)) {
      out.push(key.generation);
    }
  }
  return out.sort((a, b) => a - b);
}

/** A storage driver that runs `hook` once, right after the first `delete` returns. */
function afterFirstDelete(base: IStorageDriver, hook: () => Promise<unknown>): IStorageDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getRange: (k, o, l) => base.getRange(k, o, l),
    getTail: (k, m) => base.getTail(k, m),
    list: (r) => base.list(r),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    delete: async (k) => {
      await base.delete(k);
      if (!fired) {
        fired = true;
        await hook();
      }
    },
  };
}

/** A storage driver that runs `hook` once, just before the first object open of a generation `match` selects. */
function onFirstOpenOf(
  base: IStorageDriver,
  match: (generation: number) => boolean,
  hook: () => Promise<unknown>,
): { driver: IStorageDriver; fired: () => boolean } {
  let fired = false;
  const driver: IStorageDriver = {
    capabilities: () => base.capabilities(),
    getRange: (k, o, l) => base.getRange(k, o, l),
    delete: (k) => base.delete(k),
    list: (r) => base.list(r),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    getTail: async (k, m) => {
      if (!fired && match(k.generation)) {
        fired = true;
        await hook();
      }
      return base.getTail(k, m);
    },
  };
  return { driver, fired: () => fired };
}

describe('rollback — the facade, and the validation the core owes', () => {
  it('store.rollback drops this store’s cached view, so the same instance reads the older generation', async () => {
    // The one piece of genuinely new logic in the facade, and the interesting case: unlike a load, a rollback
    // moves the pointer to content the caches may still be holding from before. A core-level test that reads
    // through a FRESH store cannot see this.
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 });
    await loadSegment(SEG, [9], w.load, { keep: 9 });

    const store = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1); // warm the caches
    await store.rollback(SEG, 0);
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(3); // same instance
  });

  it('store.rollback takes the same options as rollbackSegment, allowForward included', () => {
    // Type-level: the store's wired form must not narrow the free function's options. A narrower type makes a
    // documented call — undoing a rollback — a compile error for every TypeScript caller of the store.
    expectTypeOf<NonNullable<Parameters<CloudRoaring['rollback']>[2]>>().toEqualTypeOf<
      NonNullable<Parameters<typeof rollbackSegment>[3]>
    >();
  });

  it('store.rollback rolls forward with allowForward, and refuses it without', async () => {
    // Undoing a rollback through the store: the target sits above the pointer, which is refused unless the call
    // opts in, and with the opt-in the same store instance reads the newer generation and audits the move.
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 }); // gen 0
    await loadSegment(SEG, [9], w.load, { keep: 9 }); // gen 1
    const store = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    await store.rollback(SEG, 0);
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(3);

    await expect(store.rollback(SEG, 1)).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);

    const audit = new RecordingAuditSink();
    const r = await store.rollback(SEG, 1, { allowForward: true, audit });
    expect(r).toEqual({ fromGeneration: 0, generation: 1 });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1); // same instance
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.rollback', namespace: 'ns', segment: 's', fromGeneration: 0, generation: 1 },
    ]);
  });

  it('store.generations reports what the bucket holds', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    const store = new CloudRoaring({
      storage: w.backend,
      retry: false,
    });
    expect(await store.generations(SEG)).toEqual([
      { generation: 0, current: false },
      { generation: 1, current: true },
    ]);
  });

  it('validates the ref before touching storage', async () => {
    const w = world();
    await expect(rollbackSegment({ segment: '' }, 0, w.deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listGenerations({ segment: '' }, w.deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it('says so when no generations remain at all', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    for (const g of [0, 1]) await w.storage.delete({ ...SEG, generation: g });
    // Target 0 rather than the current generation: rolling to the one already current short-circuits as a
    // reported no-op before anything is looked up, which is correct — it changes nothing.
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toThrow(/no generations remain/);
  });
});
