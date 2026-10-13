/**
 * An encrypted generation's cold open sends its tail read at once, beside the key fetch, instead of after it. Each test
 * records the order in which the registry, the keystore and the storage were asked, with a keystore that settles when a
 * gate opens, so the order is the code's and not the clock's.
 */
import { randomBytes } from 'node:crypto';
import { CloudRoaring, CrbmStorageChunkSource } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError, NotFoundError, TransientError, ValidationError } from '@/core/errors';
import type { IKeystore, IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

const SEG: SegmentRef = { segment: 's' };
const IDS = [1, 2, 3, 100_000, 2_000_000_000];
const FIRST_CHUNK = 0;

/** A promise and the function that settles it, so a test decides when a fake keystore answers. */
function gate<T = void>(): {
  promise: Promise<T>;
  open: (value: T) => void;
  fail: (err: unknown) => void;
} {
  let open!: (value: T) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/** Let every promise that can settle without a timer or a gate do so. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** `target` with each call to one of `methods` appended to `log` as `<label>.<method>`, when the call is made. */
function recording<T extends object>(
  target: T,
  label: string,
  methods: readonly string[],
  log: string[],
  onCall?: (method: string, args: unknown[]) => void,
): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj) as unknown;
      if (typeof value !== 'function') return value;
      if (typeof prop === 'string' && methods.includes(prop)) {
        return (...args: unknown[]) => {
          log.push(`${label}.${prop}`);
          onCall?.(prop, args);
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(obj);
    },
  });
}

interface World {
  storage: MemoryStorageDriver;
  registry: MemoryRegistryDriver;
  keystore: InProcessKeystore;
  log: string[];
  /** The `maxBytes` of every tail read the storage was asked for. */
  tailSizes: number[];
}

async function world(encrypted: boolean): Promise<World> {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, IDS, {
    registry,
    ...(encrypted ? { keystore } : {}),
  });
  return { storage, registry, keystore, log: [], tailSizes: [] };
}

/** A source over `w` that logs every storage read and registry read, with `keystore` in place of the world's. */
function sourceOn(
  w: World,
  keystore?: IKeystore,
  options: { tailBytes?: number; requireEncryption?: boolean } = {},
): CrbmStorageChunkSource {
  return new CrbmStorageChunkSource(loggedStorage(w), {
    registry: loggedRegistry(w),
    ...(keystore ? { keystore } : {}),
    ...options,
  });
}

function loggedStorage(w: World): IStorageDriver {
  return recording(w.storage, 'storage', ['getTail', 'getRange'], w.log, (method, args) => {
    if (method === 'getTail') w.tailSizes.push(args[1] as number);
  });
}

function loggedRegistry(w: World): IRegistryDriver {
  return recording(w.registry, 'registry', ['get'], w.log);
}

/** A store over the world's drivers, which can pin, and whose keystore is `keystore`. */
function storeOn(w: World, keystore: IKeystore, storage: IStorageDriver = loggedStorage(w)) {
  return new CloudRoaring({
    storage: brandAsBackend({ storage, registry: loggedRegistry(w) }),
    encryption: { keystore },
    seams: { clock: { now: () => 1_000_000, sleep: () => Promise.resolve() } },
  });
}

/** The world's keystore, logging each `openDek` and answering when `until` settles (at once without it). */
function loggedKeystore(w: World, until?: Promise<void>): IKeystore {
  return {
    ...bindAll(w.keystore),
    openDek: async (wrapped) => {
      w.log.push('keystore.openDek');
      await until;
      return w.keystore.openDek(wrapped);
    },
  } as IKeystore;
}

function bindAll(keystore: InProcessKeystore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(keystore))) {
    const member = (keystore as unknown as Record<string, unknown>)[name];
    if (name !== 'constructor' && typeof member === 'function') {
      out[name] = (member as (...a: unknown[]) => unknown).bind(keystore);
    }
  }
  return out;
}

