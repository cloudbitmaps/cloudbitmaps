import { nextGeneration } from '@/core/generation-gc';
import { CloudRoaring, LocalFsStorage, MemoryStorage } from '@/index';
import { S3Storage } from '@cloudbitmaps/s3';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { GCS_STORAGE_OPTION_KEYS } from '@/gcs/backend';
import { S3_STORAGE_OPTION_KEYS } from '@/s3/backend';
import { AZURE_BLOB_STORAGE_OPTION_KEYS } from '@/azure-blob/backend';

import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { ValidationError } from '@/core/errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SameKeys } from '../helpers/types';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

// Azurite's fixed, publicly-documented dev account + key (not a secret — the same value ships in every SDK).
// Constructing a client parses this string but talks to nothing, which is all these wiring tests need.
const AZURITE_CONN =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
  'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
  'BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

/**
 * A backend exists to state a location ONCE.
 *
 * The failure it prevents is quiet: wire the objects at one prefix and the registry at another and the
 * store constructs fine, reads fine, and answers **empty** — because the pointer it consults
 * lives somewhere nothing was ever written. "Empty" is indistinguishable from "new", so the misconfiguration
 * presents as an absence of data rather than as an error. These tests pin the property that makes it
 * unexpressible: both halves are built from one set of inputs, and you cannot hand them different ones.
 */
