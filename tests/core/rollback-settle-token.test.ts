import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingAuditSink } from '@/core/audit';
import { NotFoundError, TransientError, WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { setSegmentRetention, MIN_EXPIRES_AT_MS } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { storeCodec } from '../helpers/store-codec';
import { CloudRoaring, MemoryStorage } from '@/index';
import { testEntropy } from '../helpers/entropy';
import { withoutTokenReports } from '../helpers/no-token-reports';

/**
 * A rollback settles a swap that met a conflict, or got no answer, by the write token it sent, as a load's publish
 * does: the swap is its own when the row's pointer is over a token the call sent, whatever else has been written to the
 * row since, and another writer's write of the same pointer is not. A registry that reports no tokens keeps the
 * row-shape rule.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const CONFLICT_MESSAGE =
  "rollback: the segment's row changed while the rollback ran, and this rollback could not confirm that its swap is " +
  'the one the row shows; check store.generations(ref) and run it again';
const RETENTION = { expiresAt: MIN_EXPIRES_AT_MS * 4 };

function world(registry: IRegistryDriver = new MemoryRegistryDriver()) {
  const storage = new MemoryStorageDriver();
  const load = { storage, registry, entropy: testEntropy, codec: storeCodec };
  return { storage, registry, load, deps: { storage, registry } };
}
type World = ReturnType<typeof world>;

/** `n` one-id generations, every one kept: generation `n - 1` is current. */
async function loads(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await loadSegment(SEG, [i + 1], w.load, { keep: 9 });
}

const rowOf = async (w: World): Promise<RegistryRecord> => (await w.registry.get(SEG))!;
const retain = (w: World): Promise<unknown> =>
  setSegmentRetention(SEG, { registry: w.registry }, RETENTION);

async function present(w: World): Promise<number[]> {
  const out: number[] = [];
  for await (const k of w.storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

type Swap = IRegistryDriver['compareAndSwap'];

/**
 * `registry` with its `n`-th compare-and-swap whose patch names `currentGen: gen` wrapped: `before` runs first; unless
 * `lands` is false, the real write is made with the options it was given and `after` runs; then `fail` is thrown in
 * place of the answer. It inherits the flag from `registry`.
 */
function onSwap(
  registry: IRegistryDriver,
  gen: number,
  step: {
    before?: () => Promise<unknown>;
    after?: () => Promise<unknown>;
    fail: unknown;
    lands?: boolean;
    nth?: number;
  },
): IRegistryDriver {
  const out = Object.create(registry) as IRegistryDriver;
  let seen = 0;
  out.compareAndSwap = async (...args: Parameters<Swap>) => {
    if ('currentGen' in args[2] && args[2].currentGen === gen && ++seen === (step.nth ?? 1)) {
      await step.before?.();
      if (step.lands !== false) {
        await registry.compareAndSwap(...args);
        await step.after?.();
      }
      throw step.fail;
    }
    return registry.compareAndSwap(...args);
  };
  return out;
}

const conflict = (): WriteConflictError => new WriteConflictError('a replay met another writer');
const noAnswer = (): TransientError => new TransientError('the registry write got no answer');

/** A rollback to 0 whose swap lands, `after` runs, and the swap then answers `fail`. */
async function rolled(
  w: World,
  fail: unknown,
  after: (w: World) => Promise<unknown>,
  registry: IRegistryDriver = w.registry,
) {
  const audit = new RecordingAuditSink();
  const wrapped = onSwap(registry, 0, { fail, after: () => after(w) });
  const result = await rollbackSegment(SEG, 0, { ...w.deps, registry: wrapped }, { audit }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { ...result, audit };
}

const renewal = async (w: World): Promise<void> => {
  await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { status: 'active' });
};
const leaseWrite = async (w: World): Promise<void> => {
  await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, {
    leases: [{ holder: '00000000000000aa', generation: 0, until: Date.now() + 3_600_000 }],
  });
};

describe('a rollback whose swap landed and came back as a conflict', () => {
  it('through the store: the move is reported, audited once, and a re-run is a no-op with no second event', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    const ref = { segment: 's', namespace: 'n' };
    await store.load(ref, [1, 2, 3]);
    await store.load(ref, [4, 5]);
    const reg = backend.registry as unknown as { compareAndSwap: Swap };
    const original = reg.compareAndSwap.bind(reg);
    let armed = true;
    reg.compareAndSwap = async (r, expected, patch, opts) => {
      const res = await original(r, expected, patch, opts);
      if (armed && patch.currentGen === 0) {
        armed = false;
        // Another writer lands over the swap before the conflict reaches the caller.
        await store.setRetention(ref, { expiresAt: Date.now() + 86_400_000 });
        throw new WriteConflictError('registry OCC conflict');
      }
      return res;
    };
    const audit = new RecordingAuditSink();
    expect(await store.rollback(ref, 0, { audit })).toEqual({ fromGeneration: 1, generation: 0 });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.rollback']);
    expect(await store.rollback(ref, 0, { audit })).toEqual({ fromGeneration: 0, generation: 0 });
    expect(audit.snapshot()).toHaveLength(1);
  });

  it('is settled when only a lease overtook it', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, conflict(), leaseWrite);
    expect(r).toMatchObject({ value: { fromGeneration: 2, generation: 0 } });
    expect(r.audit.snapshot()).toHaveLength(1);
    expect((await rowOf(w)).currentGen).toBe(0);
  });

  it('is settled when a retention write overtook it, and checks the target after: a collected one is put back', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, conflict(), async (x) => {
      await retain(x);
      await x.storage.delete({ ...SEG, generation: 0 });
    });
    expect(r).toMatchObject({ error: expect.any(NotFoundError) });
    expect((r as { error: Error }).error.message).toMatch(
      /was collected while the pointer was moving/,
    );
    expect((r as { error: Error }).error.message).toMatch(/the pointer was put back/);
    expect(r.audit.snapshot()).toEqual([]);
    expect((await rowOf(w)).currentGen).toBe(2);
  });

  it('is settled, audited once, and a re-run is a no-op, when the check after it then fails to read the target', async () => {
    const w = world();
    await loads(w, 3);
    let failing = false;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        if (p !== 'getTail') return value.bind(t);
        return (...a: unknown[]) =>
          failing ? Promise.reject(new TransientError('storage throttled')) : value.apply(t, a);
      },
    }) as IStorageDriver;
    const audit = new RecordingAuditSink();
    const registry = onSwap(w.registry, 0, {
      fail: conflict(),
      after: async () => {
        await retain(w);
        failing = true;
      },
    });
    await expect(
      rollbackSegment(SEG, 0, { storage: flaky, registry }, { audit }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(audit.snapshot()).toHaveLength(1);
    failing = false;
    await expect(rollbackSegment(SEG, 0, w.deps, { audit })).resolves.toEqual({
      fromGeneration: 0,
      generation: 0,
    });
    expect(audit.snapshot()).toHaveLength(1);
  });

  it('is not settled when a load moved the pointer on: the new message, no event, nothing deleted', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, conflict(), async (x) => {
      await loadSegment(SEG, [90], x.load, { keep: 9 });
    });
    expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
    expect((r as { error: Error }).error.message).toBe(CONFLICT_MESSAGE);
    expect(r.audit.snapshot()).toEqual([]);
    expect((await rowOf(w)).currentGen).toBe(3);
    expect(await present(w)).toEqual([0, 1, 2, 3]);
  });

  it('is not settled when a write renewed the pointer over it: the stated limit, no event', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, conflict(), renewal);
    expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
    expect((r as { error: Error }).error.message).toBe(CONFLICT_MESSAGE);
    expect(r.audit.snapshot()).toEqual([]);
    expect(await present(w)).toEqual([0, 1, 2]);
  });

  it('is not settled when the swap never landed and a load published the very number: a conflict, no event', async () => {
    const w = world();
    await loads(w, 6);
    await rollbackSegment(SEG, 4, w.deps); // generation 5 is above the pointer
    const audit = new RecordingAuditSink();
    const registry = onSwap(w.registry, 5, {
      fail: conflict(),
      lands: false,
      before: async () => {
        await w.storage.delete({ ...SEG, generation: 5 });
        const r = await loadSegment(SEG, [77], w.load, { keep: 9 });
        expect(r).toMatchObject({ published: true, generation: 5 });
      },
    });
    const err = await rollbackSegment(
      SEG,
      5,
      { ...w.deps, registry },
      { allowUnknown: true, audit },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toBe(CONFLICT_MESSAGE);
    expect((await rowOf(w)).currentGen).toBe(5);
    expect(audit.snapshot()).toEqual([]);
  });

  it('is settled when its first send met only a lease and its resend landed, the resend having a token of its own', async () => {
    const w = world();
    await loads(w, 3);
    const tokens: string[] = [];
    const out = Object.create(w.registry) as IRegistryDriver;
    let sends = 0;
    out.compareAndSwap = async (ref, expected, patch, options) => {
      const nth = ++sends;
      const seenOptions = { onToken: (t: string) => (tokens.push(t), options?.onToken?.(t)) };
      if (nth === 1) {
        seenOptions.onToken('first-send-token-never-written');
        await leaseWrite(w);
        throw conflict();
      }
      await w.registry.compareAndSwap(ref, expected, patch, seenOptions);
      await retain(w);
      throw conflict();
    };
    const audit = new RecordingAuditSink();
    const clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
    const r = await rollbackSegment(SEG, 0, { ...w.deps, registry: out, clock }, { audit });
    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    expect(sends).toBe(2);
    expect(tokens).toHaveLength(2);
    expect(audit.snapshot()).toHaveLength(1);
  });
});

