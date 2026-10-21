import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { eraseIdFromSegment, FENCE_ATTEMPTS } from '@/core/erase-id';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { openGenerationReader } from '@/core/crbm-open';
import { loadSegment } from '@/core/load';
import { pruneKnown } from '@/core/known-generations';
import { renewPointer } from '@/core/pointer-id';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MemoryStorage } from '@/index';
import type { Entropy, SegmentRef } from '@/index';
import type {
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
} from '@cloudbitmaps/core/driver-kit';
import { storeCodec } from '../helpers/store-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore, counting as countingCalls } from '../helpers/counting';
import { recordedWaits, unansweredRegistry } from '../helpers/unanswered-registry';
import { testEntropy } from '../helpers/entropy';

/**
 * The erasure's one write to the row before it deletes anything: it takes every generation it is about to delete out of
 * the row's ledger of known generations (`knownGens`), and renews the row's `pointerId` where a load in flight could
 * still publish what it deletes. These tests pin the races of that write, what it costs, and the claim it exists for:
 * after an erasure that says `erased: true`, no ledger entry names a generation that held the id.
 *
 * Each race is built by running a hook at a named point: the first open of a generation's object (the scan), a
 * registry read by its ordinal, or a registry write.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

interface World {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly load: {
    storage: IStorageDriver;
    registry: IRegistryDriver;
    codec: typeof storeCodec;
    entropy: Entropy;
  };
}

function world(): World {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  return {
    storage,
    registry,
    load: { storage, registry, entropy: testEntropy, codec: storeCodec },
  };
}

const bucket = async (w: World): Promise<number[]> =>
  (await listGenerations(SEG, { storage: w.storage, registry: w.registry })).map(
    (g) => g.generation,
  );

async function holdersOf(storage: IStorageDriver, id: number): Promise<number[]> {
  const out: number[] = [];
  for await (const key of storage.list(SEG)) {
    const reader = await openGenerationReader(storage, key, undefined);
    const bytes = await reader.getChunk(0);
    if (bytes !== null && storeCodec.safeDeserialize(bytes, 1 << 20).has(id)) {
      out.push(key.generation);
    }
  }
  return out.sort((a, b) => a - b);
}

const ledgerOf = async (registry: IRegistryDriver): Promise<number[] | undefined> =>
  (await registry.get(SEG))?.knownGens?.map((e) => e.generation);

/** `base` that runs `hook` the first time an object of a generation `match` names is opened. */
function onFirstOpen(
  base: IStorageDriver,
  match: (generation: number) => boolean,
  hook: () => Promise<unknown>,
): IStorageDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getRange: (k, o, l) => base.getRange(k, o, l),
    delete: (k, o) => base.delete(k, o),
    list: (r) => base.list(r),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    getTail: async (k, m) => {
      if (!fired && match(k.generation)) {
        fired = true;
        await hook();
      }
      return base.getTail(k, m);
    },
  };
}

/** What a registry saw: reads and writes asked, and writes that landed. */
interface Tally {
  gets: number;
  attempts: number;
  landed: number;
}

/**
 * `base` counting its calls, with two hooks: `beforeGet(n)` runs before the n-th read (1-based) answers, `afterGet(n)`
 * after it has read and before it returns the row, and `beforeCas(n)` runs before the n-th write is sent.
 */
function counting(
  base: IRegistryDriver,
  hooks: {
    beforeGet?: (n: number) => Promise<void>;
    afterGet?: (n: number) => Promise<void>;
    beforeCas?: (n: number) => Promise<void>;
    afterCas?: (n: number) => Promise<void>;
  } = {},
): { registry: IRegistryDriver; tally: Tally } {
  const tally: Tally = { gets: 0, attempts: 0, landed: 0 };
  const registry = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return async (ref: SegmentRef) => {
          const n = ++tally.gets;
          await hooks.beforeGet?.(n);
          const row = await target.get(ref);
          await hooks.afterGet?.(n);
          return row;
        };
      }
      if (prop === 'compareAndSwap') {
        return async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
          const n = ++tally.attempts;
          await hooks.beforeCas?.(n);
          const out = await target.compareAndSwap(...args);
          tally.landed += 1;
          await hooks.afterCas?.(n);
          return out;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as IRegistryDriver;
  return { registry, tally };
}

/** Holds a call at a point until `open` is called, and says when it got there. */
function gate(): {
  reached: Promise<void>;
  wait: () => Promise<void>;
  open: () => void;
  hit: () => void;
} {
  let hit!: () => void;
  const reached = new Promise<void>((resolve) => (hit = resolve));
  let open!: () => void;
  const released = new Promise<void>((resolve) => (open = resolve));
  return { reached, wait: () => released, open, hit };
}

/** Generations 0 and 1 hold `id`; 2 is current and clean; the default `keep` of the loads keeps every one in the ledger. */
async function holderBelow(w: World, id = 999): Promise<void> {
  await loadSegment(SEG, [1, id], w.load, { keep: 9 }); // 0 holds
  await loadSegment(SEG, [1], w.load, { keep: 9 }); // 1 current, clean
}

