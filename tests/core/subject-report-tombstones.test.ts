import { randomBytes } from 'node:crypto';
import { CloudRoaring, MemoryStorage, destroySegment } from '@/index';
import type { SegmentRef, SubjectReport } from '@/index';
import type { GenKey, IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { findIdUnderTombstone } from '@/core/erase-id';
import { BudgetExceededError, TransientError } from '@/core/errors';
import { brandAsBackend } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { roaringCodec } from '@/native-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { loadedStore } from '../helpers/loaded';

/**
 * `subjectReport` lists a destroyed segment whose leftover objects still hold the id, under `tombstones`, found by the
 * search `eraseSubject` makes under a tombstone. Every case runs the erasure afterwards, so the report and the erasure
 * are held to agree: what the report lists, the erasure deletes, and what it does not list, the erasure does not find.
 */
const ID = 7;
const NS = 'ns';
const ref = (segment: string, namespace: string | undefined = NS): SegmentRef => ({
  segment,
  namespace,
});

interface Counts {
  list: number;
  getTail: number;
  getRange: number;
  putImmutable: number;
  delete: number;
}

/** The storage driver with each call counted, and `fault` given a chance to reject a tail read. */
function counting(
  base: IStorageDriver,
  fault?: (key: GenKey) => Error | undefined,
): { storage: IStorageDriver; counts: Counts } {
  const counts: Counts = { list: 0, getTail: 0, getRange: 0, putImmutable: 0, delete: 0 };
  const storage = new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const call = value as (...args: unknown[]) => unknown;
      if (prop === 'getTail' && fault !== undefined) {
        return (key: GenKey, ...rest: unknown[]) => {
          counts.getTail += 1;
          const failure = fault(key);
          return failure === undefined ? call.call(target, key, ...rest) : Promise.reject(failure);
        };
      }
      return (...args: unknown[]) => {
        if (prop in counts) counts[prop as keyof Counts] += 1;
        return call.apply(target, args);
      };
    },
  });
  return { storage, counts };
}

async function history(
  backend: MemoryStorage,
  segment: string,
  generations: readonly (readonly number[])[],
  namespace: string | undefined = NS,
): Promise<void> {
  for (const [generation, ids] of generations.entries()) {
    await bulkLoadCrbmGeneration(
      backend.storage,
      { ...ref(segment, namespace), generation },
      [...ids],
      { registry: backend.registry },
    );
  }
}

const cleartextDestroy = (backend: MemoryStorage, segment: string, namespace = NS) =>
  destroySegment(
    ref(segment, namespace),
    { registry: backend.registry },
    { confirmSegment: segment, allowCleartext: true },
  );

async function present(backend: MemoryStorage, segment: string): Promise<number[]> {
  const out: number[] = [];
  for await (const key of backend.storage.list(ref(segment))) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

/** A store over the same backend, its storage counted. */
function storeOver(
  backend: MemoryStorage,
  options: { fault?: (key: GenKey) => Error | undefined } = {},
) {
  const { storage, counts } = counting(backend.storage, options.fault);
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage, registry: backend.registry }),
    retry: false,
  });
  return { store, counts };
}

const names = (refs: readonly SegmentRef[]): string[] => refs.map((r) => r.segment);

