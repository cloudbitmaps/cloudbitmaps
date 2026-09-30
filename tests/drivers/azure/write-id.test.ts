import type { ContainerClient } from '@azure/storage-blob';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { storageObjectName } from '@/azure-blob/keys';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

/**
 * A conditional write that lands and loses its response is sent again by the client's retry policy, meets its own
 * blob, and is answered 409 or 412. Each write tags its blob with a random id in metadata, and a conflict reads the id
 * back: the write is its own when the blob carries the id it sent. These tests drive both drivers over a fake
 * container that applies a write and then answers the conflict its replay would get.
 */

const restErr = (statusCode: number, code?: string): Error =>
  Object.assign(new Error(`http ${statusCode}`), { statusCode, ...(code ? { code } : {}) });

interface Stored {
  bytes: Uint8Array;
  etag: string;
  metadata?: Record<string, string>;
}

type Sent = { op: 'upload' | 'commit' | 'getProperties' };

/** A fake container: conditional writes, custom metadata, and one armed fault per test. */
class FakeContainer {
  readonly blobs = new Map<string, Stored>();
  readonly sent: Sent[] = [];
  private seq = 0;
  /** After the next conditional write applies, answer this instead of success (the replay's conflict). */
  replayConflictAfterWrite: Error | undefined;
  /** Fail the next `getProperties` with this. */
  propertiesFault: Error | undefined;
  /** Runs between a write applying and the read-back: another writer landing on top. */
  afterWrite: (() => void) | undefined;

  count(op: Sent['op']): number {
    return this.sent.filter((s) => s.op === op).length;
  }

  overwrite(name: string, metadata?: Record<string, string>): void {
    this.blobs.set(name, { bytes: new Uint8Array(0), etag: `"e${++this.seq}"`, metadata });
  }

  private apply(
    name: string,
    body: Uint8Array,
    opts: {
      conditions?: { ifNoneMatch?: string; ifMatch?: string };
      metadata?: Record<string, string>;
    },
  ): void {
    const cur = this.blobs.get(name);
    const c = opts.conditions ?? {};
    if (c.ifNoneMatch === '*' && cur !== undefined) throw restErr(409, 'BlobAlreadyExists');
    if (c.ifMatch !== undefined && (cur === undefined || cur.etag !== c.ifMatch)) {
      throw restErr(412, 'ConditionNotMet');
    }
    this.blobs.set(name, { bytes: body, etag: `"e${++this.seq}"`, metadata: opts.metadata });
    if (this.replayConflictAfterWrite !== undefined) {
      const fault = this.replayConflictAfterWrite;
      this.replayConflictAfterWrite = undefined;
      this.afterWrite?.();
      throw fault;
    }
  }

  getBlockBlobClient(name: string): unknown {
    return {
      getProperties: async () => {
        this.sent.push({ op: 'getProperties' });
        if (this.propertiesFault !== undefined) throw this.propertiesFault;
        const b = this.blobs.get(name);
        if (b === undefined) throw restErr(404);
        return { etag: b.etag, contentLength: b.bytes.length, metadata: b.metadata };
      },
      downloadToBuffer: async (
        _o: number,
        _c: number,
        opts?: { conditions?: { ifMatch?: string } },
      ) => {
        const b = this.blobs.get(name);
        if (b === undefined) throw restErr(404, 'BlobNotFound');
        if (opts?.conditions?.ifMatch !== undefined && opts.conditions.ifMatch !== b.etag) {
          throw restErr(412, 'ConditionNotMet');
        }
        return Buffer.from(b.bytes);
      },
      upload: async (
        body: Uint8Array,
        length: number,
        opts: Parameters<FakeContainer['apply']>[2],
      ) => {
        this.sent.push({ op: 'upload' });
        this.apply(name, body.subarray(0, length), opts);
      },
      stageBlock: async () => undefined,
      commitBlockList: async (_ids: string[], opts: Parameters<FakeContainer['apply']>[2]) => {
        this.sent.push({ op: 'commit' });
        this.apply(name, new Uint8Array(0), opts);
      },
    };
  }
}

const GEN: GenKey = { segment: 's', generation: 0 };
const NAME = storageObjectName('cloudbitmaps', GEN);
const asClient = (c: FakeContainer): ContainerClient => c as unknown as ContainerClient;
const storageOver = (c: FakeContainer, blockBytes?: number): AzureBlobStorageDriver =>
  new AzureBlobStorageDriver({
    containerClient: asClient(c),
    prefix: 'cloudbitmaps',
    ...(blockBytes === undefined ? {} : { blockBytes, maxObjectBytes: 1024 }),
  });
const put = (d: AzureBlobStorageDriver, bytes: Uint8Array) =>
  d.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });

