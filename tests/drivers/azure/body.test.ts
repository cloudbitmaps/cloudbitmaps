import { Readable } from 'node:stream';
import { collect } from '@/azure-blob/body';
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
    const body = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]);
    await expect(collect(body, live(), 12, oversize)).rejects.toThrow('too long');
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
