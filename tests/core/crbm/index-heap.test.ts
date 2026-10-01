import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';

/**
 * The reader's memory bound must not under-count the heap its parsed index really retains: the storage reader
 * cache evicts on `retainedIndexBytes`, so a bound below the truth lets the cache hold more than its budget.
 *
 * This measures, rather than reasons: it forces a collection (`--expose-gc` is switched on at run time, so no
 * runner flag is needed), opens a reader over thousands of entries, collects again, and divides the heap that
 * stayed by the entry count.
 *
 * Tolerance: the reported figure may be exceeded by 5% plus 16 KiB. The 5% absorbs allocator rounding of the
 * large backing stores; the 16 KiB absorbs the fixed per-reader objects (the reader itself, its arrays' headers,
 * one-off feedback vectors) that do not scale with entries. Thousands of entries keep that constant small beside
 * the per-entry weight, and the median of several samples rejects a sample a stray collection skewed.
 */
const ENTRIES = 4_000;
const SAMPLES = 5;
const REL_SLACK = 0.05;
const ABS_SLACK_BYTES = 16 * 1024;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

async function buildObject(entries: number): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 1 });
  for (let i = 0; i < entries; i++) {
    // Spread the keys across the 16-bit range with uneven gaps, and vary lengths and cardinalities, so the
    // index holds the mixed varint widths and large CRCs a real one does.
    const key = Math.floor((i * 65_535) / (entries - 1));
    const payload = new Uint8Array(4 + (i % 7)).fill(i & 0xff);
    await writer.addChunk(key, payload, 1 + ((i * 7919) % 65_536));
  }
  await writer.finish();
  return sink.bytes();
}

function heapUsed(): number {
  gc();
  gc();
  return getHeapStatistics().used_heap_size;
}

describe('CrbmReader — retained index heap versus the reported bound', () => {
  it('reports at least what the heap retains per parsed index entry', async () => {
    const bytes = await buildObject(ENTRIES);
    const blob = new BufferReader(bytes);
    const held: CrbmReader[] = [];
    const perEntryMeasured: number[] = [];
    const perEntryReported: number[] = [];
    let slackOk = true;
    for (let s = 0; s < SAMPLES; s++) {
      const before = heapUsed();
      const reader = await CrbmReader.open(blob);
      const after = heapUsed();
      held.push(reader); // keep every reader alive until the end so a sample cannot be collected under the next
      expect(reader.chunkKeys()).toHaveLength(ENTRIES);
      const measured = after - before;
      const reported = reader.retainedIndexBytes;
      perEntryMeasured.push(measured / ENTRIES);
      perEntryReported.push(reported / ENTRIES);
      if (measured > reported * (1 + REL_SLACK) + ABS_SLACK_BYTES) slackOk = false;
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
    const m = median(perEntryMeasured);
    const r = median(perEntryReported);
    // A failed expectation names both figures, so the gap is visible in the report.
    expect(
      m,
      `measured ${m.toFixed(1)} B/entry retained, reader reports ${r.toFixed(1)} B/entry`,
    ).toBeLessThanOrEqual(r * (1 + REL_SLACK) + ABS_SLACK_BYTES / ENTRIES);
    expect(slackOk, 'every sample stays within the stated tolerance of the reported bound').toBe(
      true,
    );
  });
});