describe('a rollback whose registry resent its swap', () => {
  it('recognises the first attempt that landed after the registry reported a token for a resend', async () => {
    // A registry that sends a write again reports each attempt's token before it sends: the attempt that lands may be
    // the first, so every token reported is kept, not only the last.
    const w = world();
    await loads(w, 3);
    const out = Object.create(w.registry) as IRegistryDriver;
    out.compareAndSwap = async (ref, expected, patch, options) => {
      const resend = (token: string): void => {
        options?.onToken?.(token);
        options?.onToken?.('token-of-a-resend-that-never-landed');
      };
      await w.registry.compareAndSwap(ref, expected, patch, { onToken: resend });
      await retain(w);
      throw conflict();
    };
    const audit = new RecordingAuditSink();
    const r = await rollbackSegment(SEG, 0, { ...w.deps, registry: out }, { audit });
    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    expect(audit.snapshot()).toHaveLength(1);
  });

  it('recognises it after no answer too', async () => {
    const w = world();
    await loads(w, 3);
    const out = Object.create(w.registry) as IRegistryDriver;
    out.compareAndSwap = async (ref, expected, patch, options) => {
      await w.registry.compareAndSwap(ref, expected, patch, {
        onToken: (token) => {
          options?.onToken?.(token);
          options?.onToken?.('token-of-a-resend-that-never-landed');
        },
      });
      await retain(w);
      throw noAnswer();
    };
    const audit = new RecordingAuditSink();
    await expect(rollbackSegment(SEG, 0, { ...w.deps, registry: out }, { audit })).resolves.toEqual(
      { fromGeneration: 2, generation: 0 },
    );
    expect(audit.snapshot()).toHaveLength(1);
  });
});

