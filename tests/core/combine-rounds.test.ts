/**
 * How a combine spends its round trips: how wide its window opens and grows, and when an exclude is read.
 *
 * The source holds every chunk read open until the test settles it, so what has been requested at any moment, and
 * how many reads are open at once, are the test's to observe, with no real timers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SegmentEngine } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { seedSegment } from '../helpers/loaded';
import type { ChunkRef } from '@/core/ports';

const K = 65_536;

const quiesce = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

interface Held {
  readonly name: string;
  readonly settle: () => void;
  readonly fail: (error: Error) => void;
}

/** A chunk source whose reads stay open until {@link run} settles them, oldest first, one at a time. */
class HeldChunkSource extends MemoryStorageChunkSource {
  /** Every read requested, as `segment:chunkKey`, in order. */
  readonly requested: string[] = [];
  private readonly held: Held[] = [];
  inFlight = 0;
  peak = 0;
  /** Reads (`segment:chunkKey`) that reject instead of resolving. */
  failing = new Set<string>();

  currentVersion(): Promise<string | null> {
    return Promise.resolve('v1');
  }

  override getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    const name = `${ref.segment}:${ref.chunkKey}`;
    this.requested.push(name);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.held.push({
        name,
        settle: () => {
          this.inFlight -= 1;
          super.getChunk(ref).then(resolve, reject);
        },
        fail: (error) => {
          this.inFlight -= 1;
          reject(error);
        },
      });
    });
  }

  private release(h: Held): void {
    if (this.failing.has(h.name)) h.fail(new Error(`${h.name} failed`));
    else h.settle();
  }

  /** Settle the oldest open read, once the event loop is quiet. False when none is open. */
  async step(): Promise<boolean> {
    await quiesce();
    const next = this.held.shift();
    if (next === undefined) return false;
    this.release(next);
    return true;
  }

  /** Settle reads, oldest first, until `done`; then settle whatever is left open so every rejection has landed. */
  async run(done: () => boolean): Promise<void> {
    while (!done()) {
      if (!(await this.step())) await quiesce();
    }
    await quiesce();
    for (const rest of this.held.splice(0)) this.release(rest);
    await quiesce();
  }
}

const idsOf = (k: number): number[] => [k * K + 1, k * K + 2, k * K + 3];
const chunks = (keys: Iterable<number>): number[] => [...keys].flatMap(idsOf);
const range = (n: number): number[] => [...Array(n).keys()];

function build(segments: Record<string, Iterable<number>>) {
  const storage = new HeldChunkSource();
  for (const [name, ids] of Object.entries(segments)) seedSegment(storage, name, chunks(ids));
  const engine = new SegmentEngine({ storage, codec: roaringCodec });
  return { storage, engine };
}

