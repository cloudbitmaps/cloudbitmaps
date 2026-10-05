import { randomBytes } from 'node:crypto';
import { loadSegment } from '@/core/load';
import type { LoadOptions } from '@/core/load';
import { KeyUnavailableError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, RegistrySummary, SegmentRef } from '@/core/ports';
import { sealSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * A guarded load reads the size of the current generation from the row's summary instead of opening the object, so it
 * makes no tail read of it, and reads the tail exactly as before when the row has no summary it can use: an old row, a
 * summary that names another generation, or a sealed one that does not open.
 *
 * The tail read was also how a load found out that the object its row names was removed from outside. A load that
 * finds that takes the generations below its pointer by a listing, and not by the name of the one its publish pushed
 * out of the window, so it does not delete the one generation left to roll back to. With the summary there is no tail
 * read, and a zero-byte read of the current object, made only when the load is about to take a name, is what tells.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world(keystore?: InProcessKeystore) {
  const memory = new MemoryStorageDriver();
  const memoryRegistry = new MemoryRegistryDriver();
  const calls: Record<string, number> = {};
  /** The `getTail` calls by how many bytes they ask for, so a zero-byte check and a real tail read are told apart. */
  const tails: number[] = [];
  const base = counting<IStorageDriver>(memory, calls);
  const storage = new Proxy(base, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'getTail') return value;
      return (key: Parameters<IStorageDriver['getTail']>[0], max: number) => {
        tails.push(max);
        return (value as IStorageDriver['getTail'])(key, max);
      };
    },
  });
  const registryCalls: Record<string, number> = {};
  const registry = counting<IRegistryDriver>(memoryRegistry, registryCalls);
  const reset = (): void => {
    tails.length = 0;
    for (const c of [calls, registryCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  return {
    memory,
    registry: memoryRegistry,
    storage,
    calls,
    registryCalls,
    tails,
    reset,
    deps: { storage, registry, codec: roaringCodec, keystore },
  };
}
type World = ReturnType<typeof world>;

const idsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** Load `count` generations, each one id larger than the last. */
async function loadMany(w: World, count: number, options: LoadOptions = {}): Promise<void> {
  for (let i = 0; i < count; i++) {
    const have = (await w.registry.get(SEG))?.currentGen ?? -1;
    const r = await loadSegment(SEG, idsOf(have + 2), w.deps, options);
    expect(r.published).toBe(true);
  }
}

async function present(w: World): Promise<number[]> {
  const out: number[] = [];
  for await (const k of w.memory.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** Replace the row's summary, as a writer that moved the pointer without the library would have left it. */
async function plant(w: World, summary: RegistrySummary | undefined): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { summary });
}

describe('a guarded load whose row carries a summary for its current generation', () => {
  it('makes no tail read of the current generation, and says how big it was from the summary', async () => {
    const w = world();
    await loadMany(w, 3);
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps);
    expect(r).toMatchObject({ generation: 3, published: true, cardinalityBefore: 3 });
    // Only zero-byte checks: the next number is free, and the current object is there.
    expect(w.tails.every((max) => max === 0)).toBe(true);
    expect(w.tails).toHaveLength(2);
  });

  it('takes the size from the summary and not from the object', async () => {
    const w = world();
    await loadMany(w, 2);
    // The object holds 2 ids; the row says 1,000.
    await plant(w, { generation: 1, cardinality: 1_000 });
    const refused = await loadSegment(SEG, idsOf(10), w.deps, { guard: { minRetained: 0.5 } });
    expect(refused).toMatchObject({
      published: false,
      reason: 'min-retained',
      cardinalityBefore: 1_000,
    });
  });

  it('refuses an empty generation over a summary that says the segment is not empty', async () => {
    const w = world();
    await loadMany(w, 2);
    const r = await loadSegment(SEG, [], w.deps);
    expect(r).toMatchObject({ published: false, reason: 'empty', cardinalityBefore: 2 });
  });

  it('lets an empty generation over a summary that says the segment is empty', async () => {
    const w = world();
    await loadSegment(SEG, [], w.deps);
    w.reset();
    const r = await loadSegment(SEG, [], w.deps);
    expect(r).toMatchObject({ published: true, cardinalityBefore: 0 });
    expect(w.tails.every((max) => max === 0)).toBe(true);
  });

  it('is judged by the freshly read row: a summary that has moved on with a publish is not the one used', async () => {
    const w = world();
    await loadMany(w, 2);
    await loadSegment(SEG, idsOf(50), w.deps);
    const r = await loadSegment(SEG, idsOf(40), w.deps, { guard: { minRetained: 0.5 } });
    expect(r).toMatchObject({ published: true, cardinalityBefore: 50 });
    const refused = await loadSegment(SEG, idsOf(10), w.deps, { guard: { minRetained: 0.5 } });
    expect(refused).toMatchObject({ published: false, cardinalityBefore: 40 });
  });
});

describe('a guarded load whose row has no summary it can use reads the tail, as before', () => {
  it('reads the tail of a row with no summary, and takes the size from the index', async () => {
    const w = world();
    await loadMany(w, 2);
    await plant(w, undefined);
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps);
    expect(r).toMatchObject({ published: true, cardinalityBefore: 2 });
    expect(w.tails.filter((max) => max > 0)).toHaveLength(1);
  });

  it('reads the tail of a row whose summary names another generation', async () => {
    const w = world();
    await loadMany(w, 3);
    // A registry of someone else's that moved the pointer and left the old description on the row. A shipped registry
    // refuses to write that, so the row is shown to the load with its summary changed.
    const stale: IRegistryDriver = new Proxy(w.deps.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return value;
        return async (...args: Parameters<IRegistryDriver['get']>) => {
          const row = await (value as IRegistryDriver['get']).apply(t, args);
          return row === null ? null : { ...row, summary: { generation: 1, cardinality: 1_000 } };
        };
      },
    });
    w.reset();
    const r = await loadSegment(
      SEG,
      idsOf(10),
      { ...w.deps, registry: stale },
      { guard: { minRetained: 0.5 } },
    );
    expect(r).toMatchObject({ published: true, cardinalityBefore: 3 });
    expect(w.tails.filter((max) => max > 0)).toHaveLength(1);
  });

  it('does not read the tail at all when no bound needs the size, summary or not', async () => {
    const w = world();
    await loadMany(w, 2);
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ published: true, cardinalityBefore: null });
    expect(w.tails.filter((max) => max > 0)).toHaveLength(0);
  });
});