describe('two erasures below the pointer', () => {
  it('both say erased: true, and the second goes on under the first’s write with none of its own', async () => {
    const w = world();
    await loadSegment(SEG, [111, 501], w.load, { keep: 9 }); // 0 holds A
    await loadSegment(SEG, [111, 502], w.load, { keep: 9 }); // 1 holds B
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 2 current, clean

    // B is held right after it read the row for its fence; A runs to the end; then B goes on from the row it read.
    const held = gate();
    const b = counting(w.registry, {
      afterGet: async (n) => {
        if (n === 2) {
          held.hit();
          await held.wait();
        }
      },
    });
    const a = counting(w.registry);
    const second = eraseIdFromSegment(SEG, 502, { ...w.load, registry: b.registry });
    await held.reached;
    const first = await eraseIdFromSegment(SEG, 501, { ...w.load, registry: a.registry });
    held.open();

    expect(first).toMatchObject({ erased: true });
    expect(await second).toMatchObject({ erased: true });
    // Who wrote: A pruned the ledger of every generation below the pointer, so B found nothing left to prune.
    expect(a.tally.landed).toBe(1);
    expect(b.tally.landed).toBe(0);
    expect(await bucket(w)).toEqual([2]);
    expect(await ledgerOf(w.registry)).toEqual([2]);
  });

  it('two erasures that start together both say erased: true', async () => {
    const w = world();
    await loadSegment(SEG, [111, 501], w.load, { keep: 9 });
    await loadSegment(SEG, [111, 502], w.load, { keep: 9 });
    await loadSegment(SEG, [111], w.load, { keep: 9 });
    const [a, b] = await Promise.all([
      eraseIdFromSegment(SEG, 501, w.load),
      eraseIdFromSegment(SEG, 502, w.load),
    ]);
    expect(a).toMatchObject({ erased: true });
    expect(b).toMatchObject({ erased: true });
    expect(await bucket(w)).toEqual([2]);
  });
});

describe('a load lands first', () => {
  it('below the pointer: erased: true, the holders are gone, and the generation the call found clean stays as the load’s grace generation', async () => {
    const w = world();
    await holderBelow(w); // 0 holds, 1 current
    const storage = onFirstOpen(
      w.storage,
      (g) => g === 0,
      async () => {
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 }); // 2, published during the scan
      },
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage });
    expect(res).toMatchObject({ erased: true, fromGeneration: 0 });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    // The sweep's bound is the load's pointer, and 1 is named by the load's window, so it stays.
    expect(await bucket(w)).toEqual([1, 2]);
    expect(await ledgerOf(w.registry)).toEqual([1, 2]);
  });

  it('above the pointer, past every holder: erased: true, the prune renews nothing, and the bucket decides', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // 1 holds
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 }); // 2 holds
    await rollbackSegment(SEG, 0, w.load);
    let loaded: RegistryRecord | undefined;
    const storage = onFirstOpen(
      w.storage,
      (g) => g > 0,
      async () => {
        await loadSegment(SEG, [111, 222], w.load, { keep: 9 }); // 3
        loaded = (await w.registry.get(SEG))!;
      },
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage });
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await bucket(w)).toEqual([0, 3]);
    const row = (await w.registry.get(SEG))!;
    expect(row.pointerId).toBe(loaded!.pointerId);
  });

  it('above the pointer, taking a free number below a holder: superseded, nothing deleted', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 2 }, [111, 999]); // a holder above the pointer
    const storage = onFirstOpen(
      w.storage,
      (g) => g === 2,
      async () => {
        await loadSegment(SEG, [111, 5], w.load, { keep: 9 }); // takes 1
      },
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await holdersOf(w.storage, 999)).toEqual([2]);
  });

  it('above the pointer, past a holder: the call does not sweep, so an object below the pointer that no ledger names stays', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [111], w.load, { keep: 0 }); // 1: collects 0, ledger [1]
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [111]); // an orphan the ledger does not name
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [111, 999]); // a holder above the pointer
    const storage = onFirstOpen(
      w.storage,
      (g) => g === 3,
      async () => {
        await loadSegment(SEG, [111, 5], w.load, { keep: 9 }); // takes 2, below the holder
      },
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await bucket(w)).toEqual([0, 1, 2, 3]);
  });

  it('a rollback forward onto a holder during the scan: superseded', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 });
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 });
    await loadSegment(SEG, [111, 999], w.load, { keep: 9 });
    await rollbackSegment(SEG, 0, w.load);
    const storage = onFirstOpen(
      w.storage,
      (g) => g > 0,
      () => rollbackSegment(SEG, 2, w.load),
    );
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage });
    // The pointer is on a holder now: the call takes the other one, which is below it, and leaves the one the pointer names.
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      fromGeneration: 2,
      collected: [1],
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    expect(await bucket(w)).toEqual([0, 2]);
    expect(await ledgerOf(w.registry)).toEqual([0, 2]);
  });

  it('right after the fence’s write: erased: true, and the generation the call found clean is spared', async () => {
    const w = world();
    await holderBelow(w); // ledger [0, 1]: the fence's write removes 0
    let fired = false;
    const c = counting(w.registry, {
      afterCas: async () => {
        if (fired) return;
        fired = true;
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 }); // 2: the load's window is [1]
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    // The sweep reads the row, finds 1 named, and leaves it: it is the load's grace generation.
    expect(await bucket(w)).toEqual([1, 2]);
  });
});

/** `base` that runs `hook` the first time an object is written (the erasure's rewrite, while it streams). */
function onFirstPut(base: IStorageDriver, hook: () => Promise<unknown>): IStorageDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getRange: (k, o, l) => base.getRange(k, o, l),
    getTail: (k, m) => base.getTail(k, m),
    delete: (k, o) => base.delete(k, o),
    list: (r) => base.list(r),
    putImmutable: async (k, b) => {
      const out = await base.putImmutable(k, b);
      if (!fired) {
        fired = true;
        await hook();
      }
      return out;
    },
  };
}

