import { randomBytes } from 'node:crypto';
vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);

import { NotFoundError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

/**
 * A cold `count()` of a current generation is answered from the registry row alone: one pointer read, and no read of
 * the object, whether the segment is cleartext or encrypted and however wide its index is. A row with no summary it
 * can use sends the count to the object as before and gives the same answer. One resolution serves a `count` and the
 * `has` after it, which reads the generation the count saw, and a segment that was purged and loaded again is never
 * answered from the old row's summary.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const TTL = 2_000;

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => {},
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A writer store, and a counting reader store over the same bucket, which has read nothing yet. */
function world(options: { encrypted?: boolean; readerMax?: number; readerMaxBytes?: number } = {}) {
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const backend = new MemoryStorage();
  const clock = manualClock();
  const writer = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
  });
  const calls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(backend.storage, calls);
  /** What the reader's registry says of a row, for a test to change what a read finds there. */
  const tamper: { row: (row: RegistryRecord) => RegistryRecord } = { row: (row) => row };
  const registry = counting<IRegistryDriver>(
    new Proxy(backend.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return value;
        return async (ref: SegmentRef) => {
          const row = await t.get(ref);
          return row === null ? null : tamper.row(row);
        };
      },
    }),
    registryCalls,
  );
  const reader = (retry = false): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      ...(retry ? {} : { retry: false }),
      cache: {
        ...(options.readerMax === undefined ? {} : { readerMax: options.readerMax }),
        ...(options.readerMaxBytes === undefined ? {} : { readerMaxBytes: options.readerMaxBytes }),
      },
      seams: { clock },
      ...(keystore === undefined ? {} : { encryption: { keystore } }),
    });
  const reset = (): void => {
    for (const c of [calls, registryCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  /** What a cold read of the reader store sent: row reads and each kind of object read. */
  const sent = () => ({
    rows: registryCalls.get ?? 0,
    tails: calls.getTail ?? 0,
    ranges: calls.getRange ?? 0,
  });
  return { backend, tamper, writer, reader, clock, reset, sent, registry: backend.registry, calls };
}

/** One id in each of `chunks` chunks, so the index is as wide as the chunk count says. */
const spread = (chunks: number): number[] => Array.from({ length: chunks }, (_, c) => c * 65_536);

describe('a cold count is one request', () => {
  it.each([
    ['cleartext', false, 50],
    ['encrypted', true, 50],
  ])('%s: one row read, no tail and no range read', async (_, encrypted, chunks) => {
    const w = world({ encrypted });
    await w.writer.load(SEG, spread(chunks));
    const store = w.reader();
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(chunks);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('an index wider than the 256 KiB tail read: still one row read', async () => {
    const w = world();
    // 60,000 one-id chunks make an index longer than the tail read, where a count that opened the object needed a
    // third request.
    await w.writer.load(SEG, spread(60_000));
    const store = w.reader();
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(60_000);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('after a setRetention and a TTL lapse: one row read and no re-open', async () => {
    const w = world();
    await w.writer.load(SEG, spread(10));
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.has(0)).toBe(true); // opens the generation
    w.reset();
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    w.clock.advance(TTL + 1);
    expect(await seg.count()).toBe(10);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a count then a has: the one resolution serves both, and the has reads the generation the count saw', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    w.reset();
    expect(await seg.count()).toBe(3);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    // Another process publishes while the TTL has not lapsed: the has still reads what the count described.
    await w.writer.load(SEG, [9]);
    w.reset();
    expect(await seg.has(1)).toBe(true);
    expect(await seg.has(9)).toBe(false);
    expect(w.sent().rows).toBe(0);
    expect(w.sent().tails).toBe(1);
    expect(await seg.count()).toBe(3);
  });

  it('a refresh that finds the same row keeps the open reader, so a read after it opens nothing', async () => {
    const w = world();
    await w.writer.load(SEG, spread(10));
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.has(0)).toBe(true);
    w.clock.advance(TTL + 1);
    w.reset();
    expect(await seg.count()).toBe(10);
    expect(await seg.has(65_536)).toBe(true);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 1 }); // the row, and the one chunk
  });

  it('after the reader cache lets the segment go, inside the TTL: no request at all', async () => {
    const w = world({ readerMax: 1 });
    await w.writer.load(SEG, spread(10));
    await w.writer.load({ ...SEG, segment: 'other' }, spread(3));
    const store = w.reader();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(10);
    // A reader cache of one: counting another segment lets `s` go. Its resolution is kept, for the TTL.
    expect(await store.segment('other', { namespace: 'ns' }).count()).toBe(3);
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(10);
    expect(w.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
    w.clock.advance(TTL);
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(10);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('through the default read retries, a cold count is still one row read', async () => {
    const w = world();
    await w.writer.load(SEG, spread(10));
    const store = w.reader(true);
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(10);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a snapshot that holds only a target weighs its summary, so the reader cache stays bounded', async () => {
    // A ceiling of a few hundred bytes holds about one target. Counting four segments and then the first again makes
    // a second row read for it: its snapshot was evicted by the bytes it weighed, not kept for free.
    const w = world({ readerMaxBytes: 600 });
    for (const name of ['a', 'b', 'c', 'd'])
      await w.writer.load({ ...SEG, segment: name }, spread(5));
    const store = w.reader();
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(await store.segment(name, { namespace: 'ns' }).count()).toBe(5);
    }
    w.reset();
    expect(await store.segment('a', { namespace: 'ns' }).count()).toBe(5);
    expect(w.sent().rows).toBe(1);
  });

  it('a purge and re-create inside one TTL is read as the old one, and after it as the new row', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(3);
    expect(await seg.has(1)).toBe(true); // a reader of the old incarnation is open
    // The name is purged and loaded again: generation 0 again, with another count, under a new row.
    await w.registry.delete(SEG);
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    await w.writer.load(SEG, [10, 11, 12, 13, 14]);
    expect((await w.registry.get(SEG))?.currentGen).toBe(0);
    // Within the TTL the snapshot is the one resolved before: bounded staleness, as for every read.
    expect(await seg.count()).toBe(3);
    // After it, the answer is the freshly read row's summary, never the old one carried over for a generation that
    // has the same number.
    w.clock.advance(TTL + 1);
    expect(await seg.count()).toBe(5);
    expect(await seg.has(14)).toBe(true);
  });
});

describe('a row with no summary it can use', () => {
  it('none: the object is opened, and the answer is the same', async () => {
    const w = world();
    await w.writer.load(SEG, spread(20));
    w.tamper.row = (row) => ({ ...row, summary: undefined });
    const store = w.reader();
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(20);
    expect(w.sent()).toEqual({ rows: 1, tails: 1, ranges: 0 });
  });

  it('naming another generation: the object is opened, and the answer is the same', async () => {
    const w = world();
    await w.writer.load(SEG, spread(20));
    w.tamper.row = (row) => ({
      ...row,
      summary: { generation: 7, cardinality: 999, fingerprint: '4096:1' },
    });
    const store = w.reader();
    w.reset();
    expect(await store.segment('s', { namespace: 'ns' }).count()).toBe(20);
    expect(w.sent()).toEqual({ rows: 1, tails: 1, ranges: 0 });
  });
});

describe('a torn restore', () => {
  it('a cold count and a stat answer the row, while a read of the object throws', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3, 4]);
    const sizeBytes = (await w.backend.storage.getTail({ ...SEG, generation: 0 }, 0)).size;
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(4);
    await expect(seg.has(1)).rejects.toBeInstanceOf(NotFoundError);
    // `stat()` answers from the row's summary, whose fingerprint carries the object's size: the row's figures, which
    // `checkConsistency` is what holds against the bucket.
    expect(await store.segment('s', { namespace: 'ns' }).stat()).toEqual({
      generation: 0,
      cardinality: 4,
      sizeBytes,
    });
  });
});
