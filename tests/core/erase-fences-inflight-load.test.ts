import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment, type LoadOptions } from '@/core/load';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { IRegistryDriver, SegmentRef } from '@/index';
import { collect } from '../helpers/loaded';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { TransientError } from '@/core/errors';
import { rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { recordedWaits, unansweredRegistry } from '../helpers/unanswered-registry';

/**
 * An erasure that finds the id only in a generation above the pointer deletes that generation. A load that wrote it
 * and has not yet published holds a publish fenced on the row it read, so the erasure first renews the row's
 * `pointerId` (it names the pointer at the value it has), a change the load's fence counts as another writer's. Without
 * that write the load published after the delete, and the row named a generation that is not in the bucket.
 */
const REF: SegmentRef = { segment: 's' };

async function generations(storage: MemoryStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('an erasure fences a load in flight before deleting its object', () => {
  it('the load is refused, and the row names only what is in the bucket', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);

    // Hold the load at its publish, with its object already in the bucket.
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const gated = Object.create(registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!held && 'currentGen' in patch) {
        held = true;
        reach();
        await gate;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 3, 9], { ...deps, registry: gated });
    await reached;
    expect(await generations(storage)).toEqual([0, 1]);

    const before = (await registry.get(REF))!;
    const erased = await eraseIdFromSegment(REF, 9, deps);
    // The fence renewed the row's pointerId and kept what a read resolves: the pointer and the summary.
    const fenced = (await registry.get(REF))!;
    expect(fenced.pointerId).not.toBe(before.pointerId);
    expect(fenced.pointerId).toBe(fenced.token);
    expect(fenced.currentGen).toBe(0);
    expect(fenced.summary).toEqual(before.summary);
    open();
    const loaded = await load;

    expect(erased).toMatchObject({ erased: true });
    expect(loaded.published).toBe(false);
    const row = (await registry.get(REF))!;
    expect(row.currentGen).toBe(0);
    expect(await generations(storage)).toEqual([0]);
  });

  it('the load publishes before the fence lands: the erasure deletes nothing, and a re-run erases from the new generation', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);
    let reachLoad!: () => void;
    const loadReached = new Promise<void>((resolve) => (reachLoad = resolve));
    let openLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => (openLoad = resolve));
    let loadHeld = false;
    const gated = Object.create(registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!loadHeld && 'currentGen' in patch) {
        loadHeld = true;
        reachLoad();
        await loadGate;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 3, 9], { ...deps, registry: gated });
    await loadReached;

    // The erasure is held at its fence, which names the pointer; the load's publish lands meanwhile.
    let reachFence!: () => void;
    const fenceReached = new Promise<void>((resolve) => (reachFence = resolve));
    let openFence!: () => void;
    const fenceGate = new Promise<void>((resolve) => (openFence = resolve));
    let fenceHeld = false;
    const erasing = Object.create(registry) as MemoryRegistryDriver;
    erasing.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!fenceHeld && 'currentGen' in patch) {
        fenceHeld = true;
        reachFence();
        await fenceGate;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const erasure = eraseIdFromSegment(REF, 9, { ...deps, registry: erasing });
    await fenceReached;
    openLoad();
    expect(await load).toMatchObject({ generation: 1, published: true });
    openFence();

    expect(await erasure).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect((await registry.get(REF))!.currentGen).toBe(1);
    expect(await generations(storage)).toEqual([0, 1]);
    expect(await eraseIdFromSegment(REF, 9, deps)).toMatchObject({
      erased: true,
      fromGeneration: 1,
    });
  });

  it('pins written while the fence is written are waited out, not reported as another writer', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const gated = Object.create(registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!held && 'currentGen' in patch) {
        held = true;
        reach();
        await gate;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 3, 9], { ...deps, registry: gated });
    await reached;

    // Before each of the erasure's first eight fence writes, a reader pins generation 0: a lease-only change.
    let pins = 0;
    const pinned = Object.create(registry) as MemoryRegistryDriver;
    pinned.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if ('currentGen' in patch && pins < 8) {
        pins += 1;
        const row = (await registry.get(ref))!;
        await registry.compareAndSwap(ref, row.token, {
          leases: [{ holder: pins.toString(16).padStart(16, '0'), generation: 0, until: 1e15 }],
        });
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const erased = await eraseIdFromSegment(REF, 9, { ...deps, registry: pinned });
    open();
    const loaded = await load;

    expect(pins).toBe(8);
    expect(erased).toMatchObject({ erased: true });
    expect(loaded.published).toBe(false);
  });

  it('the erasure that loses to the publish reports it, and a re-run erases from the new generation', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);
    // The load lands first: the erasure finds 9 in the current generation and rewrites it.
    await loadSegment(REF, [1, 2, 3, 9], deps);
    const erased = await eraseIdFromSegment(REF, 9, deps);
    expect(erased).toMatchObject({ erased: true, fromGeneration: 1 });
    const row = (await registry.get(REF))!;
    expect(await generations(storage)).toEqual([row.currentGen!]);
  });
});

