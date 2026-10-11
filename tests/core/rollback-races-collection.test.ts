import { runConsistencyCheck } from '@cloudbitmaps/core';
import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, WriteConflictError } from '@/core/errors';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { RecordingAuditSink } from '@/index';
import type { IStorageDriver } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * A rollback that lands between a delete loop's read of the row and its delete. Every loop that deletes generations
 * re-reads the row before each delete (invariant 4), and one round trip remains between that read and the delete:
 *
 *   delete loop      reads the row: g is collectable ── stalls ───────────────────────────────▶ deletes g
 *   rollback                                  lists: g is there │ moves the pointer onto g │ lists: g is there
 *
 * The rollback's own check runs before the delete, so it reports success, and the row then names an object that is
 * gone. Nothing can put that object back, so each loop detects it instead: a row it reads after a delete (the next
 * re-read, or one read after its last delete) that names a generation it deleted raises `NotFoundError`, which tells
 * the caller to roll back to a generation still in the bucket. `checkConsistency` reports the state either way.
 *
 * Gated promises hold each loop between its read and its delete while the rollback runs to the end, and the clock
 * never waits, so a run is the same every time.
 */

type Gate = ReturnType<typeof gate>;

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec, clock } };
}
type World = ReturnType<typeof world>;

/** `storage`, whose first delete of `generation` waits at `at` before it is sent. */
function stallingDelete(storage: IStorageDriver, generation: number, at: Gate): IStorageDriver {
  let held = false;
  const gated = Object.create(storage) as IStorageDriver;
  gated.delete = async (key, options) => {
    if (!held && key.generation === generation) {
      held = true;
      at.reach();
      await at.opened;
    }
    return storage.delete(key, options);
  };
  return gated;
}

/** Wait until `call` stops at `at`; a call that ends first fails the test rather than hanging it. */
async function stalledAt(at: Gate, call: Promise<unknown>): Promise<void> {
  const ended = call.then(
    () => 'ended without reaching the delete',
    (err: unknown) => `failed before reaching the delete: ${String(err)}`,
  );
  expect(await Promise.race([at.reached.then(() => 'reached'), ended])).toBe('reached');
}

/** The rejection a delete loop raises when the row names a generation it deleted. */
const pointerOnDeleted =
  (generation: number, said: RegExp) =>
  (e: unknown): boolean =>
    e instanceof NotFoundError &&
    new RegExp(`deleted generation ${generation}\\b`).test(e.message) &&
    /roll back to a generation/.test(e.message) &&
    said.test(e.message);

/** The row names `generation`, the bucket holds `present`, and the consistency check reports the missing object. */
async function namesMissing(w: World, generation: number, present: number[]): Promise<void> {
  expect((await w.registry.get(REF))?.currentGen).toBe(generation);
  expect(await generations(w.storage)).toEqual(present);
  const report = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
  expect(report.inconsistent).toEqual([
    {
      segment: REF.segment,
      namespace: undefined,
      currentGen: generation,
      issue: 'missing-storage-generation',
    },
  ]);
}

/** The row names `generation`, its object is there, and the consistency check finds nothing wrong. */
async function namesPresent(w: World, generation: number, present: number[]): Promise<void> {
  expect((await w.registry.get(REF))?.currentGen).toBe(generation);
  expect(await generations(w.storage)).toEqual(present);
  const report = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
  expect(report.inconsistent).toEqual([]);
}

/** Generations 0 to `last`, each loaded with a window wide enough that no load collects anything. */
async function loaded(w: World, last: number): Promise<void> {
  for (let g = 0; g <= last; g++) await loadSegment(REF, [g + 1], w.deps, { keep: 9 });
  expect(await generations(w.storage)).toEqual(Array.from({ length: last + 1 }, (_, g) => g));
}

