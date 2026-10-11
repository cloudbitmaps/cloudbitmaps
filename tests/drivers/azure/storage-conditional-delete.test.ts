import type { ContainerClient } from '@azure/storage-blob';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { AzureBlobStorage } from '@/azure-blob/backend';
import { NotFoundError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

/**
 * The Azure Blob storage half's conditional delete: a Delete Blob under `ifMatch: <the ETag a tail read reported>`,
 * unless `conditionalDelete` is off. A fake container keeps blobs with ETags, reads a tail as the service does (the
 * properties, then a ranged download, each carrying the ETag) and applies `ifMatch` on a delete, answering a name with
 * no blob `404` or `412` as a test asks.
 */

const KEY: GenKey = { segment: 's', generation: 1 };

const restError = (statusCode: number, code: string): Error =>
  Object.assign(new Error(code), { statusCode, code });

class FakeContainer {
  readonly blobs = new Map<string, { bytes: Uint8Array; etag: string }>();
  readonly calls: Array<{ op: string; ifMatch?: string }> = [];
  /** What a Delete Blob under `ifMatch` answers for a name with no blob. */
  absentAnswer: 404 | 412 = 404;
  containerMissing = false;
  /** Runs as a ranged download arrives, before it is answered: a blob replaced between the two requests. */
  beforeDownload: (() => void) | undefined;
  /** What a properties read meets, in place of an answer. */
  propertiesFault: Error | undefined;
  /** Answer a properties read without an ETag. */
  omitPropertiesEtag = false;
  /** Apply the next delete, then lose its answer: the client's retry policy sends it again. */
  loseNextDeleteAnswer = false;
  private seq = 0;

  /** Store `text` under every name; returns its ETag. */
  put(text: string): string {
    this.seq += 1;
    const etag = `"0x8D${this.seq}"`;
    this.blobs.set('only', { bytes: new TextEncoder().encode(text), etag });
    return etag;
  }

  client(): ContainerClient {
    const missing = (): Error =>
      this.containerMissing ? restError(404, 'ContainerNotFound') : restError(404, 'BlobNotFound');
    const blob = {
      getProperties: async () => {
        this.calls.push({ op: 'getProperties' });
        if (this.propertiesFault !== undefined) throw this.propertiesFault;
        const stored = this.blobs.get('only');
        if (stored === undefined || this.containerMissing) throw missing();
        return {
          contentLength: stored.bytes.length,
          etag: this.omitPropertiesEtag ? undefined : stored.etag,
        };
      },
      download: async (
        offset: number,
        count: number,
        options?: { conditions?: { ifMatch?: string } },
      ) => {
        this.calls.push({ op: 'download', ifMatch: options?.conditions?.ifMatch });
        this.beforeDownload?.();
        const stored = this.blobs.get('only');
        if (stored === undefined || this.containerMissing) throw missing();
        const bytes = stored.bytes.subarray(offset, offset + count);
        const ifMatch = options?.conditions?.ifMatch;
        if (ifMatch !== undefined && stored.etag !== ifMatch) {
          throw restError(412, 'ConditionNotMet');
        }
        return {
          etag: stored.etag,
          contentLength: bytes.length,
          readableStreamBody: (async function* () {
            yield Buffer.from(bytes);
          })(),
        };
      },
      delete: async (options?: { conditions?: { ifMatch?: string } }) => {
        const ifMatch = options?.conditions?.ifMatch;
        const once = (): void => {
          this.calls.push({ op: 'delete', ifMatch });
          if (this.containerMissing) throw missing();
          const stored = this.blobs.get('only');
          if (stored === undefined) {
            throw ifMatch !== undefined && this.absentAnswer === 412
              ? restError(412, 'ConditionNotMet')
              : missing();
          }
          if (ifMatch !== undefined && stored.etag !== ifMatch) {
            throw restError(412, 'ConditionNotMet');
          }
          this.blobs.delete('only');
        };
        if (this.loseNextDeleteAnswer) {
          this.loseNextDeleteAnswer = false;
          once();
        }
        once();
      },
      deleteIfExists: async () => {
        this.calls.push({ op: 'deleteIfExists' });
        if (this.containerMissing) throw missing();
        return { succeeded: this.blobs.delete('only') };
      },
    };
    return { getBlockBlobClient: () => blob } as unknown as ContainerClient;
  }
}

const over = (fake: FakeContainer, conditionalDelete?: boolean): AzureBlobStorageDriver =>
  new AzureBlobStorageDriver({
    containerClient: fake.client(),
    ...(conditionalDelete === undefined ? {} : { conditionalDelete }),
  });

describe('AzureBlobStorageDriver: a tail read reports the ETag', () => {
  it('of the download that carried the bytes, and of the properties when none were asked for', async () => {
    const fake = new FakeContainer();
    const etag = fake.put('hello');
    const driver = over(fake);
    expect((await driver.getTail(KEY, 3)).version).toBe(etag);
    expect((await driver.getTail(KEY, 0)).version).toBe(etag);
  });
});

describe('AzureBlobStorageDriver: a tail read of a blob replaced between its two requests', () => {
  it('reads the replacement whole: its size, its bytes and its version together', async () => {
    const fake = new FakeContainer();
    fake.put('0123456789');
    let replaced = false;
    let etagB = '';
    fake.beforeDownload = () => {
      if (replaced) return;
      replaced = true;
      etagB = fake.put('abcdefghijklmnopqrstuvwxyz0123');
    };
    const tail = await over(fake).getTail(KEY, 4);
    expect(tail).toEqual({ bytes: new TextEncoder().encode('0123'), size: 30, version: etagB });
  });

  it('sends the properties ETag as ifMatch on the download', async () => {
    const fake = new FakeContainer();
    const etag = fake.put('hello');
    await over(fake).getTail(KEY, 3);
    expect(fake.calls.filter((c) => c.op === 'download')).toEqual([
      { op: 'download', ifMatch: etag },
    ]);
  });

  it('refuses a properties answer with no ETag, since the download could not be conditional', async () => {
    const fake = new FakeContainer();
    fake.put('hello');
    fake.omitPropertiesEtag = true;
    await expect(over(fake).getTail(KEY, 3)).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls.some((c) => c.op === 'download')).toBe(false);
  });

  it('is NotFoundError when the blob is gone by the download', async () => {
    const fake = new FakeContainer();
    fake.put('hello');
    fake.beforeDownload = () => fake.blobs.clear();
    await expect(over(fake).getTail(KEY, 3)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('takes the version from the properties for an empty blob and for a length of zero', async () => {
    const fake = new FakeContainer();
    const empty = fake.put('');
    expect((await over(fake).getTail(KEY, 4)).version).toBe(empty);
    const etag = fake.put('hello');
    expect((await over(fake).getTail(KEY, 0)).version).toBe(etag);
    expect(fake.calls.some((c) => c.op === 'download')).toBe(false);
  });

  it('is a TransientError when the blob is replaced again on the second try', async () => {
    const fake = new FakeContainer();
    fake.put('0123456789');
    fake.beforeDownload = () => {
      fake.put('abcdefghijklmnopqrstuvwxyz0123');
    };
    await expect(over(fake).getTail(KEY, 4)).rejects.toBeInstanceOf(TransientError);
    expect(fake.calls.filter((c) => c.op === 'getProperties')).toHaveLength(2);
    expect(fake.calls.filter((c) => c.op === 'download')).toHaveLength(2);
  });
});

describe('AzureBlobStorageDriver: a delete given ifVersion, on by default', () => {
  it('sends ifMatch with the ETag, and deletes', async () => {
    const fake = new FakeContainer();
    const driver = over(fake);
    expect(driver.capabilities().conditionalDelete).toBe(true);
    fake.put('one');
    const { version } = await driver.getTail(KEY, 3);
    fake.calls.length = 0;
    await driver.delete(KEY, { ifVersion: version });
    expect(fake.calls).toEqual([{ op: 'delete', ifMatch: version }]);
    expect(fake.blobs.size).toBe(0);
  });

  it('another blob under the name since: 412, the properties find it, WriteConflictError, and it stays', async () => {
    const fake = new FakeContainer();
    const driver = over(fake);
    const first = fake.put('one');
    await driver.delete(KEY);
    const second = fake.put('two');
    await expect(driver.delete(KEY, { ifVersion: first })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(fake.blobs.get('only')?.etag).toBe(second);
  });

  it.each([404, 412] as const)(
    'an absent blob is a no-op when the service answers it %s',
    async (answer) => {
      const fake = new FakeContainer();
      fake.absentAnswer = answer;
      const driver = over(fake);
      const first = fake.put('one');
      await driver.delete(KEY);
      await expect(driver.delete(KEY, { ifVersion: first })).resolves.toBeUndefined();
    },
  );

  it('a container that does not exist is not an absent blob', async () => {
    const fake = new FakeContainer();
    fake.containerMissing = true;
    const err = await over(fake)
      .delete(KEY, { ifVersion: '"0x8D1"' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
  });

  it('a 409 on the delete (a snapshot or a lease in the way) is not a lost race', async () => {
    const fake = new FakeContainer();
    const etag = fake.put('one');
    const client = fake.client();
    const blob = client.getBlockBlobClient('x') as unknown as { delete: () => Promise<void> };
    blob.delete = async () => {
      throw restError(409, 'SnapshotsPresent');
    };
    const driver = new AzureBlobStorageDriver({ containerClient: client });
    const err = await driver.delete(KEY, { ifVersion: etag }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toMatch(/SnapshotsPresent/);
  });
});

describe('AzureBlobStorageDriver: with conditionalDelete off the version is not sent', () => {
  it('a stale version deletes what is there, through deleteIfExists', async () => {
    const fake = new FakeContainer();
    const driver = over(fake, false);
    expect(driver.capabilities().conditionalDelete).toBe(false);
    const first = fake.put('one');
    await driver.delete(KEY);
    fake.put('two');
    fake.calls.length = 0;
    await driver.delete(KEY, { ifVersion: first });
    expect(fake.calls).toEqual([{ op: 'deleteIfExists' }]);
    expect(fake.blobs.size).toBe(0);
  });

  it('a value that is not a boolean is refused', () => {
    expect(
      () =>
        new AzureBlobStorageDriver({
          containerClient: new FakeContainer().client(),
          conditionalDelete: 'no' as unknown as boolean,
        }),
    ).toThrow(ValidationError);
  });

  it('AzureBlobStorage hands its `conditionalDelete` to the storage half as well as the registry', () => {
    const containerClient = new FakeContainer().client();
    const off = new AzureBlobStorage({ containerClient, conditionalDelete: false });
    expect(off.storage.capabilities().conditionalDelete).toBe(false);
    expect(off.registry.capabilities().conditionalDelete).toBe(false);
    const on = new AzureBlobStorage({ containerClient });
    expect(on.storage.capabilities().conditionalDelete).toBe(true);
    expect(on.registry.capabilities().conditionalDelete).toBe(true);
  });
});

describe('AzureBlobStorageDriver: a delete sent again, and the look after a failed condition', () => {
  it.each([404, 412] as const)(
    'a copy the client sends again after a lost response meets its own landed delete (%s): success',
    async (answer) => {
      const fake = new FakeContainer();
      fake.absentAnswer = answer;
      const driver = over(fake);
      const etag = fake.put('one');
      fake.loseNextDeleteAnswer = true;
      await expect(driver.delete(KEY, { ifVersion: etag })).resolves.toBeUndefined();
      expect(fake.calls.filter((c) => c.op === 'delete')).toHaveLength(2);
      expect(fake.blobs.size).toBe(0);
    },
  );

  it.each([
    ['a 503', restError(503, 'ServerBusy')],
    ['a dropped connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])(
    'a look that meets %s is a TransientError, not a conflict and not a no-op',
    async (_, fault) => {
      const fake = new FakeContainer();
      const driver = over(fake);
      const first = fake.put('one');
      await driver.delete(KEY);
      fake.put('two');
      fake.propertiesFault = fault;
      await expect(driver.delete(KEY, { ifVersion: first })).rejects.toBeInstanceOf(TransientError);
      expect(fake.blobs.size).toBe(1);
    },
  );
});
