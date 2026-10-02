import { randomBytes } from 'node:crypto';
import { CloudRoaring, CrbmStorageChunkSource } from '@/index';
import { rollbackSegment } from '@/core/rollback';
import { BufferSink } from '@/core/blob';
import { CrbmWriter } from '@/core/crbm/writer';
import { nextGeneration } from '@/core/generation-gc';
import { IntegrityError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { GenKey, IStorageDriver, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A segment whose row carries wrapped keys has been encrypted since its first published generation: a load picks the
 * posture once, and a publish never adds a key to a lineage that has generations. So a cleartext object under such a
 * segment's name was never one of its generations: a forgery, or a write from before the segment's key was made. A
 * read refuses it with `IntegrityError` rather than believe its index or its metadata, and never in silence.
 */
const SEG: SegmentRef = { segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const store = (): CloudRoaring =>
    new CloudRoaring({
      storage: new CrbmStorageChunkSource(storage, { registry, keystore, requireEncryption: true }),
      retry: false,
      cache: { genTtlMs: 0 },
    });
  const load = async (ids: number[]): Promise<number> => {
    const generation = await nextGeneration(SEG, { storage, registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, ids, { registry, keystore });
    return generation;
  };
  return { storage, registry, store, load };
}

/** A cleartext object, written with no key, whose index claims 65,536 ids and whose metadata names an owner. */
async function putCleartext(storage: IStorageDriver, key: GenKey): Promise<void> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, {
    generation: key.generation,
    metadata: { owner: 'attacker' },
  });
  await writer.addChunk(0, Uint8Array.of(1), 65_536);
  await writer.finish();
  await storage.putImmutable(key, async (out) => out.write(sink.bytes()));
}

describe('a cleartext object under an encrypted segment', () => {
  it('a forgery in place of the current generation is refused, not counted', async () => {
    const { storage, store, load } = world();
    const generation = await load([1, 2, 3]);
    expect(await store().segment('s').count()).toBe(3);
    await storage.delete({ ...SEG, generation });
    await putCleartext(storage, { ...SEG, generation });
    const seg = store().segment('s');
    await expect(seg.count()).rejects.toBeInstanceOf(IntegrityError);
    await expect(seg.has(1)).rejects.toThrow(/not encrypted, but it was opened with a key/);
    await expect(seg.pin()).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a rollback onto a cleartext write from before the key was made reads loudly refused, and rolling forward reads again', async () => {
    const { storage, registry, store, load } = world();
    // A cleartext write that never published (a crash between the write and the publish), then the first
    // encrypted load, which numbers above it and makes the segment's key.
    await putCleartext(storage, { ...SEG, generation: 0 });
    const encrypted = await load([7, 8]);
    expect(encrypted).toBe(1);
    await rollbackSegment(SEG, 0, { storage, registry });
    await expect(store().segment('s').count()).rejects.toThrow(
      /not encrypted, but it was opened with a key/,
    );
    await rollbackSegment(SEG, encrypted, { storage, registry }, { allowForward: true });
    expect(await store().segment('s').count()).toBe(2);
  });
});
