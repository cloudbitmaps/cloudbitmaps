import { PassThrough } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { NotFoundError, ValidationError } from '@/core/errors';

// The range read is one ranged GET through `readOnce`, buffering at most the length asked for. A fake `Storage` serves
// it the way GCS does (`206` with `Content-Range: bytes a-b/total`) and lets each test replace the response, so the
// status, the length and the header the driver checks are each exercised as hostile input.

const KEY = { segment: 's', generation: 0 };

interface Served {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

class FakeRange {
  requests: unknown[] = [];
  destroyed = 0;
  override: ((honest: Served) => Served) | undefined;

  constructor(readonly object: Uint8Array | undefined) {}

  storage(): Storage {
    const file = {
      interceptors: [] as unknown[],
      createReadStream: (options: { start: number; end: number }) => {
        this.requests.push(options);
        const out = new PassThrough();
        const destroy = out.destroy.bind(out);
        out.destroy = (err?: Error) => {
          this.destroyed++;
          return destroy(err);
        };
        queueMicrotask(() => {
          if (this.object === undefined)
            return void out.destroy(Object.assign(new Error('nf'), { code: 404 }));
          const total = this.object.length;
          if (options.start >= total)
            return void out.destroy(Object.assign(new Error('range'), { code: 416 }));
          const last = Math.min(options.end, total - 1);
          const honest: Served = {
            status: 206,
            headers: {
              'content-range': `bytes ${options.start}-${last}/${total}`,
              'content-length': String(last - options.start + 1),
            },
            body: this.object.subarray(options.start, last + 1),
          };
          const served = this.override?.(honest) ?? honest;
          out.emit('response', { statusCode: served.status, headers: served.headers });
          out.end(Buffer.from(served.body));
        });
        return out;
      },
    };
    return { bucket: () => ({ file: () => file }) } as unknown as Storage;
  }
}

const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);
const driverOver = (fake: FakeRange): GcsStorageDriver =>
  new GcsStorageDriver({ storage: fake.storage(), bucket: 'b' });

describe('GcsStorageDriver.getRange (one ranged GET, capped at the length asked for)', () => {
  it('returns exactly the bytes asked for, in one request, as stored', async () => {
    const obj = bytesOf(100);
    const fake = new FakeRange(obj);
    const got = await driverOver(fake).getRange(KEY, 10, 8);
    expect(Array.from(got)).toEqual(Array.from(obj.subarray(10, 18)));
    expect(fake.requests).toEqual([{ start: 10, end: 17, decompress: false }]);
  });

  it('refuses a response that advertises more than the length asked for, before buffering it', async () => {
    const fake = new FakeRange(bytesOf(100));
    fake.override = (h) => ({
      ...h,
      headers: { ...h.headers, 'content-length': '16' },
      body: bytesOf(16),
    });
    await expect(driverOver(fake).getRange(KEY, 10, 8)).rejects.toThrow(ValidationError);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses a response that sends more than the length asked for without saying so', async () => {
    const fake = new FakeRange(bytesOf(100));
    fake.override = (h) => ({
      ...h,
      headers: { 'content-range': h.headers['content-range']! },
      body: bytesOf(16),
    });
    await expect(driverOver(fake).getRange(KEY, 10, 8)).rejects.toThrow(ValidationError);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses a range that runs past the end of the object (a short read), never returning part of it', async () => {
    const fake = new FakeRange(bytesOf(14));
    await expect(driverOver(fake).getRange(KEY, 10, 8)).rejects.toThrow(/out of bounds/);
  });

  it('maps a range that starts past the end (416) to ValidationError, and a missing object to NotFoundError', async () => {
    await expect(driverOver(new FakeRange(bytesOf(4))).getRange(KEY, 10, 8)).rejects.toThrow(
      ValidationError,
    );
    await expect(driverOver(new FakeRange(undefined)).getRange(KEY, 0, 8)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('refuses a 206 whose Content-Range is missing, malformed, or names other bytes', async () => {
    for (const range of [
      undefined,
      'bytes */100',
      'bytes 0-7/100',
      'bytes 10-17/x',
      'bytes 10-18/100',
    ]) {
      const fake = new FakeRange(bytesOf(100));
      const headers: Record<string, string> = { 'content-length': '8' };
      if (range !== undefined) headers['content-range'] = range;
      fake.override = (h) => ({ ...h, headers });
      await expect(driverOver(fake).getRange(KEY, 10, 8), String(range)).rejects.toThrow(
        ValidationError,
      );
    }
  });

  it('refuses a 200 (the whole object, the range ignored) unless the whole object is exactly the range', async () => {
    const whole = (body: Uint8Array) => (): Served => ({
      status: 200,
      headers: { 'content-length': String(body.length) },
      body,
    });
    // Six bytes for six asked for from offset 2: within the cap, but they are the object's first six, not bytes 2-7.
    const offset = new FakeRange(bytesOf(8));
    offset.override = whole(bytesOf(6));
    await expect(driverOver(offset).getRange(KEY, 2, 6)).rejects.toThrow(
      /whole object returned for a range from 2/,
    );
    const obj = bytesOf(8);
    const exact = new FakeRange(obj);
    exact.override = whole(obj);
    expect(Array.from(await driverOver(exact).getRange(KEY, 0, 8))).toEqual(Array.from(obj));
  });

  it('refuses any other success status', async () => {
    const fake = new FakeRange(bytesOf(100));
    fake.override = (h) => ({ ...h, status: 204 });
    await expect(driverOver(fake).getRange(KEY, 10, 8)).rejects.toThrow(ValidationError);
  });
});
