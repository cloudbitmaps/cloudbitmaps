import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { BufferReader, BufferSink } from '@/core/blob';
import type { BlobReader } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { PAYLOAD_START } from '@/core/crbm/format';
import type { ChunkExtent } from '@/core/crbm/plan-reads';
import { collect } from '../../helpers/chunk-stream';
import { planAllAtOnce } from '../../helpers/plan-reference';
import { zeroEntropy } from '../../helpers/entropy';

// A chunk stream plans its ranges as its window opens them. What it asks of the blob must be exactly what a plan of
// the whole key list made up front asked for, and a stream that stops early must have planned only what it opened.

/** The shape of a reader's parsed index that these tests read. */
interface Held {
  index: { keys: Uint16Array; offsets: Float64Array; lengths: Uint32Array };
  payloadEnd: number;
}

/** A blob that records every range read. */
class Spy implements BlobReader {
  readonly ranges: { offset: number; length: number }[] = [];
  constructor(private readonly inner: BlobReader) {}
  async getRange(offset: number, length: number): Promise<Uint8Array> {
    this.ranges.push({ offset, length });
    return this.inner.getRange(offset, length);
  }
  getTail(maxBytes: number) {
    return this.inner.getTail(maxBytes);
  }
}

async function build(sizes: ReadonlyMap<number, number>): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { entropy: zeroEntropy, generation: 1 });
  for (const [key, size] of [...sizes].sort((a, b) => a[0] - b[0])) {
    await writer.addChunk(key, new Uint8Array(size).fill(key & 0xff), 1);
  }
  await writer.finish();
  return sink.bytes();
}

async function open(bytes: Uint8Array) {
  const spy = new Spy(new BufferReader(bytes));
  const reader = await CrbmReader.open(spy, {});
  spy.ranges.length = 0; // count the chunk reads, not the open
  return { reader, spy };
}

/** The plan main made for `keys`: every key looked up, deduplicated by slot, every extent, all planned at once. */
function referenceRanges(reader: CrbmReader, keys: readonly number[]) {
  const { index, payloadEnd } = reader as unknown as Held;
  const slotOf = (chunkKey: number): number => {
    let lo = 0;
    let hi = index.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = index.keys[mid]!;
      if (k === chunkKey) return mid;
      if (k < chunkKey) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const slots = keys.map((key) => slotOf(key));
  const needed = [...new Set(slots.filter((slot) => slot >= 0))];
  const extents: ChunkExtent[] = needed.map((slot) => ({
    key: index.keys[slot]!,
    offset: index.offsets[slot]!,
    length: index.lengths[slot]!,
  }));
  return planAllAtOnce(extents, { start: PAYLOAD_START, end: payloadEnd }).map(
    ({ offset, length }) => ({ offset, length }),
  );
}

// Each case writes and reads a few megabytes of chunks, a hundred times over.
vi.setConfig({ testTimeout: 60_000 });

const KIB = 1024;
/** A segment's chunks by key and size: mostly small, a few large, so that ranges both merge and split. */
const segments = fc
  .uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 40 })
  .chain((keys) =>
    fc
      .array(
        fc.oneof(
          { weight: 6, arbitrary: fc.integer({ min: 40, max: 3 * KIB }) },
          { weight: 1, arbitrary: fc.integer({ min: 150 * KIB, max: 400 * KIB }) },
        ),
        { minLength: keys.length, maxLength: keys.length },
      )
      .map((sizes) => new Map(keys.map((k, i) => [k, sizes[i]!] as const))),
  );

/** A key list over a segment: a few of its keys, some it does not hold, some twice, in ascending order. */
const askedOf = (held: readonly number[]) =>
  fc
    .tuple(
      fc.subarray([...held]),
      fc.array(fc.integer({ min: 0, max: 65_535 }), { maxLength: 8 }),
      fc.array(fc.integer({ min: 0, max: 80 }), { maxLength: 6 }),
    )
    .map(([some, extra, repeats]) => {
      const keys = [...new Set([...some, ...extra])].sort((a, b) => a - b);
      const out: number[] = [];
      for (const [i, k] of keys.entries()) {
        out.push(k);
        if (repeats.includes(i)) out.push(k);
      }
      return out;
    });

