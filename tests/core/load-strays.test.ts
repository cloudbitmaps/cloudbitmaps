import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { nextLoadGeneration } from '@/core/generation-gc';
import { STRAY_MARGIN, floorOf, reportStrays, straysOf } from '@/core/generation-floor';
import { rollbackSegment } from '@/core/rollback';
import { NotFoundError, TransientError } from '@/core/errors';
import type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { storeCodec } from '../helpers/store-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';

/**
 * A listed generation number far above anything the row names (its pointer, its ledger, its leases) is a stray: a
 * load and the erasure rewrite number past what the row names and what lies near it, never past the stray, and a
 * load reports it. Nothing deletes, overwrites or takes the stray's number.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const MAX = Number.MAX_SAFE_INTEGER;
const EMPTY = { count: 0, generations: [] };

const backends: Array<{
  name: string;
  make: () => Promise<{ storage: IStorageDriver; done: () => Promise<void> }>;
}> = [
  {
    name: 'memory',
    make: async () => ({ storage: new MemoryStorageDriver(), done: async () => undefined }),
  },
  {
    name: 'localfs',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'crbm-strays-'));
      return {
        storage: new LocalFsStorageDriver(root),
        done: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
];

/** A storage whose existence check cannot answer, so every load numbers by the listing. */
function checkFails(inner: IStorageDriver): IStorageDriver {
  return new Proxy(inner, {
    get(t, p, rx) {
      const value = Reflect.get(t, p, rx) as unknown;
      if (p !== 'getTail') return value;
      return (key: GenKey, maxBytes: number) =>
        maxBytes === 0
          ? Promise.reject(new TransientError('503 SlowDown'))
          : inner.getTail(key, maxBytes);
    },
  }) as IStorageDriver;
}

