import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { IKeystore } from '@/core/crypto';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { IntegrityError, KeyUnavailableError, NotFoundError } from '@/core/errors';
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

  it('is one tail read of the target, the one that checks it is what the row says the segment is', async () => {
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

  it('is one tail read of the target, with the key too', async () => {
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