describe('subjectReport lists a cleartext tombstone whose leftover object holds the id', () => {
  it('lists it when the newest generation holds the id, and the erasure deletes what it listed', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'gone', [
      [1, 2],
      [ID, 1],
    ]);
    await cleartextDestroy(backend, 'gone');
    const { store } = storeOver(backend);

    const report = await store.subjectReport(ID, { namespace: NS });
    expect(report).toEqual({
      id: ID,
      segments: [],
      tombstones: [ref('gone')],
      scannedSegments: 1,
    });

    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([expect.objectContaining({ segment: 'gone', erased: true })]);
    expect(await present(backend, 'gone')).toEqual([]);
    expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([]);
  });

  it('lists it when only an older generation holds the id', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'gone', [
      [ID, 1],
      [1, 2],
      [3, 4],
    ]);
    await cleartextDestroy(backend, 'gone');
    const { store } = storeOver(backend);

    expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([ref('gone')]);
    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([expect.objectContaining({ segment: 'gone', erased: true })]);
  });

  it('does not list it when no generation holds the id, though the search ran', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'gone', [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    await cleartextDestroy(backend, 'gone');
    const { store, counts } = storeOver(backend);

    const report = await store.subjectReport(ID, { namespace: NS });
    expect(report.tombstones).toEqual([]);
    expect(report.segments).toEqual([]);
    expect(counts.list).toBe(1);
    expect(counts.getTail).toBe(3); // every object was opened: the search ran
    expect(counts.putImmutable + counts.delete).toBe(0);

    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([]);
    expect(await present(backend, 'gone')).toEqual([0, 1, 2]);
  });

  it('does not list a crypto-shredded segment whose objects are still in the bucket', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = await loadedStore({}, { retry: false, encryption: { keystore } });
    for (let i = 0; i < 3; i++) await w.load(ref('sealed'), [ID, i]);
    expect(await present(w.backend, 'sealed')).toEqual([0, 1, 2]);
    expect(
      (await w.store.subjectReport(ID, { namespace: NS })).segments.map((s) => s.segment),
    ).toEqual(['sealed']);
    const shred = await destroySegment(
      ref('sealed'),
      { registry: w.backend.registry },
      { confirmSegment: 'sealed' },
    );
    expect(shred.cryptoShredded).toBe(true);
    expect(await present(w.backend, 'sealed')).toEqual([0, 1, 2]);

    const { store } = storeOver(w.backend);
    const report = await store.subjectReport(ID, { namespace: NS });
    expect(report.tombstones).toEqual([]);
    expect(report.segments).toEqual([]);

    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([]);
    expect(await present(w.backend, 'sealed')).toEqual([0, 1, 2]);
  });

  it('lists a crypto-shredded segment over a cleartext object a writer left under the tombstone', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = await loadedStore({}, { retry: false, encryption: { keystore } });
    for (let i = 0; i < 2; i++) await w.load(ref('sealed'), [ID, i]);
    const shred = await destroySegment(
      ref('sealed'),
      { registry: w.backend.registry },
      { confirmSegment: 'sealed' },
    );
    expect(shred.cryptoShredded).toBe(true);
    // A cleartext object under the tombstone, with no registry write, as a cleartext writer that lost a race leaves.
    await bulkLoadCrbmGeneration(w.backend.storage, { ...ref('sealed'), generation: 5 }, [ID, 3]);

    // A store with a keystore still searches the tombstone: the objects decide, not the store's encryption settings.
    const strict = new CloudRoaring({
      storage: w.backend,
      retry: false,
      encryption: { keystore, required: true },
    });
    const report = await strict.subjectReport(ID, { namespace: NS });
    expect(report.tombstones).toEqual([ref('sealed')]);
    expect(report.segments).toEqual([]);

    const ledger = await strict.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({ segment: 'sealed', erased: true, fromGeneration: 5 }),
    ]);
    expect(await present(w.backend, 'sealed')).toEqual([]); // every object under a tombstone is garbage
    expect((await strict.subjectReport(ID, { namespace: NS })).tombstones).toEqual([]);
  });

  it('lists a tombstone whose row names no generation, over an object a first load left', async () => {
    const backend = new MemoryStorage();
    const { store } = storeOver(backend);
    await store.setRetention(ref('early'), { expiresAt: 2_000_000_000_000 }); // a row minted ahead of its first load
    await store.dropSegment(ref('early'), { confirmSegment: 'early' });
    const row = await backend.registry.get(ref('early'));
    expect(row?.status).toBe('destroyed');
    expect(row?.currentGen).toBeNull();
    await bulkLoadCrbmGeneration(backend.storage, { ...ref('early'), generation: 0 }, [ID, 3]);

    expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([ref('early')]);
    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({ segment: 'early', erased: true }),
    ]);
    expect(await present(backend, 'early')).toEqual([]);
  });

  it('does not list a dropped segment that deleted every generation, and opens nothing', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'dropped', [[ID], [ID, 1]]);
    const { store, counts } = storeOver(backend);
    await store.dropSegment(ref('dropped'), { confirmSegment: 'dropped' });
    expect(await present(backend, 'dropped')).toEqual([]);
    expect((await backend.registry.get(ref('dropped')))?.status).toBe('destroyed');
    counts.list = counts.getTail = counts.getRange = 0;

    const report = await store.subjectReport(ID, { namespace: NS });
    expect(report.tombstones).toEqual([]);
    expect(counts.list).toBe(1);
    expect(counts.getTail + counts.getRange).toBe(0);

    expect((await store.eraseSubject(ID, { namespace: NS })).erasedFrom).toEqual([]);
  });

  it('lists a dropped segment whose sweep left a cleartext object a racing load wrote', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'raced', [[1, 2]]);
    const { store } = storeOver(backend);
    await store.dropSegment(ref('raced'), { confirmSegment: 'raced' });
    // The object a load that was still writing when the sweep listed lands after it, with no registry publish.
    await bulkLoadCrbmGeneration(backend.storage, { ...ref('raced'), generation: 1 }, [ID, 3]);

    expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([ref('raced')]);
    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.erasedFrom).toEqual([
      expect.objectContaining({ segment: 'raced', erased: true }),
    ]);
    expect(await present(backend, 'raced')).toEqual([]);
  });

  describe('the budget', () => {
    async function tenGenerations(): Promise<MemoryStorage> {
      const backend = new MemoryStorage();
      await history(backend, 'long', [[ID, 1], ...Array.from({ length: 9 }, () => [1, 2, 3])]);
      await cleartextDestroy(backend, 'long');
      return backend;
    }

    it('is charged one unit for the row and one for each object opened past the one it names', async () => {
      const backend = await tenGenerations();
      const { store } = storeOver(backend);

      const enough = await store.subjectReport(ID, { namespace: NS, budget: { maxRequests: 10 } });
      expect(enough.tombstones).toEqual([ref('long')]);

      const short = store.subjectReport(ID, { namespace: NS, budget: { maxRequests: 9 } });
      await expect(short).rejects.toBeInstanceOf(BudgetExceededError);
      // Refused part-way through the search, it reports the bound plus one, a lower bound.
      await expect(short).rejects.toMatchObject({
        option: 'budget.maxRequests',
        limit: 9,
        spent: 10,
      });
      const tight = store.subjectReport(ID, { namespace: NS, budget: { maxRequests: 5 } });
      await expect(tight).rejects.toMatchObject({ limit: 5, spent: 6 });
      await expect(short).rejects.toThrow(/subjectReport would fan out to more than 9 units/);

      const free = await store.subjectReport(ID, { namespace: NS, budget: false });
      expect(free.tombstones).toEqual([ref('long')]);

      // The erasure is charged the same: it completes at 10 and refuses at 9, deleting nothing.
      const refused = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 9 } });
      expect(refused.erasedFrom[0]).toMatchObject({ erased: false });
      expect(await present(backend, 'long')).toHaveLength(10);
      const done = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 10 } });
      expect(done.erasedFrom[0]).toMatchObject({ erased: true });
    });
  });

  describe('a fault on the listing', () => {
    const policy = {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffFactor: 1,
      jitter: 'none',
    } as const;
    const failingList = (base: IStorageDriver, failures: () => boolean): IStorageDriver =>
      new Proxy(base, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== 'function') return value;
          if (prop === 'list') {
            return (r: SegmentRef) =>
              failures()
                ? {
                    [Symbol.asyncIterator]: () => ({
                      next: () => Promise.reject(new TransientError('injected list fault')),
                    }),
                  }
                : (value as (r: SegmentRef) => unknown).call(target, r);
          }
          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      });

    it('is retried under the store retry, and the segment is listed', async () => {
      const backend = new MemoryStorage();
      await history(backend, 'flaky', [[ID]]);
      await cleartextDestroy(backend, 'flaky');
      let injected = 0;
      const storage = failingList(backend.storage, () => injected++ === 0);
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry: backend.registry }),
        retry: policy,
      });
      expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([ref('flaky')]);
      expect(injected).toBeGreaterThan(1);
    });

    it('that outlasts the retry rejects the report', async () => {
      const backend = new MemoryStorage();
      await history(backend, 'flaky', [[ID]]);
      await cleartextDestroy(backend, 'flaky');
      const storage = failingList(backend.storage, () => true);
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry: backend.registry }),
        retry: policy,
      });
      await expect(store.subjectReport(ID, { namespace: NS })).rejects.toBeInstanceOf(
        TransientError,
      );
    });
  });

  describe('a fault on an object', () => {
    it('is retried under the store retry, and the segment is listed', async () => {
      const backend = new MemoryStorage();
      await history(backend, 'flaky', [[1], [ID]]);
      await cleartextDestroy(backend, 'flaky');
      let injected = 0;
      const { storage } = counting(backend.storage, (key) =>
        key.generation === 1 && injected++ === 0
          ? new TransientError('injected read fault')
          : undefined,
      );
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry: backend.registry }),
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: 'none' },
      });
      expect((await store.subjectReport(ID, { namespace: NS })).tombstones).toEqual([ref('flaky')]);
      expect(injected).toBeGreaterThan(1); // the fault was met, then the read ran again
    });

    it('that outlasts the retry rejects the report, which never under-reports', async () => {
      const backend = new MemoryStorage();
      await history(backend, 'flaky', [[1], [ID]]);
      await cleartextDestroy(backend, 'flaky');
      const { store } = storeOver(backend, {
        fault: () => new TransientError('injected read fault'),
      });
      await expect(store.subjectReport(ID, { namespace: NS })).rejects.toBeInstanceOf(
        TransientError,
      );
    });
  });

  it('searches only the scope: a tombstone in another namespace costs no listing', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'other', [[ID]], 'elsewhere');
    await cleartextDestroy(backend, 'other', 'elsewhere');
    await history(backend, 'live', [[ID]]);
    const { store, counts } = storeOver(backend);

    const scoped = await store.subjectReport(ID, { namespace: NS });
    expect(scoped).toEqual({
      id: ID,
      segments: [ref('live')],
      tombstones: [],
      scannedSegments: 1,
    });
    expect(counts.list).toBe(0);

    const all = await store.subjectReport(ID, { allNamespaces: true });
    expect(all.segments).toEqual([ref('live')]);
    expect(all.tombstones).toEqual([ref('other', 'elsewhere')]);
    expect((await store.eraseSubject(ID, { allNamespaces: true })).erasedFrom).toHaveLength(2);
  });

  it('keeps a member and a tombstone apart, each in listing order', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'a-live', [[ID]]);
    await history(backend, 'b-gone', [[ID]]);
    await history(backend, 'c-live', [[ID]]);
    await history(backend, 'd-gone', [[ID]]);
    await cleartextDestroy(backend, 'b-gone');
    await cleartextDestroy(backend, 'd-gone');
    const { store } = storeOver(backend);
    const report = await store.subjectReport(ID, { namespace: NS });
    expect(names(report.segments)).toEqual(['a-live', 'c-live']);
    expect(names(report.tombstones)).toEqual(['b-gone', 'd-gone']);
    expect(report.scannedSegments).toBe(4);
  });

  it('has an empty tombstones list when no segment is destroyed', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'live', [[ID]]);
    const { store } = storeOver(backend);
    const report: SubjectReport = await store.subjectReport(ID, { namespace: NS });
    expect(report.tombstones).toEqual([]);
    expect(report.segments).toEqual([ref('live')]);
  });
});

describe('findIdUnderTombstone', () => {
  const deps = (storage: IStorageDriver) => ({ storage, codec: roaringCodec });

  it("returns the newest holder's number and writes and deletes nothing", async () => {
    const backend = new MemoryStorage();
    await history(backend, 'gone', [[ID], [1], [ID, 2]]);
    await cleartextDestroy(backend, 'gone');
    const { storage, counts } = counting(backend.storage);
    expect(await findIdUnderTombstone(ref('gone'), ID, deps(storage))).toBe(2);
    expect(await findIdUnderTombstone(ref('gone'), 99, deps(storage))).toBeNull();
    expect(counts.putImmutable + counts.delete).toBe(0);
    expect(await present(backend, 'gone')).toEqual([0, 1, 2]);
  });

  it('is null for objects sealed under a key', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = await loadedStore({}, { retry: false, encryption: { keystore } });
    await w.load(ref('sealed'), [ID]);
    await destroySegment(
      ref('sealed'),
      { registry: w.backend.registry },
      { confirmSegment: 'sealed' },
    );
    expect(await findIdUnderTombstone(ref('sealed'), ID, deps(w.backend.storage))).toBeNull();
  });
});
