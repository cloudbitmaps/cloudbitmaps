import { bulkLoadCrbmGeneration, MemoryColdDriver } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';

// Bulk-load buffers remainders and flushes them per chunk, and this covers the branch that flush creates.
//
// The insert loop used to call the codec once per id, which measured 1,344 ms for 1M ids with no yield point —
// a synchronous stall on Node's only thread. It now buffers and inserts per chunk, which brought the same input
// to 879 ms. The buffer is CAPPED (`BULK_FLUSH_IDS`, 1 << 20) rather than accumulating the whole input, because
// bucketing everything first would hold every remainder as an uncompressed JS number across up to 65,536
// chunks — unbounded in exactly the way this library refuses to be.
//
// That cap introduces a branch nothing else reaches: after a mid-stream flush, a chunk seen AGAIN must
// `addMany` into its existing bitmap instead of constructing a fresh one. Get that wrong — overwrite instead of
// merge — and ids silently vanish, with no error and no failing test, because every existing bulk-load test
// uses inputs far below the threshold. So this test deliberately crosses it.
//
// It is the slowest test in the suite by design; the alternative is leaving a data-loss branch uncovered.
const FLUSH_AT = 1 << 20; // must match BULK_FLUSH_IDS in crbm-cold-source.ts
const KEY = { segment: 'bulk', namespace: 'ns', generation: 1 } as const;

describe('bulk-load across the flush boundary', () => {
  it('merges into an existing chunk after a flush instead of replacing it', async () => {
    // Every id lands in one of 4 chunk keys, so each chunk is guaranteed to be revisited after the flush —
    // which is precisely the branch under test. Remainders are unique per chunk so the expected cardinality is
    // exact rather than approximate.
    const total = FLUSH_AT + 5_000;
    const chunkKeys = [0, 1, 2, 3];
    function* ids(): Iterable<number> {
      for (let i = 0; i < total; i++) {
        const chunkKey = chunkKeys[i % chunkKeys.length] as number;
        yield joinId(chunkKey, Math.floor(i / chunkKeys.length) % 65_536);
      }
    }
    // Distinct (chunkKey, remainder) pairs — what the bitmap should hold once duplicates collapse.
    const expected = new Set<number>();
    for (const id of ids()) expected.add(id);

    const cold = new MemoryColdDriver();
    const res = await bulkLoadCrbmGeneration(cold as never, KEY as never, ids(), {
      codec: roaringCodec,
    } as never);

    // The assertion that catches an overwrite: a replace-instead-of-merge bug loses everything written before
    // the flush, so the cardinality would come out far below this.
    expect((res as { cardinality: number }).cardinality).toBe(expected.size);
    expect(expected.size).toBeGreaterThan(65_000); // sanity: the fixture really is wide enough to matter
  });

  // NOT covered here, deliberately: reading the written object back through a cold source. Wiring one needs a
  // driver shape `MemoryColdDriver` does not satisfy, and the payload round-trip is already exercised at
  // smaller scale by the dr-drill, compaction and key-rotation suites — plus the `.crbm` format carries a
  // per-chunk CRC32C, so silent byte corruption fails closed on read regardless. The failure mode UNIQUE to
  // the flush is losing ids, and the cardinality assertion above is what catches that.
});
