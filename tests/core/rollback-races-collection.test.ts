import { runConsistencyCheck } from '@cloudbitmaps/core';
import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { DELETE_SETTLE_WAITS_MS, gcOrphanGenerations, watchDeletes } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { RecordingAuditSink } from '@/index';
import type { Clock } from '@/index';
import type {
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
} from '@cloudbitmaps/core/driver-kit';
import { roaringCodec } from '@/native-codec';
import { sameIncarnation } from '@/core/token';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';
import { testEntropy } from '../helpers/entropy';

/**
 * A rollback that lands between a delete loop's read of the row and its delete. Every loop that deletes generations
 * re-reads the row before each delete (invariant 4), and one round trip remains between that read and the delete:
 *
 *   delete loop      reads the row: g is collectable ── stalls ───────────────────────────────▶ deletes g
 *   rollback                                  lists: g is there │ moves the pointer onto g │ lists: g is there
 *
 * The rollback's own check runs before the delete, so it reports success, and the row then names an object that is
 * gone. Nothing can put that object back, so each loop detects it instead: a row it reads after a delete (the next
 * re-read, or one read after its last delete) that names a generation it deleted, with no object under it, still
 * naming it when read again at once and after each wait, raises `NotFoundError`, which tells the caller to check the
 * segment's generations and roll back only while the pointer names a missing one. `checkConsistency` reports the state
 * either way. A rollback whose own check runs after the delete puts the pointer back itself, and is not reported.
 *
 * Gated promises hold each loop between its read and its delete while the rollback runs to the end, and the clock
 * never waits, so a run is the same every time.
 */

