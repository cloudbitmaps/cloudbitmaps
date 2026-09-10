import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
  nextGeneration,
  publishGeneration,
  runConsistencyCheck,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError } from '@/core/errors';
import type { GovernanceMeta, IColdDriver, IKeystore, IRegistryDriver, SegmentRef } from '@/index';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `currentGen: null` — "this segment exists and has **no Cold generation yet**".
 *
 * A segment enters the library by having a generation **loaded** into it, and the publish that lands the first
 * generation is what creates its registry row. So between "a segment is intended" and "a segment has data" there
 * is nothing at all: no row, and therefore no entry in `registry.list()` — which is what every fleet-wide
 * operation enumerates from (retention sweeps, `checkConsistency`, `eraseNamespace`, discovery).
 *
 * That gap matters for exactly one caller: `setRetention`, which records a policy on a segment whose first load
 * has not happened yet (a daily bucket given a 30-day expiry the moment it is named). A policy on an
 * unenumerable segment would never be swept, so the policy write mints the row — and the obvious row,
 * `currentGen: 0` with no object behind it, is the forbidden `missing-cold-generation` state. Hence the third
 * pointer value: **`null`, "enumerable, and claiming no Cold data"**. `retention.ts` is the only writer that
 * mints one; that path is tested in `retention-policy.test.ts`.
 *
 * The bar this file holds the pointer to: **a null-gen row must be indistinguishable from no row on every read
 * path**, and every writer that reasons about generations (`publishGeneration`, `nextGeneration`,
 * `gcOrphanGenerations`, `runConsistencyCheck`) must read it as "no Cold data", never as generation 0.
 */

const SEG: SegmentRef = { segment: 's' };

async function world(keystore?: IKeystore) {
  const w = await loadedStore({}, { keystore, retry: false });
  /** A FRESH store per call: the fixture pins a segment's resolved generation for the store's lifetime. */
  const reader = (): CloudRoaring =>
    new CloudRoaring({ cold: w.cold, registry: w.registry, keystore, retry: false });
  return { ...w, reader };
}

async function coldGenerations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/** The row a pre-load `setRetention` leaves behind: a live segment that has never had a Cold generation. */
async function createNullGenRow(
  registry: IRegistryDriver,
  ref: SegmentRef = SEG,
  retention?: GovernanceMeta,
): Promise<void> {
  await registry.create(ref, { currentGen: null, retention });
}

