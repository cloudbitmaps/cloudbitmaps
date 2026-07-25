import { Scheduler, SeededRng } from '@/testing/simulator';

/**
 * Launch `n` fake "operations", each of which awaits two scheduler points (modelling a read then a write)
 * and records its label at each. Returns the per-op completion log once the scheduler has drained.
 */
async function runOps(scheduler: Scheduler, n: number): Promise<string[]> {
  const log: string[] = [];
  scheduler.arm();
  const ops = Array.from({ length: n }, (_v, i) =>
    (async () => {
      await scheduler.point(`op${i}.a`);
      log.push(`op${i}.a`);
      await scheduler.point(`op${i}.b`);
      log.push(`op${i}.b`);
    })(),
  );
  await scheduler.drain();
  await Promise.all(ops);
  return log;
}

describe('Scheduler', () => {
  it('drives every launched op to completion', async () => {
    const s = new Scheduler(new SeededRng(1));
    const log = await runOps(s, 4);
    expect(log).toHaveLength(8); // 4 ops × 2 points
    for (let i = 0; i < 4; i++) {
      // Each op's read precedes its write (program order within an op is preserved).
      expect(log.indexOf(`op${i}.a`)).toBeLessThan(log.indexOf(`op${i}.b`));
    }
  });

  it('is deterministic: the same seed yields the same release order', async () => {
    const h1 = await (async () => {
      const s = new Scheduler(new SeededRng(42));
      await runOps(s, 5);
      return s.history();
    })();
    const h2 = await (async () => {
      const s = new Scheduler(new SeededRng(42));
      await runOps(s, 5);
      return s.history();
    })();
    expect(h1).toEqual(h2);
    expect(h1).toHaveLength(10);
  });

  it('actually interleaves: different seeds give different orders', async () => {
    const histories = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = new Scheduler(new SeededRng(seed));
      await runOps(s, 6);
      histories.add(s.history().join(','));
    }
    expect(histories.size).toBeGreaterThan(1);
  });

  it('interleaves ops rather than running them strictly in order', async () => {
    // With enough ops and a fixed seed, at least one op's points are separated by another op's.
    const s = new Scheduler(new SeededRng(123));
    await runOps(s, 6);
    const h = s.history();
    let interleaved = false;
    for (let i = 0; i < 6; i++) {
      const a = h.indexOf(`op${i}.a`);
      const b = h.indexOf(`op${i}.b`);
      if (b - a > 1) interleaved = true; // something else ran between this op's two points
    }
    expect(interleaved).toBe(true);
  });

  it('reports the realized concurrency width (maxConcurrency > 1 when ops overlap)', async () => {
    const s = new Scheduler(new SeededRng(11));
    await runOps(s, 5); // 5 ops launched together → at least 5 gates pending at the first drain step
    expect(s.maxConcurrency).toBeGreaterThan(1);
  });

  it('point() is a pass-through when not armed', async () => {
    const s = new Scheduler(new SeededRng(1));
    // No arm()/drain(): awaiting a point must resolve immediately, not hang.
    await s.point('free');
    expect(s.steps).toBe(0);
  });

  it('rejects double-arm and drain-without-arm', async () => {
    const s = new Scheduler(new SeededRng(1));
    await expect(s.drain()).rejects.toThrow(/requires arm/);
    s.arm();
    expect(() => s.arm()).toThrow(/already armed/);
    await s.drain();
  });

  it('disarms after drain so a later batch can re-arm', async () => {
    const s = new Scheduler(new SeededRng(9));
    await runOps(s, 3);
    // A second batch on the same scheduler must work (arm again).
    const log = await runOps(s, 3);
    expect(log).toHaveLength(6);
    expect(s.steps).toBe(12); // 6 points from each batch
  });
});
