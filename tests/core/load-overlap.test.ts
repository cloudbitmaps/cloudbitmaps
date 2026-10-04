import { randomBytes } from 'node:crypto';
import { loadSegment, type LoadOptions } from '@/core/load';
import { destroySegment } from '@/core/erasure';
import { KeyUnavailableError, TransientError, ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/core/ports';
import type { WrappedDek } from '@/core/crypto';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';

/**
 * A load starts its existence check and its key unwrap while it encodes, joins them where the write needs them, and
 * asks the keystore for a segment's key once. These pin the requests a load makes (kinds, counts and the order the
 * fences rest on), that the check and the unwrap are in flight while the ids are consumed, and that a failure of
 * either, or of the encoding, fails the load as it always did, with nothing written and nothing left rejecting.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type Log = string[];
/** Delays (a promise to wait for) or fails (a rejected one) the named request; `undefined` lets it through. */
type Hook = (label: string, args: unknown[]) => Promise<void> | undefined;

/** `target`, with each call to the methods in `names` logged, and `hook` given the chance to hold or fail it. */
function logged<T extends object>(
  target: T,
  prefix: string,
  names: readonly string[],
  log: Log,
  hook?: Hook,
): T {
  return new Proxy(target, {
    get(t, p, rx) {
      const value = Reflect.get(t, p, rx) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (typeof p !== 'string' || !names.includes(p)) return fn.bind(t);
      return (...args: unknown[]) => {
        const label = p === 'getTail' && args[1] === 0 ? `${prefix}.check` : `${prefix}.${p}`;
        log.push(label);
        const held = hook?.(label, args);
        if (p === 'list') {
          // A listing is an async iterable: hold or fail it when it is first pulled.
          return (async function* () {
            await held;
            yield* fn.apply(t, args) as AsyncIterable<unknown>;
          })();
        }
        return held === undefined ? fn.apply(t, args) : held.then(() => fn.apply(t, args));
      };
    },
  });
}

/** The stores a segment lives in, which a load reaches through doubles that log, and a seed reaches directly. */
function world() {
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keys = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
  const log: Log = [];
  const direct = (encrypted: boolean) => ({
    storage: memory,
    registry,
    codec: roaringCodec,
    ...(encrypted ? { keystore: keys } : {}),
  });
  const through = (encrypted: boolean, storageHook?: Hook, keystoreHook?: Hook) => ({
    storage: logged(memory, 'storage', ['getTail', 'list', 'putImmutable'], log, storageHook),
    registry: logged(registry, 'registry', ['get', 'create', 'compareAndSwap'], log),
    codec: roaringCodec,
    ...(encrypted
      ? { keystore: logged(keys, 'keystore', ['openDek', 'createDek'], log, keystoreHook) }
      : {}),
  });
  const seed = async (encrypted: boolean) => {
    await loadSegment(SEG, [1, 2], direct(encrypted), { keep: 9 });
  };
  return { memory, registry, keys, log, through, seed };
}

/** `ids`, noting in `log` when they are first pulled and when they have all been consumed. */
function marked(ids: number[], log: Log, onFirst?: () => void): Iterable<number> {
  return {
    *[Symbol.iterator]() {
      log.push('ids:start');
      onFirst?.();
      yield* ids;
      log.push('ids:end');
    },
  };
}

const counts = (log: Log): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const l of log) if (!l.startsWith('ids:')) out[l] = (out[l] ?? 0) + 1;
  return out;
};

interface Shape {
  name: string;
  encrypted: boolean;
  existing: boolean;
  options: LoadOptions;
  /** The requests the load makes: the kinds and counts it made before the overlap, with one unwrap where there were two. */
  expected: Record<string, number>;
}

const WRITE = { 'storage.check': 1, 'storage.putImmutable': 1 };
const SHAPES: Shape[] = [
  {
    name: 'a new cleartext segment, guarded',
    encrypted: false,
    existing: false,
    options: {},
    expected: { ...WRITE, 'registry.get': 2, 'registry.create': 1 },
  },
  {
    name: 'an existing cleartext segment, guarded',
    encrypted: false,
    existing: true,
    options: {},
    expected: { ...WRITE, 'registry.get': 1, 'registry.compareAndSwap': 1 },
  },
  {
    name: 'an existing cleartext segment, allowEmpty',
    encrypted: false,
    existing: true,
    options: { allowEmpty: true },
    expected: { ...WRITE, 'registry.get': 1, 'registry.compareAndSwap': 1 },
  },
  {
    name: 'an existing cleartext segment, minRetained',
    encrypted: false,
    existing: true,
    options: { guard: { minRetained: 0.5 } },
    expected: { ...WRITE, 'registry.get': 1, 'registry.compareAndSwap': 1 },
  },
  {
    name: 'a new encrypted segment, guarded',
    encrypted: true,
    existing: false,
    options: {},
    expected: { ...WRITE, 'registry.get': 2, 'registry.create': 1, 'keystore.createDek': 1 },
  },
  {
    name: 'an existing encrypted segment, guarded',
    encrypted: true,
    existing: true,
    options: {},
    expected: {
      ...WRITE,
      'registry.get': 2,
      'registry.compareAndSwap': 1,
      'keystore.openDek': 1,
    },
  },
  {
    name: 'an existing encrypted segment, allowEmpty',
    encrypted: true,
    existing: true,
    options: { allowEmpty: true },
    expected: {
      ...WRITE,
      'registry.get': 2,
      'registry.compareAndSwap': 1,
      'keystore.openDek': 1,
    },
  },
];

