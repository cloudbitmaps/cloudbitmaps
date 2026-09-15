import { listGenerations, rollbackSegment } from '@/core/rollback';
import { loadSegment } from '@/core/load';
import { NotFoundError, ValidationError } from '@/core/errors';
import { destroySegment } from '@/core/erasure';
import { InProcessKeystore } from '@/drivers/crypto';
import { randomBytes } from 'node:crypto';
import { CloudRoaring, MemoryColdDriver, MemoryRegistryDriver, RecordingAuditSink } from '@/index';
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
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  return {
    cold,
    registry,
    deps: { cold, registry },
    load: { cold, registry, codec: roaringCodec },
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

    const store = new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(1);

    const r = await rollbackSegment(SEG, 0, w.deps);
    expect(r).toEqual({ fromGeneration: 1, generation: 0 });

    const after = new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });
    expect(await after.segment('s', { namespace: 'ns' }).count()).toBe(3);
  });

  it('deletes nothing, so the rollback is itself reversible', async () => {
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, w.load, { keep: 9 });
    await rollbackSegment(SEG, 0, w.deps);
    // Everything is still there — including the generations now ABOVE the pointer, which is what lets an
    // operator who rolled back too far roll forward again.
    expect((await listGenerations(SEG, w.deps)).map((g) => g.generation)).toEqual([0, 1, 2]);
    await rollbackSegment(SEG, 2, w.deps);
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
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
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    await loadSegment(SEG, [1], { cold, registry, codec: roaringCodec, keystore });
    await loadSegment(SEG, [2], { cold, registry, codec: roaringCodec, keystore }, { keep: 9 });
    await destroySegment(SEG, { registry }, { confirmSegment: 's' });

    await expect(rollbackSegment(SEG, 0, { cold, registry })).rejects.toBeInstanceOf(
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
    const racing = new Proxy(w.cold, {
      get(t, p, rx) {
        if (p !== 'list') return Reflect.get(t, p, rx) as unknown;
        return async function* (ref: SegmentRef) {
          if (!fired) {
            fired = true;
            await loadSegment(SEG, [42], w.load, { keep: 9 });
          }
          yield* w.cold.list(ref);
        };
      },
    }) as typeof w.cold;

    await expect(rollbackSegment(SEG, 0, { ...w.deps, cold: racing })).rejects.toThrow();
    expect(fired).toBe(true);
    // The concurrent load stands: a rollback is the most derived write there is, so publishing it into a row
    // that moved since would undo whatever moved it — the opposite of what the operator asked for.
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
  });
});