const plant = (storage: IStorageDriver, generation: number): Promise<unknown> =>
  bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [7]);

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe.each(backends)('a planted high generation number blocks nothing ($name)', ({ make }) => {
  let storage: IStorageDriver;
  let done: () => Promise<void>;
  let registry: IRegistryDriver;
  beforeEach(async () => {
    ({ storage, done } = await make());
    registry = new MemoryRegistryDriver();
  });
  afterEach(() => done());
  const deps = () => ({ storage, registry, entropy: testEntropy, codec: storeCodec });

  it('the largest number plus currentGen + 1: the load publishes past currentGen + 1, reports it, leaves it, and the next load works', async () => {
    for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, deps());
    await plant(storage, 3);
    await plant(storage, MAX);
    const r = await loadSegment(SEG, [1, 2, 3, 4], deps());
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(r.strays).toEqual({ count: 1, generations: [MAX] });
    expect(await generations(storage)).toContain(MAX);
    expect(r.collected).not.toContain(MAX);
    const next = await loadSegment(SEG, [1, 2, 3, 4, 5], deps());
    expect(next).toMatchObject({ generation: 5, published: true });
    expect(await generations(storage)).toContain(MAX);
  });

  it('the erasure rewrite numbers past a planted maximum too, and leaves it', async () => {
    await loadSegment(SEG, [1, 2, 3], deps());
    await plant(storage, 1);
    await plant(storage, MAX);
    const res = await eraseIdFromSegment(SEG, 2, deps());
    expect(res.erased).toBe(true);
    expect(await generations(storage)).toContain(MAX);
    const row = await registry.get(SEG);
    expect(row?.currentGen).toBeLessThan(MAX);
  });

  it('a sparse plant far above numbers within the margin and is reported', async () => {
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, deps());
    await plant(storage, 1 + 5000);
    const r = await loadSegment(SEG, [1, 2, 3], { ...deps(), storage: checkFails(storage) });
    expect(r.generation).toBeLessThanOrEqual(1 + 1 + STRAY_MARGIN);
    expect(r.generation).toBe(2);
    expect(r.strays).toEqual({ count: 1, generations: [5001] });
  });

  it('a stray is no candidate for the ledger seed, and the generations it would displace stay', async () => {
    for (let g = 0; g <= 3; g++) await loadSegment(SEG, [g + 1], deps(), { keep: 5 });
    // A row with a pointer and no ledger: the registry was repaired by hand to name 2, with 3 left above it.
    const row = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, row.token, { currentGen: 2 });
    expect((await registry.get(SEG))?.knownGens).toBeUndefined();
    const run = [2 + 1025, 2 + 1026, 2 + 1027]; // a contiguous run just past the margin
    for (const g of [2 + 5000, ...run]) await plant(storage, g);
    // currentGen + 1 is taken by the orphan 3, so the listing numbers.
    const r = await loadSegment(SEG, [9], deps(), { keep: 2 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(r.strays).toEqual({ count: 4, generations: [1027, 1028, 1029, 5002] });
    const known = (await registry.get(SEG))?.knownGens?.map((e) => e.generation) ?? [];
    expect([...known].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    // The bucket, not the return value: nothing genuine in the window was displaced, nothing planted was taken.
    const left = await generations(storage);
    expect(left).toEqual(expect.arrayContaining([2, 3, 4, 1027, 1028, 1029, 5002]));
  });

  it('a run that begins at the margin is walked: the load numbers past it, reports nothing, and the seed never names it', async () => {
    for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, deps(), { keep: 5 });
    // A row with a pointer and no ledger: the registry was repaired by hand to name 1, with 2 left above it.
    const row = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, row.token, { currentGen: 1 });
    expect((await registry.get(SEG))?.knownGens).toBeUndefined();
    const run = [1 + STRAY_MARGIN, 2 + STRAY_MARGIN, 3 + STRAY_MARGIN];
    for (const g of run) await plant(storage, g);
    const r = await loadSegment(SEG, [9], deps(), { keep: 5 });
    expect(r).toMatchObject({ generation: 4 + STRAY_MARGIN, published: true });
    expect(r.strays).toEqual(EMPTY);
    const known = (await registry.get(SEG))?.knownGens?.map((e) => e.generation) ?? [];
    expect(known).not.toContain(2 + STRAY_MARGIN);
    expect(known).not.toContain(3 + STRAY_MARGIN);
    expect(known).toContain(4 + STRAY_MARGIN);
  });

  it('nothing deletes a stray, and a rollback onto it is refused without allowUnknown', async () => {
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, deps());
    await plant(storage, 5000);
    const r = await loadSegment(SEG, [1, 2, 3], { ...deps(), storage: checkFails(storage) });
    expect(r.strays.count).toBe(1);
    await loadSegment(SEG, [1, 2, 3, 4], deps());
    expect(await generations(storage)).toContain(5000);
    await expect(rollbackSegment(SEG, 5000, { storage, registry }, {})).rejects.toBeInstanceOf(
      Error,
    );
    expect((await registry.get(SEG))?.currentGen).toBeLessThan(5000);
  });

  it('every return path carries strays: published, refused, a load that never listed, and a lost race', async () => {
    await loadSegment(SEG, [1], deps());
    // A load that finds the next number free never lists: the empty value.
    const quiet = await loadSegment(SEG, [1, 2], deps());
    expect(quiet.strays).toEqual(EMPTY);
    await plant(storage, 9000);
    // Refused (an empty input over a non-empty segment) after listing: the stray is still reported.
    const refused = await loadSegment(SEG, [], { ...deps(), storage: checkFails(storage) });
    expect(refused).toMatchObject({ published: false, reason: 'empty' });
    expect(refused.strays).toEqual({ count: 1, generations: [9000] });
    // Lost race: another load's object holds the number this load numbered.
    await plant(storage, 2);
    const racing = new Proxy(storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) =>
          maxBytes === 0 && key.generation === 2
            ? Promise.reject(new NotFoundError('absent'))
            : storage.getTail(key, maxBytes);
      },
    }) as IStorageDriver;
    const first = await loadSegment(SEG, [1, 2, 3], { ...deps(), storage: racing });
    expect(first).toMatchObject({ generation: 2, published: false, reason: 'superseded' });
    expect(first.strays).toEqual(EMPTY);
  });
});

/** A storage that lists `held` and cannot answer an existence check, so the load numbers by the listing. */
function listing(held: readonly number[]): IStorageDriver {
  return {
    getTail: () => Promise.reject(new TransientError('503 SlowDown')),
    list: async function* () {
      for (const generation of [...held].sort((a, b) => a - b)) yield { ...SEG, generation };
    },
  } as unknown as IStorageDriver;
}

const row = (r: Partial<RegistryRecord>): RegistryRecord => r as RegistryRecord;
const number = (held: readonly number[], r: RegistryRecord | null) =>
  nextLoadGeneration(SEG, { storage: listing(held), registry: undefined as never } as never, r);

