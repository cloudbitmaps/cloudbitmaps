import { ChunkWindow } from '@/core/chunk-window';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('ChunkWindow', () => {
  it('hands results back in key order though reads finish in reverse', async () => {
    const keys = [3, 5, 8, 13, 21];
    const w = new ChunkWindow<number>(
      keys,
      async (k) => {
        await tick(60 - k * 2);
        return k * 10;
      },
      5,
      false,
    );
    const out: number[] = [];
    for (let i = 0; i < keys.length; i++) out.push(await w.take());
    expect(out).toEqual([30, 50, 80, 130, 210]);
  });

  it('opens 1, 2, 4 … max wide when it ramps, counting the read being taken', async () => {
    const launched: number[] = [];
    const w = new ChunkWindow<number>(
      Array.from({ length: 12 }, (_, i) => i),
      async (k) => {
        launched.push(k);
        return k;
      },
      8,
      true,
    );
    const ahead: number[] = [];
    for (let i = 0; i < 12; i++) {
      await w.take();
      ahead.push(launched.length - i); // reads launched beyond those already taken, before this take
    }
    expect(ahead.slice(0, 5)).toEqual([1, 2, 4, 8, 8]);
    expect(Math.max(...ahead)).toBe(8);
  });

  it('opens at max at once when it does not ramp, and never beyond it', async () => {
    let launched = 0;
    let inflight = 0;
    let peak = 0;
    const w = new ChunkWindow<number>(
      Array.from({ length: 20 }, (_, i) => i),
      async (k) => {
        launched++;
        inflight++;
        peak = Math.max(peak, inflight);
        await tick(3);
        inflight--;
        return k;
      },
      6,
      false,
    );
    const first = w.take();
    expect(launched).toBe(6);
    await first;
    for (let i = 1; i < 20; i++) await w.take();
    expect(peak).toBe(6);
    expect(launched).toBe(20);
  });

  it('surfaces an error only when its slot is taken, and leaves no unhandled rejection for the rest', async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const w = new ChunkWindow<number>(
        [0, 1, 2, 3, 4],
        async (k) => {
          await tick(2);
          if (k === 1 || k === 3) throw new Error(`read ${k} failed`);
          return k;
        },
        5,
        false,
      );
      expect(await w.take()).toBe(0);
      await expect(w.take()).rejects.toThrow('read 1 failed');
      await tick(30); // slot 3 rejects and is never taken
      expect(unhandled).toEqual([]);
      expect(await w.take()).toBe(2);
    } finally {
      process.off('unhandledRejection', on);
    }
  });

  it('with a ramp start, opens at that width and doubles from it, up to the maximum', async () => {
    const started: number[] = [];
    const w = new ChunkWindow<number>(
      Array.from({ length: 40 }, (_, i) => i),
      async (k) => {
        started.push(k);
        return k;
      },
      16,
      true,
      4,
    );
    await w.take();
    expect(started).toHaveLength(4); // taken 0: width 4
    await w.take();
    await w.take();
    await w.take();
    expect(started).toHaveLength(3 + 8); // taken 3: width 8
    for (let i = 0; i < 8; i++) await w.take();
    expect(started.length - 11).toBeLessThanOrEqual(16); // never past the maximum
    expect(started.length).toBeLessThanOrEqual(11 + 16);
  });
});
