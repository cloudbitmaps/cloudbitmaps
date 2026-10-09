vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
import { randomBytes } from 'node:crypto';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import type { Clock, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { NotFoundError } from '@/core/errors';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * The row's summary names its generation's object by its fingerprint (its size and footer checksum), and every live
 * open of the generation, however long after its registry read, is checked against it (invariant 2). An object that is
 * not the one the row named is a move: the read resolves the row again, and never serves it. So a reader opened late
 * never serves an object no row names, and a replaced object under an unchanged row is refused, never read.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const TTL = 2_000;
const FIRST = [10, HI + 10];
const OLD = [20, HI + 20];
/** What an object no row names holds: an id no published generation ever held. */
const STRAY = [999, HI + 999, 2 * HI + 999];

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function collect(ids: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of ids) out.push(id);
  return out;
}

async function world(options: { encrypted?: boolean } = {}) {
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const encryption = keystore === undefined ? {} : { encryption: { keystore } };
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false, ...encryption });
  const calls: Record<string, number> = {};
  const rows: Record<string, number> = {};
  const clock = manualClock();
  const reader = new CloudRoaring({
    storage: brandAsBackend({
      storage: counting<IStorageDriver>(backend.storage, calls),
      registry: counting<IRegistryDriver>(backend.registry, rows),
    }),
    retry: false,
    seams: { clock },
    cache: { readerMax: 1, genTtlMs: TTL },
    ...encryption,
  });
  const requests = () => ({
    rows: rows.get ?? 0,
    tails: calls.getTail ?? 0,
    ranges: calls.getRange ?? 0,
  });
  const reset = (): void => {
    for (const c of [calls, rows]) for (const k of Object.keys(c)) delete c[k];
  };
  /** Put `ids` under `a`'s generation `g` with no publish, as a load whose publish was refused or got no answer. */
  const stray = async (g: number, ids: number[]): Promise<void> => {
    await backend.storage.delete({ ...A, generation: g });
    // Encrypted, it is sealed under a key of its own: the row does not hold it, as for a first load still in flight.
    await bulkLoadCrbmGeneration(backend.storage, { ...A, generation: g }, ids, {
      ...(keystore === undefined
        ? {}
        : { keystore, registry: new MemoryRegistryDriver(), publish: false }),
    });
  };
  return {
    backend,
    writer,
    reader,
    clock,
    requests,
    reset,
    stray,
    a: reader.segment('a', { namespace: NS }),
  };
}

describe('a reader opened late never serves an object no row names', () => {
  it.each([
    ['cleartext', false],
    ['encrypted', true],
  ])(
    '%s: a count, a rollback and an erasure, then an unpublished object under the number: the read resolves again',
    async (_, encrypted) => {
      const w = await world({ encrypted });
      await w.writer.load(A, FIRST);
      await w.writer.load(A, OLD);
      // A count answered from the row's summary: a snapshot of generation 1 that opens nothing.
      expect(await w.a.count()).toBe(OLD.length);
      await w.writer.rollback(A, 0);
      const erased = await w.writer.eraseSubject(20, { namespace: NS });
      expect(erased.erasedFrom).toEqual([expect.objectContaining({ segment: 'a', erased: true })]);
      // A load writes number 1 again, and its publish never lands: no row names this object.
      await w.stray(1, STRAY);
      const ids = await collect(w.a.iterate());
      expect(ids).toEqual(FIRST);
      expect(await w.a.has(999)).toBe(false);
    },
  );
});

describe('an object replaced under an unchanged row is never served', () => {
  it('a cold read throws NotFoundError, as for a missing object; a count and a stat answer the row', async () => {
    const w = await world();
    await w.writer.load(A, OLD);
    await w.stray(0, STRAY);
    await expect(w.a.has(999)).rejects.toBeInstanceOf(NotFoundError);
    await expect(collect(w.a.iterate())).rejects.toBeInstanceOf(NotFoundError);
    // The row's figures: what checkConsistency is for.
    expect(await w.a.count()).toBe(OLD.length);
    expect(await w.a.stat()).toMatchObject({ generation: 0, cardinality: OLD.length });
    const report = await w.writer.checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([
      expect.objectContaining({ segment: 'a', currentGen: 0, issue: 'summary-mismatch' }),
    ]);
  });

  it('a replacement that lands between the registry read and the open is refused too', async () => {
    const w = await world();
    await w.writer.load(A, OLD);
    expect(await w.a.count()).toBe(OLD.length); // resolved from the row, nothing opened
    await w.stray(0, STRAY);
    await expect(w.a.has(999)).rejects.toBeInstanceOf(NotFoundError);
    // Put back, the object is the row's again, and the read serves it.
    await w.backend.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(w.backend.storage, { ...A, generation: 0 }, OLD);
    expect(await collect(w.a.iterate())).toEqual(OLD);
  });

  it('a pin of a replaced object is refused', async () => {
    const w = await world();
    await w.writer.load(A, OLD);
    await w.stray(0, STRAY);
    await expect(w.a.pin()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('stat() answers from the row', () => {
  it.each([
    ['cleartext', false],
    ['encrypted', true],
  ])("%s: one registry read cold, nothing warm, and the object's size", async (_, encrypted) => {
    const w = await world({ encrypted });
    await w.writer.load(A, OLD);
    const size = (await w.backend.storage.getTail({ ...A, generation: 0 }, 0)).size;
    w.reset();
    expect(await w.a.stat()).toEqual({ generation: 0, cardinality: OLD.length, sizeBytes: size });
    expect(w.requests()).toEqual({ rows: 1, tails: 0, ranges: 0 });
    w.reset();
    expect(await w.a.stat()).toEqual({ generation: 0, cardinality: OLD.length, sizeBytes: size });
    expect(w.requests()).toEqual({ rows: 0, tails: 0, ranges: 0 });
  });

  it("a torn restore that lost the object reports the row's figures; checkConsistency finds it", async () => {
    const w = await world();
    await w.writer.load(A, OLD);
    const size = (await w.backend.storage.getTail({ ...A, generation: 0 }, 0)).size;
    await w.backend.storage.delete({ ...A, generation: 0 });
    expect(await w.a.stat()).toEqual({ generation: 0, cardinality: OLD.length, sizeBytes: size });
    await expect(w.a.has(20)).rejects.toBeInstanceOf(NotFoundError);
    const report = await w.writer.checkConsistency();
    expect(report.inconsistent).toEqual([
      expect.objectContaining({ segment: 'a', currentGen: 0, issue: 'missing-storage-generation' }),
    ]);
  });
});
