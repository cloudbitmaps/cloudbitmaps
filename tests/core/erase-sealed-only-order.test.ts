import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import type { SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

const REF: SegmentRef = { segment: 's' };
const X = 9;

describe('an erasure that deletes only objects it cannot search, on a segment with a generation', () => {
  it('reports them ascending, in the result and in a segment.collect that names no generation', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { storage, registry, codec: roaringCodec, keystore };
    await loadSegment(REF, [1], deps); // generation 0, current, under the row's key
    for (const generation of [1, 2]) {
      // Above the pointer, each sealed under a key of its own, which the row does not hold.
      await bulkLoadCrbmGeneration(storage, { ...REF, generation }, [1, X], {
        registry: new MemoryRegistryDriver(),
        keystore,
        publish: false,
      });
    }
    const audit = new RecordingAuditSink();
    const out = await eraseIdFromSegment(REF, X, deps, { audit });
    expect(out).toMatchObject({ erased: false, reason: 'not-member', collected: [1, 2] });
    const events = audit.snapshot();
    expect(events).toEqual([
      expect.objectContaining({ kind: 'segment.collect', collected: [1, 2] }),
    ]);
    expect(events[0]).not.toHaveProperty('fromGeneration');
  });
});
