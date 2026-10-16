import { createHash } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { WriteConflictError, TransientError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { counterEntropy, zeroEntropy } from '../helpers/entropy';
import { withoutTokenReports } from '../helpers/no-token-reports';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * Three deletes that were decided from one read of an object's footer, and what they did when another writer of the same
 * cleartext ids had put an object under the same number. A footer names an object by its size and footer checksum; the
 * checksum now covers a write identity every load draws, so two writes of the same ids no longer have the same
 * footer, and a delete that proves "this is mine" by the footer proves it of one write. Each case below deleted the other
 * writer's object when two writes of the same ids were the same bytes, and leaves it now. Gated promises hold each
 * interleaving, and the clock never waits, so a run is the same every time.
 */

const IDS = [3, 5, 8];

/**
 * Each case runs under random-looking identities, where the delete is refused, and again under one all-zero identity
 * for every write, the footer of an object from before identities existed: there the old race is real, which shows the
 * case can fail and what the identity buys.
 */
const MODES = [
  ['distinct identities', false],
  ['all-zero identities', true],
] as const;

/** What the segment reads, through a store over the same drivers. */
async function reads(storage: IStorageDriver, registry: IRegistryDriver): Promise<number[]> {
  const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }), retry: false });
  return collect(store.segment(REF.segment).iterate());
}

describe('the gone-row reclaim across a purge', () => {
  /**
   *   first load   reads no row, writes 0 ([3, 5, 8]), its guard refuses it ── stalls before its reclaim reads the row ──▶
   *   retention    the name is dropped, swept (0 is deleted) and purged: no row
   *   second load  (the same ids) reads no row, takes 0 afresh and writes ── holds its row's creation ──▶ creates it
   *
   * The reclaim reads no row and checks the object under 0 by its footer. Were that footer the one the second load's
   * same ids always write, the first load would delete the second's object, and the row it then creates would name a
   * generation with nothing under it.
   */
  it.each(MODES)(
    '%s: the object the second load wrote is kept or deleted',
    async (_label, zero) => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const entropy = zero ? zeroEntropy : counterEntropy();
      const deps = { storage, registry, codec: roaringCodec, clock, entropy };

      // The first load: its write lands, then its first read of the row after it is answered and held.
      const atReclaim = gate();
      let wrote = false;
      let held = false;
      const l1Storage = Object.create(storage) as IStorageDriver;
      l1Storage.putImmutable = async (key, write) => {
        const put = await storage.putImmutable(key, write);
        wrote = true;
        return put;
      };
      const l1Registry = Object.create(registry) as IRegistryDriver;
      l1Registry.get = async (ref) => {
        const row = await registry.get(ref);
        if (wrote && !held) {
          held = true;
          atReclaim.reach();
          await atReclaim.opened;
        }
        return row;
      };
      const l1 = loadSegment(
        REF,
        IDS,
        { ...deps, storage: l1Storage, registry: l1Registry },
        { guard: { minCardinality: 100 } },
      );
      await atReclaim.reached;
      expect(await generations(storage)).toEqual([0]);

      // The name is swept: the object under 0 goes, and there is no row.
      await storage.delete({ ...REF, generation: 0 });
      expect(await registry.get(REF)).toBeNull();

      // The second load takes 0 afresh and writes the same ids; its row is not created yet.
      const atCreate = gate();
      const l2Registry = Object.create(registry) as IRegistryDriver;
      l2Registry.create = async (ref, record, options) => {
        atCreate.reach();
        await atCreate.opened;
        return registry.create(ref, record, options);
      };
      const l2 = loadSegment(REF, IDS, { ...deps, registry: l2Registry });
      await atCreate.reached;
      expect(await generations(storage)).toEqual([0]);

      // The first load's reclaim reads no row and meets the second load's object under its number.
      atReclaim.open();
      expect(await l1).toMatchObject({ generation: 0, published: false });
      if (zero) {
        // The first load's footer proof matches the second load's object: it deletes it.
        expect(await generations(storage)).toEqual([]);
        atCreate.open();
        await l2.catch(() => undefined);
        return;
      }
      expect(await generations(storage)).toEqual([0]);

      atCreate.open();
      expect(await l2).toMatchObject({ generation: 0, published: true });
      expect((await registry.get(REF))?.currentGen).toBe(0);
      expect(await generations(storage)).toEqual([0]);
      expect(await reads(storage, registry)).toEqual(IDS);
    },
  );
});

/**
 * A storage driver whose version of an object derives from its bytes, as an S3 ETag of an object stored without SSE-KMS
 * or SSE-C does: two objects with the same bytes report the same version, and a delete under a version removes
 * whatever holds those bytes now.
 */
function contentVersioned(storage: IStorageDriver): IStorageDriver {
  const out = Object.create(storage) as IStorageDriver;
  const versionOf = async (key: GenKey): Promise<string> => {
    const whole = await storage.getTail(key, 1 << 30);
    return createHash('md5').update(whole.bytes).digest('hex');
  };
  out.getTail = async (key, maxBytes) => ({
    ...(await storage.getTail(key, maxBytes)),
    version: await versionOf(key),
  });
  out.delete = async (key, options) => {
    if (options?.ifVersion !== undefined && (await versionOf(key)) !== options.ifVersion) {
      throw new WriteConflictError(`the object under ${key.generation} is not the version named`);
    }
    // The check above is the condition; the memory driver's own counter version is the one it applies in turn.
    return storage.delete(key, { ...options, ifVersion: (await storage.getTail(key, 0)).version });
  };
  return out;
}

