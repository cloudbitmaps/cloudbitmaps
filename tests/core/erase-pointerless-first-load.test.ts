import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import { eraseIdFromSegment, type EraseIdDeps } from '@/core/erase-id';
import { TransientError, WriteConflictError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import type {
  IRegistryDriver,
  IStorageDriver,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { type Unanswered, recordedWaits, unansweredRegistry } from '../helpers/unanswered-registry';

/**
 * A row with no pointer, which `setRetention` makes before a segment's first load, and a first load's object in its
 * bucket: a load still running, or one that wrote its object and never published. The erasure searches each object,
 * and when one holds the id it renews the row's `pointerId` before it deletes any: a write that names the pointer at its
 * own value, `null`, so a first load fenced on the row it read is refused at its publish, and the row never names an
 * object the erasure deleted. Before each delete it reads the row again, and deletes only while the row is still the
 * one it renewed. An erasure that finds no holder writes nothing.
 */
const REF: SegmentRef = { segment: 's' };

/** The id the tests erase, and ids beside it. */
const X = 9;

function world(options: { keystore?: InProcessKeystore } = {}) {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const deps = {
    storage,
    registry,
    codec: roaringCodec,
    ...(options.keystore === undefined ? {} : { keystore: options.keystore }),
  };
  return { storage, registry, deps };
}

const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A point a call stops at until the test opens it, and a promise that says it got there. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, opened, reach, reached };
}

/** Whether a patch is a publish: it names the pointer at a generation. */
const isPublish = (patch: RegistryPatch): boolean =>
  'currentGen' in patch && patch.currentGen !== null;

/** Whether a patch names the pointer at `null`: the erasure's renewal of a row with no pointer. */
const isRenewalOfNoPointer = (patch: RegistryPatch): boolean =>
  'currentGen' in patch && patch.currentGen === null;

/** `registry`, with a load's publish (a compare-and-swap or a create) held at `g` the first time it is sent. */
function heldAtPublish(registry: IRegistryDriver, g: ReturnType<typeof gate>): IRegistryDriver {
  let held = false;
  const out = Object.create(registry) as IRegistryDriver;
  out.compareAndSwap = async (ref, expected, patch, opts) => {
    if (!held && isPublish(patch)) {
      held = true;
      g.reach();
      await g.opened;
    }
    return registry.compareAndSwap(ref, expected, patch, opts);
  };
  out.create = async (ref, record, opts) => {
    if (!held) {
      held = true;
      g.reach();
      await g.opened;
    }
    return registry.create(ref, record, opts);
  };
  return out;
}

/** `storage`, with the first object written through it held at `g` before it is written. */
function heldAtWrite(storage: IStorageDriver, g: ReturnType<typeof gate>): IStorageDriver {
  let held = false;
  const out = Object.create(storage) as IStorageDriver;
  out.putImmutable = async (key, write) => {
    if (!held) {
      held = true;
      g.reach();
      await g.opened;
    }
    return storage.putImmutable(key, write);
  };
  return out;
}

/** A first load that wrote its object and never published: what a crash between the two leaves. */
async function crashedFirstLoad(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  generation: number,
  ids: number[],
  ks?: InProcessKeystore,
): Promise<void> {
  await bulkLoadCrbmGeneration(storage, { ...REF, generation }, ids, {
    registry,
    publish: false,
    ...(ks === undefined ? {} : { keystore: ks }),
  });
}

