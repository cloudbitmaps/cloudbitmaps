import { LeaseExpiredError } from '@/index';
import { guardIdIterable, guardItems } from '@/lease-guards';

/**
 * The checks a stream makes of a lease: before its first pull, and each time it reads a chunk. They take any async
 * iterable, so a stream of another shape is wrapped by the same function.
 */

async function* idsOf(...ids: number[]): AsyncGenerator<number> {
  yield* ids;
}
const ended = (): void => {
  throw new LeaseExpiredError('ended', 1, 'expired');
};
const drain = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const v of it) out.push(v);
  return out;
};

describe('guardIdIterable', () => {
  it('checks before the first pull, so an empty stream past its lease throws and never ends empty', async () => {
    let calls = 0;
    const g = guardIdIterable(idsOf(), () => {
      calls += 1;
      ended();
    });
    await expect(drain(g)).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(calls).toBe(1);
  });

  it('checks again each time the ids move into a chunk, and not between ids of one chunk', async () => {
    let checks = 0;
    const g = guardIdIterable(idsOf(1, 2, 3, 65_536, 65_537, 131_072), () => void (checks += 1));
    expect(await drain(g)).toEqual([1, 2, 3, 65_536, 65_537, 131_072]);
    expect(checks).toBe(1 + 3); // before the first pull, then one for each of three chunks
  });

  it('a lease that ends mid-stream throws at the next chunk, and ends the source stream', async () => {
    let live = true;
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield* [1, 2, 65_536];
      } finally {
        closed = true;
      }
    }
    const it = guardIdIterable(source(), () => {
      if (!live) ended();
    })[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    live = false;
    expect((await it.next()).value).toBe(2);
    await expect(it.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(closed).toBe(true);
  });

  it('leaving a live stream early ends the source', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield* [1, 2, 3];
      } finally {
        closed = true;
      }
    }
    for await (const v of guardIdIterable(source(), () => undefined)) {
      expect(v).toBe(1);
      break;
    }
    expect(closed).toBe(true);
  });
});

describe('guardItems', () => {
  it('checks before the first pull, and before each item', async () => {
    let checks = 0;
    const g = guardItems(idsOf(1, 2), () => void (checks += 1));
    expect(await drain(g)).toEqual([1, 2]);
    expect(checks).toBe(3);
  });

  it('throws on an empty stream whose lease has ended', async () => {
    await expect(drain(guardItems(idsOf(), ended))).rejects.toBeInstanceOf(LeaseExpiredError);
  });
});
