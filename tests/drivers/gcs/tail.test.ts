import { PassThrough } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { NotFoundError, TransientError, ValidationError } from '@/core/errors';

// The tail read is one suffix-range GET. A fake `Storage` serves it the way GCS does (`206` with
// `Content-Range: bytes a-b/total`, the whole object when it is shorter than the suffix) and lets each test replace
// the response, so every header the driver relies on is exercised as hostile input.

const KEY = { segment: 's', generation: 0 };

interface Served {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

class FakeTail {
  requests: Array<{ kind: 'read' | 'metadata'; options?: unknown }> = [];
  /** Replaces the honest response for a read. */
  override: ((honest: Served) => Served) | undefined;
  failure: unknown;

  constructor(readonly object: Uint8Array | undefined) {}

  storage(): Storage {
    const file = {
      createReadStream: (options: { end?: number }) => {
        this.requests.push({ kind: 'read', options });
        const out = new PassThrough();
        queueMicrotask(() => {
          if (this.object === undefined)
            return void out.destroy(Object.assign(new Error('nf'), { code: 404 }));
          if (this.failure !== undefined) return void out.destroy(this.failure as Error);
          const n = -(options.end as number);
          const total = this.object.length;
          const first = Math.max(0, total - n);
          const honest: Served = {
            status: 206,
            headers: {
              'content-range': `bytes ${first}-${total - 1}/${total}`,
              'content-length': String(total - first),
            },
            body: this.object.subarray(first),
          };
          const served = this.override?.(honest) ?? honest;
          out.emit('response', { statusCode: served.status, headers: served.headers });
          out.end(Buffer.from(served.body));
        });
        return out;
      },
      getMetadata: async () => {
        this.requests.push({ kind: 'metadata' });
        if (this.object === undefined) throw Object.assign(new Error('nf'), { code: 404 });
        return [{ size: String(this.object.length) }];
      },
    };
    return { bucket: () => ({ file: () => file }) } as unknown as Storage;
  }
}

const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);
const driverOver = (fake: FakeTail): GcsStorageDriver =>
  new GcsStorageDriver({ storage: fake.storage(), bucket: 'b' });

