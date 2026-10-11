import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import type { IKeystore } from '@/core/crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
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
 * segment's key has opened it. A keystore that fails for any reason but "no key at hand" is a fault, and is thrown, and
 * above the pointer a key service that did not answer in time is thrown as it is, to retry.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

function world(keystore?: IKeystore, registry: IRegistryDriver = new MemoryRegistryDriver()) {
  const storage = new MemoryStorageDriver();
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

  it('names the generations it finds in numeric order, whatever order the storage lists them in', async () => {
    const w = world();
    await loads(w, 12); // generation 11 is current
    for (const g of [3, 4, 5, 6, 7, 8, 9, 11]) await w.storage.delete({ ...SEG, generation: g });
    const reversed = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p === 'list') {
          return async function* (ref: SegmentRef) {
            const keys = [];
            for await (const k of t.list(ref)) keys.push(k);
            for (const k of keys.reverse()) yield k;
          };
        }
        return typeof value === 'function' ? value.bind(t) : value;
      },
    }) as IStorageDriver;
    // Generations 2 and 10 are left, and 10 sorts before 2 as text.
    await expect(
      rollbackSegment(SEG, 11, { storage: reversed, registry: w.registry }),
    ).rejects.toThrow(/is current, but its object is not in the bucket — present: 2, 10$/);
  });
});

type Swap = IRegistryDriver['compareAndSwap'];

/**
 * `registry` with its `n`-th compare-and-swap (counting from 1) wrapped: `before` runs first; then, unless `fail` is set
 * and `lands` is not, the real write is made and `after` runs; then `fail`, when set, is thrown in place of the answer.
 */
function onSwap(
  registry: IRegistryDriver,
  n: number,
  step: {
    before?: () => Promise<unknown>;
    after?: () => Promise<unknown>;
    fail?: unknown;
    lands?: boolean;
  },
): IRegistryDriver {
  let calls = 0;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'compareAndSwap') return typeof value === 'function' ? value.bind(t) : value;
      return async (...args: Parameters<Swap>) => {
        if (++calls !== n) return (value as Swap).apply(t, args);
        await step.before?.();
        if (step.fail !== undefined && step.lands !== true) throw step.fail;
        const out = await (value as Swap).apply(t, args);
        await step.after?.();
        if (step.fail !== undefined) throw step.fail;
        return out;
      };
    },
  });
}

const unanswered = (): TransientError => new TransientError('the registry write got no answer');

/**
 * `registry`, whose first compare-and-swap lands and then throws `TransientError`, as a write does whose response is lost
 * on the way back; `meanwhile` runs between the two. With `lands: false` the registry refuses or never gets the write,
 * and `meanwhile` runs before the error.
 */
function noAnswer(
  registry: IRegistryDriver,
  {
    lands = true,
    meanwhile = async () => {},
  }: { lands?: boolean; meanwhile?: () => Promise<unknown> } = {},
): IRegistryDriver {
  return lands
    ? onSwap(registry, 1, { fail: unanswered(), lands: true, after: meanwhile })
    : onSwap(registry, 1, { fail: unanswered(), before: meanwhile });
}

/** A write that names a field a read resolves through, at the value it has: it renews the row's pointerId alone. */
async function renewal(w: World): Promise<void> {
  await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { status: 'active' });
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
    const audit = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      meanwhile: () => w.storage.delete({ ...SEG, generation: 0 }),
    });

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit })).rejects.toThrow(
      /generation 0 of "s" was collected while the pointer was moving — the pointer was put back/,
    );

    const row = await rowOf(w);
    expect(row.currentGen).toBe(2);
    expect(row.summary).toEqual(before.summary);
    expect(await present(w)).toEqual([1, 2]);
    expect(audit.snapshot()).toEqual([]); // the move did not stand, so nothing records it
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
    const audit = new RecordingAuditSink();
    const registry = counting<IRegistryDriver>(
      noAnswer(w.registry, {
        meanwhile: async () => {
          await leaseWrite(w, 0); // a reader pinned the target the moment it became current
          await w.storage.delete({ ...SEG, generation: 0 });
        },
      }),
      calls,
    );

    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit })).rejects.toThrow(
      /was collected while the pointer was moving — the pointer was put back/,
    );
    const row = await rowOf(w);
    expect(row.currentGen).toBe(2);
    expect(row.leases).toHaveLength(1);
    expect(audit.snapshot()).toEqual([]);
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

  it('does not take the pointer back from a renewal made between the read back and the undo', async () => {
    // Once the row read back is taken for the swap's, the undo is fenced on it: a write that renews the pointerId after
    // that read is another writer's, so the undo is not sent again over it, as for a swap that got its answer.
    const w = world();
    await loads(w, 3);
    const registry = onSwap(
      onSwap(w.registry, 1, {
        fail: unanswered(),
        lands: true,
        after: () => w.storage.delete({ ...SEG, generation: 0 }),
      }),
      2,
      { before: () => renewal(w) },
    );
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toThrow(
      /the move back failed, so the pointer may still name 0/,
    );
    expect((await rowOf(w)).currentGen).toBe(0);
  });
});

