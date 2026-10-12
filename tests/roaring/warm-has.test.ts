import { CloudRoaring, MemoryStorage, type MetricEvent } from '@/index';

/** A storage whose reads can be made to fail, to prove a read error arrives as a rejection. */
class FlakyStorage extends MemoryStorage {
  failReads = false;

  constructor() {
    super();
    const driver = this.storage;
    for (const method of ['getRange', 'getTail'] as const) {
      const real = driver[method].bind(driver) as (...args: unknown[]) => Promise<unknown>;
      (driver as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
        this.failReads ? Promise.reject(new Error('storage down')) : real(...args);
    }
  }
}

async function loaded(metrics?: { onEvent(e: MetricEvent): void }) {
  const storage = new FlakyStorage();
  await new CloudRoaring({ storage }).load({ segment: 's' }, [1, 2, 70000]);
  const store = new CloudRoaring({ storage, ...(metrics ? { metrics } : {}) });
  return { storage, store };
}

describe('has() and count() with metrics off', () => {
  it('answer the same values', async () => {
    const { store } = await loaded();
    const seg = store.segment('s');
    expect(await seg.has(2)).toBe(true);
    expect(await seg.has(3)).toBe(false);
    expect(await seg.count()).toBe(3);
  });

  it('return a rejected promise, never a synchronous throw, for a bad id', async () => {
    const { store } = await loaded();
    const seg = store.segment('s');
    let promise: Promise<boolean> | undefined;
    expect(() => {
      promise = seg.has(-1);
    }).not.toThrow();
    await expect(promise).rejects.toThrow();
  });

  it('return a rejected promise when storage fails', async () => {
    const { storage, store } = await loaded();
    const seg = store.segment('s');
    storage.failReads = true;
    let has: Promise<boolean> | undefined;
    let count: Promise<number> | undefined;
    expect(() => {
      has = seg.has(70000);
      count = seg.count();
    }).not.toThrow();
    await expect(has).rejects.toThrow('storage down');
    // count answers from the registry row's summary when warm; it either answers or rejects, never throws
    await (count as Promise<number>).catch(() => undefined);
  });
});

describe('has() and count() with metrics on', () => {
  it('emit exactly one op event each, named for the call, with a numeric ms', async () => {
    const events: MetricEvent[] = [];
    const { store } = await loaded({ onEvent: (e) => void events.push(e) });
    const seg = store.segment('s');
    await seg.has(1);
    await seg.has(5);
    await seg.count();
    const ops = events.filter((e) => e.kind === 'op');
    expect(ops.map((e) => (e as { name: string }).name)).toEqual(['has', 'has', 'count']);
    for (const e of ops) {
      expect(Object.keys(e).sort()).toEqual(['kind', 'ms', 'name']);
      expect(typeof (e as { ms: number }).ms).toBe('number');
    }
  });

  it('emit an op event for a has() that fails, and still reject', async () => {
    const events: MetricEvent[] = [];
    const { storage, store } = await loaded({ onEvent: (e) => void events.push(e) });
    storage.failReads = true;
    await expect(store.segment('s').has(70000)).rejects.toThrow('storage down');
    expect(events.filter((e) => e.kind === 'op')).toEqual([
      { kind: 'op', name: 'has', ms: expect.any(Number) },
    ]);
  });
});

/** Microtask turns a promise takes to settle. */
async function turns(p: Promise<unknown>): Promise<number> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  let n = 0;
  while (!settled) {
    await Promise.resolve();
    n += 1;
  }
  return n;
}

describe('a warm has() with metrics off', () => {
  it('adds no promise frame of its own over the engine call', async () => {
    const off = await loaded();
    const on = await loaded({ onEvent: () => undefined });
    const offSeg = off.store.segment('s');
    const onSeg = on.store.segment('s');
    await offSeg.has(1);
    await onSeg.has(1);
    const withOff = await turns(offSeg.has(1));
    const withOn = await turns(onSeg.has(1));
    expect(withOff).toBeLessThan(withOn);
  });
});
