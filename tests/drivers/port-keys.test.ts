import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError, WriteConflictError } from '@/core/errors';
import type { BlobSink } from '@/core/blob';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';
import { S3StorageDriver } from '@/s3/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { brandAsBackend } from '@cloudbitmaps/core/driver-kit';
import { validateSegmentRef, PORT_KEYS, REF_KEYS } from '@/core/validate';
import type { RegistryRecord } from '@/core/ports';
import { STUB_GCS_BUCKET, StubGcsService } from '../helpers/gcs-stub';
import { StubBlobService } from '../helpers/azure-blob-stub';
import { BUCKET, StubBucket } from '../helpers/stub-s3-bucket';
import { isolateAwsEnv } from '../helpers/aws-env';
import type { IsolatedAwsEnv } from '../helpers/aws-env';

/**
 * The driver ports refuse a key they do not take, and an option they do not take. `{ segment: 'a', namspace: 'eu' }`
 * read as the default namespace's `a`, so a hand-built ref in a recovery script deleted the wrong row or object; a
 * misspelt `ifVersion` read as no condition and deleted whatever was under the key. Each driver family is run: the
 * memory pair, the local-files pair, the object-store registry every GCS, Azure and S3 registry shares (over a store in
 * memory), and the S3 storage driver over its stubbed client.
 */

const TYPO = { segment: 'a', namspace: 'eu' } as unknown as SegmentRef;
const TYPO_GEN = { segment: 'a', namspace: 'eu', generation: 0 } as unknown as GenKey;
const KEY: GenKey = { segment: 'a', generation: 0 };
const KEYS = /unknown key "namspace" in the segment ref; it takes \{ segment, namespace \}/;
const bytes = (b: Uint8Array) => async (sink: BlobSink) => sink.write(b);

class MapStore implements ObjectRegistryStore {
  readonly label = 'map';
  readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private next = 1;
  read(key: string): Promise<ObjectRow | null> {
    const f = this.objects.get(key);
    return Promise.resolve(f === undefined ? null : { bytes: f.bytes, version: String(f.version) });
  }
  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
    const f = this.objects.get(key);
    if (expect === 'absent' ? f !== undefined : String(f?.version) !== expect.version) {
      return Promise.reject(new WriteConflictError('lost'));
    }
    this.objects.set(key, { bytes: body, version: this.next++ });
    return Promise.resolve();
  }
  async *listKeys(): AsyncIterable<string> {
    // Nothing is listed here.
  }
}

let root: string;
let env: IsolatedAwsEnv;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-port-keys-'));
  env = isolateAwsEnv();
});
afterEach(async () => {
  env.restore();
  await rm(root, { recursive: true, force: true });
});

const registries: Array<[string, () => IRegistryDriver]> = [
  ['memory', () => new MemoryRegistryDriver()],
  ['local files', () => new LocalFsRegistryDriver(root)],
  ['object store', () => new ObjectStoreRegistry(new MapStore(), 'p', () => 1_000)],
];

describe.each(registries)('the %s registry port', (_name, make) => {
  it('refuses a ref with a key it does not take, on every call, and the default row stays', async () => {
    const registry = make();
    await registry.create({ segment: 'a' }, { currentGen: 0 });
    const calls: Array<() => Promise<unknown>> = [
      () => registry.get(TYPO),
      () => registry.create(TYPO, { currentGen: 0 }),
      () => registry.compareAndSwap(TYPO, 't', { currentGen: 1 }),
      () => registry.delete(TYPO),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ValidationError);
      await expect(call()).rejects.toThrow('unknown key "namspace" in the segment ref');
    }
    expect((await registry.get({ segment: 'a' }))?.currentGen).toBe(0);
  });

  it('takes the ref the library hands it: a generation key and a listing row', async () => {
    const registry = make();
    await registry.create({ segment: 'a', generation: 3 } as SegmentRef, { currentGen: 0 });
    const row = await registry.get({ segment: 'a', currentGen: 0, status: 'active' } as SegmentRef);
    expect(row?.currentGen).toBe(0);
  });

  it('refuses an option it does not take or of the wrong type, before it writes anything', async () => {
    const registry = make();
    const ref: SegmentRef = { segment: 'a' };
    const bad = [
      { onTokan: () => undefined },
      { held: 'row' },
      { onToken: 'cb' },
    ] as unknown as Array<Record<string, unknown>>;
    for (const options of bad) {
      await expect(registry.create(ref, { currentGen: 0 }, options)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await registry.get(ref)).toBeNull();
    await expect(registry.create(ref, { currentGen: 0 }, null as never)).rejects.toThrow(
      ValidationError,
    );
    const { token } = await registry.create(
      ref,
      { currentGen: 0 },
      { held: null, onToken: () => {} },
    );
    await expect(
      registry.compareAndSwap(ref, token, { currentGen: 1 }, { onTokan: () => {} } as never),
    ).rejects.toThrow('write options does not take `onTokan`');
    expect((await registry.get(ref))?.currentGen).toBe(0);
  });
});