describe('a registry row with no Cold generation (currentGen: null)', () => {
  describe('read path — indistinguishable from having no row at all', () => {
    it('answers every read exactly like the same unloaded segment with no row', async () => {
      // Two worlds, nothing loaded in either. The only difference is that one carries a policy row.
      const withRow = await world();
      const withoutRow = await world();
      await createNullGenRow(withRow.registry, SEG, { expiresAt: 9_999_999_999_999 });

      for (const w of [withRow, withoutRow]) {
        const s = w.reader().segment('s');
        expect(await s.has(1)).toBe(false);
        expect(await s.count()).toBe(0);
        expect(await collect(s.iterate())).toEqual([]);
      }
      // And the row is still Cold-less — a read must never publish a pointer as a side effect.
      expect((await withRow.registry.get(SEG))!.currentGen).toBeNull();
    });

    it('resolves no Cold generation, so `currentGeneration` reports null (not 0)', async () => {
      const w = await world();
      await createNullGenRow(w.registry);
      const cold = new CrbmColdChunkSource(w.cold, { registry: w.registry });
      expect(await cold.currentGeneration(SEG)).toBeNull();
    });

    it('intersects with a loaded segment from either side, resolving no phantom generation', async () => {
      const w = await world();
      await createNullGenRow(w.registry, { segment: 'pending' });
      await w.load('loaded', [1, 2, 3]);

      const store = w.reader();
      const pending = store.segment('pending');
      const loaded = store.segment('loaded');
      // Operand order decides which side resolves first and which is skipped chunk-by-chunk, so both are pinned.
      expect(await collect(pending.intersect([loaded]))).toEqual([]);
      expect(await collect(loaded.intersect([pending]))).toEqual([]);
    });

    it('unions and andNots as an empty operand, not a broken one', async () => {
      const w = await world();
      await createNullGenRow(w.registry, { segment: 'pending' });
      await w.load('loaded', [1, 2, 100_000]);

      const store = w.reader();
      const pending = store.segment('pending');
      const loaded = store.segment('loaded');
      expect(await collect(pending.union([loaded]))).toEqual([1, 2, 100_000]);
      expect(await collect(loaded.union([pending]))).toEqual([1, 2, 100_000]);
      expect(await collect(loaded.andNot([pending]))).toEqual([1, 2, 100_000]);
      expect(await collect(pending.andNot([loaded]))).toEqual([]);
    });

    it('a `currentGen: 0` row with no object is the state this replaces — and it still fails loudly', async () => {
      // The control for the tests above: if `null` were "the same as 0" the two would behave alike. They do not —
      // this is the `missing-cold-generation` breakage that made a naive row worse than no row. Note that it now
      // fails the SAME way on every read verb: with no per-op delta in front of the generation, there is no verb
      // that can keep answering off a second source while its neighbour throws.
      const w = await world();
      await w.registry.create(SEG, { currentGen: 0 });
      const s = w.reader().segment('s');
      await expect(s.count()).rejects.toThrow();
      await expect(s.has(1)).rejects.toThrow();
      await expect(collect(s.iterate())).rejects.toThrow();
    });
  });

  describe('discovery + fleet-wide operations', () => {
    it('is enumerable — the reason the row exists at all', async () => {
      const w = await world();
      await createNullGenRow(w.registry);

      const listed: string[] = [];
      for await (const rec of w.registry.list()) listed.push(rec.segment);
      expect(listed).toEqual(['s']);

      // The control: with no row, an intended-but-unloaded segment is invisible to every fleet-wide operation,
      // so a policy recorded on it would never be swept.
      const blind = await world();
      const none: string[] = [];
      for await (const rec of blind.registry.list()) none.push(rec.segment);
      expect(none).toEqual([]);
    });

    it('is consistent, not torn: checkConsistency does not report missing-cold-generation', async () => {
      const w = await world();
      await createNullGenRow(w.registry);

      const report = await runConsistencyCheck({ cold: w.cold, registry: w.registry });
      expect(report).toEqual({ checked: 1, inconsistent: [], errored: [] });
    });

    it('control: the same scan DOES report a row whose generation is genuinely missing', async () => {
      // Without this, the assertion above could pass for the wrong reason (a scan that reports nothing ever).
      const w = await world();
      await w.registry.create(SEG, { currentGen: 4 });
      const report = await runConsistencyCheck({ cold: w.cold, registry: w.registry });
      expect(report.inconsistent).toEqual([
        { segment: 's', namespace: undefined, currentGen: 4, issue: 'missing-cold-generation' },
      ]);
    });
  });

  describe('the generation writers', () => {
    it('publishGeneration advances a null pointer instead of comparing against it', async () => {
      const w = await world();
      await createNullGenRow(w.registry, SEG, { expiresAt: 1 });
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3]); // no registry ⇒ unpublished

      expect(await publishGeneration(w.registry, { ...SEG, generation: 0 })).toBe(true);
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.retention).toEqual({ expiresAt: 1 }); // publishing is not a rewrite
      expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3]);
    });

    it('bulkLoadCrbmGeneration lands on a segment that already has a null-gen row', async () => {
      const w = await world();
      await createNullGenRow(w.registry);
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [7, 8, 9], {
        registry: w.registry,
      });
      expect((await w.registry.get(SEG))!.currentGen).toBe(0);
      expect(await collect(w.reader().segment('s').iterate())).toEqual([7, 8, 9]);
    });

    it('numbering and GC both read the row as "no Cold data", not as generation 0', async () => {
      // The two helpers that do arithmetic on the pointer. `nextGeneration` must offer 0 (a null pointer is not
      // "generation 0 exists", so the first load is still 0), and GC must delete nothing — "below current"
      // selects nothing, and an object present here is indistinguishable from a load about to publish it.
      // `generation-gc.test.ts` owns the full matrix for both; this pins the null-pointer row of it.
      const w = await world();
      await createNullGenRow(w.registry);
      expect(await nextGeneration(SEG, w)).toBe(0);

      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1]); // written, not yet published
      expect(await gcOrphanGenerations(SEG, w, { keep: 0 })).toEqual([]);
      expect(await coldGenerations(w.cold, SEG)).toEqual([0]);
      expect(await nextGeneration(SEG, w)).toBe(1); // …and the object counts, so a retry skips past it
    });

    it('an encrypted bulk-load onto a null-gen row stores the freshly minted DEK on the row', async () => {
      // The publish that advances a null pointer is a FIRST publish, so it has to carry the wrapped DEK exactly
      // like the create path does. If it only moved the pointer, the generation would be encrypted under a key
      // whose wrapping was never stored — written, paid for, and permanently unreadable.
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = await world(keystore);
      await createNullGenRow(w.registry);

      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [4, 5, 6], {
        registry: w.registry,
        keystore,
      });
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.wrappedDeks?.length).toBeGreaterThan(0);
      expect(await collect(w.reader().segment('s').iterate())).toEqual([4, 5, 6]);
    });

    it('reuses a DEK the row already carries instead of minting a second one', async () => {
      // The null-pointer variant of "one DEK per segment" (`encryption-lifecycle.test.ts` pins it across
      // generations). Here there is no generation to infer the key from, only the row: the wrappings on it are
      // what a reader resolves from, so they must be the ones generation 0 was written under. A freshly minted
      // DEK here would leave the generation undecryptable.
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = await world(keystore);
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });

      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
        registry: w.registry,
        keystore,
      });
      expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(minted.wrapped);
      expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3]);
    });

    it('refuses to bulk-load a CLEARTEXT generation onto a row that claims encryption', async () => {
      // Writing cleartext bytes under a row that still advertises `wrappedDeks` is not merely untidy: it makes
      // `destroySegment` emit `segment.erase` — the audit event defined as "unreadable everywhere, backups
      // included" — for plaintext that stays readable from any copy. An audit trail that over-attests is the one
      // failure it exists to prevent, so the state is refused rather than created. The null pointer is what makes
      // this its own case: a writer that only checked the row when the pointer was non-null would take the
      // first-publish path here and skip the check entirely.
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = await world(); // …and this world has no keystore wired
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });

      await expect(
        bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
          registry: w.registry,
        }),
      ).rejects.toBeInstanceOf(KeyUnavailableError);
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBeNull(); // nothing published
      expect(rec.wrappedDeks).toEqual(minted.wrapped); // and the key material is untouched
    });

    it('a publish with no DEK does not mention the field, so key material survives', async () => {
      // The publish step in isolation: a registry patch CLEARS an optional field by mentioning it, so
      // `wrappedDeks: undefined` is not "leave it alone" but "delete it". `publishGeneration` must therefore omit
      // the key entirely when there is nothing to store — the branch for a non-null pointer never touches it, and
      // the two must not disagree.
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = await world();
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: null, wrappedDeks: minted.wrapped });
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3]); // object only, unpublished

      expect(await publishGeneration(w.registry, { ...SEG, generation: 0 })).toBe(true);
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0);
      expect(rec.wrappedDeks).toEqual(minted.wrapped);
    });
  });
});