async function runShape(shape: Shape) {
  const w = world();
  if (shape.existing) await w.seed(shape.encrypted);
  const result = await loadSegment(SEG, marked([1, 2, 3], w.log), w.through(shape.encrypted), {
    keep: 9,
    ...shape.options,
  });
  return { w, result };
}

describe('a load makes the requests it always made, with one keystore unwrap', () => {
  it.each(SHAPES)('$name', async (shape) => {
    const { w, result } = await runShape(shape);
    expect(result.published).toBe(true);
    expect(counts(w.log)).toEqual(shape.expected);
  });

  it.each(SHAPES)('$name: the fences keep their order', async (shape) => {
    const { w } = await runShape(shape);
    const at = (label: string) => w.log.indexOf(label);
    const gets = w.log.flatMap((l, i) => (l === 'registry.get' ? [i] : []));
    const publish = Math.max(at('registry.create'), at('registry.compareAndSwap'));
    // The row the guard judges is read first: before the ids are touched, and before anything is written.
    expect(gets[0]).toBe(0);
    expect(gets[0]).toBeLessThan(at('ids:start'));
    // The row a first load, or an encrypted segment, reads again comes after the ids and before the write.
    if (gets.length > 1) {
      expect(gets[1]).toBeGreaterThan(at('ids:end'));
      expect(gets[1]).toBeLessThan(at('storage.putImmutable'));
    }
    // The write comes after the ids, and the publish after the write.
    expect(at('ids:end')).toBeLessThan(at('storage.putImmutable'));
    expect(at('storage.putImmutable')).toBeLessThan(publish);
  });

  it('a pointer that moves while the ids stream still wins the publish: the load reports superseded', async () => {
    const w = world();
    await w.seed(false);
    // Another load publishes after this one read its row and before it writes.
    const ids = (async function* () {
      yield 1;
      await loadSegment(SEG, [9], w.through(false), { keep: 9 });
      yield 2;
    })();
    const loser = await loadSegment(SEG, ids, w.through(false), { keep: 9 });
    expect(loser).toMatchObject({ published: false, reason: 'superseded' });
  });
});

/** A promise released by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('the existence check and the unwrap are in flight while the ids are consumed', () => {
  it('an existing encrypted segment, allowEmpty: both are sent, and neither has answered, when the ids start', async () => {
    const w = world();
    await w.seed(true);
    const probe = gate();
    const unwrap = gate();
    const state: string[] = [];
    const deps = w.through(
      true,
      (label) =>
        label === 'storage.check' ? probe.promise.then(() => void state.push('probe')) : undefined,
      (label) =>
        label === 'keystore.openDek'
          ? unwrap.promise.then(() => void state.push('unwrap'))
          : undefined,
    );
    const atFirstId: string[] = [];
    const pending = loadSegment(
      SEG,
      marked([1, 2, 3], w.log, () => atFirstId.push(...w.log, ...state)),
      deps,
      { allowEmpty: true },
    );
    await vi.waitFor(() => expect(w.log).toContain('ids:end'));
    // The encoding ran to its end with both still out: the load is waiting for them, not they for it.
    expect(state).toEqual([]);
    probe.open();
    unwrap.open();
    expect((await pending).published).toBe(true);
    expect(atFirstId).toEqual(['registry.get', 'keystore.openDek', 'storage.check', 'ids:start']);
  });

  it('a new cleartext segment, guarded: the check is out while the ids are consumed', async () => {
    const w = world();
    const probe = gate();
    const state: string[] = [];
    const deps = w.through(false, (label) =>
      label === 'storage.check' ? probe.promise.then(() => void state.push('probe')) : undefined,
    );
    const pending = loadSegment(SEG, marked([1, 2, 3], w.log), deps);
    await vi.waitFor(() => expect(w.log).toContain('ids:end'));
    expect(state).toEqual([]);
    probe.open();
    expect((await pending).published).toBe(true);
  });
});

describe('the early key is used only for the row the write sees', () => {
  /** The keystore calls a load made, with the wrappings each unwrap was asked about. */
  const opens = (w: ReturnType<typeof world>, wrapped: Array<readonly WrappedDek[]>) =>
    w.through(true, undefined, (label, args) => {
      if (label === 'keystore.openDek') wrapped.push(args[0] as readonly WrappedDek[]);
      return undefined;
    });

  it('wrappings swapped between the two row reads: the write unwraps again, and the publish fences as before', async () => {
    const w = world();
    await w.seed(true);
    const asked: Array<readonly WrappedDek[]> = [];
    const deps = opens(w, asked);
    const first = (await w.registry.get(SEG))!.wrappedDeks!;
    const swapped = (await w.keys.createDek()).wrapped;
    const ids = (async function* () {
      yield 1;
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, { wrappedDeks: swapped });
      yield 2;
    })();
    const r = await loadSegment(SEG, ids, deps, { allowEmpty: true, keep: 9 });
    // One unwrap for the row the load first read, and a second for the row it wrote under.
    expect(asked).toEqual([first, swapped]);
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
  });

  it('a shred between the two row reads refuses the load: nothing is put', async () => {
    const w = world();
    await w.seed(true);
    const ids = (async function* () {
      yield 1;
      await destroySegment(SEG, { registry: w.registry }, { confirmSegment: SEG.segment });
      yield 2;
    })();
    await expect(
      loadSegment(SEG, ids, w.through(true), { allowEmpty: true, keep: 9 }),
    ).rejects.toThrow(/destroyed/);
    expect(w.log.filter((l) => l === 'storage.putImmutable')).toEqual([]);
  });

  it('a destroyed row never starts the unwrap', async () => {
    const w = world();
    await w.seed(true);
    // Destroyed, with its wrappings still on the row.
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { status: 'destroyed' });
    w.log.length = 0;
    await expect(
      loadSegment(SEG, marked([1], w.log), w.through(true), { allowEmpty: true }),
    ).rejects.toThrow(/destroyed/);
    expect(w.log.filter((l) => l.startsWith('keystore.'))).toEqual([]);
    expect(w.log.filter((l) => l === 'storage.putImmutable')).toEqual([]);
  });
});

