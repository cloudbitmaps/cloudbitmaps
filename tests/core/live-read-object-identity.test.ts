import { randomBytes } from 'node:crypto';
import { CloudRoaring, CrbmStorageChunkSource, InProcessKeystore, MemoryStorage } from '@/index';
import type { Clock, IMetricsSink, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { ChunkRead, GenKey, IRegistryDriver, IStorageDriver } from '@/core/ports';
import { rowVersionOf } from '@/core/crbm-storage-source';
import { compactFingerprint } from '@/core/crbm/reader';
import { tokenOfVersion } from '@/core/combine-many';
import { IntegrityError, NotFoundError } from '@/core/errors';
import { counting } from '../helpers/counting';

/**
 * A live read never serves chunks of two objects as one generation (invariant 3), because a version names the object
 * it was read from, not only its number and its row's token (invariant 2).
 *
 * A generation number can be taken again within one incarnation of a row: a rollback, then an erasure that deletes the
 * generation above the pointer that held the erased id, then a load that numbers the same generation again. A reader
 * that resolved the row before those writes and opens the generation after them opens the new object under the
 * version the row named before. A `count()` answered from the row's summary is such a resolution: it opens nothing,
 * and the reader opens when a later read needs it. Chunks the store cached from the earlier object under that version
 * must not be served beside the new object's.
 *
 *     writer                                   reader (clock frozen inside one refresh window)
 *     load a [10, 65546]          -> g0
 *     load a [20, 65556]          -> g1
 *                                              has(20), has(65556): opens g1, caches its chunks 0 and 1
 *                                              reads of other segments: the reader cache lets a go
 *                                              count(a) = 2: a snapshot from the row alone, no object opened
 *     rollback a -> 0
 *     eraseSubject(20): deletes g1, above the pointer
 *     load a [30, 65566, 131102]  -> g1 again
 *                                              iterate(a): opens the new g1
 *                                                one generation's ids, never [20, 65556, 131102]
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const TTL = 2_000;
/** Generation 0 of `a`. */
const FIRST = [10, HI + 10];
/** Generation 1 of `a` as the reader first reads it: 20 is the id the erasure removes. */
const OLD = [20, HI + 20];
/** The object a load writes under number 1 once the erasure has deleted the old one. */
const NEW = [30, HI + 30, 2 * HI + 30];

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function collect(ids: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of ids) out.push(id);
  return out;
}

/** A read's ids are one generation's: one of `generations`, whole. */
function expectOneGeneration(ids: readonly number[], ...generations: number[][]): void {
  expect(generations).toContainEqual(ids);
}

interface Options {
  /** The reader cache's count bound. */
  readerMax?: number;
  /** The segments read after `a` is warmed, which make the reader cache let `a` go. */
  evictors?: Array<{ segment: string; ids: number[] }>;
  encrypted?: boolean;
  /** The reader store retries as a store does by default. */
  retry?: boolean;
}

