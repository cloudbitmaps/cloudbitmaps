import { WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { releaseLease, takeLease } from '@/core/leases';
import { clearSegmentRetention, setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import type { Clock } from '@/core/determinism';
import type { IRegistryDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { roaringCodec } from '@/native-codec';
import { testEntropy } from '../helpers/entropy';

/**
 * A contention error ends with what the caller does next, and a rollback that loses its race keeps the driver's error
 * as its cause. None of the messages carries a stored value.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const FAR = T0 * 2;
const NEXT_STEP =
  "another writer changed the segment's row while this call ran. Re-run the call: it reads the row afresh";

const clock: Clock = { now: () => T0, sleep: () => Promise.resolve() };

/** `registry`, with every compare-and-swap refused as another writer's would be, once `armed` is true. */
function conflicting(registry: IRegistryDriver, armed: () => boolean): IRegistryDriver {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (prop !== 'compareAndSwap') return fn;
      return (...a: unknown[]) => {
        if (armed()) return Promise.reject(new WriteConflictError('the driver lost the race'));
        return fn(...a);
      };
    },
  }) as IRegistryDriver;
}

async function loaded(count: number) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => T0 });
  for (let g = 0; g < count; g++) {
    await loadSegment(
      SEG,
      Array.from({ length: g + 3 }, (_, i) => i),
      { storage, registry, entropy: testEntropy, codec: roaringCodec, clock },
      { keep: 5 },
    );
  }
  return { storage, registry };
}

describe('the next step in a contention error', () => {
  it('a load that cannot move the pointer says to re-run it', async () => {
    const { storage, registry: base } = await loaded(1);
    const registry = conflicting(base, () => true);
    const err = await loadSegment(
      SEG,
      [1, 2, 3],
      { storage, registry, entropy: testEntropy, codec: roaringCodec, clock },
      { keep: 5 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toBe(
      `publishGeneration: contention setting currentGen for s; ${NEXT_STEP}`,
    );
  });

  it('setRetention and clearRetention say to re-run them', async () => {
    const { registry } = await loaded(1);
    await setSegmentRetention(SEG, { registry, clock }, { expiresAt: FAR });
    const racing = conflicting(registry, () => true);
    await expect(
      setSegmentRetention(SEG, { registry: racing, clock }, { expiresAt: FAR + 1 }),
    ).rejects.toThrow(
      `setRetention: contention writing the retention policy for segment "s"; ${NEXT_STEP}`,
    );
    await expect(clearSegmentRetention(SEG, { registry: racing, clock })).rejects.toThrow(
      `clearRetention: contention clearing the retention policy for segment "s"; ${NEXT_STEP}`,
    );
  });

  it('a lease that cannot be taken or released says to re-run the call', async () => {
    const { registry } = await loaded(1);
    const row = (await registry.get(SEG))!;
    const holder = '0000000000000007';
    const racing = conflicting(registry, () => true);
    await expect(
      takeLease(
        SEG,
        { registry: racing, clock },
        { holder, generation: row.currentGen as number, until: FAR, row, current: false },
      ),
    ).rejects.toThrow(`lease: contention taking a lease on segment "s"; ${NEXT_STEP}`);

    await takeLease(
      SEG,
      { registry, clock },
      { holder, generation: row.currentGen as number, until: FAR, row, current: false },
    );
    await expect(releaseLease(SEG, { registry: racing, clock }, holder)).rejects.toThrow(
      `lease: contention releasing a lease on segment "s"; ${NEXT_STEP}`,
    );
  });

  it("a rollback that loses its race says it could not confirm its swap is the row's, and keeps the driver error as its cause", async () => {
    const { storage, registry } = await loaded(3);
    const racing = conflicting(registry, () => true);
    const err = await rollbackSegment(SEG, 1, { storage, registry: racing, clock }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toBe(
      "rollback: the segment's row changed while the rollback ran, and this rollback could not confirm that its swap " +
        'is the one the row shows; check store.generations(ref) and run it again',
    );
    expect((err as Error).cause).toBeInstanceOf(WriteConflictError);
    expect(((err as Error).cause as Error).message).toBe('the driver lost the race');
    expect((await registry.get(SEG))!.currentGen).toBe(2);
  });
});
