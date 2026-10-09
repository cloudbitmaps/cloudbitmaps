import { PassThrough } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsStorage } from '@/gcs/backend';
import { storageObjectName } from '@/gcs/keys';
import { NotFoundError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

/**
 * The GCS storage half's conditional delete: an object delete under `ifGenerationMatch: <the generation a tail read
 * reported>`, when `conditionalDelete` is set. A fake `Storage` keeps objects with GCS object generations, serves a tail
 * read with the `x-goog-generation` header GCS sends, and applies the precondition on a delete, answering a name with no
 * object `404` or `412` as a test asks, since which one real GCS answers has not been recorded.
 */

const KEY: GenKey = { segment: 's', generation: 1 };
const NAME = storageObjectName(undefined, KEY);

const httpError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code, errors: [{ reason: message }] });

class FakeBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; generation: number }>();
  readonly deletes: Array<{ name: string; options: { ifGenerationMatch?: number } | undefined }> =
    [];
  /** What a delete under a precondition answers for a name with no object. */
  absentAnswer: 404 | 412 = 404;
  /** Answer the next delete with this, unapplied. */
  nextDelete: Error | undefined;
  /** Apply the next delete, then lose its answer: the SDK's retry sends it again. */
  loseNextDeleteAnswer = false;
  /** What a metadata read meets, in place of an answer. */
  metadataFault: Error | undefined;
  bucketMissing = false;
  /** The `x-goog-generation` a read of an object of this generation is answered with. */
  generationHeader = (generation: number): string => String(generation);
  private seq = 1_700_000_000;

  /** Store `text` under the generation's name; returns the object generation GCS gave it. */
  put(text: string): string {
    this.seq += 1;
    this.objects.set(NAME, { bytes: new TextEncoder().encode(text), generation: this.seq });
    return String(this.seq);
  }

  storage(): Storage {
    const file = (name: string) => ({
      interceptors: [] as unknown[],
      createReadStream: (options: { end?: number }) => {
        const out = new PassThrough();
        queueMicrotask(() => {
          const stored = this.objects.get(name);
          if (stored === undefined) return void out.destroy(httpError(404, 'notFound'));
          const n = -(options.end as number);
          const total = stored.bytes.length;
          const first = Math.max(0, total - n);
          out.emit('response', {
            statusCode: 206,
            headers: {
              'content-range': `bytes ${first}-${total - 1}/${total}`,
              'content-length': String(total - first),
              'x-goog-generation': this.generationHeader(stored.generation),
            },
          });
          out.end(Buffer.from(stored.bytes.subarray(first)));
        });
        return out;
      },
      getMetadata: async () => {
        if (this.metadataFault !== undefined) throw this.metadataFault;
        const stored = this.objects.get(name);
        if (stored === undefined) throw httpError(404, 'notFound');
        return [{ size: String(stored.bytes.length), generation: String(stored.generation) }];
      },
      delete: async (options?: { ifGenerationMatch?: number }) => {
        // The SDK sends a delete that carries a precondition again after a lost answer: modelled by sending it twice.
        const once = (): void => {
          this.deletes.push({ name, options });
          const armed = this.nextDelete;
          this.nextDelete = undefined;
          if (armed !== undefined) throw armed;
          const stored = this.objects.get(name);
          const expected = options?.ifGenerationMatch;
          if (stored === undefined) {
            throw expected !== undefined && this.absentAnswer === 412
              ? httpError(412, 'conditionNotMet')
              : httpError(404, 'notFound');
          }
          if (expected !== undefined && stored.generation !== expected) {
            throw httpError(412, 'conditionNotMet');
          }
          this.objects.delete(name);
        };
        if (this.loseNextDeleteAnswer) {
          this.loseNextDeleteAnswer = false;
          once();
        }
        once();
      },
    });
    const bucket = {
      file,
      getFiles: async () => {
        if (this.bucketMissing) throw httpError(404, 'notFound');
        return [[]];
      },
    };
    return { bucket: () => bucket } as unknown as Storage;
  }
}

const over = (fake: FakeBucket, conditionalDelete?: boolean): GcsStorageDriver =>
  new GcsStorageDriver({
    storage: fake.storage(),
    bucket: 'b',
    ...(conditionalDelete === undefined ? {} : { conditionalDelete }),
  });

describe('GcsStorageDriver: a tail read reports the object generation', () => {
  it('from the x-goog-generation of the GET that carried the bytes, and from the metadata when none were asked for', async () => {
    const fake = new FakeBucket();
    const generation = fake.put('hello');
    const driver = over(fake);
    expect((await driver.getTail(KEY, 3)).version).toBe(generation);
    expect((await driver.getTail(KEY, 100)).version).toBe(generation);
    expect((await driver.getTail(KEY, 0)).version).toBe(generation);
  });

  it('reports none for a header that is not a generation, rather than one the service could not compare', async () => {
    const fake = new FakeBucket();
    fake.put('hello');
    const driver = over(fake, true);
    for (const header of ['not-a-number', '0', '-1', '1.5', '99999999999999999999']) {
      fake.generationHeader = () => header;
      expect((await driver.getTail(KEY, 3)).version, header).toBeUndefined();
    }
  });
});