describe('an encrypted segment', () => {
  const key = (): InProcessKeystore =>
    new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

  it('is judged by its sealed summary, with no tail read', async () => {
    const keystore = key();
    const w = world(keystore);
    await loadMany(w, 2);
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps);
    expect(r).toMatchObject({ published: true, cardinalityBefore: 2 });
    expect(w.tails.every((max) => max === 0)).toBe(true);
  });

  it('takes the size from the sealed summary and not from the object', async () => {
    const keystore = key();
    const w = world(keystore);
    await loadMany(w, 2);
    const row = (await w.registry.get(SEG))!;
    const aead = await keystore.openDek(row.wrappedDeks!);
    await plant(w, sealSummary(aead, SEG, 1, 1_000));
    const refused = await loadSegment(SEG, idsOf(10), w.deps, { guard: { minRetained: 0.5 } });
    expect(refused).toMatchObject({
      published: false,
      reason: 'min-retained',
      cardinalityBefore: 1_000,
    });
  });

  it('reads the tail when the sealed summary does not open, and publishes a good one', async () => {
    const keystore = key();
    const w = world(keystore);
    await loadMany(w, 3);
    const row = (await w.registry.get(SEG))!;
    const aead = await keystore.openDek(row.wrappedDeks!);
    // Sealed for generation 1, moved onto the row that names generation 2.
    await plant(w, { generation: 2, sealed: sealSummary(aead, SEG, 1, 1_000).sealed });
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps, { guard: { minRetained: 0.5 } });
    expect(r).toMatchObject({ published: true, cardinalityBefore: 3 });
    expect(w.tails.filter((max) => max > 0)).toHaveLength(1);
    expect((await w.registry.get(SEG))!.summary).toHaveProperty('generation', 3);
  });

  it('refuses without a keystore, as it does when it reads the tail', async () => {
    const keystore = key();
    const w = world(keystore);
    await loadMany(w, 2);
    await expect(
      loadSegment(SEG, idsOf(10), { ...w.deps, keystore: undefined }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});

describe('a load over a current object that was removed from outside', () => {
  it('does not delete the only generation left before the tear, though the row carries a summary', async () => {
    const w = world();
    await loadMany(w, 3);
    expect(await present(w)).toEqual([1, 2]);
    // The row names 2, with a summary of it, and its object is gone: a lifecycle rule, a partial restore.
    await w.memory.delete({ ...SEG, generation: 2 });
    const r = await loadSegment(SEG, idsOf(10), w.deps);
    expect(r).toMatchObject({ generation: 3, published: true });
    // Generation 1 is what a rollback can still go to. A name-only pass would have taken it.
    expect(await present(w)).toEqual([1, 3]);
  });

  it('still collects by name, with no listing, when the current object is there', async () => {
    const w = world();
    await loadMany(w, 3);
    w.reset();
    const r = await loadSegment(SEG, idsOf(10), w.deps);
    expect(r).toMatchObject({ generation: 3, collected: [1] });
    expect(w.calls.list).toBeUndefined();
    expect(await present(w)).toEqual([2, 3]);
  });

  it('is told by one zero-byte read of the current object, made after the publish', async () => {
    const w = world();
    await loadMany(w, 3);
    w.reset();
    await loadSegment(SEG, idsOf(10), w.deps);
    // The check that the next number is free, then the check that the current object is there.
    expect(w.tails).toEqual([0, 0]);
    expect(w.calls.getTail).toBe(2);
  });

  it('makes that read only when it is about to delete by name a generation the window keeps', async () => {
    // keep 0 deletes the one it supersedes by name, which is the object that may be gone: nothing to protect.
    const zero = world();
    await loadMany(zero, 3, { keep: 0 });
    zero.reset();
    await loadSegment(SEG, idsOf(10), zero.deps, { keep: 0 });
    expect(zero.tails).toEqual([0]);
    // keep 2 collects by name a generation the window keeps, so it looks for the current object first, as keep 1 does.
    const wide = world();
    await loadMany(wide, 4, { keep: 2 });
    wide.reset();
    await loadSegment(SEG, idsOf(10), wide.deps, { keep: 2 });
    expect(wide.tails).toEqual([0, 0]);
    expect(wide.calls.list).toBeUndefined();
    // An unguarded load made no such read before the summary existed, and makes none now.
    const bare = world();
    await loadMany(bare, 3);
    bare.reset();
    await loadSegment(SEG, idsOf(10), bare.deps, { allowEmpty: true });
    expect(bare.tails).toEqual([0]);
  });

  it('makes no such read for a load the guard refuses, or that loses its race', async () => {
    const w = world();
    await loadMany(w, 3);
    w.reset();
    const refused = await loadSegment(SEG, [], w.deps);
    expect(refused).toMatchObject({ published: false, reason: 'empty' });
    // Only the check of the next number, before the object was written.
    expect(w.tails).toEqual([0]);
  });

  it('lists when the read finds the current object gone', async () => {
    const w = world();
    await loadMany(w, 3);
    await w.memory.delete({ ...SEG, generation: 2 });
    w.reset();
    await loadSegment(SEG, idsOf(10), w.deps);
    expect(w.calls.list).toBe(1);
  });

  it('lists when the zero-byte read fails for any reason, rather than assume the object is there', async () => {
    const w = world();
    await loadMany(w, 3);
    w.reset();
    let seen = 0;
    const failing = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'getTail') return value;
        return (key: Parameters<IStorageDriver['getTail']>[0], max: number) => {
          // The check that the next number is free answers as before; the check of the current object throws.
          if (++seen === 2) return Promise.reject(new Error('the check failed'));
          return (value as IStorageDriver['getTail'])(key, max);
        };
      },
    });
    const r = await loadSegment(SEG, idsOf(10), { ...w.deps, storage: failing });
    expect(r.published).toBe(true);
    expect(w.calls.list).toBe(1);
    expect(await present(w)).toEqual([2, 3]);
  });
});

describe('what the summary changes for a row whose object is gone', () => {
  it('a smaller repair is judged against the size the row remembers', async () => {
    const w = world();
    await loadMany(w, 3);
    await w.memory.delete({ ...SEG, generation: 2 });
    // A repair that retains less than half of what the row says is refused where it landed when the guard read the tail
    // (the object was not found, so there was nothing to compare against).
    const r = await loadSegment(SEG, idsOf(1), w.deps, { guard: { minRetained: 0.5 } });
    expect(r).toMatchObject({ published: false, reason: 'min-retained', cardinalityBefore: 3 });
    // Without the bound, or with the empty refusal off, it lands.
    const ok = await loadSegment(SEG, idsOf(1), w.deps, { allowEmpty: true });
    expect(ok.published).toBe(true);
  });
});
