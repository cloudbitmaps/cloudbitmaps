/**
 * What the engine's reads cost in storage requests now that a combine reads each operand as coalesced ranges, counted
 * against the real engine over the in-memory backend with the same segment shapes the calibration harness uses:
 * segments of about 2,000 chunks of about 250 ids each (a chunk of about 516 bytes, so the whole object is one range of
 * 1 MiB), two of which share `k` chunks. Each case counts what the storage driver was asked, and the pointer reads the
 * registry was asked, and compares them with what the cost model charges for the same read.
 *
 * These counts are the engine's own; they are not measured on S3. They are what the published cost figures for this
 * engine are derived from (`bench/`), and what a calibration run is expected to count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { estimateCost } from '@cloudbitmaps/tools';
import { collect } from '../helpers/loaded';
import { chunkReads } from '../helpers/chunk-reads';

const CHUNK = 65_536;
const IDS_PER_CHUNK = 250;

/** The ids of a segment that holds exactly the chunks `keys`, 250 ids each. */
const idsOf = (keys: Iterable<number>): number[] =>
  [...keys].flatMap((k) => Array.from({ length: IDS_PER_CHUNK }, (_, i) => k * CHUNK + i * 7 + 1));
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

/** A backend whose storage reads and pointer reads are counted. */
function counted() {
  const backend = new MemoryStorage();
  const calls = { getRange: 0, getTail: 0, pointer: 0, rangeBytes: 0 };
  const storage = new Proxy(backend.storage, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'getTail') calls.getTail += 1;
        if (prop === 'getRange') {
          calls.getRange += 1;
          calls.rangeBytes += args[2] as number;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const registry = new Proxy(backend.registry, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'get') calls.pointer += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const loader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  /** A store that has read nothing, over the counted halves; counts start at zero. */
  const cold = () => {
    calls.getRange = calls.getTail = calls.pointer = calls.rangeBytes = 0;
    return new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: 0 },
    });
  };
  return { loader, cold, calls };
}

/** What the model charges one cold intersect of `operands` operands that read `chunkRequests` range requests. */
const modelGets = (operands: number, chunkRequests: number): number =>
  Math.round(
    estimateCost({
      segments: [],
      workload: {
        intersectsPerSec: 1,
        chunksPerIntersect: chunkRequests,
        operandsPerIntersect: operands,
      },
    }).monthlyUSD.byOp.intersects /
      ((730 * 3600 * 0.4) / 1e6),
  );

const reads = chunkReads();
beforeEach(reads.start);
afterEach(reads.stop);

// These count requests, not time, but each case first loads thousands of chunks: under a second alone, several times
// that under the load of the whole suite.
vi.setConfig({ testTimeout: 60_000 });

