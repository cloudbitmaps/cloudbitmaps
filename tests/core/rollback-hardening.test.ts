import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import type { IKeystore } from '@/core/crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  NotFoundError,
  TransientError,
  ValidationError,
} from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { openSummary } from '@/core/summary';
import { incarnationOf } from '@/core/token';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * A rollback proves what it moves the pointer onto. Rolling to the generation already current is a no-op only over an
 * object that is there; a swap that got no answer is settled by reading the row, and checked like one that did; and a
 * target above the pointer of an encrypted segment, which may never have been published, is moved onto only once the
 * segment's key has opened it. A keystore that fails for any reason but "no key at hand" is a fault, and is thrown.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

function world(keystore?: IKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const load = { storage, registry, codec: roaringCodec, keystore };
  return { storage, registry, load, deps: { storage, registry, keystore } };
}
type World = ReturnType<typeof world>;

/** `n` one-id generations, every one kept: generation `n - 1` is current. */
async function loads(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await loadSegment(SEG, [i + 1], w.load, { keep: 9 });
}

const rowOf = async (w: World): Promise<RegistryRecord> => (await w.registry.get(SEG))!;

const present = async (w: World): Promise<number[]> => {
  const out: number[] = [];
  for await (const k of w.storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
};

/** A timeout as `AbortSignal.timeout()` and the AWS SDK raise one: an error named `TimeoutError`. */
const timedOut = (): Error =>
  Object.assign(new Error('the key service timed out'), { name: 'TimeoutError' });

describe('a rollback to the generation already current', () => {
  it('throws NotFoundError naming what is in the bucket when its object is gone, and moves nothing', async () => {
    // The pointer names a missing object after a collection raced an earlier move, or after a swap that got no answer
    // landed and its target was collected. Re-running a rollback to the generation you want must not report success.
    const w = world();
    await loads(w, 3);
    await w.storage.delete({ ...SEG, generation: 2 });
    const before = await rowOf(w);
    const audit = new RecordingAuditSink();

    const err = await rollbackSegment(SEG, 2, w.deps, { audit }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(
      /generation 2 of "s" is current, but its object is not in the bucket — present: 0, 1/,
    );
    expect((await rowOf(w)).token).toBe(before.token);
    expect(audit.snapshot()).toEqual([]);
  });

  it('says so when no generation remains at all', async () => {
    const w = world();
    await loads(w, 1);
    await w.storage.delete({ ...SEG, generation: 0 });
    await expect(rollbackSegment(SEG, 0, w.deps)).rejects.toThrow(
      /is current, but its object is not in the bucket \(no generations remain\)/,
    );
  });

  it('is a no-op for one zero-byte read when its object is there, with no listing', async () => {
    const w = world();
    await loads(w, 2);
    const calls: Record<string, number> = {};
    const tails: number[] = [];
    const storage = counting<IStorageDriver>(w.storage, calls);
    const watched = new Proxy(storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'getTail') return value;
        return (...args: Parameters<IStorageDriver['getTail']>) => {
          tails.push(args[1]);
          return (value as IStorageDriver['getTail'])(...args);
        };
      },
    });

    const r = await rollbackSegment(SEG, 1, { storage: watched, registry: w.registry });

    expect(r).toEqual({ fromGeneration: 1, generation: 1 });
    expect(tails).toEqual([0]);
    expect(calls.list ?? 0).toBe(0);
    expect(calls.getRange ?? 0).toBe(0);
  });

  it('throws a fault of that read rather than reporting a no-op it could not check', async () => {
    const w = world();
    await loads(w, 2);
    const fault = new TransientError('the storage read was throttled');
    const throttled = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'getTail') return typeof value === 'function' ? value.bind(t) : value;
        return () => Promise.reject(fault);
      },
    });
    await expect(
      rollbackSegment(SEG, 1, { storage: throttled, registry: w.registry }),
    ).rejects.toBe(fault);
  });
});

/**
 * `registry`, whose first compare-and-swap lands and then throws `TransientError`, as a write does whose response is lost
 * on the way back; `meanwhile` runs between the two. With `lands: false` the write never lands.
 */
