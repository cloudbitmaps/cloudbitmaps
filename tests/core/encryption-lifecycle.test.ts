import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  destroySegment,
  eraseNamespace,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError, ValidationError } from '@/core/errors';
import type { CompactionDeps, IKeystore, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';
const k = (): Uint8Array => randomBytes(32);

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => Date.now() }, keystore };
  const store = (ks = keystore): CloudRoaring =>
    new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry, keystore: ks }),
      retry: false,
    });
  return { cold, warm, registry, deps, store };
}

async function members(store: CloudRoaring): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment('s').iterate()) out.push(id);
  return out;
}

describe('encryption lifecycle — compaction (Phase 4e)', () => {
  it('compaction reuses the segment DEK: decrypts gen g, re-encrypts gen g+1 (I3 preserved)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3, 100_000], {
      registry: w.registry,
      keystore,
    });
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;

    await w.store().segment('s').add(4);
    await w.store().segment('s').remove(2);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    // Same DEK reused (the wrapped list is unchanged), and the new generation is still encrypted + correct.
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore);
    expect(await members(w.store())).toEqual([1, 3, 4, 100_000]);
  });

  it('compaction bootstrap mints a DEK for an all-warm segment', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.store().segment('s').addMany([1, 2, 3]);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0 });
    expect((await w.registry.get(SEG))!.wrappedDeks).toHaveLength(1);
    expect(await members(w.store())).toEqual([1, 2, 3]);
    // The bootstrapped generation is genuinely encrypted: a source without the keystore can't read it.
    const noKeystore = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(members(noKeystore)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('requireEncryption refuses to compact a cleartext segment without a keystore', async () => {
    const w = world(); // no keystore
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.store().segment('s').add(3);
    await expect(
      compactSegment(SEG, { ...w.deps, requireEncryption: true }, { owner: OWNER }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reuses the same DEK + correct data across multiple generations (0 → 1 → 2)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    const wrapped0 = (await w.registry.get(SEG))!.wrappedDeks;

    await w.store().segment('s').add(4);
    expect((await compactSegment(SEG, w.deps, { owner: OWNER })).toGen).toBe(1);
    await w.store().segment('s').add(5);
    expect((await compactSegment(SEG, w.deps, { owner: OWNER })).toGen).toBe(2);

    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    // The DEK is reused across every generation (the wrapped list never changes), and each gen decrypts.
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrapped0);
    expect(await members(w.store())).toEqual([1, 2, 3, 4, 5]);
  });

  it('compacting an encrypted segment without the keystore fails fast (KeyUnavailableError, never a silent decode)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    // Bootstrap an encrypted gen 0 — the registry row carries the wrapped DEK.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    await w.store().segment('s').add(4); // a Warm row to fold
    // The daemon now runs WITHOUT the keystore: it must refuse (can't open the DEK), never mis-decode the
    // ciphertext. A lost key is a genuine fault that propagates, not a silent wrong answer.
    await expect(
      compactSegment(SEG, { ...w.deps, keystore: undefined }, { owner: OWNER }),
    ).rejects.toThrow(KeyUnavailableError);
  });
});

describe('crypto-shred — destroySegment / eraseNamespace (Phase 4e, L1–L4)', () => {
  it('shreds the DEK + clears Warm; the segment reads empty and is unrecoverable even WITH the keystore', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    await w.store().segment('s').add(4); // a live Warm row too
    expect(await members(w.store())).toEqual([1, 2, 3, 4]);

    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res.destroyed).toBe(true);
    expect(res.warmRowsDeleted).toBeGreaterThanOrEqual(1);

    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('destroyed');
    expect(rec.wrappedDeks).toBeUndefined(); // the key is gone — the .crbm bytes are now unreadable forever

    // Reads empty even though we still hold the KEK: there is no DEK left to unwrap.
    expect(await members(w.store())).toEqual([]);
  });

  it('requires the exact segment name as confirmation (guards against accidental shred)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    await expect(destroySegment(SEG, w.deps, { confirmSegment: 'wrong' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await w.registry.get(SEG))!.status).toBe('active'); // untouched
  });

  it('is idempotent — destroying an already-destroyed segment is a no-op success', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    const again = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(again).toMatchObject({ destroyed: true, reason: 'already' });
  });

  it('eraseNamespace shreds every encrypted segment in the namespace', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    for (const seg of ['a', 'b']) {
      await bulkLoadCrbmGeneration(
        w.cold,
        { namespace: 'ns', segment: seg, generation: 0 },
        [1, 2],
        {
          registry: w.registry,
          keystore,
        },
      );
    }
    const { destroyed } = await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns' });
    expect(destroyed.map((d) => d.segment).sort()).toEqual(['a', 'b']);
    expect(destroyed.every((d) => d.destroyed)).toBe(true);
    for (const seg of ['a', 'b']) {
      expect((await w.registry.get({ namespace: 'ns', segment: seg }))!.status).toBe('destroyed');
    }
  });

  it('refuses to shred a cleartext segment (no key to shred) unless allowCleartext', async () => {
    const w = world(); // no keystore
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res).toMatchObject({ destroyed: false, reason: 'cleartext' });
    expect((await w.registry.get(SEG))!.status).toBe('active');
  });

  it('refuses to resurrect a destroyed segment: bulk-load throws, compaction skips it', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });

    // Bulk-loading a new generation would mint a DEK that could never be reached → refuse outright.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [9], {
        registry: w.registry,
        keystore,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Compaction won't resurrect it either — a destroyed segment is terminal.
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'destroyed' });
    // The original Cold data is unrecoverable; the segment reads empty.
    expect(await members(w.store())).toEqual([]);
  });
});
