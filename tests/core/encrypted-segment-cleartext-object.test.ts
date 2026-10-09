import { randomBytes } from 'node:crypto';
import { CloudRoaring, CrbmStorageChunkSource } from '@/index';
import { rollbackSegment } from '@/core/rollback';
import { BufferSink } from '@/core/blob';
import { CrbmWriter } from '@/core/crbm/writer';
import { nextGeneration } from '@/core/generation-gc';
import { holdsObject } from '@/core/crbm-storage-source';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferReader } from '@/core/blob';
import { IntegrityError, NotFoundError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { publishGeneration } from '@/core/crbm-storage-source';
import { roaringCodec } from '@/roaring-codec';
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
  it('is still named by its footer alone: the refusal is at open, and the footer reads take no key', async () => {
    // What tells a writer its own object from another, and a pin its object from a replacement, reads the footer
    // with no key, so it answers for a cleartext object under a key exactly as for any other.
    const { storage, load } = world();
    await load([7, 8]);
    const key = { ...SEG, generation: 5 };
    await putCleartext(storage, key);
    const { size } = await storage.getTail(key, 1);
    const bytes = await storage.getRange(key, 0, size);
    const fingerprint = (await CrbmReader.open(new BufferReader(bytes))).fingerprint;
    expect(await CrbmReader.sameObject(new BufferReader(bytes), fingerprint)).toBe(true);
    expect(await holdsObject(storage, key, fingerprint)).toBe(true);
    expect(await holdsObject(storage, key, `${size}:1`)).toBe(false);
  });

  it('a forgery in place of the current generation is refused by every read of the object', async () => {
    const { storage, store, load } = world();
    const generation = await load([1, 2, 3]);
    expect(await store().segment('s').count()).toBe(3);
    await storage.delete({ ...SEG, generation });
    await putCleartext(storage, { ...SEG, generation });
    const seg = store().segment('s');
    // A cold count is the row's word and does not open the object, so it still says 3; every read of the object
    // is refused: it is not the object the row's summary names, which its footer says before any key is used.
    expect(await seg.count()).toBe(3);
    await expect(seg.has(1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(seg.has(1)).rejects.toThrow(
      new RegExp(`generation ${generation} is another object than its registry row names`),
    );
    await expect(seg.pin()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a forgery in place of the current generation of a row with no summary is refused as cleartext under a key', async () => {
    const { storage, registry, store, load } = world();
    const generation = await load([1, 2, 3]);
    const row = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, row.token, { summary: undefined });
    await storage.delete({ ...SEG, generation });
    await putCleartext(storage, { ...SEG, generation });
    const seg = store().segment('s');
    await expect(seg.has(1)).rejects.toThrow(
      new RegExp(`generation ${generation} is not encrypted, but it was opened with a key`),
    );
    await expect(seg.pin()).rejects.toBeInstanceOf(IntegrityError);
  });

  it("a cleartext load racing the segment's first keyed load is refused at its publish, so reads go on", async () => {
    // An unguarded load with no keystore reads "no row", writes its cleartext object, and only then does the other
    // writer's keyed first load publish, creating the row with its key. The cleartext publish onto that row is the
    // one way a cleartext generation could become current under a key. The load found no row and fences on that
    // absence, so the row that appeared refuses it before its compare-and-swap, and the refusal deletes its cleartext
    // object, which its footer proves its own: a cleartext object has no place in an encrypted segment's bucket.
    const { storage, registry } = world();
    const keystore = new InProcessKeystore({ keys: { k2: randomBytes(32) }, activeKeyId: 'k2' });
    const keyed = await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7, 8], {
      registry,
      keystore,
      publish: false,
    });
    const racing = new Proxy(storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'putImmutable') return value;
        return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
          const out = await storage.putImmutable(...args);
          await publishGeneration(
            registry,
            { ...SEG, generation: 0 },
            { wrappedDeks: keyed.wrappedDeks },
          );
          return out;
        };
      },
    });
    expect(
      await loadSegment(
        SEG,
        [1, 2, 3],
        { storage: racing, registry, codec: roaringCodec },
        { allowEmpty: true },
      ),
    ).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    const row = (await registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(row.wrappedDeks?.length).toBeGreaterThan(0);
    const left: number[] = [];
    for await (const k of storage.list(SEG)) left.push(k.generation);
    expect(left).toEqual([0]);
    // The segment reads as the keyed load wrote it: no cleartext generation became current.
    const reader = new CloudRoaring({
      storage: new CrbmStorageChunkSource(storage, { registry, keystore }),
      retry: false,
      cache: { genTtlMs: 0 },
    });
    expect(await reader.segment('s').count()).toBe(2);
  });

  it('a rollback onto a cleartext write from before the key was made is refused, and reads go on', async () => {
    const { storage, registry, store, load } = world();
    // A cleartext write that never published (a crash between the write and the publish), then the first
    // encrypted load, which numbers above it and makes the segment's key.
    await putCleartext(storage, { ...SEG, generation: 0 });
    const encrypted = await load([7, 8]);
    expect(encrypted).toBe(1);
    await expect(rollbackSegment(SEG, 0, { storage, registry })).rejects.toThrow(
      /generation 0 of "s" is cleartext, but the segment is encrypted/,
    );
    expect(await store().segment('s').count()).toBe(2);
  });
});
