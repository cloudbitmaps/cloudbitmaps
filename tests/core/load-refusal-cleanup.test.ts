import { loadSegment } from '@/core/load';
import { roaringCodec } from '@/roaring-codec';
import { RecordingAuditSink, TransientError } from '@/index';
import type { IStorageDriver, SegmentRef } from '@/index';
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