/** Every `unhandledRejection` the process raises while `body` runs and settles. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await body();
    await settle();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

const first = (source: CrbmStorageChunkSource): Promise<Uint8Array | null> =>
  source.getChunk({ ...SEG, chunkKey: FIRST_CHUNK });

describe('an encrypted cold open sends its tail read beside the key fetch', () => {
  it('starts the tail read before the keystore has answered', async () => {
    const w = await world(true);
    const key = gate();
    const read = first(sourceOn(w, loggedKeystore(w, key.promise)));
    await settle();
    // The key has not answered, and the tail request is already out.
    expect(w.log).toEqual(['registry.get', 'storage.getTail', 'keystore.openDek']);
    key.open();
    expect(await read).not.toBeNull();
    // Nothing more than the chunk's own range read follows: one tail read for the open.
    expect(w.log).toEqual([
      'registry.get',
      'storage.getTail',
      'keystore.openDek',
      'storage.getRange',
    ]);
  });

  it('a keystore that answers at once still leaves the cold open one tail read', async () => {
    const w = await world(true);
    const source = sourceOn(w, loggedKeystore(w));
    expect(await first(source)).not.toBeNull();
    expect(w.log.filter((entry) => entry === 'storage.getTail')).toHaveLength(1);
  });

  it('a keystore fault surfaces as KeyUnavailableError when the tail read it sent answers', async () => {
    const w = await world(true);
    const key = gate();
    const source = sourceOn(w, loggedKeystore(w, key.promise));
    const fault = new KeyUnavailableError('the keystore is down');
    let caught: unknown;
    const unhandled = await unhandledDuring(async () => {
      const read = first(source).catch((err: unknown) => {
        caught = err;
      });
      await settle();
      key.fail(fault);
      await read;
    });
    expect(caught).toBe(fault);
    expect(unhandled).toEqual([]);
  });

  it('a keystore fault raises the key error while the tail read is pending, and its later failure is handled', async () => {
    const w = await world(true);
    const key = gate();
    const tail = gate<never>();
    const slow = recording(w.storage, 'storage', ['getRange'], w.log);
    const storage: IStorageDriver = new Proxy(slow, {
      get(obj, prop) {
        if (prop === 'getTail') {
          return () => {
            w.log.push('storage.getTail');
            return tail.promise;
          };
        }
        const value = Reflect.get(obj, prop, obj) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(obj)
          : value;
      },
    });
    const source = new CrbmStorageChunkSource(storage, {
      registry: w.registry,
      keystore: loggedKeystore(w, key.promise),
    });
    const fault = new KeyUnavailableError('the keystore is down');
    let caught: unknown;
    const unhandled = await unhandledDuring(async () => {
      // The test's own gate promise has a handler, so only the code under test can leave a rejection unhandled.
      tail.promise.catch(() => undefined);
      const read = first(source).catch((err: unknown) => {
        caught = err;
      });
      await settle();
      expect(w.log).toContain('storage.getTail');
      key.fail(fault);
      await settle();
      // The tail request fails after the caller has its answer.
      tail.fail(new NotFoundError('the object is gone'));
      await read;
    });
    expect(caught).toBe(fault);
    expect(unhandled).toEqual([]);
  });

  it('a key that fails while the tail has already failed raises the key error, with nothing unhandled', async () => {
    const w = await world(true);
    // The object is missing, so the tail read fails at once; the key fails later.
    await w.storage.delete({ ...SEG, generation: 0 });
    const key = gate();
    const source = sourceOn(w, loggedKeystore(w, key.promise));
    const fault = new KeyUnavailableError('the keystore is down');
    let caught: unknown;
    const unhandled = await unhandledDuring(async () => {
      const read = first(source).catch((err: unknown) => {
        caught = err;
      });
      await settle();
      expect(w.log).toContain('storage.getTail');
      key.fail(fault);
      await read;
    });
    expect(caught).toBe(fault);
    expect(caught).not.toBeInstanceOf(NotFoundError);
    expect(unhandled).toEqual([]);
  });

  it('a missing object with a working key surfaces NotFoundError', async () => {
    const w = await world(true);
    await w.storage.delete({ ...SEG, generation: 0 });
    const unhandled = await unhandledDuring(async () => {
      await expect(first(sourceOn(w, loggedKeystore(w)))).rejects.toBeInstanceOf(NotFoundError);
    });
    expect(unhandled).toEqual([]);
  });

  it('a store with no keystore sends no tail read for an encrypted row', async () => {
    const w = await world(true);
    await expect(first(sourceOn(w))).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(w.log).toEqual(['registry.get']);
  });
});

describe('a cleartext open and a warm open make the requests they made', () => {
  it('a cleartext cold open: the row, the tail, the chunk', async () => {
    const w = await world(false);
    expect(await first(sourceOn(w))).not.toBeNull();
    expect(w.log).toEqual(['registry.get', 'storage.getTail', 'storage.getRange']);
  });

  it('a warm open of an encrypted segment: the chunk alone, no row, no key, no tail', async () => {
    const w = await world(true);
    const source = sourceOn(w, loggedKeystore(w));
    await first(source);
    w.log.length = 0;
    expect(await first(source)).not.toBeNull();
    expect(w.log).toEqual(['storage.getRange']);
  });

  it('a warm open of a cleartext segment: the chunk alone', async () => {
    const w = await world(false);
    const source = sourceOn(w);
    await first(source);
    w.log.length = 0;
    expect(await first(source)).not.toBeNull();
    expect(w.log).toEqual(['storage.getRange']);
  });
});

describe('which opens send an early tail read, and of what size', () => {
  it('the early tail read asks for the size an open asks for: a custom tailBytes, or a footer at least', async () => {
    for (const [tailBytes, asked] of [
      [4096, 4096],
      [8, 104],
    ] as const) {
      const w = await world(true);
      expect(await first(sourceOn(w, loggedKeystore(w), { tailBytes }))).not.toBeNull();
      // One tail read, of the size the reader asks for: the early read is that read, not one beside it.
      expect(w.tailSizes).toEqual([asked]);
    }
  });

  it('a tailBytes that is not a number sends one tail read, not a second', async () => {
    const w = await world(true);
    await expect(
      first(sourceOn(w, loggedKeystore(w), { tailBytes: Number.NaN })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(w.tailSizes).toHaveLength(1);
  });

  it('requireEncryption with a keystore over a cleartext row sends no tail read', async () => {
    const w = await world(false);
    const source = sourceOn(w, loggedKeystore(w), { requireEncryption: true });
    await expect(first(source)).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(w.log).toEqual(['registry.get']);
  });

  it('a pin sends its tail read beside the key request', async () => {
    const w = await world(true);
    const key = gate();
    const read = storeOn(w, loggedKeystore(w, key.promise)).segment(SEG.segment).pin();
    await settle();
    expect(w.log).toEqual(['registry.get', 'storage.getTail', 'keystore.openDek']);
    key.open();
    await read;
  });

  it("a has()'s first open waits for the key before it sends the tail read", async () => {
    const w = await world(true);
    const key = gate();
    const read = storeOn(w, loggedKeystore(w, key.promise)).segment(SEG.segment).has(3);
    await settle();
    // The version comes first, and the row's sealed summary needs the key: nothing to overlap yet.
    expect(w.log).toEqual(['registry.get', 'keystore.openDek']);
    key.open();
    expect(await read).toBe(true);
    expect(w.log).toEqual(['registry.get', 'keystore.openDek', 'storage.getTail']);
  });

  it("a has()'s open made again after a failed one overlaps, and a key fault then still wins", async () => {
    const w = await world(true);
    let tails = 0;
    let keys = 0;
    const flaky = new Proxy(loggedStorage(w), {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj) as unknown;
        if (prop === 'getTail') {
          return (...args: unknown[]) =>
            tails++ === 0
              ? (w.log.push('storage.getTail'), Promise.reject(new TransientError('503')))
              : (value as (...a: unknown[]) => unknown).apply(obj, args);
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(obj)
          : value;
      },
    });
    const fault = new KeyUnavailableError('key revoked');
    const keystore: IKeystore = {
      ...bindAll(w.keystore),
      openDek: async (wrapped) => {
        w.log.push('keystore.openDek');
        if (keys++ > 0) throw fault;
        return w.keystore.openDek(wrapped);
      },
    } as IKeystore;
    const unhandled = await unhandledDuring(async () => {
      await expect(storeOn(w, keystore, flaky).segment(SEG.segment).has(3)).rejects.toBe(fault);
    });
    expect(w.log).toEqual([
      'registry.get',
      'keystore.openDek',
      'storage.getTail',
      'registry.get',
      'storage.getTail',
      'keystore.openDek',
    ]);
    expect(unhandled).toEqual([]);
  });
});
