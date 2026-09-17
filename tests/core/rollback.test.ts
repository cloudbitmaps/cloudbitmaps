import { listGenerations, rollbackSegment } from '@/core/rollback';
import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, ValidationError } from '@/core/errors';
import { destroySegment } from '@/core/erasure';
import { InProcessKeystore } from '@/drivers/crypto';
import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  MemoryStorageDriver,
  MemoryRegistryDriver,
  RecordingAuditSink,
  bulkLoadCrbmGeneration,
} from '@/index';
import { WriteConflictError } from '@/core/errors';
import type { SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';

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
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
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

    const store = new CloudRoaring({ storage: w.storage, registry: w.registry, retry: false });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1);

    const r = await rollbackSegment(SEG, 0, w.deps);
    expect(r).toEqual({ fromGeneration: 1, generation: 0 });

    const after = new CloudRoaring({ storage: w.storage, registry: w.registry, retry: false });
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
    // current the very generation a guard refused. Before this refusal existed, `store.load`'s empty guard
    // could be undone by a rollback that looked entirely routine.
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
    // taken before the swap therefore proves nothing. Reproduced before the fix: the swap landed and the
    // segment was left pointing at an object that had just been deleted.
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
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
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
    // The hazard rollback introduces, and it needs no race. Before this was closed: roll back, then erase, and
    // the erasure answered `'not-member'` — which `eraseSubject` uses to filter the segment out of the ledger
    // entirely, i.e. a clean Art. 17 receipt — while the subject's bit sat in a generation one rollback away
    // from being served again. The scan was bounded below the pointer because, under forward-only, nothing
    // above it could ever come back. Rollback ended that premise.
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

    const store = new CloudRoaring({ storage: w.storage, registry: w.registry, retry: false });
    expect(await store.segment('s', { namespace: 'ns' }).has(999)).toBe(false);
  });
});

describe('rollback — the facade, and the validation the core owes', () => {
  it('store.rollback drops this store’s cached view, so the same instance reads the older generation', async () => {
    // The one piece of genuinely new logic in the facade, and the interesting case: unlike a load, a rollback
    // moves the pointer to content the caches may still be holding from before. A core-level test that reads
    // through a FRESH store cannot see this.
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 });
    await loadSegment(SEG, [9], w.load, { keep: 9 });

    const store = new CloudRoaring({ storage: w.storage, registry: w.registry, retry: false });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1); // warm the caches
    await store.rollback(SEG, 0);
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(3); // same instance
  });

  it('store.generations reports what the bucket holds', async () => {
    const w = world();
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    const store = new CloudRoaring({ storage: w.storage, registry: w.registry, retry: false });
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