describe('GcsStorageDriver.getTail (suffix range, one request)', () => {
  it('returns the last N bytes and the size in one request', async () => {
    const obj = bytesOf(1000);
    const fake = new FakeTail(obj);
    const got = await driverOver(fake).getTail(KEY, 100);
    expect(got.size).toBe(1000);
    expect(Array.from(got.bytes)).toEqual(Array.from(obj.subarray(900)));
    expect(fake.requests).toEqual([{ kind: 'read', options: { end: -100, decompress: false } }]);
  });

  it('returns the whole object, and its size, when it is shorter than N', async () => {
    const obj = bytesOf(40);
    const fake = new FakeTail(obj);
    const got = await driverOver(fake).getTail(KEY, 100);
    expect(got.size).toBe(40);
    expect(Array.from(got.bytes)).toEqual(Array.from(obj));
    expect(fake.requests).toHaveLength(1);
  });

  it('accepts an object of exactly N bytes', async () => {
    const fake = new FakeTail(bytesOf(100));
    const got = await driverOver(fake).getTail(KEY, 100);
    expect(got.size).toBe(100);
    expect(got.bytes).toHaveLength(100);
  });

  it('accepts a 200 that carries a whole object no longer than N', async () => {
    const fake = new FakeTail(bytesOf(30));
    fake.override = (h) => ({ status: 200, headers: { 'content-length': '30' }, body: h.body });
    const got = await driverOver(fake).getTail(KEY, 100);
    expect(got.size).toBe(30);
  });

  it('asks only for the size when no bytes are wanted', async () => {
    const fake = new FakeTail(bytesOf(55));
    const got = await driverOver(fake).getTail(KEY, 0);
    expect(got).toEqual({ bytes: new Uint8Array(0), size: 55 });
    expect(fake.requests).toEqual([{ kind: 'metadata' }]);
  });

  it('treats an empty object as an empty tail with size 0', async () => {
    const fake = new FakeTail(new Uint8Array(0));
    // GCS and the emulator each answer a suffix on an empty object differently; neither may fail the read.
    fake.override = () => ({
      status: 206,
      headers: { 'content-range': 'bytes 0--1/0' },
      body: new Uint8Array(0),
    });
    expect(await driverOver(fake).getTail(KEY, 10)).toEqual({ bytes: new Uint8Array(0), size: 0 });
    fake.failure = Object.assign(new Error('416'), { code: 416 });
    expect(await driverOver(fake).getTail(KEY, 10)).toEqual({ bytes: new Uint8Array(0), size: 0 });
  });

  it('maps a 404 to NotFoundError, a 5xx to TransientError, and a real 416 to ValidationError', async () => {
    await expect(driverOver(new FakeTail(undefined)).getTail(KEY, 10)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const flaky = new FakeTail(bytesOf(50));
    flaky.failure = Object.assign(new Error('boom'), { code: 503 });
    await expect(driverOver(flaky).getTail(KEY, 10)).rejects.toBeInstanceOf(TransientError);
    const bad = new FakeTail(bytesOf(50));
    bad.failure = Object.assign(new Error('416'), { code: 416 });
    await expect(driverOver(bad).getTail(KEY, 10)).rejects.toBeInstanceOf(ValidationError);
  });

  describe('hostile responses', () => {
    const refuse = async (
      object: Uint8Array,
      override: (h: Served) => Served,
      n = 10,
    ): Promise<void> => {
      const fake = new FakeTail(object);
      fake.override = override;
      await expect(driverOver(fake).getTail(KEY, n)).rejects.toBeInstanceOf(ValidationError);
    };

    it('refuses a missing Content-Range', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-length': '10' } }));
    });

    it('refuses a malformed Content-Range', async () => {
      for (const value of [
        'bytes */50',
        'bytes 40-49/*',
        'bytes 40-49',
        'items 40-49/50',
        'bytes -40-49/50',
        'bytes 40-49/50, bytes 0-1/50',
        'bytes 40-49/5e1',
        ' bytes 40-49/50',
        'bytes 40-49/99999999999999999999',
      ]) {
        await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-range': value } }));
      }
    });

    it('refuses a total smaller than the bytes received', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-range': 'bytes 40-49/8' } }));
      await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-range': 'bytes 0-9/5' } }));
    });

    it('refuses a total that places the range elsewhere than the end of the object', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-range': 'bytes 40-49/500' } }));
      await refuse(bytesOf(50), (h) => ({
        ...h,
        headers: { 'content-range': 'bytes 40-49/9007199254740991' },
      }));
    });

    it('refuses an internally consistent range that is shorter than the tail asked for', async () => {
      // 5 bytes at 45-49/50 is coherent, but a 10-byte tail of a 50-byte object starts at 40.
      await refuse(bytesOf(50), (h) => ({
        ...h,
        headers: { 'content-range': 'bytes 45-49/50' },
        body: h.body.subarray(5),
      }));
    });

    it('refuses a range that disagrees with the bytes received', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, body: h.body.subarray(0, 4) }));
      await refuse(bytesOf(50), (h) => ({ ...h, headers: { 'content-range': 'bytes 30-49/50' } }));
    });

    it('refuses more bytes than asked for, whatever the headers say', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, body: bytesOf(500) }));
      await refuse(bytesOf(50), () => ({
        status: 200,
        headers: { 'content-length': '10' },
        body: bytesOf(500),
      }));
    });

    it('refuses an advertised length over N before buffering', async () => {
      await refuse(bytesOf(50), (h) => ({
        ...h,
        headers: { ...h.headers, 'content-length': '5000' },
      }));
    });

    it('refuses an unexpected success status', async () => {
      await refuse(bytesOf(50), (h) => ({ ...h, status: 204 }));
    });

    it('refuses bytes from an object that claims to be empty, and an empty answer for a live one', async () => {
      const fake = new FakeTail(bytesOf(50));
      fake.override = (h) => ({ ...h, body: new Uint8Array(0) });
      await expect(driverOver(fake).getTail(KEY, 10)).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
