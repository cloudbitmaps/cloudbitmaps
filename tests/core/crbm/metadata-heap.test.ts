import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { BufferReader } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { metadataBytes, metadataFromBytes } from '@/core/metadata';
import { writeCrbm } from '../../helpers/crbm-extension';

/**
 * The reader's weight must not under-count the heap its decoded metadata retains, for the reason
 * `index-heap.test.ts` gives for the index: the storage reader cache evicts on the weight. What a reader of an object with metadata holds
 * beyond a 1.0 one is the frozen record `metadataFromBytes` returns, so this decodes records as the reader does,
 * holds them, and divides the heap that stayed by their count, for three shapes near the 1 KiB cap: one long value,
 * many keys every record shares, and many keys unique to each record, which is the costly one (each record carries
 * its own keys).
 *
 * Tolerance: 5% plus 4 KiB over the whole measurement, which absorbs the array that holds the records.
 */
const RECORDS = 2_000;
const REL_SLACK = 0.05;
const ABS_SLACK_BYTES = 4 * 1024;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as (options?: { type: 'major'; execution: 'sync' }) => void;
function heapUsed(): number {
  for (let i = 0; i < 6; i++) gc({ type: 'major', execution: 'sync' });
  const stats = getHeapStatistics();
  return stats.used_heap_size + stats.external_memory;
}

const fail = (message: string): never => {
  throw new Error(message);
};
const two = (j: number): string =>
  String.fromCharCode(97 + Math.floor(j / 26)) + String.fromCharCode(97 + (j % 26));
const SHAPES: ReadonlyArray<readonly [string, (i: number) => Record<string, string | number>]> = [
  ['one long value', (i) => ({ k: `${i}`.padEnd(1014, 'x') })],
  [
    '110 keys every record shares',
    (i) => Object.fromEntries(Array.from({ length: 110 }, (_, j) => [two(j), i % 10])),
  ],
  [
    '100 keys unique to each record',
    (i) =>
      Object.fromEntries(
        Array.from({ length: 100 }, (_, j) => [(i * 100 + j).toString(36), j % 10]),
      ),
  ],
];

/** What a reader of an object holding `metadata` adds to its weight for it. */
async function weightOf(metadata: Record<string, string | number>): Promise<number> {
  const bytes = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
    generation: 1,
    metadata,
  });
  const reader = await CrbmReader.open(new BufferReader(bytes));
  return reader.retainedBytes - reader.retainedIndexBytes;
}

const kept: unknown[] = [];

describe('CrbmReader — the metadata weight versus the heap a decoded record retains', () => {
  // Every shape's bytes are made, and kept, before any is measured, so no measurement nets an earlier one's frees.
  const encoded = SHAPES.map(([name, make]) => ({
    name,
    make,
    bytes: Array.from({ length: RECORDS }, (_, i) => metadataBytes(make(i), fail)!),
  }));
  kept.push(encoded);

  it.each(encoded.map((e) => [e.name, e] as const))('%s', async (_name, { make, bytes }) => {
    const before = heapUsed();
    const held = bytes.map((b) => metadataFromBytes(b, fail));
    const after = heapUsed();
    kept.push(held);
    const measured = (after - before) / RECORDS;
    let reported = 0;
    for (const i of [0, 1, RECORDS - 1]) reported += await weightOf(make(i));
    reported /= 3;
    expect(
      measured,
      `measured ${measured.toFixed(0)} B a record retained, the reader weighs it ${reported.toFixed(0)} B`,
    ).toBeLessThanOrEqual(reported * (1 + REL_SLACK) + ABS_SLACK_BYTES / RECORDS);
  });
});
