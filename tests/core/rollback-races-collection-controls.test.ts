import { destroySegment } from '@/core/erasure';
import { eraseIdFromSegment } from '@/core/erase-id';
import { KeyUnavailableError, NotFoundError, TransientError, ValidationError } from '@/core/errors';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { RecordingAuditSink } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * The controls of the race in `rollback-races-collection.test.ts`: the rows and buckets a delete loop meets after its
 * delete that are NOT a rollback onto a generation it deleted, and must raise nothing, and the faults and paths that
 * must keep what the loop found. A loop holds a read of the row after a delete to what it deleted only when the row is
 * active, of the incarnation the loop read, names a generation it deleted, and the bucket has no object under that
 * number; every other case is one of these.
 *
 * Gated promises hold each loop between its read and its delete, and the clock never waits, so a run is the same every
 * time.
 */

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec, clock } };
}
type World = ReturnType<typeof world>;

/** `storage`, whose first delete of `generation` waits at `at` and runs `after` once it has landed. */
function hookedDelete(
  storage: IStorageDriver,
  generation: number,
  hooks: { at?: ReturnType<typeof gate>; after?: () => Promise<void> },
): IStorageDriver {
  let used = false;
  const hooked = Object.create(storage) as IStorageDriver;
  hooked.delete = async (key, options) => {
    const mine = !used && key.generation === generation;
    if (mine) {
      used = true;
      if (hooks.at !== undefined) {
        hooks.at.reach();
        await hooks.at.opened;
      }
    }
    await storage.delete(key, options);
    if (mine) await hooks.after?.();
  };
  return hooked;
}

/** Wait until `call` stops at `at`; a call that ends first fails the test rather than hanging it. */
async function stalledAt(at: ReturnType<typeof gate>, call: Promise<unknown>): Promise<void> {
  const ended = call.then(
    () => 'ended without reaching the delete',
    (err: unknown) => `failed before reaching the delete: ${String(err)}`,
  );
  expect(await Promise.race([at.reached.then(() => 'reached'), ended])).toBe('reached');
}

/** Generations 0 to `last`, one id each, kept. */
async function loaded(w: World, last: number): Promise<void> {
  for (let g = 0; g <= last; g += 1) await loadSegment(REF, [g + 1], w.deps, { keep: 9 });
}

/** The row is purged and made again, naming `generation` over no object: another segment's number. */
async function purgedAndMadeAgain(w: World, generation: number): Promise<void> {
  await w.registry.delete(REF);
  await w.registry.create(REF, { currentGen: generation });
}

/** What a call settled to: its result, or the error it threw. */
const settled = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    (value) => value,
    (err: unknown) => err,
  );

describe('a fault of the read of the bucket after a delete', () => {
  it('is thrown by the collection, never taken for a missing object nor for one that is there', async () => {
    const w = world();
    await loaded(w, 3);
    const at = gate();
    let faulty = false;
    const flaky = Object.create(w.storage) as IStorageDriver;
    flaky.getTail = async (key, max) => {
      if (faulty) throw new TransientError('storage unavailable');
      return w.storage.getTail(key, max);
    };
    const pass = gcOrphanGenerations(
      REF,
      { storage: hookedDelete(flaky, 0, { at }), registry: w.registry },
      { keep: 2 },
    );
    await stalledAt(at, pass);
    await rollbackSegment(REF, 0, w.deps);
    faulty = true;
    at.open();
    await expect(pass).rejects.toBeInstanceOf(TransientError);
  });
});

describe('a row purged and made again, naming a number just deleted, is another segment', () => {
  it('the listing pass raises nothing and reports what it deleted', async () => {
    const w = world();
    await loaded(w, 3);
    const pass = gcOrphanGenerations(
      REF,
      {
        storage: hookedDelete(w.storage, 0, { after: () => purgedAndMadeAgain(w, 0) }),
        registry: w.registry,
      },
      { keep: 2 },
    );
    await expect(pass).resolves.toEqual([0]);
  });

  it("a refused load's reclaim raises nothing, and the load answers with its refusal", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps);
    const audit = new RecordingAuditSink();
    const load = loadSegment(
      REF,
      [],
      {
        ...w.deps,
        storage: hookedDelete(w.storage, 1, { after: () => purgedAndMadeAgain(w, 1) }),
      },
      { audit },
    );
    await expect(load).resolves.toMatchObject({ generation: 1, published: false, reason: 'empty' });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.load-refused']);
  });

  it("an erasure's delete above the pointer raises nothing about a missing object", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 });
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 1 holds the id
    await rollbackSegment(REF, 0, w.deps);
    const erasure = eraseIdFromSegment(REF, X, {
      ...w.deps,
      storage: hookedDelete(w.storage, 1, { after: () => purgedAndMadeAgain(w, 1) }),
    });
    // Nothing left in the bucket holds the id: the row it now reads is another segment's, which never held it.
    await expect(erasure).resolves.toMatchObject({ erased: true, collected: [1] });
  });
});

