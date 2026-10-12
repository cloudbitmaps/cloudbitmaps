import { randomBytes } from 'node:crypto';
import { TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { objectFingerprint } from '../helpers/fingerprint';

/**
 * What a seed reads from the bucket, and how: each generation it keeps has its footer checksum read (a 104-byte tail
 * read) from its object, the superseded one's too, under the store's read retry and a few at a time; a read that
 * still fails fails the load and leaves nothing of it in the bucket; a superseded generation a clear summary
 * describes with another checksum is left out. Clear and encrypted rows alike.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const NO_WAIT = {
  clock: { now: () => 0, sleep: () => Promise.resolve() },
  rng: { next: () => 0.5 },
};

function world(encrypted: boolean) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  return { storage, registry, deps: { storage, registry, codec: roaringCodec, keystore } };
}
type W = ReturnType<typeof world>;

async function gens(w: W): Promise<number[]> {
  const out: number[] = [];
  for await (const k of w.storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}
const crcOf = async (w: W, generation: number): Promise<number> => {
  const f = await objectFingerprint(w.storage, { ...SEG, generation });
  return Number(f.slice(f.indexOf(':') + 1));
};
/** Two loads, then the ledger dropped as a registry of your own that does not store it would: pointer at 1. */
async function twoLoadsNoLedger(w: W): Promise<void> {
  for (let i = 0; i < 2; i++) await loadSegment(SEG, [i, 100 + i], w.deps, { keep: 3 });
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
}

/** `storage`, with each 104-byte tail read passed to `around`. */
function aroundFooters(
  storage: MemoryStorageDriver,
  around: (key: GenKey, read: () => Promise<unknown>) => Promise<unknown>,
): IStorageDriver {
  return new Proxy(storage as IStorageDriver, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      if (p !== 'getTail') return value.bind(t);
      return (key: GenKey, max: number) =>
        max === 104
          ? around(key, () => (value as IStorageDriver['getTail']).call(t, key, max))
          : (value as IStorageDriver['getTail']).call(t, key, max);
    },
  });
}

describe.each([
  { name: 'cleartext', encrypted: false },
  { name: 'encrypted', encrypted: true },
])('a seed over a row with no ledger: $name', ({ encrypted }) => {
  it('retries a throttled footer read under the store’s read retry, and publishes', async () => {
    const w = world(encrypted);
    await twoLoadsNoLedger(w);
    let failed = 0;
    const storage = aroundFooters(w.storage, (key, read) => {
      if (key.generation === 0 && failed++ < 2) return Promise.reject(new TransientError('503'));
      return read();
    });
    const r = await loadSegment(
      SEG,
      [7, 8],
      { ...w.deps, storage, readRetry: NO_WAIT },
      { keep: 3 },
    );
    expect(r).toMatchObject({ generation: 2, published: true });
    expect(failed).toBe(3);
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toEqual([0, 1, 2]);
  });

  it('fails the load with the read’s error when it never succeeds, and leaves its own object out of the bucket', async () => {
    const w = world(encrypted);
    await twoLoadsNoLedger(w);
    const storage = aroundFooters(w.storage, (key, read) =>
      key.generation === 0 ? Promise.reject(new TransientError('503')) : read(),
    );
    const before = await w.registry.get(SEG);
    await expect(
      loadSegment(SEG, [7, 8], { ...w.deps, storage, readRetry: NO_WAIT }, { keep: 3 }),
    ).rejects.toBeInstanceOf(TransientError);
    // Nothing was published and the number the load took is free again, so its object is not an orphan above the pointer.
    expect(await gens(w)).toEqual([0, 1]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect((await w.registry.get(SEG))!.token).toBe(before!.token);
  });

  it('reads the superseded generation’s checksum from its footer, and records the object’s own', async () => {
    const w = world(encrypted);
    await twoLoadsNoLedger(w);
    const read: number[] = [];
    const storage = aroundFooters(w.storage, (key, go) => {
      read.push(key.generation);
      return go();
    });
    await loadSegment(SEG, [7, 8], { ...w.deps, storage }, { keep: 3 });
    expect(read).toContain(1);
    const ledger = (await w.registry.get(SEG))!.knownGens!;
    expect(ledger.map((e) => e.generation)).toEqual([0, 1, 2]);
    for (const e of ledger)
      expect(e.footerCrc, `generation ${e.generation}`).toBe(await crcOf(w, e.generation));
  });

  it('runs its footer reads a few at a time, and keeps the entries in order', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 20; g++) {
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [5000 + g]);
    }
    await w.registry.create(SEG, { currentGen: 19 });
    let inFlight = 0;
    let peak = 0;
    const storage = aroundFooters(w.storage, async (_key, go) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await go();
      } finally {
        inFlight--;
      }
    });
    await loadSegment(SEG, [1, 2], { ...w.deps, storage }, { keep: 20 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    // Ascending by number with the superseded generation last, then the generation the load published.
    const numbers = (await w.registry.get(SEG))!.knownGens!.map((e) => e.generation);
    expect(numbers).toEqual([...Array.from({ length: 19 }, (_, i) => i), 19, 20]);
  });
});

describe('a seed over a row whose clear summary disagrees with the superseded object', () => {
  it('leaves that generation out of the ledger, since the row and the bucket disagree about the number', async () => {
    const w = world(false);
    await twoLoadsNoLedger(w);
    // Another object under the number the row's summary describes.
    await w.storage.delete({ ...SEG, generation: 1 });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [999, 1000, 1001]);
    await loadSegment(SEG, [7, 8], w.deps, { keep: 3 });
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toEqual([0, 2]);
  });
});

describe('a seed over a row with no ledger and a large keep', () => {
  it('names at most 127 generations below the one it publishes', async () => {
    const w = world(false);
    for (let g = 0; g < 200; g++) {
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [5000 + g]);
    }
    await w.registry.create(SEG, { currentGen: 199 });
    await loadSegment(SEG, [1, 2], w.deps, { keep: 1000 });
    const numbers = (await w.registry.get(SEG))!.knownGens!.map((e) => e.generation);
    // The newest 127 by number below 200 hold the superseded generation 199 (last), and the new generation follows.
    expect(numbers).toHaveLength(128);
    expect(numbers.slice(0, 126)).toEqual(Array.from({ length: 126 }, (_, i) => 73 + i));
    expect(numbers.slice(126)).toEqual([199, 200]);
  });
});