describe('a rollback whose swap got no answer, settled by the token', () => {
  it('is not settled when a renewal followed the landing: it reads as that of another writer, and nothing is audited', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), renewal);
    expect((r as { error: Error }).error).toBeInstanceOf(TransientError);
    expect(r.audit.snapshot()).toEqual([]);
    expect((await rowOf(w)).currentGen).toBe(0);
  });

  it('is settled, with one event, when a lease followed the landing', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), leaseWrite);
    expect(r).toMatchObject({ value: { fromGeneration: 2, generation: 0 } });
    expect(r.audit.snapshot()).toHaveLength(1);
  });

  it('is not settled when a load moved the pointer on: the TransientError, no event, nothing deleted', async () => {
    const w = world();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), async (x) => {
      await loadSegment(SEG, [90], x.load, { keep: 9 });
    });
    expect((r as { error: Error }).error).toBeInstanceOf(TransientError);
    expect(r.audit.snapshot()).toEqual([]);
    expect(await present(w)).toEqual([0, 1, 2, 3]);
  });
});

describe('a rollback over a registry that reports no write tokens', () => {
  const tokenless = () => world(withoutTokenReports(new MemoryRegistryDriver()));

  it('does not report write tokens', () => {
    expect(tokenless().registry.reportsWriteTokens).toBe(false);
  });

  it('takes the row the swap would leave for its own after no answer, a lease having followed it', async () => {
    const w = tokenless();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), leaseWrite);
    expect(r).toMatchObject({ value: { fromGeneration: 2, generation: 0 } });
    expect(r.audit.snapshot()).toHaveLength(1);
  });

  it('throws the TransientError after no answer when a retention write changed the row (the row-shape rule)', async () => {
    const w = tokenless();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), retain);
    expect((r as { error: Error }).error).toBeInstanceOf(TransientError);
    expect(r.audit.snapshot()).toEqual([]);
  });

  it('throws the new conflict message after a conflict when only a lease followed the landed swap: a conflict is never settled as landed', async () => {
    const w = tokenless();
    await loads(w, 3);
    const r = await rolled(w, conflict(), leaseWrite);
    expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
    expect((r as { error: Error }).error.message).toBe(CONFLICT_MESSAGE);
    expect(r.audit.snapshot()).toEqual([]);
  });

  it('throws the new conflict message after a conflict when a retention write changed the row', async () => {
    const w = tokenless();
    await loads(w, 3);
    const r = await rolled(w, conflict(), retain);
    expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
    expect((r as { error: Error }).error.message).toBe(CONFLICT_MESSAGE);
    expect(r.audit.snapshot()).toEqual([]);
  });
});

