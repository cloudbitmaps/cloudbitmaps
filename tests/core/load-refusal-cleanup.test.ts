import { loadSegment } from '@/core/load';
import { KeyUnavailableError, ValidationError } from '@/core/errors';
import { roaringCodec } from '@/roaring-codec';
import { RecordingAuditSink, TransientError } from '@/index';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

/**
 * A refused load deletes the object it wrote, best-effort: a fault in that cleanup must not replace the refusal, which
 * is an answer and not an error, nor drop its audit event. The object it leaves is above the pointer, where the next
 * load that numbers past it collects it.
 */
const REF: SegmentRef = { segment: 's' };

function deletesFail(real: MemoryStorageDriver): IStorageDriver {
  return {
    capabilities: () => real.capabilities(),
    getTail: (k, m) => real.getTail(k, m),
    getRange: (k, o, l) => real.getRange(k, o, l),
    list: (r) => real.list(r),
    putImmutable: (k, fn) => real.putImmutable(k, fn),
    delete: () => Promise.reject(new TransientError('storage unavailable')),
  };
}

describe('a refused load whose cleanup fails is still a refusal', () => {
  it('a guard refusal is returned and audited when the delete of its object fails', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await loadSegment(
      REF,
      Array.from({ length: 10 }, (_, i) => i + 1),
      {
        storage,
        registry,
        codec: roaringCodec,
      },
    );
    const audit = new RecordingAuditSink();
    const res = await loadSegment(
      REF,
      [1],
      { storage: deletesFail(storage), registry, codec: roaringCodec },
      { guard: { minRetained: 0.5 }, audit },
    );
    expect(res).toMatchObject({ published: false, reason: 'min-retained' });
    expect(audit.snapshot().map((e) => e.kind)).toContain('segment.load-refused');
    expect((await registry.get(REF))!.currentGen).toBe(0);
  });
});

describe('a refusal the publish raises as an error', () => {
  // A publish states three refusals by throwing, each before that attempt's write is sent, and a registry raises
  // `ValidationError` only from checks it makes before sending a write. The load treats both classes as a definite
  // refusal: it reclaims its object as any refused load does, and rethrows. Anything else may still land, so the object
  // stays. A segment with no row: the reclaim finds none, and deletes the object its footer proves the load's own.
  const objects = async (storage: IStorageDriver): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of storage.list(REF)) out.push(k.generation);
    return out;
  };
  const createThrows = (registry: MemoryRegistryDriver, err: Error): IRegistryDriver => {
    const stub = Object.create(registry) as IRegistryDriver;
    stub.create = () => Promise.reject(err);
    return stub;
  };

  it.each<[string, Error]>([
    ['ValidationError', new ValidationError('the row is over the registry size cap')],
    ['KeyUnavailableError', new KeyUnavailableError('the key cannot be unwrapped')],
  ])(
    'a %s from the registry is rethrown, nothing is published, and the object is reclaimed',
    async (_, err) => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const audit = new RecordingAuditSink();
      await expect(
        loadSegment(
          REF,
          [1, 2, 3],
          { storage, registry: createThrows(registry, err), codec: roaringCodec },
          { allowEmpty: true, audit },
        ),
      ).rejects.toBe(err);
      expect(await registry.get(REF)).toBeNull();
      expect(await objects(storage)).toEqual([]);
      expect(audit.snapshot().map((e) => e.kind)).not.toContain('segment.publish');
    },
  );

  it('a fault that is not a refusal is rethrown and keeps the object', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const err = new Error('socket hang up');
    await expect(
      loadSegment(
        REF,
        [1, 2, 3],
        { storage, registry: createThrows(registry, err), codec: roaringCodec },
        { allowEmpty: true },
      ),
    ).rejects.toBe(err);
    expect(await registry.get(REF)).toBeNull();
    expect(await objects(storage)).toEqual([0]);
  });
});