/** A writer store and a reader store over one bucket, the reader's requests counted. */
async function world(options: Options = {}) {
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const encryption = keystore === undefined ? {} : { encryption: { keystore } };
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false, ...encryption });
  const calls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const clock = manualClock();
  const events: Array<Parameters<IMetricsSink['onEvent']>[0]> = [];
  const reader = new CloudRoaring({
    storage: brandAsBackend({
      storage: counting<IStorageDriver>(backend.storage, calls),
      registry: counting<IRegistryDriver>(backend.registry, registryCalls),
    }),
    ...(options.retry === true ? {} : { retry: false }),
    seams: { clock },
    cache: { readerMax: options.readerMax ?? 1, genTtlMs: TTL },
    metrics: { onEvent: (e) => events.push(e) },
    ...encryption,
  });
  await writer.load(A, FIRST);
  await writer.load(A, OLD);
  const evictors = options.evictors ?? [{ segment: 'b', ids: [1] }];
  for (const e of evictors) await writer.load({ namespace: NS, segment: e.segment }, e.ids);
  const requests = () => ({
    pointer: registryCalls.get ?? 0,
    tail: calls.getTail ?? 0,
    range: calls.getRange ?? 0,
  });
  const cacheHits = () => events.filter((e) => e.kind === 'cache' && e.hit).length;
  return {
    backend,
    writer,
    reader,
    clock,
    requests,
    cacheHits,
    a: reader.segment('a', { namespace: NS }),
    evictors: evictors.map((e) => reader.segment(e.segment, { namespace: NS })),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * The reader caches both chunks of generation 1, lets `a` go from its reader cache, and counts `a` from the row's
 * summary, which opens no object.
 */
async function warmLetGoAndCount(w: World): Promise<void> {
  expect(await w.a.has(20)).toBe(true);
  expect(await w.a.has(HI + 20)).toBe(true);
  for (const s of w.evictors) expect(await s.has(1)).toBe(true);
  const before = w.requests();
  expect(await w.a.count()).toBe(OLD.length);
  // One pointer read, and no read of the object: the count opened nothing.
  expect(w.requests()).toEqual({ ...before, pointer: before.pointer + 1 });
}

/** Number 1 is taken again: a rollback onto 0, an erasure that deletes 1 above the pointer, and a load of `fresh`. */
async function takeNumberAgain(w: World, fresh: number[] = NEW): Promise<void> {
  await w.writer.rollback(A, 0);
  const erased = await w.writer.eraseSubject(20, { namespace: NS });
  expect(erased.erasedFrom).toEqual([
    expect.objectContaining({ segment: 'a', erased: true, fromGeneration: 1 }),
  ]);
  expect(await w.writer.load(A, fresh)).toMatchObject({ generation: 1, published: true });
}

/** The size of the object under generation 1 of `a`. */
async function sizeOfGeneration1(storage: IStorageDriver): Promise<number> {
  return (await storage.getTail({ ...A, generation: 1 }, 0)).size;
}

/**
 * A source over the bucket of a writer store that has written generations 0 and 1 of `a`, and `b`, with a timed
 * refresh (so a small generation's reader keeps its chunks) and room for one reader.
 */
async function sourceWorld(ids: { old: number[]; fresh: number[] }) {
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false });
  const calls: Record<string, number> = {};
  const source = new CrbmStorageChunkSource(counting<IStorageDriver>(backend.storage, calls), {
    registry: backend.registry,
    clock: manualClock(),
    currentGenTtlMs: TTL,
    maxOpenSegments: 1,
  });
  await writer.load(A, FIRST);
  await writer.load(A, ids.old);
  await writer.load({ namespace: NS, segment: 'b' }, [1]);
  /** The reader cache lets `a` go, and a summary resolves it again from the row, opening nothing. */
  const letGoAndSummarize = async (): Promise<void> => {
    await source.listChunkKeys({ namespace: NS, segment: 'b' });
    const tails = calls.getTail ?? 0;
    expect((await source.summary(A))?.cardinality).toBe(ids.old.length);
    expect(calls.getTail ?? 0).toBe(tails);
  };
  const takeAgain = async (): Promise<void> => {
    await writer.rollback(A, 0);
    await writer.eraseSubject(ids.old[0]!, { namespace: NS });
    expect(await writer.load(A, ids.fresh)).toMatchObject({ generation: 1, published: true });
  };
  return { backend, source, letGoAndSummarize, takeAgain };
}