const storages: Array<[string, () => IStorageDriver]> = [
  ['memory', () => new MemoryStorageDriver()],
  ['local files', () => new LocalFsStorageDriver(root)],
  [
    'S3 (stubbed client)',
    () => new S3StorageDriver({ client: new StubBucket().client(), bucket: BUCKET }),
  ],
];

describe.each(storages)('the %s storage port', (_name, make) => {
  it('refuses a key with a key it does not take, and the default namespace object stays', async () => {
    const storage = make();
    await storage.putImmutable(KEY, bytes(new Uint8Array([1, 2, 3])));
    const calls: Array<() => Promise<unknown>> = [
      () => storage.delete(TYPO_GEN),
      () => storage.getRange(TYPO_GEN, 0, 1),
      () => storage.getTail(TYPO_GEN, 1),
      () => storage.putImmutable(TYPO_GEN, bytes(new Uint8Array([1]))),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ValidationError);
      await expect(call()).rejects.toThrow(KEYS);
    }
    expect(Array.from(await storage.getRange(KEY, 0, 3))).toEqual([1, 2, 3]);
  });

  it('refuses a misspelt ifVersion instead of deleting unconditionally', async () => {
    const storage = make();
    await storage.putImmutable(KEY, bytes(new Uint8Array([1, 2, 3])));
    const { version } = await storage.getTail(KEY, 1);
    const options = { ifVersoin: version ?? 'v' } as never;
    await expect(storage.delete(KEY, options)).rejects.toThrow(
      'delete options does not take `ifVersoin`',
    );
    await expect(storage.delete(KEY, { ifVersion: 7 } as never)).rejects.toThrow(
      'delete options: `ifVersion` must be a string',
    );
    await expect(storage.delete(KEY, null as never)).rejects.toBeInstanceOf(ValidationError);
    expect(Array.from(await storage.getRange(KEY, 0, 3))).toEqual([1, 2, 3]);
  });
});

describe('the chunk source port refuses a ref with a key it does not take, on every method', () => {
  const source = new CrbmStorageChunkSource(new MemoryStorageDriver(), {
    registry: new MemoryRegistryDriver(),
  });
  const methods = [
    'cardinalities',
    'currentGeneration',
    'currentVersion',
    'exists',
    'invalidate',
    'listChunkKeys',
    'sizeOf',
    'stat',
    'summary',
  ] as const;
  it.each(methods)('%s', async (method) => {
    const call = source[method] as (ref: SegmentRef) => unknown;
    await expect(Promise.resolve().then(() => call.call(source, TYPO))).rejects.toThrow(
      'unknown key "namspace"',
    );
  });
  it('getChunk and getChunks', async () => {
    await expect(source.getChunk({ ...TYPO, chunkKey: 0 } as never)).rejects.toThrow(
      'unknown key "namspace"',
    );
    const drain = async (): Promise<void> => {
      for await (const chunk of source.getChunks!(TYPO, [0])) void chunk;
    };
    await expect(drain()).rejects.toThrow('unknown key "namspace"');
  });
});