describe.each([
  ['upload (one block)', undefined, new Uint8Array([1, 2, 3])],
  ['staged commit (several blocks)', 2, new Uint8Array([1, 2, 3, 4, 5])],
])('AzureBlobStorageDriver write id, %s', (_label, blockBytes, bytes) => {
  it('tags the blob with an id in metadata and makes no read-back when the write succeeds', async () => {
    const c = new FakeContainer();
    await put(storageOver(c, blockBytes), bytes);
    expect(c.blobs.get(NAME)?.metadata?.cbwid).toMatch(/^[0-9a-f]{32}$/);
    expect(c.count('getProperties')).toBe(0);
  });

  it('gives each write its own id', async () => {
    const c = new FakeContainer();
    await put(storageOver(c, blockBytes), bytes);
    const first = c.blobs.get(NAME)?.metadata?.cbwid;
    c.blobs.clear();
    await put(storageOver(c, blockBytes), bytes);
    expect(c.blobs.get(NAME)?.metadata?.cbwid).not.toBe(first);
  });

  it('reports success when the conflict is the write meeting its own blob', async () => {
    const c = new FakeContainer();
    c.replayConflictAfterWrite = restErr(409, 'BlobAlreadyExists');
    const res = await put(storageOver(c, blockBytes), bytes);
    expect(res.size).toBe(bytes.length);
    expect(c.count('getProperties')).toBe(1);
  });

  it('reports a conflict when the stored blob carries another writer id', async () => {
    const c = new FakeContainer();
    c.overwrite(NAME, { cbwid: 'someone-else' });
    await expect(put(storageOver(c, blockBytes), bytes)).rejects.toBeInstanceOf(WriteConflictError);
    expect(c.count('getProperties')).toBe(1);
  });

  it('reports a conflict when the stored blob carries no id', async () => {
    const c = new FakeContainer();
    c.overwrite(NAME);
    await expect(put(storageOver(c, blockBytes), bytes)).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('throws TransientError when the read-back fails transiently', async () => {
    const c = new FakeContainer();
    c.replayConflictAfterWrite = restErr(409, 'BlobAlreadyExists');
    c.propertiesFault = restErr(503, 'ServerBusy');
    await expect(put(storageOver(c, blockBytes), bytes)).rejects.toBeInstanceOf(TransientError);
  });

  it('does not read back a failure that is not a conflict', async () => {
    const c = new FakeContainer();
    c.blobs.clear();
    const d = storageOver(c, blockBytes);
    c.replayConflictAfterWrite = restErr(500, 'InternalError');
    await expect(put(d, bytes)).rejects.toBeInstanceOf(TransientError);
    expect(c.count('getProperties')).toBe(0);
  });
});

describe('AzureBlobRegistryDriver write id', () => {
  const ref = { segment: 's:v1' };
  const registryOver = (c: FakeContainer): AzureBlobRegistryDriver =>
    new AzureBlobRegistryDriver({ containerClient: asClient(c), now: () => 1 });
  const rowKey = (c: FakeContainer): string => [...c.blobs.keys()][0] as string;

  it('tags a row with an id and makes no read-back when the write succeeds', async () => {
    const c = new FakeContainer();
    const reg = registryOver(c);
    await reg.create(ref, { currentGen: 0 });
    const { token } = (await reg.get(ref))!;
    await reg.compareAndSwap(ref, token, { currentGen: 1 });
    expect(c.blobs.get(rowKey(c))?.metadata?.cbwid).toMatch(/^[0-9a-f]{32}$/);
    expect(c.count('getProperties')).toBe(3); // create's read, get, and the swap's read: no read-back
  });

  it('a create that meets its own row is a success', async () => {
    const c = new FakeContainer();
    c.replayConflictAfterWrite = restErr(409, 'BlobAlreadyExists');
    const { token } = await registryOver(c).create(ref, { currentGen: 0 });
    expect(token).toBe('0');
    expect((await registryOver(c).get(ref))?.currentGen).toBe(0);
  });

  it('a compare-and-swap that meets its own row is a success', async () => {
    const c = new FakeContainer();
    const reg = registryOver(c);
    const { token } = await reg.create(ref, { currentGen: 0 });
    c.replayConflictAfterWrite = restErr(412, 'ConditionNotMet');
    await expect(reg.compareAndSwap(ref, token, { currentGen: 1 })).resolves.toEqual({
      token: '1',
    });
  });

  it('a delete whose tombstone meets its own row is a success, written once', async () => {
    const c = new FakeContainer();
    const reg = registryOver(c);
    await reg.create(ref, { currentGen: 0 });
    c.replayConflictAfterWrite = restErr(412, 'ConditionNotMet');
    await reg.delete(ref);
    expect(c.count('upload')).toBe(2); // the create, and one tombstone: the delete did not loop
    expect(await reg.get(ref)).toBeNull();
  });

  it('a create that loses to another writer is a conflict', async () => {
    const c = new FakeContainer();
    await registryOver(c).create(ref, { currentGen: 0 });
    // Another writer created the row after ours read "absent": arm the store so the next create meets it.
    const reg = registryOver(c);
    await expect(reg.create(ref, { currentGen: 0 })).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('a compare-and-swap whose row carries another id, or none, is a conflict', async () => {
    for (const other of [{ cbwid: 'someone-else' }, undefined]) {
      const c = new FakeContainer();
      const reg = registryOver(c);
      const { token } = await reg.create(ref, { currentGen: 0 });
      // Ours lands, is answered as a conflict, and another writer has swapped in over it before the read-back.
      c.replayConflictAfterWrite = restErr(412, 'ConditionNotMet');
      c.afterWrite = () => {
        const row = c.blobs.get(rowKey(c))!;
        c.blobs.set(rowKey(c), { ...row, etag: '"other"', metadata: other });
      };
      await expect(reg.compareAndSwap(ref, token, { currentGen: 1 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    }
  });

  it('throws TransientError when the read-back fails transiently', async () => {
    const c = new FakeContainer();
    const reg = registryOver(c);
    const { token } = await reg.create(ref, { currentGen: 0 });
    c.replayConflictAfterWrite = restErr(412, 'ConditionNotMet');
    // the compare-and-swap reads the row first (two getProperties), so fault only the third
    const blob = c.getBlockBlobClient.bind(c);
    let calls = 0;
    c.getBlockBlobClient = (name: string) => {
      const b = blob(name) as { getProperties: () => Promise<unknown> };
      const real = b.getProperties;
      b.getProperties = async () => {
        if (++calls === 2) throw restErr(503, 'ServerBusy');
        return real();
      };
      return b;
    };
    await expect(reg.compareAndSwap(ref, token, { currentGen: 1 })).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