describe('a collection pass (the listing pass), raced by a rollback onto the generation it is deleting', () => {
  it('a rollback onto a deleted generation, seen at the next re-read: NotFoundError, not WriteConflictError', async () => {
    const w = world();
    await loaded(w, 3); // current 3; `keep: 1` keeps 2 and deletes 1, then 0
    const at = gate();
    const pass = gcOrphanGenerations(
      REF,
      { storage: stallingDelete(w.storage, 1, at), registry: w.registry },
      { keep: 1 },
    );
    await stalledAt(at, pass);
    await expect(rollbackSegment(REF, 1, w.deps)).resolves.toEqual({
      fromGeneration: 3,
      generation: 1,
    });
    at.open();

    await expect(pass).rejects.toSatisfy(pointerOnDeleted(1, /collection/));
    // The pass stopped there: generation 0, still queued, is kept.
    await namesMissing(w, 1, [0, 2, 3]);
  });

  it('a rollback onto the last generation it deletes, seen by the one read after the loop: NotFoundError, not success', async () => {
    const w = world();
    await loaded(w, 3); // current 3; `keep: 2` keeps 2 and 1, and deletes 0 alone
    const at = gate();
    const pass = gcOrphanGenerations(
      REF,
      { storage: stallingDelete(w.storage, 0, at), registry: w.registry },
      { keep: 2 },
    );
    await stalledAt(at, pass);
    await rollbackSegment(REF, 0, w.deps);
    at.open();

    await expect(pass).rejects.toSatisfy(pointerOnDeleted(0, /collection/));
    await namesMissing(w, 0, [1, 2, 3]);
  });

  it('a rollback that lands before the re-read of the generation it targets refuses the pass as before, and loses nothing', async () => {
    const w = world();
    await loaded(w, 3);
    const at = gate();
    const pass = gcOrphanGenerations(
      REF,
      { storage: stallingDelete(w.storage, 1, at), registry: w.registry },
      { keep: 1 },
    );
    await stalledAt(at, pass);
    // Generation 0 is queued, not yet deleted: the re-read before its delete finds the pointer below the cutoff.
    await rollbackSegment(REF, 0, w.deps);
    at.open();

    await expect(pass).rejects.toBeInstanceOf(WriteConflictError);
    await namesPresent(w, 0, [0, 2, 3]);
  });

  it('a rollback onto a generation the pass keeps raises nothing', async () => {
    const w = world();
    await loaded(w, 3);
    const at = gate();
    const pass = gcOrphanGenerations(
      REF,
      { storage: stallingDelete(w.storage, 0, at), registry: w.registry },
      { keep: 1 },
    );
    await stalledAt(at, pass);
    await rollbackSegment(REF, 2, w.deps); // 2 is the window the pass keeps
    at.open();

    await expect(pass).resolves.toEqual([1, 0]);
    await namesPresent(w, 2, [2, 3]);
  });

  it('a number the pass deleted, taken again by a load that published it, is no missing object', async () => {
    const w = world();
    await loaded(w, 3);
    const at = gate();
    const pass = gcOrphanGenerations(
      REF,
      { storage: stallingDelete(w.storage, 0, at), registry: w.registry },
      { keep: 1 },
    );
    // 1 is deleted; the pass re-proves the row for 0 and stalls before deleting it.
    await stalledAt(at, pass);
    await rollbackSegment(REF, 0, w.deps);
    // A load numbers 1 afresh, since its object is gone, and publishes it.
    await expect(loadSegment(REF, [9], w.deps, { keep: 9 })).resolves.toMatchObject({
      generation: 1,
      published: true,
    });
    at.open();

    // The row names 1, a number the pass deleted, over the load's object: the read after the loop finds it there.
    await expect(pass).resolves.toEqual([1, 0]);
    await namesPresent(w, 1, [1, 2, 3]);
  });

  it("a load's listing pass, after its publish landed: NotFoundError saying the load took effect", async () => {
    const w = world();
    await loaded(w, 3); // the row's window is 2, 1, 0
    const at = gate();
    // `collectByListing` lists: the pass deletes 2, then 1, then 0, which the new window of one leaves out.
    const load = loadSegment(
      REF,
      [42],
      { ...w.deps, storage: stallingDelete(w.storage, 2, at), collectByListing: true },
      { keep: 1 },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 2, w.deps);
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(2, /took effect at generation 4/));
    await namesMissing(w, 2, [0, 1, 3, 4]);
  });

  it("an erasure's collection of a holder below the pointer: NotFoundError after the deletion is audited, not a race", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 0 holds the id
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 }); // 1 is current and does not
    const at = gate();
    const audit = new RecordingAuditSink();
    // The id is found below the pointer only, so the erasure collects with `keep: 0` and rewrites nothing.
    const erasure = eraseIdFromSegment(
      REF,
      X,
      { ...w.deps, storage: stallingDelete(w.storage, 0, at) },
      { audit },
    );
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 0, w.deps);
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(0, /erasure/));
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.collect', fromGeneration: 0, collected: [0] }),
    ]);
    await namesMissing(w, 0, [1]);
  });
});