describe('the GCS and Azure storage ports refuse a misspelt or mistyped delete option', () => {
  const quick = { retryOptions: { maxTries: 1, retryDelayInMs: 1, maxRetryDelayInMs: 2 } };

  it('GCS: nothing is sent, and the object stays', async () => {
    const stub = new StubGcsService();
    await stub.start();
    try {
      const storage = new GcsStorageDriver({
        storage: stub.client(),
        bucket: STUB_GCS_BUCKET,
        clock: { sleep: async () => {} },
      });
      await storage.putImmutable(KEY, bytes(new Uint8Array([1, 2, 3])));
      const { version } = await storage.getTail(KEY, 1);
      await expect(storage.delete(KEY, { ifVersoin: version } as never)).rejects.toThrow(
        'delete options does not take `ifVersoin`',
      );
      await expect(storage.delete(KEY, { ifVersion: 7 } as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(storage.delete(TYPO_GEN)).rejects.toThrow(KEYS);
      expect(stub.count('delete')).toBe(0);
      expect(Array.from(await storage.getRange(KEY, 0, 3))).toEqual([1, 2, 3]);
    } finally {
      await stub.stop();
    }
  });

  it('Azure Blob: no DELETE is sent, and the blob stays', async () => {
    const stub = new StubBlobService();
    await stub.start();
    try {
      const storage = new AzureBlobStorageDriver({ containerClient: stub.client(quick) });
      await storage.putImmutable(KEY, bytes(new Uint8Array([1, 2, 3])));
      const { version } = await storage.getTail(KEY, 1);
      await expect(storage.delete(KEY, { ifVersoin: version } as never)).rejects.toThrow(
        'delete options does not take `ifVersoin`',
      );
      await expect(storage.delete(KEY, { ifVersion: 7 } as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(storage.delete(TYPO_GEN)).rejects.toThrow(KEYS);
      expect(stub.count('DELETE')).toBe(0);
      expect(Array.from(await storage.getRange(KEY, 0, 3))).toEqual([1, 2, 3]);
    } finally {
      await stub.stop();
    }
  });
});

describe('driver-kit validateSegmentRef, called as a driver of your own calls it', () => {
  it('takes a generation key, a chunk ref and a registry row with no second argument', () => {
    expect(() => validateSegmentRef({ segment: 'a', generation: 1 } as never)).not.toThrow();
    expect(() => validateSegmentRef({ segment: 'a', chunkKey: 1 } as never)).not.toThrow();
    expect(() =>
      validateSegmentRef({ segment: 'a', currentGen: 1, status: 'active' } as never),
    ).not.toThrow();
    expect(() =>
      validateSegmentRef({ segment: 'a', generation: 1, namspace: 'x' } as never),
    ).toThrow('unknown key "namspace"');
  });

  it('a wrapping registry and a wrapping storage that validate then forward still run a load', async () => {
    const { CloudRoaring } = await import('@/index');
    const registry = new MemoryRegistryDriver();
    const storage = new MemoryStorageDriver();
    const wrapReg = Object.create(registry) as IRegistryDriver;
    for (const m of ['get', 'create', 'compareAndSwap', 'delete'] as const) {
      (wrapReg as unknown as Record<string, unknown>)[m] = (
        ref: SegmentRef,
        ...rest: unknown[]
      ) => {
        validateSegmentRef(ref);
        return (registry[m] as (...a: unknown[]) => unknown)(ref, ...rest);
      };
    }
    const wrapStore = Object.create(storage) as IStorageDriver;
    for (const m of ['putImmutable', 'getRange', 'getTail', 'delete'] as const) {
      (wrapStore as unknown as Record<string, unknown>)[m] = (key: GenKey, ...rest: unknown[]) => {
        validateSegmentRef(key);
        return (storage[m] as (...a: unknown[]) => unknown)(key, ...rest);
      };
    }
    const backend = { storage: wrapStore, registry: wrapReg };
    brandAsBackend(backend as never);
    const store = new CloudRoaring({ storage: backend as never });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    expect(await store.segment('a').count()).toBe(3);
  });
});

describe('a registry row is taken at the ports, and the list of its fields follows RegistryRecord', () => {
  it('a row from list() goes straight to registry.delete and storage.list, a misspelt extra key does not', async () => {
    const registry = new MemoryRegistryDriver();
    await registry.create({ segment: 'a' }, { currentGen: 0 });
    let row: RegistryRecord | undefined;
    for await (const r of registry.list()) row = r;
    expect(row).toBeDefined();
    const storage = new MemoryStorageDriver();
    await expect(storage.list(row!)[Symbol.asyncIterator]().next()).resolves.toBeDefined();
    await expect(registry.delete({ ...row!, namspace: 'eu' } as never)).rejects.toThrow(
      'unknown key "namspace"',
    );
    await registry.delete(row!);
    expect(await registry.get({ segment: 'a' })).toBeNull();
  });

  it('PORT_KEYS and REF_KEYS cover exactly the fields of RegistryRecord, a generation key and a chunk ref', () => {
    const fields: Record<keyof RegistryRecord, true> = {
      segment: true,
      namespace: true,
      currentGen: true,
      wrappedDeks: true,
      keyId: true,
      status: true,
      retention: true,
      residency: true,
      summary: true,
      knownGens: true,
      leases: true,
      createdAt: true,
      updatedAt: true,
      token: true,
      pointerId: true,
    };
    const taken = new Set<string>([...REF_KEYS, ...PORT_KEYS]);
    for (const k of Object.keys(fields)) expect(taken.has(k)).toBe(true);
    expect([...taken].filter((k) => !(k in fields)).sort()).toEqual(['chunkKey', 'generation']);
  });
});