describe('a pointer on a deleted number with an object under it is not missing anything', () => {
  it("a load's eviction by name raises nothing when a writer took the number again and published it", async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps);
    await loadSegment(REF, [2], w.deps, { keep: 9 });
    const at = gate();
    const load = loadSegment(REF, [3], {
      ...w.deps,
      storage: hookedDelete(w.storage, 0, {
        at,
        // Where a driver ignores a delete's condition, a writer that took number 0 again and published it has its
        // object under the pointer when the loop reads the row: the object is there.
        after: async () => {
          await w.storage.putImmutable({ ...REF, generation: 0 }, (sink) =>
            sink.write(new Uint8Array([1, 2, 3])),
          );
        },
      }),
    });
    await stalledAt(at, load);
    await rollbackSegment(REF, 0, w.deps);
    at.open();
    await expect(load).resolves.toMatchObject({ generation: 2, published: true, collected: [0] });
    expect(await generations(w.storage)).toEqual([0, 1, 2]);
  });
});

describe('a refusal the publish raises as an error, after its reclaim left the pointer on the object it deleted', () => {
  for (const [name, refusal] of [
    ['ValidationError', new ValidationError('the row is over the cap')],
    ['KeyUnavailableError', new KeyUnavailableError('the key is not available')],
  ] as const) {
    it(`throws NotFoundError naming the ${name} in place of it`, async () => {
      const w = world();
      await loadSegment(REF, [1, 2, 3], w.deps);
      const at = gate();
      const refusing = Object.create(w.registry) as IRegistryDriver;
      refusing.compareAndSwap = () => Promise.reject(refusal);
      const audit = new RecordingAuditSink();
      const load = loadSegment(
        REF,
        [4, 5, 6],
        { ...w.deps, registry: refusing, storage: hookedDelete(w.storage, 1, { at }) },
        { audit },
      );
      await stalledAt(at, load);
      await rollbackSegment(REF, 1, w.deps, { allowForward: true });
      at.open();
      const err = await settled(load);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toMatch(
        new RegExp(
          `the load was refused \\(${name}: ${refusal.message}\\).*deleted generation 1\\b`,
        ),
      );
      // A refusal the publish raised is not one the load answers, so it is not audited as one.
      expect(audit.snapshot()).toEqual([]);
      expect((await w.registry.get(REF))?.currentGen).toBe(1);
      expect(await generations(w.storage)).toEqual([0]);
    });
  }
});

describe('a load whose current object is gone, which collects by listing, raced by a rollback', () => {
  it('throws NotFoundError saying the load took effect', async () => {
    const w = world();
    for (let g = 0; g <= 3; g += 1) await loadSegment(REF, [g + 1], w.deps, { keep: 2 });
    await w.storage.delete({ ...REF, generation: 3 }); // the row names 3, and its object is gone
    const at = gate();
    const load = loadSegment(
      REF,
      [50],
      { ...w.deps, storage: hookedDelete(w.storage, 1, { at }) },
      { keep: 1 },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 1, w.deps);
    at.open();
    const err = await settled(load);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(
      /the load took effect at generation 4, but its collection deleted generation 1\b/,
    );
  });
});

describe('an erasure whose collection below the pointer was raced stops before it deletes above the pointer', () => {
  it('a holder above the pointer is kept, and the NotFoundError is raised', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 0 holds the id
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 }); // 1 does not
    await loadSegment(REF, [1, 2, 3, X, 7], w.deps, { keep: 9 }); // 2 holds the id
    await rollbackSegment(REF, 1, w.deps); // current 1: 0 below it, 2 above it
    const at = gate();
    const erasure = eraseIdFromSegment(REF, X, {
      ...w.deps,
      storage: hookedDelete(w.storage, 0, { at }),
    });
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 0, w.deps);
    at.open();
    const err = await settled(erasure);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/an erasure deleted generation 0\b/);
    // It stopped at the missing object and deleted nothing more.
    expect(await generations(w.storage)).toEqual([1, 2]);
  });
});

