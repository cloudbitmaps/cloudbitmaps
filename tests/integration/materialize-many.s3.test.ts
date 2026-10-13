import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import roaring from 'roaring';
import { S3Storage } from '@cloudbitmaps/s3';
import { CloudRoaring, WriteConflictError } from '@/index';
import type { MaterializeResult } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver } from '@/core/ports';

const { RoaringBitmap32 } = roaring;

// Runs against MinIO from docker-compose: `docker compose up -d` then `pnpm test:integration`.
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = 'cloudbitmaps-it';
const RUN =
  process.env.GITHUB_RUN_ID === undefined
    ? randomUUID().slice(0, 8)
    : `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});

beforeAll(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListBucketsCommand({}));
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
});

/** Pseudo-random ids over 2^27, so a few million of them fill 2,048 chunks with arrays a few KiB each. */
function spread(count: number, seed: number): InstanceType<typeof RoaringBitmap32> {
  const b = new RoaringBitmap32();
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    b.add(x >>> 5);
  }
  return b;
}

const published = (o: unknown): MaterializeResult => {
  expect((o as MaterializeResult).published).toBe(true);
  return o as MaterializeResult;
};

describe('materializeMany against S3 (MinIO)', () => {
  it('publishes outputs over one multipart part, byte for byte what a load of the ids writes, and loses a race typed', async () => {
    const storage = new S3Storage({
      bucket: BUCKET,
      prefix: `${RUN}/many`,
      endpoint: ENDPOINT,
      pathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    let race: (() => Promise<void>) | undefined;
    const registry = new Proxy(storage.registry, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== 'compareAndSwap' || typeof value !== 'function') return value;
        return async (ref: { segment: string }, ...rest: unknown[]) => {
          if (ref.segment === 'raced' && race !== undefined) {
            const go = race;
            race = undefined;
            await go();
          }
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, ref, ...rest);
        };
      },
    }) as IRegistryDriver;
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: storage.storage, registry }),
      cache: { genTtlMs: 0 },
    });
    const other = new CloudRoaring({ storage });
    const a = spread(3_000_000, 1);
    const b = spread(3_000_000, 2);
    const small = spread(20_000, 3);
    await store.load({ segment: 'a' }, { bitmap: a });
    await store.load({ segment: 'b' }, { bitmap: b });
    await store.load({ segment: 'small' }, { bitmap: small });
    await store.load({ segment: 'raced' }, { bitmap: small });
    const union = RoaringBitmap32.from(a.toArray());
    union.orInPlace(b);
    const s = (n: string) => store.segment(n);
    race = async () => {
      await other.load({ segment: 'raced' }, { bitmap: spread(10, 9) });
    };
    const run = await store.materializeMany({
      operands: { a: s('a'), b: s('b'), small: s('small') },
      outputs: [
        { dest: s('big'), expr: { or: ['a', 'b'] } },
        { dest: s('inter'), expr: { and: ['a', 'b'] } },
        { dest: s('tiny'), expr: { and: ['small', 'a'] } },
        { dest: s('raced'), expr: 'small' },
      ],
      keep: 1,
    });
    const big = published(run.outputs[0]);
    expect(big.size).toBeGreaterThan(8 * 1024 * 1024);
    published(run.outputs[1]);
    published(run.outputs[2]);
    expect(run.outputs[3]).toMatchObject({
      published: false,
      error: expect.any(WriteConflictError),
    });
    // the same ids loaded are the same object
    await store.load({ segment: 'big-ref' }, { bitmap: union });
    const driver = storage.storage;
    const bytes = async (segment: string): Promise<string> =>
      Buffer.from((await driver.getTail({ segment, generation: 0 }, 1 << 30)).bytes).toString(
        'hex',
      );
    expect(await bytes('big')).toBe(await bytes('big-ref'));
    expect(await s('big').count()).toBe(union.size);
    expect(run.stats.groups).toBe(1);
    expect(run.stats.requests.rangeReads).toBeGreaterThan(0);
  }, 120_000);
});