describe('the fence above the pointer gets no answer', () => {
  // A registry write that ends without an answer may have landed, and may still land. The erasure reads the row and
  // decides from it, and deletes no holder above the pointer until it has.
  async function rolledBack() {
    const storage = new MemoryStorageDriver();
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2], deps);
    await loadSegment(REF, [1, 2, 9], deps);
    await rollbackSegment(REF, 0, deps); // generation 1, holding 9, is above the pointer
    return { storage, registry, deps, before: (await registry.get(REF))! };
  }

  it('it landed: the holder is deleted, and the write is not sent again', async () => {
    const w = await rolledBack();
    const t = recordedWaits();
    const registry = unansweredRegistry(w.registry, ['land-then-throw']);
    expect(
      await eraseIdFromSegment(REF, 9, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: true, fromGeneration: 1, collected: [1] });
    expect(registry.sends).toBe(1);
    expect(t.sleeps).toEqual([]);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('it did not land: a fresh write, after a wait, lands, and the holder is deleted', async () => {
    const w = await rolledBack();
    const t = recordedWaits();
    const registry = unansweredRegistry(w.registry, ['throw', 'throw']);
    expect(
      await eraseIdFromSegment(REF, 9, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: true, collected: [1] });
    expect(registry.sends).toBe(3);
    expect(t.sleeps).toEqual([250, 500]);
    const row = (await w.registry.get(REF))!;
    expect(row.currentGen).toBe(0);
    expect(row.pointerId).not.toBe(w.before.pointerId);
  });

  it('it never lands: the TransientError is thrown, and the holder above the pointer is kept', async () => {
    const w = await rolledBack();
    const t = recordedWaits();
    const registry = unansweredRegistry(w.registry, ['throw', 'throw', 'throw', 'throw']);
    await expect(
      eraseIdFromSegment(REF, 9, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(registry.sends).toBe(4);
    expect(t.sleeps).toEqual([250, 500, 1000]);
    expect(await generations(w.storage)).toEqual([0, 1]);
    expect((await w.registry.get(REF))!.token).toBe(w.before.token);
  });

  it('a lease written while it is unanswered is waited out, and the fresh write lands', async () => {
    const w = await rolledBack();
    const t = recordedWaits();
    const registry = unansweredRegistry(w.registry, ['throw'], {
      between: async () => {
        const row = (await w.registry.get(REF))!;
        await w.registry.compareAndSwap(REF, row.token, {
          leases: [{ holder: '00000000000000aa', generation: 0, until: 1e15 }],
        });
      },
    });
    expect(
      await eraseIdFromSegment(REF, 9, { ...w.deps, registry, clock: t.clock, rng: t.rng }),
    ).toMatchObject({ erased: true, collected: [1] });
    expect(registry.sends).toBe(2);
  });
});

/** A point a call stops at until the test opens it, and a promise that says it got there. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, opened, reach, reached };
}

describe('an erasure and a first load that found no row', () => {
  // The load reads no row, another load creates the row at generation 0, and this load numbers past that object and
  // writes generation 1 holding the id. The erasure finds the id only there, above the pointer, writes the row and
  // deletes generation 1. The load then publishes: had it no fence, it would advance the pointer to 1 over the row
  // that appeared, naming an object the erasure deleted, and every read of the segment would fail. It fences on the
  // absence it found, guarded or not, so it is refused.
  const X = 4242;
  const REF_NS: SegmentRef = { namespace: 'ns', segment: 'g' };

  it.each<[string, LoadOptions]>([
    ['an unguarded', { allowEmpty: true }],
    ['a guarded', {}],
  ])(
    '%s load is refused, the pointer stays on a generation in the bucket, and every read works',
    async (_, options) => {
      const backend = new MemoryStorage();
      const store = new CloudRoaring({ storage: backend, retry: false });
      const registry = backend.registry;
      const afterRead = gate();
      const atCreate = gate();
      let reads = 0;
      let creates = 0;
      const gated = Object.create(registry) as IRegistryDriver;
      gated.get = async (ref) => {
        const row = await registry.get(ref);
        if (reads++ === 0) {
          afterRead.reach();
          await afterRead.opened;
        }
        return row;
      };
      gated.create = async (ref, record, opts) => {
        if (creates++ === 0) {
          atCreate.reach();
          await atCreate.opened;
        }
        return registry.create(ref, record, opts);
      };
      const audit = new RecordingAuditSink();
      const load = loadSegment(
        REF_NS,
        [X, 7],
        { storage: backend.storage, registry: gated, codec: roaringCodec },
        { ...options, audit },
      );

      await afterRead.reached; // it read no row
      expect((await store.load(REF_NS, [1])).generation).toBe(0); // another load creates the row
      afterRead.open();
      await atCreate.reached; // it wrote generation 1, holding X, and is about to create the row
      const objects = async (): Promise<number[]> => {
        const out: number[] = [];
        for await (const k of backend.storage.list(REF_NS)) out.push(k.generation);
        return out.sort((a, b) => a - b);
      };
      expect(await objects()).toEqual([0, 1]);

      const erased = await store.eraseSubject(X, { namespace: 'ns' });
      atCreate.open();
      const loaded = await load;

      // The erasure's ledger: it found X only in generation 1, above the pointer, and deleted it.
      expect(erased.erasedFrom).toEqual([
        { segment: 'g', namespace: 'ns', erased: true, fromGeneration: 1 },
      ]);
      expect(loaded).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
      expect(audit.snapshot()).toContainEqual(
        expect.objectContaining({
          kind: 'segment.load-refused',
          generation: 1,
          reason: 'superseded',
        }),
      );
      expect((await registry.get(REF_NS))!.currentGen).toBe(0);
      expect(await objects()).toEqual([0]);
      const seg = new CloudRoaring({ storage: backend, retry: false }).segment('g', {
        namespace: 'ns',
      });
      expect(await seg.has(X)).toBe(false);
      expect(await collect(seg.iterate())).toEqual([1]);
    },
  );
});

describe('a row with no pointer, over an object a first load wrote and never published', () => {
  // A row minted by `setRetention` before the first load names no generation, and the first load's object is in the
  // bucket until that load publishes. The erasure renews the row's pointerId before it deletes the object, so that load
  // can no longer publish it. `erase-pointerless-first-load.test.ts` holds the races.
  async function world() {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await registry.create(REF, { currentGen: null });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], {
      registry,
      publish: false,
    });
    return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
  }

  it('an id the unpublished object holds is erased, and the object is deleted', async () => {
    const w = await world();
    const before = (await w.registry.get(REF))!;
    expect(await eraseIdFromSegment(REF, 2, w.deps)).toEqual({
      segment: 's',
      namespace: undefined,
      erased: true,
      fromGeneration: 0,
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([]);
    const row = (await w.registry.get(REF))!;
    expect(row.currentGen).toBeNull();
    expect(row.pointerId).not.toBe(before.pointerId);
  });

  it("an id it does not hold is 'no-generation', as with an empty bucket, and nothing is written or deleted", async () => {
    const w = await world();
    const before = (await w.registry.get(REF))!;
    expect(await eraseIdFromSegment(REF, 7, w.deps)).toMatchObject({
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
    expect((await w.registry.get(REF))!.token).toBe(before.token);
    expect(await generations(w.storage)).toEqual([0]);
  });
});

describe('a row with no pointer, on a store that requires encryption', () => {
  // A row `setRetention` minted before the first load holds no key and no data, so it is not a cleartext segment: the
  // erasure reports it as holding nothing, as on any store, rather than refusing it as cleartext.
  function world() {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { storage, registry, codec: roaringCodec, keystore, requireEncryption: true };
    return { storage, registry, deps };
  }

  it("an empty row is 'no-generation'", async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    expect(await eraseIdFromSegment(REF, 7, w.deps)).toMatchObject({
      erased: false,
      reason: 'no-generation',
    });
  });

  it('a first load held at its publish is a holder, since its object cannot be searched: it is deleted, and the load refused', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const gated = Object.create(w.registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!held && 'currentGen' in patch) {
        held = true;
        reach();
        await gate;
      }
      return w.registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 9], { ...w.deps, registry: gated });
    await reached;
    expect(await generations(w.storage)).toEqual([0]);

    const outcome = await eraseIdFromSegment(REF, 9, w.deps);
    open();
    expect(outcome).toEqual({
      segment: 's',
      namespace: undefined,
      erased: false,
      reason: 'no-generation',
      collected: [0],
    });
    expect(await load).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    expect(await generations(w.storage)).toEqual([]);
    expect((await w.registry.get(REF))!.currentGen).toBeNull();
  });
});