/** Start a consumer and return its progress, so the test can look at the source mid-flight. */
function consume(gen: AsyncGenerator<number>) {
  const state = { out: [] as number[], done: false, error: undefined as unknown };
  const finished = (async () => {
    try {
      for await (const id of gen) state.out.push(id);
    } catch (error) {
      state.error = error;
    } finally {
      state.done = true;
    }
  })();
  return { state, finished };
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

const A = { segment: 'a' };
const X = { segment: 'x' };
/** An exclude that holds a key far from any include, so it removes nothing and is never read. */
const FAR = 1000;

describe('the combine window opens at 8 keys and widens to the default of 32', () => {
  it('starts 8 reads wide, and never has more than 32 open', async () => {
    const { storage, engine } = build({ a: range(200), x: [FAR] });
    const { state, finished } = consume(engine.andNot(A, [X]));
    await quiesce();
    expect(storage.requested).toHaveLength(8); // the opening batch, before any read has resolved
    await storage.run(() => state.done);
    await finished;
    expect(state.error).toBeUndefined();
    expect(storage.peak).toBe(32); // it widened all the way, and no further
    expect(state.out).toEqual(chunks(range(200)));
    expect(storage.requested).toHaveLength(200);
  });

  it('widens by doubling per key taken: 8 keys until the fourth, then 16, then 32', async () => {
    const { storage, engine } = build({ a: range(200), x: [FAR] });
    const { state, finished } = consume(engine.andNot(A, [X]));
    await quiesce();
    const open: number[] = [];
    for (let taken = 1; taken <= 6; taken++) {
      await storage.step();
      await quiesce();
      open.push(storage.inFlight);
    }
    // Each step settles the oldest read, the consumer takes it, and the window refills to its width.
    expect(open).toEqual([8, 8, 8, 16, 32, 32]);
    await storage.run(() => state.done);
    await finished;
  });

  it('a concurrency below 8 caps the window from the start', async () => {
    const { storage, engine } = build({ a: range(100), x: [FAR] });
    const { state, finished } = consume(engine.andNot(A, [X], { concurrency: 3 }));
    await quiesce();
    expect(storage.requested).toHaveLength(3);
    await storage.run(() => state.done);
    await finished;
    expect(storage.peak).toBe(3);
  });

  it('a concurrency of 8 never has more than 8 reads open', async () => {
    const { storage, engine } = build({ a: range(100), x: [FAR] });
    const { state, finished } = consume(engine.andNot(A, [X], { concurrency: 8 }));
    await quiesce();
    expect(storage.requested).toHaveLength(8);
    await storage.run(() => state.done);
    await finished;
    expect(storage.peak).toBe(8);
  });

  it('a concurrency of 16 opens 8 wide and widens to 16', async () => {
    const { storage, engine } = build({ a: range(100), x: [FAR] });
    const { state, finished } = consume(engine.andNot(A, [X], { concurrency: 16 }));
    await quiesce();
    expect(storage.requested).toHaveLength(8);
    await storage.run(() => state.done);
    await finished;
    expect(storage.peak).toBe(16);
  });

  it('a read that stops after its first key has requested only the opening 8', async () => {
    const { storage, engine } = build({ a: range(200), x: [FAR] });
    const gen = engine.andNot(A, [X]);
    const first = (async () => {
      for await (const id of gen) return id;
      return null;
    })();
    await storage.run(() => storage.requested.length >= 8);
    expect(await first).toBe(idsOf(0)[0]);
    expect(storage.requested.length).toBeLessThanOrEqual(9);
    expect(unhandled).toEqual([]);
  });
});

describe('an exclude is read in the same round as the includes when the include side cannot be emptied', () => {
  it('andNot: the exclude read starts before the include read resolves', async () => {
    const { storage, engine } = build({ a: [0], x: [0] });
    const { state, finished } = consume(engine.andNot(A, [X]));
    await quiesce();
    expect([...storage.requested].sort()).toEqual(['a:0', 'x:0']); // both open, none settled
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual([]); // x holds everything a does
  });

  it('union with an exclude: the exclude read starts before the include reads resolve', async () => {
    const { storage, engine } = build({ a: [0], b: [0], x: [0] });
    const { state, finished } = consume(engine.union([A, { segment: 'b' }], { exclude: [X] }));
    await quiesce();
    expect([...storage.requested].sort()).toEqual(['a:0', 'b:0', 'x:0']);
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual([]);
  });

  it('suppresses exactly the ids the exclude holds, whichever round it was read in', async () => {
    const { storage, engine } = build({ a: [0, 1], x: [1] });
    const { state, finished } = consume(engine.andNot(A, [X]));
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual(idsOf(0));
    expect(unhandled).toEqual([]);
  });

  it('an intersect of two includes reads its exclude only after the AND', async () => {
    const { storage, engine } = build({ a: [0], b: [0], x: [0] });
    const { state, finished } = consume(engine.intersect([A, { segment: 'b' }], { exclude: [X] }));
    await quiesce();
    expect([...storage.requested].sort()).toEqual(['a:0', 'b:0']); // no exclude yet
    await storage.step();
    await storage.step();
    await quiesce();
    expect(storage.requested).toContain('x:0'); // the AND held ids, so the exclude is read now
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual([]);
  });

  it('an intersect whose AND is empty never fetches its exclude', async () => {
    const storage = new HeldChunkSource();
    seedSegment(storage, 'a', [1]);
    seedSegment(storage, 'b', [2]); // same chunk key 0, no id in common
    seedSegment(storage, 'x', [3]);
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    const { state, finished } = consume(engine.intersect([A, { segment: 'b' }], { exclude: [X] }));
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual([]);
    expect([...storage.requested].sort()).toEqual(['a:0', 'b:0']);
  });
});

describe('request counts', () => {
  it('andNot reads each include chunk once and each exclude only where it holds the key', async () => {
    const { storage, engine } = build({ a: range(60), x: range(10), y: range(5) });
    const { state, finished } = consume(engine.andNot(A, [X, { segment: 'y' }]));
    await storage.run(() => state.done);
    await finished;
    expect(storage.requested).toHaveLength(60 + 10 + 5);
    expect(new Set(storage.requested).size).toBe(75);
    expect(state.out).toEqual(chunks(range(60).slice(10)));
  });

  it('an intersect with an exclude reads the same chunks as before', async () => {
    const { storage, engine } = build({ a: range(40), b: range(30), x: range(5) });
    const { state, finished } = consume(engine.intersect([A, { segment: 'b' }], { exclude: [X] }));
    await storage.run(() => state.done);
    await finished;
    expect(storage.requested).toHaveLength(30 * 2 + 5);
  });

  it('the per-op budget counts the same units: refused over the cap, allowed at it', async () => {
    const make = () => build({ a: range(20), x: range(10) });
    const units = 20 + 10;
    const ok = make();
    const okRun = consume(ok.engine.andNot(A, [X], { budget: { maxRequests: units } }));
    await ok.storage.run(() => okRun.state.done);
    await okRun.finished;
    expect(okRun.state.error).toBeUndefined();

    const over = make();
    const overRun = consume(over.engine.andNot(A, [X], { budget: { maxRequests: units - 1 } }));
    await over.storage.run(() => overRun.state.done);
    await overRun.finished;
    expect(overRun.state.error).toBeDefined();
    expect(over.storage.requested).toEqual([]);
  });
});

describe('a failure in the shared round', () => {
  it('an exclude read that fails surfaces its error, and the include read landing later raises nothing', async () => {
    const { storage, engine } = build({ a: [0], x: [0] });
    storage.failing.add('x:0');
    const { state, finished } = consume(engine.andNot(A, [X]));
    await storage.run(() => state.done);
    await finished;
    expect((state.error as Error).message).toBe('x:0 failed');
    await quiesce();
    expect(unhandled).toEqual([]);
  });

  it('an include read that fails surfaces its error, and the exclude read landing later raises nothing', async () => {
    const { storage, engine } = build({ a: [0], x: [0] });
    storage.failing.add('a:0');
    const { state, finished } = consume(engine.andNot(A, [X]));
    await storage.run(() => state.done);
    await finished;
    expect((state.error as Error).message).toBe('a:0 failed');
    await quiesce();
    expect(unhandled).toEqual([]);
  });

  it('errors surface in key order, after every id before them', async () => {
    const { storage, engine } = build({ a: range(4), x: range(4) });
    storage.failing.add('x:1');
    storage.failing.add('a:2');
    const { state, finished } = consume(engine.andNot(A, [X]));
    await storage.run(() => state.done);
    await finished;
    expect((state.error as Error).message).toBe('x:1 failed');
    expect(state.out).toEqual([]); // key 0 is fully suppressed, so nothing came out before key 1 failed
    expect(unhandled).toEqual([]);
  });

  it('ids of earlier keys are yielded before a later key fails', async () => {
    const { storage, engine } = build({ a: range(4), x: [1, 2, 3] });
    storage.failing.add('x:2');
    const { state, finished } = consume(engine.andNot(A, [X]));
    await storage.run(() => state.done);
    await finished;
    expect(state.out).toEqual(idsOf(0)); // key 0 has no exclude; key 1 is suppressed; key 2 fails
    expect((state.error as Error).message).toBe('x:2 failed');
    expect(unhandled).toEqual([]);
  });
});