describe("a load's collection by name, raced by a rollback onto a generation it evicts", () => {
  it('the last name it deletes, seen by the one read after the loop: NotFoundError, not a load reported as clean', async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps); // 0
    await loadSegment(REF, [2], w.deps); // 1, keeps 0
    const at = gate();
    // Generation 2 pushes 0 out of the window of one, and deletes it by name.
    const load = loadSegment(REF, [3], { ...w.deps, storage: stallingDelete(w.storage, 0, at) });
    await stalledAt(at, load);
    await rollbackSegment(REF, 0, w.deps);
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(0, /took effect at generation 2/));
    await namesMissing(w, 0, [1, 2]);
  });

  it('a name it deleted, seen at the re-read before the next: NotFoundError, not a load reported as clean', async () => {
    const w = world();
    for (const ids of [[1], [2], [3]]) await loadSegment(REF, ids, w.deps, { keep: 2 }); // 0..2, keeps 1 and 0
    const at = gate();
    // A `keep` of 0 pushes 0, 1 and 2 out of the window: it deletes them by name, in that order.
    const load = loadSegment(
      REF,
      [4],
      { ...w.deps, storage: stallingDelete(w.storage, 0, at) },
      { keep: 0 },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 0, w.deps);
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(0, /took effect at generation 3/));
    // It stopped at the re-read: 1 and 2 are still there.
    await namesMissing(w, 0, [1, 2, 3]);
  });

  it('a row purged and made again, naming a number the pass deleted, is another segment: it raises nothing', async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps); // 0
    await loadSegment(REF, [2], w.deps); // 1, keeps 0
    const at = gate();
    const load = loadSegment(REF, [3], { ...w.deps, storage: stallingDelete(w.storage, 0, at) });
    await stalledAt(at, load);
    // The name is purged and made again, with a row that names generation 0 and no object of its own.
    await w.registry.delete(REF);
    await w.registry.create(REF, { currentGen: 0 });
    at.open();

    // Its numbers are its own: the pass deleted the earlier segment's 0, and says nothing of this one's.
    await expect(load).resolves.toMatchObject({ generation: 2, published: true, collected: [0] });
  });
});

describe("a refused load's reclaim of its own object, raced by a forward rollback onto that object", () => {
  it('under the row it read: NotFoundError naming the refusal, and the refusal is still audited', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    const at = gate();
    const audit = new RecordingAuditSink();
    // An empty result over a non-empty segment is refused, and the load deletes its object at 1 by number.
    const load = loadSegment(
      REF,
      [],
      { ...w.deps, storage: stallingDelete(w.storage, 1, at) },
      { audit },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 1, w.deps, { allowForward: true });
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(1, /refused \(empty\)/));
    expect(audit.snapshot()).toContainEqual(
      expect.objectContaining({ kind: 'segment.load-refused', generation: 1, reason: 'empty' }),
    );
    await namesMissing(w, 1, [0]);
  });

  it('under a row another load changed, the object proved its own: the same', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    // Right after this load writes its object at 1, another load publishes 2, so this one's publish is refused.
    let raced = false;
    const racing = Object.create(w.storage) as IStorageDriver;
    racing.putImmutable = async (key, write) => {
      const out = await w.storage.putImmutable(key, write);
      if (!raced) {
        raced = true;
        await loadSegment(REF, [4, 5, 6], w.deps, { keep: 9 });
      }
      return out;
    };
    const at = gate();
    const load = loadSegment(REF, [7, 8, 9], {
      ...w.deps,
      storage: stallingDelete(racing, 1, at),
    });
    await stalledAt(at, load);
    await rollbackSegment(REF, 1, w.deps); // below the pointer, 2, so no opt-in is needed
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(1, /refused \(superseded\)/));
    await namesMissing(w, 1, [0, 2]);
  });
});

describe("an erasure's delete of a holder above the pointer, raced by a forward rollback onto it", () => {
  /** Generation 0 is current without the id; `above` generations above the pointer hold it. */
  async function holdersAbove(w: World, above: number): Promise<void> {
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 });
    for (let g = 1; g <= above; g++) {
      await loadSegment(REF, [1, 2, 3, X, 100 + g], w.deps, { keep: 9 });
    }
    await rollbackSegment(REF, 0, w.deps);
  }

  it('its last delete, seen by the one read after the loop: NotFoundError after the deletion is audited, never erased: true', async () => {
    const w = world();
    await holdersAbove(w, 1);
    const at = gate();
    const audit = new RecordingAuditSink();
    const erasure = eraseIdFromSegment(
      REF,
      X,
      { ...w.deps, storage: stallingDelete(w.storage, 1, at) },
      { audit },
    );
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 1, w.deps, { allowForward: true });
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(1, /erasure/));
    // Nothing in the bucket holds the id, and the deletion that made it so is on the record.
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.collect', fromGeneration: 1, collected: [1] }),
    ]);
    await namesMissing(w, 1, [0]);
  });

  it('a holder it deleted, seen at the re-read before the next: NotFoundError, and no record of a finished erasure', async () => {
    const w = world();
    await holdersAbove(w, 2); // 1 and 2 hold the id; the erasure deletes 2, then 1
    const at = gate();
    const audit = new RecordingAuditSink();
    const erasure = eraseIdFromSegment(
      REF,
      X,
      { ...w.deps, storage: stallingDelete(w.storage, 2, at) },
      { audit },
    );
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 2, w.deps, { allowForward: true });
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(2, /erasure/));
    // Generation 1 still holds the id: the erasure did not finish, so it records nothing.
    expect(audit.snapshot()).toEqual([]);
    await namesMissing(w, 2, [0, 1]);
  });
});
