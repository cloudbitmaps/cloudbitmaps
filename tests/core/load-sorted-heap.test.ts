import { createHash } from 'node:crypto';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import roaring from 'roaring';
import type { CodecInterface } from '@/core/codec';
import { NotFoundError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { BlobSink } from '@/core/blob';
import type { GenKey, IStorageDriver, SegmentRef, StorageCaps } from '@/core/ports';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { counterEntropy } from '../helpers/entropy';
import { heavy } from '../helpers/strength';

/**
 * A sorted load holds one chunk and the writer's index, whatever the segment's size: what it promises, measured rather
 * than reasoned.
 *
 * Three loads of 100 times as many ids from the smallest to the largest, each spread over the same 8,192 chunks, so the
 * writer's index (which a load holds until its footer) is the same size at every tier and only the ids grow. A warm-up
 * load runs first, so no tier pays the one-off allocations of the first load in the process. The ids come from a
 * generator, never an array, and the storage hashes each write and keeps nothing, so neither the input nor a backend's
 * buffer is in the figure. Every 65,536 ids, and at every sink write of 64 KiB or more (the encoded index, once the
 * footer's encoding is done), the test lets a turn of the event loop pass, forces several synchronous major
 * collections (`--expose-gc` is switched on at run time, so no runner flag is needed), and reads the JS heap, external
 * memory (a typed array's backing store) and the native memory roaring's bitmaps hold, by roaring's own count. The
 * figure is the highest such reading over the one taken just before the load.
 *
 * These are samples after collection, not a high-water mark. What lives between two readings and is gone by the next
 * is not in them: above all the temporary array the index's encoding builds while the footer is written, about as large
 * again as the index (so about 200 bytes a chunk at that moment, derived from the encoder's code), which is garbage
 * before the index is handed to the sink.
 *
 * What it holds, each in numbers, each failure message naming every figure:
 *   - a flat line: the largest tier's peak is within FLAT_SLACK of the smallest's;
 *   - a cap on the largest tier's peak;
 *   - a contrast: an unsorted load of the largest tier's ids, which holds the generation in memory, peaks at least
 *     CONTRAST times as high, so a sorted load that fell back to the in-memory path fails here;
 *   - the two write the same object (their `sha256`);
 *   - at most two chunk bitmaps are alive at any reading: an exact count, from weak references to every bitmap the
 *     codec makes, taken after the collection.
 *
 * The turn of the event loop matters for that count: a weak reference keeps its target alive until the end of the
 * job that made it, so a reading inside the job that made the bitmaps would count them all.
 *
 * Thresholds were calibrated at more than twice the figures measured (see the constants); no time is measured. The
 * largest tier is a million ids on a pull request and ten million in the full-strength run.
 */

// Ten million ids, sampled 150 times each way, take a while on a busy runner.
vi.setConfig({ testTimeout: 180_000 });

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as (options?: { type: 'major'; execution: 'sync' }) => void;

const MiB = 1024 * 1024;
const CHUNKS = 8_192;
const TOP = heavy('sortedLoadHeapIds');
const TIERS = [TOP / 100, TOP / 10, TOP];
const SAMPLE_EVERY_IDS = 65_536;
const SEG: SegmentRef = { namespace: 'ns', segment: 'heap' };

/**
 * The most the largest tier's peak may exceed the smallest's: the ids grow 100 times, the held state does not. Measured
 * at most 0.04 MiB apart after the warm-up, locally and on CI's Node 22 and 24.
 */
const FLAT_SLACK = 0.5 * MiB;
/** The most a sorted load's peak may be, at any tier: measured at most about 1.1 MiB, locally and on CI. */
const CAP = 3 * MiB;
/** How many times a sorted load's peak an unsorted load of the same ids must reach. */
const CONTRAST = 4;
/** The most chunk bitmaps alive at any reading of a sorted load. */
const MAX_LIVE_BITMAPS = 2;

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function settledBytes(): number {
  // Backing stores are freed when their owner is swept, so several synchronous major collections settle them.
  for (let i = 0; i < 4; i++) gc({ type: 'major', execution: 'sync' });
  const stats = getHeapStatistics();
  // roaring tells V8 what its native bitmaps allocate, and on Node 24 the heap statistics' external figure does not
  // include it (measured: 2,000 bitmaps of 4,000 ids, 16 MiB native, moved it by 0.1 MiB), so roaring's own count is
  // added. A Node that did include it would count the native part twice; a sorted load holds next to none of it.
  return stats.used_heap_size + stats.external_memory + roaring.getRoaringUsedMemory();
}

/** What one load's readings found. */
interface Peak {
  readonly bytes: number;
  readonly liveBitmaps: number;
  readonly nativeBytes: number;
  readonly readings: number;
  readonly sha256: string;
}

/** Readings over one load: each one the settled heap above the baseline, and the bitmaps still alive. */
class Readings {
  private readonly baseline = settledBytes();
  private refs: WeakRef<object>[] = [];
  peak = 0;
  liveBitmaps = 0;
  nativeBytes = 0;
  count = 0;

  /** The codec, with every bitmap it makes registered. */
  codec(): CodecInterface {
    return {
      ...roaringCodec,
      fromValues: (values) => {
        const bitmap = roaringCodec.fromValues(values);
        this.refs.push(new WeakRef(bitmap));
        return bitmap;
      },
    };
  }

  take(): void {
    const bytes = settledBytes() - this.baseline;
    this.refs = this.refs.filter((r) => r.deref() !== undefined);
    this.count++;
    this.peak = Math.max(this.peak, bytes);
    this.liveBitmaps = Math.max(this.liveBitmaps, this.refs.length);
    this.nativeBytes = Math.max(this.nativeBytes, roaring.getRoaringUsedMemory());
  }
}

/** Storage that hashes what is written and keeps none of it, reading once at every write of 64 KiB or more. */
class DiscardStorage implements IStorageDriver {
  constructor(private readonly readings: Readings) {}

  capabilities(): StorageCaps {
    return { rangeRead: true, maxObjectBytes: 2 ** 40, conditionalPut: true };
  }

  async putImmutable(
    _key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const hash = createHash('sha256');
    let size = 0;
    await write({
      write: async (bytes: Uint8Array) => {
        if (bytes.length >= 64 * 1024) {
          await macrotask();
          this.readings.take();
        }
        hash.update(bytes);
        size += bytes.length;
      },
    });
    return { size, sha256: hash.digest('hex') };
  }

  async getRange(): Promise<Uint8Array> {
    throw new NotFoundError('nothing is kept');
  }

  async getTail(): Promise<never> {
    throw new NotFoundError('nothing is kept');
  }

  async delete(): Promise<void> {}

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<GenKey> {
    return;
  }
}

/**
 * `n` ascending ids over {@link CHUNKS} chunks, three apart inside a chunk (array containers, no runs), reading every
 * {@link SAMPLE_EVERY_IDS}.
 */
async function* ascending(n: number, readings: Readings): AsyncGenerator<number> {
  let chunk = -1;
  let first = 0;
  for (let i = 0; i < n; i++) {
    if (i % SAMPLE_EVERY_IDS === 0) {
      await macrotask();
      readings.take();
    }
    const c = Math.floor((i * CHUNKS) / n);
    if (c !== chunk) {
      chunk = c;
      first = i;
    }
    yield chunk * 65_536 + 3 * (i - first);
  }
}

async function measure(n: number, sorted: boolean): Promise<Peak> {
  const readings = new Readings();
  const result = await loadSegment(
    SEG,
    ascending(n, readings),
    {
      storage: new DiscardStorage(readings),
      registry: new MemoryRegistryDriver(),
      codec: readings.codec(),
      entropy: counterEntropy(),
    },
    { sorted },
  );
  expect(result).toMatchObject({
    published: true,
    cardinality: n,
    chunkCount: Math.min(n, CHUNKS),
  });
  return {
    bytes: readings.peak,
    liveBitmaps: readings.liveBitmaps,
    nativeBytes: readings.nativeBytes,
    readings: readings.count,
    sha256: result.sha256,
  };
}

const mib = (bytes: number): string => `${(bytes / MiB).toFixed(2)} MiB`;
const shown = (p: Peak): string =>
  `${mib(p.bytes)} (${p.readings} readings, ${p.liveBitmaps} live bitmaps, roaring ${mib(p.nativeBytes)})`;

describe("a sorted load holds one chunk and the writer's index, whatever the segment holds", () => {
  it('peaks flat across 100 times the ids, under a cap, and far under an unsorted load', async () => {
    await measure(TIERS[0]!, true); // the warm-up: the first load in a process allocates once what no later one does
    const sorted: Peak[] = [];
    for (const n of TIERS) sorted.push(await measure(n, true));
    const unsorted = await measure(TOP, false);
    const [bottom, , top] = sorted as [Peak, Peak, Peak];
    const report =
      TIERS.map((n, i) => `sorted ${n} ids: ${shown(sorted[i]!)}`).join('; ') +
      `; unsorted ${TOP} ids: ${shown(unsorted)}`;

    expect(top.bytes - bottom.bytes, `flat line. ${report}`).toBeLessThanOrEqual(FLAT_SLACK);
    for (const p of sorted) expect(p.bytes, `cap. ${report}`).toBeLessThanOrEqual(CAP);
    expect(unsorted.bytes, `contrast. ${report}`).toBeGreaterThanOrEqual(CONTRAST * top.bytes);
    for (const p of sorted) {
      expect(p.liveBitmaps, `live bitmaps. ${report}`).toBeLessThanOrEqual(MAX_LIVE_BITMAPS);
    }
    // The unsorted load holds every chunk's bitmap at once, which the count above would see.
    expect(unsorted.liveBitmaps, `live bitmaps, unsorted. ${report}`).toBeGreaterThan(CHUNKS / 2);
    expect(top.sha256).toBe(unsorted.sha256);
    console.log(`load-sorted-heap: ${report}`);
  });
});
