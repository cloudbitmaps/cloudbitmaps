import { randomBytes } from 'node:crypto';
import { loadSegment } from '@/core/load';
import { openGenerationReader, publishGeneration } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import type { AuditEvent } from '@/core/audit';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { setSegmentRetention } from '@/core/retention';
import { usableSummary } from '@/core/summary';
import { incarnationOf } from '@/core/token';
import { InProcessKeystore } from '@/drivers/crypto';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring, MIN_EXPIRES_AT_MS, RecordingAuditSink } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore, counting } from '../helpers/counting';

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

function world(
  now: () => number = () => 1_000,
  makeBase: (now: () => number) => IRegistryDriver = (clock) =>
    new MemoryRegistryDriver({ now: clock }),
) {
  const storage = new MemoryStorageDriver();
  const base = makeBase(now);
  const writes: Record<string, number> = {};
  const deletes: Record<string, number> = {};
  const faults: Fault[] = [];
  const held: Array<() => Promise<unknown>> = [];
  const waits: number[] = [];
  /** The patches that move a pointer, each as the registry port received it, resends included. */
  const sent: Array<{ write: Write; patch: Record<string, unknown> }> = [];
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
        const patch = (p === 'create' ? args[1] : args[2]) as Record<string, unknown>;
        if ('currentGen' in patch) sent.push({ write: p, patch });
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
  // A virtual clock: it waits for nothing and records each wait it is asked for. A test can have something happen
  // during a wait, as a request the service held reaching the registry.
  let duringWait: (() => Promise<void>) | undefined;
  const clock = {
    now: () => 0,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
      await duringWait?.();
    },
    // A load hands the loop back through this, and it is not a wait: only the publish's backoff is recorded.
    yieldNow: async (): Promise<void> => {},
  };
  const bare = { storage: faultyStorage, registry, codec: roaringCodec };
  return {
    storage,
    base,
    registry,
    writes,
    sent,
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
    /** Run `f` during each wait the publish makes on its clock. */
    duringWait: (f: () => Promise<void>) => (duringWait = f),
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
    // The collection ran, as after any publish, by name: `threeLoads` kept every generation, so the row names 0 and 1
    // and a `keep` of 1 takes both.
    expect([...r.collected]).toEqual([0, 1]);
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

  it('an unguarded first load whose create landed and lost its response is published, written once', async () => {
    // Its fence is the absence it found, and the row read back is its own create's: the publish recognises its own
    // write before it asks whether a row appeared.
    const w = world();
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [7, 8], w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(w.writes.create).toBe(1);
    expect(writesTotal(w)).toBe(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.storage, 0)).toEqual([7, 8]);
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

  it('attempts that run out while the last unanswered write lands during its wait are published, by the proof of the object', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'conflict-unapplied' }, 2);
    w.arm({ kind: 'transient-unapplied' }, 3);
    w.duringWait(async () => {
      // The first request the load gave up on reaches the registry while the load waits, and the attempts run out.
      if (w.waits.length === 3) await w.land();
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(5);
    expect(w.deletes()).toBe(0);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it("attempts that run out on an unanswered write, with the pointer at the load's number over another object, are not published", async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'conflict-unapplied' }, 2);
    w.arm({ kind: 'transient-unapplied' }, 3);
    w.duringWait(async () => {
      if (w.waits.length !== 3) return;
      // During the last wait this load's object is replaced under its number, and another writer points the row at it.
      await w.storage.delete({ ...SEG, generation: 3 });
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [42, 43], {
        registry: w.base,
      });
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect(await idsOf(w.storage, 3)).toEqual([42, 43]);
  });

  it("attempts that run out on an unanswered write, with another incarnation at the load's number over the load's own object, are not published", async () => {
    const w = world(() => 1_000);
    await threeLoads(w);
    w.arm({ kind: 'conflict-unapplied' }, 2);
    w.arm({ kind: 'transient-unapplied' }, 3);
    w.duringWait(async () => {
      if (w.waits.length !== 3) return;
      // During the last wait the name is deleted and created again, in the same millisecond, pointing at the number this
      // load took. The object under it is this load's own, which the footer proves, and the creation stamp is the same.
      await w.base.delete(SEG);
      await w.base.create(SEG, { currentGen: 3 });
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect(w.deletes()).toBe(0);
    expect(await generations(w.storage)).toEqual([0, 1, 2, 3]);
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

  it('a token-only change during an unanswered write costs no wait and no fresh write: the row moved', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      // The write gets no answer, and by the time the row is read back another writer has changed it without moving
      // the pointer: a retention policy. The pointer is where it was, but the row is not the one the write was made
      // against, so the write can never land, and waiting to send it again would be a wait for nothing.
      meanwhile: async () => {
        const row = (await w.base.get(SEG))!;
        await w.base.compareAndSwap(SEG, row.token, { retention: { note: 'x' } });
      },
    });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect(w.waits).toEqual([]);
    expect(w.writes.compareAndSwap).toBe(1);
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

  it('an unguarded first load whose create did not land is refused by the row another writer created meanwhile', async () => {
    const w = world();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        await w.base.create(SEG, { currentGen: null });
      },
    });
    const r = await loadSegment(SEG, [5], w.deps, { allowEmpty: true });
    // It found no row and fenced on that absence: the row read back is another writer's, so no fresh write is sent.
    expect(r).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    expect(w.writes.create).toBe(1);
    expect(w.writes.compareAndSwap ?? 0).toBe(0);
    expect((await w.base.get(SEG))!.currentGen).toBeNull();
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
        // It read no row, so its fence is that absence, and nothing in it names this load's number. Its object is
        // replaced under that number, and another writer creates the row, pointing at its own.
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

describe('a publish settled by reading the row names its incarnation in the audit event', () => {
  // The write's own answer carries the new token; a publish settled by a read of the row has none, so the event takes
  // the incarnation from that read. A first load that found no row has no other source for it.
  const publishEvent = async (w: ReturnType<typeof world>) => ({
    kind: 'segment.publish',
    namespace: 'ns',
    segment: 's',
    incarnation: incarnationOf((await w.base.get(SEG))!.token),
  });

  it("a segment's first create that landed and lost its response", async () => {
    const w = world();
    w.arm({ kind: 'land-then-transient' });
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [7, 8], w.deps, { audit });
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(audit.snapshot()).toStrictEqual([{ ...(await publishEvent(w)), generation: 0 }]);
  });

  it('a compare-and-swap that landed and reported a conflict', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-conflict' });
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9, audit });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(audit.snapshot()).toStrictEqual([{ ...(await publishEvent(w)), generation: 3 }]);
  });

  it('attempts that ran out while the last unanswered write landed', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'conflict-unapplied' }, 2);
    w.arm({ kind: 'transient-unapplied' }, 3);
    w.duringWait(async () => {
      if (w.waits.length === 3) await w.land();
    });
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9, audit });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(audit.snapshot()).toStrictEqual([{ ...(await publishEvent(w)), generation: 3 }]);
  });
});

