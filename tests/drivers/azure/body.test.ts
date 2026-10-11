import { Readable } from 'node:stream';
import { NotFoundError } from '@/core/errors';
import { collect, destroyBody } from '@/azure-blob/body';
import { isTransient } from '@/azure-blob/azure-errors';

/**
 * The one body reader both Azure halves use: the bytes it returns, the cap it holds a body to, and the one mapping of
 * a body cut off mid-read to a retryable connection fault.
 */
const oversize = (): Error => new Error('too long');
const live = (): AbortSignal => new AbortController().signal;

describe('Azure: collect, the one body reader', () => {
  it('joins the chunks of a body that ends', async () => {
    const body = Readable.from([Buffer.from([1, 2]), 'ab', Buffer.from([3])]);
    expect([...(await collect(body, live(), 16, oversize))]).toEqual([1, 2, 97, 98, 3]);
  });

  it('stops at the first byte past the cap and lets the body go', async () => {
    let pulled = 0;
    // It would go on for 16 chunks: only a check made as each chunk arrives stops it at the second.
    const body = new Readable({
      highWaterMark: 8,
      read() {
        pulled += 1;
        if (pulled > 16) this.destroy(new Error('read on past the cap'));
        else this.push(Buffer.alloc(8));
      },
    });
    await expect(collect(body, live(), 12, oversize)).rejects.toThrow('too long');
    expect(pulled).toBeLessThan(16);
    expect(body.destroyed).toBe(true);
  });

  it('refuses an advertised length over the cap before reading a byte', async () => {
    const body = Readable.from([Buffer.alloc(1)]);
    await expect(collect(body, live(), 4, oversize, 5)).rejects.toThrow('too long');
    expect(body.destroyed).toBe(true);
  });

  it('reads an AbortError with the read not aborted as a dropped connection, and transient', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = new Readable({ read: () => body.destroy(abort) });
    const err = await collect(body, live(), 16, oversize).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('ECONNRESET');
    expect(isTransient(err)).toBe(true);
  });

  it("leaves an AbortError from the read's own abort as it is", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = new Readable({ read: () => body.destroy(abort) });
    await expect(collect(body, controller.signal, 16, oversize)).rejects.toBe(abort);
  });

  it('reads a body that closes without ending as a dropped connection, and transient', async () => {
    const body = new Readable({ read: () => body.destroy() });
    const err = await collect(body, live(), 16, oversize).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('ECONNRESET');
    expect(isTransient(err)).toBe(true);
  });
});

describe('Azure: collect, the edges the first tests leave open', () => {
  it('holds a body to the cap to the byte: the cap itself is read, one byte more is refused', async () => {
    expect([...(await collect(Readable.from([Buffer.alloc(4, 7)]), live(), 4, oversize))]).toEqual([
      7, 7, 7, 7,
    ]);
    await expect(collect(Readable.from([Buffer.alloc(5)]), live(), 4, oversize)).rejects.toThrow(
      'too long',
    );
    // across chunks too
    await expect(
      collect(Readable.from([Buffer.alloc(2), Buffer.alloc(3)]), live(), 4, oversize),
    ).rejects.toThrow('too long');
  });

  it('keeps the SDK error as the cause of a dropped-connection error (abort and premature close)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const aborted = new Readable({ read: () => aborted.destroy(abort) });
    const e1 = (await collect(aborted, live(), 16, oversize).catch((e: unknown) => e)) as Error;
    expect(e1.cause).toBe(abort);

    const closed = new Readable({ read: () => closed.destroy() });
    const e2 = (await collect(closed, live(), 16, oversize).catch((e: unknown) => e)) as Error;
    expect((e2.cause as { code?: string }).code).toBe('ERR_STREAM_PREMATURE_CLOSE');
  });

  it('a body with no stream is a NotFoundError', async () => {
    await expect(collect(undefined, live(), 16, oversize)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('destroyBody leaves a listener, so an error the body raises later is not thrown out of the event', () => {
    const body = Readable.from([Buffer.alloc(1)]);
    destroyBody(body);
    expect(body.destroyed).toBe(true);
    expect(() => body.emit('error', new Error('late abort'))).not.toThrow();
  });
});
