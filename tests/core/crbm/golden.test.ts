import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';

/**
 * Golden-file corpus (finding V6). `tests/golden/v1.0-basic.crbm` pins the exact v1.0 byte layout
 * forever — it's the artifact future language ports decode against (F8). If this test fails after a
 * code change, the on-disk format changed: that is a breaking change requiring a new format version,
 * not a golden-file update.
 */
const GOLDEN_PATH = fileURLToPath(new URL('../../golden/v1.0-basic.crbm', import.meta.url));

// The exact inputs that produced the golden file.
const GENERATION = 7;
const CHUNKS = [
  { chunkKey: 0, payload: Uint8Array.of(0xde, 0xad, 0xbe, 0xef), cardinality: 3 },
  { chunkKey: 256, payload: Uint8Array.of(0x01, 0x02), cardinality: 1 },
  { chunkKey: 4096, payload: Uint8Array.of(0xff), cardinality: 2 },
];

describe('golden .crbm corpus (V6, F8)', () => {
  it('the writer reproduces the golden bytes exactly', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: GENERATION });
    for (const c of CHUNKS) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();

    const golden = new Uint8Array(readFileSync(GOLDEN_PATH));
    expect(Buffer.from(sink.bytes()).toString('hex')).toBe(Buffer.from(golden).toString('hex'));
  });

  it('the reader decodes the golden bytes to the original segment', async () => {
    const golden = new Uint8Array(readFileSync(GOLDEN_PATH));
    const reader = await CrbmReader.open(new BufferReader(golden));

    expect(reader.generation).toBe(GENERATION);
    expect(reader.chunkKeys()).toEqual([0, 256, 4096]);
    expect(reader.count()).toBe(6);
    for (const c of CHUNKS) {
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
    }
  });
});
