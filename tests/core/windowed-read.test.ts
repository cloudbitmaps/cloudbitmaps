/**
 * `iterate` and the storage path of `count` fetch through a bounded window instead of one chunk at a time.
 *
 * The driver here holds every chunk read until the test settles it, so the in-flight count, the order of the
 * requests and the moment an error lands are all the test's to control, with no real timers. Each case is
 * checked on the numbers a cold read pays for: how many reads are open at once, how many a stopped read leaves
 * behind, and the total, which must not move.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SegmentEngine } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { seedSegment } from '../helpers/loaded';
import type { ChunkRef } from '@/core/ports';

const K = 65_536;
const WINDOW = 8;
const IDS_PER_CHUNK = 3;

/**
 * Wait until every queued microtask has run. The engine schedules nothing but promises (`core/` may not touch a
 * timer), and a `setImmediate` callback runs only once the microtask queue is empty, so one is enough.
 */
const quiesce = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

interface Held {
  readonly key: number;
  readonly settle: () => void;
  readonly fail: (error: Error) => void;
}

/** A chunk source whose reads stay open until {@link run} settles them, oldest first, one at a time. */
class HeldChunkSource extends MemoryStorageChunkSource {
  readonly requested: number[] = [];
  private readonly held: Held[] = [];
  inFlight = 0;
  peak = 0;
  /** Chunk keys whose read rejects instead of resolving. */
  failing = new Set<number>();
  /** Chunk keys the source reports as holding no bytes, though it lists them. */
  absent = new Set<number>();
  /** How many times a read asked which bytes it is reading. */
  versionReads = 0;

  currentVersion(): Promise<string | null> {
    this.versionReads += 1;
    return Promise.resolve('v1');
  }

  override getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.requested.push(ref.chunkKey);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.held.push({
        key: ref.chunkKey,
        settle: () => {
          this.inFlight -= 1;
          if (this.absent.has(ref.chunkKey)) resolve(null);
          else super.getChunk(ref).then(resolve, reject);
        },
        fail: (error) => {
          this.inFlight -= 1;
          reject(error);
        },
      });
    });
  }

  /** Let the event loop run to quiescence, then settle the oldest open read; repeat until `done` is true. */
  async run(done: () => boolean): Promise<void> {
    while (!done()) {
      await quiesce();
      const next = this.held.shift();
      if (next === undefined) {
        if (done()) return;
        continue;
      }
      if (this.failing.has(next.key)) next.fail(new Error(`chunk ${next.key} failed`));
      else next.settle();
    }
    await quiesce();
    // Whatever a stopped read left open is settled too, so a rejection in it has landed before the test ends.
    for (const rest of this.held.splice(0)) {
      if (this.failing.has(rest.key)) rest.fail(new Error(`chunk ${rest.key} failed`));
      else rest.settle();
    }
    await quiesce();
  }
}

/**
 * The three ids of chunk `k`. Each chunk's are different (`k` is in the low bits), so a chunk handed back in the
 * wrong slot yields ids that are not in `ids`, and an out-of-order read cannot pass for an ordered one.
 */
const idsOf = (k: number): number[] =>
  Array.from({ length: IDS_PER_CHUNK }, (_, r) => k * K + r * 100 + k);

