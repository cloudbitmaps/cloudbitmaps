vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
import { randomBytes } from 'node:crypto';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import type { Clock, IKeystore, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver, RegistryRecord } from '@/core/ports';
import { NotFoundError } from '@/core/errors';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * What a read costs, and what it serves, once the reader cache has let its segment go inside `cache.genTtlMs`. The store
 * keeps the segment's resolution apart from its reader, so the read sends no registry read, and opens the object only
 * when a chunk it needs is not in the chunk cache: the version a cached chunk is checked against comes from the row's
 * summary, which names the object by its fingerprint. Each count is the reader store's requests, against a world of two
 * segments and a reader cache of one, so reading `b` lets `a`'s reader go.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const B: SegmentRef = { namespace: NS, segment: 'b' };
const HI = 65_536;
const TTL = 2_000;

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function collect(ids: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of ids) out.push(id);
  return out;
}

async function world(options: { ttl?: number; encrypted?: boolean } = {}) {
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
  });
  const calls: Record<string, number> = {};
  const rowCalls: Record<string, number> = {};
  const keyCalls: Record<string, number> = {};
  /** What the reader's registry says of a row, for a test to change what a read finds there. */
  const tamper: { row: (row: RegistryRecord) => RegistryRecord } = { row: (row) => row };
  const registry = counting<IRegistryDriver>(
    new Proxy(backend.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return typeof value === 'function' ? value.bind(t) : value;
        return async (ref: SegmentRef) => {
          const row = await t.get(ref);
          return row === null ? null : tamper.row(row);
        };
      },
    }),
    rowCalls,
  );
  const clock = manualClock();
  const reader = new CloudRoaring({
    storage: brandAsBackend({
      storage: counting<IStorageDriver>(backend.storage, calls),
      registry,
    }),
    retry: false,
    seams: { clock },
    cache: { readerMax: 1, genTtlMs: options.ttl ?? TTL },
    ...(keystore === undefined
      ? {}
      : { encryption: { keystore: counting<IKeystore>(keystore, keyCalls) } }),
  });
  const reset = (): void => {
    for (const c of [calls, rowCalls, keyCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  const sent = () => ({
    rows: rowCalls.get ?? 0,
    tails: calls.getTail ?? 0,
    ranges: calls.getRange ?? 0,
  });
  return {
    backend,
    writer,
    reader,
    clock,
    tamper,
    reset,
    sent,
    keystore,
    unwraps: () => keyCalls.openDek ?? 0,
    a: reader.segment('a', { namespace: NS }),
    b: reader.segment('b', { namespace: NS }),
  };
}

/** `a` and `b` loaded, `a`'s chunk 0 read (so its reader opened and the chunk is cached), then `a`'s reader let go. */
async function letGo(options: { ttl?: number; encrypted?: boolean } = {}) {
  const w = await world(options);
  await w.writer.load(A, [1, HI + 1]);
  await w.writer.load(B, [2]);
  expect(await w.a.has(1)).toBe(true);
  expect(await w.b.has(2)).toBe(true);
  w.reset();
  return w;
}

describe('after the reader cache lets a segment go, inside cache.genTtlMs', () => {
  it('a has() whose chunk is cached sends nothing', async () => {
    const w = await letGo();
    expect(await w.a.has(1)).toBe(true);
    expect(w.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
  });

  it('a has() that needs a chunk sends one tail read and its range, and no row read', async () => {
    const w = await letGo();
    expect(await w.a.has(HI + 1)).toBe(true);
    expect(w.sent()).toEqual({ rows: 0, tails: 1, ranges: 1 });
  });

  it('a count() sends nothing', async () => {
    const w = await letGo();
    expect(await w.a.count()).toBe(2);
    expect(w.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
  });

  it('an iterate opens the object for its shape, and reads no row', async () => {
    const w = await letGo();
    expect(await collect(w.a.iterate())).toEqual([1, HI + 1]);
    expect(w.sent()).toEqual({ rows: 0, tails: 1, ranges: 1 });
  });

  it('encrypted: a has() whose chunk is cached sends nothing, and opens the sealed summary with the key', async () => {
    const w = await letGo({ encrypted: true });
    expect(await w.a.has(1)).toBe(true);
    expect(w.sent()).toEqual({ rows: 0, tails: 0, ranges: 0 });
    expect(w.unwraps()).toBe(1);
  });

  it('once the TTL lapses, the row is read again, and only the row', async () => {
    const w = await letGo();
    w.clock.advance(TTL);
    expect(await w.a.has(1)).toBe(true);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });
});

describe('a store with no timed refresh resolves a segment the reader cache let go again', () => {
  it('genTtlMs 0: a has() whose chunk is cached reads the row, and opens nothing', async () => {
    const w = await letGo({ ttl: 0 });
    expect(await w.a.has(1)).toBe(true);
    expect(w.sent()).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });
});

describe('an object replaced under the same generation and pointerId, under reader-cache pressure', () => {
  const OLD = [20, HI + 20];
  /** What the replacement holds: ids no published generation held. */
  const STRAY = [999, HI + 999, 2 * HI + 999];

  /**
   * Put `ids` under `a`'s generation 0 with no publish: the row still names the object it named. Encrypted, it is sealed
   * under a key of its own, as a first load still in flight would be.
   */
  async function replace(
    w: Awaited<ReturnType<typeof world>>,
    ids: number[],
    encrypted = false,
  ): Promise<void> {
    await w.backend.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(w.backend.storage, { ...A, generation: 0 }, ids, {
      ...(encrypted
        ? { keystore: w.keystore, registry: new MemoryRegistryDriver(), publish: false }
        : {}),
    });
  }

  it.each([
    ['cleartext', false],
    ['encrypted', true],
  ])(
    "%s: is never served, though the reader was let go and reopened from the kept resolution: the reopen is held to the row's fingerprint",
    async (_, encrypted) => {
      const w = await world({ encrypted });
      await w.writer.load(A, OLD);
      await w.writer.load(B, [2]);
      expect(await w.a.has(20)).toBe(true); // opens the object, and caches its chunk 0
      expect(await w.b.has(2)).toBe(true); // lets `a`'s reader go
      await replace(w, STRAY, encrypted);
      w.reset();
      await expect(w.a.has(HI + 999)).rejects.toBeInstanceOf(NotFoundError);
      // The reopen read the row once more, as for a swept generation, and refused the object again.
      expect(w.sent().rows).toBe(1);
      await expect(collect(w.a.iterate())).rejects.toBeInstanceOf(NotFoundError);
      // The chunk cached from the object the row names still answers for it, and nothing of the replacement does.
      expect(await w.a.has(20)).toBe(true);
      expect(await w.a.has(999)).toBe(false);
      expect(await w.a.count()).toBe(OLD.length);
      // Put back, the object is the row's again, and the read serves it.
      if (!encrypted) {
        await replace(w, OLD);
        expect(await collect(w.a.iterate())).toEqual(OLD);
      }
    },
  );

  it('a row with no summary names no object: the reopen names the object it opened, so no chunk of the first answers for it', async () => {
    const w = await world();
    w.tamper.row = (row) => ({ ...row, summary: undefined });
    await w.writer.load(A, OLD);
    await w.writer.load(B, [2]);
    expect(await w.a.has(20)).toBe(true);
    expect(await w.b.has(2)).toBe(true);
    await replace(w, STRAY);
    w.reset();
    // Read under the version of the object now under the number: its chunk, not the one cached from the first.
    expect(await w.a.has(20)).toBe(false);
    expect(await w.a.has(999)).toBe(true);
    expect(w.sent()).toEqual({ rows: 0, tails: 1, ranges: 1 });
  });
});