describe('a refused load keeps its object under a row another load changed', () => {
  it('one a reader leased included', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps);
    let lost = false;
    const lossy = Object.create(w.registry) as IRegistryDriver;
    lossy.compareAndSwap = async (ref, expected, patch) => {
      const written = await w.registry.compareAndSwap(ref, expected, patch);
      if (lost) return written;
      lost = true;
      // Another load publishes 2 and keeps nothing; a reader holds a lease on this load's generation, 1.
      await loadSegment(REF, [7, 8, 9], w.deps, { keep: 9 });
      const row = await w.registry.get(ref);
      if (row === null) throw new Error('the row is gone');
      await w.registry.compareAndSwap(ref, row.token, {
        keptGens: [],
        leases: [{ holder: '0123456789abcdef', generation: 1, until: 4_000_000_000_000 }],
      });
      throw new TransientError('connection reset after the write');
    };
    await expect(
      loadSegment(REF, [4, 5, 6], { ...w.deps, registry: lossy }),
    ).resolves.toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    const row = await w.registry.get(REF);
    expect(row?.currentGen).toBe(2);
    expect(row?.leases?.map((l) => l.generation)).toEqual([1]);
    expect(await generations(w.storage)).toEqual([0, 1, 2]);
  });
});

describe('a segment destroyed between the read that allowed the delete and the delete', () => {
  const destroy = (w: World) =>
    destroySegment(REF, w.deps, { confirmSegment: REF.segment, allowCleartext: true });

  it("a load's eviction by name raises nothing: no reader resolves a tombstone's generations", async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps);
    await loadSegment(REF, [2], w.deps, { keep: 9 });
    const at = gate();
    const load = loadSegment(REF, [3], { ...w.deps, storage: hookedDelete(w.storage, 0, { at }) });
    await stalledAt(at, load);
    await rollbackSegment(REF, 0, w.deps);
    await destroy(w);
    at.open();
    // Its publish had landed, and that is its answer.
    await expect(load).resolves.toMatchObject({ generation: 2, published: true, collected: [0] });
  });

  it("a refused load's reclaim raises nothing about a missing object", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps);
    const at = gate();
    const load = loadSegment(REF, [], { ...w.deps, storage: hookedDelete(w.storage, 1, { at }) });
    await stalledAt(at, load);
    await rollbackSegment(REF, 1, w.deps, { allowForward: true });
    await destroy(w);
    at.open();
    await expect(load).resolves.toMatchObject({ generation: 1, published: false, reason: 'empty' });
  });

  it("an erasure's delete above the pointer raises nothing about a missing object", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 });
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 1 holds the id
    await rollbackSegment(REF, 0, w.deps);
    const at = gate();
    const erasure = eraseIdFromSegment(REF, X, {
      ...w.deps,
      storage: hookedDelete(w.storage, 1, { at }),
    });
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 1, w.deps, { allowForward: true });
    await destroy(w);
    at.open();
    // No generation in the bucket holds the id, and no reader resolves a tombstone's generations.
    await expect(erasure).resolves.toMatchObject({
      erased: true,
      fromGeneration: 1,
      collected: [1],
    });
  });
});

describe('a pointer on an object lost out of band, not on a number the erasure deleted', () => {
  it('is not blamed on the erasure that deleted a holder above it', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 });
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 1 holds the id
    await rollbackSegment(REF, 0, w.deps);
    const at = gate();
    const erasure = eraseIdFromSegment(REF, X, {
      ...w.deps,
      storage: hookedDelete(w.storage, 1, { at }),
    });
    await stalledAt(at, erasure);
    await w.storage.delete({ ...REF, generation: 0 }); // the row now names an absent object
    at.open();
    // The pointer names 0, which the erasure never deleted: that state is the consistency check's to report.
    await expect(erasure).resolves.toMatchObject({
      erased: true,
      fromGeneration: 1,
      collected: [1],
    });
  });
});
