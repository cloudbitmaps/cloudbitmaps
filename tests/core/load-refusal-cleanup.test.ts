import { windowOf } from '@/core/known-generations';
import { runConsistencyCheck } from '@cloudbitmaps/core';
import { openGenerationReader } from '@/core/crbm-open';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { KeyUnavailableError, NotFoundError, ValidationError } from '@/core/errors';
import { rollbackSegment } from '@/core/rollback';
import { storeCodec } from '../helpers/store-codec';
import { RecordingAuditSink, TransientError } from '@/index';
import type { SegmentRef } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { gate } from '../helpers/retaken-number-race';
import { testEntropy } from '../helpers/entropy';

/**
 * A refused load deletes the object it wrote, best-effort: a fault in that cleanup must not replace the refusal, which
 * is an answer and not an error, nor drop its audit event. The object it leaves is above the pointer, where the next
 * load that numbers past it collects it.
 */
const REF: SegmentRef = { segment: 's' };

function deletesFail(real: MemoryStorageDriver): IStorageDriver {
  return {
    capabilities: () => real.capabilities(),
    getTail: (k, m) => real.getTail(k, m),
    getRange: (k, o, l) => real.getRange(k, o, l),
    list: (r) => real.list(r),
    putImmutable: (k, fn) => real.putImmutable(k, fn),
    delete: () => Promise.reject(new TransientError('storage unavailable')),
  };
}

describe('a refused load whose cleanup fails is still a refusal', () => {
  it('a guard refusal is returned and audited when the delete of its object fails', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await loadSegment(
      REF,
      Array.from({ length: 10 }, (_, i) => i + 1),
      {
        storage,
        registry,
        entropy: testEntropy,
        codec: storeCodec,
      },
    );
    const audit = new RecordingAuditSink();
    const res = await loadSegment(
      REF,
      [1],
      { storage: deletesFail(storage), registry, entropy: testEntropy, codec: storeCodec },
      { guard: { minRetained: 0.5 }, audit },
    );
    expect(res).toMatchObject({ published: false, reason: 'min-retained' });
    expect(audit.snapshot().map((e) => e.kind)).toContain('segment.load-refused');
    expect((await registry.get(REF))!.currentGen).toBe(0);
  });
});

describe('a refusal the publish raises as an error', () => {
  // A publish states three refusals by throwing, each before that attempt's write is sent, and a registry raises
  // `ValidationError` only from checks it makes before sending a write. The load treats both classes as a definite
  // refusal: it reclaims its object as any refused load does, and rethrows. Anything else may still land, so the object
  // stays. A segment with no row: the reclaim finds none, and deletes the object its footer proves the load's own.
  const objects = async (storage: IStorageDriver): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of storage.list(REF)) out.push(k.generation);
    return out;
  };
  const createThrows = (registry: MemoryRegistryDriver, err: Error): IRegistryDriver => {
    const stub = Object.create(registry) as IRegistryDriver;
    stub.create = () => Promise.reject(err);
    return stub;
  };

  it.each<[string, Error]>([
    ['ValidationError', new ValidationError('the row is over the registry size cap')],
    ['KeyUnavailableError', new KeyUnavailableError('the key cannot be unwrapped')],
  ])(
    'a %s from the registry is rethrown, nothing is published, and the object is reclaimed',
    async (_, err) => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const audit = new RecordingAuditSink();
      await expect(
        loadSegment(
          REF,
          [1, 2, 3],
          {
            storage,
            registry: createThrows(registry, err),
            entropy: testEntropy,
            codec: storeCodec,
          },
          { allowEmpty: true, audit },
        ),
      ).rejects.toBe(err);
      expect(await registry.get(REF)).toBeNull();
      expect(await objects(storage)).toEqual([]);
      expect(audit.snapshot().map((e) => e.kind)).not.toContain('segment.publish');
    },
  );

  it('a fault that is not a refusal is rethrown and keeps the object', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const err = new Error('socket hang up');
    await expect(
      loadSegment(
        REF,
        [1, 2, 3],
        {
          storage,
          registry: createThrows(registry, err),
          entropy: testEntropy,
          codec: storeCodec,
        },
        { allowEmpty: true },
      ),
    ).rejects.toBe(err);
    expect(await registry.get(REF)).toBeNull();
    expect(await objects(storage)).toEqual([0]);
  });
});

