import { brandAsBackend } from '@/core/ports';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { IntegrityError, TransientError } from '@/core/errors';
import { DEFAULT_RETRY_POLICY } from '@/core/retry';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * The reads a write makes along the way are retried as the store's own reads are.
 *
 * A load's guard reads the current generation's index, and an erasure reads the generation it rewrites, reads every
 * chunk of it as it streams the new one, reads back the generation it wrote to verify it, and reads any retained
 * generation that may still hold the id. Each is a read, safe to repeat, so one transient fault there is run again
 * under the store's retry rather than failing the whole call. The write itself is still sent once. What retrying
 * cannot fix is not retried.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type ReadOp = 'getRange' | 'getTail';

interface Fault {
  readonly op: ReadOp;
  readonly generation: number;
  /** Which read of that kind, on that generation, fails: 1 is the first. */
  readonly nth: number;
  readonly error: () => Error;
}

/** The driver under a backend, with one read armed to fail; every read is counted by kind and generation. */
function flakyReads(inner: IStorageDriver): {
  storage: IStorageDriver;
  arm: (fault: Fault) => void;
  reads: (op: ReadOp, generation: number) => number;
  fired: () => boolean;
} {
  const seen = new Map<string, number>();
  let fault: Fault | undefined;
  let fired = false;
  const count = (op: ReadOp, key: GenKey): number => {
    const k = `${op}:${key.generation}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n;
  };
  const maybeFail = (op: ReadOp, key: GenKey): void => {
    const n = count(op, key);
    if (
      fault !== undefined &&
      fault.op === op &&
      fault.generation === key.generation &&
      fault.nth === n
    ) {
      fired = true;
      throw fault.error();
    }
  };
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'getRange') {
        return async (key: GenKey, offset: number, length: number) => {
          maybeFail('getRange', key);
          return target.getRange(key, offset, length);
        };
      }
      if (prop === 'getTail') {
        return async (key: GenKey, maxBytes: number) => {
          maybeFail('getTail', key);
          return target.getTail(key, maxBytes);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return {
    storage,
    arm: (f) => {
      fault = f;
      seen.clear();
      fired = false;
    },
    reads: (op, generation) => seen.get(`${op}:${generation}`) ?? 0,
    fired: () => fired,
  };
}

/** A store over `MemoryStorage` whose storage half fails the armed read; the registry is the real one. */
async function world(
  ids: readonly number[],
  options: { retry?: false } = {},
): Promise<{
  backend: MemoryStorage;
  flaky: ReturnType<typeof flakyReads>;
  store: CloudRoaring;
}> {
  const backend = new MemoryStorage();
  await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, ids, {
    registry: backend.registry,
  });
  const flaky = flakyReads(backend.storage);
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: flaky.storage, registry: backend.registry }),
    cache: { genTtlMs: 0 },
    ...(options.retry === false ? { retry: false as const } : {}),
  });
  return { backend, flaky, store };
}

const transient = (): Error => new TransientError('injected transient read fault');
const corrupt = (): Error => new IntegrityError('injected integrity fault');

/** The core deps the store would hand a write, over the flaky driver, with or without the store's read retry. */
function coreDeps(w: Awaited<ReturnType<typeof world>>, retried: boolean) {
  return {
    storage: w.flaky.storage,
    registry: w.backend.registry,
    codec: roaringCodec,
    ...(retried
      ? {
          readRetry: {
            policy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: 0 },
            clock: { now: () => 0, sleep: async () => {} },
            rng: { next: () => 0 },
          },
        }
      : {}),
  };
}

describe("a load's guard read is retried", () => {
  it('one transient fault on the read of the current generation: the load publishes', async () => {
    const w = await world([1, 2, 3]);
    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: transient });

    const res = await w.store.load(SEG, [1, 2, 3, 4], { guard: { minRetained: 0.5 } });

    expect(res.published).toBe(true);
    expect(w.flaky.fired()).toBe(true);
    expect(w.flaky.reads('getTail', 0)).toBe(2); // the faulted read, then its retry
  });

  it('with the store retry off, the same fault reaches the caller', async () => {
    const w = await world([1, 2, 3], { retry: false });
    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: transient });

    await expect(
      w.store.load(SEG, [1, 2, 3, 4], { guard: { minRetained: 0.5 } }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(w.flaky.reads('getTail', 0)).toBe(1);
  });

  it('a fault retrying cannot fix is not retried', async () => {
    const w = await world([1, 2, 3]);
    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: corrupt });

    await expect(
      w.store.load(SEG, [1, 2, 3, 4], { guard: { minRetained: 0.5 } }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(w.flaky.reads('getTail', 0)).toBe(1);
  });

  it('in core: loadSegment retries it under the readRetry it is given, and not without one', async () => {
    const w = await world([1, 2, 3]);
    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: transient });
    const guard = { guard: { minRetained: 0.5 } };
    await expect(loadSegment(SEG, [1, 2, 3, 4], coreDeps(w, false), guard)).rejects.toBeInstanceOf(
      TransientError,
    );

    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: transient });
    const res = await loadSegment(SEG, [1, 2, 3, 4], coreDeps(w, true), guard);
    expect(res.published).toBe(true);
    expect(w.flaky.reads('getTail', 0)).toBe(2);
  });
});

describe("an erasure's reads are retried", () => {
  // Generation 0 holds chunks 0 and 3; the id 2 is in chunk 0, so the rewrite reads chunk 0 first (the chunk it
  // edits) and chunk 3 second (carried through), then writes generation 1 and reads it back to verify it.
  const IDS = [1, 2, 3, 200_000];

  // `total` is the reads of that kind on that generation the erasure makes with the fault: one more than without it.
  it.each([
    ['the open of the generation it rewrites', { op: 'getTail', generation: 0, nth: 1, total: 2 }],
    ['the read of the chunk it edits', { op: 'getRange', generation: 0, nth: 1, total: 3 }],
    ['a chunk it carries through', { op: 'getRange', generation: 0, nth: 2, total: 3 }],
    [
      'the read-back that verifies the generation it wrote',
      { op: 'getTail', generation: 1, nth: 1, total: 2 },
    ],
  ] as const)('one transient fault on %s: the erasure completes', async (_, at) => {
    const w = await world(IDS);
    w.flaky.arm({ ...at, error: transient });

    const ledger = await w.store.eraseSubject(2, { namespace: 'ns' });

    expect(w.flaky.fired()).toBe(true);
    expect(w.flaky.reads(at.op, at.generation)).toBe(at.total);
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({ segment: 's', erased: true, fromGeneration: 0, generation: 1 }),
    ]);
    expect(
      await new CloudRoaring({ storage: w.backend }).segment('s', { namespace: 'ns' }).has(2),
    ).toBe(false);
  });

  it('one transient fault on the read of a retained generation that still holds the id: it is erased', async () => {
    // A re-seed without the id leaves it in the generation the load retains (keep: 1), so the erasure reads that
    // one too, and deletes it.
    const w = await world(IDS);
    await w.store.load(SEG, [1, 3, 200_000]);
    w.flaky.arm({ op: 'getTail', generation: 0, nth: 1, error: transient });

    const ledger = await w.store.eraseSubject(2, { namespace: 'ns' });

    expect(w.flaky.fired()).toBe(true);
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({ segment: 's', erased: true, fromGeneration: 0 }),
    ]);
  });

  it('in core: eraseIdFromSegment retries under the readRetry it is given, and not without one', async () => {
    const w = await world(IDS);
    w.flaky.arm({ op: 'getRange', generation: 0, nth: 2, error: transient });
    await expect(eraseIdFromSegment(SEG, 2, coreDeps(w, false))).rejects.toBeInstanceOf(
      TransientError,
    );

    const v = await world(IDS);
    v.flaky.arm({ op: 'getRange', generation: 0, nth: 2, error: transient });
    const res = await eraseIdFromSegment(SEG, 2, coreDeps(v, true));
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
  });

  it.each([
    ['the open of the generation it rewrites', { op: 'getTail', generation: 0, nth: 1 }],
    ['a chunk it carries through', { op: 'getRange', generation: 0, nth: 2 }],
    [
      'the read-back that verifies the generation it wrote',
      { op: 'getTail', generation: 1, nth: 1 },
    ],
  ] as const)('a fault retrying cannot fix, on %s, is not retried', async (_, at) => {
    const w = await world(IDS);
    w.flaky.arm({ ...at, error: corrupt });

    await expect(eraseIdFromSegment(SEG, 2, coreDeps(w, true))).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(w.flaky.reads(at.op, at.generation)).toBe(at.nth);
  });
});

/** A read of `generation` by `op` that fails transiently every time: one no retry can get past. */
function alwaysFailing(inner: IStorageDriver, at: { op: ReadOp; generation: number }) {
  const state = { calls: 0 };
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === at.op) {
        return async (key: GenKey, ...rest: number[]) => {
          if (key.generation === at.generation) {
            state.calls++;
            throw new TransientError('injected persistent read fault');
          }
          return (target[at.op] as (k: GenKey, ...r: number[]) => Promise<unknown>)(key, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { storage, state };
}

describe('when the read retry gives up', () => {
  it('a retained generation that still holds the id and cannot be read fails the erasure, never a clean ledger', async () => {
    // The erasure must prove every retained holder gone. A holder it cannot read is not gone: reporting it as such
    // would hand back a receipt while the id is still in the bucket.
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: backend.registry,
    });
    const failing = alwaysFailing(backend.storage, { op: 'getTail', generation: 0 });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: failing.storage, registry: backend.registry }),
      cache: { genTtlMs: 0 },
      retry: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    await new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } }).load(SEG, [1, 3]);

    const ledger = await store.eraseSubject(2, { namespace: 'ns' });

    expect(failing.state.calls).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({
        segment: 's',
        erased: false,
        note: expect.stringContaining('injected persistent read fault'),
      }),
    ]);
  });

  it("the read retry follows the store's own policy: its attempts and its onRetry", async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: backend.registry,
    });
    const failing = alwaysFailing(backend.storage, { op: 'getRange', generation: 0 });
    const retried: number[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: failing.storage, registry: backend.registry }),
      cache: { genTtlMs: 0 },
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        onRetry: ({ attempt }) => retried.push(attempt),
      },
    });

    const ledger = await store.eraseSubject(2, { namespace: 'ns' });

    expect(ledger.erasedFrom).toEqual([expect.objectContaining({ segment: 's', erased: false })]);
    expect(failing.state.calls).toBe(2);
    expect(retried).toEqual([1]);
  });
});

describe("an erasure's writes are not retried by the read retry", () => {
  type WriteOp = 'putImmutable' | 'delete' | 'compareAndSwap';

  /** The world's drivers with the first call of `op` failing transiently, and every call of each write counted. */
  function failingWrite(w: Awaited<ReturnType<typeof world>>, op: WriteOp) {
    const calls: Record<WriteOp, number> = { putImmutable: 0, delete: 0, compareAndSwap: 0 };
    const wrap = <T extends object>(inner: T, ops: readonly WriteOp[]): T =>
      new Proxy(inner, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function' || !ops.includes(prop as WriteOp)) return value;
          const name = prop as WriteOp;
          return async (...args: unknown[]) => {
            calls[name]++;
            if (name === op && calls[name] === 1)
              throw new TransientError(`injected ${name} fault`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    return {
      calls,
      storage: wrap(w.flaky.storage, ['putImmutable', 'delete']),
      registry: wrap(w.backend.registry, ['compareAndSwap']),
    };
  }

  it.each(['putImmutable', 'compareAndSwap'] as const)(
    'a transient fault on %s is sent as many times with the read retry as without it',
    async (op) => {
      const counts: number[] = [];
      for (const retried of [false, true]) {
        const w = await world([1, 2, 3, 200_000]);
        const f = failingWrite(w, op);
        const deps = { ...coreDeps(w, retried), storage: f.storage, registry: f.registry };
        await eraseIdFromSegment(SEG, 2, deps).catch(() => undefined);
        expect(f.calls[op]).toBeGreaterThan(0);
        counts.push(f.calls[op]);
      }
      expect(counts[1]).toBe(counts[0]);
    },
  );
});
