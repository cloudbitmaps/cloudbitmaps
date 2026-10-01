import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader, RETAINED_BYTES_PER_INDEX_ENTRY } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';

/**
 * The reader's memory bound must not under-count the heap its parsed index really retains: the storage reader
 * cache evicts on `retainedIndexBytes`, so a bound below the truth lets the cache hold more than its budget.
 *
 * This measures, rather than reasons: it forces a collection (`--expose-gc` is switched on at run time, so no
 * runner flag is needed), opens a reader over thousands of entries, collects again, and divides the memory that
 * stayed (JS heap plus the off-heap backing stores of typed arrays) by the entry count.
 *
 * Tolerance: the reported figure may be exceeded by 5% plus 32 KiB over the whole measurement. The 5% absorbs
 * allocator rounding of the large backing stores; the 32 KiB absorbs what does not scale with entries (the
 * readers' own objects and any one-off allocation the first open makes). Four readers of twenty thousand entries
 * each put the weight under test near 1.6 MB, which keeps that constant small beside it.
 */
const ENTRIES = 20_000;
const READERS = 4;
const REL_SLACK = 0.05;
const ABS_SLACK_BYTES = 32 * 1024;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as (options?: { type: 'major'; execution: 'sync' }) => void;

async function buildObject(entries: number): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 1 });
  for (let i = 0; i < entries; i++) {
    // Spread the keys across the 16-bit range with uneven gaps, and vary lengths and cardinalities, so the
    // index holds the mixed varint widths and large CRCs a real one does.
    const key = Math.floor((i * 65_535) / Math.max(1, entries - 1));
    const payload = new Uint8Array(4 + (i % 7)).fill(i & 0xff);
    await writer.addChunk(key, payload, 1 + ((i * 7919) % 65_536));
  }
  await writer.finish();
  return sink.bytes();
}

function heapUsed(): number {
  // Backing stores are freed when their owner is swept, so several synchronous major collections settle them.
  for (let i = 0; i < 4; i++) gc({ type: 'major', execution: 'sync' });
  // A typed array's backing store lives outside the JS heap and is reported as external memory, so count both.
  const stats = getHeapStatistics();
  return stats.used_heap_size + stats.external_memory;
}

describe('CrbmReader — retained index heap versus the reported bound', () => {
  it('reports at least what the heap retains per parsed index entry', async () => {
    const blob = new BufferReader(await buildObject(ENTRIES));
    // One measurement over several readers, taken once: a typed array's backing store is released lazily, after
    // its owner is collected, so a second measurement in the same process would net earlier readers' frees
    // against its own allocations and read low. Several readers together keep the fixed noise small.
    const before = heapUsed();
    const held: CrbmReader[] = [];
    for (let r = 0; r < READERS; r++) held.push(await CrbmReader.open(blob));
    const after = heapUsed();
    const entries = READERS * ENTRIES;
    const measured = (after - before) / entries;
    const reported = held.reduce((n, r) => n + r.retainedIndexBytes, 0) / entries;
    expect(held[0]!.chunkKeys()).toHaveLength(ENTRIES);
    // A failed expectation names both figures, so the gap is visible in the report.
    expect(
      measured,
      `measured ${measured.toFixed(1)} B/entry retained, reader reports ${reported.toFixed(1)} B/entry`,
    ).toBeLessThanOrEqual(reported * (1 + REL_SLACK) + ABS_SLACK_BYTES / entries);
  });
});

describe('CrbmReader — the reported bound is the arrays it holds', () => {
  it('reports exactly RETAINED_BYTES_PER_INDEX_ENTRY per entry, for any entry count', async () => {
    for (const entries of [1, 2, 300, 4_000]) {
      const reader = await CrbmReader.open(new BufferReader(await buildObject(entries)));
      expect(reader.retainedIndexBytes).toBe(entries * RETAINED_BYTES_PER_INDEX_ENTRY);
    }
  });
});
