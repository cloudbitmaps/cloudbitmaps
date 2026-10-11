import { BufferReader, BufferSink } from '@/core/blob';

describe('BufferSink', () => {
  it('keeps what a writer wrote even when it refills a Node Buffer after write() resolves', async () => {
    const sink = new BufferSink();
    const reused = Buffer.alloc(4, 1);
    await sink.write(reused);
    reused.fill(2);
    await sink.write(reused);
    expect([...sink.bytes()]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });
});

describe('BufferReader.getTail', () => {
  it('refuses a length that is not a safe integer, and reads a whole negative as an empty tail', async () => {
    const reader = new BufferReader(Uint8Array.of(1, 2, 3));
    for (const bad of [
      Number.NaN,
      1.5,
      -1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
    ]) {
      await expect(reader.getTail(bad)).rejects.toThrow(/tail length/);
    }
    expect((await reader.getTail(-1)).bytes.length).toBe(0);
    expect((await reader.getTail(Number.MAX_SAFE_INTEGER)).bytes.length).toBe(3);
    expect([...(await reader.getTail(2)).bytes]).toEqual([2, 3]);
  });
});