describe('an erasure and a first load onto a row with no pointer', () => {
  it('the erasure renews the row first: the load held at its publish is refused, and its object is deleted', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    const before = (await w.registry.get(REF))!;
    const atPublish = gate();
    const loadAudit = new RecordingAuditSink();
    const load = loadSegment(
      REF,
      [1, 2, X],
      { ...w.deps, registry: heldAtPublish(w.registry, atPublish) },
      { audit: loadAudit },
    );
    await atPublish.reached;
    expect(await generations(w.storage)).toEqual([0]);

    const audit = new RecordingAuditSink();
    const erased = await eraseIdFromSegment(REF, X, w.deps, { audit });
    expect(erased).toEqual({
      segment: 's',
      namespace: undefined,
      erased: true,
      fromGeneration: 0,
      collected: [0],
    });
    const renewed = (await w.registry.get(REF))!;
    expect(renewed.currentGen).toBeNull();
    expect(renewed.pointerId).not.toBe(before.pointerId);
    expect(renewed.pointerId).toBe(renewed.token);
    expect(await generations(w.storage)).toEqual([]);
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.collect', fromGeneration: 0, collected: [0] }),
    ]);

    atPublish.open();
    expect(await load).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    expect(loadAudit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.load-refused', reason: 'superseded' }),
    ]);
    expect((await w.registry.get(REF))!.currentGen).toBeNull();
    expect(await generations(w.storage)).toEqual([]);
  });

  it('the load publishes first: the erasure is superseded and deletes nothing, and a re-run erases through the rewrite', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    const atPublish = gate();
    const load = loadSegment(REF, [1, 2, X], {
      ...w.deps,
      registry: heldAtPublish(w.registry, atPublish),
    });
    await atPublish.reached;

    // The erasure is held at its renewal; the load's publish lands meanwhile.
    const atRenewal = gate();
    let held = false;
    const erasing = Object.create(w.registry) as IRegistryDriver;
    erasing.compareAndSwap = async (ref, expected, patch, opts) => {
      if (!held && isRenewalOfNoPointer(patch)) {
        held = true;
        atRenewal.reach();
        await atRenewal.opened;
      }
      return w.registry.compareAndSwap(ref, expected, patch, opts);
    };
    const erasure = eraseIdFromSegment(REF, X, { ...w.deps, registry: erasing });
    await atRenewal.reached;
    atPublish.open();
    expect(await load).toMatchObject({ generation: 0, published: true });
    atRenewal.open();

    expect(await erasure).toMatchObject({
      erased: false,
      reason: 'superseded',
      fromGeneration: 0,
      collected: [],
    });
    expect((await w.registry.get(REF))!.currentGen).toBe(0);
    expect(await generations(w.storage)).toEqual([0]);

    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 0,
      generation: 1,
    });
    expect(await generations(w.storage)).toEqual([1]);
  });

  it("a crashed first load's object is erased", async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, 2, X]);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 0,
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([]);
    expect((await w.registry.get(REF))!.currentGen).toBeNull();
  });

  it('every holder goes, and an object that does not hold the id goes with them', async () => {
    // Two crashed first loads, one holding the id: the erasure cannot tell whose load is in flight, and both are
    // first loads onto a row it renewed, so neither can publish any more.
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]);
    await crashedFirstLoad(w.storage, w.registry, 1, [1, 2]);
    await crashedFirstLoad(w.storage, w.registry, 2, [X]);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 2,
      collected: [0, 2],
    });
    expect(await generations(w.storage)).toEqual([1]);
  });

  it('a load that publishes after the erasure is refused, and the pointer never names what was deleted', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]);
    // The load reads the row and stops before it writes its object: it numbers past the crashed one.
    const atWrite = gate();
    const load = loadSegment(REF, [5, X], {
      ...w.deps,
      storage: heldAtWrite(w.storage, atWrite),
    });
    await atWrite.reached;

    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      collected: [0],
    });
    atWrite.open();
    expect(await load).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect((await w.registry.get(REF))!.currentGen).toBeNull();
    // Its object, written after the erasure's last look, stays where no pointer names it; the next erasure finds it.
    expect(await generations(w.storage)).toEqual([1]);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 1,
      collected: [1],
    });
    expect(await generations(w.storage)).toEqual([]);
  });

  it('a holder written after the listing is found by the last check, which says re-run; the re-run deletes it', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]);
    // A load that read the row before the erasure, and writes its object, holding the id, after the erasure's listing.
    const atWrite = gate();
    const atPublish = gate();
    const load = loadSegment(REF, [2, X], {
      ...w.deps,
      storage: heldAtWrite(w.storage, atWrite),
      registry: heldAtPublish(w.registry, atPublish),
    });
    await atWrite.reached;
    // Once the erasure's renewal has landed, the load writes its object and stops at its publish.
    let renewed = false;
    const erasing = Object.create(w.registry) as IRegistryDriver;
    erasing.compareAndSwap = async (ref, expected, patch, opts) => {
      const out = await w.registry.compareAndSwap(ref, expected, patch, opts);
      if (!renewed && isRenewalOfNoPointer(patch)) {
        renewed = true;
        atWrite.open();
        await atPublish.reached;
      }
      return out;
    };
    await expect(eraseIdFromSegment(REF, X, { ...w.deps, registry: erasing })).rejects.toSatisfy(
      (e: unknown) => e instanceof WriteConflictError && /generation 1\b.*re-run/.test(e.message),
    );
    expect(await generations(w.storage)).toEqual([1]);

    // The re-run renews the row again and deletes it; the load, still at its publish, is refused.
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 1,
      collected: [1],
    });
    atPublish.open();
    expect(await load).toMatchObject({ published: false, reason: 'superseded' });
    expect(await generations(w.storage)).toEqual([]);
  });

  it('a rollback onto a holder after the renewal is seen by the read before the delete: nothing is deleted', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]);
    let rolled = false;
    const erasing = Object.create(w.registry) as IRegistryDriver;
    erasing.compareAndSwap = async (ref, expected, patch, opts) => {
      const out = await w.registry.compareAndSwap(ref, expected, patch, opts);
      if (!rolled && isRenewalOfNoPointer(patch)) {
        rolled = true;
        // An operator rolls forward onto the object, reading the renewed row.
        await rollbackSegment(REF, 0, w.deps, { allowForward: true });
      }
      return out;
    };
    const res = await eraseIdFromSegment(REF, X, { ...w.deps, registry: erasing });
    expect(rolled).toBe(true);
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      fromGeneration: 0,
      collected: [],
    });
    expect((await w.registry.get(REF))!.currentGen).toBe(0);
    expect(await generations(w.storage)).toEqual([0]);
  });
});

