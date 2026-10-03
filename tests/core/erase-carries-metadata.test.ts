import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { Aead, CrbmCrypto } from '@/core/crypto';
import {
  openGenerationReader,
  verifyGeneration,
  writeCrbmGenerationStream,
} from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, RegistrySummary, SegmentRef } from '@/core/ports';
import { openSummary, sealSummary, summaryAgrees, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec, SafeBitmap } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * An erasure rewrites the current generation without one id, and the rewrite is the same generation in every way but
 * that: it carries the source's metadata into the new object as it is, and the row's summary of it, built from what was
 * written, counts one id fewer and holds the same metadata. The metadata is not scanned for the id.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const META: GenerationMetadata = { def: 'v7', landedAt: 1_790_000_000_000, owner: 'growth' };
const IDS = [1, 2, 3, 70_000, 200_000];

function world(keystore?: InProcessKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, keystore };
  return { storage, registry, deps, keystore };
}
type World = ReturnType<typeof world>;

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

async function aeadOf(w: World): Promise<Aead | undefined> {
  const row = (await w.registry.get(SEG))!;
  return row.wrappedDeks === undefined ? undefined : w.keystore!.openDek(row.wrappedDeks);
}

async function readerOf(w: World, generation: number) {
  const aead = await aeadOf(w);
  const crypto: CrbmCrypto | undefined =
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(SEG, generation, scope) };
  return openGenerationReader(w.storage, { ...SEG, generation }, crypto);
}

describe.each([
  ['cleartext', (): World => world()],
  ['encrypted', (): World => world(key())],
])('an erasure of a %s segment that carries metadata', (_name, make) => {
  it('writes the new object with the same metadata, and a row summary that counts one id fewer', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    const result = await eraseIdFromSegment(SEG, 70_000, w.deps);
    expect(result).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });

    const reader = await readerOf(w, 1);
    expect(reader.metadata).toEqual(META);
    expect(reader.count()).toBe(IDS.length - 1);

    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    const aead = await aeadOf(w);
    const described = usableSummary(SEG, row, aead);
    expect(described).toEqual({ cardinality: IDS.length - 1, metadata: META });
    expect(
      summaryAgrees(described!, { cardinality: reader.count(), metadata: reader.metadata }),
    ).toBe(true);
    if (aead === undefined) {
      expect(row.summary).toEqual({ generation: 1, cardinality: IDS.length - 1, metadata: META });
    } else {
      expect(openSummary(aead, SEG, row.summary as never)).toEqual(described);
    }
  });

  it('writes the metadata it had byte for byte: the same bytes as a load of the remaining ids with it', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    const { generation } = await eraseIdFromSegment(SEG, 2, w.deps);
    const rewritten = await readerOf(w, generation!);

    const fresh = make();
    await loadSegment(
      SEG,
      IDS.filter((id) => id !== 2),
      fresh.deps,
      { metadata: META },
    );
    const loaded = await readerOf(fresh, 0);
    expect(rewritten.metadata).toEqual(loaded.metadata);
    expect(rewritten.count()).toBe(loaded.count());
    // The two objects differ only by their generation's number and the keys of an encrypted one, so compare sizes.
    expect(rewritten.sizeBytes).toBe(loaded.sizeBytes);
  });

  it('carries it across a second erasure, and keeps counting', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    await eraseIdFromSegment(SEG, 1, w.deps);
    const second = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(second).toMatchObject({ erased: true, fromGeneration: 1, generation: 2 });
    const reader = await readerOf(w, 2);
    expect(reader.metadata).toEqual(META);
    const row = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, row, await aeadOf(w))).toEqual({
      cardinality: IDS.length - 2,
      metadata: META,
    });
  });

  it('writes a summary without metadata for a generation that had none', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps);
    await eraseIdFromSegment(SEG, 3, w.deps);
    const reader = await readerOf(w, 1);
    expect(reader.metadata).toBeUndefined();
    const row = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, row, await aeadOf(w))).toEqual({
      cardinality: IDS.length - 1,
      metadata: undefined,
    });
  });

  it('replaces a row summary that lies about the generation it rewrites, and does not fail', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    const aead = await aeadOf(w);
    const row = (await w.registry.get(SEG))!;
    // The row says a different count and different metadata than the object holds.
    const lie: RegistrySummary =
      aead === undefined
        ? { generation: 0, cardinality: 999, metadata: { def: 'lie' } }
        : sealSummary(aead, SEG, 0, 999, { def: 'lie' });
    await w.registry.compareAndSwap(SEG, row.token, { summary: lie });

    const result = await eraseIdFromSegment(SEG, 200_000, w.deps);
    expect(result).toMatchObject({ erased: true, generation: 1 });
    const after = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, after, aead)).toEqual({
      cardinality: IDS.length - 1,
      metadata: META,
    });
  });

  it('does not scan the metadata: an id in it is carried over like any other value', async () => {
    const w = make();
    await loadSegment(SEG, IDS, w.deps, { metadata: { subject: '70000' } });
    await eraseIdFromSegment(SEG, 70_000, w.deps);
    expect((await readerOf(w, 1)).metadata).toEqual({ subject: '70000' });
  });
});

