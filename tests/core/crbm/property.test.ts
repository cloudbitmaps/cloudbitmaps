import fc from 'fast-check';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';

/**
 * Property round-trip (F1): `read(write(S)) == S` for arbitrary segments — not just the fixed sample.
 * Random key spacing exercises multi-byte key deltas; random payload sizes (some > 127 B) exercise
 * multi-byte length varints in the index path; random counts exercise large indexes. Seeded for
 * reproducibility (determinism bar V16).
 */
const SEED = 0x510b_a17e;

// A set of chunks with strictly-ascending u16 keys.
const chunksArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 0xffff }), { minLength: 0, maxLength: 200 })
  .chain((keys) => {
    const ascending = [...keys].sort((a, b) => a - b);
    return fc.tuple(
      ...ascending.map((chunkKey) =>
        fc.record({
          chunkKey: fc.constant(chunkKey),
          payload: fc.uint8Array({ minLength: 1, maxLength: 300 }),
          cardinality: fc.integer({ min: 1, max: 65_536 }),
        }),
      ),
    );
  });

describe('CrbmWriter/CrbmReader property round-trip (F1)', () => {
  it('round-trips arbitrary ascending chunk sets byte-for-byte', async () => {
    await fc.assert(
      fc.asyncProperty(
        chunksArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        async (chunks, generation) => {
          const sink = new BufferSink();
          const writer = new CrbmWriter(sink, { generation });
          for (const c of chunks) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
          await writer.finish();

          const reader = await CrbmReader.open(new BufferReader(sink.bytes()));
          expect(reader.generation).toBe(generation);
          expect(reader.chunkKeys()).toEqual(chunks.map((c) => c.chunkKey));
          expect(reader.count()).toBe(chunks.reduce((s, c) => s + c.cardinality, 0));
          for (const c of chunks) {
            expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
          }
        },
      ),
      { numRuns: 300, seed: SEED },
    );
  });
});