describe('a live read after its generation number is taken again inside the refresh window (invariant 3)', () => {
  it('iterate returns one generation, never the erased id beside the new object’s ids', async () => {
    const w = await world();
    await warmLetGoAndCount(w);
    await takeNumberAgain(w);
    const ids = await collect(w.a.iterate());
    expectOneGeneration(ids, OLD, NEW);
    expect(ids).not.toEqual(expect.arrayContaining([20, 2 * HI + 30]));
    // Once the window lapses the reader reads the row again, and the same.
    w.clock.advance(TTL + 1);
    expect(await collect(w.a.iterate())).toEqual(NEW);
    expect(await w.a.has(20)).toBe(false);
  });

  it.each<[string, Options]>([
    ['on an encrypted segment', { encrypted: true }],
    ['through the retrying wrapper a store reads through by default', { retry: true }],
    [
      'when several segments press on the reader cache',
      {
        readerMax: 3,
        evictors: ['b', 'c', 'd'].map((segment) => ({ segment, ids: [1] })),
      },
    ],
  ])('iterate returns one generation %s', async (_, options) => {
    const w = await world(options);
    await warmLetGoAndCount(w);
    await takeNumberAgain(w);
    expectOneGeneration(await collect(w.a.iterate()), OLD, NEW);
  });

  it('a has() after the count answers from one generation: never the erased id and a new id both', async () => {
    const w = await world();
    await warmLetGoAndCount(w);
    await takeNumberAgain(w);
    // 20 is only in the old object's chunk 0, and 131102 only in the new object's chunk 2.
    const pair = [await w.a.has(20), await w.a.has(2 * HI + 30)];
    expect([
      [true, false],
      [false, true],
    ]).toContainEqual(pair);
    expect(await w.a.has(20)).toBe(pair[0]);
    expect(await w.a.has(30)).toBe(pair[1]);
  });

  it('an object of the same size under the retaken number is told apart by its footer checksum', async () => {
    // One id in each of two chunks, as before: the new object is the old one's size, so only its checksum differs.
    // Only chunk 0 of the old object is cached, so a read that took the new object for the old one would mix them.
    const same = [30, HI + 30];
    const w = await world();
    const before = await sizeOfGeneration1(w.backend.storage);
    expect(await w.a.has(20)).toBe(true);
    for (const s of w.evictors) expect(await s.has(1)).toBe(true);
    expect(await w.a.count()).toBe(OLD.length);
    await takeNumberAgain(w, same);
    expect(await sizeOfGeneration1(w.backend.storage)).toBe(before);
    expectOneGeneration(await collect(w.a.iterate()), OLD, same);
    expect([
      [true, false],
      [false, true],
    ]).toContainEqual([await w.a.has(20), await w.a.has(30)]);
  });

  it('an intersect with another segment reads one generation of each', async () => {
    // `c` holds every id of both objects but the erased one. It is read last before the count, so it stays in the
    // reader cache beside `a` and the intersect opens neither again.
    const C = [1, HI + 20, 30, HI + 30, 2 * HI + 30];
    const w = await world({
      readerMax: 2,
      evictors: [
        { segment: 'b', ids: [1] },
        { segment: 'c', ids: C },
      ],
    });
    await warmLetGoAndCount(w);
    await takeNumberAgain(w);
    const c = w.reader.segment('c', { namespace: NS });
    const ids = await collect(w.a.intersect([c]));
    expectOneGeneration(ids, [HI + 20], NEW);
  });

  it('two stores over one shared source: one store’s cached chunks are never served beside the new object', async () => {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend, retry: false });
    const clock = manualClock();
    const source = new CrbmStorageChunkSource(backend.storage, {
      registry: backend.registry,
      clock,
      currentGenTtlMs: TTL,
      maxOpenSegments: 1,
    });
    const x = new CloudRoaring({ storage: source, retry: false });
    const y = new CloudRoaring({ storage: source, retry: false });
    await writer.load(A, FIRST);
    await writer.load(A, OLD);
    await writer.load({ namespace: NS, segment: 'b' }, [1]);
    const xa = x.segment('a', { namespace: NS });
    expect(await xa.has(20)).toBe(true);
    expect(await xa.has(HI + 20)).toBe(true);
    // The other store lets `a` go from the shared reader cache and counts it from the row alone.
    expect(await y.segment('b', { namespace: NS }).has(1)).toBe(true);
    expect(await y.segment('a', { namespace: NS }).count()).toBe(OLD.length);
    await writer.rollback(A, 0);
    await writer.eraseSubject(20, { namespace: NS });
    expect(await writer.load(A, NEW)).toMatchObject({ generation: 1, published: true });
    expectOneGeneration(await collect(xa.iterate()), OLD, NEW);
  });
});