describe('one erasure rewrites the current generation, another only prunes older ones', () => {
  const A = 501; // in the current generation
  const B = 502; // only in an older generation the ledger names
  async function shape(w: World, keepLast: number): Promise<void> {
    await loadSegment(SEG, [1, B], w.load, { keep: 9 }); // 0 holds B
    await loadSegment(SEG, [1, A], w.load, { keep: keepLast }); // 1 holds A, current
  }
  const both = async (w: World): Promise<void> => {
    expect(await holdersOf(w.storage, A)).toEqual([]);
    expect(await holdersOf(w.storage, B)).toEqual([]);
  };

  for (const keepLast of [1, 9]) {
    it(`B lands during A's stream: both erased: true (keep ${keepLast})`, async () => {
      const w = world();
      await shape(w, keepLast);
      let b: unknown;
      const storage = onFirstPut(w.storage, async () => {
        b = await eraseIdFromSegment(SEG, B, w.load);
      });
      const a = await eraseIdFromSegment(SEG, A, { ...w.load, storage });
      expect(a).toMatchObject({ erased: true });
      expect(b).toMatchObject({ erased: true });
      await both(w);
    });

    it(`started together: both erased: true (keep ${keepLast})`, async () => {
      const w = world();
      await shape(w, keepLast);
      const [a, b] = await Promise.all([
        eraseIdFromSegment(SEG, A, w.load),
        eraseIdFromSegment(SEG, B, w.load),
      ]);
      expect(a).toMatchObject({ erased: true });
      expect(b).toMatchObject({ erased: true });
      await both(w);
    });

    it(`started together, the pruning one first: both erased: true (keep ${keepLast})`, async () => {
      const w = world();
      await shape(w, keepLast);
      const [b, a] = await Promise.all([
        eraseIdFromSegment(SEG, B, w.load),
        eraseIdFromSegment(SEG, A, w.load),
      ]);
      expect(a).toMatchObject({ erased: true });
      expect(b).toMatchObject({ erased: true });
      await both(w);
    });
  }

  it('the pruning one lands right after the rewrite read the row: both erased: true', async () => {
    const w = world();
    await shape(w, 9);
    let b: unknown;
    let fired = false;
    const c = counting(w.registry, {
      afterGet: async (n) => {
        if (n !== 1 || fired) return;
        fired = true;
        b = await eraseIdFromSegment(SEG, B, w.load);
      },
    });
    const a = await eraseIdFromSegment(SEG, A, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(a).toMatchObject({ erased: true });
    expect(b).toMatchObject({ erased: true });
    await both(w);
  });

  it('eight segments, both erasures running over all of them: every one erased: true', async () => {
    const w = world();
    const segs = Array.from({ length: 8 }, (_, i) => ({ namespace: 'ns', segment: `s${i}` }));
    for (const s of segs) {
      await loadSegment(s, [1, B], w.load, { keep: 9 });
      await loadSegment(s, [1, A], w.load, { keep: 1 });
    }
    const outs = await Promise.all(
      segs.map((s) =>
        Promise.all([eraseIdFromSegment(s, A, w.load), eraseIdFromSegment(s, B, w.load)]),
      ),
    );
    for (const [a, b] of outs) {
      expect(a).toMatchObject({ erased: true });
      expect(b).toMatchObject({ erased: true });
    }
  });

  it('a by-name erasure of a holder above the pointer landing during the stream still refuses the rewrite: superseded', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [1, A], w.load, { keep: 9 }); // 1 holds A
    await loadSegment(SEG, [1, A, B], w.load, { keep: 9 }); // 2 holds B and A
    await rollbackSegment(SEG, 1, w.load); // 2 is above the pointer; A is current
    let b: unknown;
    const storage = onFirstPut(w.storage, async () => {
      b = await eraseIdFromSegment(SEG, B, w.load);
    });
    const a = await eraseIdFromSegment(SEG, A, { ...w.load, storage });
    // B's write renews the row's pointerId, which the rewrite's publish is fenced against.
    expect(a).toMatchObject({ erased: false, reason: 'superseded' });
    expect(b).toMatchObject({ erased: true });
  });
});