function noAnswer(
  registry: IRegistryDriver,
  {
    lands = true,
    meanwhile = async () => {},
  }: { lands?: boolean; meanwhile?: () => Promise<unknown> } = {},
): IRegistryDriver {
  let fired = false;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'compareAndSwap') return typeof value === 'function' ? value.bind(t) : value;
      return async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
        if (fired) return (value as IRegistryDriver['compareAndSwap']).apply(t, args);
        fired = true;
        if (lands) await (value as IRegistryDriver['compareAndSwap']).apply(t, args);
        await meanwhile();
        throw new TransientError('the registry write got no answer');
      };
    },
  });
}

/** A reader's lease on generation `generation`, written to the row as a pin writes one. */
async function leaseWrite(w: World, generation: number): Promise<void> {
  const row = await rowOf(w);
  await w.registry.compareAndSwap(SEG, row.token, {
    leases: [{ holder: '00000000000000aa', generation, until: Date.now() + 3_600_000 }],
  });
}

describe('a rollback whose swap gets no answer', () => {
  it('reads the row, and puts the pointer back when the swap landed and its target was collected meanwhile', async () => {
    const w = world();
    await loads(w, 3);
    const before = await rowOf(w);
    const registry = noAnswer(w.registry, {
      meanwhile: () => w.storage.delete({ ...SEG, generation: 0 }),
    });

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toThrow(
      /generation 0 of "s" was collected while the pointer was moving — the pointer was put back/,
    );

    const row = await rowOf(w);
    expect(row.currentGen).toBe(2);
    expect(row.summary).toEqual(before.summary);
    expect(await present(w)).toEqual([1, 2]);
  });

  it('reports and audits the move when the swap landed and its target is there', async () => {
    const w = world();
    await loads(w, 3);
    const audit = new RecordingAuditSink();

    const r = await rollbackSegment(
      SEG,
      0,
      { ...w.deps, registry: noAnswer(w.registry) },
      { audit },
    );

    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    const row = await rowOf(w);
    expect(row.currentGen).toBe(0);
    expect(row.summary).toMatchObject({ generation: 0, cardinality: 1 });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.rollback',
        namespace: 'ns',
        segment: 's',
        incarnation: incarnationOf(row.token),
        fromGeneration: 2,
        generation: 0,
      },
    ]);
  });

  it('takes a lease written after the swap landed for no other writer, and puts the pointer back against that row', async () => {
    const w = world();
    await loads(w, 3);
    const calls: Record<string, number> = {};
    const registry = counting<IRegistryDriver>(
      noAnswer(w.registry, {
        meanwhile: async () => {
          await leaseWrite(w, 0); // a reader pinned the target the moment it became current
          await w.storage.delete({ ...SEG, generation: 0 });
        },
      }),
      calls,
    );

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toThrow(
      /was collected while the pointer was moving — the pointer was put back/,
    );
    const row = await rowOf(w);
    expect(row.currentGen).toBe(2);
    expect(row.leases).toHaveLength(1);
    // The swap, and one undo fenced on the row read back, lease and all: not a first undo lost to a stale token.
    expect(calls.compareAndSwap).toBe(2);
  });

  it('puts the pointer back through a second lease written while it undoes, the row still the one its swap wrote', async () => {
    const w = world();
    await loads(w, 3);
    let swaps = 0;
    const racing = new Proxy(
      noAnswer(w.registry, {
        meanwhile: async () => {
          await leaseWrite(w, 0);
          await w.storage.delete({ ...SEG, generation: 0 });
        },
      }),
      {
        get(t, p, rx) {
          const value: unknown = Reflect.get(t, p, rx);
          if (p !== 'compareAndSwap') return value;
          return async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
            if (++swaps === 2) await leaseWrite(w, 0); // another reader, just before the undo lands
            return (value as IRegistryDriver['compareAndSwap'])(...args);
          };
        },
      },
    );

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry: racing })).rejects.toThrow(
      /was collected while the pointer was moving — the pointer was put back/,
    );
    expect((await rowOf(w)).currentGen).toBe(2);
  });

  it('settles an above-pointer target too, and holds it to the object it read', async () => {
    const w = world();
    await loads(w, 3);
    await rollbackSegment(SEG, 0, w.deps);
    const audit = new RecordingAuditSink();
    const r = await rollbackSegment(
      SEG,
      2,
      { ...w.deps, registry: noAnswer(w.registry) },
      { allowForward: true, audit },
    );
    expect(r).toEqual({ fromGeneration: 0, generation: 2 });
    expect((await rowOf(w)).currentGen).toBe(2);
    expect(audit.snapshot()).toHaveLength(1);
  });

  it('throws the TransientError, and moves nothing, when the swap did not land', async () => {
    const w = world();
    await loads(w, 3);
    const before = await rowOf(w);
    const audit = new RecordingAuditSink();
    await expect(
      rollbackSegment(
        SEG,
        0,
        { ...w.deps, registry: noAnswer(w.registry, { lands: false }) },
        { audit },
      ),
    ).rejects.toThrow(/the registry write got no answer/);
    expect((await rowOf(w)).token).toBe(before.token);
    expect(audit.snapshot()).toEqual([]);
  });

  it('throws the TransientError when another writer moved the row instead, and leaves its write', async () => {
    const w = world();
    await loads(w, 3);
    const registry = noAnswer(w.registry, {
      lands: false,
      meanwhile: () => loadSegment(SEG, [42], w.load, { keep: 9 }),
    });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect((await rowOf(w)).currentGen).toBe(3);
  });

  it('throws the TransientError when the row cannot be read back to settle it', async () => {
    const w = world();
    await loads(w, 3);
    const blind = readsFailAfterFirst(
      noAnswer(w.registry),
      new TransientError('the read was throttled'),
    );
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry: blind })).rejects.toThrow(
      /the registry write got no answer/,
    );
  });

  it('throws a row read back that is not one the library wrote as it is', async () => {
    const w = world();
    await loads(w, 3);
    const corrupt = new IntegrityError('registry record: not valid JSON');
    const registry = readsFailAfterFirst(noAnswer(w.registry), corrupt);
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toBe(corrupt);
  });

  it('throws the TransientError when the row names the target by another write that changed more than leases', async () => {
    // A retention write, then another operator's rollback onto the same target: not the row this swap would leave.
    const w = world();
    await loads(w, 3);
    const audit = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      lands: false,
      meanwhile: async () => {
        await setSegmentRetention(
          SEG,
          { registry: w.registry },
          { expiresAt: MIN_EXPIRES_AT_MS * 4 },
        );
        await rollbackSegment(SEG, 0, { storage: w.storage, registry: w.registry });
      },
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit }),
    ).rejects.toBeInstanceOf(TransientError);
    expect((await rowOf(w)).currentGen).toBe(0);
    expect(audit.snapshot()).toEqual([]);
  });
});

