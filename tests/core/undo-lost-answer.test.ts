import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring } from '@/index';
import type { SegmentRef } from '@/index';
import { NotFoundError, TransientError } from '@/core/errors';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { faultyRegistry } from '../helpers/lost-answer';
import type { Fault } from '../helpers/lost-answer';
import { recordedWaits } from '../helpers/unanswered-registry';

/**
 * A rollback whose target went while the pointer was moving puts the pointer back. A move back that landed and lost
 * its answer is settled by reading the row, as the move onto the target is: the pointer's id is the token of the move
 * back, so the call reports the pointer as put back. One that never landed still says the pointer may be on the target.
 *
 * Faults: (a) the move back landed and its answer was lost; (b) it landed and the answer was a conflict that may follow
 * its own landing; (c) it never landed.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
type Kind = 'memory' | 'localfs';

describe.each<Kind>(['memory', 'localfs'])(
  'the rollback undo whose answer was lost (%s)',
  (kind) => {
    let dir: string | undefined;
    beforeEach(async () => {
      dir = kind === 'localfs' ? await mkdtemp(join(tmpdir(), 'cbm-undolost-')) : undefined;
    });
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    /** A segment of three generations; the first move of a rollback removes generation 0, then the undo is faulted. */
    async function run(fault: Fault) {
      const storage: IStorageDriver =
        dir === undefined ? new MemoryStorageDriver() : new LocalFsStorageDriver(dir);
      const raw: IRegistryDriver =
        dir === undefined ? new MemoryRegistryDriver() : new LocalFsRegistryDriver(dir);
      const faulty = faultyRegistry(raw);
      let swaps = 0;
      let watching = false;
      const registry = new Proxy(faulty, {
        get: (target, prop) => {
          if (prop !== 'compareAndSwap') {
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          }
          return async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
            const res = await faulty.compareAndSwap(...args);
            if (watching) swaps += 1;
            if (swaps === 1) {
              await storage.delete({ ...SEG, generation: 0 });
              faulty.arm('compareAndSwap', fault);
            }
            return res;
          };
        },
      }) as IRegistryDriver;
      const waits = recordedWaits();
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        retry: false,
        seams: { clock: waits.clock, rng: waits.rng },
      });
      for (const ids of [[1], [2], [3]]) await store.load(SEG, ids, { keep: 9 });
      swaps = 0;
      watching = true;
      const err = await store.rollback(SEG, 0).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { err, row: (await raw.get(SEG))! };
    }

    it.each(['a', 'b'] as const)('reports the pointer as put back (%s)', async (fault) => {
      const { err, row } = await run(fault);

      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toMatch(
        /was collected while the pointer was moving — the pointer was put back/,
      );
      expect(row.currentGen).toBe(2);
    });

    it('still says the pointer may be on the target when the move back never landed (c)', async () => {
      const { err, row } = await run('c');

      expect(err).toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(TransientError);
      expect((err as Error).message).toMatch(/the pointer may still name 0/);
      expect(row.currentGen).toBe(0);
    });
  },
);
