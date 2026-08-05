import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  findCompactable,
  gcOrphanGenerations,
  publishGeneration,
  runConsistencyCheck,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError, WriteConflictError } from '@/core/errors';
import type { CompactionDeps, IKeystore, SegmentRef } from '@/index';
import type { IRegistryDriver, RegistryPatch, Token } from '@/core/ports';

/**
 * `currentGen: null` — "this segment exists and has **no Cold generation yet**".
 *
 * A **warm-only accumulator** (created by writing to it, never bulk-loaded, never compacted) has no registry row
 * at all, and that is what makes it invisible to `registry.list()` and therefore to every fleet-wide operation
 * in the library: retention sweeps, `checkConsistency`, `eraseNamespace`, discovery. A row is the fix, but the
 * obvious row — `currentGen: 0` with no object behind it — is the forbidden `missing-cold-generation` state, and
 * it breaks *per operation* rather than cleanly (`has()` short-circuits on the Warm delta and keeps answering
 * while `count()` resolves the generation and throws). So the row's pointer must be able to say "none yet".
 *
 * The bar these tests hold the change to: **a null-gen row must be indistinguishable from no row on every read
 * path**, and every writer that reasons about generations (`compactSegment`'s bootstrap, `publishGeneration`,
 * `gcOrphanGenerations`, `runConsistencyCheck`) must treat it as "no Cold data", never as generation 0.
 */

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => 1_000 }, keystore };
  // A fresh store per call: CrbmColdChunkSource pins the resolved generation per lifetime.
  const store = (reg: IRegistryDriver = registry): CloudRoaring =>
    new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry: reg, keystore }),
      retry: false,
    });
  return { cold, warm, registry, deps, store };
}

async function members(store: CloudRoaring, seg = 's'): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(seg).iterate()) out.push(id);
  return out;
}

async function warmRowCount(warm: MemoryWarmDriver, ref: SegmentRef): Promise<number> {
  let n = 0;
  for await (const row of warm.listChunks(ref)) {
    void row;
    n += 1;
  }
  return n;
}

