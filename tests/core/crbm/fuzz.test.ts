import fc from 'fast-check';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';
import { CloudRoaringError } from '@/core/errors';

/**
 * Fuzz the untrusted-bytes boundary (finding V7). Every byte a reader sees is attacker-controlled, so
 * the contract is: parsing/reading arbitrary or corrupted bytes either succeeds with self-consistent
 * data, or fails with a **typed** `CloudRoaringError` — never an uncaught `RangeError`, infinite loop,
 * or native crash.
 */
const PROBE_KEYS = [0, 1, 5, 256, 4096, 65_535];

// Pinned so a failing run is reproducible (determinism bar V16).
const SEED = 0x000b_0a7f;

async function exercise(bytes: Uint8Array): Promise<void> {
  let reader: CrbmReader;
  try {
    reader = await CrbmReader.open(new BufferReader(bytes));
  } catch (err) {
    if (!(err instanceof CloudRoaringError)) throw err;
    return;
  }
  for (const k of PROBE_KEYS) {
    try {
      await reader.getChunk(k);
    } catch (err) {
      if (!(err instanceof CloudRoaringError)) throw err;
    }
  }
}

async function validFile(): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 3 });
  await writer.addChunk(0, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), 4);
  await writer.addChunk(256, Uint8Array.of(9, 10, 11), 2);
  await writer.addChunk(65_535, Uint8Array.of(12), 1);
  await writer.finish();
  return sink.bytes();
}

describe('fuzz the .crbm read boundary (V7)', () => {
  it('arbitrary bytes only ever raise typed CloudRoaringErrors', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 400 }), async (bytes) => {
        await exercise(bytes);
      }),
      { numRuns: 600, seed: SEED },
    );
  });

  it('a single flipped/spliced byte in a valid file never crashes the reader', async () => {
    const base = await validFile();
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: base.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        async (index, xor) => {
          const corrupted = base.slice();
          corrupted[index] = corrupted[index]! ^ xor;
          await exercise(corrupted);
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });
});
