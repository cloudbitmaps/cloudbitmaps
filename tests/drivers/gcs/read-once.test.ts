import { PassThrough } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { readOnce, singleHeader } from '@/gcs/read-once';
import { GcsStorageDriver } from '@/gcs/storage';
import { TransientError, ValidationError } from '@/core/errors';

// `readOnce` against a hand-driven stream, so each way a response can misbehave is one deliberate step. The real SDK
// is exercised in send-once.test.ts.

type GcsFile = Parameters<typeof readOnce>[0];

class Driven {
  readonly stream = new PassThrough();
  destroyed = 0;
  constructor() {
    const destroy = this.stream.destroy.bind(this.stream);
    this.stream.destroy = (err?: Error) => {
      this.destroyed++;
      return destroy(err);
    };
  }
  file(): GcsFile {
    return { createReadStream: () => this.stream } as unknown as GcsFile;
  }
  respond(status: number, headers: Record<string, string>): void {
    this.stream.emit('response', { statusCode: status, headers });
  }
}

/** A file whose every read opens a fresh stream, so a read the driver retries is a second request the test drives. */
class DrivenReads {
  readonly reads: Driven[] = [];
  file(): GcsFile {
    return {
      createReadStream: () => {
        const d = new Driven();
        this.reads.push(d);
        return d.stream;
      },
    } as unknown as GcsFile;
  }
  /** The driver's `n`th read (from 0), once it has opened it; the retry waits a random backoff first. */
  async read(n: number): Promise<Driven> {
    while (this.reads.length <= n) await new Promise((r) => setTimeout(r, 5));
    return this.reads[n]!;
  }
}

const oversize = (size: number | undefined): Error =>
  new Error(size === undefined ? 'oversize stream' : `oversize ${size}`);
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('readOnce', () => {
  it('returns the status, the headers and the bytes', async () => {
    const d = new Driven();
    const p = readOnce(d.file(), {}, 100, oversize);
    d.respond(200, { 'content-length': '3', 'x-goog-generation': '7' });
    d.stream.end(Buffer.from([1, 2, 3]));
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers['x-goog-generation']).toBe('7');
    expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
  });

  it('refuses an advertised length over the cap, and destroys the stream', async () => {
    const d = new Driven();
    const p = readOnce(d.file(), {}, 10, oversize);
    d.respond(200, { 'content-length': '11' });
    await expect(p).rejects.toThrow('oversize 11');
    await settle();
    expect(d.destroyed).toBe(1);
  });

  it.each([
    ['no length', {}],
    ['a lying length', { 'content-length': '2' }],
  ])(
    'refuses a body that outruns the cap with %s, and destroys the stream',
    async (_n, headers) => {
      const d = new Driven();
      const p = readOnce(d.file(), {}, 10, oversize);
      d.respond(200, headers);
      d.stream.write(Buffer.alloc(6));
      d.stream.write(Buffer.alloc(6));
      await expect(p).rejects.toThrow('oversize stream');
      await settle();
      expect(d.destroyed).toBe(1);
    },
  );

  it('accepts a body of exactly the cap', async () => {
    const d = new Driven();
    const p = readOnce(d.file(), {}, 10, oversize);
    d.respond(200, {});
    d.stream.end(Buffer.alloc(10));
    expect((await p).bytes).toHaveLength(10);
  });

  it('does not act on the headers of an error response', async () => {
    const d = new Driven();
    const p = readOnce(d.file(), {}, 10, oversize);
    d.respond(404, { 'content-length': '999' });
    d.stream.destroy(Object.assign(new Error('nf'), { code: 404 }));
    await expect(p).rejects.toMatchObject({ code: 404 });
  });

  it('reports a stream cut off before its end as a retryable connection fault', async () => {
    const d = new Driven();
    const p = readOnce(d.file(), {}, 10, oversize);
    d.respond(200, {});
    d.stream.write(Buffer.alloc(2));
    d.stream.destroy(); // closes without 'end' and without an error
    await expect(p).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  const cutOff = (d: Driven): void => {
    d.respond(206, { 'content-range': 'bytes 0-9/10' });
    d.stream.write(Buffer.alloc(3));
    d.stream.destroy();
  };

  it('retries a tail read that is cut off, and returns what the retry read', async () => {
    const reads = new DrivenReads();
    const storage = { bucket: () => ({ file: () => reads.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    cutOff(await reads.read(0));
    const second = await reads.read(1);
    second.respond(206, { 'content-range': 'bytes 0-9/10' });
    second.stream.end(Buffer.alloc(10, 7));
    const tail = await p;
    expect(tail.size).toBe(10);
    expect(tail.bytes).toEqual(new Uint8Array(10).fill(7));
    expect(reads.reads).toHaveLength(2);
  });

  it('refuses a tail longer than it asked for on the first response, without a retry', async () => {
    const reads = new DrivenReads();
    const storage = { bucket: () => ({ file: () => reads.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    p.catch(() => undefined);
    (await reads.read(0)).respond(206, {
      'content-length': '11',
      'content-range': 'bytes 0-10/11',
    });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await new Promise((r) => setTimeout(r, 1_200)); // past the longest backoff, so a retry would have opened
    expect(reads.reads).toHaveLength(1);
  });

  it('does not retry a 501 itself, which the SDK did not either, and reports it as transient', async () => {
    const reads = new DrivenReads();
    const storage = { bucket: () => ({ file: () => reads.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    p.catch(() => undefined);
    const d = await reads.read(0);
    d.respond(501, {});
    d.stream.destroy(Object.assign(new Error('not implemented'), { code: 501 }));
    await expect(p).rejects.toBeInstanceOf(TransientError); // any 5xx, for the store's own retry to judge
    await new Promise((r) => setTimeout(r, 1_200));
    expect(reads.reads).toHaveLength(1);
  });

  it('retries a fault before any response, whatever its code, as the SDK did', async () => {
    const reads = new DrivenReads();
    const storage = { bucket: () => ({ file: () => reads.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    p.catch(() => undefined);
    for (let i = 0; i < 4; i++) {
      (await reads.read(i)).stream.destroy(
        Object.assign(new Error('refused'), { code: 'EHOSTUNREACH' }),
      );
    }
    await expect(p).rejects.toBeInstanceOf(TransientError);
    expect(reads.reads).toHaveLength(4);
  });

  it('reaches the caller as TransientError when every attempt at a tail read is cut off', async () => {
    const reads = new DrivenReads();
    const storage = { bucket: () => ({ file: () => reads.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    p.catch(() => undefined); // read below, once every attempt has been cut off
    for (let i = 0; i < 4; i++) cutOff(await reads.read(i));
    await expect(p).rejects.toBeInstanceOf(TransientError);
    expect(reads.reads).toHaveLength(4); // the first read and three retries, as the SDK would have made
  });
});

describe('singleHeader', () => {
  it('returns a header that appears once', () => {
    expect(singleHeader({ a: 'x' }, 'a')).toBe('x');
  });
  it('treats an absent, empty or repeated header as absent', () => {
    expect(singleHeader({}, 'a')).toBeUndefined();
    expect(singleHeader({ a: '' }, 'a')).toBeUndefined();
    expect(singleHeader({ a: ['x', 'y'] }, 'a')).toBeUndefined();
    expect(singleHeader({ a: ['x'] }, 'a')).toBeUndefined();
  });
});