async function coldGenerations(cold: MemoryColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/**
 * Wrap a registry driver, interposing on the mutating methods. Used to reproduce the contention that makes the
 * gen-0 publish unsafe: a null-gen row is an ORDINARY row, so `setRetention`, the dirty-count hint and erasure
 * can all CAS it — a conflict there does not mean "someone else published gen 0".
 */
function wrapRegistry(
  base: IRegistryDriver,
  hooks: {
    onCreate?: () => Promise<void> | void;
    onCas?: (patch: RegistryPatch) => Promise<'pass' | 'conflict'> | 'pass' | 'conflict';
  },
): IRegistryDriver {
  return {
    capabilities: () => base.capabilities(),
    get: (ref) => base.get(ref),
    create: async (ref, rec) => {
      await hooks.onCreate?.();
      return base.create(ref, rec);
    },
    compareAndSwap: async (ref, expected: Token, patch) => {
      const verdict = (await hooks.onCas?.(patch)) ?? 'pass';
      if (verdict === 'conflict') throw new WriteConflictError('interposed registry conflict');
      return base.compareAndSwap(ref, expected, patch);
    },
    list: (ns) => base.list(ns),
    delete: (ref) => base.delete(ref),
  };
}

/** The Part-1 row: a live segment that has never had a Cold generation. */
async function createNullGenRow(
  registry: IRegistryDriver,
  ref: SegmentRef = SEG,
  retention?: Record<string, unknown>,
): Promise<void> {
  await registry.create(ref, { currentGen: null, retention });
}

describe('a registry row with no Cold generation (currentGen: null)', () => {
  describe('read path — indistinguishable from having no row at all', () => {
    it('answers every read exactly like the same warm-only segment with no row', async () => {
      // Two worlds, same writes. The only difference is that one has a Part-1 row.
      const withRow = world();
      const withoutRow = world();
      await createNullGenRow(withRow.registry);

      for (const w of [withRow, withoutRow]) {
        const s = w.store().segment('s');
        await s.addMany([1, 2, 3, 100_000]);
        await s.remove(2);
      }

      for (const w of [withRow, withoutRow]) {
        const s = w.store().segment('s');
        expect(await s.has(1)).toBe(true);
        expect(await s.has(2)).toBe(false); // the tombstone still applies
        expect(await s.has(999)).toBe(false);
        expect(await s.count()).toBe(3);
        expect(await members(w.store())).toEqual([1, 3, 100_000]);
      }
      // And the row is still Cold-less — a read must never publish a pointer as a side effect.
      expect((await withRow.registry.get(SEG))!.currentGen).toBeNull();
    });

    it('resolves no Cold generation, so `currentGeneration` reports null (not 0)', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      const cold = new CrbmColdChunkSource(w.cold, { registry: w.registry });
      expect(await cold.currentGeneration(SEG)).toBeNull();
    });

    it('intersects with a Cold-backed segment without resolving a phantom generation', async () => {
      const w = world();
      await createNullGenRow(w.registry, { segment: 'live' });
      await bulkLoadCrbmGeneration(w.cold, { segment: 'cold', generation: 0 }, [1, 2, 3], {
        registry: w.registry,
      });
      await w.store().segment('live').addMany([2, 3, 4]);

      const store = w.store();
      const hit: number[] = [];
      for await (const id of store.segment('live').intersect([store.segment('cold')])) hit.push(id);
      expect(hit).toEqual([2, 3]);
    });

    it('a `currentGen: 0` row with no object is the state this replaces — and it still fails loudly', async () => {
      // The control for the test above: if `null` were "the same as 0" the two would behave alike. They do not —
      // this is the `missing-cold-generation` breakage that made a naive row worse than no row.
      const w = world();
      await w.registry.create(SEG, { currentGen: 0 });
      await w.store().segment('s').addMany([1, 2, 3]);
      await expect(w.store().segment('s').count()).rejects.toThrow();
    });
  });

  describe('discovery + fleet-wide operations', () => {
    it('is enumerable — the reason the row exists at all', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      await w.store().segment('s').addMany([1, 2]);

      const listed: string[] = [];
      for await (const rec of w.registry.list()) listed.push(rec.segment);
      expect(listed).toEqual(['s']);

      // The control: without a row the identical segment is invisible to every fleet-wide operation.
      const blind = world();
      await blind.store().segment('s').addMany([1, 2]);
      const none: string[] = [];
      for await (const rec of blind.registry.list()) none.push(rec.segment);
      expect(none).toEqual([]);
    });

    it('is a compaction candidate (findCompactable sees it via the registry)', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      await w.store().segment('s').addMany([1, 100_000]); // 2 chunks → 2 dirty Warm rows

      const candidates = await findCompactable(w.deps, { threshold: 1 });
      expect(candidates).toEqual([
        {
          ref: { namespace: undefined, segment: 's' },
          dirtyChunks: 2,
          currentGen: null,
          lastCompactedAt: undefined,
        },
      ]);
    });

    it('is consistent, not torn: checkConsistency does not report missing-cold-generation', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      await w.store().segment('s').addMany([1, 2]);

      const report = await runConsistencyCheck({ cold: w.cold, registry: w.registry });
      expect(report).toEqual({ checked: 1, inconsistent: [], errored: [] });
    });

    it('control: the same scan DOES report a row whose generation is genuinely missing', async () => {
      // Without this, the assertion above could pass for the wrong reason (a scan that reports nothing ever).
      const w = world();
      await w.registry.create(SEG, { currentGen: 4 });
      const report = await runConsistencyCheck({ cold: w.cold, registry: w.registry });
      expect(report.inconsistent).toEqual([
        { segment: 's', namespace: undefined, currentGen: 4, issue: 'missing-cold-generation' },
      ]);
    });
  });

  describe('compaction bootstrap — publishing the first generation onto an existing row', () => {
    it('takes the bootstrap path and CASes gen 0 onto the row, preserving its identity', async () => {
      const w = world();
      await createNullGenRow(w.registry, SEG, { expiresAt: 9_999 });
      const before = (await w.registry.get(SEG))!;
      await w.store().segment('s').addMany([1, 2, 3, 100_000]);

      const res = await compactSegment(SEG, w.deps, { owner: OWNER });
      // `fromGen: null` — there was no generation to merge onto, so this is a bootstrap, not `g + 1` from nothing.
      expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0, purged: 2 });

      const after = (await w.registry.get(SEG))!;
      expect(after.currentGen).toBe(0);
      expect(after.status).toBe('active');
      expect(after.createdAt).toBe(before.createdAt); // CAS'd in place — not deleted and recreated
      expect(after.retention).toEqual({ expiresAt: 9_999 }); // the policy that needed the row survives it
      expect(await warmRowCount(w.warm, SEG)).toBe(0); // committed, so the pinned rows were purged
      expect(await members(w.store())).toEqual([1, 2, 3, 100_000]);
    });

    it('is a no-op on a null-gen row with nothing in Warm (no phantom generation 0)', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      const res = await compactSegment(SEG, w.deps, { owner: OWNER });
      expect(res).toMatchObject({ compacted: false, reason: 'clean', fromGen: null });
      expect((await w.registry.get(SEG))!.currentGen).toBeNull(); // still Cold-less
      expect(await coldGenerations(w.cold, SEG)).toEqual([]);
    });

    it('does NOT purge Warm when the pointer never lands (the lost-write this change had to avoid)', async () => {
      // `create` would throw a conflict against the existing row; swallowing that as "someone else published"
      // and purging would delete the only copy of the data while the row still says "no Cold generation".
      const w = world();
      await createNullGenRow(w.registry);
      const registry = wrapRegistry(w.registry, { onCas: () => 'conflict' }); // every publish attempt fails
      await w.store().segment('s').addMany([1, 2, 3]);

      const res = await compactSegment(SEG, { ...w.deps, registry }, { owner: OWNER });
      expect(res).toMatchObject({ compacted: false, reason: 'bootstrap-raced', purged: 0 });
      expect((await w.registry.get(SEG))!.currentGen).toBeNull(); // nothing was published…
      expect(await warmRowCount(w.warm, SEG)).toBe(1); // …so the Warm row is still the source of truth
      expect(await members(w.store())).toEqual([1, 2, 3]); // and no data was lost
    });

    it('retries a transient conflict and commits (a competing CAS moved the token)', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      let first = true;
      const registry = wrapRegistry(w.registry, {
        onCas: async (patch) => {
          if (!first || !('currentGen' in patch)) return 'pass';
          first = false;
          // Someone else's write (a retention update, a dirty-count hint) landed between our read and our CAS.
          const rec = (await w.registry.get(SEG))!;
          await w.registry.compareAndSwap(SEG, rec.token, { dirtyChunkCount: 3 });
          return 'conflict';
        },
      });
      await w.store().segment('s').addMany([1, 2, 3]);

      const res = await compactSegment(SEG, { ...w.deps, registry }, { owner: OWNER });
      expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0 });
      expect((await w.registry.get(SEG))!.currentGen).toBe(0);
      expect(await members(w.store())).toEqual([1, 2, 3]);
    });

    it('refuses to resurrect a segment tombstoned while it was writing gen 0', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      await w.store().segment('s').addMany([1, 2, 3]);
      const registry = wrapRegistry(w.registry, {
        onCas: async (patch) => {
          if (!('currentGen' in patch)) return 'pass';
          const rec = (await w.registry.get(SEG))!;
          if (rec.status !== 'destroyed') {
            // A `dropSegment` lands in the window between the object write and the publish.
            await w.registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });
            return 'conflict'; // its CAS bumped the token, exactly as a real drop would
          }
          return 'pass';
        },
      });

      const res = await compactSegment(SEG, { ...w.deps, registry }, { owner: OWNER });
      expect(res).toMatchObject({ compacted: false, reason: 'bootstrap-raced', purged: 0 });
      const rec = (await w.registry.get(SEG))!;
      expect(rec.status).toBe('destroyed'); // the tombstone stands
      expect(rec.currentGen).toBeNull(); // never pointed at the generation we wrote
    });

    it('reuses a DEK the row already carries instead of minting a second one', async () => {
      const keystore = new InProcessKeystore({
        keys: { k1: randomBytes(32) },
        activeKeyId: 'k1',
      });
      const w = world(keystore);
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });
      await w.store().segment('s').addMany([1, 2, 3]);

      const res = await compactSegment(SEG, w.deps, { owner: OWNER });
      expect(res).toMatchObject({ compacted: true, toGen: 0 });
      // The row's wrappings are what a reader resolves the key from, so they must be the ones gen 0 was written
      // under. A freshly minted DEK here would leave the generation undecryptable.
      expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(minted.wrapped);
      expect(await members(w.store())).toEqual([1, 2, 3]);
    });

    it('fails fast when the row is encrypted but compaction has no keystore', async () => {
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = world(); // …and this world has no keystore wired
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });
      await w.store().segment('s').addMany([1, 2, 3]);

      // Silently writing cleartext gen 0 under an encrypted row would be the worst outcome: readable bytes
      // attached to a row that claims they are encrypted.
      await expect(compactSegment(SEG, w.deps, { owner: OWNER })).rejects.toBeInstanceOf(
        KeyUnavailableError,
      );
    });
  });

  describe('the other generation writers', () => {
    it('publishGeneration advances a null pointer instead of comparing against it', async () => {
      const w = world();
      await createNullGenRow(w.registry, SEG, { expiresAt: 1 });
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3]); // no registry ⇒ unpublished

      expect(await publishGeneration(w.registry, { ...SEG, generation: 0 })).toBe(true);
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.retention).toEqual({ expiresAt: 1 }); // publishing is not a rewrite
      expect(await members(w.store())).toEqual([1, 2, 3]);
    });

    it('bulkLoadCrbmGeneration lands on a segment that already has a null-gen row', async () => {
      const w = world();
      await createNullGenRow(w.registry);
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [7, 8, 9], {
        registry: w.registry,
      });
      expect((await w.registry.get(SEG))!.currentGen).toBe(0);
      expect(await members(w.store())).toEqual([7, 8, 9]);
    });

    it('an encrypted bulk-load onto a null-gen row stores the freshly minted DEK on the row', async () => {
      // The publish that advances a null pointer is a FIRST publish, so it has to carry the wrapped DEK exactly
      // like the create path does. If it only moved the pointer, the generation would be encrypted under a key
      // whose wrapping was never stored — written, paid for, and permanently unreadable.
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = world(keystore);
      await createNullGenRow(w.registry);

      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [4, 5, 6], {
        registry: w.registry,
        keystore,
      });
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.wrappedDeks?.length).toBeGreaterThan(0);
      expect(await members(w.store())).toEqual([4, 5, 6]);
    });

    it('a publish with no DEK does not wipe key material already on the row', async () => {
      // A registry patch CLEARS an optional field by mentioning it, so `wrappedDeks: undefined` is not "leave it
      // alone" — it is "delete it". Publishing a cleartext generation must therefore not mention the field at
      // all, or this path would silently destroy the wrappings while the branch for a non-null pointer preserves
      // them. (The mismatch is what matters: an encrypted row whose only generation is cleartext must fail the
      // same way it always has — closed, at the reader — not be quietly rewritten into a cleartext row.)
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = world();
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });

      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
        registry: w.registry, // no keystore ⇒ the generation is written cleartext
      });
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.wrappedDeks).toEqual(minted.wrapped);
    });

    it('gcOrphanGenerations deletes nothing while the pointer is null', async () => {
      // A bootstrap may have just written gen 0 and be about to publish it; deleting here would race that into a
      // dangling pointer. There is also no "below current" to compute.
      const w = world();
      await createNullGenRow(w.registry);
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1]);
      expect(await gcOrphanGenerations(SEG, w.deps, { keep: 0 })).toEqual([]);
      expect(await coldGenerations(w.cold, SEG)).toEqual([0]);
    });

    it('control: it still collects superseded generations once a pointer exists', async () => {
      const w = world();
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1]);
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2]);
      await w.registry.create(SEG, { currentGen: 1 });
      expect(await gcOrphanGenerations(SEG, w.deps, { keep: 0 })).toEqual([0]);
      expect(await coldGenerations(w.cold, SEG)).toEqual([1]);
    });
  });
});