type Gate = ReturnType<typeof gate>;

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, entropy: testEntropy, codec: roaringCodec, clock },
  };
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
    await rollbackSegment(REF, 2, w.deps, { allowUnknown: true });
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(2, /took effect at generation 4/));
    await namesMissing(w, 2, [0, 1, 3, 4]);
  });

  it('the first load after a rollback, deleting a generation the rollback moved away from: the same', async () => {
    const w = world();
    await loaded(w, 3);
    await rollbackSegment(REF, 1, w.deps); // the row records no window now
    const at = gate();
    // The load publishes 4 over 1 and lists: its window keeps 1, the generation it superseded, and the pass deletes 3,
    // then 2, then 0.
    const load = loadSegment(
      REF,
      [42],
      { ...w.deps, storage: stallingDelete(w.storage, 3, at) },
      { keep: 1 },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 3, w.deps, { allowUnknown: true });
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(3, /took effect at generation 4/));
    await namesMissing(w, 3, [0, 1, 2, 4]);
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
    // Without the flag the same call is refused here: the row does not name the generation.
    await expect(rollbackSegment(REF, 0, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await rollbackSegment(REF, 0, w.deps, { allowUnknown: true });
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(0, /erasure/));
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.collect', fromGeneration: 0, collected: [0] }),
    ]);
    await namesMissing(w, 0, [1]);
  });

  it("an erasure's collection after its rewrite published: NotFoundError after the rewrite is audited, never erased: true", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 }); // 0 holds the id
    await loadSegment(REF, [1, 2, X], w.deps, { keep: 9 }); // 1 is current and holds it
    const at = gate();
    const audit = new RecordingAuditSink();
    // The current generation holds the id, so the erasure rewrites it as 2, then collects below it with `keep: 0`.
    const erasure = eraseIdFromSegment(
      REF,
      X,
      { ...w.deps, storage: stallingDelete(w.storage, 0, at) },
      { audit },
    );
    await stalledAt(at, erasure);
    await rollbackSegment(REF, 0, w.deps, { allowUnknown: true });
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(0, /an erasure/));
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.rewrite', generation: 2 }),
    ]);
    expect((await w.registry.get(REF))?.currentGen).toBe(0);
    expect(await generations(w.storage)).not.toContain(0);
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
    await rollbackSegment(REF, 0, w.deps, { allowUnknown: true });
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
    await rollbackSegment(REF, 0, w.deps, { allowUnknown: true });
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
    await rollbackSegment(REF, 1, w.deps, { allowUnknown: true });
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(1, /refused \(empty\)/));
    expect(audit.snapshot()).toContainEqual(
      expect.objectContaining({ kind: 'segment.load-refused', generation: 1, reason: 'empty' }),
    );
    await namesMissing(w, 1, [0]);
  });

  it('under a row another load changed, it deletes nothing, so a rollback onto its object finds it there', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    // Right after this load writes its object at 1, another load publishes 2, so this one's publish is refused.
    let raced = false;
    const deleted: number[] = [];
    const racing = Object.create(w.storage) as IStorageDriver;
    racing.putImmutable = async (key, write) => {
      const out = await w.storage.putImmutable(key, write);
      if (!raced) {
        raced = true;
        await loadSegment(REF, [4, 5, 6], w.deps, { keep: 9 });
      }
      return out;
    };
    racing.delete = async (key, options) => {
      deleted.push(key.generation);
      return w.storage.delete(key, options);
    };
    await expect(
      loadSegment(REF, [7, 8, 9], { ...w.deps, storage: racing }),
    ).resolves.toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(deleted).toEqual([]);
    await rollbackSegment(REF, 1, w.deps, { allowUnknown: true }); // below the pointer, 2, but a generation the row does not know
    await namesPresent(w, 1, [0, 1, 2]);
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
    // Without the flag the same call is refused here: the row does not name the generation.
    await expect(rollbackSegment(REF, 1, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await rollbackSegment(REF, 1, w.deps, { allowUnknown: true });
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
    // Without the flag the same call is refused here: the row does not name the generation.
    await expect(rollbackSegment(REF, 2, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await rollbackSegment(REF, 2, w.deps, { allowUnknown: true });
    at.open();

    await expect(erasure).rejects.toSatisfy(pointerOnDeleted(2, /erasure/));
    // Generation 1 still holds the id: the erasure did not finish, so it records nothing.
    expect(audit.snapshot()).toEqual([]);
    await namesMissing(w, 2, [0, 1]);
  });
});

/**
 * The same race when the rollback's own check runs after the delete: it reads the target's footer after its move, finds
 * the object gone and puts the pointer back. The loop's read after its delete can fall between the move and that undo, and
 * sees the pointer on a missing generation for a moment. It reads the row again before it raises, at once and, with a
 * clock that can wait, after each of a few waits, so a rollback that undoes itself in that time is no missing object:
 *
 *   deleting call       reads the row ─ round trip ─▶ deletes g │ reads the row: g, missing │ reads it again: put back
 *   rollbackSegment(g)          moves the pointer onto g │ reads g's footer ── gone ──▶ moves it back
 */
describe('a rollback that finds its target gone and puts the pointer back', () => {
  /** `storage`, whose second tail read, a rollback's check after its move, waits at `at`. */
  function holdingCheck(storage: IStorageDriver, at: Gate): IStorageDriver {
    let tails = 0;
    const gated = Object.create(storage) as IStorageDriver;
    gated.getTail = (key, maxBytes) => {
      tails += 1;
      if (tails !== 2) return storage.getTail(key, maxBytes);
      return (async () => {
        at.reach();
        await at.opened;
        return storage.getTail(key, maxBytes);
      })();
    };
    return gated;
  }

  /**
   * `storage`, whose first delete of `generation` waits at `at`, and whose first zero-byte read of it after that delete
   * runs `then` first: the loop's look at the object the row names.
   */
  function stallingThenLooking(
    storage: IStorageDriver,
    generation: number,
    at: Gate,
    then: () => Promise<void>,
  ): IStorageDriver {
    let held = false;
    let deleted = false;
    let looked = false;
    const gated = Object.create(storage) as IStorageDriver;
    gated.delete = async (key, options) => {
      if (!held && key.generation === generation) {
        held = true;
        at.reach();
        await at.opened;
      }
      const out = await storage.delete(key, options);
      if (key.generation === generation) deleted = true;
      return out;
    };
    gated.getTail = async (key, maxBytes) => {
      if (deleted && !looked && key.generation === generation) {
        looked = true;
        await then();
      }
      return storage.getTail(key, maxBytes);
    };
    return gated;
  }

  /**
   * Run `start` (a loop over `storage`) until it stalls before deleting `generation`, run a rollback onto that generation
   * that stops at its check, let the delete go, and let the rollback finish its check when `when` says: at the loop's
   * look at the object (`'look'`), or at the loop's first wait (`'wait'`, on the clock it returns). Returns the loop's
   * outcome and what the rollback threw.
   */
  async function undone<T>(
    w: World,
    generation: number,
    start: (storage: IStorageDriver, clock: Clock) => Promise<T>,
    when: 'look' | 'wait',
    allowUnknown = false,
  ): Promise<{ result: T; rollback: unknown }> {
    const atDelete = gate();
    const atCheck = gate();
    // Set once the rollback starts, which is after the loop has reached its delete.
    const rollback: { settled?: Promise<unknown> } = {};
    const finishRollback = async (): Promise<void> => {
      atCheck.open();
      await rollback.settled;
    };
    const waiting: Clock = {
      ...clock,
      sleep: async (ms) => {
        if (when === 'wait' && ms === DELETE_SETTLE_WAITS_MS[0]) await finishRollback();
      },
    };
    const storage = stallingThenLooking(w.storage, generation, atDelete, async () => {
      if (when === 'look') await finishRollback();
    });
    const loop = start(storage, waiting);
    await stalledAt(atDelete, loop);
    rollback.settled = rollbackSegment(
      REF,
      generation,
      { ...w.deps, storage: holdingCheck(w.storage, atCheck) },
      { allowUnknown },
    ).then(
      () => 'rolled back',
      (err: unknown) => err,
    );
    await atCheck.reached;
    expect((await w.registry.get(REF))?.currentGen).toBe(generation);
    atDelete.open();
    const result = await loop;
    return { result, rollback: await rollback.settled };
  }

  const putBack = (e: unknown): boolean =>
    e instanceof NotFoundError && /the pointer was put back/.test(e.message);

  it('a collection pass, its last delete: no error, and the pointer is back', async () => {
    const w = world();
    await loaded(w, 3);
    const { result, rollback } = await undone(
      w,
      0,
      (storage) => gcOrphanGenerations(REF, { storage, registry: w.registry }, { keep: 2 }),
      'look',
    );
    expect(result).toEqual([0]);
    expect(rollback).toSatisfy(putBack);
    await namesPresent(w, 3, [1, 2, 3]);
  });

  it("a load's collection by name: the load reports what it did", async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps); // 0
    await loadSegment(REF, [2], w.deps); // 1, keeps 0
    const { result, rollback } = await undone(
      w,
      0,
      (storage) => loadSegment(REF, [3], { ...w.deps, storage }),
      'look',
      true, // the load's publish took 0 out of the ledger before it deletes it, so only the override reaches it
    );
    expect(result).toMatchObject({ generation: 2, published: true, collected: [0] });
    expect(rollback).toSatisfy(putBack);
    await namesPresent(w, 2, [1, 2]);
  });

  it("a refused load's reclaim: the refusal is the answer", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps); // 0
    const { result, rollback } = await undone(
      w,
      1,
      (storage) => loadSegment(REF, [], { ...w.deps, storage }),
      'look',
      true,
    );
    expect(result).toMatchObject({ generation: 1, published: false, reason: 'empty' });
    expect(rollback).toSatisfy(putBack);
    await namesPresent(w, 0, [0]);
  });

  it("an erasure's delete of a holder above the pointer: erased: true", async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 3], w.deps, { keep: 9 });
    await loadSegment(REF, [1, 2, 3, X], w.deps, { keep: 9 });
    await rollbackSegment(REF, 0, w.deps); // 1 is above the pointer, and holds the id
    const { result, rollback } = await undone(
      w,
      1,
      (storage) => eraseIdFromSegment(REF, X, { ...w.deps, storage }),
      'look',
      true,
    );
    expect(result).toMatchObject({ erased: true, fromGeneration: 1, collected: [1] });
    expect(rollback).toSatisfy(putBack);
    await namesPresent(w, 0, [0]);
  });

  it('an undo that lands only while the loop waits on its clock is no missing object either', async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps); // 0
    await loadSegment(REF, [2], w.deps); // 1, keeps 0
    const { result, rollback } = await undone(
      w,
      0,
      (storage, waiting) => loadSegment(REF, [3], { ...w.deps, storage, clock: waiting }),
      'wait',
      true,
    );
    expect(result).toMatchObject({ generation: 2, published: true, collected: [0] });
    expect(rollback).toSatisfy(putBack);
    await namesPresent(w, 2, [1, 2]);
  });
});