describe("a swap with no answer is not taken for another writer's publish of the same number", () => {
  // An operator moves the pointer onto a generation above it. Meanwhile an erasure deletes that object, a holder above
  // the pointer, and a load takes its number and publishes it; this call's swap, refused, loses its answer. The row then
  // names the target, but it is the load's, and the load's publish must stand.

  /** The race, with the load writing `ids` under the target's number 5; what the rollback threw, if it threw. */
  async function racedByALoad(w: World, ids: number[]): Promise<unknown> {
    const audit = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      lands: false,
      meanwhile: async () => {
        await w.storage.delete({ ...SEG, generation: 5 });
        const r = await loadSegment(SEG, ids, w.load, { keep: 9 });
        expect(r).toMatchObject({ published: true, generation: 5 });
      },
    });
    let err: unknown;
    try {
      await rollbackSegment(SEG, 5, { ...w.deps, registry }, { allowForward: true, audit });
    } catch (e) {
      err = e;
    }
    expect((await rowOf(w)).currentGen).toBe(5);
    expect(audit.snapshot()).toHaveLength(err === undefined ? 1 : 0);
    return err;
  }

  it('when the load wrote another object, which its summary tells apart', async () => {
    const w = world();
    await loads(w, 6);
    await rollbackSegment(SEG, 4, w.deps); // generation 5 is above the pointer
    expect(await racedByALoad(w, [42, 43])).toBeInstanceOf(TransientError);
    expect((await rowOf(w)).summary).toMatchObject({ generation: 5, cardinality: 2 });
  });

  it('on an encrypted segment, whose sealed summary no other write reproduces, even of the same object', async () => {
    const w = world(key());
    await loads(w, 6); // generation 5 holds [6]
    await rollbackSegment(SEG, 4, w.deps);
    expect(await racedByALoad(w, [6])).toBeInstanceOf(TransientError);
  });

  it('when the row records a kept window, which the swap drops and the load writes, though the object is the same', async () => {
    // A row with a window: the target above it is an object a load wrote and never published, and the load that takes
    // its number writes it byte for byte again, so the two summaries read the same and only the window differs.
    const w = world();
    await loads(w, 5); // generation 4 is current, and the row records its window
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 5 }, [6], {
      registry: w.registry,
      publish: false,
    });
    const err = await racedByALoad(w, [6]);
    expect(err).toBeInstanceOf(TransientError);
    expect((await rowOf(w)).keptGens).toBeDefined();
  });

  it('is the stated limit when the load writes the same object onto a row with no window: it reads as the swap', async () => {
    // After a rollback the row records no window, and the load that takes the number records none either, so a load
    // that writes the very object the rollback read leaves the very row the swap would. The pointer is where the
    // rollback asked for it, on that object, and the rollback reports and audits the move as its own.
    const w = world();
    await loads(w, 6); // generation 5 holds [6]
    const original = (await rowOf(w)).summary;
    await rollbackSegment(SEG, 4, w.deps);
    expect(await racedByALoad(w, [6])).toBeUndefined();
    expect((await rowOf(w)).summary).toEqual(original);
  });
});