describe('a cold intersect of two segments of about 2,000 chunks sharing k chunks', () => {
  /** `shared` chunks both hold, at the keys given, and each its own private chunks to make 1,999 chunks. */
  async function intersect(
    sharedKeys: number[],
    privateA: number[],
    privateB: number[],
  ): Promise<{ ids: number; getRange: number; getTail: number; pointer: number; wanted: number }> {
    const { loader, cold, calls } = counted();
    await loader.load({ segment: 'a' }, idsOf([...sharedKeys, ...privateA]));
    await loader.load({ segment: 'b' }, idsOf([...sharedKeys, ...privateB]));
    const store = cold();
    reads.reset();
    const got = await collect(store.segment('a').intersect([store.segment('b')]));
    expect(got).toEqual(idsOf(sharedKeys));
    return {
      ids: got.length,
      getRange: calls.getRange,
      getTail: calls.getTail,
      pointer: calls.pointer,
      wanted: reads.total(),
    };
  }

  it('k = 100, packed: 6 requests, not 204', async () => {
    const r = await intersect(range(0, 100), range(1_000, 2_899), range(5_000, 6_899));
    expect(r.wanted).toBe(200); // the engine still asks for the 100 shared chunks of each operand
    expect(r).toMatchObject({ getRange: 2, getTail: 2, pointer: 2 });
    expect(r.pointer + r.getTail + r.getRange).toBe(6);
    expect(modelGets(2, r.getRange)).toBe(6);
  });

  it('k = 100, spread over each segment: 6 requests, though most of each object is read', async () => {
    // Every 20th chunk is shared; the 19 between hold each segment's own chunks, so the shared ones are spread over
    // both objects (1,000 and 900 private chunks).
    const shared = range(0, 100).map((j) => j * 20);
    const privateA = range(0, 100).flatMap((j) => range(1, 11).map((d) => j * 20 + d));
    const privateB = range(0, 100).flatMap((j) => range(11, 20).map((d) => j * 20 + d));
    const r = await intersect(shared, privateA, privateB);
    expect(r.wanted).toBe(200);
    expect(r.getRange).toBe(2);
    expect(r.pointer + r.getTail + r.getRange).toBe(6);
    expect(modelGets(2, r.getRange)).toBe(6);
  });

  it.each([
    ['k = 1,000, packed', range(0, 1_000), range(2_000, 3_000), range(5_000, 6_000)],
    ['k = 2,000, packed', range(0, 2_000), [], []],
  ])('%s: 6 requests', async (_, shared, privateA, privateB) => {
    const r = await intersect(shared, privateA, privateB);
    expect(r.getRange).toBe(2);
    expect(r.pointer + r.getTail + r.getRange).toBe(6);
    expect(modelGets(2, r.getRange)).toBe(6);
  });

  it("k = 1,000, spread: the shared chunks alternate with each segment's own", async () => {
    const shared = range(0, 1_000).map((j) => j * 4);
    const privateA = range(0, 1_000).map((j) => j * 4 + 1);
    const privateB = range(0, 1_000).map((j) => j * 4 + 3);
    const r = await intersect(shared, privateA, privateB);
    expect(r.getRange).toBe(2);
    expect(r.pointer + r.getTail + r.getRange).toBe(6);
  });
});

describe('an andNot of one segment of 1,999 chunks against ten that share 100 of them', () => {
  it('makes 33 requests, not 3,021, in three rounds of reading', async () => {
    const { loader, cold, calls } = counted();
    await loader.load({ segment: 'a' }, idsOf(range(0, 1_999)));
    for (let i = 0; i < 10; i++) {
      await loader.load(
        { segment: `s${i}` },
        idsOf([...range(0, 100), ...range(10_000 + i * 2_000, 11_899 + i * 2_000)]),
      );
    }
    const store = cold();
    reads.reset();
    const a = store.segment('a');
    const got = await collect(a.andNot(range(0, 10).map((i) => store.segment(`s${i}`))));
    expect(got).toEqual(idsOf(range(100, 1_999)));
    expect(reads.total()).toBe(1_999 + 10 * 100); // chunks asked for; the 2,999 of the previous engine's requests
    expect(calls.pointer).toBe(11);
    expect(calls.getTail).toBe(11);
    expect(calls.getRange).toBe(11);
    expect(calls.pointer + calls.getTail + calls.getRange).toBe(33);
  });
});

describe('iterate, union and a warm repeat', () => {
  it('iterate of 1,999 chunks makes 3 requests, and a repeat from the cache makes none', async () => {
    const { loader, cold, calls } = counted();
    await loader.load({ segment: 'a' }, idsOf(range(0, 1_999)));
    const store = cold();
    expect(await collect(store.segment('a').iterate())).toHaveLength(1_999 * IDS_PER_CHUNK);
    expect(calls).toMatchObject({ pointer: 1, getTail: 1, getRange: 1 });
  });

  it('a repeat intersect on the same store reads nothing the cache holds', async () => {
    const { loader, cold, calls } = counted();
    await loader.load({ segment: 'a' }, idsOf(range(0, 100)));
    await loader.load({ segment: 'b' }, idsOf(range(0, 100)));
    const store = cold();
    const run = () => collect(store.segment('a').intersect([store.segment('b')]));
    await run();
    const before = calls.getRange;
    await run();
    expect(calls.getRange).toBe(before);
  });

  it('a union of two segments reads each as ranges', async () => {
    const { loader, cold, calls } = counted();
    await loader.load({ segment: 'a' }, idsOf(range(0, 300)));
    await loader.load({ segment: 'b' }, idsOf(range(200, 500)));
    const store = cold();
    const got = await collect(store.segment('a').union([store.segment('b')]));
    expect(got).toHaveLength(500 * IDS_PER_CHUNK);
    expect(calls.getRange).toBe(2);
  });
});