/** `registry`, whose every row read after the first fails with `fault`. */
function readsFailAfterFirst(registry: IRegistryDriver, fault: Error): IRegistryDriver {
  let reads = 0;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return value;
      return (...args: Parameters<IRegistryDriver['get']>) =>
        ++reads > 1 ? Promise.reject(fault) : (value as IRegistryDriver['get'])(...args);
    },
  });
}

describe('a rollback above the pointer of an encrypted segment', () => {
  /**
   * Generations 0 and 1 of an encrypted segment, 1 current, and at 2 an object a first load sealed under a key of its
   * own and never published: what the loser of two concurrent first loads leaves, under a key no row holds.
   */
  async function foreignAbove(w: World): Promise<void> {
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 });
    await loadSegment(SEG, [4], w.load, { keep: 9 });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 2 }, [5], {
      registry: new MemoryRegistryDriver(),
      keystore: key(),
      publish: false,
    });
  }

  it('is refused with KeyUnavailableError when the store has no keystore, before any object is read', async () => {
    const w = world(key());
    await foreignAbove(w);
    const before = await rowOf(w);
    const calls: Record<string, number> = {};

    const err = await rollbackSegment(
      SEG,
      2,
      { storage: counting<IStorageDriver>(w.storage, calls), registry: w.registry },
      { allowForward: true },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect((err as Error).message).toMatch(
      /generation 2 of "s" is above the current pointer \(1\).*no key is at hand \(the store has no keystore\)/,
    );
    expect((await rowOf(w)).token).toBe(before.token);
    expect(calls.getTail ?? 0).toBe(0);
  });

  it('is refused the same way when the keystore cannot open the key, and says why', async () => {
    const failures: unknown[] = [
      new TransientError('key service answered 503'),
      timedOut(),
      new KeyUnavailableError('no held KEK'),
      new IntegrityError('a KEK that does not unwrap the key'),
    ];
    for (const failure of failures) {
      const real = key();
      const w = world(real);
      await foreignAbove(w);
      const before = await rowOf(w);
      const unreachable: IKeystore = {
        createDek: () => real.createDek(),
        openDek: () => Promise.reject(failure),
      };
      const err = await rollbackSegment(
        SEG,
        2,
        { ...w.deps, keystore: unreachable },
        { allowForward: true },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyUnavailableError);
      expect((err as Error).message).toContain(
        `the keystore could not open the segment's key: ${(failure as Error).name}`,
      );
      expect((await rowOf(w)).token).toBe(before.token);
    }
  });

  it('undoing a rollback needs the key too, and moves with it', async () => {
    const real = key();
    const w = world(real);
    await loadSegment(SEG, [1, 2, 3], w.load, { keep: 9 });
    await loadSegment(SEG, [4], w.load, { keep: 9 });
    await rollbackSegment(SEG, 0, { storage: w.storage, registry: w.registry }); // key-less, below: allowed

    await expect(
      rollbackSegment(SEG, 1, { storage: w.storage, registry: w.registry }, { allowForward: true }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    expect((await rowOf(w)).currentGen).toBe(0);

    await rollbackSegment(SEG, 1, w.deps, { allowForward: true });
    const row = await rowOf(w);
    expect(row.currentGen).toBe(1);
    expect(row.summary?.generation).toBe(1);
    expect(
      openSummary(await real.openDek(row.wrappedDeks!), SEG, row.summary as never),
    ).toMatchObject({
      cardinality: 1,
    });
  });

  it('with the key, an object sealed under another key is refused with IntegrityError', async () => {
    const w = world(key());
    await foreignAbove(w);
    await expect(rollbackSegment(SEG, 2, w.deps, { allowForward: true })).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect((await rowOf(w)).currentGen).toBe(1);
  });

  it('still asks for allowForward first, so a target above the pointer without it is a ValidationError', async () => {
    const w = world(key());
    await foreignAbove(w);
    await expect(
      rollbackSegment(SEG, 2, { storage: w.storage, registry: w.registry }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a cleartext segment needs no key to roll forward', async () => {
    const w = world();
    await loads(w, 2);
    await rollbackSegment(SEG, 0, w.deps);
    await rollbackSegment(SEG, 1, { ...w.deps, keystore: key() }, { allowForward: true });
    expect((await rowOf(w)).currentGen).toBe(1);
  });
});

describe('a keystore failure that is not a missing key', () => {
  it('is thrown, and nothing moves, below the pointer too', async () => {
    const faults = [
      new TypeError("Cannot read properties of undefined (reading 'decrypt')"),
      new Error('the adapter was given a malformed wrapping'),
    ];
    for (const fault of faults) {
      const real = key();
      const w = world(real);
      await loads(w, 2);
      const before = await rowOf(w);
      const broken: IKeystore = {
        createDek: () => real.createDek(),
        openDek: () => Promise.reject(fault),
      };
      await expect(rollbackSegment(SEG, 0, { ...w.deps, keystore: broken })).rejects.toBe(fault);
      expect((await rowOf(w)).token).toBe(before.token);
    }
  });
});
