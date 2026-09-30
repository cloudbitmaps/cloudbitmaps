import {
  CrbmStorageChunkSource,
  IntegrityError,
  MemoryStorage,
  NotFoundError,
  TransientError,
  type Clock,
  type IRegistryDriver,
  type SegmentRef,
} from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * The reader cache re-reads a segment's pointer once `cache.genTtlMs` has passed. A refresh that cannot read the
 * registry because of a transient fault keeps serving the generation the reader holds and asks again soon; any other
 * failure reaches the reader, so a reader (and the key it unwrapped) is not trusted past a refresh that failed.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 'seg' };
const TTL = 2000;

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

/** A registry whose `get` counts its calls and fails with `fault` while one is set. */
function faultyRegistry(inner: IRegistryDriver): IRegistryDriver & {
  gets: number;
  fault: Error | undefined;
} {
  const wrapper = {
    gets: 0,
    fault: undefined as Error | undefined,
    get(ref: SegmentRef) {
      wrapper.gets += 1;
      return wrapper.fault === undefined ? inner.get(ref) : Promise.reject(wrapper.fault);
    },
  };
  return new Proxy(inner, {
    get: (t, prop, receiver) =>
      prop in wrapper ? Reflect.get(wrapper, prop) : (Reflect.get(t, prop, receiver) as unknown),
    set: (_t, prop, value) => Reflect.set(wrapper, prop, value),
  }) as IRegistryDriver & { gets: number; fault: Error | undefined };
}

async function setup() {
  const backend = new MemoryStorage();
  const { storage } = backend;
  const inner = backend.registry;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry: inner });
  const registry = faultyRegistry(inner);
  const clock = fakeClock();
  const source = new CrbmStorageChunkSource(storage, {
    registry,
    clock,
    currentGenTtlMs: TTL,
  });
  return { storage, inner, registry, clock, source };
}

describe('a pointer refresh that fails', () => {
  it('serves the reader it holds on a transient fault, and asks again after the short backoff, not a TTL', async () => {
    const { registry, clock, source } = await setup();
    expect(await source.currentGeneration(REF)).toBe(0);
    expect(registry.gets).toBe(1);

    registry.fault = new TransientError('registry unavailable');
    clock.advance(TTL);
    expect(await source.currentGeneration(REF)).toBe(0); // refresh failed: still serving
    expect(registry.gets).toBe(2);

    clock.advance(499);
    expect(await source.currentGeneration(REF)).toBe(0);
    expect(registry.gets).toBe(2); // inside the backoff: no registry call at all

    clock.advance(1);
    expect(await source.currentGeneration(REF)).toBe(0);
    expect(registry.gets).toBe(3); // the retry came at 500 ms, well before another 2 s
    clock.advance(499);
    await source.currentGeneration(REF);
    expect(registry.gets).toBe(3);
  });

  it('installs the new generation once the registry answers again', async () => {
    const { storage, inner, registry, clock, source } = await setup();
    expect(await source.currentGeneration(REF)).toBe(0);

    registry.fault = new TransientError('registry unavailable');
    clock.advance(TTL);
    expect(await source.currentGeneration(REF)).toBe(0);

    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, [1, 2, 3, 4], {
      registry: inner,
    });
    registry.fault = undefined;
    clock.advance(500);
    expect(await source.currentGeneration(REF)).toBe(1);
    expect(await source.listChunkKeys(REF)).toEqual([0]);
    const gets = registry.gets;
    clock.advance(TTL - 1);
    await source.currentGeneration(REF);
    expect(registry.gets).toBe(gets); // back to one read per TTL
  });

  it.each([
    ['an integrity error', () => new IntegrityError('corrupt row')],
    [
      'a permission error',
      () => Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }),
    ],
    ['a NotFoundError', () => new NotFoundError('row')],
  ])('throws %s to the reader, and the next read resolves afresh', async (_name, make) => {
    const { registry, clock, source } = await setup();
    expect(await source.currentGeneration(REF)).toBe(0);

    registry.fault = make();
    clock.advance(TTL);
    await expect(source.getChunk({ ...REF, chunkKey: 0 })).rejects.toBe(registry.fault);

    registry.fault = undefined;
    expect(await source.currentGeneration(REF)).toBe(0); // no snapshot was kept for the failed refresh
  });

  it('keeps the existing meaning of a row that is gone: the segment reads empty', async () => {
    const { inner, clock, source } = await setup();
    expect(await source.currentGeneration(REF)).toBe(0);

    await inner.delete(REF); // dropped
    clock.advance(TTL);
    expect(await source.currentGeneration(REF)).toBeNull();
    expect(await source.getChunk({ ...REF, chunkKey: 0 })).toBeNull();
  });

  it('keeps the existing meaning of a shredded row: the segment reads empty', async () => {
    const { inner, clock, source } = await setup();
    expect(await source.currentGeneration(REF)).toBe(0);

    const row = (await inner.get(REF))!;
    await inner.compareAndSwap(REF, row.token, { status: 'destroyed' });
    clock.advance(TTL);
    expect(await source.listChunkKeys(REF)).toEqual([]);
  });

  it('adds no registry call to a read inside the TTL, before or after a failed refresh', async () => {
    const { registry, clock, source } = await setup();
    await source.currentGeneration(REF);
    const base = registry.gets;
    for (let i = 0; i < 50; i++) {
      await source.getChunk({ ...REF, chunkKey: 0 });
      await source.currentVersion(REF);
    }
    expect(registry.gets).toBe(base);

    registry.fault = new TransientError('registry unavailable');
    clock.advance(TTL);
    await source.currentGeneration(REF);
    const afterFail = registry.gets;
    for (let i = 0; i < 50; i++) await source.getChunk({ ...REF, chunkKey: 0 });
    expect(registry.gets).toBe(afterFail);
  });

  it('coalesces concurrent readers onto one retry', async () => {
    const { registry, clock, source } = await setup();
    await source.currentGeneration(REF);
    registry.fault = new TransientError('registry unavailable');
    clock.advance(TTL);
    await source.currentGeneration(REF);
    clock.advance(500);
    const before = registry.gets;
    await Promise.all(Array.from({ length: 20 }, () => source.currentGeneration(REF)));
    expect(registry.gets).toBe(before + 1);
  });
});