describe('a refused first load on a row with no pointer, raced by a forward rollback onto its object', () => {
  it("the reclaim's read after its delete holds that row too: NotFoundError naming the refusal", async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    const at = gate();
    // Fewer ids than the guard asks for: refused, under the row it read, so it deletes its object at 0 by number.
    const load = loadSegment(
      REF,
      [1, 2],
      { ...w.deps, storage: stallingDelete(w.storage, 0, at) },
      { guard: { minCardinality: 5 } },
    );
    await stalledAt(at, load);
    await rollbackSegment(REF, 0, w.deps, { allowUnknown: true });
    at.open();

    await expect(load).rejects.toSatisfy(pointerOnDeleted(0, /refused \(min-cardinality\)/));
    await namesMissing(w, 0, []);
  });
});

// The watch itself, over a registry that answers each read from a script and a bucket that holds `present`: which reads
// it makes, which waits, and which answer each sequence of rows gives.
describe("the watch over a delete loop's reads of the row", () => {
  async function rows() {
    const registry = new MemoryRegistryDriver();
    await registry.create(REF, { currentGen: 1 });
    const held = (await registry.get(REF)) as RegistryRecord;
    await registry.delete(REF);
    await registry.create(REF, { currentGen: 1 });
    const other = (await registry.get(REF)) as RegistryRecord;
    const at = (g: number | null, of: RegistryRecord = held): RegistryRecord => ({
      ...of,
      currentGen: g,
    });
    return { held, at, other };
  }

  function rig(
    script: (RegistryRecord | null)[],
    present: number[],
    waits: boolean,
    onSleep: () => void = () => undefined,
  ) {
    const reads: number[] = [];
    const tails: number[] = [];
    const sleeps: number[] = [];
    const registry = {
      get: () => {
        reads.push(reads.length);
        return Promise.resolve(script[Math.min(reads.length - 1, script.length - 1)] ?? null);
      },
    } as unknown as IRegistryDriver;
    const storage = {
      getTail: (key: { generation: number }) => {
        tails.push(key.generation);
        return present.includes(key.generation)
          ? Promise.resolve({ bytes: new Uint8Array(0), size: 1 })
          : Promise.reject(new NotFoundError(`no object ${key.generation}`));
      },
    } as unknown as IStorageDriver;
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      onSleep();
      return Promise.resolve();
    };
    const watch = watchDeletes({ storage, registry, ...(waits ? { clock: { sleep } } : {}) }, REF);
    return { watch, reads, tails, sleeps };
  }

  it('answers only when the row read at once and after each wait still names the deleted generation, with no object', async () => {
    const { held, at } = await rows();
    const r = rig([at(3)], [], true);
    r.watch.deleted(3);
    expect(await r.watch.check(held, at(3))).toBe(3);
    expect(r.sleeps).toEqual([...DELETE_SETTLE_WAITS_MS]);
    expect(DELETE_SETTLE_WAITS_MS).toEqual([250, 500, 1_000]);
    expect(r.reads).toHaveLength(4);
    expect(r.tails).toEqual([3, 3, 3, 3, 3]);
    // With no clock it reads the row once more, at once, and waits for nothing.
    const bare = rig([at(3)], [], false);
    bare.watch.deleted(3);
    expect(await bare.watch.check(held, at(3))).toBe(3);
    expect(bare.reads).toHaveLength(1);
    expect(bare.sleeps).toEqual([]);
  });

  it('answers nothing once a read finds the pointer moved off, as a rollback that found its target gone moves it', async () => {
    const { held, at } = await rows();
    // Put back at once: the read made at once sees it, and nothing waits.
    const atOnce = rig([at(1)], [], true);
    atOnce.watch.deleted(3);
    expect(await atOnce.watch.check(held, at(3))).toBeUndefined();
    expect(atOnce.sleeps).toEqual([]);
    // Put back during the second wait.
    const later = rig([at(3), at(3), at(1)], [], true);
    later.watch.deleted(3);
    expect(await later.watch.check(held, at(3))).toBeUndefined();
    expect(later.sleeps).toEqual([250, 500]);
    expect(later.reads).toHaveLength(3);
    // Onto a generation it did not delete, or a row gone, destroyed or made again.
    const { other } = await rows();
    expect(sameIncarnation(held, other)).toBe(false);
    for (const next of [at(9), null, { ...at(3), status: 'destroyed' as const }, at(3, other)]) {
      const moved = rig([next], [], true);
      moved.watch.deleted(3);
      expect(await moved.watch.check(held, at(3))).toBeUndefined();
    }
  });

  it('judges a read that names another deleted generation the same way: missing, it is the answer; there, it is not', async () => {
    const { held, at } = await rows();
    const bothGone = rig([at(4)], [], true);
    bothGone.watch.deleted(3);
    bothGone.watch.deleted(4);
    expect(await bothGone.watch.check(held, at(3))).toBe(4);
    // A load took 4 again and published it: the object under it is that load's, and nothing is missing.
    const taken = rig([at(4)], [4], true);
    taken.watch.deleted(3);
    taken.watch.deleted(4);
    expect(await taken.watch.check(held, at(3))).toBeUndefined();
    expect(taken.tails).toEqual([3, 4]);
    // So is the deleted number itself, taken again and published between two reads of the row.
    const present: number[] = [];
    const retaken = rig([at(3)], present, true, () => present.push(3));
    retaken.watch.deleted(3);
    expect(await retaken.watch.check(held, at(3))).toBeUndefined();
    expect(retaken.sleeps).toEqual([250]);
  });

  it('makes no read when the row names no deleted generation or the object is there, and settles only after a delete', async () => {
    const { held, at } = await rows();
    const r = rig([at(3)], [3], true);
    r.watch.deleted(3);
    expect(await r.watch.check(held, at(3))).toBeUndefined();
    expect(r.reads).toHaveLength(0);
    expect(await r.watch.check(held, at(2))).toBeUndefined();
    expect(r.tails).toEqual([3]);
    // The check read the row since the delete, so there is nothing to settle; a further delete is read once more.
    expect(await r.watch.settle(held)).toBeUndefined();
    expect(r.reads).toHaveLength(0);
    r.watch.deleted(5);
    expect(await r.watch.settle(held)).toBeUndefined();
    expect(r.reads).toHaveLength(1);
  });

  it('throws a fault of the bucket read rather than guess', async () => {
    const { held, at } = await rows();
    const storage = {
      getTail: () => Promise.reject(new TransientError('throttled')),
    } as unknown as IStorageDriver;
    const watch = watchDeletes({ storage, registry: {} as IRegistryDriver }, REF);
    watch.deleted(3);
    await expect(watch.check(held, at(3))).rejects.toThrow(TransientError);
  });
});
