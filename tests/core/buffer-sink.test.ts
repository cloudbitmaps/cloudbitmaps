import { BufferSink } from '@/core/blob';

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
