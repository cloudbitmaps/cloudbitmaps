import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { IKeystore } from '@/core/crypto';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { IntegrityError, KeyUnavailableError, NotFoundError, TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { openSummary, summaryAgrees, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * A rollback writes the target's own count and metadata into the row, in the write that moves the pointer, so a reader
 * that sees the target as current sees what describes it. It reads them from the object with the one tail read it
 * already makes to check that the target is what the row says the segment is. An undo of a rollback whose target was
 * collected meanwhile puts the old row's summary back, and an encrypted target on a store with no key leaves the row with
 * none.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const A: GenerationMetadata = { run: 'a', n: 1 };
const B: GenerationMetadata = { run: 'b', n: 2 };

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

function world(keystore?: IKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const load = { storage, registry, codec: roaringCodec, keystore };
  return { storage, registry, load, deps: { storage, registry, keystore } };
}
type World = ReturnType<typeof world>;

/** Generation 0 holds three ids and metadata A, generation 1 one id and metadata B, both kept. */
async function twoGenerations(w: World): Promise<void> {
  await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9, metadata: A });
  await loadSegment(SEG, [9], w.load, { keep: 9, metadata: B, guard: {} });
}

async function describedBy(w: World): Promise<unknown> {
  const row = (await w.registry.get(SEG))!;
  const aead =
    row.wrappedDeks === undefined ? undefined : await w.load.keystore!.openDek(row.wrappedDeks);
  return usableSummary(SEG, row, aead);
}

describe('a rollback of a cleartext segment', () => {
  it("writes the target's count and metadata into the row, and rolling forward writes the other's", async () => {
    const w = world();
    await twoGenerations(w);
    expect(await describedBy(w)).toEqual({ cardinality: 1, metadata: B });

    await rollbackSegment(SEG, 0, w.deps);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(row.summary).toEqual({ generation: 0, cardinality: 3, metadata: A });
    // And it is the target's own: the object holds the same.
    const reader = await openGenerationReader(w.storage, { ...SEG, generation: 0 }, undefined);
    expect(
      summaryAgrees(
        { cardinality: 3, metadata: A },
        { cardinality: reader.count(), metadata: reader.metadata },
      ),
    ).toBe(true);

    await rollbackSegment(SEG, 1, w.deps, { allowForward: true });
    expect((await w.registry.get(SEG))!.summary).toEqual({
      generation: 1,
      cardinality: 1,
      metadata: B,
    });
  });

  it('writes a summary with no metadata for a target that has none, replacing the one it moves off', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.load, { keep: 9 });
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9, metadata: B });
    await rollbackSegment(SEG, 0, w.deps);
    expect((await w.registry.get(SEG))!.summary).toStrictEqual({ generation: 0, cardinality: 2 });
  });

  it('writes the summary of a target a row of an earlier build left with none', async () => {
    const w = world();
    await twoGenerations(w);
    // Generation 0 was written by a build that did not give its row a summary: there is none to keep, and the rollback
    // still writes one for the target.
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { summary: undefined });
    await rollbackSegment(SEG, 0, w.deps);
    expect((await w.registry.get(SEG))!.summary).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: A,
    });
  });

  it('is one tail read of a target whose index fits in it, the one that checks it is what the row says the segment is', async () => {
    const w = world();
    await twoGenerations(w);
    const calls: Record<string, number> = {};
    const storage = counting<IStorageDriver>(w.storage, calls);
    await rollbackSegment(SEG, 0, { storage, registry: w.registry });
    expect(calls.getTail).toBe(1);
    expect(calls.getRange).toBeUndefined();
    expect(calls.list).toBe(2); // before the swap, and the check after it, as ever
  });

  it('refuses a target whose footer, index or generation is not a readable object, and moves nothing', async () => {
    const w = world();
    await twoGenerations(w);
    // Generation 0 replaced by an object that says it is generation 5.
    await w.storage.delete({ ...SEG, generation: 0 });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 5 }, [1], {
      registry: new MemoryRegistryDriver(),
    });
    const bytes = (await w.storage.getTail({ ...SEG, generation: 5 }, 1 << 20)).bytes;
    await w.storage.putImmutable({ ...SEG, generation: 0 }, async (sink) => sink.write(bytes));
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toBeInstanceOf(IntegrityError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });
});

