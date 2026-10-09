import { randomBytes } from 'node:crypto';
import type { GenerationMetadata, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

/**
 * Metadata comes back through the read path: `stat()` says the current generation's number, count, metadata and size
 * from one opened generation, `generations()` carries the first three on the current entry, and a pin says what it
 * pinned. A cold `stat()` is one row read and one tail read of the object, for its size; a warm one and a pinned one
 * are none.
 * A rollback's target's metadata is what every one of them then says, with a keystore (restored from the sealed
 * summary) and without one (the row's summary is cleared, and the object is read).
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const A: GenerationMetadata = { run: 'a', n: 1 };
const B: GenerationMetadata = { run: 'b', n: 2 };

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

function world(encrypted: boolean) {
  const keystore = encrypted
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
  const rowCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(backend.storage, calls);
  const registry = counting<IRegistryDriver>(backend.registry, rowCalls);
  const reader = (withKey = true): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      retry: false,
      seams: { clock },
      ...(keystore !== undefined && withKey ? { encryption: { keystore } } : {}),
    });
  const reset = (): void => {
    for (const c of [calls, rowCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  const sent = () => ({
    rows: rowCalls.get ?? 0,
    objects: (calls.getTail ?? 0) + (calls.getRange ?? 0),
    lists: calls.list ?? 0,
  });
  return {
    backend,
    writer,
    reader,
    reset,
    sent,
    calls,
    clock,
    keystore,
    registry: backend.registry,
  };
}

describe.each([
  ['cleartext', false],
  ['encrypted', true],
])('%s', (_, encrypted) => {
  it('a load with metadata: stat, generations and a pin all say it', async () => {
    const w = world(encrypted);
    await w.writer.load(SEG, [1, 2, 3], { metadata: A });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
    expect(await store.generations(SEG)).toEqual([
      { generation: 0, current: true, cardinality: 3, metadata: A },
    ]);
    const pinned = await seg.pin();
    expect(await pinned.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
    // A later load moves the live handle and leaves the pin where it was.
    await w.writer.load(SEG, [1, 2, 3, 4], { metadata: B, keep: 9 });
    store.invalidate(SEG);
    expect(await seg.stat()).toEqual({
      generation: 1,
      cardinality: 4,
      metadata: B,
      sizeBytes: expect.any(Number),
    });
    expect(await pinned.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
    expect(await store.generations(SEG)).toEqual([
      { generation: 0, current: false },
      { generation: 1, current: true, cardinality: 4, metadata: B },
    ]);
  });

  it('every *Into with metadata: the destination says it', async () => {
    const w = world(encrypted);
    await w.writer.load({ ...SEG, segment: 'a' }, [1, 2, 3, 4]);
    await w.writer.load({ ...SEG, segment: 'b' }, [3, 4, 5]);
    const a = w.writer.segment('a', { namespace: 'ns' });
    const b = w.writer.segment('b', { namespace: 'ns' });
    const dest = (name: string) => w.writer.segment(name, { namespace: 'ns' });
    await a.intersectInto(dest('i'), [b], { metadata: A });
    await a.unionInto(dest('u'), [b], { metadata: A });
    await a.andNotInto(dest('n'), [b], { metadata: A });
    expect(await dest('i').stat()).toEqual({
      generation: 0,
      cardinality: 2,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
    expect(await dest('u').stat()).toEqual({
      generation: 0,
      cardinality: 5,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
    expect(await dest('n').stat()).toEqual({
      generation: 0,
      cardinality: 2,
      metadata: A,
      sizeBytes: expect.any(Number),
    });
  });

  it('a segment loaded with none says none, and a missing one says no generation', async () => {
    const w = world(encrypted);
    await w.writer.load(SEG, [1]);
    expect(await w.reader().segment('s', { namespace: 'ns' }).stat()).toEqual({
      generation: 0,
      cardinality: 1,
      sizeBytes: expect.any(Number),
    });
    expect(await w.reader().segment('missing', { namespace: 'ns' }).stat()).toEqual({
      generation: null,
      cardinality: 0,
      sizeBytes: null,
    });
  });

  it('a cold stat is one row read, its size from the row; warm and pinned are none', async () => {
    const w = world(encrypted);
    await w.writer.load(SEG, [1, 2, 3], { metadata: A });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    w.reset();
    expect(await seg.stat()).toMatchObject({ generation: 0, cardinality: 3, metadata: A });
    expect(w.sent()).toEqual({ rows: 1, objects: 0, lists: 0 });
    w.reset();
    await seg.stat();
    await seg.count();
    expect(w.sent()).toEqual({ rows: 0, objects: 0, lists: 0 });
    const pinned = await seg.pin();
    w.reset();
    await pinned.stat();
    await pinned.count();
    expect(w.sent()).toEqual({ rows: 0, objects: 0, lists: 0 });
  });

  it('generations() reads the row and lists, and no object: the metadata costs nothing', async () => {
    const w = world(encrypted);
    await w.writer.load(SEG, [1, 2, 3], { metadata: A });
    const store = w.reader();
    w.reset();
    await store.generations(SEG);
    expect(w.sent()).toEqual({ rows: 1, objects: 0, lists: 1 });
  });

  describe('a rollback', () => {
    async function rolledBack() {
      const w = world(encrypted);
      await w.writer.load(SEG, [1, 2, 3], { metadata: A, keep: 9 });
      await w.writer.load(SEG, [1, 2, 3, 4, 5], { metadata: B, keep: 9 });
      await w.writer.rollback(SEG, 0);
      return w;
    }

    it('says the target: stat, generations and count', async () => {
      const w = await rolledBack();
      const store = w.reader();
      const seg = store.segment('s', { namespace: 'ns' });
      expect(await seg.stat()).toEqual({
        generation: 0,
        cardinality: 3,
        metadata: A,
        sizeBytes: expect.any(Number),
      });
      expect(await seg.count()).toBe(3);
      expect(await store.generations(SEG)).toEqual([
        { generation: 0, current: true, cardinality: 3, metadata: A },
        { generation: 1, current: false },
      ]);
    });

    it('without a keystore on an encrypted segment: the row has no summary and the object says it', async () => {
      if (!encrypted) return;
      const w = world(true);
      await w.writer.load(SEG, [1, 2, 3], { metadata: A, keep: 9 });
      await w.writer.load(SEG, [1, 2, 3, 4, 5], { metadata: B, keep: 9 });
      // An operator's process with no key rolls back: the row is left with no summary rather than a clear one.
      const keyless = new CloudRoaring({ storage: w.backend, retry: false });
      await keyless.rollback(SEG, 0);
      expect((await w.registry.get(SEG))!.summary).toBeUndefined();
      const seg = w.reader().segment('s', { namespace: 'ns' });
      w.reset();
      expect(await seg.stat()).toEqual({
        generation: 0,
        cardinality: 3,
        metadata: A,
        sizeBytes: expect.any(Number),
      });
      expect(await seg.count()).toBe(3);
      expect(w.sent().objects).toBeGreaterThan(0); // read from the object, as the row has nothing to say
    });
  });
});
