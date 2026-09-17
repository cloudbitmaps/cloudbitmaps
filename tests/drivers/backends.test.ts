import {
  CloudRoaring,
  LocalFsStorage,
  MemoryStorage,
  bulkLoadCrbmGeneration,
  nextGeneration,
} from '@/index';
import { S3Storage } from '@/s3/index';
import { GcsStorage } from '@/gcs/index';
import { AzureBlobStorage } from '@/azure/index';
import { ValidationError } from '@/core/errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A backend exists to state a location ONCE.
 *
 * The bug it removes is not hypothetical and not loud: wire the objects at one prefix and the registry at
 * another and the store constructs fine, reads fine, and answers **empty** — because the pointer it consults
 * lives somewhere nothing was ever written. "Empty" is indistinguishable from "new", so the misconfiguration
 * presents as an absence of data rather than as an error. These tests pin the property that makes it
 * unexpressible: both halves are built from one set of inputs, and you cannot hand them different ones.
 */
describe('a backend configures both halves from one place', () => {
  // The prefix is the half that actually causes the silent-empty bug, so assert it on BOTH halves rather
  // than assuming one config object means one answer — an earlier version of this test checked only the
  // shared client, and a mutant that handed the registry a different prefix sailed straight through it.
  it('S3Storage gives both halves the same client, bucket and prefix', () => {
    const backend = new S3Storage({ bucket: 'bitmaps', prefix: 'cr', region: 'us-east-1' });
    // The client is built once and shared — not one per half, which would also double the connection pool.
    expect((backend.storage as unknown as { client: unknown }).client).toBe(backend.client);
    expect((backend.registry as unknown as { store: { client: unknown } }).store.client).toBe(
      backend.client,
    );
    expect((backend.registry as unknown as { store: { bucket: string } }).store.bucket).toBe(
      'bitmaps',
    );
    // …and the prefix, read off each half, is the same string.
    expect((backend.storage as unknown as { prefix: string | undefined }).prefix).toBe('cr');
    expect((backend.registry as unknown as { prefix: string | undefined }).prefix).toBe('cr');
    expect(Object.keys(backend)).toEqual(expect.arrayContaining(['storage', 'registry', 'client']));
  });

  it('a prefix reaches both halves identically, for every cloud backend', () => {
    const halves = (b: { storage: unknown; registry: unknown }): [unknown, unknown] => [
      (b.storage as { prefix?: unknown }).prefix,
      (b.registry as { prefix?: unknown }).prefix,
    ];
    for (const [label, backend] of [
      ['S3', new S3Storage({ bucket: 'b', prefix: 'p' })],
      ['GCS', new GcsStorage({ bucket: 'b', prefix: 'p', apiEndpoint: 'http://127.0.0.1:4443' })],
    ] as const) {
      const [objectsPrefix, registryPrefix] = halves(backend);
      expect(objectsPrefix, `${label}: objects prefix`).toBe('p');
      expect(registryPrefix, `${label}: registry prefix`).toBe('p');
    }
  });

  it('S3Storage builds a client, or takes yours', () => {
    const built = new S3Storage({ bucket: 'b' });
    expect(built.client).toBeDefined();
    const mine = built.client;
    expect(new S3Storage({ bucket: 'b', client: mine }).client).toBe(mine);
  });

  it('GcsStorage builds its own client, so nobody writes `{ storage: storage }`', () => {
    const backend = new GcsStorage({ bucket: 'bitmaps', apiEndpoint: 'http://127.0.0.1:4443' });
    expect(backend.client).toBeDefined();
    expect((backend.storage as unknown as { storage: unknown }).storage).toBe(backend.client);
    expect((backend.registry as unknown as { store: { storage: unknown } }).store.storage).toBe(
      backend.client,
    );
  });

  it('AzureBlobStorage refuses a half-specified container rather than failing at the first read', () => {
    expect(() => new AzureBlobStorage({})).toThrow(ValidationError);
    expect(() => new AzureBlobStorage({ container: 'c' })).toThrow(ValidationError);
    expect(() => new AzureBlobStorage({ connectionString: 'x' })).toThrow(ValidationError);
  });

  it('every backend satisfies the port: both halves present and usable', () => {
    for (const backend of [new MemoryStorage(), new S3Storage({ bucket: 'b' })]) {
      expect(typeof backend.storage.putImmutable).toBe('function');
      expect(typeof backend.registry.compareAndSwap).toBe('function');
    }
  });
});

describe('a backend is all the wiring a store needs', () => {
  it('MemoryStorage round-trips a load through the facade with one option', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    await bulkLoadCrbmGeneration(backend.storage, { segment: 's', generation: 0 }, [1, 2, 70_000], {
      registry: backend.registry,
    });
    expect(await store.segment('s').count()).toBe(3);
    expect(await store.segment('s').has(70_000)).toBe(true);
  });

  it('LocalFsStorage puts generations and pointers under one root, in the layout the CLI expects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cbm-backend-'));
    try {
      const backend = new LocalFsStorage(root);
      const store = new CloudRoaring({ storage: backend });
      await bulkLoadCrbmGeneration(backend.storage, { segment: 's', generation: 0 }, [4, 5], {
        registry: backend.registry,
      });
      expect(await store.segment('s').count()).toBe(2);
      // The layout is the class's to own — the CLI reads exactly these two directories.
      const { readdir } = await import('node:fs/promises');
      expect((await readdir(root)).sort()).toEqual(['registry', 'storage']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The half is named `storage` rather than `objects` precisely so that a backend IS, structurally, the
  // `{ storage, registry }` deps object every free function already takes. Without this a caller has to
  // destructure it at every call, which is the friction the class exists to remove.
  it('is accepted directly as the deps object by the free functions', async () => {
    const backend = new MemoryStorage();
    const ref = { segment: 'direct' };
    expect(await nextGeneration(ref, backend)).toBe(0);
    await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, [1, 2], {
      registry: backend.registry,
    });
    expect(await nextGeneration(ref, backend)).toBe(1);
  });

  it('a raw driver still works, and is read-only-cleartext because it has no pointer', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { segment: 's', generation: 0 }, [9], {
      registry: backend.registry,
    });
    // Handed only the objects, the store has no registry and resolves by list-scan. Reads work…
    const readOnly = new CloudRoaring({ storage: backend.storage });
    expect(await readOnly.segment('s').count()).toBe(1);
    // …and the verbs that must publish through a pointer say so, rather than half-working.
    await expect(readOnly.dropSegment({ segment: 's' }, { confirmSegment: 's' })).rejects.toThrow(
      /registry/i,
    );
  });
});