describe('the source names the object a chunk was read from', () => {
  async function all(stream: AsyncIterable<ChunkRead>): Promise<ChunkRead[]> {
    const out: ChunkRead[] = [];
    for await (const item of stream) out.push(item);
    return out;
  }

  it('getChunks, currentVersion, listChunkKeys and cardinalities of the new object never carry the old version', async () => {
    const w = await sourceWorld({ old: OLD, fresh: NEW });
    const before = await all(w.source.getChunks!(A, [0, 1]));
    const old = await w.source.currentVersion(A);
    expect(before.map((c) => c.version)).toEqual([old, old]);
    await w.letGoAndSummarize();
    await w.takeAgain();
    expect(await w.source.listChunkKeys(A)).toEqual([0, 1, 2]);
    expect([...((await w.source.cardinalities(A)) ?? new Map()).values()]).toEqual([1, 1, 1]);
    const now = await w.source.currentVersion(A);
    expect(now).not.toBe(old);
    const after = await all(w.source.getChunks!(A, [0, 1, 2]));
    expect(after.map((c) => c.version)).toEqual([now, now, now]);
  });

  it('an object of the same size under the retaken number has another version', async () => {
    const same = [30, HI + 30];
    const w = await sourceWorld({ old: OLD, fresh: same });
    const old = await w.source.currentVersion(A);
    const size = await sizeOfGeneration1(w.backend.storage);
    await w.letGoAndSummarize();
    await w.takeAgain();
    expect(await sizeOfGeneration1(w.backend.storage)).toBe(size);
    const now = await w.source.currentVersion(A);
    expect(now).not.toBe(old);
    expect((await all(w.source.getChunks!(A, [0, 1]))).map((c) => c.version)).toEqual([now, now]);
  });

  it('a running stream that took on the count’s snapshot moves on once that snapshot opens another object', async () => {
    // Four chunks, small enough that the reader keeps them from its open: a stream that did not move on would go on
    // serving the earlier object from memory, with no request to fail.
    const old = [20, HI + 20, 2 * HI + 20, 3 * HI + 20];
    const fresh = [30, HI + 30, 2 * HI + 30, 3 * HI + 30];
    const w = await sourceWorld({ old, fresh });
    const stream = w.source.getChunks!(A, [0, 1, 2, 3], { concurrency: 1 });
    const first = await stream.next();
    const was = await w.source.currentVersion(A);
    expect(first.value).toMatchObject({ key: 0, version: was });
    await w.letGoAndSummarize();
    // The row has not moved, so the stream takes on the count's snapshot and goes on with the object it has.
    expect((await stream.next()).value).toMatchObject({ key: 1, version: was });
    await w.takeAgain();
    // Another read opens the snapshot's reader: the object now under number 1.
    const now = await w.source.currentVersion(A);
    expect(now).not.toBe(was);
    const third = (await stream.next()).value as ChunkRead;
    expect(third).toMatchObject({ key: 2, version: now });
    expect(third.bytes).toEqual(await w.source.getChunk({ ...A, chunkKey: 2 }));
    expect((await stream.next()).value).toMatchObject({ key: 3, version: now });
    expect((await stream.next()).done).toBe(true);
  });
});