describe('a chunk stream asks the blob for the ranges a whole-list plan makes', () => {
  it('reads exactly those ranges, in that order, and answers each key as a read of it alone does', async () => {
    await fc.assert(
      fc.asyncProperty(
        segments.chain((sizes) => askedOf([...sizes.keys()]).map((asked) => ({ sizes, asked }))),
        async ({ sizes, asked }) => {
          // Big enough that the reader does not keep the whole chunk region, which would send no request.
          const padded = new Map(sizes).set(65_535, 300 * KIB);
          const asking = [...new Set([...asked, 65_535])].sort((a, b) => a - b);
          const { reader, spy } = await open(await build(padded));
          const items = await collect(reader.readChunks(asking));
          const expected = referenceRanges(reader, asking);
          expect(spy.ranges).toEqual(expected);
          expect(items.map((i) => i.key)).toEqual(asking);
          for (const item of items) {
            const alone = await reader.getChunk(item.key);
            expect(item.bytes === null ? null : [...item.bytes]).toEqual(
              alone === null ? null : [...alone],
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('a stream stopped after j chunks has sent a prefix of those ranges, no more than its window', async () => {
    await fc.assert(
      fc.asyncProperty(
        segments.chain((sizes) => askedOf([...sizes.keys()]).map((asked) => ({ sizes, asked }))),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        async ({ sizes, asked }, taken, width) => {
          const padded = new Map(sizes).set(65_535, 300 * KIB);
          const asking = [...new Set([...asked, 65_535])].sort((a, b) => a - b);
          const { reader, spy } = await open(await build(padded));
          const stream = reader.readChunks(asking, { concurrency: width });
          for (let i = 0; i < taken; i++) if ((await stream.next()).done === true) break;
          await stream.return(undefined);
          await stream.settled();
          const expected = referenceRanges(reader, asking);
          expect(spy.ranges).toEqual(expected.slice(0, spy.ranges.length));
          expect(spy.ranges.length).toBeLessThanOrEqual(Math.min(expected.length, width + taken));
        },
      ),
      { numRuns: 40 },
    );
  });

  it('is the same for a key list that repeats keys and names keys the generation lacks', async () => {
    const sizes = new Map([3, 4, 9, 70, 71].map((k) => [k, 90 * KIB] as const));
    const { reader, spy } = await open(await build(sizes));
    const asked = [0, 3, 3, 4, 5, 9, 9, 9, 70, 71, 72, 65_535];
    const items = await collect(reader.readChunks(asked));
    expect(items.map((i) => i.key)).toEqual(asked);
    expect(items.map((i) => i.bytes === null)).toEqual(asked.map((k) => !sizes.has(k)));
    expect(spy.ranges).toEqual(referenceRanges(reader, asked));
  });
});

describe('a stream over a wide generation plans only what its window opens', () => {
  const CHUNKS = 3_000;

  it('reading one chunk looks at the index entries of one range and the one after it, not of every chunk', async () => {
    const sizes = new Map(Array.from({ length: CHUNKS }, (_, k) => [k, 3 * KIB] as const));
    const { reader, spy } = await open(await build(sizes));
    const held = reader as unknown as Held;
    let looked = 0;
    const counted = (array: Float64Array | Uint32Array | Uint16Array) =>
      new Proxy(array, {
        get(target, prop) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) looked += 1;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    held.index = {
      ...held.index,
      offsets: counted(held.index.offsets) as Float64Array,
      lengths: counted(held.index.lengths) as Uint32Array,
    };
    const keys = Array.from({ length: CHUNKS }, (_, k) => k);
    const stream = reader.readChunks(keys, { ramp: true });
    const first = await stream.next();
    expect(first.done).toBe(false);
    await stream.return(undefined);
    await stream.settled();
    expect(spy.ranges).toHaveLength(1);
    // One range holds about 340 of these chunks; two reads of the index (offset and length) for each, and for the
    // chunk after the range that closes it.
    const perRange = Math.ceil((1024 * KIB) / (3 * KIB)) + 1;
    expect(looked).toBeLessThanOrEqual(2 * perRange);
    expect(looked).toBeLessThan(CHUNKS); // a plan of the whole list reads 2 x 3,000
  });

  it('a stream that is never read sends nothing', async () => {
    const sizes = new Map(Array.from({ length: 200 }, (_, k) => [k, 3 * KIB] as const));
    const { reader, spy } = await open(await build(sizes));
    reader.readChunks(Array.from({ length: 200 }, (_, k) => k));
    expect(spy.ranges).toEqual([]);
  });
});
