import { PassThrough } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { readOnce, singleHeader } from '@/gcs/read-once';
import { GcsStorageDriver } from '@/gcs/storage';
import { TransientError } from '@/core/errors';

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

  it('reaches the caller as TransientError when a tail read is cut off', async () => {
    const d = new Driven();
    const storage = { bucket: () => ({ file: () => d.file() }) } as unknown as Storage;
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const p = driver.getTail({ segment: 's', generation: 0 }, 10);
    await settle();
    d.respond(206, { 'content-range': 'bytes 0-9/10' });
    d.stream.write(Buffer.alloc(3));
    d.stream.destroy();
    await expect(p).rejects.toBeInstanceOf(TransientError);
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
