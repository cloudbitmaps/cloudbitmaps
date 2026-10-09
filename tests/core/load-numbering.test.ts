import fc from 'fast-check';
import { loadSegment } from '@/core/load';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { TransientError } from '@/core/errors';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * How a load numbers its generation. It takes `currentGen + 1` from the row it already read when one existence
 * check (a zero-byte tail read) finds that number free, and falls back to the listing — one above the pointer and
 * above every object present — whenever the check finds it taken or cannot answer. These pin when a load lists,
 * and that a number is never one an object holds.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

/** One storage call, as the load made it. */
type Call =
  | { op: 'check'; generation: number }
  | { op: 'tail'; generation: number }
  | { op: 'list' }
  | { op: 'put'; generation: number };

/** `inner`, with each check, tail read, listing and write recorded in order. */
function recording(inner: IStorageDriver): { storage: IStorageDriver; calls: Call[] } {
  const calls: Call[] = [];
  const storage = new Proxy(inner, {
    get(t, p, rx) {
      const value = Reflect.get(t, p, rx) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const key = args[0] as GenKey;
        if (p === 'getTail') {
          calls.push({
            op: args[1] === 0 ? 'check' : 'tail',
            generation: key.generation,
          });
        } else if (p === 'list') calls.push({ op: 'list' });
        else if (p === 'putImmutable') calls.push({ op: 'put', generation: key.generation });
        return fn.apply(inner, args);
      };
    },
  }) as IStorageDriver;
  return { storage, calls };
}

function world(registry: IRegistryDriver = new MemoryRegistryDriver()) {
  const memory = new MemoryStorageDriver();
  const { storage, calls } = recording(memory);
  const deps = { storage, registry, codec: roaringCodec };
  const reset = () => calls.splice(0, calls.length);
  return { memory, storage, registry, calls, deps, reset };
}

/** The calls a load made before it wrote its object: how it chose the number. */
const beforeWrite = (calls: Call[]): Call[] =>
  calls.slice(
    0,
    calls.findIndex((c) => c.op === 'put'),
  );

