import { mkdtemp, readFile, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IntegrityError, UnsupportedError, WriteConflictError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';
import type { IRegistryDriver, SegmentRef, Token } from '@/core/ports';
import { destroySegment, dropSegment } from '@/core/erasure';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { registryRowPath } from '@/drivers/localfs/paths';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { CountingObjectStore } from '../../helpers/counting';
import { countingEntropy, CREATED_TOKEN, tokenParts } from '../../helpers/tokens';
import { incarnationOf } from '@/drivers/_shared/registry';
import { webCryptoEntropy } from '@/drivers/_shared/entropy';
import { brandAsBackend } from '@/core/ports';
import { MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';

/** `n` as lowercase hex, `width` digits: what a counting entropy source's draw of `width / 2` bytes reads as. */
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

/**
 * A fleet across the schema-2 cut-over. A 0.12 process must read every row 0.11 wrote; a 0.11 process must fail
 * closed, typed, on every row 0.12 writes, never misread one; and no token a re-created name is given may be one an
 * earlier incarnation held.
 */

const REF: SegmentRef = { segment: 's' };

/**
 * 0.11's check of a row's stamp, as it shipped: the first thing its parser does after `JSON.parse`, and the one
 * that refuses a newer row before any field is looked at. It reads schema 1 only.
 */
function readAs011(text: string): void {
  const raw = (JSON.parse(text) as { schemaVersion?: unknown }).schemaVersion;
  if (raw === undefined) throw new IntegrityError('registry row has no schemaVersion');
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new IntegrityError(`registry row has a malformed schemaVersion (${String(raw)})`);
  }
  if (raw > 1) {
    throw new UnsupportedError(
      `registry row schemaVersion ${raw} is newer than this build reads (v1)`,
    );
  }
}

/** A live row exactly as 0.11 serialized one: schema 1, a decimal token, the record's fields in its order. */
const V1_ROW =
  '{"schemaVersion":1,"deleted":false,"record":{"segment":"s","currentGen":4,"status":"active",' +
  '"retention":{"expiresAt":99},"createdAt":10,"updatedAt":20,"token":"7"}}';
/** The same row as 0.11 tombstoned it. */
const V1_TOMBSTONE = V1_ROW.replace('"deleted":false', '"deleted":true');

/** A registry over a store whose raw rows a test can plant, read and remove. */
interface Harness {
  readonly registry: IRegistryDriver;
  plant(text: string): Promise<void>;
  raw(): Promise<string | undefined>;
  purge(): Promise<void>;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-reg-fleet-'));
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

describe.each(harnesses)('%s across the schema-2 cut-over', (_, make) => {
  it('reads a schema-1 row as 0.11 wrote it, through get, list and compare-and-swap', async () => {
    const h = make();
    await h.plant(V1_ROW);
    expect(await h.registry.get(REF)).toMatchObject({ currentGen: 4, token: '7' });
    const listed = [];
    for await (const r of h.registry.list()) listed.push(r);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ retention: { expiresAt: 99 }, token: '7' });

    // The first write stamps the row 2. The row gains no incarnation: its counter goes on, with a write part.
    const { token } = await h.registry.compareAndSwap(REF, '7', { currentGen: 5 });
    expect(token).toMatch(/^8\.[0-9a-f]{16}$/);
    expect(incarnationOf(token)).toBeUndefined();
    const stored = JSON.parse((await h.raw())!) as { schemaVersion: number };
    expect(stored.schemaVersion).toBe(2);
    expect(await h.registry.get(REF)).toMatchObject({ currentGen: 5, createdAt: 10, token });
  });

  it('tombstones a schema-1-born row in its own form, and re-creates the name as a new incarnation', async () => {
    const h = make(countingEntropy(41));
    await h.plant(V1_ROW);
    await h.registry.delete(REF, '7');
    expect(await h.registry.get(REF)).toBeNull();
    const tombstone = JSON.parse((await h.raw())!) as { record: { token: string } };
    expect(tombstone.record.token).toBe(`8.${hex(41, 16)}`); // its own form: no incarnation
    const { token } = await h.registry.create(REF, { currentGen: null });
    // The tombstone took counter 8; the new incarnation carries the counter on, under its own id.
    expect(token).toBe(`${hex(42, 32)}.9.${hex(43, 16)}`);
    await expect(h.registry.compareAndSwap(REF, '7', { currentGen: 1 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('refuses a stamped row whose token is in no form, live or tombstoned, naming its key', async () => {
    const h = make();
    const record = { segment: 's', currentGen: 4, status: 'active', createdAt: 10, updatedAt: 20 };
    for (const [schemaVersion, token] of [
      [2, '8'], // a bare counter: every token this build writes has a write part
      [1, `8.${'0'.repeat(16)}`], // a write part on a row no build of this one wrote
      [2, '1e3'],
    ] as const) {
      for (const deleted of [false, true]) {
        await h.plant(JSON.stringify({ schemaVersion, deleted, record: { ...record, token } }));
        const where = `schema ${schemaVersion} ${token} deleted=${deleted}`;
        await expect(h.registry.get(REF), where).rejects.toThrow(/token is not one .*s\.reg$/);
        const drain = async (): Promise<void> => {
          for await (const r of h.registry.list()) void r;
        };
        await expect(drain(), where).rejects.toBeInstanceOf(IntegrityError);
      }
    }
  });

  it('re-creates over a tombstone 0.11 wrote', async () => {
    const h = make(countingEntropy(1));
    await h.plant(V1_TOMBSTONE);
    expect(await h.registry.get(REF)).toBeNull();
    const { token } = await h.registry.create(REF, { currentGen: 0 });
    expect(tokenParts(token).counter).toBe(8);
  });

  it('writes nothing 0.11 can read: every row it writes is refused, typed, by 0.11', async () => {
    const h = make();
    // A control: the simulated check takes what 0.11 wrote, so its refusals below are about the rows.
    expect(() => readAs011(V1_ROW)).not.toThrow();

    const written: string[] = [];
    const { token } = await h.registry.create(REF, { currentGen: 0 });
    written.push((await h.raw())!);
    const { token: t1 } = await h.registry.compareAndSwap(REF, token, {
      currentGen: 1,
      summary: { generation: 1, cardinality: 3 },
    });
    written.push((await h.raw())!);
    await h.registry.delete(REF, t1);
    written.push((await h.raw())!); // the tombstone

    await h.purge();
    await h.plant(V1_ROW);
    await h.registry.compareAndSwap(REF, '7', { retention: { expiresAt: 100 } });
    written.push((await h.raw())!); // a schema-1 row, written once by this build

    for (const text of written) {
      expect(() => readAs011(text), text).toThrow(UnsupportedError);
    }
  });
});

/**
 * Tokens never repeat across purge-and-recreate. The entropy is injected and deterministic, so the run replays
 * exactly; every incarnation draws a new id, whether the row it replaces left a tombstone or nothing at all.
 */
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
        await h.registry.delete(REF, token); // a tombstone, which the next create continues from
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
    // Not a supported configuration: it shows the test above is not passing by accident.
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
 * whether the row it replaces left a tombstone or nothing at all, and a re-create over a tombstone carries the
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
      await h.registry.delete(REF, written); // tombstone counter 2
      const { token: overTombstone } = await h.registry.create(REF, { currentGen: null });
      expect(tokenParts(overTombstone).incarnation).not.toBe(tokenParts(first).incarnation);
      expect(tokenParts(overTombstone).counter).toBe(3);

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
});

/**
 * A registry restored from a backup is back at an older counter. Every write after it is still given a token the row
 * never had, because each write draws its own part: a store that kept the pre-restore row's chunks cached by
 * `<generation>:<token>` can never take the restored row's later generation for them.
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
 * A runtime without Web Crypto: a registry built there reads, and refuses only to write, and a load or an erasure
 * rewrite refuses before it writes its object, so nothing is left behind.
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
      noWebCrypto();
      const h = make();
      await h.plant(V1_ROW);
      expect(await h.registry.get(REF)).toMatchObject({ token: '7' });
      expect(h.registry.capabilities()).toEqual({ strongRead: true, canWrite: false });
      await expect(h.registry.compareAndSwap(REF, '7', { currentGen: 5 })).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      await expect(h.registry.delete(REF, '7')).rejects.toBeInstanceOf(UnsupportedError);
      await h.purge();
      await expect(h.registry.create(REF, { currentGen: null })).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      expect(await h.raw()).toBeUndefined();
    },
  );

  it.each(harnesses)('%s: an injected source still writes', async (_, make) => {
    noWebCrypto();
    const h = make(countingEntropy(1));
    expect(h.registry.capabilities()).toEqual({ strongRead: true });
    await h.registry.create(REF, { currentGen: null });
  });

  it('MemoryRegistryDriver: builds, reports it cannot write, refuses to', async () => {
    noWebCrypto();
    const registry = new MemoryRegistryDriver();
    expect(registry.capabilities()).toEqual({ strongRead: true, canWrite: false });
    await expect(registry.create(REF, { currentGen: null })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('a load refuses before it writes anything, onto a new segment and onto an existing row', async () => {
    const store = new CountingObjectStore(0);
    const storage = new MemoryStorageDriver();
    const registry = new ObjectStoreRegistry(store, undefined, () => 1);
    const roaring = new CloudRoaring({ storage: brandAsBackend({ storage, registry }) });
    await roaring.load({ segment: 'old' }, [1, 2, 3]); // written while Web Crypto is there

    noWebCrypto();
    const writes = store.writes;
    for (const segment of ['new', 'old']) {
      await expect(roaring.load({ segment }, [4, 5])).rejects.toBeInstanceOf(UnsupportedError);
    }
    expect(store.writes).toBe(writes);
    const objects = [];
    for (const segment of ['new', 'old']) {
      for await (const k of storage.list({ segment })) objects.push(`${segment}.${k.generation}`);
    }
    expect(objects).toEqual(['old.0']);
  });

  it('an erasure rewrite refuses before it writes its object', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new ObjectStoreRegistry(new CountingObjectStore(0), undefined, () => 1);
    const roaring = new CloudRoaring({ storage: brandAsBackend({ storage, registry }) });
    await roaring.load({ segment: 's' }, [1, 2, 3]);

    noWebCrypto();
    await roaring.eraseSubject(2).catch(() => undefined);
    const generations = [];
    for await (const k of storage.list({ segment: 's' })) generations.push(k.generation);
    expect(generations).toEqual([0]);
    expect(await roaring.segment('s').has(2)).toBe(true);
  });
});

/** A crypto-shred takes the summary with the wrapped keys: nothing of the generation's description survives it. */
describe.each([
  ['MemoryRegistryDriver', (): IRegistryDriver => new MemoryRegistryDriver()],
  ...harnesses.map(([name, make]) => [name, (): IRegistryDriver => make().registry] as const),
])('a crypto-shred clears the summary: %s', (_, makeRegistry) => {
  it('dropSegment of a cleartext segment leaves a tombstone with no summary', async () => {
    const registry = makeRegistry();
    await registry.create(REF, {
      currentGen: 2,
      summary: { generation: 2, cardinality: 7, metadata: { who: 'a person' } },
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
      summary: { generation: 2, sealed: Buffer.alloc(36).toString('base64') },
    });
    const result = await destroySegment(REF, { registry }, { confirmSegment: 's' });
    expect(result.cryptoShredded).toBe(true);
    const row = await registry.get(REF);
    expect(row).toMatchObject({ status: 'destroyed', currentGen: 2 });
    expect(row!.wrappedDeks).toBeUndefined();
    expect(row!.summary).toBeUndefined();
  });
});
