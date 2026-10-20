import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring } from '@/index';
import type { SegmentRef } from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { TransientError } from '@/core/errors';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { faultyRegistry } from '../helpers/lost-answer';
import { withoutTokenReports } from '../helpers/no-token-reports';
import { recordedWaits } from '../helpers/unanswered-registry';

/**
 * `setRetention` and `clearRetention` settle a registry write that landed and lost its answer by reading the row
 * back: a row that carries a token this call sent is this call's own write. Every expiry an attempt read before it
 * sent a write has its due-index pointer removed, so a write that moved an expiry never strands the old day's pointer.
 *
 * Faults, as the registry meets them: (a) the write landed and its answer was lost; (b) it landed and the answer was a
 * conflict that may follow its own landing; (c) it never landed. The (c) cases pass before and after the change: they
 * hold that a write that did not land is never claimed.
 */

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;
const X = T0 + 10 * DAY;
const Y = T0 + 20 * DAY;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const isDue = (ref: SegmentRef) => ref.namespace?.startsWith('cbm.due.') === true;

type Kind = 'memory' | 'localfs';

describe.each<Kind>(['memory', 'localfs'])(
  'a retention write whose answer was lost (%s)',
  (kind) => {
    let dir: string | undefined;
    beforeEach(async () => {
      dir = kind === 'localfs' ? await mkdtemp(join(tmpdir(), 'cbm-retlost-')) : undefined;
    });
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    function world(tokenless = false) {
      const storage: IStorageDriver =
        dir === undefined ? new MemoryStorageDriver() : new LocalFsStorageDriver(dir);
      const raw: IRegistryDriver =
        dir === undefined
          ? new MemoryRegistryDriver({ now: () => T0 })
          : new LocalFsRegistryDriver(dir, { now: () => T0 });
      const registry = faultyRegistry(raw);
      const waits = recordedWaits();
      const store = new CloudRoaring({
        storage: brandAsBackend({
          storage,
          registry: tokenless ? withoutTokenReports(registry) : registry,
        }),
        retry: false,
        seams: { clock: waits.clock, rng: waits.rng },
      });
      return { raw, registry, store };
    }
    type World = ReturnType<typeof world>;

    /** The days of the due-index pointers in the registry, ascending. */
    async function due(w: World): Promise<number[]> {
      const days: number[] = [];
      for await (const r of w.raw.list()) {
        if (isDue(r)) days.push(Number(r.namespace!.slice('cbm.due.'.length)));
      }
      return days.sort((a, b) => a - b);
    }
    const day = (t: number) => Math.floor(t / DAY);

    describe('setRetention ahead of the first load', () => {
      it.each(['a', 'b'] as const)('reports the row it created (%s)', async (fault) => {
        const w = world();
        w.registry.arm('create', fault);

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ expiresAt: Y, createdRow: true, indexed: true });
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: Y });
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('reports the row it created when another write followed it before the read-back', async () => {
        const w = world();
        w.registry.arm('create', 'a');
        w.registry.between(async () => {
          const row = (await w.raw.get(SEG))!;
          await w.raw.compareAndSwap(SEG, row.token, { retention: { expiresAt: Y, other: 1 } });
        });

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ createdRow: true, indexed: true });
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('keeps createdRow true after a later policy write, and writes no pointer for a changed expiry', async () => {
        const w = world();
        w.registry.arm('create', 'a');
        w.registry.between(async () => {
          const row = (await w.raw.get(SEG))!;
          await w.raw.compareAndSwap(SEG, row.token, {
            retention: { expiresAt: X },
          });
        });

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ expiresAt: Y, createdRow: true });
        expect(await due(w)).toEqual([day(X)]);
      });

      it('says createdRow is false after a later load published onto the row', async () => {
        const w = world();
        w.registry.arm('create', 'a');
        w.registry.between(async () => {
          const row = (await w.raw.get(SEG))!;
          await w.raw.compareAndSwap(SEG, row.token, { currentGen: 0 });
        });

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ expiresAt: Y, createdRow: false, indexed: true });
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: Y });
      });

      it('throws a create that never landed, and its re-run creates the row', async () => {
        const w = world();
        w.registry.arm('create', 'c');

        await expect(w.store.setRetention(SEG, { expiresAt: Y })).rejects.toBeInstanceOf(
          TransientError,
        );
        expect(await w.raw.get(SEG)).toBeNull();

        const again = await w.store.setRetention(SEG, { expiresAt: Y });
        expect(again).toMatchObject({ createdRow: true, indexed: true });
      });

      it('says a row another writer created is not its own', async () => {
        const w = world();
        w.registry.arm('create', 'c');
        w.registry.between(async () => {
          await w.raw.create(SEG, { currentGen: null, retention: { expiresAt: X } });
        });

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ createdRow: false, indexed: true });
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: Y });
      });
    });

    describe('setRetention moving an expiry', () => {
      it.each(['a', 'b'] as const)('removes the old day pointer (%s)', async (fault) => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        expect(await due(w)).toEqual([day(X)]);
        w.registry.arm('compareAndSwap', fault);

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ expiresAt: Y, createdRow: false, indexed: true });
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: Y });
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('throws a swap that never landed, and its re-run moves the expiry and the pointer', async () => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', 'c');

        await expect(w.store.setRetention(SEG, { expiresAt: Y })).rejects.toBeInstanceOf(
          TransientError,
        );
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: X });

        await w.store.setRetention(SEG, { expiresAt: Y });
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('decides again from a row another writer moved on, and removes the pointer of each expiry it read', async () => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        const Z = T0 + 30 * DAY;
        w.registry.arm('compareAndSwap', 'c');
        w.registry.between(async () => {
          const row = (await w.raw.get(SEG))!;
          await w.raw.compareAndSwap(SEG, row.token, { retention: { expiresAt: Z } });
        });

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res).toMatchObject({ expiresAt: Y, createdRow: false, indexed: true });
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: Y });
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('keeps today behaviour on a registry that reports no write tokens', async () => {
        const w = world(true);
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', 'a');

        await expect(w.store.setRetention(SEG, { expiresAt: Y })).rejects.toBeInstanceOf(
          TransientError,
        );
      });
    });

    describe('the due-index pointer', () => {
      it('reads the pointer back when its create got no answer', async () => {
        const w = world();
        w.registry.arm('create', 'a', isDue);

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res.indexed).toBe(true);
        expect(await due(w)).toEqual([day(Y)]);
      });

      it('says indexed: false for a pointer create that never landed', async () => {
        const w = world();
        w.registry.arm('create', 'c', isDue);

        const res = await w.store.setRetention(SEG, { expiresAt: Y });

        expect(res.indexed).toBe(false);
        expect(await due(w)).toEqual([]);
      });
    });

    describe('clearRetention', () => {
      it.each(['a', 'b'] as const)('answers true for the expiry it removed (%s)', async (fault) => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', fault);

        expect(await w.store.clearRetention(SEG)).toBe(true);

        expect((await w.raw.get(SEG))?.retention).toBeUndefined();
        expect(await due(w)).toEqual([]);
      });

      it('answers false but removes the pointer when another write followed its clear', async () => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', 'a');
        w.registry.between(async () => {
          const row = (await w.raw.get(SEG))!;
          await w.raw.compareAndSwap(SEG, row.token, { retention: { other: 1 } });
        });

        expect(await w.store.clearRetention(SEG)).toBe(false);

        expect((await w.raw.get(SEG))?.retention).toEqual({ other: 1 });
        expect(await due(w)).toEqual([]);
      });

      it('throws a clear that never landed, and its re-run removes the expiry and the pointer', async () => {
        const w = world();
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', 'c');

        await expect(w.store.clearRetention(SEG)).rejects.toBeInstanceOf(TransientError);
        expect((await w.raw.get(SEG))?.retention).toEqual({ expiresAt: X });

        expect(await w.store.clearRetention(SEG)).toBe(true);
        expect(await due(w)).toEqual([]);
      });

      it('answers false for a segment with no policy, and leaves a stranger pointer alone', async () => {
        const w = world();
        await w.raw.create(SEG, { currentGen: null });
        expect(await w.store.clearRetention(SEG)).toBe(false);
      });

      it('keeps today behaviour on a registry that reports no write tokens', async () => {
        const w = world(true);
        await w.store.setRetention(SEG, { expiresAt: X });
        w.registry.arm('compareAndSwap', 'a');

        await expect(w.store.clearRetention(SEG)).rejects.toBeInstanceOf(TransientError);
      });
    });
  },
);