/** `chunks` chunks, keys 0..chunks-1, each holding three ids; the ids ascending. */
function build(chunks: number) {
  const storage = new HeldChunkSource();
  const ids: number[] = [];
  for (let k = 0; k < chunks; k++) ids.push(...idsOf(k));
  seedSegment(storage, 'a', ids);
  const engine = new SegmentEngine({ storage, codec: roaringCodec });
  return { storage, engine, ids };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

/** Run `body` (a consumer) to completion while the source settles reads. */
async function drive<T>(storage: HeldChunkSource, body: () => Promise<T>): Promise<T> {
  let finished = false;
  const consumer = body().finally(() => {
    finished = true;
  });
  consumer.catch(() => undefined); // a rejection is the test's to read, below
  await storage.run(() => finished);
  return consumer;
}

describe('iterate fetches through a bounded, ordered window', () => {
  it('keeps up to 8 reads open once the ramp is done, never more, and yields every id in order', async () => {
    const { storage, engine, ids } = build(40);
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' })) out.push(id);
      return out;
    });
    expect(got).toEqual(ids);
    expect(storage.peak).toBe(WINDOW);
    expect(storage.requested).toEqual([...Array(40).keys()]); // each chunk once, in key order
    expect(unhandled).toEqual([]);
  });

  it('ramps 1, 2, 4, 8: a consumer that stops after its first id has fetched one chunk', async () => {
    const { storage, engine, ids } = build(40);
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' })) {
        out.push(id);
        break;
      }
      return out;
    });
    expect(got).toEqual([ids[0]]);
    expect(storage.requested).toEqual([0]);
    expect(unhandled).toEqual([]);
  });

  it('a consumer that stops inside the second chunk has fetched at most three chunks', async () => {
    const { storage, engine } = build(40);
    await drive(storage, async () => {
      let seen = 0;
      for await (const id of engine.iterate({ segment: 'a' })) {
        void id;
        seen += 1;
        if (seen === IDS_PER_CHUNK + 1) break;
      }
    });
    expect(storage.requested.length).toBeLessThanOrEqual(3);
    expect(storage.requested.length).toBeGreaterThan(IDS_PER_CHUNK - 1); // it did read ahead of chunk 1
  });

  it('a read ahead that fails after the consumer has stopped leaves no unhandled rejection', async () => {
    const { storage, engine } = build(40);
    storage.failing.add(2); // read ahead while the consumer is inside chunk 1, and rejected after it stops
    await drive(storage, async () => {
      let seen = 0;
      for await (const id of engine.iterate({ segment: 'a' })) {
        void id;
        seen += 1;
        if (seen === IDS_PER_CHUNK + 1) break;
      }
    });
    expect(storage.requested).toContain(2); // the abandoned read really ran
    await new Promise<void>((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });

  it('an error in chunk k surfaces when the read reaches k, after every id before it', async () => {
    const { storage, engine, ids } = build(40);
    storage.failing.add(5);
    const out: number[] = [];
    const outcome = await drive(storage, async () => {
      try {
        for await (const id of engine.iterate({ segment: 'a' })) out.push(id);
        return 'finished';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(outcome).toBe('chunk 5 failed');
    expect(out).toEqual(ids.slice(0, 5 * IDS_PER_CHUNK));
    expect(unhandled).toEqual([]);
  });

  it('the window does not change what a full read requests', async () => {
    const { storage, engine } = build(25);
    await drive(storage, async () => {
      for await (const id of engine.iterate({ segment: 'a' })) void id;
    });
    expect(storage.requested).toHaveLength(25);
    expect(new Set(storage.requested).size).toBe(25);
  });

  it('asks which bytes it is reading once per read, not once per chunk', async () => {
    const { storage, engine } = build(40);
    await drive(storage, async () => {
      for await (const id of engine.iterate({ segment: 'a' })) void id;
    });
    expect(storage.versionReads).toBe(1);
  });

  it('a segment of fewer chunks than the window reads each once and yields them in order', async () => {
    const { storage, engine, ids } = build(3);
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' })) out.push(id);
      return out;
    });
    expect(got).toEqual(ids);
    expect(storage.requested).toEqual([0, 1, 2]);
    expect(storage.peak).toBeLessThanOrEqual(3);
  });

  it('a listed chunk the source holds no bytes for is skipped, and the chunks after it still arrive in order', async () => {
    const { storage, engine, ids } = build(12);
    storage.absent.add(4);
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' })) out.push(id);
      return out;
    });
    expect(got).toEqual(ids.filter((id) => Math.floor(id / K) !== 4));
    expect(storage.requested).toEqual([...Array(12).keys()]);
  });

  it('a segment with no chunks yields nothing and reads nothing', async () => {
    const { storage, engine } = build(0);
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' })) out.push(id);
      return out;
    });
    expect(got).toEqual([]);
    expect(storage.requested).toEqual([]);
  });
});

