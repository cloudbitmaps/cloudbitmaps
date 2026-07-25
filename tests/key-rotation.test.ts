import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError } from '@/core/errors';
import type { CompactionDeps, IKeystore, SegmentRef } from '@/index';

/**
 * End-to-end KEK rotation (test-strategy T6).
 *
 * `tests/drivers/crypto.test.ts` proves KEK rotation at the keystore primitive (a DEK wrapped under the old
 * KEK still unwraps after `activeKeyId` moves). This proves the SAME rotation survives the whole stack —
 * registry `wrappedDeks`, the encrypted `.crbm` cold source, and a compaction re-encrypt — and that the
 * operator model holds: keep the old KEK to read old segments, and new segments adopt the new active KEK.
 */

const key = (): Uint8Array => randomBytes(32);
const OLD: SegmentRef = { segment: 'old' };
const FRESH: SegmentRef = { segment: 'fresh' };

async function members(store: CloudRoaring, seg: string): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(seg).iterate()) out.push(id);
  return out.sort((a, b) => a - b);
}

function storeWith(
  keystore: IKeystore,
  cold: MemoryColdDriver,
  warm: MemoryWarmDriver,
  registry: MemoryRegistryDriver,
): CloudRoaring {
  return new CloudRoaring({
    warm,
    cold: new CrbmColdChunkSource(cold, { registry, keystore }),
    retry: false,
  });
}

describe('KEK rotation — end to end (through registry, cold source, and compaction)', () => {
  it('rotates the active KEK without re-encrypting: old segments read under the retained old KEK, new segments adopt the new one', async () => {
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    const kekA = key();
    const kekB = key();

    // Before rotation: only KEK "A" exists; it is the active KEK. Seed an encrypted segment under it.
    const ksA = new InProcessKeystore({ keys: { A: kekA }, activeKeyId: 'A' });
    await bulkLoadCrbmGeneration(cold, { ...OLD, generation: 0 }, [1, 2, 3], {
      registry,
      keystore: ksA,
    });
    expect((await registry.get(OLD))!.wrappedDeks!.map((w) => w.keyId)).toEqual(['A']);

    // ── Rotate ── the operator adds KEK "B" and points `activeKeyId` at it, KEEPING "A" to unwrap existing DEKs.
    const ksB = new InProcessKeystore({ keys: { A: kekA, B: kekB }, activeKeyId: 'B' });
    // A fresh store per read: the cold source caches a generation snapshot for its TTL, so a read after a
    // compaction must be issued through a new store to observe the new generation (same pattern as the
    // encryption-lifecycle suite). Cheap — wiring only, no hot-path cost.
    const readB = (seg: string): Promise<number[]> =>
      members(storeWith(ksB, cold, warm, registry), seg);

    // 1. The old segment still reads — its DEK is wrapped under "A", which the rotated keystore retains.
    expect(await readB('old')).toEqual([1, 2, 3]);

    // 2. Mutating + compacting the old segment still works and does NOT re-wrap the DEK: compaction reuses the
    //    segment's existing DEK (still wrapped under "A" only), so no dependency on the new active KEK.
    await storeWith(ksB, cold, warm, registry).segment('old').add(4);
    const depsB: CompactionDeps = {
      cold,
      warm,
      registry,
      clock: { now: () => Date.now() },
      keystore: ksB,
    };
    expect(await compactSegment(OLD, depsB, { owner: 'rotator' })).toMatchObject({
      compacted: true,
    });
    expect((await registry.get(OLD))!.wrappedDeks!.map((w) => w.keyId)).toEqual(['A']);
    expect(await readB('old')).toEqual([1, 2, 3, 4]);

    // 3. A NEW segment created after rotation adopts the new active KEK "B".
    await bulkLoadCrbmGeneration(cold, { ...FRESH, generation: 0 }, [9], {
      registry,
      keystore: ksB,
    });
    expect((await registry.get(FRESH))!.wrappedDeks!.map((w) => w.keyId)).toEqual(['B']);
    expect(await readB('fresh')).toEqual([9]);

    // 4. Retiring KEK "A" (a keystore holding only "B") genuinely locks out the old segment — proof it was
    //    encrypted under "A", not merely tagged — while the new segment still reads.
    const ksBonly = new InProcessKeystore({ keys: { B: kekB }, activeKeyId: 'B' });
    const storeBonly = storeWith(ksBonly, cold, warm, registry);
    await expect(members(storeBonly, 'old')).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(await members(storeBonly, 'fresh')).toEqual([9]);
  });
});
