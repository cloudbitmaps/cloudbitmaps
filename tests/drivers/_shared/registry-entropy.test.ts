import { mkdtemp, readFile, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { UnsupportedError, WriteConflictError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';
import type { IRegistryDriver, SegmentRef, Token } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { destroySegment, dropSegment } from '@/core/erasure';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { webCryptoEntropy } from '@/drivers/_shared/entropy';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { registryRowPath } from '@/drivers/localfs/paths';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { CountingObjectStore } from '../../helpers/counting';
import { countingEntropy, CREATED_TOKEN, tokenParts } from '../../helpers/tokens';

/** `n` as lowercase hex, `width` digits: what a counting entropy source's draw of `width / 2` bytes reads as. */
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

/**
 * Where a registry's tokens come from, and what happens without a source. Every shipped registry draws each row's
 * incarnation id and each write's part from injected entropy, Web Crypto by default, so no token a re-created name is
 * given is one an earlier incarnation held, and a row restored from a backup is never given a token it had before. On a
 * runtime without Web Crypto a registry still reads, reports `canWrite: false`, and refuses every write; a load, an
 * erasure's rewrite and a leased pin refuse before they write anything, so no object is left behind.
 */

const REF: SegmentRef = { segment: 's' };

/** A registry over a store whose raw rows a test can plant, read and remove. */
interface Harness {
  readonly registry: IRegistryDriver;
  /** Whether its `delete` removes a row, rather than leaving a tombstone. */
  readonly removes: boolean;
  plant(text: string): Promise<void>;
  raw(): Promise<string | undefined>;
  purge(): Promise<void>;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-reg-entropy-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let dirs = 0;
const harnesses: ReadonlyArray<readonly [string, (entropy?: Entropy) => Harness]> = [
  [
    'ObjectStoreRegistry',
    (entropy) => {
      const store = new CountingObjectStore(0);
      const key = registryObjectKey(undefined, REF);
      return {
        registry: new ObjectStoreRegistry(store, undefined, () => 30, entropy),
        removes: false, // the counting store vouches for no conditional delete
        plant: async (text) => store.plant(key, text),
        raw: async () => store.text(key),
        purge: async () => store.remove(key),
      };
    },
  ],
  [
    'LocalFsRegistryDriver',
    (entropy) => {
      const dir = join(root, `d${dirs++}`);
      const path = registryRowPath(dir, REF);
      return {
        registry: new LocalFsRegistryDriver(dir, {
          now: () => 30,
          ...(entropy === undefined ? {} : { entropy }),
        }),
        removes: true,
        plant: async (text) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text, 'utf8');
        },
        raw: async () => readFile(path, 'utf8').catch(() => undefined),
        purge: async () => unlink(path),
      };
    },
  ],
];

describe('a re-created name never gets a token an earlier incarnation held', () => {
  /** Run `cycles` incarnations of one name, each written a few times, then deleted or removed outright. */
  async function incarnations(h: Harness, cycles: number): Promise<Token[]> {
    const issued: Token[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      let { token } = await h.registry.create(REF, { currentGen: null });
      issued.push(token);
      for (let write = 0; write < cycle % 3; write++) {
        ({ token } = await h.registry.compareAndSwap(REF, token, { currentGen: write }));
        issued.push(token);
      }
      if (cycle % 2 === 0) {
        // A tombstone, which the next create continues from, on a registry that keeps one; a removal on one that does not.
        await h.registry.delete(REF, token);
      } else {
        await h.purge(); // nothing left behind: what a hard purge leaves
      }
    }
    return issued;
  }

  it.each(harnesses)(
    '%s: every token is new, and every earlier one is refused',
    async (_, make) => {
      const h = make(countingEntropy(7));
      const issued = await incarnations(h, 60);
      expect(new Set(issued).size).toBe(issued.length);
      const { token: live } = await h.registry.create(REF, { currentGen: 0 });
      expect(issued).not.toContain(live);
      for (const stale of issued) {
        await expect(
          h.registry.compareAndSwap(REF, stale, { currentGen: 9 }),
        ).rejects.toBeInstanceOf(WriteConflictError);
      }
    },
  );

  it.each(harnesses)('%s: the same seed replays the same tokens', async (_, make) => {
    const first = await incarnations(make(countingEntropy(3)), 10);
    const again = await incarnations(make(countingEntropy(3)), 10);
    expect(again).toEqual(first);
  });

  it('the random parts are what separate them once nothing is left: a constant source repeats', async () => {
    // Not a supported configuration: it shows the tests above are not passing by accident.
    const h = harnesses[0]![1]((n) => new Uint8Array(n));
    const { token: first } = await h.registry.create(REF, { currentGen: null });
    await h.purge();
    const { token: second } = await h.registry.create(REF, { currentGen: null });
    expect(second).toBe(first);
  });

  it('MemoryRegistryDriver: every token is new across delete and re-create', async () => {
    const registry = new MemoryRegistryDriver({ now: () => 1, entropy: countingEntropy(11) });
    const issued: Token[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const { token } = await registry.create(REF, { currentGen: null });
      const { token: next } = await registry.compareAndSwap(REF, token, { currentGen: 0 });
      issued.push(token, next);
      expect(tokenParts(next).incarnation).toBe(tokenParts(token).incarnation);
      await registry.delete(REF);
    }
    expect(new Set(issued).size).toBe(issued.length);
  });

  it('MemoryRegistryDriver: the same seed replays the same tokens, exactly', async () => {
    const run = async (): Promise<Token[]> => {
      const registry = new MemoryRegistryDriver({ now: () => 1, entropy: countingEntropy(21) });
      const out: Token[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const { token } = await registry.create(REF, { currentGen: null });
        const { token: next } = await registry.compareAndSwap(REF, token, { currentGen: 0 });
        out.push(token, next);
        await registry.delete(REF);
      }
      return out;
    };
    const first = await run();
    expect(first.slice(0, 2)).toEqual([
      `${hex(21, 32)}.1.${hex(22, 16)}`,
      `${hex(21, 32)}.2.${hex(23, 16)}`,
    ]);
    expect(await run()).toEqual(first);
  });
});

/**
 * Every driver draws its incarnation ids from Web Crypto unless it is given a source: a re-created name gets a new id
 * whether the row it replaces left a tombstone or nothing at all, and a create over a tombstone carries the
 * tombstone's counter on under the new id.
 */
describe('every driver draws a new incarnation at each create, from Web Crypto by default', () => {
  it.each(harnesses)(
    '%s: a create after a tombstone or a removal is a new incarnation',
    async (_, make) => {
      const h = make();
      const { token: first } = await h.registry.create(REF, { currentGen: null });
      expect(first).toMatch(CREATED_TOKEN);
      const { token: written } = await h.registry.compareAndSwap(REF, first, { currentGen: 0 });
      await h.registry.delete(REF, written); // a tombstone at counter 2, or the row removed
      const { token: overTombstone } = await h.registry.create(REF, { currentGen: null });
      expect(tokenParts(overTombstone).incarnation).not.toBe(tokenParts(first).incarnation);
      expect(tokenParts(overTombstone).counter).toBe(h.removes ? 0 : 3);

      await h.purge(); // nothing left of the second incarnation
      const { token: overNothing } = await h.registry.create(REF, { currentGen: null });
      expect(overNothing).toMatch(CREATED_TOKEN);
      expect(
        new Set([first, overTombstone, overNothing].map((t) => tokenParts(t).incarnation)).size,
      ).toBe(3);
    },
  );

  it('MemoryRegistryDriver: a create after a delete is a new incarnation', async () => {
    const registry = new MemoryRegistryDriver();
    const { token: first } = await registry.create(REF, { currentGen: null });
    await registry.delete(REF);
    const { token: second } = await registry.create(REF, { currentGen: null });
    expect(tokenParts(second).incarnation).not.toBe(tokenParts(first).incarnation);
  });

  it('the default source draws from Web Crypto', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      expect(webCryptoEntropy(16)).toHaveLength(16);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * A registry restored from a backup is back at an older counter. Every write after it is still given a token the row
 * never had, because each write draws its own part.
 */
describe('a row restored from a backup is never given a token it had before', () => {
  it.each(harnesses)('%s', async (_, make) => {
    const h = make();
    const issued: Token[] = [];
    let { token } = await h.registry.create(REF, { currentGen: 0 });
    issued.push(token);
    ({ token } = await h.registry.compareAndSwap(REF, token, { currentGen: 1 }));
    issued.push(token);
    const backup = (await h.raw())!; // the backup, at counter 1
    const atBackup = token;
    for (let gen = 2; gen <= 4; gen++) {
      ({ token } = await h.registry.compareAndSwap(REF, token, { currentGen: gen }));
      issued.push(token);
    }

    await h.plant(backup); // the restore
    let restored = atBackup;
    for (let gen = 2; gen <= 4; gen++) {
      ({ token: restored } = await h.registry.compareAndSwap(REF, restored, { currentGen: gen }));
      expect(tokenParts(restored).counter).toBe(gen); // the counters repeat...
      expect(issued).not.toContain(restored); // ...the tokens do not
    }
  });
});

/**
 * A runtime without Web Crypto: a registry built there reads, and refuses only to write, and a load, an erasure's
 * rewrite and a leased pin refuse before they write anything, so nothing is left behind.
 */
describe('a runtime without Web Crypto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const noWebCrypto = (): void => {
    vi.stubGlobal('crypto', undefined);
  };

  it('the default entropy refuses, typed', () => {
    noWebCrypto();
    expect(() => webCryptoEntropy(16)).toThrow(UnsupportedError);
    expect(() => webCryptoEntropy(16)).toThrow(/run on a runtime that has it/);
  });

  it.each(harnesses)(
    '%s: builds and reads, reports it cannot write, refuses to',
    async (_, make) => {
      // A row a process with a source wrote, read by one built where there is none.
      const writer = make(countingEntropy(5));
      const { token } = await writer.registry.create(REF, { currentGen: 4 });
      const row = (await writer.raw())!;

      noWebCrypto();
      const h = make();
      await h.plant(row);
      expect(await h.registry.get(REF)).toMatchObject({ currentGen: 4, token, pointerId: token });
      expect(h.registry.capabilities()).toEqual({
        strongRead: true,
        canWrite: false,
        conditionalDelete: h.removes,
      });
      await expect(h.registry.compareAndSwap(REF, token, { currentGen: 5 })).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      if (h.removes) {
        // A delete that removes the row draws no token, so it goes through.
        await h.registry.delete(REF, token);
      } else {
        // One that leaves a tombstone draws one, and is refused with the row as it was.
        await expect(h.registry.delete(REF, token)).rejects.toBeInstanceOf(UnsupportedError);
        expect(await h.raw()).toBe(row);
        await h.purge();
      }
      expect(await h.raw()).toBeUndefined();
      await expect(h.registry.create(REF, { currentGen: null })).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      expect(await h.raw()).toBeUndefined();
    },
  );

  it.each(harnesses)('%s: an injected source still writes', async (_, make) => {
    noWebCrypto();
    const h = make(countingEntropy(1));
    expect(h.registry.capabilities()).toEqual({ strongRead: true, conditionalDelete: h.removes });
    await h.registry.create(REF, { currentGen: null });
  });

  it('MemoryRegistryDriver: builds, reports it cannot write, refuses to', async () => {
    noWebCrypto();
    const registry = new MemoryRegistryDriver();
    expect(registry.capabilities()).toEqual({
      strongRead: true,
      canWrite: false,
      conditionalDelete: true,
    });
    await expect(registry.create(REF, { currentGen: null })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  /** A store over a registry whose rows a test can count, with one segment loaded while Web Crypto is there. */
  async function loaded() {
    const store = new CountingObjectStore(0);
    const storage = new MemoryStorageDriver();
    const registry = new ObjectStoreRegistry(store, undefined, () => 1);
    const roaring = new CloudRoaring({ storage: brandAsBackend({ storage, registry }) });
    await roaring.load({ segment: 'old' }, [1, 2, 3]);
    const objects = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const segment of ['new', 'old']) {
        for await (const k of storage.list({ segment })) out.push(`${segment}.${k.generation}`);
      }
      return out;
    };
    return { store, roaring, objects };
  }

  it('a load refuses before it writes anything, onto a new segment and onto an existing row', async () => {
    const { store, roaring, objects } = await loaded();
    noWebCrypto();
    const writes = store.writes;
    for (const segment of ['new', 'old']) {
      await expect(roaring.load({ segment }, [4, 5])).rejects.toBeInstanceOf(UnsupportedError);
    }
    expect(store.writes).toBe(writes);
    expect(await objects()).toEqual(['old.0']);
  });

  it('an erasure rewrite refuses before it writes its object', async () => {
    const { roaring, objects } = await loaded();
    noWebCrypto();
    const result = await roaring.eraseSubject(2, { allNamespaces: true });
    expect(result.erasedFrom).toHaveLength(1);
    expect(result.erasedFrom[0]).toMatchObject({ segment: 'old', erased: false });
    expect(result.erasedFrom[0]!.note).toMatch(/canWrite is false/);
    expect(await objects()).toEqual(['old.0']);
    expect(await roaring.segment('old').has(2)).toBe(true);
  });

  it('a leased pin refuses before it reads the row or writes a lease', async () => {
    const { store, roaring } = await loaded();
    noWebCrypto();
    const { reads, writes } = store;
    await expect(roaring.segment('old').pin({ leaseUntil: Date.now() + 60_000 })).rejects.toThrow(
      /pin\(\{ leaseUntil \}\) needs a registry that can write a row/,
    );
    expect({ reads: store.reads, writes: store.writes }).toEqual({ reads, writes });
    // An unleased pin writes nothing, so it still pins.
    expect(await (await roaring.segment('old').pin()).has(2)).toBe(true);
  });
});

/** Every shipped registry, built fresh. */
const everyRegistry: ReadonlyArray<readonly [string, () => IRegistryDriver]> = [
  ['MemoryRegistryDriver', () => new MemoryRegistryDriver()],
  ...harnesses.map(([name, make]) => [name, () => make().registry] as const),
];

/** A crypto-shred takes the summary with the wrapped keys: nothing of the generation's description survives it. */
describe.each(everyRegistry)('a crypto-shred clears the summary: %s', (_, makeRegistry) => {
  it('dropSegment of a cleartext segment leaves a tombstone with no summary', async () => {
    const registry = makeRegistry();
    await registry.create(REF, {
      currentGen: 2,
      summary: {
        generation: 2,
        cardinality: 7,
        fingerprint: '4096:7',
        metadata: { who: 'a person' },
      },
    });
    const result = await dropSegment(
      REF,
      { registry, storage: new MemoryStorageDriver() },
      { confirmSegment: 's' },
    );
    expect(result.dropped).toBe(true);
    const row = await registry.get(REF);
    expect(row).toMatchObject({ status: 'destroyed', currentGen: 2 });
    expect(row!.summary).toBeUndefined();
  });

  it('leaves a destroyed row with no wrapped keys and no summary', async () => {
    const registry = makeRegistry();
    await registry.create(REF, {
      currentGen: 2,
      wrappedDeks: [{ keyId: 'k', wrapped: 'd3JhcHBlZA==' }],
      summary: { generation: 2, sealed: Buffer.alloc(48).toString('base64') },
    });
    const result = await destroySegment(REF, { registry }, { confirmSegment: 's' });
    expect(result.cryptoShredded).toBe(true);
    const row = await registry.get(REF);
    expect(row).toMatchObject({ status: 'destroyed', currentGen: 2 });
    expect(row!.wrappedDeks).toBeUndefined();
    expect(row!.summary).toBeUndefined();
  });
});