describe('which listed numbers a load numbers past', () => {
  it('a crash-left orphan at currentGen + 1, then another at + 2: the next load numbers past both', async () => {
    const n = await number([5, 6, 7], row({ currentGen: 4 }));
    expect(n).toMatchObject({ generation: 8, checked: false, strays: EMPTY });
  });

  it('the boundary: floor + 1024 counts, floor + 1025 is a stray', async () => {
    const at = await number([10 + STRAY_MARGIN], row({ currentGen: 10 }));
    expect(at).toMatchObject({ generation: 10 + STRAY_MARGIN + 1, strays: EMPTY });
    const past = await number([10 + STRAY_MARGIN + 1, 11], row({ currentGen: 10 }));
    expect(past.generation).toBe(12);
    expect(past.strays).toEqual({ count: 1, generations: [10 + STRAY_MARGIN + 1] });
  });

  it('a rollback leftover named by the ledger, or unnamed within the margin, is numbered past', async () => {
    const known = [1, 2, 600].map((generation) => ({ generation, footerCrc: 0 }));
    const named = await number([2, 600], row({ currentGen: 2, knownGens: known }));
    expect(named.generation).toBe(601);
    const unnamed = await number([2, 700], row({ currentGen: 2 }));
    expect(unnamed.generation).toBe(701);
  });

  it('a lease on a generation above the pointer counts, live or ended, and is never a stray', async () => {
    const leases = [{ holder: 'a'.repeat(16), generation: 5000, until: 0 }];
    const n = await number([5000, 5001], row({ currentGen: 2, leases }));
    expect(n).toMatchObject({ generation: 5002, strays: EMPTY });
    expect(floorOf(row({ currentGen: 2, leases }))).toBe(5000);
  });

  it('no row, a row with no pointer, and a row with no ledger start at 0 and treat 1024 and above as far', async () => {
    for (const r of [null, row({ currentGen: null })]) {
      const n = await number([1024, 5000], r);
      expect(n).toMatchObject({ generation: 0, strays: { count: 2, generations: [1024, 5000] } });
    }
    expect(Object.isFrozen((await number([], null)).strays)).toBe(true);
  });

  it('the listing handed to the seed holds the near numbers only, not a run the walk climbed', async () => {
    const n = await number(
      [10 + STRAY_MARGIN, 11 + STRAY_MARGIN, 12 + STRAY_MARGIN],
      row({ currentGen: 10 }),
    );
    expect(n).toMatchObject({ generation: 13 + STRAY_MARGIN, strays: EMPTY });
    expect(n.listed).toEqual([10 + STRAY_MARGIN]);
  });

  it('a contiguous run past the margin is walked in one load, as a restored registry needs', async () => {
    const run = Array.from({ length: 5000 }, (_, i) => 6 + i);
    const n = await number(run, row({ currentGen: 5 }));
    expect(n).toMatchObject({ generation: 5006, strays: EMPTY });
    const gap = [...run.slice(0, 2000), ...run.slice(2001)];
    const g = await number(gap, row({ currentGen: 5 }));
    expect(g.generation).toBe(2006);
    expect(g.strays.count).toBe(5000 - 2001);
    expect(g.strays.generations[0]).toBe(2007);
  });

  it('a stray report holds the lowest 64, ascending, and the count carries the rest', () => {
    const many = Array.from({ length: 500 }, (_, i) => 100_000 - i);
    const r = reportStrays(straysOf(many, null));
    expect(r.count).toBe(500);
    expect(r.generations).toHaveLength(64);
    expect(r.generations[0]).toBe(99_501);
    expect([...r.generations].sort((a, b) => a - b)).toEqual(r.generations);
  });

  // The generators seldom put a number exactly at the margin, so the walk itself is held by the run tests above.
  it('the number is never one a listed object holds, over random rows and listings', async () => {
    const gen = fc.oneof(
      fc.nat(30),
      fc.integer({ min: 0, max: 5000 }),
      fc.constant(MAX),
      fc.constant(MAX - 1),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.nat(40), { nil: null }),
        fc.uniqueArray(gen, { maxLength: 40 }),
        fc.array(gen, { maxLength: 4 }),
        async (pointer, held, named) => {
          const r = row({
            currentGen: pointer,
            knownGens: named.map((generation) => ({ generation, footerCrc: 0 })),
          });
          let n;
          try {
            n = await number(held, pointer === null ? row({ currentGen: null }) : r);
          } catch (err) {
            // Only the row's own numbers (or a run up to the largest) can leave none.
            expect((err as Error).message).toMatch(/no generation number left/);
            return;
          }
          expect(held).not.toContain(n.generation);
          expect(Number.isSafeInteger(n.generation)).toBe(true);
          expect(n.generation).toBeGreaterThan(pointer ?? -1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