describe('the collection spared a generation the row named again', () => {
  it('a rollback onto a holder below the pointer and a load, both after the fence: pruned again, erased: true', async () => {
    const w = world();
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 0 holds
    await loadSegment(SEG, [1, 5], w.load, { keep: 9 }); // 1
    await loadSegment(SEG, [1, 6], w.load, { keep: 9 }); // 2 current
    let fired = false;
    const c = counting(w.registry, {
      afterCas: async () => {
        if (fired) return;
        fired = true;
        // Without the flag the same call is refused here: the row does not name the generation.
        await expect(rollbackSegment(SEG, 0, w.load)).rejects.toBeInstanceOf(ValidationError);
        await rollbackSegment(SEG, 0, w.load, { allowUnknown: true });
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await ledgerOf(w.registry)).not.toContain(0);
  });

  it('a second write that keeps losing ends the call with superseded, and the holder stays', async () => {
    const w = world();
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 0 holds
    await loadSegment(SEG, [1, 5], w.load, { keep: 9 }); // 1
    await loadSegment(SEG, [1, 6], w.load, { keep: 9 }); // 2 current
    let fired = false;
    let lost = 0;
    const c = counting(w.registry, {
      beforeCas: async (n) => {
        if (n < 2 || lost >= FENCE_ATTEMPTS) return;
        lost += 1;
        const row = (await w.registry.get(SEG))!;
        await w.registry.compareAndSwap(SEG, row.token, renewPointer(row));
      },
      afterCas: async (n) => {
        if (n !== 1 || fired) return;
        fired = true;
        // Without the flag the same call is refused here: the row does not name the generation.
        await expect(rollbackSegment(SEG, 0, w.load)).rejects.toBeInstanceOf(ValidationError);
        await rollbackSegment(SEG, 0, w.load, { allowUnknown: true });
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(lost).toBe(FENCE_ATTEMPTS);
    expect(c.tally.landed).toBe(1);
    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
    expect(await holdersOf(w.storage, 999)).toEqual([0]);
  });

  it('a row gone before the second fence reads it leaves superseded, with the holder reported, never absent', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 0 clean
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 1 holds
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 2 holds
    await rollbackSegment(SEG, 0, w.load); // holders 1 and 2 are above the pointer
    let phase = 0;
    let after = 0;
    const loaded = onFirstOpen(
      w.storage,
      (g) => g === 2 && phase === 0,
      async () => {
        phase = 1;
        await loadSegment(SEG, [1, 8], w.load, { keep: 9 }); // 3: the pointer moves past both holders
      },
    );
    const storage: IStorageDriver = {
      capabilities: () => loaded.capabilities(),
      getRange: (k, o, l) => loaded.getRange(k, o, l),
      getTail: (k, m) => loaded.getTail(k, m),
      list: (r) => loaded.list(r),
      putImmutable: (k, b) => loaded.putImmutable(k, b),
      delete: async (k, o) => {
        const out = await loaded.delete(k, o);
        if (phase === 2 && k.generation === 1) phase = 3;
        return out;
      },
    };
    const c = counting(w.registry, {
      beforeGet: async (n) => {
        if (phase === 1 && n === 3) {
          phase = 2;
          // Without the flag the same call is refused here: the row does not name the generation.
          await expect(rollbackSegment(SEG, 2, w.load)).rejects.toBeInstanceOf(ValidationError);
          await rollbackSegment(SEG, 2, w.load, { allowUnknown: true }); // onto a holder, below the pointer 3
          await loadSegment(SEG, [1, 9], w.load, { keep: 9 }); // 4: its window keeps 2
        }
        if (phase === 3 && ++after === 2) {
          phase = 4;
          await (w.registry as MemoryRegistryDriver).delete(SEG);
        }
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage, registry: c.registry });
    expect(phase).toBe(4);
    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
    expect(await holdersOf(w.storage, 999)).not.toEqual([]);
  });

  it('the rewrite path: a rollback onto the generation it replaced and a load, before its collection: erased: true', async () => {
    const w = world();
    await loadSegment(SEG, [1, 5], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 1 holds, current: rewritten as 2
    let fired = false;
    const c = counting(w.registry, {
      afterCas: async (n) => {
        if (n !== 1 || fired) return;
        fired = true;
        // Without the flag the same call is refused here: the row does not name the generation.
        await expect(rollbackSegment(SEG, 1, w.load)).rejects.toBeInstanceOf(ValidationError);
        await rollbackSegment(SEG, 1, w.load, { allowUnknown: true }); // back onto the holder the rewrite replaced
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await ledgerOf(w.registry)).not.toContain(1);
  });

  it('a row with no usable ledger, the pointer moved past every holder, and a load that starts a ledger: erased: true', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 0 clean
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 1 holds
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 2 holds
    await loadSegment(SEG, [1, 3], w.load, { keep: 9 }); // 3 clean
    await rollbackSegment(SEG, 0, w.load); // 1 and 2 are above the pointer
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    let phase = 0;
    const storage = onFirstOpen(
      w.storage,
      (g) => g === 3 && phase === 0,
      async () => {
        phase = 1;
        // Without the flag the same call is refused here: the row does not name the generation.
        await expect(rollbackSegment(SEG, 3, w.load)).rejects.toBeInstanceOf(ValidationError);
        await rollbackSegment(SEG, 3, w.load, { allowUnknown: true }); // a rollback starts no ledger
      },
    );
    const c = counting(w.registry, {
      // The fence reads the row (read 3), then the collection does: a load lands before that read.
      beforeGet: async (n) => {
        if (n === 4 && phase === 1) {
          phase = 2;
          await loadSegment(SEG, [1, 8], w.load, { keep: 9 }); // seeds a ledger that names 1 and 2
        }
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage, registry: c.registry });
    expect(phase).toBe(2);
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
  });

  it('a rollback onto an above-pointer holder and away again, between the fence and the delete: the holder stays and the call says superseded', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [1, 5], w.load, { keep: 9 }); // 1 clean = from
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 2 holds
    await rollbackSegment(SEG, 1, w.load);
    let fired = false;
    const c = counting(w.registry, {
      afterCas: async (n) => {
        if (n !== 1 || fired) return;
        fired = true;
        // Without the flag the same call is refused here: the row does not name the generation.
        await expect(rollbackSegment(SEG, 2, w.load)).rejects.toBeInstanceOf(ValidationError);
        await rollbackSegment(SEG, 2, w.load, { allowUnknown: true });
        await rollbackSegment(SEG, 1, w.load);
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
    // The row names it again, so it is a rollback target and is not deleted from under the row.
    expect(await holdersOf(w.storage, 999)).toEqual([2]);
    expect(await ledgerOf(w.registry)).toContain(2);
  });
});

describe('a renewal that landed before the call listed the bucket', () => {
  it('is no licence for a delete by name: the call renews the row itself, after its listing', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0 current, clean
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [111, 999]); // a load in flight's object
    let renewedBy: RegistryRecord | undefined;
    let fired = false;
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      delete: (k, o) => w.storage.delete(k, o),
      putImmutable: (k, b) => w.storage.putImmutable(k, b),
      list: async function* (r) {
        if (!fired) {
          fired = true;
          const row = (await w.registry.get(SEG))!;
          await w.registry.compareAndSwap(SEG, row.token, renewPointer(row));
          renewedBy = (await w.registry.get(SEG))!;
        }
        yield* w.storage.list(r);
      },
    };
    const c = counting(w.registry);
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true });
    expect(c.tally.landed).toBe(1);
    expect((await w.registry.get(SEG))!.pointerId).not.toBe(renewedBy!.pointerId);
  });

  it('a holder above the pointer is deleted only after the call renews the row', async () => {
    const w = world();
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0 current, clean
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [111, 999]);
    const before = (await w.registry.get(SEG))!;
    const c = counting(w.registry);
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(res).toMatchObject({ erased: true });
    expect(c.tally.landed).toBe(1);
    const after = (await w.registry.get(SEG))!;
    expect(after.pointerId).not.toBe(before.pointerId);
    expect(after.currentGen).toBe(before.currentGen);
  });
});

describe('a rollback onto a holder below the pointer before the fence', () => {
  it('leaves that holder current and the generations between it and the old pointer known, and the call throws', async () => {
    const w = world();
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 0 holds
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 1 clean
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 2 current, clean
    const storage = onFirstOpen(
      w.storage,
      (g) => g === 0,
      () => rollbackSegment(SEG, 0, w.load),
    );
    await expect(eraseIdFromSegment(SEG, 999, { ...w.load, storage })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await holdersOf(w.storage, 999)).toEqual([0]);
    // 1 and 2 are above the pointer now, clean rollback targets the call has no reason to take out of the ledger.
    expect(await ledgerOf(w.registry)).toEqual([1, 2, 0]);
    expect(await bucket(w)).toEqual([0, 1, 2]);
  });
});

describe('a row that is another incarnation of the name at the fence', () => {
  it('is superseded, and nothing of the old incarnation is deleted', async () => {
    const w = world();
    await holderBelow(w); // 0 holds, 1 current
    const c = counting(w.registry, {
      beforeGet: async (n) => {
        if (n !== 2) return;
        await (w.registry as MemoryRegistryDriver).delete(SEG);
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 }); // a new incarnation, numbered above the objects left
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    // It deleted nothing: the objects below the new row's pointer are not its to take.
    expect(res).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await holdersOf(w.storage, 999)).toEqual([0]);
    expect(await bucket(w)).toEqual([0, 1, 2]);
  });
});

describe('a fence that gets no answer', () => {
  const prunes = (patch: { knownGens?: unknown }): boolean => 'knownGens' in patch;

  it('that landed is settled by reading the row, and the call goes on under it with nothing sent again', async () => {
    const w = world();
    await holderBelow(w);
    const registry = unansweredRegistry(w.registry, ['land-then-throw'], { covers: prunes });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry });
    expect(res).toMatchObject({ erased: true });
    expect(registry.sends).toBe(1);
    expect(await bucket(w)).toEqual([1]);
  });

  it('that did not land is sent again after a wait, and nothing is deleted until one is answered', async () => {
    const w = world();
    await holderBelow(w);
    const waits = recordedWaits();
    let deletedBefore: number[] | undefined;
    const registry = unansweredRegistry(w.registry, ['throw', 'pass'], {
      covers: prunes,
      between: async () => {
        deletedBefore = await bucket(w);
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, {
      ...w.load,
      registry,
      clock: waits.clock,
      rng: waits.rng,
    });
    expect(res).toMatchObject({ erased: true });
    expect(deletedBefore).toEqual([0, 1]);
    expect(waits.sleeps).toHaveLength(1);
  });

  it('with no clock to wait on, throws TransientError and has deleted nothing', async () => {
    const w = world();
    await holderBelow(w);
    const registry = unansweredRegistry(w.registry, ['throw'], { covers: prunes });
    await expect(eraseIdFromSegment(SEG, 999, { ...w.load, registry })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(await bucket(w)).toEqual([0, 1]);
    expect(await ledgerOf(w.registry)).toEqual([0, 1]);
  });
});

describe('the write is made only when the ledger names something to delete', () => {
  async function names(shape: 'nothing' | 'unusable' | 'holder'): Promise<World> {
    const w = world();
    if (shape === 'holder') {
      await loadSegment(SEG, [1, 999], w.load, { keep: 1 }); // 0 holds
      await loadSegment(SEG, [1], w.load, { keep: 1 }); // 1, ledger [0, 1]
      return w;
    }
    await loadSegment(SEG, [1], w.load, { keep: 0 });
    await loadSegment(SEG, [1], w.load, { keep: 0 });
    await loadSegment(SEG, [1], w.load, { keep: 0 }); // 2 current, ledger [2]
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [1, 999]); // an orphan below the pointer
    if (shape === 'unusable') {
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    }
    return w;
  }

  // The fence reads the row once before the sweep, and a row with no usable ledger is read once more after it, in case a
  // load started a ledger meanwhile. The receipt reads it once after its listing, which names the current generation the
  // call found clean.
  it.each([
    ['nothing' as const, 7],
    ['unusable' as const, 8],
  ])('ledger names %s: no compare-and-swap, %i registry reads', async (shape, gets) => {
    const w = await names(shape);
    const c = counting(w.registry);
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(res).toMatchObject({ erased: true, collected: [0] });
    expect(c.tally).toEqual({ gets, attempts: 0, landed: 0 });
  });

  it('ledger names the holder: one compare-and-swap, and the ledger loses it before the delete', async () => {
    const w = await names('holder');
    const seen: (number[] | undefined)[] = [];
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      list: (r) => w.storage.list(r),
      putImmutable: (k, b) => w.storage.putImmutable(k, b),
      delete: async (k, o) => {
        seen.push(await ledgerOf(w.registry));
        return w.storage.delete(k, o);
      },
    };
    const c = counting(w.registry);
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, storage, registry: c.registry });
    expect(res).toMatchObject({ erased: true, collected: [0] });
    // The last read is the receipt's, after its listing, which names the current generation the call found clean.
    expect(c.tally).toEqual({ gets: 7, attempts: 1, landed: 1 });
    expect(seen).toEqual([[1]]);
  });
});