/** An object written and never published: a load that crashed before its publish. */
async function orphan(storage: IStorageDriver, generation: number): Promise<void> {
  await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [7]);
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('a load numbers its generation from the row it read, with one existence check', () => {
  it('takes currentGen + 1 when the check finds it free, and lists nothing before its write', async () => {
    const w = world();
    for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, w.deps);
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 3, published: true });
    // The check of the next number, and nothing else: the guard took the size of the current generation from the row's
    // summary, so it did not read its tail. No listing.
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 3 }]);
  });

  it("checks 0 on a segment's first load", async () => {
    const w = world();
    const r = await loadSegment(SEG, [1], w.deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 0 }]);
  });

  it('checks 0 on a row that has no pointer yet (a retention policy set before the first load)', async () => {
    const w = world();
    await setSegmentRetention(
      SEG,
      { registry: w.registry },
      { expiresAt: Date.now() + 86_400_000 },
    );
    expect((await w.registry.get(SEG))?.currentGen).toBeNull();
    const r = await loadSegment(SEG, [1], w.deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 0 }]);
  });

  it("a crashed load's object at currentGen + 1 is met by the check, and the listing numbers past it", async () => {
    const w = world();
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, w.deps);
    await orphan(w.memory, 2); // a load wrote 2 and crashed before publishing it
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3], w.deps);
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 2 }, { op: 'list' }]);
  });

  it('numbers under an object further up when currentGen + 1 is free, and past it once the check meets it', async () => {
    const w = world();
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, w.deps, { keep: 9 });
    await orphan(w.memory, 3); // a gap: 2 is free, 3 is held
    const under = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 9 });
    expect(under).toMatchObject({ generation: 2, published: true });
    expect((await w.registry.get(SEG))?.currentGen).toBe(2);
    // The orphan is above the pointer, unpublished and unread; the next load's check meets it.
    w.reset();
    const past = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(past).toMatchObject({ generation: 4, published: true });
    expect(beforeWrite(w.calls).map((c) => c.op)).toEqual(['check', 'list']);
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3, 4]);
  });

  it('after a rollback the check meets a generation above the pointer, and the listing numbers past them all', async () => {
    const w = world();
    for (const ids of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      await loadSegment(SEG, ids, w.deps, { keep: 9 });
    }
    await rollbackSegment(SEG, 1, { storage: w.memory, registry: w.registry });
    expect((await w.registry.get(SEG))?.currentGen).toBe(1); // 2 and 3 are above it now
    w.reset();
    const r = await loadSegment(SEG, [9], w.deps, { keep: 9 });
    // 2 is taken: never reuse a number an object holds. The listing goes above 3.
    expect(r).toMatchObject({ generation: 4, published: true });
    // The rollback wrote the target's summary into the row, so the guard sizes generation 1 from it and reads no tail.
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 2 }, { op: 'list' }]);
  });

  it('restarts at 0 after a purge and re-create, with one check', async () => {
    const w = world();
    for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, w.deps);
    // Retire the name: the bucket emptied, then the row purged.
    for (const g of await generations(w.memory)) await w.memory.delete({ ...SEG, generation: g });
    await w.registry.delete(SEG);
    w.reset();
    const r = await loadSegment(SEG, [5], w.deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(beforeWrite(w.calls)).toEqual([{ op: 'check', generation: 0 }]);
  });

  it('a check that fails other than "not found" proves nothing, and the listing numbers', async () => {
    const w = world();
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, w.deps);
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) =>
          maxBytes === 0
            ? Promise.reject(new TransientError('503 SlowDown'))
            : w.storage.getTail(key, maxBytes);
      },
    }) as IStorageDriver;
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, storage: flaky });
    expect(r).toMatchObject({ generation: 2, published: true });
    expect(beforeWrite(w.calls).map((c) => c.op)).toEqual(['list']);
  });
  it('numbers above the pointer when the listing finds nothing as high: a pointer whose objects are gone', async () => {
    const w = world();
    for (let g = 0; g <= 5; g++) await loadSegment(SEG, [g], w.deps, { keep: 9 });
    // A lifecycle rule took the two newest objects: the pointer names 5, and the bucket holds 0 to 3.
    for (const g of [4, 5]) await w.memory.delete({ ...SEG, generation: g });
    // The check cannot answer, so the listing numbers: above the pointer, not above the highest object.
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) =>
          maxBytes === 0
            ? Promise.reject(new TransientError('503 SlowDown'))
            : w.storage.getTail(key, maxBytes);
      },
    }) as IStorageDriver;
    const r = await loadSegment(SEG, [9], { ...w.deps, storage: flaky }, { keep: 9 });
    expect(r).toMatchObject({ generation: 6, published: true });
  });
});

describe('re-running the load after a registry restore, as the recovery guide says', () => {
  /**
   * Six loads at the default `keep: 1` leave generations 4 and 5; the registry is restored to pointer 1, and
   * generation 1's object with it. Then the load is re-run, with `keep`, until the pointer is above the strays.
   */
  async function restoreAndRerun(keep: number): Promise<{ taken: number[]; left: number[] }> {
    const w = world();
    for (let g = 0; g <= 5; g++) await loadSegment(SEG, [g], w.deps);
    expect(await generations(w.memory)).toEqual([4, 5]);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { currentGen: 1 });
    await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 1 }, [1]);
    const taken: number[] = [];
    while ((await w.registry.get(SEG))!.currentGen! <= 5) {
      const r = await loadSegment(SEG, [100 + taken.length], w.deps, { keep });
      expect(r.published).toBe(true);
      taken.push(r.generation);
    }
    return { taken, left: await generations(w.memory) };
  }

  it('numbers below the strays first, then past them all', async () => {
    expect((await restoreAndRerun(5)).taken).toEqual([2, 3, 6]);
  });

  it('keeps the restored generation with a keep of the highest stray minus the restored pointer, plus one', async () => {
    expect((await restoreAndRerun(5 - 1 + 1)).left).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('collects it with a keep of the number of strays plus one', async () => {
    const { left } = await restoreAndRerun(2 + 1);
    expect(left).not.toContain(1);
    expect(left).toEqual([3, 4, 5, 6]);
  });
});