describe("the publish's backoff is spread by the store's random source, whatever `retry` says", () => {
  /** A store over the harness's drivers, a clock that records its waits, and a random source that always answers 0.25. */
  const storeOver = (w: ReturnType<typeof world>, retry: false | undefined) =>
    new CloudRoaring({
      storage: brandAsBackend({ storage: w.storage, registry: w.registry }),
      ...(retry === undefined ? {} : { retry }),
      seams: { clock: w.clock, rng: { next: () => 0.25 } },
    });

  it.each<['retry off' | 'retry on', false | undefined]>([
    ['retry off', false],
    ['retry on', undefined],
  ])(
    'a load that is throttled twice waits a random time under each bound, with %s',
    async (_, retry) => {
      const w = world();
      const store = storeOver(w, retry);
      await store.load(SEG, [1]);
      w.arm({ kind: 'transient-unapplied' }, 2);
      expect(await store.load(SEG, [1, 2])).toMatchObject({ published: true });
      // 0.25 of the 500 ms and 1 s bounds. With the read retry off there is no `readRetry.rng`, and the waits would be the bounds.
      expect(w.waits).toEqual([125, 250]);
    },
  );

  it('an erasure rewrite that is throttled once draws its wait from the same source, with retry off', async () => {
    const w = world();
    const store = storeOver(w, false);
    await store.load(SEG, [1, 2, 3]);
    w.arm({ kind: 'transient-unapplied' });
    expect(await store.eraseSubject(2, { namespace: 'ns' })).toMatchObject({ scannedSegments: 1 });
    expect(w.waits).toEqual([125]);
  });
});

describe('two incarnations created in the same millisecond are told apart by the token', () => {
  it('an erasure on another incarnation that points at the rewrite object, under a clock that never advances, is not an erasure', async () => {
    const w = world(() => 1_000);
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // The name is deleted and created again in the same millisecond, pointing at the number the rewrite took. The
        // object under it is the rewrite's own, so the footer cannot tell, and neither can the creation stamp.
        await w.base.delete(SEG);
        await w.base.create(SEG, { currentGen: 3 });
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
    expect(await generations(w.storage)).toEqual([0, 1, 2, 3]);
  });
});