describe('a rollback over a registry that leaves reportsWriteTokens unset', () => {
  /** A registry of someone else's that omits the flag and ignores the options of a write: it reports no tokens. */
  function unset(base: IRegistryDriver): IRegistryDriver {
    const out = Object.create(base) as IRegistryDriver;
    Object.defineProperty(out, 'reportsWriteTokens', { value: undefined });
    out.compareAndSwap = (ref, expected, patch) => base.compareAndSwap(ref, expected, patch);
    return out;
  }
  const flagless = () => world(unset(new MemoryRegistryDriver()));

  it('does not report write tokens', () => {
    expect(flagless().registry.reportsWriteTokens).toBeUndefined();
  });

  it('settles a landed swap that got no answer by the row shape, a lease having followed it', async () => {
    const w = flagless();
    await loads(w, 3);
    const r = await rolled(w, noAnswer(), leaseWrite);
    expect(r).toMatchObject({ value: { fromGeneration: 2, generation: 0 } });
    expect(r.audit.snapshot()).toHaveLength(1);
  });

  it('throws the new conflict message after a conflict, a lease having followed the landed swap', async () => {
    const w = flagless();
    await loads(w, 3);
    const r = await rolled(w, conflict(), leaseWrite);
    expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
    expect((r as { error: Error }).error.message).toBe(CONFLICT_MESSAGE);
    expect(r.audit.snapshot()).toEqual([]);
  });
});