describe('a running stream and another read opening its segment', () => {
  const B: SegmentRef = { namespace: NS, segment: 'b' };
  const KEYS = [0, 1, 2, 3];
  const sleep = (ms: number): Promise<'stalled'> =>
    new Promise((resolve) => setTimeout(() => resolve('stalled'), ms));

  /**
   * A source with no timed refresh and room for one reader, over `a` (four chunks) and `b`. The next tail read of `a`
   * can be held, to be let go or failed later: another read's open of the segment, under way.
   */
  async function coupled() {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend, retry: false });
    await writer.load(A, [20, HI + 20, 2 * HI + 20, 3 * HI + 20]);
    await writer.load(B, [1]);
    let armed = false;
    const held: Array<{ release: () => void; fail: (err: Error) => void }> = [];
    const storage = new Proxy(backend.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) => {
          if (!armed || key.segment !== 'a') return t.getTail(key, maxBytes);
          armed = false;
          return new Promise((resolve, reject) => {
            held.push({
              release: () => void t.getTail(key, maxBytes).then(resolve, reject),
              fail: reject,
            });
          });
        };
      },
    }) as IStorageDriver;
    const source = new CrbmStorageChunkSource(storage, {
      registry: backend.registry,
      maxOpenSegments: 1,
    });
    /** A stream of `a` that has yielded its first chunk, then another read opening `a` whose tail read is held. */
    const streamThenHeldOpen = async () => {
      const stream = source.getChunks!(A, KEYS, { concurrency: 1 });
      expect((await stream.next()).value).toMatchObject({ key: 0 });
      await source.listChunkKeys(B); // the reader cache lets `a` go
      armed = true;
      const other = source.currentVersion(A);
      other.catch(() => undefined);
      while (held.length === 0) await sleep(1);
      return { stream, other, open: held[0]! };
    };
    return { streamThenHeldOpen };
  }

  async function rest(stream: AsyncGenerator<ChunkRead>): Promise<number[]> {
    const keys: number[] = [];
    for (let r = await stream.next(); r.done !== true; r = await stream.next())
      keys.push(r.value.key);
    return keys;
  }

  it('the stream goes on yielding while the other open is under way', async () => {
    const { stream, other, open } = await (await coupled()).streamThenHeldOpen();
    const second = await Promise.race([stream.next(), sleep(200)]);
    expect(second).not.toBe('stalled');
    expect((second as IteratorResult<ChunkRead>).value).toMatchObject({ key: 1 });
    open.release();
    await other;
    expect(await rest(stream)).toEqual([2, 3]);
  });

  it('the other open’s failure is not the stream’s: it goes on, and the error stays with the read that met it', async () => {
    const { stream, other, open } = await (await coupled()).streamThenHeldOpen();
    const second = stream.next();
    await sleep(20);
    open.fail(new Error('AccessDenied (simulated)'));
    await expect(other).rejects.toThrow('AccessDenied (simulated)');
    expect((await second).value).toMatchObject({ key: 1 });
    expect(await rest(stream)).toEqual([2, 3]);
  });

  it('the other open’s failure, met before the stream asks again, is not the stream’s either', async () => {
    const { stream, other, open } = await (await coupled()).streamThenHeldOpen();
    open.fail(new Error('AccessDenied (simulated)'));
    await expect(other).rejects.toThrow('AccessDenied (simulated)');
    expect(await rest(stream)).toEqual([1, 2, 3]);
  });

  it('after it takes on a newer snapshot, a chunk costs the stream what a chunk cost it before', async () => {
    // A clock that counts its readings: the stream reads it, through the reader cache, as often as it compares.
    let readings = 0;
    const clock = {
      now: (): number => {
        readings += 1;
        return 0;
      },
    };
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend, retry: false });
    const keys = [0, 1, 2, 3, 4, 5, 6, 7];
    await writer.load(
      A,
      keys.map((k) => k * HI + 1),
    );
    await writer.load(B, [1]);
    const source = new CrbmStorageChunkSource(backend.storage, {
      registry: backend.registry,
      clock,
      currentGenTtlMs: TTL,
      maxOpenSegments: 1,
    });
    const stream = source.getChunks!(A, keys, { concurrency: 1 });
    const cost = async (): Promise<number> => {
      const before = readings;
      expect((await stream.next()).done).toBe(false);
      return readings - before;
    };
    await cost(); // chunk 0: the open
    const steady = await cost();
    expect(await cost()).toBe(steady);
    await source.listChunkKeys(B); // the reader cache lets `a` go
    expect((await source.summary(A))?.cardinality).toBe(keys.length); // a newer snapshot, not opened
    await cost(); // the stream compares it with its own and takes it on
    for (let i = 0; i < 3; i++) expect(await cost()).toBe(steady);
  });

  describe('when the object now under the number cannot be read', () => {
    // The stream took on the count's snapshot, the number was taken again, and the new object is then gone or
    // corrupt: the stream moves to what the row names now and meets that object's own typed error.
    async function stalled(spoil: (storage: IStorageDriver) => Promise<void>) {
      const old = [20, HI + 20, 2 * HI + 20, 3 * HI + 20];
      const w = await sourceWorld({ old, fresh: [30, HI + 30, 2 * HI + 30, 3 * HI + 30] });
      const stream = w.source.getChunks!(A, KEYS, { concurrency: 1 });
      expect((await stream.next()).value).toMatchObject({ key: 0 });
      await w.letGoAndSummarize();
      expect((await stream.next()).value).toMatchObject({ key: 1 });
      await w.takeAgain();
      await spoil(w.backend.storage);
      // Another read opens the count's snapshot: the open fails.
      await expect(w.source.currentVersion(A)).rejects.toThrow();
      return stream;
    }

    it('gone: the stream fails with NotFoundError', async () => {
      const stream = await stalled((storage) => storage.delete({ ...A, generation: 1 }));
      await expect(stream.next()).rejects.toBeInstanceOf(NotFoundError);
    });

    it('corrupt: the stream fails with IntegrityError', async () => {
      const stream = await stalled(async (storage) => {
        await storage.delete({ ...A, generation: 1 });
        await storage.putImmutable({ ...A, generation: 1 }, async (out) =>
          out.write(new Uint8Array(256).fill(0xab)),
        );
      });
      await expect(stream.next()).rejects.toBeInstanceOf(IntegrityError);
    });
  });
});