describe('a row 0.11 wrote has no incarnation id, and its own write is still recognised', () => {
  /** A live row as 0.11 serialized it: schema 1, a bare decimal token. */
  const legacyRow = (currentGen: number, createdAt: number): string =>
    `{"schemaVersion":1,"deleted":false,"record":{"segment":"s","namespace":"ns","currentGen":${currentGen},` +
    `"status":"active","createdAt":${createdAt},"updatedAt":${createdAt},"token":"7"}}`;

  /** A world over the object-store registry, with generations 0 to 2 loaded and the row then replaced by a legacy one. */
  async function legacyWorld(): Promise<ReturnType<typeof world> & { store: CountingObjectStore }> {
    const store = new CountingObjectStore(0);
    const w = world(
      () => 30,
      (clock) => new ObjectStoreRegistry(store, undefined, clock),
    );
    await threeLoads(w);
    store.plant(registryObjectKey(undefined, SEG), legacyRow(2, 30));
    expect((await w.base.get(SEG))!.token).toBe('7');
    return { ...w, store };
  }

  it('a write of its own that landed and lost its response is published: both tokens have no id, so the stamp decides', async () => {
    const w = await legacyWorld();
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    // The row gained a write part and no incarnation.
    expect((await w.base.get(SEG))!.token).toMatch(/^8\.[0-9a-f]{16}$/);
  });

  it('a write throttled once and not applied is sent again from the row just read, and the load publishes', async () => {
    const w = await legacyWorld();
    w.arm({ kind: 'transient-unapplied' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(2);
  });

  it('another row with no id, created at another time and pointing at the rewrite object, is another incarnation: the stamp says so', async () => {
    const w = await legacyWorld();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // Another legacy-form row, stamped later, names the rewrite's number over the rewrite's own object.
        w.store.plant(registryObjectKey(undefined, SEG), legacyRow(3, 99).replace('"7"', '"9"'));
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
  });

  it('a name created again over it in the same millisecond is another incarnation: the token form says so', async () => {
    const w = await legacyWorld();
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        // The legacy row is deleted and the name created again in the same millisecond (its stamp is 30 too),
        // pointing at the rewrite's number over the rewrite's own object. The row is now born with an incarnation id.
        await w.base.delete(SEG);
        await w.base.create(SEG, { currentGen: 3 });
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
  });
});

describe.each<
  [
    string,
    () => Promise<{ make: (now: () => number) => IRegistryDriver; done: () => Promise<void> }>,
  ]
>([
  [
    'the in-memory registry',
    async () => ({
      make: (clock) => new MemoryRegistryDriver({ now: clock }),
      done: async () => {},
    }),
  ],
  [
    'the local-filesystem registry',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'crbm-reconcile-'));
      return {
        make: (clock) => new LocalFsRegistryDriver(dir, { now: clock }),
        done: async () => rm(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    'the object-store registry (S3, GCS and Azure Blob share it)',
    async () => ({
      make: (clock) => new ObjectStoreRegistry(new CountingObjectStore(0), undefined, clock),
      done: async () => {},
    }),
  ],
])('the reconcile and the fresh write, over %s, with the tokens it issues', (_, open) => {
  let made: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    made = await open();
  });
  afterEach(async () => {
    await made.done();
  });
  const fresh = () => world(() => 1_000, made.make);

  it('a write that landed and lost its response is published, written once', async () => {
    const w = fresh();
    await threeLoads(w);
    w.arm({ kind: 'land-then-transient' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(1);
  });

  it('a write throttled once and not applied is sent again from the row just read, and the original is refused by the fence', async () => {
    const w = fresh();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(w.writes.compareAndSwap).toBe(2);
    expect(w.waits).toEqual([500]);
    const landed = await w.base.get(SEG);
    await expect(w.land()).rejects.toBeInstanceOf(WriteConflictError);
    expect(await w.base.get(SEG)).toEqual(landed);
  });

  it('throttling that never clears is four writes, then the registry TransientError, with nothing deleted and at most one landing late', async () => {
    const w = fresh();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' }, 10);
    await expect(loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(w.writes.compareAndSwap).toBe(4);
    expect(w.deletes()).toBe(0);
    const settled = await w.landAll();
    expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await w.base.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it('an erasure on another incarnation created in the same millisecond, over the rewrite object, is not an erasure', async () => {
    const w = fresh();
    await threeLoads(w);
    w.arm({
      kind: 'transient-unapplied',
      meanwhile: async () => {
        await w.base.delete(SEG);
        await w.base.create(SEG, { currentGen: 3 });
      },
    });
    const r = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(r).toMatchObject({ erased: false, reason: 'superseded' });
    expect(r.collected).toEqual([]);
  });
});

describe('a publish that is settled by reading the row carries the generation summary in every write it sends', () => {
  const META = { run: 'r1', n: 2 };

  type Keyed = ReturnType<typeof keyed>;
  function keyed(encrypted: boolean) {
    const keystore = encrypted
      ? new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' })
      : undefined;
    const w = world();
    return { w, keystore, deps: { ...w.deps, keystore } };
  }
  const described = async (k: Keyed): Promise<unknown> => {
    const row = (await k.w.base.get(SEG))!;
    const aead =
      row.wrappedDeks === undefined ? undefined : await k.keystore!.openDek(row.wrappedDeks);
    return usableSummary(SEG, row, aead);
  };
  /** Every write sent since `from` moved the pointer with a summary, and the same one each time. */
  const summariesSince = (k: Keyed, from: number): unknown[] => {
    const writes = k.w.sent.slice(from);
    expect(writes.length).toBeGreaterThan(0);
    for (const { patch } of writes) expect(patch.summary).toBeDefined();
    expect(new Set(writes.map(({ patch }) => JSON.stringify(patch.summary))).size).toBe(1);
    return writes.map(({ patch }) => patch.summary);
  };

  describe.each([
    ['cleartext', false],
    ['encrypted', true],
  ])('on a %s segment', (_name, encrypted) => {
    describe.each([
      ['the write landed and lost its response', { kind: 'land-then-transient' } as Fault, 1],
      [
        'the write was throttled and never applied, and is sent again',
        { kind: 'transient-unapplied' } as Fault,
        2,
      ],
    ])('when %s', (_when, fault, sends) => {
      it("a segment's first load (a create) holds the summary", async () => {
        const k = keyed(encrypted);
        k.w.arm(fault);
        const r = await loadSegment(SEG, [1, 2, 3], k.deps, { metadata: META });
        expect(r).toMatchObject({ generation: 0, published: true });
        expect(k.w.sent.map((x) => x.write)).toEqual(Array(sends).fill('create'));
        summariesSince(k, 0);
        expect(await described(k)).toEqual({ cardinality: 3, metadata: META });
      });

      it('a later load (a compare-and-swap) holds the summary', async () => {
        const k = keyed(encrypted);
        await loadSegment(SEG, [1, 2, 3], k.deps, { keep: 9, metadata: META });
        const from = k.w.sent.length;
        k.w.arm(fault);
        const r = await loadSegment(SEG, [1, 2, 3, 4, 5], k.deps, {
          keep: 9,
          metadata: { run: 'r2' },
        });
        expect(r).toMatchObject({ generation: 1, published: true });
        expect(k.w.sent.slice(from).map((x) => x.write)).toEqual(
          Array(sends).fill('compareAndSwap'),
        );
        summariesSince(k, from);
        expect(await described(k)).toEqual({ cardinality: 5, metadata: { run: 'r2' } });
      });

      it('a load onto a row that has no pointer yet holds the summary', async () => {
        const k = keyed(encrypted);
        await setSegmentRetention(
          SEG,
          { registry: k.w.base },
          { expiresAt: MIN_EXPIRES_AT_MS + 86_400_000 * 900 },
        );
        expect((await k.w.base.get(SEG))!.currentGen).toBeNull();
        const from = k.w.sent.length;
        k.w.arm(fault);
        const r = await loadSegment(SEG, [1, 2, 3], k.deps, { metadata: META });
        expect(r).toMatchObject({ generation: 0, published: true });
        expect(k.w.sent.slice(from).map((x) => x.write)).toEqual(
          Array(sends).fill('compareAndSwap'),
        );
        summariesSince(k, from);
        expect(await described(k)).toEqual({ cardinality: 3, metadata: META });
      });

      it('an erasure rewrite holds the summary of the rewrite', async () => {
        const k = keyed(encrypted);
        await loadSegment(SEG, [1, 2, 3, 4, 5], k.deps, { keep: 9, metadata: META });
        const from = k.w.sent.length;
        k.w.arm(fault);
        const r = await eraseIdFromSegment(SEG, 2, k.deps);
        expect(r).toMatchObject({ erased: true, generation: 1 });
        expect(k.w.sent.slice(from).map((x) => x.write)).toEqual(
          Array(sends).fill('compareAndSwap'),
        );
        summariesSince(k, from);
        expect(await described(k)).toEqual({ cardinality: 4, metadata: META });
      });
    });
  });

  it('a bulk load that publishes by itself, throttled and sent again, holds the summary in each send', async () => {
    const w = world();
    w.arm({ kind: 'transient-unapplied' });
    const r = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [5, 6], {
      registry: w.registry,
      clock: w.clock,
      metadata: META,
    });
    expect(r.becameCurrent).toBe(true);
    expect(w.sent.map((x) => x.write)).toEqual(['create', 'create']);
    for (const { patch } of w.sent) {
      expect(patch.summary).toEqual({ generation: 0, cardinality: 2, metadata: META });
    }
  });
});

/**
 * The window a publish records is derived from the row its write was made against, so a write that ends without an
 * answer and then lands records, and deletes, exactly what the same write would have after a clean answer.
 */
describe('a publish whose write got no answer records the same window as one that did', () => {
  /** `threeLoads` kept 0 and 1; a load with keep 2 now publishes 3, names 1 and 2, and pushes 0 out. */
  const next = (w: ReturnType<typeof world>) => loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 2 });

  it('a write that landed and lost its response', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-transient' });
    const r = await next(w);
    expect(r).toMatchObject({ generation: 3, published: true, collected: [0] });
    expect((await w.base.get(SEG))!.keptGens).toEqual([1, 2]);
    expect(await generations(w.storage)).toEqual([1, 2, 3]);
    expect(w.sent.at(-1)!.patch.keptGens).toEqual([1, 2]);
  });

  it('a write that landed and then reported a conflict', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'land-then-conflict' });
    const r = await next(w);
    expect(r).toMatchObject({ generation: 3, published: true, collected: [0] });
    expect((await w.base.get(SEG))!.keptGens).toEqual([1, 2]);
    expect(await generations(w.storage)).toEqual([1, 2, 3]);
  });

  it('a write throttled and not applied, sent again from the row just read', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({ kind: 'transient-unapplied' });
    const r = await next(w);
    expect(r).toMatchObject({ generation: 3, published: true, collected: [0] });
    expect(w.sent.map((s) => s.patch.keptGens)).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect((await w.base.get(SEG))!.keptGens).toEqual([1, 2]);
    expect(await generations(w.storage)).toEqual([1, 2, 3]);
  });

  it('a write that landed on a row that records no list: the load lists, keeps the newest two, and seeds nothing it cannot fence', async () => {
    const w = world();
    await threeLoads(w);
    const row = (await w.base.get(SEG))!;
    await w.base.compareAndSwap(SEG, row.token, { keptGens: undefined });
    w.arm({ kind: 'land-then-transient' });
    const r = await next(w);
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(await generations(w.storage)).toEqual([1, 2, 3]); // the window, found by listing
    // The write settled by reading the row has no token to fence a seed on, so the row records none yet.
    expect((await w.base.get(SEG))!.keptGens).toBeUndefined();
    const again = await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps, { keep: 2 });
    expect(again).toMatchObject({ generation: 4, published: true });
    expect((await w.base.get(SEG))!.keptGens).toEqual([2, 3]);
    expect(await generations(w.storage)).toEqual([2, 3, 4]);
  });

  it('a write that lost to another load deletes nothing and records nothing of its own', async () => {
    const w = world();
    await threeLoads(w);
    w.arm({
      kind: 'conflict-unapplied',
      meanwhile: async () => {
        await loadSegment(SEG, [1, 2, 3, 4, 5], w.plain, { keep: 9 }); // publishes 3 first, keeping all
      },
    });
    const r = await next(w);
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    // The other load numbered past the object this one had written, and published 4; the row names what it kept. The
    // refused object stays below the pointer, named by no list: a listing takes it.
    expect((await w.base.get(SEG))!.keptGens).toEqual([0, 1, 2]);
    expect(await generations(w.storage)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a publish with no keep, as a bulk load makes, leaves the row recording no list', async () => {
    const w = world();
    await threeLoads(w);
    expect((await w.base.get(SEG))!.keptGens).toEqual([0, 1]);
    const published = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [9], {
      registry: w.base,
    });
    expect(published).toBeDefined();
    const row = (await w.base.get(SEG))!;
    expect(row.currentGen).toBe(3);
    expect(row.keptGens).toBeUndefined();
  });
});
