import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring, RecordingAuditSink, destroySegment } from '@/index';
import type { SegmentRef } from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver } from '@/core/ports';
import { roaringCodec } from '@/native-codec';
import { InProcessKeystore } from '@/drivers/crypto';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';
import { faultyStorage } from '../helpers/lost-answer';
import { gate } from '../helpers/retaken-number-race';
import { recordedWaits } from '../helpers/unanswered-registry';

/**
 * A storage delete that lands and loses its answer is settled by reading its key: an object found gone counts as
 * deleted, so an erasure reports and audits it, a drop counts it and a load's collection returns. Faults: (a) the
 * delete landed and its answer was lost; (c) it never landed. The (c) cases pass before and after the change: they
 * hold that a delete that did not land is never claimed. The read-back that fails too, and a delete that lands after
 * the read-back, are the documented limits: the call reports the fault and a re-run finds the id gone.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 5;
const at =
  (generation: number) =>
  (key: GenKey): boolean =>
    key.generation === generation;

type Kind = 'memory' | 'localfs';

describe.each<Kind>(['memory', 'localfs'])(
  'a storage delete whose answer was lost (%s)',
  (kind) => {
    let dir: string | undefined;
    beforeEach(async () => {
      dir = kind === 'localfs' ? await mkdtemp(join(tmpdir(), 'cbm-lost-del-')) : undefined;
    });
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    function world() {
      const raw: IStorageDriver =
        dir === undefined ? new MemoryStorageDriver() : new LocalFsStorageDriver(dir);
      const registry: IRegistryDriver =
        dir === undefined ? new MemoryRegistryDriver() : new LocalFsRegistryDriver(dir);
      const storage = faultyStorage(raw);
      const waits = recordedWaits();
      const audit = new RecordingAuditSink();
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        retry: false,
        seams: { clock: waits.clock, rng: waits.rng },
      });
      return { raw, registry, storage, waits, audit, store };
    }
    type World = ReturnType<typeof world>;

    const put = (w: World, generation: number, ids: number[], publish = true) =>
      bulkLoadCrbmGeneration(w.raw, { ...SEG, generation }, ids, { registry: w.registry, publish });
    const present = async (w: World): Promise<number[]> => {
      const out: number[] = [];
      for await (const k of w.raw.list(SEG)) out.push(k.generation);
      return out.sort((a, b) => a - b);
    };
    const events = (w: World) => w.audit.snapshot();
    const collects = (w: World) =>
      events(w).filter((e) => e.kind === 'segment.collect') as unknown as {
        fromGeneration?: number;
        collected: number[];
      }[];
    const erase = (w: World) => w.store.eraseSubject(X, { namespace: 'ns', audit: w.audit });

    describe('eraseSubject', () => {
      it('receipts a collect-only erasure whose last delete lost its answer', async () => {
        const w = world();
        await put(w, 0, [X, 6]);
        await put(w, 1, [7]);
        w.storage.armDelete('a', at(0));

        const res = await erase(w);

        expect(res.erasedFrom).toEqual([
          { segment: 's', namespace: 'ns', erased: true, fromGeneration: 0 },
        ]);
        expect(collects(w)).toMatchObject([{ fromGeneration: 0, collected: [0] }]);
        expect(await present(w)).toEqual([1]);
      });

      it('receipts a rewrite whose collection delete lost its answer', async () => {
        const w = world();
        await put(w, 0, [X, 6]);
        await put(w, 1, [X, 7]);
        w.storage.armDelete('a', at(0));

        const res = await erase(w);

        expect(res.erasedFrom).toEqual([
          { segment: 's', namespace: 'ns', erased: true, fromGeneration: 1, generation: 2 },
        ]);
        expect(events(w).map((e) => e.kind)).toEqual(['segment.rewrite']);
        expect(await present(w)).toEqual([2]);
      });

      it('receipts a holder above the pointer whose delete lost its answer', async () => {
        const w = world();
        await put(w, 0, [6]);
        await put(w, 1, [X], false);
        w.storage.armDelete('a', at(1));

        const res = await erase(w);

        expect(res.erasedFrom).toMatchObject([{ erased: true }]);
        expect(collects(w)).toMatchObject([{ collected: [1] }]);
        expect(await present(w)).toEqual([0]);
      });

      it('receipts a first load object on a row with no pointer', async () => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: Date.now() + 86_400_000 * 400 });
        await put(w, 0, [X, 6], false);
        w.storage.armDelete('a', at(0));

        const res = await erase(w);

        expect(res.erasedFrom).toMatchObject([{ erased: true }]);
        expect(collects(w)).toMatchObject([{ collected: [0] }]);
        expect(await present(w)).toEqual([]);
      });

      it('receipts a holder under a tombstone', async () => {
        const w = world();
        await put(w, 0, [X, 6]);
        await destroySegment(
          SEG,
          { registry: w.registry },
          { confirmSegment: 's', allowCleartext: true },
        );
        w.storage.armDelete('a', at(0));

        const res = await erase(w);

        expect(res.erasedFrom).toMatchObject([{ erased: true }]);
        expect(collects(w)).toMatchObject([{ collected: [0] }]);
        expect(await present(w)).toEqual([]);
      });

      it('receipts an object no read can open (sealed-only) whose delete lost its answer', async () => {
        const keystore = new InProcessKeystore({
          keys: { k1: randomBytes(32) },
          activeKeyId: 'k1',
        });
        const w = world();
        await bulkLoadCrbmGeneration(w.raw, { ...SEG, generation: 0 }, [6, 7], {
          registry: w.registry,
          keystore,
        });
        // A first load's object sealed under a key it made and never stored.
        await bulkLoadCrbmGeneration(w.raw, { ...SEG, generation: 1 }, [8], {
          registry: new MemoryRegistryDriver(),
          keystore,
          publish: false,
        });
        const store = new CloudRoaring({
          storage: brandAsBackend({ storage: w.storage, registry: w.registry }),
          encryption: { keystore },
          retry: false,
          seams: { clock: w.waits.clock, rng: w.waits.rng },
        });
        w.storage.armDelete('a', at(1));

        const res = await store.eraseSubject(99, { namespace: 'ns', audit: w.audit });

        expect(res.erasedFrom).toEqual([]);
        expect(collects(w)).toHaveLength(1);
        expect(collects(w)[0]).toMatchObject({ collected: [1] });
        expect(collects(w)[0]).not.toHaveProperty('fromGeneration');
        expect(await present(w)).toEqual([0]);
      });

      it.each(['collect-only', 'rewrite', 'above the pointer'] as const)(
        'a delete that never landed is an error and the re-run receipts it (%s)',
        async (shape) => {
          const w = world();
          const above = shape === 'above the pointer';
          const target = above ? 1 : 0;
          await put(w, 0, above ? [6] : [X, 6]);
          if (above) await put(w, 1, [X], false);
          else await put(w, 1, shape === 'rewrite' ? [X, 7] : [7]);
          w.storage.armDelete('c', at(target));

          const first = await erase(w);
          expect(first.erasedFrom).toMatchObject([
            { erased: false, note: expect.stringContaining('error: TransientError') },
          ]);
          const second = await erase(w);
          expect(second.erasedFrom).toMatchObject([{ erased: true }]);
          expect(collects(w).at(-1)?.collected).toContain(target);
        },
      );

      it('a delete whose read-back failed too is an error, and the re-run lists nothing', async () => {
        const w = world();
        await put(w, 0, [X, 6]);
        await put(w, 1, [7]);
        w.storage.armDelete('a', at(0));
        w.storage.failTails(3);

        const first = await erase(w);
        expect(first.erasedFrom).toMatchObject([{ erased: false }]);
        expect(collects(w)).toEqual([]);
        w.storage.failTails(0);
        expect((await erase(w)).erasedFrom).toEqual([]);
        expect(await present(w)).toEqual([1]);
      });

      it('a delete that lands after the read-back is an error, and the re-run lists nothing', async () => {
        const w = world();
        await put(w, 0, [X, 6]);
        await put(w, 1, [7]);
        w.storage.armDelete('c', at(0));
        w.storage.landAfterCheck();

        const first = await erase(w);
        expect(first.erasedFrom).toMatchObject([{ erased: false }]);
        expect((await erase(w)).erasedFrom).toEqual([]);
        expect(await present(w)).toEqual([1]);
      });
    });

    it('a holder replaced under its number before the read-back is not claimed as deleted', async () => {
      if (kind === 'localfs') return; // the file driver reports no object version, so it cannot tell
      const w = world();
      await put(w, 0, [6]);
      await put(w, 1, [X], false);
      w.storage.armDelete('a', at(1));
      w.storage.between(async () => {
        await bulkLoadCrbmGeneration(w.raw, { ...SEG, generation: 1 }, [8, 9], {
          registry: new MemoryRegistryDriver(),
          publish: false,
        });
      });

      const res = await erase(w);

      // The condition's own answer, as when any other writer retakes the number: the new object stays, and the call
      // does not list a deletion it did not make.
      expect(res.erasedFrom).toMatchObject([{ erased: true, fromGeneration: 1 }]);
      expect(await present(w)).toEqual([0, 1]);
      expect(collects(w)).toMatchObject([{ collected: [] }]);
    });

    it('a holder replaced by an object that also holds the id is not receipted', async () => {
      if (kind === 'localfs') return; // the file driver reports no object version, so it cannot tell
      const w = world();
      await put(w, 0, [6]);
      await put(w, 1, [X], false);
      w.storage.armDelete('a', at(1));
      w.storage.between(async () => {
        await bulkLoadCrbmGeneration(w.raw, { ...SEG, generation: 1 }, [X, 9], {
          registry: new MemoryRegistryDriver(),
          publish: false,
        });
      });

      const res = await erase(w);

      expect(res.erasedFrom).toMatchObject([{ erased: false, note: 'superseded' }]);
      expect(await present(w)).toEqual([0, 1]);
      expect(events(w)).toEqual([]);
    });

    describe('a refused rewrite discard', () => {
      const REF: SegmentRef = { segment: 's' };

      /** The refusal 'before verify' arranged as the discard fault test does, with the discard's delete faulted. */
      async function refused(fault: 'a' | 'c', how: 'superseded' | 'destroyed' = 'superseded') {
        const storage = new MemoryStorageDriver();
        const registry: IRegistryDriver = new MemoryRegistryDriver();
        const faulty = faultyStorage(storage);
        const deps = {
          storage,
          registry,
          entropy: testEntropy,
          codec: roaringCodec,
          clock: { now: () => 1_800_000_000_000, sleep: () => Promise.resolve() },
        };
        await loadSegment(REF, [1, 2, 9], deps);
        const atPublish = gate();
        const l1Registry = Object.create(registry) as IRegistryDriver;
        l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
          if ('currentGen' in patch && patch.currentGen === 1) {
            atPublish.reach();
            await atPublish.opened;
          }
          return registry.compareAndSwap(ref, expected, patch, options);
        };
        const l1 =
          how === 'superseded'
            ? loadSegment(REF, [5, 6], { ...deps, registry: l1Registry })
            : Promise.resolve();
        if (how === 'superseded') await atPublish.reached;
        let released = false;
        const own = how === 'destroyed' ? 1 : 2;
        const first = Object.create(faulty) as IStorageDriver;
        first.putImmutable = async (key, write) => {
          const out = await storage.putImmutable(key, write);
          if (key.generation === own && !released) {
            released = true;
            if (how === 'destroyed') {
              await destroySegment(
                REF,
                { registry },
                { confirmSegment: 's', allowCleartext: true },
              );
            } else {
              atPublish.open();
              await l1;
            }
          }
          return out;
        };
        faulty.armDelete(fault, (k) => k.generation === own);
        return {
          storage,
          registry,
          run: () => eraseIdFromSegment(REF, 9, { ...deps, storage: first }),
        };
      }

      it('reports the refusal when the discard landed and lost its answer', async () => {
        const w = await refused('a');
        const res = await w.run();
        expect(res).toMatchObject({ erased: false, reason: 'superseded' });
        const left: number[] = [];
        for await (const k of w.storage.list(REF)) left.push(k.generation);
        expect(left.sort()).toEqual([0, 1]);
      });

      it('settles the discard under a tombstone that landed and lost its answer', async () => {
        const w = await refused('a', 'destroyed');
        // The rewrite's object is discarded, then the erasure searches what the tombstone left, as it does for any
        // tombstoned row, and erases the id from it.
        expect(await w.run()).toMatchObject({ erased: true, fromGeneration: 0 });
        const left: number[] = [];
        for await (const k of w.storage.list(REF)) left.push(k.generation);
        expect(left).toEqual([]);
      });

      it('throws when the discard under a tombstone never landed, and the object stays', async () => {
        const w = await refused('c', 'destroyed');
        await expect(w.run()).rejects.toBeInstanceOf(TransientError);
        const left: number[] = [];
        for await (const k of w.storage.list(REF)) left.push(k.generation);
        expect(left).toContain(1);
      });

      it('throws when the discard never landed, and the object stays', async () => {
        const w = await refused('c');
        await expect(w.run()).rejects.toBeInstanceOf(TransientError);
        const left: number[] = [];
        for await (const k of w.storage.list(REF)) left.push(k.generation);
        expect(left.sort()).toEqual([0, 1, 2]);
      });
    });

    describe('dropSegment', () => {
      it('counts a delete settled by reading it back', async () => {
        const w = world();
        await put(w, 0, [1]);
        await put(w, 1, [2]);
        w.storage.armDelete('a', at(0));

        const res = await w.store.dropSegment(SEG, { confirmSegment: 's', audit: w.audit });

        expect(res.generationsDeleted).toEqual([0, 1]);
        expect(res.generationsRemaining).toEqual([]);
        expect(events(w)).toMatchObject([{ kind: 'segment.dispose', generationsDeleted: 2 }]);
        expect(await present(w)).toEqual([]);
      });

      it('leaves a delete that never landed to the next pass', async () => {
        const w = world();
        await put(w, 0, [1]);
        await put(w, 1, [2]);
        w.storage.armDelete('c', at(0));

        const res = await w.store.dropSegment(SEG, { confirmSegment: 's', audit: w.audit });

        expect(res.generationsDeleted).toEqual([0, 1]);
        expect(await present(w)).toEqual([]);
      });
    });

    describe('a load collecting what it evicts', () => {
      const deps = (w: World) => ({
        storage: w.storage,
        registry: w.registry,
        entropy: testEntropy,
        codec: roaringCodec,
        clock: w.waits.clock,
        rng: w.waits.rng,
      });
      it('settles a delete by name that lost its answer', async () => {
        const w = world();
        await w.store.load(SEG, [1, 2], { keep: 0 });
        w.storage.armDelete('a', at(0));

        const res = await w.store.load(SEG, [3], { keep: 0 });

        expect(res).toMatchObject({ published: true, collected: [0] });
        expect(await present(w)).toEqual([1]);
      });

      it('settles a delete in the listing pass that lost its answer', async () => {
        const w = world();
        await w.store.load(SEG, [1, 2], { keep: 0 });
        w.storage.armDelete('a', at(0));

        const res = await loadSegment(
          SEG,
          [3],
          { ...deps(w), collectByListing: true },
          { keep: 0 },
        );

        expect(res).toMatchObject({ published: true, collected: [0] });
        expect(await present(w)).toEqual([1]);
      });

      it('throws for a delete that never landed, after the publish', async () => {
        const w = world();
        await w.store.load(SEG, [1, 2], { keep: 0 });
        w.storage.armDelete('c', at(0));

        await expect(w.store.load(SEG, [3], { keep: 0 })).rejects.toBeInstanceOf(TransientError);
        expect(await present(w)).toEqual([0, 1]);
      });
    });
  },
);
