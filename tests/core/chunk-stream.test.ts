import { describe, expect, it } from 'vitest';
import { ChunkStream } from '@/core/chunk-stream';
import { IntegrityError } from '@/core/errors';
import type { ChunkRead } from '@/core/ports';

const item = (key: number): ChunkRead => ({ key, bytes: new Uint8Array([key]), version: 'v' });

async function* keys(...ks: number[]): AsyncGenerator<ChunkRead> {
  for (const k of ks) {
    await new Promise((r) => setImmediate(r));
    yield item(k);
  }
}

describe('ChunkStream', () => {
  it('answers overlapping takes, made before any settles, with the key each was made for', async () => {
    const stream = new ChunkStream(keys(3, 5, 9));
    const taken = [stream.take(3), stream.take(5), stream.take(9)];
    expect((await Promise.all(taken)).map((c) => c.key)).toEqual([3, 5, 9]);
  });

  it('refuses an answer for another key rather than hand its bytes to the key asked for', async () => {
    const stream = new ChunkStream(keys(3, 5));
    await expect(stream.take(4)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('fails when the stream ends before the key, and fails every take after a failure with the same error', async () => {
    const stream = new ChunkStream(keys(3));
    await stream.take(3);
    await expect(stream.take(4)).rejects.toBeInstanceOf(IntegrityError);

    const boom = new Error('boom');
    async function* failing(): AsyncGenerator<ChunkRead> {
      yield item(1);
      await Promise.resolve();
      throw boom;
    }
    const broken = new ChunkStream(failing());
    const first = broken.take(1);
    const second = broken.take(2);
    const third = broken.take(3); // made before the failure is known
    await expect(first).resolves.toMatchObject({ key: 1 });
    await expect(second).rejects.toBe(boom);
    await expect(third).rejects.toBe(boom);
    await expect(broken.take(4)).rejects.toBe(boom);
  });

  it('close stops the stream: the generator is finished, and a failure to close is not raised', async () => {
    let finished = false;
    async function* gen(): AsyncGenerator<ChunkRead> {
      try {
        yield item(1);
        yield item(2);
      } finally {
        finished = true;
      }
    }
    const stream = new ChunkStream(gen());
    await stream.take(1);
    stream.close();
    await new Promise((r) => setImmediate(r));
    expect(finished).toBe(true);
    stream.close(); // twice is fine
  });
});
