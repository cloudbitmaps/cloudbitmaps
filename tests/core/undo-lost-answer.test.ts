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

    interface RunOptions {
      /** Reads that fail from the fault on (the read-back's reads). */
      readonly failReads?: number;
      /** Fault the move onto the target instead of the move back; the target then stays. */
      readonly onSwap?: boolean;
      /** A registry that reports no write tokens. */
      readonly noTokens?: boolean;
      /** Clear the pointer first, so the rollback starts from a row with no pointer. */
      readonly noPointer?: boolean;
    }

    /** A segment of three generations; the first move of a rollback removes generation 0, then the undo is faulted. */
    async function run(fault: Fault, opts: RunOptions = {}) {
      const storage: IStorageDriver =
        dir === undefined ? new MemoryStorageDriver() : new LocalFsStorageDriver(dir);
      const raw: IRegistryDriver =
        dir === undefined ? new MemoryRegistryDriver() : new LocalFsRegistryDriver(dir);
      const faulty = faultyRegistry(raw);
      let swaps = 0;
      let watching = false;
      const registry = new Proxy(faulty, {
        get: (target, prop) => {
          if (prop === 'reportsWriteTokens' && opts.noTokens === true) return false;
          if (prop !== 'compareAndSwap') {
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          }
          return async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
            if (watching && opts.onSwap === true && swaps === 0) {
              faulty.arm('compareAndSwap', fault);
              if (opts.failReads !== undefined) faulty.failReads(opts.failReads);
            }
            let res;
            try {
              res = await faulty.compareAndSwap(...args);
            } finally {
              if (watching) swaps += 1;
              if (swaps === 1 && opts.onSwap !== true) {
                await storage.delete({ ...SEG, generation: 0 });
                faulty.arm('compareAndSwap', fault);
                if (opts.failReads !== undefined) faulty.failReads(opts.failReads);
              }
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
      if (opts.noPointer === true) {
        const row = (await raw.get(SEG))!;
        await raw.compareAndSwap(SEG, row.token, { currentGen: null });
      }
      swaps = 0;
      watching = true;
      const slept = waits.sleeps.length;
      const result = await store
        .rollback(SEG, 0, opts.noPointer === true ? { allowUnknown: true } : {})
        .then(
          (r) => ({ err: undefined as unknown, r }),
          (e: unknown) => ({ err: e, r: undefined }),
        );
      return {
        err: result.err,
        result: result.r,
        sleeps: waits.sleeps.slice(slept),
        row: (await raw.get(SEG))!,
      };
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

    it('waits before it reads the row again when the first read of the move back fails (a)', async () => {
      const { err, row, sleeps } = await run('a', { failReads: 1 });

      expect((err as Error).message).toMatch(/the pointer was put back/);
      expect(sleeps).toHaveLength(1);
      expect(row.currentGen).toBe(2);
    });

    it('settles a landed swap whose answer was lost by a second read, after a wait', async () => {
      const { err, result, row, sleeps } = await run('a', { onSwap: true, failReads: 1 });

      expect(err).toBeUndefined();
      expect(result).toEqual({ fromGeneration: 2, generation: 0 });
      expect(sleeps).toHaveLength(1);
      expect(row.currentGen).toBe(0);
    });

    it('still says the pointer may be on the target when the read-back fails too (a)', async () => {
      const { err, row, sleeps } = await run('a', { failReads: 3 });

      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toMatch(/the pointer may still name 0/);
      expect(sleeps).toHaveLength(2);
      expect(row.currentGen).toBe(2);
    });

    it.each(['a', 'b'] as const)(
      'keeps "may still name" on a registry that reports no write tokens (%s)',
      async (fault) => {
        const { err, row } = await run(fault, { noTokens: true });

        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toMatch(/the pointer may still name 0/);
        expect(row.currentGen).toBe(2);
      },
    );

    it('settles a move back to no pointer by its token (a)', async () => {
      const { err, row } = await run('a', { noPointer: true });

      expect((err as Error).message).toMatch(/the pointer was put back/);
      expect(row.currentGen).toBeNull();
    });
  },
);
