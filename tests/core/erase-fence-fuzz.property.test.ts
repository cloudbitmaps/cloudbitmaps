import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { openGenerationReader } from '@/core/crbm-open';
import { eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { NotFoundError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { clearSegmentRetention, setSegmentRetention } from '@/core/retention';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';
import { faultyRegistry } from '../helpers/lost-answer';
import { heavy } from '../helpers/strength';

/**
 * An erasure of X, and one to three loads that read the row before it began and carry X in their own input, over a
 * segment with a history of crashed and published generations of X and of another id Y (and sometimes an orphan above
 * the pointer). The loads' object writes are held; one hook fires at a random registry read of the erasure (an erasure
 * of Y, a generation published by another writer, a second erasure of X, a full load, or a policy write: a retention
 * expiry or a residency set and then cleared again, so the row is put back as the loads read it); the loads' writes are
 * released at a random read; and on a quarter of the runs the first compare-and-swap of the erasure lands with its
 * answer lost.
 *
 * Whatever the interleaving:
 *
 *  1. when an erasure answers `erased: true`, X is not in the generation the row names;
 *  2. with no hook and no lost answer, an erasure that found the id and did not erase it was refused as `'superseded'`.
 *
 * (1) is what an erasure that found the id promises a load that read the row before it began: that load is refused,
 * by the erasure's own write or by another write that changed the row's `pointerId` or ledger, which no later write puts
 * back. Without the renewal on the path that owed the ledger no prune, about 3.3% of these runs serve X after
 * `erased: true`; where a retention or residency write counts as that other write, a set and a clear of it undo it.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 777;
const Y = 888;

/** A small seeded generator, so a run is a function of its seed alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The storage, with each object write held until `mayWrite` resolves. */
function heldPuts(storage: IStorageDriver, mayWrite: Promise<void>): IStorageDriver {
  return new Proxy(storage, {
    get(t, k, rx) {
      const v: unknown = Reflect.get(t, k, rx);
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (k !== 'putImmutable') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        await mayWrite;
        return await (fn.apply(t, a) as Promise<unknown>);
      };
    },
  });
}

/** The registry, calling `cb` with the count of reads after each read answers. */
function onGet(registry: IRegistryDriver, cb: (n: number) => Promise<void>): IRegistryDriver {
  let n = 0;
  return new Proxy(registry, {
    get(t, k, rx) {
      const v: unknown = Reflect.get(t, k, rx);
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (k !== 'get') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const row = await (fn.apply(t, a) as Promise<unknown>);
        n += 1;
        await cb(n);
        return row;
      };
    },
  });
}