/** Replace generation 0 with the same ids and no metadata block, under the same key and the same number. */
async function stripBlock(w: World): Promise<void> {
  await w.storage.delete({ ...SEG, generation: 0 });
  await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, IDS, {
    registry: w.registry,
    keystore: w.keystore,
    publish: false,
  });
  expect((await readerOf(w, 0)).metadata).toBeUndefined();
}

describe('an erasure over an object whose metadata block was stripped', () => {
  // Whoever can write the bucket replaces generation 0 with the same ids and no block: whether an encrypted object's
  // block is there is not authenticated, so it opens without complaint. The row's sealed summary is authenticated.
  it('on an encrypted segment carries the metadata the row authenticated, and the erasure goes through', async () => {
    const w = world(key());
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    await stripBlock(w);

    const result = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(result).toMatchObject({ erased: true, generation: 1 });
    expect((await readerOf(w, 1)).metadata).toEqual(META);
    const row = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, row, await aeadOf(w))).toEqual({
      cardinality: IDS.length - 1,
      metadata: META,
    });
  });

  it('carries the object as it is when the row has no summary to hold it to', async () => {
    const w = world(key());
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    await stripBlock(w);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { summary: undefined });

    expect(await eraseIdFromSegment(SEG, 1, w.deps)).toMatchObject({ erased: true });
    expect((await readerOf(w, 1)).metadata).toBeUndefined();
    const after = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, after, await aeadOf(w))).toEqual({
      cardinality: IDS.length - 1,
      metadata: undefined,
    });
  });

  it('carries the object as it is when the row never had metadata to hold it to', async () => {
    const w = world(key());
    await loadSegment(SEG, IDS, w.deps);
    await eraseIdFromSegment(SEG, 1, w.deps);
    expect((await readerOf(w, 1)).metadata).toBeUndefined();
  });

  it('carries the object, not the row, when the object has metadata of its own that the row does not say', async () => {
    const w = world(key());
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    const aead = (await aeadOf(w))!;
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: sealSummary(aead, SEG, 0, IDS.length, { def: 'other' }),
    });

    expect(await eraseIdFromSegment(SEG, 1, w.deps)).toMatchObject({ erased: true });
    expect((await readerOf(w, 1)).metadata).toEqual(META);
    const after = (await w.registry.get(SEG))!;
    expect(usableSummary(SEG, after, aead)?.metadata).toEqual(META);
  });

  it('does not take the metadata of a summary it cannot open: that is no authority', async () => {
    const w = world(key());
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    await stripBlock(w);
    const row = (await w.registry.get(SEG))!;
    // The sealed bytes are another generation's: they do not open under this one's associated data.
    const aead = (await aeadOf(w))!;
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: { ...sealSummary(aead, SEG, 7, IDS.length, META), generation: 0 },
    });

    expect(await eraseIdFromSegment(SEG, 1, w.deps)).toMatchObject({ erased: true });
    expect((await readerOf(w, 1)).metadata).toBeUndefined();
  });

  it('on a cleartext segment carries the object as it is: a clear summary has no more authority than the block it sits beside', async () => {
    const w = world();
    await loadSegment(SEG, IDS, w.deps, { metadata: META });
    await stripBlock(w);
    const row = (await w.registry.get(SEG))!;
    expect(row.summary).toMatchObject({ metadata: META });

    expect(await eraseIdFromSegment(SEG, 1, w.deps)).toMatchObject({ erased: true });
    expect((await readerOf(w, 1)).metadata).toBeUndefined();
    const after = (await w.registry.get(SEG))!;
    expect(after.summary).toEqual({ generation: 1, cardinality: IDS.length - 1 });
  });
});

describe('the rewrite is checked against the summary it will publish', () => {
  it('refuses an object that does not hold the metadata its summary will say', async () => {
    const w = world();
    const key0 = { ...SEG, generation: 0 };
    const chunks = (async function* () {
      yield { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) };
    })();
    const tally = await writeCrbmGenerationStream(w.storage, key0, chunks, { metadata: META });
    await verifyGeneration(w.storage, key0, { ...tally, metadata: META }, undefined);
    // The summary would claim other metadata, none, or a different count than the object holds.
    for (const wrong of [{ x: 'y' }, undefined]) {
      await expect(
        verifyGeneration(w.storage, key0, { ...tally, metadata: wrong }, undefined),
      ).rejects.toBeInstanceOf(IntegrityError);
    }
    await expect(
      verifyGeneration(w.storage, key0, { ...tally, cardinality: 9, metadata: META }, undefined),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('the store carries the metadata through eraseSubject', () => {
  it('keeps what the segment was loaded with, and the row says so', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false });
    await store.load(SEG, IDS, { metadata: META });
    const ledger = await store.eraseSubject(200_000, { namespace: 'ns' });
    expect(ledger.erasedFrom).toEqual([expect.objectContaining({ erased: true, generation: 1 })]);
    const reader = await openGenerationReader(
      backend.storage,
      { ...SEG, generation: 1 },
      undefined,
    );
    expect(reader.metadata).toEqual(META);
    const row = (await backend.registry.get(SEG))!;
    expect(row.summary).toEqual({ generation: 1, cardinality: IDS.length - 1, metadata: META });
  });
});