describe('a rollback of an encrypted segment', () => {
  it('seals the target count and metadata into the row, with the key', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    await rollbackSegment(SEG, 0, w.deps);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(Object.keys(row.summary!).sort()).toEqual(['generation', 'sealed']);
    const aead = await keystore.openDek(row.wrappedDeks!);
    expect(openSummary(aead, SEG, row.summary as never)).toEqual({ cardinality: 3, metadata: A });
    const reader = await openGenerationReader(
      w.storage,
      { ...SEG, generation: 0 },
      {
        aead,
        aadFor: (scope) => aadFor(SEG, 0, scope),
      },
    );
    expect(reader.metadata).toEqual(A);
  });

  it('is one tail read of a target whose index fits in it, with the key too', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    const calls: Record<string, number> = {};
    await rollbackSegment(SEG, 0, {
      storage: counting<IStorageDriver>(w.storage, calls),
      registry: w.registry,
      keystore,
    });
    expect(calls.getTail).toBe(1);
    expect(calls.getRange).toBeUndefined();
  });

  it('on a store with no keystore rolls back, leaves the row with no summary, and reads one tail', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    const calls: Record<string, number> = {};
    const r = await rollbackSegment(SEG, 0, {
      storage: counting<IStorageDriver>(w.storage, calls),
      registry: w.registry,
    });
    expect(r).toEqual({ fromGeneration: 1, generation: 0 });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(row.summary).toBeUndefined();
    expect(calls.getTail).toBe(1);
  });

  it('on a store whose keystore cannot open the segment key does the same', async () => {
    const strangers = [
      // None of the segment's KEKs.
      new InProcessKeystore({ keys: { other: randomBytes(32) }, activeKeyId: 'other' }),
      // A KEK of the same name that is not the one the key was wrapped under.
      new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' }),
    ];
    for (const stranger of strangers) {
      const w = world(key());
      await twoGenerations(w);
      await expect(stranger.openDek((await w.registry.get(SEG))!.wrappedDeks!)).rejects.toSatisfy(
        (e) => e instanceof KeyUnavailableError || e instanceof IntegrityError,
      );
      await rollbackSegment(SEG, 0, { ...w.deps, keystore: stranger });
      const row = (await w.registry.get(SEG))!;
      expect(row.currentGen).toBe(0);
      expect(row.summary).toBeUndefined();
    }
  });

  it('refuses a target sealed under another key, and moves nothing', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    // Generation 0 replaced by one sealed under a key of its own, on a row the segment does not have.
    await w.storage.delete({ ...SEG, generation: 0 });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [1], {
      registry: new MemoryRegistryDriver(),
      keystore: key(),
    });
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toBeInstanceOf(IntegrityError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('still refuses a cleartext target under a row with keys, and an encrypted one under a row with none', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    await w.storage.delete({ ...SEG, generation: 0 });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [1], {
      registry: new MemoryRegistryDriver(),
    });
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toThrow(
      /is cleartext, but the segment is encrypted/,
    );
    await expect(rollbackSegment(SEG, 0, { ...w.deps, keystore: undefined })).rejects.toThrow(
      /is cleartext, but the segment is encrypted/,
    );

    const plain = world();
    await twoGenerations(plain);
    await plain.storage.delete({ ...SEG, generation: 0 });
    await bulkLoadCrbmGeneration(plain.storage, { ...SEG, generation: 0 }, [1], {
      registry: new MemoryRegistryDriver(),
      keystore: key(),
    });
    await expect(rollbackSegment(SEG, 0, plain.deps)).rejects.toThrow(
      /is encrypted, but the segment is cleartext/,
    );
  });
});

