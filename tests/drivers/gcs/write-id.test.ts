import { Writable } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

/**
 * A resumable upload is a session the SDK retries within, so a commit that landed and lost its response can be
 * answered 412 by its own replay. The upload tags its object with a random id in custom metadata, and a 412 on the
 * commit reads the id back: the write is its own when the stored object carries the id it sent. These tests drive the
 * driver over a fake `Storage` whose stream applies a write and then answers the 412 its replay would get.
 */

const httpErr = (code: number): Error => Object.assign(new Error(`http ${code}`), { code });

interface Opts {
  resumable?: boolean;
  metadata?: { contentType?: string; metadata?: Record<string, string> };
}

class FakeBucket {
  /** The custom metadata of the object the fake holds, when it holds one. */
  stored: { metadata?: Record<string, string> } | undefined;
  metadataReads = 0;
  streamsOpened: Opts[] = [];
  /** The next stream applies its write, then fails its commit with this. */
  replayAnswer: Error | undefined;
  /** The next stream fails its commit with this without applying anything. */
  failWith: Error | undefined;
  /** Fail the next getMetadata with this. */
  metadataFault: Error | undefined;

  storage(): Storage {
    const file = {
      createWriteStream: (opts: Opts) => {
        this.streamsOpened.push(opts);
        return new Writable({
          write: (_c, _e, cb) => cb(),
          final: (cb) => {
            if (this.failWith !== undefined) {
              const e = this.failWith;
              this.failWith = undefined;
              return cb(e);
            }
            if (this.stored !== undefined && opts.metadata?.metadata !== undefined) {
              // the object is already there: a write-once precondition failure
              return cb(httpErr(412));
            }
            this.stored = { metadata: opts.metadata?.metadata };
            if (this.replayAnswer !== undefined) {
              const e = this.replayAnswer;
              this.replayAnswer = undefined;
              return cb(e);
            }
            cb();
          },
        });
      },
      getMetadata: async () => {
        this.metadataReads++;
        if (this.metadataFault !== undefined) throw this.metadataFault;
        if (this.stored === undefined) throw httpErr(404);
        return [{ metadata: this.stored.metadata }];
      },
    };
    return { bucket: () => ({ file: () => file }) } as unknown as Storage;
  }
}

const GEN: GenKey = { segment: 's', generation: 0 };
const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const driverOver = (b: FakeBucket, threshold = 2): GcsStorageDriver =>
  new GcsStorageDriver({
    storage: b.storage(),
    bucket: 'b',
    simpleUploadThresholdBytes: threshold,
  });
const put = (d: GcsStorageDriver, payload = bytes) =>
  d.putImmutable(GEN, async (sink) => {
    await sink.write(payload);
  });

describe('GcsStorageDriver write id, resumable path', () => {
  it('tags the object with an id in custom metadata and makes no read-back when the write succeeds', async () => {
    const b = new FakeBucket();
    await put(driverOver(b));
    expect(b.streamsOpened[0]).toMatchObject({ resumable: true });
    expect(b.streamsOpened[0]?.metadata?.contentType).toBe('application/octet-stream');
    expect(b.stored?.metadata?.cbwid).toMatch(/^[0-9a-f]{32}$/);
    expect(b.metadataReads).toBe(0);
  });

  it('gives each write its own id', async () => {
    const [x, y] = [new FakeBucket(), new FakeBucket()];
    await put(driverOver(x));
    await put(driverOver(y));
    expect(x.stored?.metadata?.cbwid).not.toBe(y.stored?.metadata?.cbwid);
  });

  it('reports success when the 412 is the upload meeting its own object', async () => {
    const b = new FakeBucket();
    b.replayAnswer = httpErr(412);
    const res = await put(driverOver(b));
    expect(res.size).toBe(bytes.length);
    expect(b.metadataReads).toBe(1);
  });

  it('reports a conflict when the stored object carries another writer id', async () => {
    const b = new FakeBucket();
    b.stored = { metadata: { cbwid: 'someone-else' } };
    await expect(put(driverOver(b))).rejects.toBeInstanceOf(WriteConflictError);
    expect(b.metadataReads).toBe(1);
  });

  it('reports a conflict when the stored object carries no id', async () => {
    const b = new FakeBucket();
    b.stored = { metadata: undefined };
    b.failWith = httpErr(412);
    await expect(put(driverOver(b))).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('reports a conflict when the stored object is gone by the read-back', async () => {
    const b = new FakeBucket();
    b.failWith = httpErr(412);
    await expect(put(driverOver(b))).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('throws TransientError when the read-back fails transiently', async () => {
    const b = new FakeBucket();
    b.replayAnswer = httpErr(412);
    b.metadataFault = httpErr(503);
    await expect(put(driverOver(b))).rejects.toBeInstanceOf(TransientError);
  });

  it('does not read back a failure that is not a 412', async () => {
    const b = new FakeBucket();
    b.failWith = httpErr(500);
    await expect(put(driverOver(b))).rejects.toBeInstanceOf(TransientError);
    expect(b.metadataReads).toBe(0);
  });

  it('leaves the simple upload as it was: no id, and no read-back on a 412', async () => {
    const b = new FakeBucket();
    b.failWith = httpErr(412);
    await expect(put(driverOver(b, 1024))).rejects.toBeInstanceOf(WriteConflictError);
    expect(b.streamsOpened[0]).toMatchObject({ resumable: false });
    expect(b.streamsOpened[0]?.metadata?.metadata).toBeUndefined();
    expect(b.metadataReads).toBe(0);
  });
});