describe('a refused load whose row another writer changed', () => {
  /**
   * The object a refused load wrote, once another writer has changed the row, stays in the bucket: its number may by
   * then name another writer's object, which a read of its footer cannot tell from this load's own when that writer
   * loaded the same ids. Left there, an object below the pointer is an orphan a later load's listing takes, and until
   * then a rollback target, since a rollback checks only that its target is stored, sealed to match the row, and opens:
   *
   *   stale loader   reads the row at 5, finds 6 free ── stalls before its put ──────────▶ writes 6, is refused
   *   two loads                       publish 6 (deleting 5), then 7 (deleting 6) │
   */
  const objects = async (storage: IStorageDriver): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of storage.list(REF)) out.push(k.generation);
    return out.sort((a, b) => a - b);
  };
  const world = () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    return {
      storage,
      registry,
      deps: { storage, registry, entropy: testEntropy, codec: storeCodec },
    };
  };
  const consistent = async (w: ReturnType<typeof world>): Promise<void> => {
    const report = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
    expect(report.inconsistent).toEqual([]);
  };

  /** A stalled loader of an empty set refused below the pointer, as the diagram above runs it. */
  async function stalledBelowThePointer(w: ReturnType<typeof world>): Promise<void> {
    for (let g = 0; g <= 5; g++) await loadSegment(REF, [g + 1], w.deps, { keep: 0 }); // current 5
    const at = gate();
    let held = false;
    const stalling = Object.create(w.storage) as IStorageDriver;
    stalling.putImmutable = async (key, write) => {
      if (!held && key.generation === 6) {
        held = true;
        at.reach();
        await at.opened;
      }
      return w.storage.putImmutable(key, write);
    };
    const stale = loadSegment(
      REF,
      [],
      { ...w.deps, storage: stalling },
      { allowEmpty: true, keep: 0 },
    );
    await at.reached;
    await loadSegment(REF, [7], w.deps, { keep: 0 }); // 6, deleting 5
    await loadSegment(REF, [8], w.deps, { keep: 0 }); // 7, deleting 6
    expect(await objects(w.storage)).toEqual([7]);
    at.open();

    // It writes 6 afresh, below the pointer now, and is refused.
    await expect(stale).resolves.toMatchObject({
      generation: 6,
      published: false,
      reason: 'superseded',
    });
  }

  it("keeps a stalled loader's object below the pointer, and a listing takes it", async () => {
    const w = world();
    await stalledBelowThePointer(w);
    expect(await objects(w.storage)).toEqual([6, 7]);
    expect((await w.registry.get(REF))!.currentGen).toBe(7);
    await consistent(w);
    expect(await gcOrphanGenerations(REF, w.deps, { keep: 0 })).toEqual([6]);
    expect(await objects(w.storage)).toEqual([7]);
    // The row never knew 6, so a rollback is refused for that; the override reaches the bucket and finds it gone.
    await expect(rollbackSegment(REF, 6, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(rollbackSegment(REF, 6, w.deps, { allowUnknown: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('until a listing takes it, only allowUnknown lets a rollback name it, and publishes what no load published', async () => {
    const w = world();
    await stalledBelowThePointer(w);
    // The refused load's object is in no row's record of what it published: a rollback refuses it unless told not to.
    await expect(rollbackSegment(REF, 6, w.deps)).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(REF))!.currentGen).toBe(7);
    await expect(rollbackSegment(REF, 6, w.deps, { allowUnknown: true })).resolves.toMatchObject({
      generation: 6,
    });
    expect((await w.registry.get(REF))!.currentGen).toBe(6);
    // The generation the rollback restored is the refused load's empty one.
    const reader = await openGenerationReader(w.storage, { ...REF, generation: 6 }, undefined);
    expect(reader.count()).toBe(0);
  });

  it('keeps an object that landed unanswered and that the next publish keeps in its window', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    // This load's compare-and-swap lands and its answer is lost; before the load reads the row back, another load
    // publishes over it with a window of one, which keeps this load's generation.
    let lost = false;
    const lossy = Object.create(w.registry) as IRegistryDriver;
    lossy.compareAndSwap = async (ref, expected, patch, options) => {
      // The write is sent, so it reports its token first, as a registry does; its answer is what is lost.
      const written = await w.registry.compareAndSwap(
        ref,
        expected,
        patch,
        lost ? undefined : options,
      );
      if (lost) return written;
      lost = true;
      await loadSegment(REF, [7, 8, 9], w.deps);
      throw new TransientError('connection reset after the write');
    };
    const audit = new RecordingAuditSink();
    await expect(
      loadSegment(REF, [4, 5, 6], { ...w.deps, registry: lossy }, { audit }),
    ).resolves.toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(audit.snapshot()).toContainEqual(
      expect.objectContaining({ kind: 'segment.load-refused', unanswered: true }),
    );
    const row = (await w.registry.get(REF))!;
    expect(row.currentGen).toBe(2);
    expect(windowOf(row)).toEqual([1]);
    expect(await objects(w.storage)).toEqual([1, 2]);
    await consistent(w);
  });

  it('keeps an object the pointer names by the time the refusal reads the row', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    // Right after this load writes its empty object at 1, a forward rollback moves the pointer onto it. The guard then
    // refuses the empty load, and the row its refusal reads names the object.
    let rolled = false;
    const racing = Object.create(w.storage) as IStorageDriver;
    racing.putImmutable = async (key, write) => {
      const out = await w.storage.putImmutable(key, write);
      if (!rolled) {
        rolled = true;
        await rollbackSegment(REF, 1, w.deps, { allowUnknown: true });
      }
      return out;
    };
    await expect(loadSegment(REF, [], { ...w.deps, storage: racing })).resolves.toMatchObject({
      generation: 1,
      published: false,
      reason: 'empty',
    });
    expect(rolled).toBe(true);
    expect((await w.registry.get(REF))!.currentGen).toBe(1);
    expect(await objects(w.storage)).toEqual([0, 1]);
    await consistent(w);
  });
});