/**
 * `deps.storage`, with the listing the rollback makes after its swap hiding `hidden`: the object was collected while the
 * pointer moved.
 */
function collectingAfterSwap(w: World, hidden: number): IStorageDriver {
  let lists = 0;
  return new Proxy(w.storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'list') return value;
      return (ref: SegmentRef) => {
        lists += 1;
        const inner = (value as IStorageDriver['list']).call(t, ref);
        if (lists === 1) return inner;
        return (async function* () {
          for await (const k of inner) if (k.generation !== hidden) yield k;
        })();
      };
    },
  });
}

describe('the undo of a rollback whose target was collected while the pointer moved', () => {
  it('puts the old row back with its summary', async () => {
    const w = world();
    await twoGenerations(w);
    const before = (await w.registry.get(SEG))!;
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toThrow(/the pointer was put back/);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    expect(row.summary).toEqual(before.summary);
    expect(row.summary).toEqual({ generation: 1, cardinality: 1, metadata: B });
  });

  it('puts the old sealed summary back on an encrypted segment', async () => {
    const keystore = key();
    const w = world(keystore);
    await twoGenerations(w);
    const before = (await w.registry.get(SEG))!;
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toThrow(/the pointer was put back/);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    expect(row.summary).toEqual(before.summary);
    expect(
      openSummary(await keystore.openDek(row.wrappedDeks!), SEG, row.summary as never),
    ).toEqual({
      cardinality: 1,
      metadata: B,
    });
  });

  it('puts back none when the old row had none', async () => {
    const w = world();
    await twoGenerations(w);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { summary: undefined });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toThrow(/the pointer was put back/);
    const after = (await w.registry.get(SEG))!;
    expect(after.currentGen).toBe(1);
    expect(after.summary).toBeUndefined();
  });

  it('does not put back a summary the row held for another generation, which a registry refuses to write', async () => {
    const w = world();
    await twoGenerations(w);
    // A registry of someone else's left the row with a summary of generation 0 beside a pointer at 1. It is shown to the
    // rollback as it is; writing it back would be refused, so the undo writes none.
    const stale: IRegistryDriver = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return value;
        return async (...args: Parameters<IRegistryDriver['get']>) => {
          const row = await (value as IRegistryDriver['get']).apply(t, args);
          return row === null ? null : { ...row, summary: { generation: 0, cardinality: 3 } };
        };
      },
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry: stale, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toThrow(/the pointer was put back/);
    const after = (await w.registry.get(SEG))!;
    expect(after.currentGen).toBe(1);
    expect(after.summary).toBeUndefined();
  });

  it('does not put back a summary in the clear beside the keys of an encrypted row, which a registry refuses to write', async () => {
    const w = world(key());
    await twoGenerations(w);
    // A registry of someone else's left a clear summary of generation 1 on an encrypted row. A shipped registry refuses
    // to write that shape, so the undo writes none rather than fail.
    const odd: IRegistryDriver = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return value;
        return async (...args: Parameters<IRegistryDriver['get']>) => {
          const row = await (value as IRegistryDriver['get']).apply(t, args);
          return row === null ? null : { ...row, summary: { generation: 1, cardinality: 1 } };
        };
      },
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry: odd, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toThrow(/the pointer was put back/);
    const after = (await w.registry.get(SEG))!;
    expect(after.currentGen).toBe(1);
    expect(after.summary).toBeUndefined();
  });

  it('is a NotFoundError either way', async () => {
    const w = world();
    await twoGenerations(w);
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, storage: collectingAfterSwap(w, 0) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the store passes its keystore to a rollback', () => {
  it('so an encrypted segment rolls back with a sealed summary of the target', async () => {
    const keystore = key();
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
    await store.load(SEG, [1, 2, 3], { keep: 9, metadata: A });
    await store.load(SEG, [9], { keep: 9, metadata: B });
    await store.rollback(SEG, 0);
    const row = (await backend.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(
      openSummary(await keystore.openDek(row.wrappedDeks!), SEG, row.summary as never),
    ).toEqual({
      cardinality: 3,
      metadata: A,
    });
  });
});

describe('a target whose index is longer than the tail read', () => {
  it('is read with one range read more, for its count and metadata, and the row says them', async () => {
    const w = world();
    // One id in each of 60,000 chunks: an index of about 600 KB, past the 256 KiB the tail read takes.
    const wide = Array.from({ length: 60_000 }, (_, i) => i * 65_536);
    await loadSegment(SEG, wide, w.load, { keep: 9, metadata: A });
    await loadSegment(SEG, [9], w.load, { keep: 9, metadata: B, guard: {} });
    const calls: Record<string, number> = {};
    await rollbackSegment(SEG, 0, {
      storage: counting<IStorageDriver>(w.storage, calls),
      registry: w.registry,
    });
    expect(calls.getTail).toBe(1);
    expect(calls.getRange).toBe(1);
    expect((await w.registry.get(SEG))!.summary).toEqual({
      generation: 0,
      cardinality: wide.length,
      metadata: A,
    });
  });
});

describe('a rollback on a store that holds a keystore', () => {
  it('rolls a cleartext segment back with a clear summary: a segment with no keys has none to open', async () => {
    // A store that turned encryption on after some segments existed.
    const w = world();
    await twoGenerations(w);
    const keystore = key();
    let opened = 0;
    const spy: IKeystore = {
      createDek: () => keystore.createDek(),
      openDek: (wrapped) => {
        opened += 1;
        return keystore.openDek(wrapped);
      },
    };
    await rollbackSegment(SEG, 0, { ...w.deps, keystore: spy });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(row.summary).toEqual({ generation: 0, cardinality: 3, metadata: A });
    expect(opened).toBe(0); // a segment with no keys has none to open
  });

  it('treats any failure to open the key of an encrypted segment as no key at hand: it still rolls back, and writes no summary', async () => {
    const failures: unknown[] = [
      new TransientError('key service answered 503'),
      new Error('the key service timed out'),
      new KeyUnavailableError('no key'),
      new IntegrityError('a key that does not unwrap'),
    ];
    for (const failure of failures) {
      const real = key();
      const w = world(real);
      await twoGenerations(w);
      const unreachable: IKeystore = {
        createDek: () => real.createDek(),
        openDek: () => Promise.reject(failure),
      };
      const calls: Record<string, number> = {};
      const result = await rollbackSegment(SEG, 0, {
        storage: counting<IStorageDriver>(w.storage, calls),
        registry: w.registry,
        keystore: unreachable,
      });
      expect(result).toEqual({ fromGeneration: 1, generation: 0 });
      const row = (await w.registry.get(SEG))!;
      expect(row.currentGen).toBe(0);
      expect(row.summary).toBeUndefined();
      expect(calls.getTail).toBe(1);
    }
  });
});

/**
 * `deps.storage`, with the first read of `generation`'s footer followed by `swap`, which replaces the object under that
 * number: the object read is gone from the bucket by the time the rollback swaps the pointer.
 */
function replacedAfterFirstRead(
  w: World,
  generation: number,
  swap: () => Promise<void>,
): IStorageDriver {
  let done = false;
  return new Proxy(w.storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'getTail') return typeof value === 'function' ? value.bind(t) : value;
      return async (...args: Parameters<IStorageDriver['getTail']>) => {
        const out = await (value as IStorageDriver['getTail']).apply(t, args);
        if (!done && args[0].generation === generation && args[1] > 0) {
          done = true;
          await t.delete(args[0]);
          await swap();
        }
        return out;
      };
    },
  });
}