async function servedIds(storage: IStorageDriver, registry: IRegistryDriver): Promise<number[]> {
  const row = await registry.get(SEG);
  if (row === null || row.currentGen === null) return [];
  let reader: Awaited<ReturnType<typeof openGenerationReader>>;
  try {
    reader = await openGenerationReader(storage, { ...SEG, generation: row.currentGen }, undefined);
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
  const out: number[] = [];
  for (const ck of reader.chunkKeys()) {
    const b = await reader.getChunk(ck);
    if (b === null) continue;
    for (const r of roaringCodec.safeDeserialize(b, 1 << 20).toArray()) out.push((ck << 16) + r);
  }
  return out;
}

type Answer = EraseIdResult | { readonly threw: string };

const erasedTrue = (a: Answer): boolean => 'erased' in a && a.erased;

/** One run, a function of `seed`. Returns what to count, and fails on a counterexample. */
async function run(seed: number): Promise<{ erased: boolean; refused: boolean }> {
  const r = rng(seed);
  const pick = (n: number): number => Math.floor(r() * n);
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const base = { registry };
  let g = 0;
  const shape: string[] = [];
  const steps = 1 + pick(4);
  for (let i = 0; i < steps; i++) {
    const kind = pick(4);
    const ids = [5 + i];
    if (kind === 0) {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [X, ...ids], {
        ...base,
        publish: false,
      });
      shape.push('crashX');
    } else if (kind === 1) {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [X, Y, ...ids], base);
      shape.push('pubX');
    } else if (kind === 2) {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [Y, ...ids], base);
      shape.push('pubY');
    } else {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [Y, ...ids], {
        ...base,
        publish: false,
      });
      shape.push('crashY');
    }
  }
  await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [Y, 99], base);
  shape.push('head');
  if (pick(3) === 0) {
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g++ }, [X, 98], {
      ...base,
      publish: false,
    });
    shape.push('orphanAbove');
  }
  const nLoads = 1 + pick(3);
  const mayWrite = gate();
  const loads: Promise<unknown>[] = [];
  for (let i = 0; i < nLoads; i++) {
    const read = gate();
    const tracked = onGet(registry, async (n) => {
      if (n === 1) read.resolve();
    });
    loads.push(
      loadSegment(SEG, [X, 3 + i, 4], {
        storage: heldPuts(storage, mayWrite.promise),
        registry: tracked,
        entropy: testEntropy,
        codec: roaringCodec,
      }).catch((e: unknown) => ({ threw: String(e) })),
    );
    await read.promise;
    if (pick(4) === 0 && i < nLoads - 1) {
      // an ungated writer lands an orphan between the loads' reads
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g + 50 + i }, [Y, 1000 + i], {
        ...base,
        publish: false,
      }).catch(() => undefined);
      shape.push('lateOrphan');
    }
  }
  const hookAt = 1 + pick(10);
  const releaseAt = 1 + pick(14);
  const hook = pick(6);
  const clearAt = hookAt + pick(8);
  const policy = pick(2) === 0 ? 'retention' : 'residency';
  let policySet = false;
  let policyCleared = false;
  const setPolicy = async (): Promise<void> => {
    policySet = true;
    if (policy === 'retention')
      await setSegmentRetention(SEG, { registry }, { expiresAt: Date.now() + 86_400_000 });
    else {
      const row = await registry.get(SEG);
      if (row !== null)
        await registry.compareAndSwap(SEG, row.token, { residency: { region: 'x' } });
    }
  };
  const clearPolicy = async (): Promise<void> => {
    policyCleared = true;
    if (policy === 'retention') await clearSegmentRetention(SEG, { registry });
    else {
      const row = await registry.get(SEG);
      if (row !== null) await registry.compareAndSwap(SEG, row.token, { residency: undefined });
    }
  };
  const lost = pick(4) === 0;
  shape.push(`hook${hook}@${hookAt} release@${releaseAt} lost=${lost} loads=${nLoads}`);
  let hooked = false;
  const depsOf = (reg: IRegistryDriver) => ({
    storage,
    registry: reg,
    entropy: testEntropy,
    codec: roaringCodec,
  });
  let other: Promise<Answer> = Promise.resolve({ threw: 'none' });
  const faulty = faultyRegistry(registry);
  if (lost) faulty.arm('compareAndSwap', 'a', undefined, 1);
  const eraseReg = onGet(faulty, async (n) => {
    if (n === releaseAt) mayWrite.resolve();
    if (hook === 5 && policySet && !policyCleared && n >= clearAt)
      await clearPolicy().catch(() => undefined);
    if (n !== hookAt || hooked) return;
    hooked = true;
    if (hook === 1) await eraseIdFromSegment(SEG, Y, depsOf(registry)).catch(() => undefined);
    else if (hook === 2)
      await bulkLoadCrbmGeneration(
        storage,
        { ...SEG, generation: 200 + (seed % 7) },
        [Y, 61],
        base,
      ).catch(() => undefined);
    else if (hook === 3)
      other = eraseIdFromSegment(SEG, X, depsOf(registry)).catch((e: unknown) => ({
        threw: String(e),
      }));
    else if (hook === 4) await loadSegment(SEG, [Y, 62], depsOf(registry)).catch(() => undefined);
    else if (hook === 5) await setPolicy().catch(() => undefined);
  });
  let res: Answer;
  try {
    res = await eraseIdFromSegment(SEG, X, depsOf(eraseReg));
  } catch (e) {
    res = { threw: String(e) };
  }
  // A policy set that the erasure's reads did not outlast is cleared before the loads' writes land.
  if (hook === 5 && policySet && !policyCleared) await clearPolicy().catch(() => undefined);
  mayWrite.resolve();
  await Promise.all(loads);
  const second = await other;
  const served = await servedIds(storage, registry);
  const where = `seed ${seed}: ${shape.join(',')} ${JSON.stringify(res)}`;
  if (erasedTrue(res)) expect(served, `X served after erased:true, ${where}`).not.toContain(X);
  if (erasedTrue(second))
    expect(served, `X served after a second erased:true, ${where}`).not.toContain(X);
  let refused = false;
  if ('erased' in res && !res.erased && res.reason !== 'not-member' && hook === 0 && !lost) {
    refused = true;
    expect(res.reason, `refusal other than superseded, ${where}`).toBe('superseded');
  }
  return { erased: erasedTrue(res), refused };
}

describe('an erasure and the loads that read the row before it began, in a random interleaving', () => {
  it('never serves the erased id after erased: true', async () => {
    let runs = 0;
    let erased = 0;
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        const out = await run(seed);
        runs += 1;
        if (out.erased) erased += 1;
        if (out.refused) refused += 1;
      }),
      { numRuns: heavy('eraseFenceFuzzRuns') },
    );
    // The run is not vacuous: most runs erase.
    expect(erased).toBeGreaterThan(runs / 10);
    // And some runs end in the refusal assertion 2 checks.
    if (runs >= 1000) expect(refused).toBeGreaterThan(0);
  }, 900_000);
});