describe('two loads that check the same number', () => {
  it('both find it free; write-once lets one put land and the other reports superseded, having written nothing', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    // Hold both loads' ids until each has checked generation 1, so both write it.
    let checked = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => (release = resolve));
    const counting = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return async (key: GenKey, maxBytes: number) => {
          try {
            return await w.storage.getTail(key, maxBytes);
          } finally {
            if (maxBytes === 0 && ++checked === 2) release();
          }
        };
      },
    }) as IStorageDriver;
    async function* held(ids: number[]): AsyncIterable<number> {
      await bothChecked;
      yield* ids;
    }
    const deps = { ...w.deps, storage: counting };
    const [a, b] = await Promise.all([
      loadSegment(SEG, held([1, 2]), deps),
      loadSegment(SEG, held([1, 2, 3]), deps),
    ]);
    expect([a.generation, b.generation]).toEqual([1, 1]);
    const [won, lost] = a.published ? [a, b] : [b, a];
    expect(won.published).toBe(true);
    expect(lost).toMatchObject({ published: false, reason: 'superseded', size: 0 });
    expect((await w.registry.get(SEG))?.currentGen).toBe(1);
  });

  it('a load that checks after the other wrote numbers past it by the listing; the later publish is refused', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    let second: Awaited<ReturnType<typeof loadSegment>> | undefined;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'putImmutable') return value;
        return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
          const out = await w.storage.putImmutable(...args);
          // The first load's object has landed and it has not published yet: a second load runs whole.
          second ??= await loadSegment(SEG, [1, 2, 3], w.deps);
          return out;
        };
      },
    }) as IStorageDriver;
    const first = await loadSegment(SEG, [1, 2], { ...w.deps, storage: racing });
    expect(second).toMatchObject({ generation: 2, published: true });
    expect(first).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))?.currentGen).toBe(2);
  });
});

/**
 * A model of one segment's bucket and row, driven through random sequences of loads, crashed loads, refused
 * loads, rollbacks and retirements. Whatever the sequence: a load never writes a number an object holds (the put
 * never meets write-once), it takes `currentGen + 1` exactly when no object holds that number and otherwise one
 * above the pointer and everything present, and what it publishes is what it wrote.
 */
describe('numbering over gaps above the pointer (property)', () => {
  type Op =
    | { kind: 'load'; ids: number[] }
    | { kind: 'crash'; above: number }
    | { kind: 'refused' }
    | { kind: 'rollback'; back: number }
    | { kind: 'retire' };
  const op: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant('load' as const),
        ids: fc.array(fc.nat(9), { minLength: 1, maxLength: 4 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('crash' as const),
        above: fc.integer({ min: 1, max: 3 }),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'refused' as const }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('rollback' as const),
        back: fc.integer({ min: 1, max: 3 }),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'retire' as const }) },
  );

  it('never collides, takes currentGen + 1 exactly when it is free, and publishes what it wrote', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 24 }), async (ops) => {
        const w = world();
        let conflicts = 0;
        const watching = new Proxy(w.storage, {
          get(t, p, rx) {
            const value = Reflect.get(t, p, rx) as unknown;
            if (p !== 'putImmutable') return value;
            return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
              try {
                return await w.storage.putImmutable(...args);
              } catch (err) {
                conflicts += 1;
                throw err;
              }
            };
          },
        }) as IStorageDriver;
        const deps = { ...w.deps, storage: watching };
        for (const o of ops) {
          const row = await w.registry.get(SEG);
          const current = row?.currentGen ?? -1;
          const present = await generations(w.memory);
          if (o.kind === 'load' || o.kind === 'refused') {
            const ids = o.kind === 'load' ? o.ids : [];
            const expected = present.includes(current + 1)
              ? Math.max(current, ...present) + 1
              : current + 1;
            // A refused load: an empty result over a non-empty segment, under the default guard.
            const r = await loadSegment(SEG, ids, deps, { keep: 2 });
            expect(r.generation).toBe(expected);
            if (r.published) {
              expect((await w.registry.get(SEG))?.currentGen).toBe(expected);
            } else {
              expect(r.reason).toBe('empty');
              expect(await generations(w.memory)).not.toContain(expected); // it cleaned up after itself
            }
          } else if (o.kind === 'crash') {
            const at = Math.max(current, ...present) + o.above;
            await orphan(w.memory, at);
          } else if (o.kind === 'rollback') {
            const target = present.filter((g) => g < current).at(-o.back);
            if (target !== undefined)
              await rollbackSegment(SEG, target, { storage: w.memory, registry: w.registry });
          } else {
            for (const g of present) await w.memory.delete({ ...SEG, generation: g });
            if (row !== null) await w.registry.delete(SEG);
          }
        }
        expect(conflicts).toBe(0);
      }),
      { numRuns: 150 },
    );
  });
});
