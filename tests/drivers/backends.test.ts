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
    expect(build({ bucket: 'b', client, prefix: 'p', now: () => 0 })).not.toThrow();
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

  // The size settings are options of the backend, and the backend hands them to the storage half, which is the
  // one that writes the objects. Each is read back off the half's advertised ceiling or its write threshold.
  it('S3Storage takes maxObjectBytes and partBytes and gives them to its storage half', () => {
    const MIB = 1024 * 1024;
    expect(new S3Storage({ bucket: 'b' }).storage.capabilities().maxObjectBytes).toBe(
      8 * MIB * 10_000,
    );
    const sized = new S3Storage({ bucket: 'b', partBytes: 5 * MIB, maxObjectBytes: 1234 });
    expect(sized.storage.capabilities().maxObjectBytes).toBe(1234);
    expect((sized.storage as unknown as { partBytes: number }).partBytes).toBe(5 * MIB);
    // The default ceiling follows the part size it is given.
    expect(
      new S3Storage({ bucket: 'b', partBytes: 5 * MIB }).storage.capabilities().maxObjectBytes,
    ).toBe(5 * MIB * 10_000);
  });

  it('GcsStorage takes maxObjectBytes and simpleUploadThresholdBytes and gives them to its storage half', () => {
    const opts = { bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443' };
    expect(new GcsStorage(opts).storage.capabilities().maxObjectBytes).toBe(5 * 1024 ** 4);
    const sized = new GcsStorage({ ...opts, maxObjectBytes: 1234, simpleUploadThresholdBytes: 7 });
    expect(sized.storage.capabilities().maxObjectBytes).toBe(1234);
    expect((sized.storage as unknown as { threshold: number }).threshold).toBe(7);
  });

  it('AzureBlobStorage takes maxObjectBytes and blockBytes, gives them to its storage half, and refuses a bad one', () => {
    const opts = { connectionString: AZURITE_CONN, container: 'c' };
    expect(new AzureBlobStorage(opts).storage.capabilities().maxObjectBytes).toBe(
      8 * 1024 * 1024 * 50_000,
    );
    const sized = new AzureBlobStorage({ ...opts, blockBytes: 4, maxObjectBytes: 1234 });
    expect(sized.storage.capabilities().maxObjectBytes).toBe(1234);
    expect((sized.storage as unknown as { blockBytes: number }).blockBytes).toBe(4);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new AzureBlobStorage({ ...opts, blockBytes: bad })).toThrow(ValidationError);
      expect(() => new AzureBlobStorage({ ...opts, maxObjectBytes: bad })).toThrow(ValidationError);
    }
  });

  it('a size setting that is not a positive safe integer is refused by name, on every backend', () => {
    const bads = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      '8' as unknown as number,
    ];
    const s3 = { bucket: 'b' };
    const gcs = { bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443' };
    const azure = { connectionString: AZURITE_CONN, container: 'c' };
    for (const bad of bads) {
      expect(() => new S3Storage({ ...s3, partBytes: bad })).toThrow(/partBytes must be/);
      expect(() => new S3Storage({ ...s3, maxObjectBytes: bad })).toThrow(/maxObjectBytes must be/);
      expect(() => new GcsStorage({ ...gcs, maxObjectBytes: bad })).toThrow(
        /maxObjectBytes must be/,
      );
      expect(() => new GcsStorage({ ...gcs, simpleUploadThresholdBytes: bad })).toThrow(
        /simpleUploadThresholdBytes must be/,
      );
      expect(() => new AzureBlobStorage({ ...azure, blockBytes: bad })).toThrow(
        /blockBytes must be/,
      );
      expect(() => new AzureBlobStorage({ ...azure, maxObjectBytes: bad })).toThrow(
        /maxObjectBytes must be/,
      );
    }
    for (const fn of [
      () => new S3Storage({ ...s3, partBytes: Number.NaN }),
      () => new GcsStorage({ ...gcs, simpleUploadThresholdBytes: 0 }),
    ]) {
      expect(fn).toThrow(ValidationError);
    }
  });

  it('S3Storage raises a small partBytes to the 5 MiB floor and grows it to cover maxObjectBytes in 10,000 parts', () => {
    const MIB = 1024 * 1024;
    const part = (o: object) =>
      (new S3Storage({ bucket: 'b', ...o }).storage as unknown as { partBytes: number }).partBytes;
    expect(part({ partBytes: 1 })).toBe(5 * MIB);
    expect(part({ partBytes: 1, maxObjectBytes: 1 })).toBe(5 * MIB);
    expect(part({ partBytes: 5 * MIB, maxObjectBytes: 100 * MIB * 10_000 })).toBe(100 * MIB);
  });

  it('a size setting that belongs to another backend is still refused by name', () => {
    const s3 = (options: object) => () => new S3Storage(options as { bucket: string });
    expect(s3({ bucket: 'b', blockBytes: 1 })).toThrow(/does not take `blockBytes`/);
    expect(s3({ bucket: 'b', simpleUploadThresholdBytes: 1 })).toThrow(
      /`simpleUploadThresholdBytes`/,
    );
    const gcs = (options: object) => () => new GcsStorage(options as { bucket: string });
    expect(gcs({ bucket: 'b', partBytes: 1 })).toThrow(/does not take `partBytes`/);
    const azure = (options: object) => () => new AzureBlobStorage(options);
    expect(
      azure({ connectionString: AZURITE_CONN, container: 'c', simpleUploadThresholdBytes: 1 }),
    ).toThrow(/does not take `simpleUploadThresholdBytes`/);
  });

  // A supplied client already carries its own region, endpoint, addressing and credentials (S3), or project and
  // endpoint (GCS). A setting beside it would be ignored, which sends an `endpoint` meant for MinIO, or an
  // `apiEndpoint` meant for an emulator, to a client that talks to production. Each such key is refused and
  // named, as AzureBlobStorage refuses `connectionString` / `container` beside `containerClient`.
  describe('a client carries its own connection settings, so none may be given beside it', () => {
    const s3Settings = {
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      pathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      maxSockets: 64,
    } as const;
    const gcsSettings = { projectId: 'p', apiEndpoint: 'http://127.0.0.1:4443' } as const;
    const s3Client = new S3Storage({ bucket: 'b' }).client;
    const gcsClient = new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:4443' }).client;
    const s3 = (options: object) => () => new S3Storage({ bucket: 'b', ...options });
    const gcs = (options: object) => () => new GcsStorage({ bucket: 'b', ...options });

    for (const [key, value] of Object.entries(s3Settings)) {
      it(`S3Storage refuses \`${key}\` beside \`client\`, names it, and says the client carries it`, () => {
        const build = s3({ client: s3Client, [key]: value });
        expect(build).toThrow(ValidationError);
        expect(build).toThrow(new RegExp(`with \`${key}\`; the \`client\` already carries them`));
        // …and only that key is named: the others were not given.
        for (const other of Object.keys(s3Settings).filter((k) => k !== key)) {
          expect(build).not.toThrow(new RegExp(`with .*\`${other}\`; `));
        }
        // …while the same key without a client still builds one.
        expect(s3({ [key]: value })).not.toThrow();
      });
    }

    for (const [key, value] of Object.entries(gcsSettings)) {
      it(`GcsStorage refuses \`${key}\` beside \`client\`, names it, and says the client carries it`, () => {
        const build = gcs({ client: gcsClient, [key]: value });
        expect(build).toThrow(ValidationError);
        expect(build).toThrow(new RegExp(`with \`${key}\`; the \`client\` already carries them`));
        for (const other of Object.keys(gcsSettings).filter((k) => k !== key)) {
          expect(build).not.toThrow(new RegExp(`with .*\`${other}\`; `));
        }
        expect(gcs({ [key]: value })).not.toThrow();
      });
    }

    it('several settings beside a client are all named', () => {
      expect(s3({ client: s3Client, ...s3Settings })).toThrow(
        /with `region`, `endpoint`, `pathStyle`, `credentials`, `maxSockets`; the `client` already carries them/,
      );
      expect(s3({ client: s3Client, region: 'x', credentials: s3Settings.credentials })).toThrow(
        /with `region`, `credentials`;/,
      );
      expect(gcs({ client: gcsClient, ...gcsSettings })).toThrow(
        /with `projectId`, `apiEndpoint`; the `client` already carries them/,
      );
    });

    it('the message says what to do: configure the client, or drop `client`', () => {
      expect(s3({ client: s3Client, region: 'x' })).toThrow(
        /configure them on the client, or drop `client`/,
      );
      expect(gcs({ client: gcsClient, projectId: 'x' })).toThrow(
        /configure them on the client, or drop `client`/,
      );
    });

    it('a client alone, and the keys the backend itself uses beside it, are taken', () => {
      const now = () => 0;
      expect(s3({ client: s3Client })).not.toThrow();
      expect(s3({ client: s3Client, prefix: 'p', now })).not.toThrow();
      expect(gcs({ client: gcsClient })).not.toThrow();
      expect(gcs({ client: gcsClient, prefix: 'p', now })).not.toThrow();
      // A key set to `undefined` is absent, as it is for AzureBlobStorage's `containerClient`.
      expect(s3({ client: s3Client, region: undefined, credentials: undefined })).not.toThrow();
      expect(
        gcs({ client: gcsClient, projectId: undefined, apiEndpoint: undefined }),
      ).not.toThrow();
      expect(new S3Storage({ bucket: 'b', client: s3Client }).client).toBe(s3Client);
      expect(new GcsStorage({ bucket: 'b', client: gcsClient }).client).toBe(gcsClient);
    });

    it('a `client` of null is no client, as it was before: the store builds one from the settings', () => {
      // `S3Client | undefined` is the declared type, but a plain-JS caller can pass null, which `??` treated as absent.
      expect(s3({ client: null, ...s3Settings })).not.toThrow();
      expect(gcs({ client: null, ...gcsSettings })).not.toThrow();
      expect(new S3Storage({ bucket: 'b', client: null as never }).client).toBeTruthy();
      expect(new GcsStorage({ bucket: 'b', client: null as never }).client).toBeTruthy();
    });

    it('an unknown key is reported before a setting beside a client', () => {
      expect(s3({ client: s3Client, region: 'x', bogus: 1 })).toThrow(/does not take `bogus`/);
      expect(gcs({ client: gcsClient, projectId: 'x', bogus: 1 })).toThrow(/does not take `bogus`/);
    });

    it('a built client takes every setting without a client', () => {
      expect(s3({ ...s3Settings })).not.toThrow();
      expect(gcs({ ...gcsSettings })).not.toThrow();
    });
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

  it('a containerClient of null is no containerClient: the settings build one, and without them it is refused up front', () => {
    // `ContainerClient | undefined` is the declared type, but a plain-JS caller can pass null, as for S3 and GCS.
    const nul = (options: object) => () => new AzureBlobStorage(options);
    expect(
      nul({ containerClient: null, connectionString: AZURITE_CONN, container: 'c' }),
    ).not.toThrow();
    expect(nul({ containerClient: null })).toThrow(/needs either `containerClient`/);
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

describe('a backend refuses settings it can never honour, when it is built', () => {
  const TiB = 1024 ** 4;
  const MiB = 1024 ** 2;
  const s3 = (o: object) => () => new S3Storage({ region: 'us-east-1', ...o } as never);
  const gcs = (o: object) => () =>
    new GcsStorage({ apiEndpoint: 'http://127.0.0.1:4443', ...o } as never);
  const azure = (o: object) => () =>
    new AzureBlobStorage({ connectionString: AZURITE_CONN, container: 'c', ...o } as never);

  it('a bucket that is not a non-empty string', () => {
    for (const bucket of [undefined, '', 5, null]) {
      expect(s3({ bucket })).toThrow(ValidationError);
      expect(gcs({ bucket })).toThrow(ValidationError);
    }
  });

  it('a `now` that is not a function', () => {
    expect(s3({ bucket: 'b', now: 5 })).toThrow(/`now` must be a function/);
    expect(gcs({ bucket: 'b', now: 'today' })).toThrow(/`now` must be a function/);
    expect(azure({ now: {} })).toThrow(/`now` must be a function/);
    expect(s3({ bucket: 'b', now: () => 1 })).not.toThrow();
  });

  it("a size past the service's own limit", () => {
    expect(gcs({ bucket: 'b', maxObjectBytes: 5 * TiB + 1 })).toThrow(/5 TiB object limit/);
    expect(azure({ blockBytes: 4000 * MiB + 1 })).toThrow(/4,000 MiB block limit/);
    expect(azure({ maxObjectBytes: Number.MAX_SAFE_INTEGER })).toThrow(/blocks of 4,000 MiB/);
    expect(azure({ blockBytes: 4000 * MiB })).not.toThrow();
  });
});