describe('an erasure that finds no holder on a row with no pointer writes nothing', () => {
  it('an empty bucket', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    const before = (await w.registry.get(REF))!;
    expect(await eraseIdFromSegment(REF, X, w.deps)).toEqual({
      segment: 's',
      namespace: undefined,
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
    expect((await w.registry.get(REF))!.token).toBe(before.token);
  });

  it('an innocent first load in flight still publishes', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    const before = (await w.registry.get(REF))!;
    const atPublish = gate();
    const load = loadSegment(REF, [1, 2, 3], {
      ...w.deps,
      registry: heldAtPublish(w.registry, atPublish),
    });
    await atPublish.reached;
    let writes = 0;
    const counted = Object.create(w.registry) as IRegistryDriver;
    counted.compareAndSwap = (ref, expected, patch, opts) => {
      writes += 1;
      return w.registry.compareAndSwap(ref, expected, patch, opts);
    };
    expect(await eraseIdFromSegment(REF, X, { ...w.deps, registry: counted })).toMatchObject({
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
    expect(writes).toBe(0);
    expect((await w.registry.get(REF))!.token).toBe(before.token);
    atPublish.open();
    expect(await load).toMatchObject({ generation: 0, published: true });
  });
});

describe('objects sealed under a key no row holds', () => {
  // On a row with no pointer the erasure holds no key, so it cannot search an encrypted first load's object. Each one
  // counts as a holder: it is deleted, and listed in `collected`. Only a searched object that held the id makes the
  // answer `erased: true`.
  it("only sealed holders: each is deleted, and the answer is 'no-generation' with them in collected", async () => {
    const ks = keystore();
    const w = world({ keystore: ks });
    await w.registry.create(REF, { currentGen: null });
    const before = (await w.registry.get(REF))!;
    await crashedFirstLoad(w.storage, w.registry, 0, [1, 2], ks);
    const audit = new RecordingAuditSink();
    expect(await eraseIdFromSegment(REF, X, w.deps, { audit })).toEqual({
      segment: 's',
      namespace: undefined,
      erased: false,
      reason: 'no-generation',
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([]);
    expect((await w.registry.get(REF))!.pointerId).not.toBe(before.pointerId);
    // The deletion is audited, with no generation the id was found in, since none was searched.
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.collect', segment: 's', incarnation: expect.any(String), collected: [0] },
    ]);
  });

  it('a sealed holder beside a cleartext one that holds the id: both go, and the answer is erased', async () => {
    const ks = keystore();
    const w = world({ keystore: ks });
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]); // cleartext, from a store with no keystore
    await crashedFirstLoad(w.storage, w.registry, 1, [1, 2], ks);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 0,
      collected: [0, 1],
    });
    expect(await generations(w.storage)).toEqual([]);
  });
});

