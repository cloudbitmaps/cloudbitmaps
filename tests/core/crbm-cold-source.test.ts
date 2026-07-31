import { mkdtemp, open as fsOpen, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrbmColdChunkSource, writeCrbmGeneration } from '@/core/crbm-cold-source';
import { LocalFsColdDriver } from '@/drivers/localfs/cold';
import { coldObjectPath } from '@/drivers/localfs/paths';
import { SafeBitmap } from '@/roaring-codec';
import { CapabilityError, IntegrityError, ValidationError } from '@/core/errors';
import type { IColdDriver } from '@/core/ports';

let root: string;
let driver: LocalFsColdDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-bridge-'));
  driver = new LocalFsColdDriver(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bm = (...vals: number[]): SafeBitmap => SafeBitmap.fromValues(vals);

describe('CrbmColdChunkSource + writeCrbmGeneration', () => {
  it('run-encodes a cold generation: far smaller on disk, byte-identical set on the way back', async () => {
    // `writeCrbmGeneration` calls `bitmap.optimize?.()` before serializing. Roaring's third container type is a
    // RUN, and no implementation selects it on its own — it takes an explicit pass, and nothing was making it.
    // So run-shaped ids were stored at array or bitset prices: measured at 570x for a contiguous range.
    //
    // This asserts BOTH halves, because size alone is not the property that matters. A re-encoding that lost or
    // gained a single id would also be "smaller".
    const contiguous = Array.from({ length: 50_000 }, (_, i) => i);
    const unoptimized = SafeBitmap.fromValues(contiguous).serialize().length;

    await writeCrbmGeneration(driver, { segment: 'runs', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues(contiguous) },
    ]);

    // The written object is dramatically smaller than the same chunk serialized without the pass. A loose bound
    // (10x) rather than the measured ~500x, so a future roaring release tuning its heuristics cannot fail this
    // test for being *differently* efficient — the claim under test is "run-encoding happens", not an exact size.
    const cold = new CrbmColdChunkSource(driver);
    const chunk = await cold.getChunk({ segment: 'runs', chunkKey: 0 });
    expect(chunk).not.toBeNull();
    expect(chunk!.length * 10).toBeLessThan(unoptimized);

    // And the set survives exactly: same cardinality, same bounds, and a member/non-member probe either side.
    const back = SafeBitmap.safeDeserialize(chunk!, 1 << 26);
    expect(back.size).toBe(contiguous.length);
    expect(back.toArray()).toEqual(contiguous);
    expect(back.has(0)).toBe(true);
    expect(back.has(49_999)).toBe(true);
    expect(back.has(50_000)).toBe(false);
  });

  it('leaves a sparse generation byte-identical — the pass is never a losing trade', async () => {
    // The other half of the contract: `optimize()` must not make anything WORSE. Roaring keeps whichever
    // encoding is smaller per container, so ids with no runs in them come out unchanged rather than paying for
    // a speculative conversion. Without this, "smaller on run-shaped data" would be an untested half-claim.
    const sparse = [3, 901, 5_012, 20_444, 61_003];
    const direct = SafeBitmap.fromValues(sparse).serialize();

    await writeCrbmGeneration(driver, { segment: 'sparse', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues(sparse) },
    ]);
    const cold = new CrbmColdChunkSource(driver);
    const chunk = await cold.getChunk({ segment: 'sparse', chunkKey: 0 });
    // Contents, not identity: the driver hands back a Buffer (a Uint8Array subclass), which `toEqual`
    // distinguishes from the Uint8Array `serialize()` returns even when every byte matches.
    expect([...chunk!]).toEqual([...direct]);
    expect(SafeBitmap.safeDeserialize(chunk!, 1 << 26).toArray()).toEqual(sparse);
  });

  it('round-trips bitmaps through an on-disk generation', async () => {
    await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
      { chunkKey: 5, bitmap: bm(7) },
    ]);
    const cold = new CrbmColdChunkSource(driver);

    expect((await cold.listChunkKeys({ segment: 's' })).sort((a, b) => a - b)).toEqual([0, 5]);
    const bytes = await cold.getChunk({ segment: 's', chunkKey: 0 });
    expect(bytes).not.toBeNull();
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([1, 2, 3]);
    expect(await cold.getChunk({ segment: 's', chunkKey: 999 })).toBeNull();
  });

  it('skips empty bitmaps (empty chunks are never stored)', async () => {
    await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
      { chunkKey: 0, bitmap: bm(1) },
      { chunkKey: 1, bitmap: SafeBitmap.empty() },
    ]);
    const cold = new CrbmColdChunkSource(driver);
    expect(await cold.listChunkKeys({ segment: 's' })).toEqual([0]);
  });

  it('rejects duplicate chunkKeys in one generation', async () => {
    await expect(
      writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
        { chunkKey: 0, bitmap: bm(1) },
        { chunkKey: 0, bitmap: bm(2) },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns empty/null for a segment with no generations', async () => {
    const cold = new CrbmColdChunkSource(driver);
    expect(await cold.listChunkKeys({ segment: 'ghost' })).toEqual([]);
    expect(await cold.getChunk({ segment: 'ghost', chunkKey: 0 })).toBeNull();
  });

  const read = async (cold: CrbmColdChunkSource, chunkKey: number): Promise<number[]> =>
    SafeBitmap.safeDeserialize(
      (await cold.getChunk({ segment: 's', chunkKey }))!,
      1 << 20,
    ).toArray();

  it('resolves the latest generation across gaps and pins it per source', async () => {
    await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
      { chunkKey: 0, bitmap: bm(1) },
    ]);
    await writeCrbmGeneration(driver, { segment: 's', generation: 5 }, [
      { chunkKey: 0, bitmap: bm(9) },
    ]);
    const cold = new CrbmColdChunkSource(driver);
    expect(await read(cold, 0)).toEqual([9]); // latest = gen 5, not 1

    // A new generation written later is NOT seen by this source (immutable snapshot)…
    await writeCrbmGeneration(driver, { segment: 's', generation: 6 }, [
      { chunkKey: 0, bitmap: bm(9, 10) },
    ]);
    expect(await read(cold, 0)).toEqual([9]);
    // …but a fresh source picks it up.
    expect(await read(new CrbmColdChunkSource(driver), 0)).toEqual([9, 10]);
  });

  it('surfaces a corrupt on-disk .crbm as IntegrityError', async () => {
    await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
      { chunkKey: 0, bitmap: bm(1, 2) },
    ]);
    // Flip the first payload byte (payload region starts at offset 8) → chunk CRC mismatch.
    const handle = await fsOpen(coldObjectPath(root, { segment: 's', generation: 1 }), 'r+');
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, 8);
    buf[0]! ^= 0xff;
    await handle.write(buf, 0, 1, 8);
    await handle.close();

    const cold = new CrbmColdChunkSource(driver);
    await expect(cold.getChunk({ segment: 's', chunkKey: 0 })).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it('does not cache a failed open — a later read retries', async () => {
    await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, [
      { chunkKey: 0, bitmap: bm(1) },
    ]);
    let calls = 0;
    const flaky: IColdDriver = {
      capabilities: () => driver.capabilities(),
      putImmutable: (k, w) => driver.putImmutable(k, w),
      getRange: (k, o, l) => driver.getRange(k, o, l),
      getTail: (k, m) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('transient')) : driver.getTail(k, m);
      },
      delete: (k) => driver.delete(k),
      list: (r) => driver.list(r),
    };
    const cold = new CrbmColdChunkSource(flaky);
    await expect(cold.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow('transient');
    expect(await read(cold, 0)).toEqual([1]); // retried, not poisoned-cached
  });

  it('fails fast if the cold driver lacks range reads', () => {
    const noRange = {
      capabilities: () => ({ rangeRead: false, maxObjectBytes: 1 }),
    } as unknown as IColdDriver;
    expect(() => new CrbmColdChunkSource(noRange)).toThrow(CapabilityError);
  });
});