describe("a refused rewrite's discard on a driver whose versions derive from the bytes", () => {
  const Y = 77;
  /**
   *   load 0       [1, 2, X, Y]
   *   first load   writes 1 ([5, 6]), holds its publish
   *   erasure of X reads 0, writes 2 = [1, 2, Y]; the first load publishes, which refuses its publish; its discard proves 2
   *                by the footer, renews the row ── stalls before its delete ──▶ deletes 2 under the version it read
   *   erasure of Y finds 2 above the pointer and deletes it
   *   second load  [1, 2, Y] reads the renewed row, takes 2 afresh, writes ── publishes
   *
   * The version the discard names is a hash of the bytes it read. With the same bytes under 2, the load's object has that
   * version, and the delete removes the generation the pointer now names.
   */
  it.each(MODES)("%s: the load's generation is kept or deleted", async (_label, zero) => {
    const storage = new MemoryStorageDriver();
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    const entropy = zero ? zeroEntropy : counterEntropy();
    const deps = { storage, registry, codec: roaringCodec, clock, entropy };
    await loadSegment(REF, [1, 2, X, Y], deps);

    const l1AtPublish = gate();
    const l1Registry = Object.create(registry) as IRegistryDriver;
    l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
      if ('currentGen' in patch && patch.currentGen === 1) {
        l1AtPublish.reach();
        await l1AtPublish.opened;
      }
      return registry.compareAndSwap(ref, expected, patch, options);
    };
    const l1 = loadSegment(REF, [5, 6], { ...deps, registry: l1Registry });
    await l1AtPublish.reached;

    let refused = false;
    const e1Registry = Object.create(registry) as IRegistryDriver;
    e1Registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (!refused && 'currentGen' in patch && patch.currentGen === 2) {
        l1AtPublish.open();
        expect(await l1).toMatchObject({ generation: 1, published: true });
        refused = true;
      }
      return registry.compareAndSwap(ref, expected, patch, options);
    };
    const atDelete = gate();
    let stalled = false;
    const versioned = contentVersioned(storage);
    const e1Storage = Object.create(versioned) as IStorageDriver;
    e1Storage.delete = async (key, options) => {
      if (refused && key.generation === 2 && !stalled) {
        stalled = true;
        atDelete.reach();
        await atDelete.opened;
      }
      return versioned.delete(key, options);
    };
    const e1 = eraseIdFromSegment(REF, X, { ...deps, storage: e1Storage, registry: e1Registry });
    await atDelete.reached;

    expect(await eraseIdFromSegment(REF, Y, deps)).toMatchObject({ erased: true });
    expect(await generations(storage)).not.toContain(2);
    const l2: LoadResult = await loadSegment(REF, [1, 2, Y], deps);
    expect(l2).toMatchObject({ generation: 2, published: true });

    atDelete.open();
    expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
    if (zero) {
      // The same bytes, so the same version: the delete removes the generation the pointer names.
      expect(await generations(storage)).not.toContain(2);
      return;
    }
    expect((await registry.get(REF))?.currentGen).toBe(2);
    expect(await generations(storage)).toContain(2);
    expect(await reads(storage, registry)).toEqual([1, 2, Y]);
  });
});

describe('a publish that gets no answer, on a registry that reports no write tokens', () => {
  /**
   *   row         names 0 ([9])
   *   first load  ([3, 5, 8]) writes 1; its publish gets no answer and did not land ── meanwhile ──▶
   *   erasure     (of 8) finds 1 above the pointer holding 8, deletes it
   *   second load (the same ids) takes 1 afresh and publishes it
   *   first load  reads the row: it names 1; its footer proof of "my object under 1" is asked
   *
   * Such a registry cannot say whose write landed, so the first load asks whether the object under 1 is its own. A footer
   * that is the same for the same ids answers yes, and the first load reports `published: true` for the second load's write.
   */
  it.each(MODES)(
    "%s: the other load's write is or is not reported as its own",
    async (_label, zero) => {
      const storage = new MemoryStorageDriver();
      const registry = withoutTokenReports(new MemoryRegistryDriver());
      const entropy = zero ? zeroEntropy : counterEntropy();
      const deps = { storage, registry, codec: roaringCodec, clock, entropy };
      expect(await loadSegment(REF, [9], deps)).toMatchObject({ generation: 0, published: true });

      let armed = true;
      const l1Registry = Object.create(registry) as IRegistryDriver;
      l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
        if (armed && 'currentGen' in patch && patch.currentGen === 1) {
          armed = false;
          expect(await generations(storage)).toEqual([0, 1]);
          await eraseIdFromSegment(REF, 8, deps);
          expect(await generations(storage)).toEqual([0]);
          expect(await loadSegment(REF, IDS, deps)).toMatchObject({
            generation: 1,
            published: true,
          });
          throw new TransientError('no answer, and the write did not land');
        }
        return registry.compareAndSwap(ref, expected, patch, options);
      };
      const first = await loadSegment(
        REF,
        IDS,
        { ...deps, registry: l1Registry },
        { allowEmpty: true },
      ).catch((e: unknown) => e);

      if (zero) {
        // The footer is the same for the same ids, so the first load takes the second load's object for its own.
        expect(first).toMatchObject({ published: true });
        return;
      }
      // Whatever else it reports, it does not claim the second load's publish as its own.
      expect(first).not.toMatchObject({ published: true });
      expect((await registry.get(REF))?.currentGen).toBe(1);
      expect(await reads(storage, registry)).toEqual(IDS);
    },
  );
});
