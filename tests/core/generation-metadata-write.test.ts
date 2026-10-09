import { randomBytes } from 'node:crypto';
import roaring from 'roaring';
import { aadFor } from '@/core/crypto';
import { openGenerationReader, publishGeneration } from '@/core/crbm-storage-source';
import { IntegrityError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { openSummary, summaryAgrees, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { FINGERPRINT } from '../helpers/fingerprint';

const { RoaringBitmap32 } = roaring;

/**
 * What a load writes besides the ids: the metadata, in the object and, with the count, in the row's summary, by the
 * write that moves the pointer. Read back through the open the store's own reads use, the object and the row agree.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const META: GenerationMetadata = { def: 'v41', landedAt: 1_790_000_000_000, owner: 'growth' };

function cleartext() {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend, retry: false });
  return { backend, store, storage: backend.storage, registry: backend.registry };
}

function encrypted() {
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
  return { backend, store, storage: backend.storage, registry: backend.registry, keystore };
}

/** The whole object's bytes. */
async function objectBytes(storage: IStorageDriver, generation: number): Promise<Uint8Array> {
  return (await storage.getTail({ ...SEG, generation }, 1 << 30)).bytes;
}

const contains = (hay: Uint8Array, text: string): boolean =>
  Buffer.from(hay).includes(Buffer.from(text, 'utf8'));

describe('a cleartext load with metadata', () => {
  it('writes it into the object, and into the row beside the count, and they agree', async () => {
    const { store, storage, registry } = cleartext();
    const result = await store.load(SEG, [5, 6, 7, 100_000], { metadata: META });
    expect(result).toMatchObject({ generation: 0, published: true, cardinality: 4 });

    const row = (await registry.get(SEG))!;
    expect(row.summary).toEqual({
      generation: 0,
      cardinality: 4,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: META,
    });

    const reader = await openGenerationReader(storage, { ...SEG, generation: 0 }, undefined);
    expect(reader.metadata).toEqual(META);
    expect(reader.count()).toBe(4);
    expect(
      summaryAgrees(usableSummary(SEG, row, undefined)!, {
        cardinality: reader.count(),
        metadata: reader.metadata,
      }),
    ).toBe(true);
  });

  it('writes the count alone, with no metadata key, for a load that has none', async () => {
    const { store, storage, registry } = cleartext();
    await store.load(SEG, [1, 2, 3]);
    const row = (await registry.get(SEG))!;
    expect(row.summary).toStrictEqual({
      generation: 0,
      cardinality: 3,
      fingerprint: expect.stringMatching(FINGERPRINT),
    });
    const reader = await openGenerationReader(storage, { ...SEG, generation: 0 }, undefined);
    expect(reader.metadata).toBeUndefined();
  });

  it('writes the same object whatever order the keys were given in', async () => {
    const a = cleartext();
    const b = cleartext();
    const first = await a.store.load(SEG, [1, 2], { metadata: { x: 1, a: 'y', m: 2 } });
    const second = await b.store.load(SEG, [1, 2], { metadata: { m: 2, a: 'y', x: 1 } });
    expect(first.sha256).toBe(second.sha256);
    expect(first.size).toBe(second.size);
  });

  it('writes the same object for the empty record as for none, and the object is a plain 1.0 one', async () => {
    const a = cleartext();
    const b = cleartext();
    const c = cleartext();
    const none = await a.store.load(SEG, [1, 2]);
    const empty = await b.store.load(SEG, [1, 2], { metadata: {} });
    const some = await c.store.load(SEG, [1, 2], { metadata: { a: 1 } });
    expect(empty.sha256).toBe(none.sha256);
    expect(empty.size).toBe(none.size);
    expect(some.size).toBeGreaterThan(none.size);
    expect((await b.registry.get(SEG))!.summary).toStrictEqual({
      generation: 0,
      cardinality: 2,
      fingerprint: expect.stringMatching(FINGERPRINT),
    });
  });

  it('gives each generation its own metadata: a later load without it has none', async () => {
    const { store, storage, registry } = cleartext();
    await store.load(SEG, [1, 2], { metadata: { run: 'one' } });
    await store.load(SEG, [1, 2, 3], { metadata: { run: 'two' } });
    await store.load(SEG, [1, 2, 3, 4]);
    const row = (await registry.get(SEG))!;
    expect(row.currentGen).toBe(2);
    expect(row.summary).toStrictEqual({
      generation: 2,
      cardinality: 4,
      fingerprint: expect.stringMatching(FINGERPRINT),
    });
    // The generation the window kept is the one before it, with its own.
    const kept = await openGenerationReader(storage, { ...SEG, generation: 1 }, undefined);
    expect(kept.metadata).toEqual({ run: 'two' });
    expect(
      (await openGenerationReader(storage, { ...SEG, generation: 2 }, undefined)).metadata,
    ).toBeUndefined();
  });

  it('writes it for a bitmap load', async () => {
    const { store, storage, registry } = cleartext();
    const bitmap = new RoaringBitmap32([1, 2, 3, 70_000]);
    await store.load(SEG, { bitmap }, { metadata: { from: 'bitmap' } });
    const bytes = bitmap.serialize(true);
    await store.load(
      { ...SEG, segment: 'b' },
      { serialized: bytes },
      { metadata: { from: 'bytes' } },
    );
    expect((await registry.get(SEG))!.summary).toEqual({
      generation: 0,
      cardinality: 4,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { from: 'bitmap' },
    });
    expect((await registry.get({ ...SEG, segment: 'b' }))!.summary).toEqual({
      generation: 0,
      cardinality: 4,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { from: 'bytes' },
    });
    const reader = await openGenerationReader(storage, { ...SEG, generation: 0 }, undefined);
    expect(reader.metadata).toEqual({ from: 'bitmap' });
  });

  it('writes it for each *Into verb', async () => {
    const { store, storage, registry } = cleartext();
    await store.load({ ...SEG, segment: 'a' }, [1, 2, 3, 4]);
    await store.load({ ...SEG, segment: 'b' }, [3, 4, 5]);
    const a = store.segment('a', { namespace: 'ns' });
    const b = store.segment('b', { namespace: 'ns' });
    const into = async (verb: 'intersectInto' | 'unionInto' | 'andNotInto', name: string) => {
      const dest = store.segment(name, { namespace: 'ns' });
      const metadata = { verb };
      return verb === 'andNotInto'
        ? a.andNotInto(dest, [b], { metadata })
        : a[verb](dest, [b], { metadata });
    };
    for (const [verb, count] of [
      ['intersectInto', 2],
      ['unionInto', 5],
      ['andNotInto', 2],
    ] as const) {
      const r = await into(verb, `d-${verb}`);
      const ref = { ...SEG, segment: `d-${verb}` };
      const row = (await registry.get(ref))!;
      expect(row.summary).toEqual({
        generation: r.generation,
        cardinality: count,
        fingerprint: expect.stringMatching(FINGERPRINT),
        metadata: { verb },
      });
      const reader = await openGenerationReader(
        storage,
        { ...ref, generation: r.generation },
        undefined,
      );
      expect(reader.metadata).toEqual({ verb });
      expect(reader.count()).toBe(count);
    }
  });

  it('writes the summary on a first load, an advancing load and a load onto a row with no pointer', async () => {
    const { registry, storage } = cleartext();
    const deps = { storage, registry, codec: roaringCodec };
    // A policy recorded ahead of the first load leaves a row with no pointer.
    await registry.create(SEG, { currentGen: null, retention: { expiresAt: 4_102_444_800_000 } });
    expect((await registry.get(SEG))!.currentGen).toBeNull();
    await loadSegment(SEG, [1], deps, { metadata: { n: 0 } });
    expect((await registry.get(SEG))!.summary).toEqual({
      generation: 0,
      cardinality: 1,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { n: 0 },
    });
    await loadSegment(SEG, [1, 2], deps, { metadata: { n: 1 } });
    expect((await registry.get(SEG))!.summary).toEqual({
      generation: 1,
      cardinality: 2,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { n: 1 },
    });
    const fresh = { ...SEG, segment: 'fresh' };
    await loadSegment(fresh, [1, 2, 3], deps, { metadata: { n: 2 } });
    expect((await registry.get(fresh))!.summary).toEqual({
      generation: 0,
      cardinality: 3,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { n: 2 },
    });
  });
});

describe('an encrypted load with metadata', () => {
  it('seals the count and the metadata in the row, and the metadata in the object', async () => {
    const { store, storage, registry, keystore } = encrypted();
    await store.load(SEG, [1, 2, 3, 4, 5, 6, 7], { metadata: { owner: 'a-recognisable-owner' } });
    const row = (await registry.get(SEG))!;
    expect(row.wrappedDeks).toBeDefined();
    const summary = row.summary!;
    expect(Object.keys(summary).sort()).toEqual(['generation', 'sealed']);

    const aead = await keystore.openDek(row.wrappedDeks!);
    expect(openSummary(aead, SEG, summary as never)).toEqual({
      cardinality: 7,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: { owner: 'a-recognisable-owner' },
    });

    const reader = await openGenerationReader(
      storage,
      { ...SEG, generation: 0 },
      {
        aead,
        aadFor: (scope) => aadFor(SEG, 0, scope),
      },
    );
    expect(reader.metadata).toEqual({ owner: 'a-recognisable-owner' });
    expect(
      summaryAgrees(usableSummary(SEG, row, aead)!, {
        cardinality: reader.count(),
        metadata: reader.metadata,
      }),
    ).toBe(true);
  });

  it('leaves the plaintext metadata and count out of the row and the object', async () => {
    const { store, storage, registry } = encrypted();
    await store.load(
      SEG,
      Array.from({ length: 4_321 }, (_, i) => i),
      {
        metadata: { owner: 'a-recognisable-owner', run: 7_654_321 },
      },
    );
    const record = await registry.get(SEG);
    const row = JSON.stringify(record);
    expect(row).not.toContain('recognisable');
    expect(row).not.toContain('7654321');
    expect(row).not.toContain('"cardinality"');
    expect(row).not.toContain('"metadata"');
    // The count as a value anywhere in the row. Searching the serialised row for its digits would also search the
    // random token, the timestamps and the ciphertext, which hold any four digits now and then.
    const values: unknown[] = [];
    const walk = (v: unknown): void => {
      if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
      else values.push(v);
    };
    walk(record);
    expect(values).not.toContain(4_321);
    expect(values).not.toContain('4321');
    const bytes = await objectBytes(storage, 0);
    expect(contains(bytes, 'recognisable')).toBe(false);
    expect(contains(bytes, 'owner')).toBe(false);
  });

  it('is the same size in the row for any count, so the row does not give the count away', async () => {
    const sizes: number[] = [];
    for (const n of [1, 9, 10, 4_000]) {
      const { store, registry } = encrypted();
      await store.load(
        SEG,
        Array.from({ length: n }, (_, i) => i),
        { metadata: { a: 'x' } },
      );
      sizes.push(((await registry.get(SEG))!.summary as { sealed: string }).sealed.length);
    }
    expect(new Set(sizes).size).toBe(1);
  });

  it('seals a count alone for a load with no metadata', async () => {
    const { store, registry, keystore } = encrypted();
    await store.load(SEG, [1, 2, 3]);
    const row = (await registry.get(SEG))!;
    const aead = await keystore.openDek(row.wrappedDeks!);
    expect(openSummary(aead, SEG, row.summary as never)).toEqual({
      cardinality: 3,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: undefined,
    });
  });

  it("refuses a sealed summary moved onto another generation's row", async () => {
    const { store, registry, keystore } = encrypted();
    await store.load(SEG, [1, 2], { metadata: { run: 'one' } });
    const first = (await registry.get(SEG))!.summary as { generation: number; sealed: string };
    await store.load(SEG, [1, 2, 3], { metadata: { run: 'two' } });
    const row = (await registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    const aead = await keystore.openDek(row.wrappedDeks!);

    // The first generation's blob, planted on the row that names the second as current.
    const planted = { generation: 1, sealed: first.sealed };
    await registry.compareAndSwap(SEG, row.token, { summary: planted });
    const moved = (await registry.get(SEG))!;
    expect(() => openSummary(aead, SEG, moved.summary as never)).toThrow(IntegrityError);
    expect(usableSummary(SEG, moved, aead)).toBeUndefined();
    // And moved onto another segment's row it fails the same way.
    expect(() => openSummary(aead, { ...SEG, segment: 'other' }, row.summary as never)).toThrow(
      IntegrityError,
    );
  });
});

describe('the loader that publishes by itself', () => {
  it('writes the summary of what it wrote, clear on a cleartext segment', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const written = await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      metadata: META,
    });
    expect(written.summary).toEqual({
      generation: 0,
      cardinality: 3,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: META,
    });
    expect((await registry.get(SEG))!.summary).toEqual(written.summary);
  });

  it('seals it on an encrypted segment, and returns the same one it published', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const written = await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
      metadata: META,
    });
    const row = (await registry.get(SEG))!;
    expect(row.summary).toEqual(written.summary);
    expect(Object.keys(row.summary!).sort()).toEqual(['generation', 'sealed']);
    expect(
      openSummary(await keystore.openDek(row.wrappedDeks!), SEG, row.summary as never),
    ).toEqual({
      cardinality: 3,
      fingerprint: expect.stringMatching(FINGERPRINT),
      metadata: META,
    });
  });

  it('returns the summary without publishing it when asked not to publish', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const written = await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], {
      registry,
      publish: false,
    });
    expect(written.summary).toStrictEqual({
      generation: 0,
      cardinality: 2,
      fingerprint: expect.stringMatching(FINGERPRINT),
    });
    expect(await registry.get(SEG)).toBeNull();
  });
});

describe('a sealed summary on a row that holds no key', () => {
  it('is not published as a row made from nothing', async () => {
    // An object sealed under a key a row held when it was written, and no row now: the first publish cannot make a
    // row that holds the key. It reports that it did not publish, and creates nothing.
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    const key = { ...SEG, generation: 0 };
    const sealed = { generation: 0, sealed: 'A'.repeat(64) };
    expect(await publishGeneration(registry, key, { summary: sealed, row: null })).toBe(false);
    expect(await publishGeneration(registry, key, { summary: sealed })).toBe(false);
    expect(await registry.get(SEG)).toBeNull();
  });
});