describe('the guard finishes before the check starts and before the ids are consumed', () => {
  it('an existing encrypted segment, guarded: held on the guard, neither the check nor the ids have started', async () => {
    const w = world();
    await w.seed(true);
    const unwrap = gate();
    const deps = w.through(true, undefined, (label) =>
      label === 'keystore.openDek' ? unwrap.promise : undefined,
    );
    const pending = loadSegment(SEG, marked([1, 2, 3], w.log), deps, { keep: 9 });
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    // The guard needs the key to open the current generation's summary, so it is what the load is waiting for.
    expect(w.log).toEqual(['registry.get', 'keystore.openDek']);
    unwrap.open();
    expect((await pending).published).toBe(true);
    expect(w.log.indexOf('storage.check')).toBeLessThan(w.log.indexOf('ids:start'));
  });
});

/** Run `fn`, then let abandoned promises settle, and report every unhandled rejection seen meanwhile. */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

describe('a failure fails the load as it always did, and leaves nothing behind', () => {
  const writes = (log: Log) => log.filter((l) => l === 'storage.putImmutable');

  it.each([
    ['transient', new TransientError('listing throttled')],
    ['permanent', new Error('listing denied')],
  ])('the existence check failing, and the listing it falls back to (%s)', async (_name, err) => {
    const w = world();
    const deps = w.through(false, (label) =>
      label === 'storage.check' || label === 'storage.list' ? Promise.reject(err) : undefined,
    );
    const seen = await unhandledDuring(async () => {
      await expect(loadSegment(SEG, marked([1, 2], w.log), deps)).rejects.toBe(err);
    });
    expect(seen).toEqual([]);
    expect(writes(w.log)).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('the check failing alone falls back to the listing, as before', async () => {
    const w = world();
    const deps = w.through(false, (label) =>
      label === 'storage.check' ? Promise.reject(new TransientError('nope')) : undefined,
    );
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 0, published: true });
    expect(w.log).toContain('storage.list');
  });

  it.each([
    ['guarded', {}],
    ['allowEmpty', { allowEmpty: true }],
  ] as const)('the unwrap failing (%s)', async (_name, options) => {
    const w = world();
    await w.seed(true);
    const err = new KeyUnavailableError('no key');
    const deps = w.through(true, undefined, (label) =>
      label === 'keystore.openDek' ? Promise.reject(err) : undefined,
    );
    const before = (await w.registry.get(SEG))?.token;
    const seen = await unhandledDuring(async () => {
      await expect(loadSegment(SEG, marked([1, 2, 3], w.log), deps, options)).rejects.toBe(err);
    });
    expect(seen).toEqual([]);
    expect(writes(w.log)).toEqual([]);
    expect((await w.registry.get(SEG))?.token).toBe(before);
  });

  it('the encoding throwing while the check and the unwrap are out: they are abandoned without a rejection', async () => {
    const w = world();
    await w.seed(true);
    const late = gate();
    const deps = w.through(
      true,
      (label) =>
        label === 'storage.check' || label === 'storage.list'
          ? late.promise.then(() => Promise.reject(new TransientError('late')))
          : undefined,
      (label) =>
        label === 'keystore.openDek'
          ? late.promise.then(() => Promise.reject(new KeyUnavailableError('late')))
          : undefined,
    );
    const seen = await unhandledDuring(async () => {
      // An id out of range: the encoding throws while both requests are still in flight.
      await expect(loadSegment(SEG, [1, -5], deps, { allowEmpty: true })).rejects.toBeInstanceOf(
        ValidationError,
      );
      late.open();
    });
    expect(seen).toEqual([]);
    expect(writes(w.log)).toEqual([]);
  });
});
