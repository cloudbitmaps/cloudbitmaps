import { loadSegment } from '@/core/load';
import { openGenerationReader, publishGeneration } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import type { AuditEvent } from '@/core/audit';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * The driver sends a publish's registry write once. When it ends without a definite answer (a throttle, a lost
 * response, a timeout: a `TransientError`), the publish reads the row again and decides from what it finds:
 *
 * - the pointer names this generation, on the incarnation the write was made against, over the object this load wrote:
 *   the write landed, and the load is published;
 * - the row is the one the write was made against: the write did not land, or may still be on its way. The publish
 *   waits on the injected clock and sends a fresh compare-and-swap from the row it just read, at most three times; the
 *   registry's fence lets at most one of the copies land. Still unanswered, the load throws the registry's own
 *   `TransientError` and deletes nothing;
 * - anything else: the row has moved past the state the write was conditioned on, so the write can never land, and the
 *   publish goes on as after a lost race.
 *
 * Each test counts the writes at the registry port.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type Write = 'create' | 'compareAndSwap';

/** What a registry write does, instead of simply landing. */
type Fault =
  /** Apply the write, then fail as if its response were lost; `after` runs in between. */
  | { kind: 'land-then-transient'; after?: () => void }
  /** Apply the write, then report a conflict, as an Azure replay meeting its own row does. */
  | { kind: 'land-then-conflict' }
  /** Report a conflict without applying anything: another writer won; `meanwhile` is what it did first. */
  | { kind: 'conflict-unapplied'; meanwhile?: () => Promise<void> }
  /** Fail before applying it, keeping the call to land later; `meanwhile` runs before the failure is reported. */
  | { kind: 'transient-unapplied'; meanwhile?: () => Promise<void> };