describe('every registry that reports write tokens settles a rollback by its token', () => {
  class MapStore implements ObjectRegistryStore {
    readonly label = 'map';
    readonly conditionalDelete = true;
    private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
    private next = 1;
    /** Runs after the next write is applied and before it answers; `'conflict'` answers with a conflict. */
    afterWrite: (() => Promise<'conflict' | undefined>) | undefined;
    read(key: string): Promise<ObjectRow | null> {
      const f = this.objects.get(key);
      return Promise.resolve(
        f === undefined ? null : { bytes: f.bytes, version: String(f.version) },
      );
    }
    async write(key: string, body: Uint8Array, expect: 'absent' | { version: string }) {
      const f = this.objects.get(key);
      if (expect === 'absent' ? f !== undefined : String(f?.version) !== expect.version)
        throw new WriteConflictError(`lost: ${key}`);
      this.objects.set(key, { bytes: body, version: this.next++ });
      const hook = this.afterWrite;
      this.afterWrite = undefined;
      if ((await hook?.()) === 'conflict')
        throw new WriteConflictError(`replay met itself: ${key}`);
    }
    async *listKeys(prefix: string): AsyncIterable<string> {
      for (const k of [...this.objects.keys()].sort()) if (k.startsWith(prefix)) yield k;
    }
    async delete(key: string, expect: { version: string }): Promise<void> {
      if (String(this.objects.get(key)?.version) !== expect.version)
        throw new WriteConflictError(key);
      this.objects.delete(key);
    }
  }

  const makers: [
    string,
    () => Promise<{ registry: IRegistryDriver; done: () => Promise<void> }>,
  ][] = [
    ['memory', async () => ({ registry: new MemoryRegistryDriver(), done: async () => {} })],
    [
      'local files',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'crbm-settle-'));
        return {
          registry: new LocalFsRegistryDriver(dir),
          done: () => rm(dir, { recursive: true, force: true }),
        };
      },
    ],
    [
      'shared object store',
      async () => ({
        registry: new ObjectStoreRegistry(new MapStore(), 'p', () => 1_000),
        done: async () => {},
      }),
    ],
  ];

  describe.each(makers)('%s registry', (_name, make) => {
    let kit: Awaited<ReturnType<typeof make>>;
    beforeEach(async () => {
      kit = await make();
    });
    afterEach(() => kit.done());

    it.each([
      ['a conflict', conflict],
      ['no answer', noAnswer],
    ] as const)(
      'settles a landed swap overtaken by a retention write, after %s',
      async (_n, fail) => {
        const w = world(kit.registry);
        await loads(w, 3);
        const r = await rolled(w, fail(), retain);
        expect(r).toMatchObject({ value: { fromGeneration: 2, generation: 0 } });
        expect(r.audit.snapshot()).toHaveLength(1);
      },
    );

    it('does not settle a landed swap a load moved past', async () => {
      const w = world(kit.registry);
      await loads(w, 3);
      const r = await rolled(w, conflict(), async (x) => {
        await loadSegment(SEG, [90], x.load, { keep: 9 });
      });
      expect((r as { error: Error }).error).toBeInstanceOf(WriteConflictError);
      expect(r.audit.snapshot()).toEqual([]);
    });
  });

  it('a shared object store whose write applied and answered with a conflict, another writer on top, is settled', async () => {
    const store = new MapStore();
    const w = world(new ObjectStoreRegistry(store, 'p', () => 1_000));
    await loads(w, 3);
    store.afterWrite = async () => {
      await retain(w);
      return 'conflict';
    };
    const audit = new RecordingAuditSink();
    await expect(rollbackSegment(SEG, 0, w.deps, { audit })).resolves.toEqual({
      fromGeneration: 2,
      generation: 0,
    });
    expect(audit.snapshot()).toHaveLength(1);
    expect((await rowOf(w)).currentGen).toBe(0);
  });
});