describe('the version’s spelling', () => {
  it('a pin holds the row’s version, with no object suffix: what a live version names without it', async () => {
    const w = await sourceWorld({ old: OLD, fresh: NEW });
    const live = await w.source.currentVersion(A);
    const pinned = await w.source.pinGeneration(A);
    expect(pinned?.version).not.toContain('#');
    expect(pinned?.version).toBe(rowVersionOf(live!));
    expect(live).toBe(`${pinned!.version}#${compactFingerprint(pinned!.fingerprint)}`);
    // And a store's pinned handle says the same.
    const store = new CloudRoaring({ storage: w.backend, retry: false });
    const handle = await store.segment('a', { namespace: NS }).pin();
    expect(handle.pinnedAt?.version).toBe(pinned?.version);
  });

  it('rowVersionOf drops the object suffix of a live version, and only that', () => {
    expect(rowVersionOf('1:tok#5h.1b8gqkl')).toBe('1:tok');
    expect(rowVersionOf('0#5h.1b8gqkl')).toBe('0');
    expect(rowVersionOf('1:a#b#5h.1b8gqkl')).toBe('1:a#b');
    // A row token that itself ends like a suffix is kept: only the version's end is the object.
    expect(rowVersionOf('1:a#b.c#5h.1b8gqkl')).toBe('1:a#b.c');
    expect(rowVersionOf('1:x#5h.1b8gqkl#7.9')).toBe('1:x#5h.1b8gqkl');
  });

  it('tokenOfVersion reads the token of a row version; a live one is read through rowVersionOf', () => {
    expect(tokenOfVersion('1:tok')).toBe('tok');
    expect(tokenOfVersion(rowVersionOf('1:tok#5h.1b8gqkl'))).toBe('tok');
    expect(tokenOfVersion('0')).toBeUndefined();
    expect(tokenOfVersion(rowVersionOf('0#5h.1b8gqkl'))).toBeUndefined();
    expect(tokenOfVersion(null)).toBeUndefined();
    // A pin's version is not stripped: a token that happens to end like a suffix is the token.
    expect(tokenOfVersion('1:a#b.c')).toBe('a#b.c');
  });

  it('the compact fingerprint is the size and the footer checksum in base 36', () => {
    expect(compactFingerprint('197:2858319717')).toBe(
      `${(197).toString(36)}.${(2858319717).toString(36)}`,
    );
    expect(compactFingerprint('0:0')).toBe('0.0');
  });
});

describe('a reopen of the same object costs what it did', () => {
  it('after the reader cache lets a segment go, its cached chunks still answer: a pointer read and a tail read, no range', async () => {
    const w = await world();
    expect(await w.a.has(20)).toBe(true);
    expect(await w.a.has(HI + 20)).toBe(true);
    expect(await collect(w.a.iterate())).toEqual(OLD);
    expect(await w.evictors[0]!.has(1)).toBe(true);
    let before = w.requests();
    let hits = w.cacheHits();
    expect(await w.a.has(20)).toBe(true);
    expect(w.requests()).toEqual({ ...before, pointer: before.pointer + 1, tail: before.tail + 1 });
    expect(w.cacheHits()).toBe(hits + 1);
    // Warm: nothing at all.
    before = w.requests();
    expect(await w.a.has(HI + 20)).toBe(true);
    expect(await collect(w.a.iterate())).toEqual(OLD);
    expect(w.requests()).toEqual(before);
    // A streamed read after the reader cache lets the segment go again: every chunk from the cache.
    expect(await w.evictors[0]!.has(1)).toBe(true);
    before = w.requests();
    hits = w.cacheHits();
    expect(await collect(w.a.iterate())).toEqual(OLD);
    expect(w.requests()).toEqual({ ...before, pointer: before.pointer + 1, tail: before.tail + 1 });
    expect(w.cacheHits()).toBe(hits + OLD.length);
  });

  it('a cold count is one pointer read; a has() after it opens the object once; a warm has() makes no request', async () => {
    const w = await world();
    expect(await w.a.count()).toBe(OLD.length);
    expect(w.requests()).toEqual({ pointer: 1, tail: 0, range: 0 });
    expect(await w.a.has(20)).toBe(true);
    // The reader keeps this small generation's chunks from its open, so the has() makes no range read.
    expect(w.requests()).toEqual({ pointer: 1, tail: 1, range: 0 });
    expect(await w.a.has(20)).toBe(true);
    expect(await w.a.has(HI + 20)).toBe(true);
    expect(w.requests()).toEqual({ pointer: 1, tail: 1, range: 0 });
  });
});