function world(now: () => number = () => 1_000) {
  const storage = new MemoryStorageDriver();
  const base = new MemoryRegistryDriver({ now });
  const writes: Record<string, number> = {};
  const deletes: Record<string, number> = {};
  const faults: Fault[] = [];
  const held: Array<() => Promise<unknown>> = [];
  const waits: number[] = [];
  let reads = 0;
  let failNextRead: Error | undefined;
  let failNextTail: Error | undefined;
  const registry = new Proxy(base, {
    get(t, p, rx) {
      const value = Reflect.get(t, p, rx) as unknown;
      if (p === 'get') {
        return async (ref: SegmentRef) => {
          reads += 1;
          if (failNextRead !== undefined) {
            const e = failNextRead;
            failNextRead = undefined;
            throw e;
          }
          return base.get(ref);
        };
      }
      if (p !== 'create' && p !== 'compareAndSwap') return value;
      return async (...args: unknown[]) => {
        writes[p] = (writes[p] ?? 0) + 1;
        const send = (): Promise<unknown> =>
          (base[p as Write] as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        const f = faults.shift();
        if (f === undefined) return send();
        if (f.kind === 'land-then-transient') {
          await send();
          f.after?.();
          throw new TransientError('503 SlowDown, after the write was applied');
        }
        if (f.kind === 'land-then-conflict') {
          await send();
          throw new WriteConflictError('the replay met its own row');
        }
        if (f.kind === 'conflict-unapplied') {
          await f.meanwhile?.();
          throw new WriteConflictError('another writer won');
        }
        held.push(send);
        await f.meanwhile?.();
        throw new TransientError('503 SlowDown; the request may still land');
      };
    },
  }) as IRegistryDriver;
  const countedStorage = counting<IStorageDriver>(storage, deletes);
  // A footer read the test makes fail once: what a publish asks of its own object after an unanswered write.
  const faultyStorage = new Proxy(countedStorage, {
    get(t, p, rx) {
      const value = Reflect.get(t, p, rx) as unknown;
      if (p !== 'getTail') return value;
      return async (...args: unknown[]) => {
        if (failNextTail !== undefined) {
          const e = failNextTail;
          failNextTail = undefined;
          throw e;
        }
        return (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
      };
    },
  });
  // A virtual clock: it waits for nothing and records each wait it is asked for.
  const clock = {
    now: () => 0,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
  const bare = { storage: faultyStorage, registry, codec: roaringCodec };
  return {
    storage,
    base,
    registry,
    writes,
    waits,
    clock,
    reads: () => reads,
    deletes: () => deletes.delete ?? 0,
    /** What a store wires: the drivers, the codec and a clock to wait on. */
    deps: { ...bare, clock },
    /** The same with no clock, so there is nothing to wait on between writes. */
    bare,
    /** The same with the store's random source, which spreads each wait. */
    withRng: (next: () => number) => ({ ...bare, clock, readRetry: { clock, rng: { next } } }),
    plain: { storage, registry: base, codec: roaringCodec },
    /** Make the next `times` registry writes do `f`. */
    arm: (f: Fault, times = 1) => {
      for (let i = 0; i < times; i++) faults.push(f);
    },
    failNextRead: (e: Error) => (failNextRead = e),
    failNextTail: (e: Error) => (failNextTail = e),
    /** Let the first write a fault held reach the registry after all. */
    land: async () => held[0]!(),
    /** Let every write a fault held reach the registry, and say how each ended. */
    landAll: async () => Promise.allSettled(held.map((send) => send())),
  };
}

async function idsOf(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push((chunkKey << 16) + r);
    }
  }
  return out.sort((a, b) => a - b);
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A segment at generation 2, its generations 0 and 1 kept. */
async function threeLoads(w: ReturnType<typeof world>): Promise<void> {
  for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, w.plain, { keep: 9 });
}

const writesTotal = (w: ReturnType<typeof world>): number =>
  (w.writes.create ?? 0) + (w.writes.compareAndSwap ?? 0);

describe('a publish whose registry write ends without a definite answer reads the row and decides', () => {
  it('a compare-and-swap that landed and lost its response is published, written once', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 1 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(r.reason).toBeUndefined();
    expect([...r.collected].sort()).toEqual([0, 1]); // the collection pass ran, as after any publish
    expect(w.writes.compareAndSwap).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it("a segment's first create that landed and lost its response is published, written once", async () => {
    const w = world();
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [7, 8], w.deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(w.writes.create).toBe(1);
    expect(writesTotal(w)).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(0);
  });

  it('a compare-and-swap that landed and reported a conflict is published, not superseded', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-conflict' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(1);
  });

  it('a compare-and-swap throttled once and not applied is sent again from the row just read, and the load publishes', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const before = w.reads();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(2); // the one throttled, then one fresh write
    expect(w.waits).toEqual([500]); // the first wait's bound, on the injected clock
    expect(w.deletes()).toBe(0);
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
    // The fresh write acts on the row the failure path read, so that path costs one extra read, not two.
    const withFault = w.reads() - before;
    const control = world();
    await threeLoads(control);
    const controlBefore = control.reads();
    await loadSegment(SEG, [1, 2, 3, 4], control.deps, { keep: 9 });
    expect(withFault - (control.reads() - controlBefore)).toBe(1);
  });

  it('the wait is spread by the store random source: a fraction of the bound', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' }, 2);
    const r = await loadSegment(
      SEG,
      [1, 2, 3, 4],
      w.withRng(() => 0.25),
      { keep: 9 },
    );
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.waits).toEqual([125, 250]); // a quarter of 500 ms, then of 1 s
  });

  it("a segment's first create throttled once and not applied is sent again, and the load publishes", async () => {
    const w = world();
    w.arm({ kind: 'transient-unapplied' });
    const r = await loadSegment(SEG, [5], w.deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(w.writes.create).toBe(2);
    expect(w.waits).toEqual([500]);
    expect(await idsOf(w.storage, 0)).toEqual([5]);
  });

  it('a throttled write whose next attempt lands and loses its response is settled the same way: published', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(2);
  });

  it('a throttled write whose next attempt lands and reports a conflict is published, not superseded', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    w.arm({ kind: 'land-then-conflict' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(2);
  });

  it('an original write delayed past the fresh one is refused by the registry: at most one lands', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    const landed = await w.registry.get(SEG);
    // The request the service answered 503 reaches the registry after the fresh write landed: its version is stale.
    await expect(w.land()).rejects.toBeInstanceOf(WriteConflictError);
    expect(await w.base.get(SEG)).toEqual(landed);
    expect(w.writes.compareAndSwap).toBe(2);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it('throttling that never clears is three fresh writes, then the registry TransientError, and nothing deleted', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' }, 10); // more than the bound allows
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    // The registry's own error reaches the caller as it is, so its `cause` is where a caller reads the SDK's error.
    expect((err as Error).message).toBe('503 SlowDown; the request may still land');
    expect(w.writes.compareAndSwap).toBe(4); // bounded: the first send and three fresh ones
    expect(w.waits).toEqual([500, 1000, 2000]);
    expect(w.deletes()).toBe(0);
    expect(await generations(w.storage)).toEqual([0, 1, 2, 3]);
    expect((await w.base.get(SEG))!.currentGen).toBe(2);
  });

  it('with no clock to wait on, a write that did not land throws at once and is not sent again', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.bare, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(w.writes.compareAndSwap).toBe(1);
    expect(w.deletes()).toBe(0);
  });

  it('attempts that run out on unanswered writes throw the registry TransientError, not a contention error', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'conflict-unapplied' }, 2); // two lost races use two of the five attempts
    w.arm({ kind: 'transient-unapplied' }, 3);
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(w.writes.compareAndSwap).toBe(5);
    expect(w.deletes()).toBe(0);
  });

  it('the write that lands after the load threw finds its object there, and the pointer is valid', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' }, 10);
    await expect(loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 })).rejects.toBeInstanceOf(
      TransientError,
    );
    // Every request the load gave up on reaches the registry after all, each with the version it was made against.
    const settled = await w.landAll();
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1); // the fence: at most one lands
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
    expect(w.deletes()).toBe(0);
  });

  it('a create that is never answered and never lands is sent as fresh creates, then throws and keeps its object', async () => {
    const w = world();
    w.arm({ kind: 'transient-unapplied' }, 10);
    await expect(loadSegment(SEG, [5], w.deps)).rejects.toBeInstanceOf(TransientError);
    expect(w.writes.create).toBe(4);
    expect(w.deletes()).toBe(0);
    await w.land();
    expect((await w.base.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.storage, 0)).toEqual([5]);
  });

  it('an erasure rewrite whose compare-and-swap was throttled and not applied is sent again from the row just read', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: true, fromGeneration: 2, generation: 3 });
    expect(w.writes.compareAndSwap).toBe(2);
    expect(await idsOf(w.storage, 3)).toEqual([1, 3]);
  });

  it('a bulk load whose create was throttled and not applied is sent again from the clock it was given', async () => {
    const w = world();
    w.arm({ kind: 'transient-unapplied' });
    const r = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [5], {
      registry: w.registry,
      clock: w.clock,
    });
    expect(r.becameCurrent).toBe(true);
    expect(w.writes.create).toBe(2);
    expect(w.waits).toEqual([500]);
  });

  it('a re-read that finds a row the library did not write raises that, and nothing is deleted', async () => {
    const w = world();
    await threeLoads(w);
    const corrupt = new IntegrityError('the registry row is not one this library wrote');
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        w.failNextRead(corrupt);
      },
    });
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBe(corrupt);
    expect(w.writes.compareAndSwap).toBe(1);
    expect(w.deletes()).toBe(0);
    expect(await generations(w.storage)).toContain(3);
  });

  it('a re-read that fails too leaves the outcome unknown: TransientError, and nothing deleted', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        w.failNextRead(new TransientError('the re-read is throttled too'));
      },
    });
    await expect(loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(w.writes.compareAndSwap).toBe(1);
    expect(w.deletes()).toBe(0);
    expect(await generations(w.storage)).toContain(3);
  });

  it('a proof of its own object that fails transiently throws that TransientError, deletes nothing, and the write stays landed', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'land-then-transient',
      after: () => w.failNextTail(new TransientError('the footer read is throttled')),
    });
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe('the footer read is throttled');
    expect(w.writes.compareAndSwap).toBe(1);
    expect(w.deletes()).toBe(0);
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it('a proof of its own object that fails any other way is a TransientError with that cause, never the raw error', async () => {
    const w = world();
    await threeLoads(w);
    const raw = new IntegrityError('the footer is unreadable');
    w.arm({ kind: 'land-then-transient', after: () => w.failNextTail(raw) });
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(IntegrityError);
    expect((err as Error).cause).toBe(raw);
    expect(w.deletes()).toBe(0);
    expect(await generations(w.storage)).toContain(3);
  });

  it('a compare-and-swap that did not land while another writer published is reported superseded', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // Another writer publishes generation 4 directly: the row moves past the version this write was made against.
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 4 }, [9], {
          registry: w.base,
        });
      },
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect(w.writes.compareAndSwap).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(4);
    // The write can never land now, and the row changed, so the object stays for collection, as after a lost race.
    expect(await generations(w.storage)).toContain(3);
  });

  it('a refusal after a write that went unanswered says so in the audit event; after answered writes it does not', async () => {
    const answered = world();
    await threeLoads(answered);
    answered.arm({
      kind: 'conflict-unapplied',
      // Another writer changes the row (a retention policy), and this load's write then loses to it: an answer.
      meanwhile: async () => {
        const row = (await answered.base.get(SEG))!;
        await answered.base.compareAndSwap(SEG, row.token, { retention: { note: 'x' } });
      },
    });
    const seenA: AuditEvent[] = [];
    const a = await loadSegment(SEG, [1, 2, 3, 4], answered.deps, {
      keep: 9,
      audit: { onEvent: (e) => seenA.push(e) },
    });
    expect(a).toMatchObject({ published: false, reason: 'superseded' });
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({ kind: 'segment.load-refused', reason: 'superseded' });
    expect(seenA[0]).not.toHaveProperty('unanswered');

    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      // The write gets no answer, and by the time the row is read back another writer has moved the pointer on.
      meanwhile: async () => {
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 4 }, [9], {
          registry: w.base,
        });
      },
    });
    const seen: AuditEvent[] = [];
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, {
      keep: 9,
      audit: { onEvent: (e) => seen.push(e) },
    });
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'segment.load-refused',
        reason: 'superseded',
        unanswered: true,
      }),
    ]);
  });

  it('an unguarded first load whose create did not land advances over a row another writer created, with a new write', async () => {
    const w = world();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        await w.base.create(SEG, { currentGen: null });
      },
    });
    const r = await loadSegment(SEG, [5], w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 0, published: true });
    // The create was sent once; the advance is a compare-and-swap against the row the other writer made.
    expect(w.writes.create).toBe(1);
    expect(w.writes.compareAndSwap).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(0);
  });

  it('a pointer at this number over another object is not this publish: superseded, and that object kept', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // This load's object is replaced under its number, and another writer points the row at it.
        await w.storage.delete({ ...SEG, generation: 3 });
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [42, 43], {
          registry: w.base,
        });
      },
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([42, 43]);
  });

  it('an unguarded first load finding a pointer at its number over another object is superseded, and that object kept', async () => {
    const w = world();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // No fence names this load's number: it read no row, and it asked for no guard. Its object is replaced under
        // that number, and another writer creates the row, pointing at its own.
        await w.storage.delete({ ...SEG, generation: 0 });
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [42, 43], {
          registry: w.base,
        });
      },
    });
    const r = await loadSegment(SEG, [5], w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    expect(w.writes.create).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.storage, 0)).toEqual([42, 43]);
  });

  it('a pointer at this number on another incarnation is not this publish', async () => {
    let clock = 1_000;
    const w = world(() => clock);
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // The row is deleted and created again, later, naming this load's number: a different incarnation.
        clock += 5_000;
        await w.base.delete(SEG);
        await w.base.create(SEG, { currentGen: 3 });
      },
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect(w.writes.compareAndSwap).toBe(1);
  });

  it('an erasure whose write did not land, with another incarnation pointing at its number over its own object, is not an erasure', async () => {
    // The registry clock never advances, so the two incarnations share a `createdAt` and only the object tells them apart.
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        await w.storage.delete({ ...SEG, generation: 3 });
        await w.base.delete(SEG);
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [2, 99], {
          registry: w.base,
        });
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
    expect(await idsOf(w.storage, 3)).toEqual([2, 99]);
    expect(await generations(w.storage)).toEqual([0, 1, 2, 3]);
  });

  it('an erasure whose write did not land, on another incarnation that points at the rewrite object, is not an erasure', async () => {
    let clock = 1_000;
    const w = world(() => clock);
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // The name is deleted and created again, later, pointing at the number the rewrite took: its object is the
        // rewrite's own, so the footer cannot tell, and the incarnation has to.
        clock += 5_000;
        await w.base.delete(SEG);
        await w.base.create(SEG, { currentGen: 3 });
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
  });

  it('a bulk load whose create did not land, over an object replaced under its number, did not become current', async () => {
    const w = world();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        await w.storage.delete({ ...SEG, generation: 0 });
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [42, 43], {
          registry: w.base,
        });
      },
    });
    const r = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [5], {
      registry: w.registry,
    });
    expect(r.becameCurrent).toBe(false);
    expect(await idsOf(w.storage, 0)).toEqual([42, 43]);
  });

  it('a bulk load whose create landed and lost its response became current', async () => {
    const w = world();
    w.arm({ kind: 'land-then-transient' });
    const r = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [5], {
      registry: w.registry,
    });
    expect(r.becameCurrent).toBe(true);
    expect(w.writes.create).toBe(1);
  });

  it('a publish given no way to prove its object cannot settle an unanswered write that names its number', async () => {
    const w = world();
    w.arm({ kind: 'land-then-transient' });
    const err = await publishGeneration(w.registry, { ...SEG, generation: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/gave no way to tell its own object/);
    expect(w.writes.create).toBe(1);
  });

  it('an erasure rewrite whose compare-and-swap landed and lost its response completes, written once', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-transient' });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: true, fromGeneration: 2, generation: 3 });
    expect(w.writes.compareAndSwap).toBe(1);
    expect(await idsOf(w.storage, 3)).toEqual([1, 3]);
  });
});
