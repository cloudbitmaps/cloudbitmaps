import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { loadSegment } from '@/core/load';
import { ValidationError, WriteConflictError, errorKind } from '@/core/errors';
import type { BlobSink } from '@/core/blob';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { GcsStorageDriver } from '@/gcs/storage';
import { roaringCodec } from '@/native-codec';
import { S3StorageDriver } from '@/s3/storage';
import { StubBlobService } from '../helpers/azure-blob-stub';
import { counterEntropy } from '../helpers/entropy';
import { STUB_GCS_BUCKET, StubGcsService } from '../helpers/gcs-stub';
import { STUB_BUCKET, StubS3Bucket } from '../helpers/s3-bucket-stub';

/**
 * A sorted load reads its ids while the object uploads, so an error the caller's ids raise leaves through the storage
 * driver's upload, and every driver maps the errors its upload meets: a cloud driver reads a 409 or a 412 as a lost
 * write-once race, which a load then reports as `published: false, reason: 'superseded'`, and a connection reset or a
 * throttle as a transient fault, copied onto a `TransientError`. A caller's database error shaped like one of those
 * would be swallowed as a lost race or reported as a storage fault. The load hands the caller the very error its ids
 * raised instead, on every driver, and the refusal of an id out of order the same way.
 *
 * The cloud drivers run their real SDK clients over the in-repo stubs: S3's over a stub transport, with no socket, and
 * GCS's and Azure Blob's over a stub service on the loopback interface. Nothing reaches a cloud.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const INSTANT = { sleep: async () => undefined };

/** Errors a caller's own source can throw that look like what each driver maps, and values that are not errors. */
const SHAPES: Record<string, () => unknown> = {
  '409 conflict': () =>
    Object.assign(new Error('the warehouse query conflicted'), {
      name: 'ConditionalRequestConflict',
      code: 409,
      statusCode: 409,
      status: 409,
      $metadata: { httpStatusCode: 409 },
    }),
  '412 precondition': () =>
    Object.assign(new Error('the warehouse precondition failed'), {
      name: 'PreconditionFailed',
      code: 412,
      statusCode: 412,
      status: 412,
      $metadata: { httpStatusCode: 412 },
    }),
  ECONNRESET: () =>
    Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      errno: -54,
      syscall: 'read',
    }),
  // The library's own lost race, from another call the source made: the load would read it as its own otherwise.
  'WriteConflictError of its own': () => new WriteConflictError('another store lost a race'),
  SlowDown: () =>
    Object.assign(new Error('please reduce your request rate'), {
      name: 'SlowDown',
      code: 503,
      statusCode: 503,
      $metadata: { httpStatusCode: 503 },
    }),
  // Not an Error at all: a plain object shaped like an SDK's conflict, a string, and nothing.
  'plain object shaped like a 409': () => ({
    name: 'ConditionalRequestConflict',
    code: 409,
    statusCode: 409,
    $metadata: { httpStatusCode: 409 },
  }),
  string: () => 'the warehouse query conflicted',
  undefined: () => undefined,
};

/**
 * `storage`, recording what each write it is handed threw, which is what the driver's error mapping meets. Every
 * other member is the driver's own.
 */
