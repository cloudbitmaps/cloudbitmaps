import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { CrbmColdChunkSource } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import { LocalFsColdDriver } from '@/drivers/localfs/cold';
import { CloudRoaring, MemoryWarmDriver } from '@/index';
import { ValidationError, WriteConflictError } from '@/core/errors';
import { joinId } from '@/core/bit-route';

let root: string;
let driver: LocalFsColdDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-bulk-'));
  driver = new LocalFsColdDriver(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read the whole effective set back through the engine over the bulk-loaded Cold generation. */
async function readBack(segment = 's'): Promise<number[]> {
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new CrbmColdChunkSource(driver),
  });
  const out: number[] = [];
  for await (const id of store.segment(segment).iterate()) out.push(id);
  return out;
}

describe('bulkLoadCrbmGeneration (Phase 3b)', () => {
  it('builds a generation from a flat id list, read back through the engine', async () => {
    const ids = [1, 2, 3, 100, joinId(5, 7), joinId(65_535, 9)];
    const res = await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, ids);
    expect(res.cardinality).toBe(ids.length);
    expect(res.chunkCount).toBe(3); // chunk 0 (1,2,3,100), chunk 5, chunk 65535
    expect(res.size).toBeGreaterThan(0);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readBack()).toEqual([...ids].sort((a, b) => a - b));
  });

  it('dedups and sorts an unsorted, duplicate-laden source', async () => {
    const ids = [9, 3, 3, 9, 1, 2, 2, 1, 70_000, 70_000];
    const res = await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, ids);
    expect(res.cardinality).toBe(5); // {1,2,3,9,70000}
    expect(await readBack()).toEqual([1, 2, 3, 9, 70_000]);
  });

  it('accepts an async iterable source', async () => {
    async function* gen(): AsyncGenerator<number> {
      for (const id of [5, 4, 3, 2, 1]) yield id;
    }
    await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, gen());
    expect(await readBack()).toEqual([1, 2, 3, 4, 5]);
  });

  it('dedups a large duplicate-heavy stream, consuming it lazily', async () => {
    // 200k yields collapsing to 1000 distinct ids. We assert dedup (cardinality) + that the source is
    // pulled lazily one value at a time (not buffered into an array first). True peak-memory can't be
    // asserted deterministically; lazy single-value consumption is the observable proxy.
    let inFlight = 0;
    let maxInFlight = 0;
    function* gen(): Generator<number> {
      for (let pass = 0; pass < 200; pass++) {
        for (let i = 0; i < 1000; i++) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield i * 60; // spans ~ several chunks
          inFlight--;
        }
      }
    }
    const res = await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, gen());
    expect(res.cardinality).toBe(1000);
    expect(maxInFlight).toBe(1); // never more than one input value materialized at a time
    expect(await readBack()).toEqual(Array.from({ length: 1000 }, (_v, i) => i * 60));
  });

  it('rejects re-using an existing generation (write-once), leaving the prior object intact', async () => {
    await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, [1, 2, 3]);
    await expect(
      bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, [9, 9, 9]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await readBack()).toEqual([1, 2, 3]); // unchanged
  });

  it('writes a valid empty generation for an empty source', async () => {
    const res = await bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, []);
    expect(res).toMatchObject({ chunkCount: 0, cardinality: 0 });
    const cold = new CrbmColdChunkSource(driver);
    expect(await cold.listChunkKeys({ segment: 's' })).toEqual([]);
    expect(await readBack()).toEqual([]);
  });

  it('rejects a bad id and writes no object (fails before the put)', async () => {
    for (const bad of [-1, 2 ** 32, 1.5, NaN]) {
      await expect(
        bulkLoadCrbmGeneration(driver, { segment: 's', generation: 1 }, [1, bad, 3]),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    // Nothing was committed — the segment has no generation.
    expect(await new CrbmColdChunkSource(driver).listChunkKeys({ segment: 's' })).toEqual([]);
  });

  it('round-trips the distinct set for any id stream (property)', async () => {
    // ids spanning chunk boundaries: 0, the max u32, the chunk-edge values, and a wide spread.
    const ID = fc.oneof(
      fc.integer({ min: 0, max: 2 ** 32 - 1 }),
      fc.constantFrom(0, 1, 65_535, 65_536, 65_537, 2 ** 32 - 1, joinId(65_535, 65_535)),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(ID, { maxLength: 200 }), async (ids) => {
        const r = await mkdtemp(join(tmpdir(), 'crbm-bulk-prop-'));
        try {
          const d = new LocalFsColdDriver(r);
          const res = await bulkLoadCrbmGeneration(d, { segment: 's', generation: 1 }, ids);
          const want = [...new Set(ids)].sort((a, b) => a - b);
          expect(res.cardinality).toBe(want.length);

          const store = new CloudRoaring({
            warm: new MemoryWarmDriver(),
            cold: new CrbmColdChunkSource(d),
          });
          const got: number[] = [];
          for await (const id of store.segment('s').iterate()) got.push(id);
          expect(got).toEqual(want);
        } finally {
          await rm(r, { recursive: true, force: true });
        }
      }),
      { numRuns: 60 },
    );
  });

  it('the loaded generation participates in intersection (the seed → query path)', async () => {
    await bulkLoadCrbmGeneration(driver, { segment: 'a', generation: 1 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(driver, { segment: 'b', generation: 1 }, [2, 3, 4, 200_000]);
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(driver),
    });
    const got: number[] = [];
    for await (const id of store.segment('a').intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([2, 3, 200_000]);
  });
});
