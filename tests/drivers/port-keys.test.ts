import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError, WriteConflictError } from '@/core/errors';
import type { BlobSink } from '@/core/blob';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';
import { S3StorageDriver } from '@/s3/storage';
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
const KEYS =
  /unknown key "namspace" in the segment ref; it takes \{ segment, namespace, generation, chunkKey \}/;
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