describe('an allowForward rollback onto an object above the pointer that was replaced after it was read', () => {
  /** Generation 2 holds nine ids and metadata B; the pointer is rolled back to 1, so 2 is above it. */
  async function rolledBackBelowTwo(w: World): Promise<void> {
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9, metadata: A });
    await loadSegment(SEG, [1, 2, 3, 4, 5], w.load, { keep: 9, guard: {} });
    await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9], w.load, {
      keep: 9,
      metadata: B,
      guard: {},
    });
    await rollbackSegment(SEG, 1, w.deps);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  }

  const other = (w: World) => async (): Promise<void> => {
    // An erasure took the object's number out of the bucket and a load took it again: two ids, other metadata.
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 2 }, [100, 200], {
      registry: w.registry,
      keystore: w.load.keystore,
      metadata: { run: 'replacement' },
      publish: false,
    });
  };

  it.each([
    ['cleartext', (): World => world()],
    ['encrypted', (): World => world(key())],
  ])('puts the pointer and its summary back, on a %s segment', async (_name, make) => {
    const w = make();
    await rolledBackBelowTwo(w);
    const before = (await w.registry.get(SEG))!;
    await expect(
      rollbackSegment(
        SEG,
        2,
        { ...w.deps, storage: replacedAfterFirstRead(w, 2, other(w)) },
        { allowForward: true },
      ),
    ).rejects.toThrow(
      /generation 2 of "s" was replaced while the pointer was moving — the pointer was put back/,
    );
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    expect(row.summary).toEqual(before.summary);
  });

  it('is a NotFoundError, as a collected target is', async () => {
    const w = world();
    await rolledBackBelowTwo(w);
    await expect(
      rollbackSegment(
        SEG,
        2,
        { ...w.deps, storage: replacedAfterFirstRead(w, 2, other(w)) },
        { allowForward: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('treats a replacement of the same size whose footer does not check as another object too', async () => {
    const w = world();
    await rolledBackBelowTwo(w);
    const original = (await w.storage.getTail({ ...SEG, generation: 2 }, 1 << 20)).bytes;
    const corrupt = original.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    const garbage = async (): Promise<void> => {
      await w.storage.putImmutable({ ...SEG, generation: 2 }, (sink) => sink.write(corrupt));
    };
    await expect(
      rollbackSegment(
        SEG,
        2,
        { ...w.deps, storage: replacedAfterFirstRead(w, 2, garbage) },
        { allowForward: true },
      ),
    ).rejects.toThrow(/was replaced while the pointer was moving/);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('lands when the object is the one it read, and reads the target footer once more to know', async () => {
    const w = world();
    await rolledBackBelowTwo(w);
    const calls: Record<string, number> = {};
    await rollbackSegment(
      SEG,
      2,
      { storage: counting<IStorageDriver>(w.storage, calls), registry: w.registry },
      { allowForward: true },
    );
    expect(calls.getTail).toBe(2);
    expect((await w.registry.get(SEG))!.summary).toEqual({
      generation: 2,
      cardinality: 9,
      metadata: B,
    });
  });

  it('reads nothing more for an encrypted target it has no key to open, and leaves the row with no summary', async () => {
    const w = world(key());
    await rolledBackBelowTwo(w);
    const calls: Record<string, number> = {};
    await rollbackSegment(
      SEG,
      2,
      { storage: counting<IStorageDriver>(w.storage, calls), registry: w.registry },
      { allowForward: true },
    );
    expect(calls.getTail).toBe(1);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(2);
    expect(row.summary).toBeUndefined();
  });

  it('reads nothing more for a target below the pointer, where a number cannot be taken again', async () => {
    const w = world();
    await twoGenerations(w);
    const calls: Record<string, number> = {};
    await rollbackSegment(
      SEG,
      0,
      { storage: counting<IStorageDriver>(w.storage, calls), registry: w.registry },
      { allowForward: true },
    );
    expect(calls.getTail).toBe(1);
  });
});