describe('iterate over a range uses the same window', () => {
  it('keeps up to 8 reads open over the chunks in range, and trims the edges', async () => {
    const { storage, engine, ids } = build(40);
    const after = 5 * K + 50; // keeps the last two ids of chunk 5
    const through = 30 * K + 150; // keeps the first two ids of chunk 30
    const got = await drive(storage, async () => {
      const out: number[] = [];
      for await (const id of engine.iterate({ segment: 'a' }, { after, through })) out.push(id);
      return out;
    });
    expect(got).toEqual(ids.filter((id) => id > after && id <= through));
    expect(storage.peak).toBe(WINDOW);
    expect(storage.requested).toEqual(Array.from({ length: 26 }, (_, i) => 5 + i));
    expect(unhandled).toEqual([]);
  });

  it('stops after its first id having fetched one chunk, and surfaces an error only at its chunk', async () => {
    const { storage, engine } = build(40);
    const first = await drive(storage, async () => {
      for await (const id of engine.iterate({ segment: 'a' }, { after: 3 * K + 3 })) return id;
      return null;
    });
    expect(first).toBe(3 * K + 103); // chunk 3's id at 3K+3 is excluded: `after` is exclusive
    expect(storage.requested).toEqual([3]);

    const second = build(40);
    second.storage.failing.add(9);
    const out: number[] = [];
    const outcome = await drive(second.storage, async () => {
      try {
        for await (const id of second.engine.iterate(
          { segment: 'a' },
          { after: 3 * K, through: 20 * K },
        )) {
          out.push(id);
        }
        return 'finished';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(outcome).toBe('chunk 9 failed');
    expect(out).toEqual(second.ids.filter((id) => id > 3 * K && id < 9 * K));
    expect(unhandled).toEqual([]);
  });

  it('asks which bytes it is reading once per read', async () => {
    const { storage, engine } = build(40);
    await drive(storage, async () => {
      for await (const id of engine.iterate({ segment: 'a' }, { after: 2 * K, through: 30 * K })) {
        void id;
      }
    });
    expect(storage.versionReads).toBe(1);
  });
});

describe('count on the storage path uses a window of 8', () => {
  it('keeps up to 8 reads open and returns the same total', async () => {
    const { storage, engine, ids } = build(40);
    const total = await drive(storage, () => engine.count({ segment: 'a' }));
    expect(total).toBe(ids.length);
    expect(storage.peak).toBe(WINDOW);
    expect(storage.requested).toHaveLength(40);
    expect(new Set(storage.requested).size).toBe(40);
    expect(storage.versionReads).toBe(1);
  });

  it('opens every read at once when the segment has fewer chunks than the window', async () => {
    const { storage, engine, ids } = build(3);
    const total = await drive(storage, () => engine.count({ segment: 'a' }));
    expect(total).toBe(ids.length);
    expect(storage.peak).toBe(3);
    expect(storage.requested).toEqual([0, 1, 2]);
  });

  it('counts a listed chunk the source holds no bytes for as empty', async () => {
    const { storage, engine, ids } = build(12);
    storage.absent.add(4);
    const total = await drive(storage, () => engine.count({ segment: 'a' }));
    expect(total).toBe(ids.length - IDS_PER_CHUNK);
  });

  it('fails with the first error and leaves no unhandled rejection', async () => {
    const { storage, engine } = build(40);
    storage.failing.add(3);
    storage.failing.add(6);
    const outcome = await drive(storage, async () => {
      try {
        await engine.count({ segment: 'a' });
        return 'finished';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(outcome).toBe('chunk 3 failed');
    await new Promise<void>((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });
});