describe('what an erasure costs at the store an object-store registry is over', () => {
  /** The registry's reads and writes, and the storage requests by method, that one erasure of the id makes. */
  async function requests(
    shape: 'older' | 'unnamed' | 'no-ledger' | 'rewrite' | 'above',
  ): Promise<{ registry: [number, number]; storage: Record<string, number> }> {
    const storage = new MemoryStorageDriver();
    const store = new CountingObjectStore(0, { conditionalDelete: true });
    let t = 1_000;
    const registry = new ObjectStoreRegistry(store, 'p', () => (t += 1));
    const load = { storage, registry, entropy: testEntropy, codec: storeCodec };
    if (shape === 'older') {
      await loadSegment(SEG, [1, 999], load, { keep: 1 }); // 0 holds, and the ledger names it
      await loadSegment(SEG, [1], load, { keep: 1 });
    } else if (shape === 'rewrite') {
      await loadSegment(SEG, [1], load, { keep: 1 });
      await loadSegment(SEG, [1, 999], load, { keep: 1 }); // the current generation holds
    } else if (shape === 'above') {
      await loadSegment(SEG, [1], load, { keep: 5 });
      await loadSegment(SEG, [1, 2], load, { keep: 5 }); // clean, above the pointer after the rollback
      await loadSegment(SEG, [1, 999], load, { keep: 5 }); // holds, above the pointer after the rollback
      await rollbackSegment(SEG, 0, load);
    } else {
      for (let i = 0; i < 3; i++) await loadSegment(SEG, [1], load, { keep: 0 });
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 999]); // an orphan the ledger does not name
      if (shape === 'no-ledger') {
        const row = (await registry.get(SEG))!;
        await registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
      }
    }
    const [reads, writes] = [store.reads, store.writes];
    const calls: Record<string, number> = {};
    const counted = { ...load, storage: countingCalls(storage, calls) };
    expect(await eraseIdFromSegment(SEG, 999, counted)).toMatchObject({ erased: true });
    delete calls.capabilities;
    return { registry: [store.reads - reads, store.writes - writes], storage: calls };
  }

  // Each count includes one read of the row after the call's last listing of the bucket, made because that listing names
  // the generation the call found current or its own rewrite, which it skips only while the row names it with the
  // footer checksum of the object it read or wrote. The storage counts pin that the skip happens: that generation is
  // listed, not opened again, while every other generation the call found clean is opened again.
  it('an id held only by an older generation the ledger names: 8 reads and 1 write', async () => {
    expect(await requests('older')).toEqual({
      registry: [8, 1],
      storage: { list: 3, getTail: 2, getRange: 2, delete: 1 },
    });
  });
  it('an id held only by an older generation, with a usable ledger that does not name it: 7 reads and no write', async () => {
    expect(await requests('unnamed')).toEqual({
      registry: [7, 0],
      storage: { list: 3, getTail: 2, getRange: 2, delete: 1 },
    });
  });
  it('an id held only by an older generation, on a row with no usable ledger: 8 reads and no write, and the current generation is opened again', async () => {
    // No ledger vouches for the generation the call found clean, so the receipt opens it again: one tail read and one
    // chunk read more than where the row has a ledger.
    expect(await requests('no-ledger')).toEqual({
      registry: [8, 0],
      storage: { list: 3, getTail: 3, getRange: 3, delete: 1 },
    });
  });
  it('an id held by the current generation (a rewrite): 10 reads and 1 write', async () => {
    expect(await requests('rewrite')).toEqual({
      registry: [10, 1],
      storage: { list: 3, getTail: 2, getRange: 1, putImmutable: 1, delete: 2 },
    });
  });
  it('an id held only above the pointer, beside a generation there it found clean: that one is opened again, the current one is not', async () => {
    // The search opens 0, 1 and 2 (one tail read and one chunk read each); the receipt opens 1 again, since a ledger
    // entry for a generation the call did not find current can outlive the object it read, and skips 0.
    expect(await requests('above')).toEqual({
      registry: [8, 1],
      storage: { list: 3, getTail: 4, getRange: 4, delete: 1 },
    });
  });
});