describe('a swap with no answer is taken for this call only from the row the swap would leave', () => {
  const after: [string, (w: World) => Promise<unknown>][] = [
    [
      'a retention write',
      (w) =>
        setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: MIN_EXPIRES_AT_MS * 4 }),
    ],
    [
      'a residency write',
      async (w) => w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { residency: { r: 1 } }),
    ],
    [
      'a status write',
      async (w) => w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { status: 'destroyed' }),
    ],
  ];
  for (const [name, write] of after) {
    it(`throws the TransientError when ${name} follows the landed swap`, async () => {
      const w = world();
      await loads(w, 3);
      const audit = new RecordingAuditSink();
      const registry = noAnswer(w.registry, { meanwhile: () => write(w) });
      await expect(
        rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit }),
      ).rejects.toBeInstanceOf(TransientError);
      expect((await rowOf(w)).currentGen).toBe(0);
      expect(audit.snapshot()).toEqual([]);
    });
  }

  it('throws the TransientError when the row carries other wrapped keys after the swap landed', async () => {
    const w = world(key());
    await loads(w, 3);
    const registry = noAnswer(w.registry, {
      meanwhile: async () => {
        const row = await rowOf(w);
        const deks = row.wrappedDeks!;
        await w.registry.compareAndSwap(SEG, row.token, { wrappedDeks: [...deks, ...deks] });
      },
    });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('throws the TransientError when the swap did not land on a row with no summary, by a rollback that writes none', async () => {
    // A key-less rollback of an encrypted segment writes no summary, and the row it read had none, so only the pointer
    // says the swap did not land.
    const w = world(key());
    await loads(w, 3);
    const keyless = { storage: w.storage, registry: w.registry };
    await rollbackSegment(SEG, 1, keyless); // leaves the row with no summary
    const audit = new RecordingAuditSink();
    await expect(
      rollbackSegment(
        SEG,
        0,
        { ...keyless, registry: noAnswer(w.registry, { lands: false }) },
        { audit },
      ),
    ).rejects.toBeInstanceOf(TransientError);
    expect((await rowOf(w)).currentGen).toBe(1);
    expect(audit.snapshot()).toEqual([]);
  });

  it('throws the TransientError when the row was deleted after the swap landed', async () => {
    const w = world();
    await loads(w, 3);
    const registry = noAnswer(w.registry, { meanwhile: () => w.registry.delete(SEG) });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('throws the TransientError when the row is another incarnation that reads the same', async () => {
    // A purge and re-create after the swap landed, under a clock that gives the new row the old one's createdAt, with
    // the pointer and the summary the swap wrote: only the incarnation tells the rows apart.
    const w = world(undefined, new MemoryRegistryDriver({ now: () => 1_000 }));
    await loads(w, 3);
    const audit = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      meanwhile: async () => {
        const swapped = await rowOf(w);
        await w.registry.delete(SEG);
        await w.registry.create(SEG, { currentGen: 0, summary: swapped.summary });
      },
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(audit.snapshot()).toEqual([]);
  });

  it('takes another rollback that made the same move from the same row for its own, and each call audits it', async () => {
    // The stated limit: a cleartext rollback onto the same target from the same row leaves the very row this swap would
    // (the same pointer, the same summary of the same object), so the two cannot be told apart. The pointer is where
    // both asked for it, and the one move is recorded by both calls.
    const w = world();
    await loads(w, 3);
    const ours = new RecordingAuditSink();
    const theirs = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      lands: false,
      meanwhile: () =>
        rollbackSegment(SEG, 0, { storage: w.storage, registry: w.registry }, { audit: theirs }),
    });
    const r = await rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit: ours });
    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    expect(ours.snapshot()).toHaveLength(1);
    expect(theirs.snapshot()).toHaveLength(1);
  });

  it('tells another rollback that made the same move apart by its sealed summary, on an encrypted segment', async () => {
    const w = world(key());
    await loads(w, 3);
    const ours = new RecordingAuditSink();
    const theirs = new RecordingAuditSink();
    const registry = noAnswer(w.registry, {
      lands: false,
      meanwhile: () => rollbackSegment(SEG, 0, w.deps, { audit: theirs }),
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit: ours }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(ours.snapshot()).toEqual([]);
    expect(theirs.snapshot()).toHaveLength(1);
  });
});

describe('a swap that loses a race is not a swap with no answer', () => {
  it('throws a fault that is neither a conflict nor transient as it is, though the swap landed', async () => {
    const w = world();
    await loads(w, 3);
    const audit = new RecordingAuditSink();
    const boom = new TypeError('the driver broke after writing');
    const registry = onSwap(w.registry, 1, { fail: boom, lands: true });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit })).rejects.toBe(boom);
    expect(audit.snapshot()).toEqual([]);
  });

  it('throws the WriteConflictError when another rollback onto the same target won, and audits nothing', async () => {
    const w = world();
    await loads(w, 3);
    const audit = new RecordingAuditSink();
    const registry = onSwap(w.registry, 1, {
      before: () => rollbackSegment(SEG, 0, { storage: w.storage, registry: w.registry }),
    });
    await expect(
      rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(audit.snapshot()).toEqual([]);
  });
});

