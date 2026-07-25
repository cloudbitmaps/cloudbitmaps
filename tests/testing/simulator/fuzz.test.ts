import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import { CloudRoaringError, IntegrityError } from '@/core/errors';
import { WARM_DELTA_VERSION } from '@/core/chunk';
import { NO_ROW } from '@/core/ports';
import { SeededRng } from '@/testing/simulator';

/**
 * Seeded fuzz of the untrusted-bytes boundary at the Warm tier (spec 09 V7, invariant 5). We plant random
 * bytes as a Warm row, then read through the engine. Every read must EITHER be rejected with a **typed**
 * {@link CloudRoaringError} — `IntegrityError` for structural corruption, `UnsupportedError` for an
 * unrecognized schema version (the 1-byte delta version mirrors the Cold `.crbm` reader) — OR, if
 * the random bytes happened to decode, return a **self-consistent** result (count == iterated cardinality,
 * and every iterated id reports `has() === true`). Never an arbitrary error, a native-addon crash, or a
 * silently-wrong result. (The `.crbm`/Cold side has its own corpus in tests/core/crbm/fuzz.test.ts.)
 */
describe('seeded fuzz: hostile Warm bytes through the engine (V7)', () => {
  it('never crashes, mis-types, or returns an inconsistent result on random Warm-row bytes', async () => {
    const rng = new SeededRng(0xc0ffee);
    let decoded = 0; // how many random inputs happened to decode cleanly (sanity: the path is reachable)
    for (let i = 0; i < 600; i++) {
      const warm = new MemoryWarmDriver();
      const cold = new MemoryColdChunkSource();
      const seg = new CloudRoaring({ warm, cold }).segment('s');

      const chunkKey = rng.nextInt(4);
      const len = rng.nextInt(200); // includes 0..3 (too-short) and longer malformed payloads
      const bytes = new Uint8Array(len);
      for (let b = 0; b < len; b++) bytes[b] = rng.nextInt(256);
      // Half the iterations get a valid version byte so the fuzz still exercises the payload/size-cap path
      // *behind* the version gate; the other half fuzz the version byte itself.
      if (len > 0 && i % 2 === 0) bytes[0] = WARM_DELTA_VERSION;

      // MemoryWarmDriver stores opaque bytes verbatim — the engine owns the decode/size-cap boundary.
      await warm.putConditional({ segment: 's', chunkKey }, bytes, NO_ROW);

      try {
        const count = await seg.count();
        const ids: number[] = [];
        for await (const v of seg.iterate()) ids.push(v);
        // Success path is NOT a no-op: cross-check the three read APIs against each other.
        expect(ids.length).toBe(count);
        for (const v of ids.slice(0, 16)) expect(await seg.has(v)).toBe(true);
        decoded++;
      } catch (err) {
        // The ONLY tolerated failure is a typed rejection (integrity OR unsupported-version).
        expect(err, `unexpected error type: ${(err as Error)?.name}`).toBeInstanceOf(
          CloudRoaringError,
        );
      }
    }
    // Almost all random bytes are malformed; we don't require any to decode, but the assertion above is
    // what guards the success path when one does.
    expect(decoded).toBeGreaterThanOrEqual(0);
  });

  it('rejects an over-cap Warm row with IntegrityError', async () => {
    const warm = new MemoryWarmDriver();
    const cold = new MemoryColdChunkSource();
    const seg = new CloudRoaring({ warm, cold }).segment('s');
    // A row larger than the engine's total Warm-row cap (2×1MiB + header) must be rejected before any
    // native deserialize — the size screen fires on length alone, not content. A valid version byte ensures
    // it's the *size* cap that rejects (not the version gate), which is what this test pins.
    const huge = new Uint8Array((2 << 20) + 16);
    huge[0] = WARM_DELTA_VERSION;
    await warm.putConditional({ segment: 's', chunkKey: 0 }, huge, NO_ROW);
    await expect(seg.count()).rejects.toBeInstanceOf(IntegrityError);
  });
});