describe('a load publishing between a rewrite and its collection', () => {
  it('has the rewrite spared as its grace generation, and the claim holds', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 0
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 1 holds, current: rewritten as 2
    let fired = false;
    const c = counting(w.registry, {
      afterCas: async () => {
        if (fired) return;
        fired = true;
        await loadSegment(SEG, [1, 7], w.load, { keep: 9 }); // 3
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true, generation: 2 });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await bucket(w)).toEqual([2, 3]);
  });
});

describe('a load publishing between the fence and the sweep', () => {
  it('has its grace generation spared by the sweep while the holder check passes', async () => {
    const w = world();
    await holderBelow(w);
    let reads = 0;
    const c = counting(w.registry, {
      // Reads: the call's own, the fence's, then the sweep's first. The load lands before the third answers.
      beforeGet: async (n) => {
        reads = n;
        if (n === 3) await loadSegment(SEG, [1, 7], w.load, { keep: 9 });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await bucket(w)).toEqual([1, 2]);
  });
});

describe('a row with no usable ledger that a load starts between the fence and the sweep', () => {
  it('is pruned again and swept again: erased: true', async () => {
    const w = world();
    await loadSegment(SEG, [1, 999], w.load, { keep: 9 }); // 0 holds
    await loadSegment(SEG, [1], w.load, { keep: 9 });
    await loadSegment(SEG, [1], w.load, { keep: 9 }); // 2 current
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    const c = counting(w.registry, {
      // The load's publish over a row with no ledger seeds one from the bucket, which names the holder.
      beforeGet: async (n) => {
        if (n === 3) await loadSegment(SEG, [1, 7], w.load, { keep: 9 });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(res).toMatchObject({ erased: true });
    expect(await holdersOf(w.storage, 999)).toEqual([]);
    expect(await ledgerOf(w.registry)).not.toContain(0);
    expect(c.tally.landed).toBe(1);
    // The second collection spares the generation the call found clean, which the load's window names.
    expect(await bucket(w)).toEqual([2, 3]);
  });

  it('with a usable ledger no second read is made', async () => {
    const w = world();
    await holderBelow(w);
    const c = counting(w.registry);
    await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    // None after the collection: the last of the seven is the receipt's, after its listing, which names the current
    // generation the call found clean.
    expect(c.tally.gets).toBe(7);
  });
});

describe('a fence that keeps losing', () => {
  /** Before each of the call's writes, another writer renews the row: the write meets a token it did not read. */
  function interfering(w: World, times: number, sink: { lost: number }): IRegistryDriver {
    return counting(w.registry, {
      beforeCas: async () => {
        if (sink.lost >= times) return;
        sink.lost += 1;
        const row = (await w.registry.get(SEG))!;
        await w.registry.compareAndSwap(SEG, row.token, renewPointer(row));
      },
    }).registry;
  }

  it('says superseded at the fifth loss, deletes nothing, and makes no claim', async () => {
    const w = world();
    await holderBelow(w);
    const sink = { lost: 0 };
    const res = await eraseIdFromSegment(SEG, 999, {
      ...w.load,
      registry: interfering(w, 99, sink),
    });
    expect(FENCE_ATTEMPTS).toBe(5);
    expect(sink.lost).toBe(FENCE_ATTEMPTS);
    expect(res).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await bucket(w)).toEqual([0, 1]);
    expect(await holdersOf(w.storage, 999)).toEqual([0]);
  });

  it('lands at the fifth try after four losses', async () => {
    const w = world();
    await holderBelow(w);
    const sink = { lost: 0 };
    const res = await eraseIdFromSegment(SEG, 999, {
      ...w.load,
      registry: interfering(w, FENCE_ATTEMPTS - 1, sink),
    });
    expect(res).toMatchObject({ erased: true });
    expect(await bucket(w)).toEqual([1]);
  });

  it('six writes of the row’s leases alone cost no attempt', async () => {
    const w = world();
    await holderBelow(w);
    let n = 0;
    const c = counting(w.registry, {
      beforeCas: async () => {
        if (n >= 6) return;
        n += 1;
        const row = (await w.registry.get(SEG))!;
        const leases = [
          ...(row.leases ?? []),
          { holder: n.toString(16).padStart(16, '0'), generation: 1, until: 4_000_000_000_000 },
        ];
        await w.registry.compareAndSwap(SEG, row.token, { leases });
      },
    });
    const res = await eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry });
    expect(res).toMatchObject({ erased: true });
    // Six lost to leases, then the one that landed: more than the five a write that loses to another writer gets.
    expect(c.tally.attempts).toBe(7);
    expect(c.tally.landed).toBe(1);
  });
});

describe('holders above the pointer', () => {
  async function aboveBoth(w: World, same: boolean): Promise<void> {
    await loadSegment(SEG, [111], w.load, { keep: 9 }); // 0 clean
    await loadSegment(SEG, same ? [111, 501, 502] : [111, 501], w.load, { keep: 9 }); // 1
    await loadSegment(SEG, same ? [111] : [111, 502], w.load, { keep: 9 }); // 2
    await rollbackSegment(SEG, 0, w.load);
  }

  const cases: [string, boolean, number, number[]][] = [
    ['the same generation', true, 0, [0, 2]],
    ['different generations', false, 1, [0]],
  ];
  for (const [name, same, writes, left] of cases) {
    it(`two erasures whose ids are held by ${name}: both erased: true, and the second’s writes that landed: ${writes}`, async () => {
      const w = world();
      await aboveBoth(w, same);
      const held = gate();
      const b = counting(w.registry, {
        afterGet: async (n) => {
          if (n === 2) {
            held.hit();
            await held.wait();
          }
        },
      });
      const second = eraseIdFromSegment(SEG, 502, { ...w.load, registry: b.registry });
      await held.reached;
      const first = await eraseIdFromSegment(SEG, 501, w.load);
      held.open();
      expect(first).toMatchObject({ erased: true });
      expect(await second).toMatchObject({ erased: true });
      expect(b.tally.landed).toBe(writes);
      expect(await holdersOf(w.storage, 501)).toEqual([]);
      expect(await holdersOf(w.storage, 502)).toEqual([]);
      expect(await bucket(w)).toEqual(left);
    });
  }

  it('two erasures that start together, with different holders, both say erased: true', async () => {
    const w = world();
    await aboveBoth(w, false);
    const [a, b] = await Promise.all([
      eraseIdFromSegment(SEG, 501, w.load),
      eraseIdFromSegment(SEG, 502, w.load),
    ]);
    expect(a).toMatchObject({ erased: true });
    expect(b).toMatchObject({ erased: true });
  });

  it('a holder whose delete fails is out of the ledger before the call throws', async () => {
    const w = world();
    await aboveBoth(w, false);
    const denied: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      list: (r) => w.storage.list(r),
      putImmutable: (k, b) => w.storage.putImmutable(k, b),
      delete: () => Promise.reject(new Error('AccessDenied')),
    };
    await expect(eraseIdFromSegment(SEG, 501, { ...w.load, storage: denied })).rejects.toThrow(
      'AccessDenied',
    );
    // The holder (1) is out of the ledger, so it is no known generation: the row names 0 and 2 only.
    expect(await ledgerOf(w.registry)).toEqual([2, 0]);
  });
});

describe('a row that goes while the call runs', () => {
  it('on the path with nothing to delete by name never says absent while a holder is in the bucket', async () => {
    const w = world();
    await holderBelow(w);
    let gone = false;
    const c = counting(w.registry, {
      beforeCas: async () => {
        if (gone) return;
        gone = true;
        await (w.registry as MemoryRegistryDriver).delete(SEG);
      },
    });
    await expect(
      eraseIdFromSegment(SEG, 999, { ...w.load, registry: c.registry }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(gone).toBe(true);
    expect(await holdersOf(w.storage, 999)).toEqual([0]);
  });
});

describe('pruneKnown', () => {
  const row = (known: number[], current: number): RegistryRecord =>
    ({
      status: 'active',
      currentGen: current,
      knownGens: known.map((generation) => ({ generation, footerCrc: 1 })),
    }) as unknown as RegistryRecord;

  it('keeps the order of what is left and never removes the current generation', () => {
    const r = row([3, 1, 4, 2], 2);
    expect(pruneKnown(r, new Set([1, 2, 3]))?.map((e) => e.generation)).toEqual([4, 2]);
  });

  it('names nothing on a row with no usable ledger', () => {
    expect(
      pruneKnown({ ...row([1, 2], 2), status: 'destroyed' } as RegistryRecord, new Set([1])),
    ).toBe(undefined);
  });
});

describe('after erased: true, no ledger entry names a generation that held the id (property)', () => {
  let root: string;
  let dirs = 0;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cbm-fence-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const registries: ReadonlyArray<{ name: string; make: () => IRegistryDriver }> = [
    { name: 'MemoryRegistryDriver', make: () => new MemoryRegistryDriver() },
    {
      name: 'LocalFsRegistryDriver',
      make: () => new LocalFsRegistryDriver(join(root, `d${dirs++}`)),
    },
    {
      name: 'ObjectStoreRegistry',
      make: () => new ObjectStoreRegistry(new CountingObjectStore(0), undefined, Date.now),
    },
  ];

  type Step =
    | { kind: 'load'; ids: number[]; keep: number }
    | { kind: 'rollback'; pick: number }
    | { kind: 'erase'; id: number };
  const step: fc.Arbitrary<Step> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('load' as const),
        ids: fc.uniqueArray(fc.integer({ min: 1, max: 5 }), { maxLength: 4 }),
        keep: fc.constantFrom(0, 1, 3, 9),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('rollback' as const), pick: fc.nat(9) }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('erase' as const),
        id: fc.integer({ min: 1, max: 5 }),
      }),
    },
  );

  describe.each(registries)('over $name', (reg) => {
    it('holds', async () => {
      const erased = { count: 0 };
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 3, maxLength: 14 }), async (steps) => {
          const storage = new MemoryStorageDriver();
          const registry = reg.make();
          const deps = { storage, registry, entropy: testEntropy, codec: storeCodec };
          for (const s of steps) {
            if (s.kind === 'load') {
              await loadSegment(SEG, [100, ...s.ids], deps, { keep: s.keep });
            } else if (s.kind === 'rollback') {
              const gens = await bucket({ storage, registry, load: deps });
              if (gens.length > 0) {
                await rollbackSegment(SEG, gens[s.pick % gens.length]!, deps, {
                  allowUnknown: true, // widen: land on unknown numbers too
                }).catch(() => undefined);
              }
            } else {
              if ((await registry.get(SEG)) === null) continue;
              const held = await holdersOf(storage, s.id);
              const namedBefore = ((await ledgerOf(registry)) ?? []).filter((g) =>
                held.includes(g),
              );
              const res = await eraseIdFromSegment(SEG, s.id, deps).catch(() => undefined);
              if (res === undefined || !res.erased) continue;
              if (namedBefore.length > 0) erased.count += 1;
              const named = (await ledgerOf(registry)) ?? [];
              expect(named.filter((g) => held.includes(g))).toEqual([]);
              expect(await holdersOf(storage, s.id)).toEqual([]);
            }
          }
        }),
        { numRuns: reg.name === 'MemoryRegistryDriver' ? 60 : 20, seed: 7 },
      );
      // Not vacuous: calls that said erased: true over a ledger that named a generation holding the id were checked.
      expect(erased.count).toBeGreaterThan(3);
    }, 120_000);
  });
});