describe('the undo of a rollback whose target was collected meanwhile', () => {
  const collected = (w: World) => () => w.storage.delete({ ...SEG, generation: 0 });

  it('audits nothing, as the move did not stand', async () => {
    const w = world();
    await loads(w, 3);
    const audit = new RecordingAuditSink();
    const registry = onSwap(w.registry, 1, { after: collected(w) });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry }, { audit })).rejects.toThrow(
      /was collected while the pointer was moving — the pointer was put back/,
    );
    expect(audit.snapshot()).toEqual([]);
    expect((await rowOf(w)).currentGen).toBe(2);
  });

  it('is not sent again over a row another writer renewed the pointer of, and says the move back failed', async () => {
    // The first call is the swap, the second the undo.
    const w = world();
    await loads(w, 3);
    const registry = onSwap(onSwap(w.registry, 1, { after: collected(w) }), 2, {
      before: () => renewal(w),
    });
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry })).rejects.toThrow(
      /the move back failed, so the pointer may still name 0/,
    );
    expect((await rowOf(w)).currentGen).toBe(0);
  });

  it('is not sent again after an error that is not a lost race, and says the move back failed', async () => {
    const w = world();
    await loads(w, 3);
    const registry = onSwap(onSwap(w.registry, 1, { after: collected(w) }), 2, {
      fail: new TransientError('the response was lost'),
    });
    const err = await rollbackSegment(SEG, 0, { ...w.deps, registry }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/the move back failed, so the pointer may still name 0/);
    expect((await rowOf(w)).currentGen).toBe(0);
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

  /** The rollback onto the foreign object at 2, with a keystore whose `openDek` rejects with `failure`. */
  async function withFailingKeystore(failure: unknown): Promise<{ err: unknown; moved: boolean }> {
    const real = key();
    const w = world(real);
    await foreignAbove(w);
    const before = await rowOf(w);
    const calls: Record<string, number> = {};
    const failing: IKeystore = {
      createDek: () => real.createDek(),
      openDek: () => Promise.reject(failure),
    };
    const err = await rollbackSegment(
      SEG,
      2,
      {
        storage: counting<IStorageDriver>(w.storage, calls),
        registry: w.registry,
        keystore: failing,
      },
      { allowForward: true },
    ).catch((e: unknown) => e);
    expect(calls.getTail ?? 0).toBe(0);
    return { err, moved: (await rowOf(w)).token !== before.token };
  }

  it('is refused the same way when the keystore cannot open the key, and says why', async () => {
    const cases: [unknown, string][] = [
      [
        new KeyUnavailableError('no held KEK'),
        'it holds none of the KEKs the key is wrapped under',
      ],
      [
        new IntegrityError('a KEK that does not unwrap the key'),
        'a KEK it holds does not unwrap the key',
      ],
    ];
    for (const [failure, why] of cases) {
      const { err, moved } = await withFailingKeystore(failure);
      expect(err).toBeInstanceOf(KeyUnavailableError);
      expect((err as Error).message).toContain(
        `the keystore could not open the segment's key: ${why}`,
      );
      expect(moved).toBe(false);
    }
  });

  it('throws a key service that did not answer in time as it is, to retry, and moves nothing', async () => {
    // Not KeyUnavailableError, which says to restore a KEK and not to retry: the same call can succeed a moment later.
    for (const failure of [new TransientError('key service answered 503'), timedOut()]) {
      const { err, moved } = await withFailingKeystore(failure);
      expect(err).toBe(failure);
      expect(moved).toBe(false);
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

describe('what counts as no key at hand, below the pointer', () => {
  /** What a rollback below the pointer throws when the keystore's `openDek` rejects with `fault`, and that it moved nothing. */
  async function below(fault: unknown): Promise<unknown> {
    const real = key();
    const w = world(real);
    await loads(w, 2);
    const broken: IKeystore = {
      createDek: () => real.createDek(),
      openDek: () => Promise.reject(fault),
    };
    let caught: unknown = 'it resolved';
    try {
      await rollbackSegment(SEG, 0, { ...w.deps, keystore: broken });
    } catch (e) {
      caught = e;
    }
    expect((await rowOf(w)).currentGen).toBe(1);
    return caught;
  }
  const named = (name: string): Error =>
    Object.assign(new Error('the key service failed'), { name });

  it('is a timeout only by an error named exactly TimeoutError: a look-alike name, or a plain abort, is a fault', async () => {
    for (const name of [
      'timeouterror',
      'TIMEOUTERROR',
      'TimeoutExceeded',
      'TimeoutErrorX',
      'MyTimeoutError',
      'AbortError',
    ]) {
      const fault = named(name);
      expect(await below(fault)).toBe(fault);
    }
  });

  it('is a timeout only from an Error, not from any object that carries the name', async () => {
    const fault = { name: 'TimeoutError', message: 'a plain object' };
    expect(await below(fault)).toBe(fault);
  });

  it('is never judged by a message', async () => {
    const fault = new Error('TimeoutError: the request timed out');
    expect(await below(fault)).toBe(fault);
  });

  it('rethrows a rejection that is not an object, as it is', async () => {
    for (const fault of [undefined, null, 'TimeoutError']) expect(await below(fault)).toBe(fault);
  });
});