describe('GcsStorageDriver: a delete given ifVersion, with conditionalDelete set', () => {
  it('sends ifGenerationMatch with the generation, and deletes', async () => {
    const fake = new FakeBucket();
    const driver = over(fake, true);
    expect(driver.capabilities().conditionalDelete).toBe(true);
    fake.put('one');
    const { version } = await driver.getTail(KEY, 3);
    await driver.delete(KEY, { ifVersion: version });
    expect(fake.deletes).toEqual([{ name: NAME, options: { ifGenerationMatch: Number(version) } }]);
    expect(fake.objects.has(NAME)).toBe(false);
  });

  it('another object under the name since: 412, the metadata finds it, WriteConflictError, and it stays', async () => {
    const fake = new FakeBucket();
    const driver = over(fake, true);
    const first = fake.put('one');
    await driver.delete(KEY);
    const second = fake.put('two');
    await expect(driver.delete(KEY, { ifVersion: first })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(String(fake.objects.get(NAME)?.generation)).toBe(second);
  });

  it.each([404, 412] as const)(
    'an absent object is a no-op when the service answers it %s',
    async (answer) => {
      const fake = new FakeBucket();
      fake.absentAnswer = answer;
      const driver = over(fake, true);
      const first = fake.put('one');
      await driver.delete(KEY);
      await expect(driver.delete(KEY, { ifVersion: first })).resolves.toBeUndefined();
    },
  );

  it('a copy the SDK sends again after a lost answer meets its own landed delete: success', async () => {
    const fake = new FakeBucket();
    fake.absentAnswer = 412;
    const driver = over(fake, true);
    const generation = fake.put('one');
    fake.loseNextDeleteAnswer = true;
    await expect(driver.delete(KEY, { ifVersion: generation })).resolves.toBeUndefined();
    expect(fake.deletes).toHaveLength(2);
    expect(fake.objects.has(NAME)).toBe(false);
  });

  it('a 404 in a bucket that does not exist fails the delete, conditioned or not', async () => {
    const fake = new FakeBucket();
    fake.bucketMissing = true;
    const driver = over(fake, true);
    const err = await driver.delete(KEY, { ifVersion: '1' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect((err as Error).message).toMatch(/bucket does not exist/);
  });

  it('a version that is not an object generation is refused before anything is sent', async () => {
    const fake = new FakeBucket();
    const driver = over(fake, true);
    fake.put('one');
    await expect(driver.delete(KEY, { ifVersion: '"etag"' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fake.deletes).toEqual([]);
    expect(fake.objects.has(NAME)).toBe(true);
  });
});

describe('GcsStorageDriver: without conditionalDelete the version is not sent', () => {
  it('by default: a stale version deletes what is there, and the capability says so', async () => {
    const fake = new FakeBucket();
    const driver = over(fake);
    expect(driver.capabilities().conditionalDelete).toBe(false);
    const first = fake.put('one');
    await driver.delete(KEY);
    fake.put('two');
    await driver.delete(KEY, { ifVersion: first });
    expect(fake.deletes.map((d) => d.options)).toEqual([undefined, undefined]);
    expect(fake.objects.has(NAME)).toBe(false);
  });

  it('a value that is not a boolean is refused', () => {
    expect(
      () =>
        new GcsStorageDriver({
          storage: new FakeBucket().storage(),
          bucket: 'b',
          conditionalDelete: 1 as unknown as boolean,
        }),
    ).toThrow(ValidationError);
  });

  it('GcsStorage hands its `conditionalDelete` to the storage half as well as the registry', () => {
    // No request is made: a capability is read from the options alone.
    const where = { bucket: 'b', projectId: 'p', apiEndpoint: 'http://127.0.0.1:9' };
    const on = new GcsStorage({ ...where, conditionalDelete: true });
    expect(on.storage.capabilities().conditionalDelete).toBe(true);
    expect(on.registry.capabilities().conditionalDelete).toBe(true);
    const off = new GcsStorage(where);
    expect(off.storage.capabilities().conditionalDelete).toBe(false);
    expect(off.registry.capabilities().conditionalDelete).toBe(false);
  });
});

describe('GcsStorageDriver: the look after a failed precondition', () => {
  it.each([
    ['a 503', httpError(503, 'backendError')],
    ['a dropped connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('that meets %s is a TransientError, not a conflict and not a no-op', async (_, fault) => {
    const fake = new FakeBucket();
    const driver = over(fake, true);
    const first = fake.put('one');
    await driver.delete(KEY);
    fake.put('two');
    fake.metadataFault = fault;
    await expect(driver.delete(KEY, { ifVersion: first })).rejects.toBeInstanceOf(TransientError);
    expect(fake.objects.has(NAME)).toBe(true);
  });
});
