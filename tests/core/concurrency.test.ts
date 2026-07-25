import { mapWithConcurrency } from '@/core/concurrency';
import { ValidationError } from '@/core/errors';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Later items finish first (descending delays), yet results come back in input order.
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await wait(ms);
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 4, async (x) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(1);
      inFlight -= 1;
      return x;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity: the pool actually overlapped work
    expect(out).toEqual(items);
  });

  it('rejects with the first error and stops scheduling new work', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error('boom');
        await wait(1);
        return x;
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6); // stopped early — did not fan out over every item
  });

  it('rejects a non-positive or non-integer limit', async () => {
    await expect(mapWithConcurrency([1], 0, async (x) => x)).rejects.toThrow(ValidationError);
    await expect(mapWithConcurrency([1], -1, async (x) => x)).rejects.toThrow(ValidationError);
    await expect(mapWithConcurrency([1], 1.5, async (x) => x)).rejects.toThrow(ValidationError);
  });

  it('returns [] for no items (and never invokes fn)', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async (x) => {
      calls += 1;
      return x;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