describe('a backend configures both halves from one place', () => {
  // The prefix is the half that actually causes the silent-empty failure, so assert it on BOTH halves rather
  // than assuming one config object means one answer — a test that checks only the shared client passes a
  // mutant that hands the registry a different prefix.
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
      // Azure is checked here because the Azurite integration run cannot catch a mutant pointing its registry
      // at a different prefix: that test writes and reads through the same mismatched registry, so a uniform
      // prefix error is invisible to it. This is the single failure mode the backend shape exists to make
      // unexpressible, so it is asserted on every cloud, not most.
      [
        'Azure',
        new AzureBlobStorage({ connectionString: AZURITE_CONN, container: 'c', prefix: 'p' }),
      ],
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

  // `GcsStorageDriver` takes the GCS client as `storage`, and `GcsStorage` takes it as `client`. An ignored
  // client key would fall back to ambient credentials and the PUBLIC endpoint, so a user pointed at
  // fake-gcs-server would silently start talking to production: every key GcsStorage does not take is refused.
  it('GcsStorage refuses a key it does not take, `storage` among them, instead of ignoring it', () => {
    const client = new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443' }).client;
    const build = (options: object) => () => new GcsStorage(options as { bucket: string });
    expect(build({ bucket: 'b', storage: client })).toThrow(ValidationError);
    expect(build({ bucket: 'b', storage: client })).toThrow(
      /does not take `storage`.*goes in `client`/,
    );
    expect(build({ bucket: 'b', endpoint: 'http://x' })).toThrow(/`endpoint`/);
    expect(build({ bucket: 'b', client, prefix: 'p', projectId: 'x', now: () => 0 })).not.toThrow();
  });

  it('S3Storage and AzureBlobStorage refuse a key they do not take, and every backend a bag that is not an object', () => {
    const s3 = (options: object) => () => new S3Storage(options as { bucket: string });
    expect(s3({ bucket: 'b', s3Client: {} })).toThrow(
      /S3Storage does not take `s3Client`.*goes in `client`/,
    );
    expect(s3({ bucket: 'b', forcePathStyle: true })).toThrow(/`forcePathStyle`/);
    expect(
      s3({ bucket: 'b', region: 'us-east-1', pathStyle: true, prefix: 'p', now: () => 0 }),
    ).not.toThrow();
    const azure = (options: object) => () => new AzureBlobStorage(options);
    expect(azure({ connectionString: 'x', container: 'c', client: {} })).toThrow(
      /AzureBlobStorage does not take `client`.*goes in `containerClient`/,
    );
    for (const bad of [undefined, null, 'b']) {
      expect(() => new S3Storage(bad as unknown as { bucket: string })).toThrow(ValidationError);
      expect(() => new GcsStorage(bad as unknown as { bucket: string })).toThrow(ValidationError);
      expect(() => new AzureBlobStorage(bad as unknown as object)).toThrow(ValidationError);
    }
  });

  it('each cloud backend takes exactly the keys its options interface declares (checked by the compiler)', () => {
    const agree: {
      readonly s3: SameKeys<
        (typeof S3_STORAGE_OPTION_KEYS)[number],
        keyof ConstructorParameters<typeof S3Storage>[0]
      >;
      readonly gcs: SameKeys<
        (typeof GCS_STORAGE_OPTION_KEYS)[number],
        keyof ConstructorParameters<typeof GcsStorage>[0]
      >;
      readonly azure: SameKeys<
        (typeof AZURE_BLOB_STORAGE_OPTION_KEYS)[number],
        keyof NonNullable<ConstructorParameters<typeof AzureBlobStorage>[0]>
      >;
    } = { s3: true, gcs: true, azure: true };
    expect(Object.values(agree).every(Boolean)).toBe(true);
  });

  it('AzureBlobStorage refuses a half-specified container rather than failing at the first read', () => {
    expect(() => new AzureBlobStorage({})).toThrow(ValidationError);
    expect(() => new AzureBlobStorage({ container: 'c' })).toThrow(ValidationError);
    expect(() => new AzureBlobStorage({ connectionString: 'x' })).toThrow(ValidationError);
  });

  // `now` exists so tests and replayable jobs can pin the clock. It is threaded to the REGISTRY half (the
  // half that stamps rows), and a backend that quietly drops it passes every other suite and produces
  // unreproducible timestamps later — the defect that only shows up as flake. So every backend is checked, no
  // exceptions.
  it('threads an injected `now` to the registry half of every backend', async () => {
    const now = (): number => 1_700_000_000_000;
    const dir = await mkdtemp(join(tmpdir(), 'cbm-now-'));
    try {
      const cloudRegistryNow = (b: { registry: unknown }): unknown =>
        (b.registry as { now?: unknown }).now;
      expect(cloudRegistryNow(new S3Storage({ bucket: 'b', now })), 'S3').toBe(now);
      expect(
        cloudRegistryNow(
          new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443', now }),
        ),
        'GCS',
      ).toBe(now);
      expect(
        cloudRegistryNow(
          new AzureBlobStorage({ connectionString: AZURITE_CONN, container: 'c', now }),
        ),
        'Azure',
      ).toBe(now);

      // Memory and LocalFs hold the clock differently, so assert the OBSERVABLE effect rather than the field:
      // the timestamp actually stamped on a row.
      for (const [label, backend] of [
        ['Memory', new MemoryStorage({ now })],
        ['LocalFs', new LocalFsStorage(dir, { now })],
      ] as const) {
        const ref = { segment: 'clock-check' };
        await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, [1], {
          registry: backend.registry,
        });
        const row = await backend.registry.get(ref);
        expect(row?.createdAt, `${label}: createdAt`).toBe(1_700_000_000_000);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A containerClient already names the account and the container. Accepting a contradicting
  // `container` alongside it and silently keeping one of them points the store at a container nobody asked
  // for — the same silent-empty failure the backend shape exists to remove, just one level up.
  it('AzureBlobStorage refuses a containerClient AND a container/connectionString', () => {
    const client = new AzureBlobStorage({
      connectionString: AZURITE_CONN,
      container: 'c',
    }).containerClient;
    expect(() => new AzureBlobStorage({ containerClient: client, container: 'other' })).toThrow(
      ValidationError,
    );
    expect(
      () => new AzureBlobStorage({ containerClient: client, connectionString: AZURITE_CONN }),
    ).toThrow(ValidationError);
    expect(() => new AzureBlobStorage({ containerClient: client })).not.toThrow();
  });

  it('every backend satisfies the port: both halves present and usable', () => {
    for (const backend of [
      new MemoryStorage(),
      new S3Storage({ bucket: 'b' }),
      new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443' }),
      new AzureBlobStorage({ connectionString: AZURITE_CONN, container: 'c' }),
    ]) {
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
    // The message must name what to DO — build the store on a backend — rather than send the reader to add a
    // `registry` key, which TypeScript rejects.
    await expect(readOnly.dropSegment({ segment: 's' }, { confirmSegment: 's' })).rejects.toThrow(
      /needs a storage backend/,
    );
  });
});