function recording(storage: IStorageDriver): { storage: IStorageDriver; met: unknown[] } {
  const met: unknown[] = [];
  const wrapped = new Proxy(storage, {
    get(target, prop) {
      if (prop === 'putImmutable') {
        return (key: GenKey, write: (sink: BlobSink) => Promise<void>) =>
          target.putImmutable(key, (sink) =>
            write(sink).catch((err: unknown) => {
              met.push(err);
              throw err;
            }),
          );
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, met };
}

interface Backend {
  readonly storage: IStorageDriver;
  /** How many requests the backend's service has received, for a cloud backend. */
  readonly sent?: () => number;
  close(): Promise<void>;
}

const BACKENDS: Record<string, () => Promise<Backend>> = {
  S3: async () => {
    const bucket = new StubS3Bucket();
    return {
      storage: new S3StorageDriver({
        client: bucket.client(),
        bucket: STUB_BUCKET,
        clock: INSTANT,
      }),
      sent: () => bucket.sent.length,
      close: async () => undefined,
    };
  },
  GCS: async () => {
    const stub = new StubGcsService();
    await stub.start();
    return {
      storage: new GcsStorageDriver({
        storage: stub.client(),
        bucket: STUB_GCS_BUCKET,
        clock: INSTANT,
      }),
      sent: () => stub.sent.length,
      close: () => stub.stop(),
    };
  },
  'Azure Blob': async () => {
    const stub = new StubBlobService();
    await stub.start();
    const quick = { retryOptions: { maxTries: 1, retryDelayInMs: 1, maxRetryDelayInMs: 2 } };
    return {
      storage: new AzureBlobStorageDriver({ containerClient: stub.client(quick) }),
      sent: () => stub.requests.length,
      close: () => stub.stop(),
    };
  },
  LocalFs: async () => {
    const root = await mkdtemp(join(tmpdir(), 'cb-sorted-'));
    return {
      storage: new LocalFsStorageDriver(root),
      close: () => rm(root, { recursive: true, force: true }),
    };
  },
  Memory: async () => ({ storage: new MemoryStorageDriver(), close: async () => undefined }),
};

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out;
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (result) => ({ resolved: result }),
    (e: unknown) => e,
  );
}

describe.each(Object.keys(BACKENDS))('a sorted load on %s', (name) => {
  let backend: Backend;
  beforeEach(async () => {
    backend = await BACKENDS[name]!();
  });
  afterEach(async () => {
    await backend.close();
  });

  const deps = () => ({
    storage: backend.storage,
    registry: new MemoryRegistryDriver(),
    entropy: counterEntropy(),
    codec: roaringCodec,
  });

  it.each(Object.keys(SHAPES))(
    'throws the very value its ids raised (%s), which the driver never meets, and writes nothing',
    async (shape) => {
      const raised = SHAPES[shape]!();
      async function* ids(): AsyncGenerator<number> {
        for (let i = 0; i < 2_000; i++) yield i * 70_000;
        throw raised;
      }
      const { storage, met } = recording(backend.storage);
      const d = { ...deps(), storage };
      expect(await thrown(loadSegment(SEG, ids(), d, { sorted: true }))).toBe(raised);
      // The driver met the load's own sentinel, an Error with no fields of the caller's.
      expect(met).toHaveLength(1);
      expect(met[0]).not.toBe(raised);
      expect(met[0]).toBeInstanceOf(Error);
      expect(Object.keys(met[0] as Error)).toEqual([]);
      expect(await generations(backend.storage)).toEqual([]);
      expect(await d.registry.get(SEG)).toBeNull();
    },
  );

  it("leaves the caller's error as it was thrown, every field of it, and sends nothing for it", async () => {
    // A plain error twice first: the control, after the one-off requests a driver makes on its first load.
    const shapes = [
      () => new Error('a plain error, the warm-up'),
      () => new Error('a plain error, the control'),
      () =>
        Object.assign(new Error('the warehouse answered 503'), {
          // Credential-shaped fields, which a driver's scrubber redacts on an error it maps.
          headers: { 'x-api-key': 'caller-key' },
          config: { password: 'caller-password' },
        }),
      // Shaped like a missing object, which the GCS driver would answer by checking its bucket.
      () => Object.assign(new Error('the warehouse row is gone'), { code: 404, status: 404 }),
    ];
    const requests: number[] = [];
    for (const make of shapes) {
      const raised = make();
      const as = make();
      async function* ids(): AsyncGenerator<number> {
        yield 1;
        yield 70_000;
        throw raised;
      }
      const before = backend.sent?.() ?? 0;
      expect(await thrown(loadSegment(SEG, ids(), deps(), { sorted: true }))).toBe(raised);
      requests.push((backend.sent?.() ?? 0) - before);
      expect(raised.message).toBe(as.message);
      expect({ ...raised }).toEqual({ ...as });
    }
    // The load's own requests (its numbering's listing) and no more: none of the driver's answers to an error.
    expect(requests.slice(1)).toEqual([requests[1], requests[1], requests[1]]);
  });

  it.each([
    ['a chunk the next id closes', 3],
    ['the last chunk', 4],
  ])(
    "throws the codec's own error when building %s fails, as the codec raised it",
    async (_, at) => {
      const failure = Object.assign(new Error('the codec could not build a chunk'), {
        $metadata: { httpStatusCode: 503 },
        code: 'ECONNRESET',
      });
      let made = 0;
      const codec = {
        ...roaringCodec,
        fromValues: (values: Iterable<number>) => {
          if (++made === at) throw failure;
          return roaringCodec.fromValues(values);
        },
      };
      const ids = [1, 70_000, 140_000, 210_000];
      expect(await thrown(loadSegment(SEG, ids, { ...deps(), codec }, { sorted: true }))).toBe(
        failure,
      );
      expect(await generations(backend.storage)).toEqual([]);
    },
  );

  it('throws the very error a sync source raised', async () => {
    const raised = SHAPES['409 conflict']!();
    function* ids(): Generator<number> {
      yield 1;
      yield 2;
      throw raised;
    }
    expect(await thrown(loadSegment(SEG, ids(), deps(), { sorted: true }))).toBe(raised);
  });

  it('throws its own refusal of an id out of order as the ValidationError it raised', async () => {
    const err = await thrown(loadSegment(SEG, [1, 2, 70_000, 3], deps(), { sorted: true }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(errorKind(err)).toBe('ValidationError');
    expect((err as Error).message).toMatch(/^ids\[3\]: lower than the id before it/);
    expect((err as Error).cause).toBeUndefined();
    expect(await generations(backend.storage)).toEqual([]);
  });

  it('writes and publishes when its ids raise nothing', async () => {
    const r = await loadSegment(SEG, [1, 2, 70_000], deps(), { sorted: true });
    expect(r).toMatchObject({ published: true, cardinality: 3, chunkCount: 2 });
    expect(await generations(backend.storage)).toEqual([r.generation]);
  });
});

describe('a sorted load on S3 that fails after its parts went up', () => {
  it('throws the error its ids raised, aborts the upload and leaves no object', async () => {
    const bucket = new StubS3Bucket();
    const storage = new S3StorageDriver({
      client: bucket.client(),
      bucket: STUB_BUCKET,
      clock: INSTANT,
      partBytes: 5 * 1024 * 1024,
    });
    const raised = SHAPES['409 conflict']!();
    // Array containers of 4,096 ids two apart (8 KiB each, no runs to compress): about 11 MiB before the error, so two
    // parts are uploaded first.
    async function* ids(): AsyncGenerator<number> {
      for (let chunk = 0; chunk < 1_400; chunk++) {
        for (let i = 0; i < 4_096; i++) yield chunk * 65_536 + 2 * i;
      }
      throw raised;
    }
    const d = {
      storage,
      registry: new MemoryRegistryDriver(),
      entropy: counterEntropy(),
      codec: roaringCodec,
    };
    expect(await thrown(loadSegment(SEG, ids(), d, { sorted: true }))).toBe(raised);
    expect(bucket.count('UploadPart')).toBeGreaterThanOrEqual(2);
    expect(bucket.count('AbortMultipartUpload')).toBe(1);
    expect(bucket.count('CompleteMultipartUpload')).toBe(0);
    expect([...bucket.objects.keys()].filter((k) => k.includes('/segments/'))).toEqual([]);
  });
});
