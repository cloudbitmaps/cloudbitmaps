import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IRegistryDriver, IStorageDriver, RegistryPatch } from '@cloudbitmaps/core/driver-kit';
import { roaringCodec } from '@/roaring-codec';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';
import { testEntropy } from '../helpers/entropy';

/**
 * The read that proves an object is the one a writer wrote is not an answer when it faults: a timeout, a throttle or a
 * server error does not say the object is another's. A refused erasure's discard of its own object above the winner's
 * pointer retries that read under the store's read retry and, when it still fails, throws it, so the operator knows the
 * object may remain; a refused load's reclaim is best-effort and keeps its object, as it does for every fault (its
 * test pins that behaviour and does not reproduce a bug).
 */

const NO_WAIT = { clock, rng: { next: () => 0 } };

/** How a footer read goes wrong: it throws, comes back corrupt, or comes back as another object's footer. */
type Fault = Error | 'corrupt' | 'other-object';

/** `storage`, whose footer reads of generation `gen` go wrong `times` times once `armed()` is true. */
function faultingFooter(
  storage: IStorageDriver,
  gen: number,
  times: number,
  armed: () => boolean,
  fault: Fault = new TransientError('the footer read timed out'),
): { storage: IStorageDriver; faults: () => number } {
  const out = Object.create(storage) as IStorageDriver;
  let faults = 0;
  out.getTail = async (key, maxBytes) => {
    if (!(armed() && key.generation === gen && maxBytes > 0 && faults < times)) {
      return storage.getTail(key, maxBytes);
    }
    faults += 1;
    if (fault === 'other-object') return storage.getTail({ ...key, generation: 1 }, maxBytes);
    if (fault !== 'corrupt') throw fault;
    const tail = await storage.getTail(key, maxBytes);
    const bytes = new Uint8Array(tail.bytes);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    return { ...tail, bytes };
  };
  return { storage: out, faults: () => faults };
}

/** A refused erasure of X (its rewrite is generation 2, the first load published 1): its discard's footer read faults. */
async function refusedErasure(times: number, readRetry: typeof NO_WAIT | undefined, fault?: Fault) {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec, clock };
  await loadSegment(REF, [1, 2, X], deps);
  const l1AtPublish = gate();
  const l1Registry = Object.create(registry) as IRegistryDriver;
  l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
    if ('currentGen' in patch && patch.currentGen === 1) {
      l1AtPublish.reach();
      await l1AtPublish.opened;
    }
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  const l1 = loadSegment(REF, [5, 6], { ...deps, registry: l1Registry });
  await l1AtPublish.reached;
  let refused = false;
  const isRewritePublish = (patch: RegistryPatch): boolean =>
    'currentGen' in patch && patch.currentGen === 2;
  const erasureRegistry = Object.create(registry) as IRegistryDriver;
  erasureRegistry.compareAndSwap = async (ref, expected, patch, options) => {
    if (!refused && isRewritePublish(patch)) {
      refused = true;
      l1AtPublish.open();
      await l1;
    }
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  const faulty = faultingFooter(storage, 2, times, () => refused, fault);
  const erasure = eraseIdFromSegment(REF, X, {
    ...deps,
    storage: faulty.storage,
    registry: erasureRegistry,
    ...(readRetry === undefined ? {} : { readRetry }),
  });
  return { erasure, storage, registry, faults: faulty.faults };
}

describe('a refused erasure whose proving read of its own object faults', () => {
  it('a transient fault is retried under the read retry, and the proven object is then deleted', async () => {
    const run = await refusedErasure(2, NO_WAIT);
    await expect(run.erasure).resolves.toMatchObject({ erased: false });
    expect(run.faults()).toBe(2);
    expect(await generations(run.storage)).toEqual([0, 1]);
  });

  it('a fault that outlasts the retry is thrown, and the object is kept', async () => {
    const run = await refusedErasure(Infinity, NO_WAIT);
    await expect(run.erasure).rejects.toBeInstanceOf(TransientError);
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
    expect((await run.registry.get(REF))?.currentGen).toBe(1);
  });

  it('with no read retry, one fault is thrown and not read as "not this object"', async () => {
    const run = await refusedErasure(1, undefined);
    await expect(run.erasure).rejects.toBeInstanceOf(TransientError);
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
  });
});

describe('a refused erasure whose proving read does not prove the object', () => {
  it('a permanent fault is thrown at once, not retried, and the object is kept', async () => {
    const run = await refusedErasure(Infinity, NO_WAIT, new Error('access denied'));
    await expect(run.erasure).rejects.toThrow('access denied');
    expect(run.faults()).toBe(1);
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
  });

  it('a footer that fails its checks once is read again, and the proven object is then deleted', async () => {
    const run = await refusedErasure(1, NO_WAIT, 'corrupt');
    await expect(run.erasure).resolves.toMatchObject({ erased: false });
    expect(run.faults()).toBe(1);
    expect(await generations(run.storage)).toEqual([0, 1]);
  });

  it('a footer that keeps failing its checks is not proven: the refusal is reported and the object kept', async () => {
    const run = await refusedErasure(Infinity, NO_WAIT, 'corrupt');
    await expect(run.erasure).resolves.toMatchObject({ erased: false, reason: 'superseded' });
    expect(run.faults()).toBeGreaterThan(1);
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
  });

  it('with no read retry, a footer that fails its checks is not proven at once', async () => {
    const run = await refusedErasure(Infinity, undefined, 'corrupt');
    await expect(run.erasure).resolves.toMatchObject({ erased: false, reason: 'superseded' });
    expect(run.faults()).toBe(1);
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
  });

  it.each<[string, Fault]>([
    ['is gone', new NotFoundError('no such object')],
    ['is another object', 'other-object'],
  ])('an object that %s is kept without an error', async (_name, fault) => {
    const run = await refusedErasure(Infinity, NO_WAIT, fault);
    await expect(run.erasure).resolves.toMatchObject({ erased: false, reason: 'superseded' });
    expect(await generations(run.storage)).toEqual([0, 1, 2]);
  });
});

describe('a refused load whose proving read of its own object faults', () => {
  it.each<[string, Error]>([
    ['transient', new TransientError('timed out')],
    ['permanent', new Error('access denied')],
  ])(
    'a %s fault: still refused, not failed, and the object is kept for a later collection',
    async (_kind, fault) => {
      const storage = new MemoryStorageDriver();
      const registry: IRegistryDriver = new MemoryRegistryDriver();
      const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec, clock };
      // A load that read no row publishes on that absence; a row created under it refuses the publish and, being
      // another writer's, leaves the object for collection without a proof. Deleting the row it read after its object is
      // written leaves the refusal reading an absent row, which is the one place the load proves its object.
      await loadSegment(REF, [1], deps);
      const written = gate();
      const armed = { on: false };
      const faulty = faultingFooter(storage, 1, Infinity, () => armed.on, fault);
      const loadRegistry = Object.create(registry) as IRegistryDriver;
      loadRegistry.compareAndSwap = async (ref, expected, patch, options) => {
        if ('currentGen' in patch && patch.currentGen === 1) {
          written.reach();
          await written.opened;
        }
        return registry.compareAndSwap(ref, expected, patch, options);
      };
      const load = loadSegment(REF, [2], {
        ...deps,
        storage: faulty.storage,
        registry: loadRegistry,
      });
      await written.reached;
      await registry.delete(REF);
      armed.on = true;
      written.open();
      await expect(load).resolves.toMatchObject({ published: false });
      expect(faulty.faults()).toBeGreaterThan(0);
      expect(await generations(storage)).toEqual([0, 1]);
    },
  );
});