/**
 * A registry write that ends without an answer may have landed, and may still land. The erasure reads the row and
 * decides from it, deleting nothing until it has: the renewal landed (this one or another erasure's), it did not (a
 * fresh compare-and-swap from the row read, after a wait), or the row moved on (the reason it says).
 */
describe('the renewal gets no answer', () => {
  const timing = recordedWaits;
  const dropping = (
    registry: IRegistryDriver,
    plan: readonly Unanswered[],
    between?: (nth: number) => Promise<void>,
  ): IRegistryDriver & { sends: number } =>
    unansweredRegistry(registry, plan, between === undefined ? {} : { between });

  async function seeded(): Promise<ReturnType<typeof world> & { before: RegistryRecord }> {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await crashedFirstLoad(w.storage, w.registry, 0, [1, X]);
    return { ...w, before: (await w.registry.get(REF))! };
  }

  it('it landed: the erasure goes on', async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['land-then-throw']);
    const deps: EraseIdDeps = { ...w.deps, registry, clock: t.clock, rng: t.rng };
    expect(await eraseIdFromSegment(REF, X, deps)).toMatchObject({
      erased: true,
      collected: [0],
    });
    expect(registry.sends).toBe(1);
    expect(t.sleeps).toEqual([]);
  });

  it('it did not land: a fresh write is sent after a wait, and lands', async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw']);
    const deps: EraseIdDeps = { ...w.deps, registry, clock: t.clock, rng: t.rng };
    expect(await eraseIdFromSegment(REF, X, deps)).toMatchObject({
      erased: true,
      collected: [0],
    });
    expect(registry.sends).toBe(2);
    expect(t.sleeps).toEqual([250]);
  });

  it('it never lands: three fresh writes, then the TransientError, and nothing deleted', async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw', 'throw', 'throw', 'throw']);
    const deps: EraseIdDeps = { ...w.deps, registry, clock: t.clock, rng: t.rng };
    await expect(eraseIdFromSegment(REF, X, deps)).rejects.toBeInstanceOf(TransientError);
    expect(registry.sends).toBe(4);
    expect(t.sleeps).toEqual([250, 500, 1000]);
    expect(await generations(w.storage)).toEqual([0]);
    expect((await w.registry.get(REF))!.token).toBe(w.before.token);
  });

  it('with no clock to wait on, the TransientError is thrown at once, and nothing deleted', async () => {
    const w = await seeded();
    const registry = dropping(w.registry, ['throw']);
    await expect(eraseIdFromSegment(REF, X, { ...w.deps, registry })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(registry.sends).toBe(1);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('the row cannot be read either: the TransientError is thrown, and nothing deleted', async () => {
    const w = await seeded();
    const t = timing();
    let failReads = false;
    const registry = dropping(w.registry, ['throw'], async () => {
      failReads = true;
    });
    const failing = Object.create(registry) as IRegistryDriver;
    failing.get = (ref) =>
      failReads ? Promise.reject(new Error('the read failed too')) : w.registry.get(ref);
    const res = eraseIdFromSegment(REF, X, {
      ...w.deps,
      registry: failing,
      clock: t.clock,
      rng: t.rng,
    });
    await expect(res).rejects.toSatisfy(
      (e: unknown) => e instanceof TransientError && /timed out/.test(e.message),
    );
    expect(await generations(w.storage)).toEqual([0]);
  });

  it("the row is gone: 'absent', and nothing deleted", async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw'], async () => {
      const row = (await w.registry.get(REF))!;
      await w.registry.delete(REF, row.token);
    });
    expect(
      await eraseIdFromSegment(REF, X, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: false, reason: 'absent', collected: [] });
    expect(registry.sends).toBe(1);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('the row is a tombstone: nothing is deleted until the tombstone is searched', async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw'], async () => {
      const row = (await w.registry.get(REF))!;
      await w.registry.compareAndSwap(REF, row.token, { status: 'destroyed' });
    });
    const statusAtDelete: (string | undefined)[] = [];
    const storage = Object.create(w.storage) as IStorageDriver;
    storage.delete = async (key) => {
      statusAtDelete.push((await w.registry.get(REF))?.status);
      return w.storage.delete(key);
    };
    expect(
      await eraseIdFromSegment(REF, X, {
        ...w.deps,
        storage,
        registry,
        clock: t.clock,
        rng: t.rng,
      }),
    ).toMatchObject({ erased: true });
    expect(registry.sends).toBe(1);
    expect(statusAtDelete.length).toBeGreaterThan(0);
    expect(statusAtDelete.every((s) => s === 'destroyed')).toBe(true);
    expect(await generations(w.storage)).toEqual([]);
  });

  it("another erasure's renewal landed after the row was read: that licenses the deletes, and this one is not sent again", async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw'], async () => {
      const row = (await w.registry.get(REF))!;
      await w.registry.compareAndSwap(REF, row.token, { currentGen: null });
    });
    expect(
      await eraseIdFromSegment(REF, X, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: true, collected: [0] });
    expect(registry.sends).toBe(1);
    expect(t.sleeps).toEqual([]);
  });

  it("the pointer was set: 'superseded', and nothing deleted", async () => {
    const w = await seeded();
    const t = timing();
    const registry = dropping(w.registry, ['throw'], async () => {
      const row = (await w.registry.get(REF))!;
      await w.registry.compareAndSwap(REF, row.token, { currentGen: 0 });
    });
    expect(
      await eraseIdFromSegment(REF, X, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0, collected: [] });
    expect(registry.sends).toBe(1);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('a row purged and made again meanwhile is no renewal: nothing is deleted, and the number a new load took stays its own', async () => {
    // While the renewal is unanswered, the row is purged and the bucket emptied, the name is made again with no
    // pointer, and a first load of the new row takes generation 0 again and stops at its publish. The new row has a
    // pointerId of its own, but it is another incarnation: taking it for a renewal would delete that load's object
    // under the number the erasure listed, and the load would then publish a pointer to nothing.
    const w = await seeded();
    const t = timing();
    const atPublish = gate();
    let load: Promise<LoadResult> | undefined;
    const registry = dropping(w.registry, ['throw'], async () => {
      const row = (await w.registry.get(REF))!;
      await w.registry.delete(REF, row.token);
      await w.storage.delete({ ...REF, generation: 0 });
      await w.registry.create(REF, { currentGen: null });
      load = loadSegment(REF, [3, X], {
        ...w.deps,
        registry: heldAtPublish(w.registry, atPublish),
      });
      await atPublish.reached;
    });
    expect(
      await eraseIdFromSegment(REF, X, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await generations(w.storage)).toEqual([0]);
    atPublish.open();
    expect(await load).toMatchObject({ generation: 0, published: true });
    expect((await w.registry.get(REF))!.currentGen).toBe(0);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('a renewal another erasure landed first, met as a lost race, licenses the deletes too', async () => {
    const w = await seeded();
    let raced = false;
    const racing = Object.create(w.registry) as IRegistryDriver;
    racing.compareAndSwap = async (ref, expected, patch, opts) => {
      if (!raced && isRenewalOfNoPointer(patch)) {
        raced = true;
        const row = (await w.registry.get(REF))!;
        await w.registry.compareAndSwap(REF, row.token, { currentGen: null });
      }
      return w.registry.compareAndSwap(ref, expected, patch, opts);
    };
    expect(await eraseIdFromSegment(REF, X, { ...w.deps, registry: racing })).toMatchObject({
      erased: true,
      collected: [0],
    });
    expect(raced).toBe(true);
  });
});

describe('an eraseSubject of an id no segment holds, beside first loads in flight', () => {
  // On a row with no pointer the erasure holds no key, so every encrypted object a first load wrote there counts as a
  // holder, whatever id is erased: the erasure renews the row and deletes it, and that load is refused. Only such a
  // load: one onto no row, one above a pointer under the row's key, and a cleartext one that does not hold the id all
  // publish.
  it('refuses an encrypted first load onto a row made ahead of its data, and only that load', async () => {
    const backend = new MemoryStorage();
    const ks = keystore();
    const store = new CloudRoaring({
      storage: backend,
      encryption: { keystore: ks },
      retry: false,
    });
    const sealedDeps = { storage: backend.storage, codec: roaringCodec, keystore: ks };
    const plainDeps = { storage: backend.storage, codec: roaringCodec };
    const ns = 'fleet';
    const ref = (segment: string): SegmentRef => ({ namespace: ns, segment });

    // A row made ahead of its data, then an encrypted first load onto it.
    await store.setRetention(ref('ahead'), { expiresAt: Date.now() + 86_400_000 });
    // A loaded encrypted segment, and a second load above its pointer.
    await store.load(ref('loaded'), [1, 2]);
    // A row made ahead of its data, and a cleartext first load onto it that does not hold the id.
    await store.setRetention(ref('plain'), { expiresAt: Date.now() + 86_400_000 });

    const loads: { name: string; done: Promise<LoadResult>; at: ReturnType<typeof gate> }[] = [];
    const start = (name: string, ids: number[], deps: typeof plainDeps): void => {
      const at = gate();
      const done = loadSegment(ref(name), ids, {
        ...deps,
        registry: heldAtPublish(backend.registry, at),
      });
      loads.push({ name, done, at });
    };
    start('ahead', [1, 2], sealedDeps);
    start('fresh', [1, 2], sealedDeps); // onto no row: no erasure reaches it
    start('loaded', [1, 2, 3], sealedDeps);
    start('plain', [1, 2], plainDeps);
    await Promise.all(loads.map((l) => l.at.reached));

    const unrelated = 4242;
    const audit = new RecordingAuditSink();
    const ledger = await store.eraseSubject(unrelated, { namespace: ns, audit });
    // The ledger lists no segment, since the id was found in none; the audit sink records the one deletion.
    expect(ledger.erasedFrom).toEqual([]);
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: ns,
        segment: 'ahead',
        incarnation: expect.any(String),
        collected: [0],
      },
    ]);
    for (const l of loads) l.at.open();
    const outcomes = Object.fromEntries(
      await Promise.all(loads.map(async (l) => [l.name, await l.done] as const)),
    );
    expect(outcomes.ahead).toMatchObject({ published: false, reason: 'superseded' });
    expect(outcomes.fresh).toMatchObject({ published: true });
    expect(outcomes.loaded).toMatchObject({ published: true });
    expect(outcomes.plain).toMatchObject({ published: true });
    const objects: number[] = [];
    for await (const k of backend.storage.list(ref('ahead'))) objects.push(k.generation);
    expect(objects).toEqual([]);
  });
});
