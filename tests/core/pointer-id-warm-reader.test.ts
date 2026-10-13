vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
/**
 * A warm reader keys what it holds on a generation with the row's `pointerId` (invariant 2), so a row write that does
 * not change what the row resolves to costs it nothing more than the registry read its TTL refresh makes anyway: a
 * retention policy, a lease taken or released. A write that does change it (a publish, a rollback, a renewal of the
 * pointer) re-opens the segment once. Counted at the reader store's own registry and storage, after a TTL lapse.
 */
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { UnsupportedError } from '@/core/errors';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const TTL = 2_000;
const IDS = [1, 65_536, 131_072];
const LEASE_MS = 3_600_000;

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

function world() {
  const backend = new MemoryStorage();
  const clock = manualClock();
  const writer = new CloudRoaring({ storage: backend, retry: false });
  const calls: Record<string, number> = {};
  const rows: Record<string, number> = {};
  const storage = counting<IStorageDriver>(backend.storage, calls);
  const registry = counting<IRegistryDriver>(backend.registry, rows);
  const reader = new CloudRoaring({
    storage: brandAsBackend({ storage, registry }),
    retry: false,
    seams: { clock },
  });
  const reset = (): void => {
    for (const c of [calls, rows]) for (const k of Object.keys(c)) delete c[k];
  };
  const sent = () => ({
    rows: rows.get ?? 0,
    tails: calls.getTail ?? 0,
    ranges: calls.getRange ?? 0,
  });
  const seg = reader.segment('s', { namespace: 'ns' });
  return { backend, writer, reader, clock, reset, sent, seg };
}

type World = ReturnType<typeof world>;

/** A warm reader: one `has()` has opened the generation and cached the chunk it reads. */
async function warm(): Promise<World> {
  const w = world();
  await w.writer.load(SEG, IDS);
  expect(await w.seg.has(1)).toBe(true);
  w.reset();
  return w;
}

/** What one `has()` sends after a TTL lapse. */
async function afterLapse(w: World): Promise<ReturnType<World['sent']>> {
  w.reset();
  w.clock.advance(TTL + 1);
  expect(await w.seg.has(1)).toBe(true);
  return w.sent();
}

describe('a write that leaves what the row resolves to costs a warm reader only its refresh (invariant 2)', () => {
  it('control: no write, a TTL lapse, then a has() sends the registry read alone', async () => {
    const w = await warm();
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a setRetention, then a lapse: the registry read alone', async () => {
    const w = await warm();
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a clearRetention, then a lapse: the registry read alone', async () => {
    const w = await warm();
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    await afterLapse(w);
    await w.writer.clearRetention(SEG);
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a lease taken, then a lapse: the registry read alone; and its release, then a lapse: the same', async () => {
    const w = await warm();
    const pinned = await w.writer
      .segment('s', { namespace: 'ns' })
      .pin({ leaseUntil: Date.now() + LEASE_MS });
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
    await pinned.release();
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });
});

describe('a write that changes what the row resolves to re-opens a warm reader once', () => {
  it('a publish, then a lapse: the new generation is opened and read', async () => {
    const w = await warm();
    await w.writer.load(SEG, [1, 2, 65_536]);
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 1, ranges: 1 });
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 0, ranges: 0 });
  });

  it('a rollback, then a lapse: the generation it names is opened and read', async () => {
    const w = world();
    await w.writer.load(SEG, IDS, { keep: 3 });
    await w.writer.load(SEG, [1, 2], { keep: 3 });
    expect(await w.seg.has(1)).toBe(true);
    await w.writer.rollback(SEG, 0);
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 1, ranges: 1 });
  });

  it('the pointer named at the value it has, then a lapse: the same generation is opened again', async () => {
    const w = await warm();
    const row = (await w.backend.registry.get(SEG))!;
    const { token } = await w.backend.registry.compareAndSwap(SEG, row.token, {
      currentGen: row.currentGen,
    });
    expect((await w.backend.registry.get(SEG))!.pointerId).toBe(token);
    expect(await afterLapse(w)).toEqual({ rows: 1, tails: 1, ranges: 1 });
  });
});

describe('pins of one generation share what they hold across lease and policy writes', () => {
  it("pinnedAt.version is the generation with the row's pointerId, the same across a lease and a policy write", async () => {
    const w = await warm();
    const at = async () => (await w.writer.segment('s', { namespace: 'ns' }).pin()).pinnedAt!;
    const first = await at();
    const row = (await w.backend.registry.get(SEG))!;
    expect(first.version).toBe(`${row.currentGen}:${row.pointerId}`);
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    const leased = await w.writer
      .segment('s', { namespace: 'ns' })
      .pin({ leaseUntil: Date.now() + LEASE_MS });
    expect(leased.pinnedAt!.version).toBe(first.version);
    expect((await at()).version).toBe(first.version);
    await leased.release();
    await w.writer.load(SEG, [9]);
    expect((await at()).version).not.toBe(first.version);
  });

  it('N leased pins of one generation make one tail read between them', async () => {
    const w = await warm();
    w.reset();
    const pins = [];
    for (let i = 0; i < 4; i++) {
      pins.push(await w.seg.pin({ leaseUntil: w.clock.now() + LEASE_MS }));
    }
    expect(w.sent().tails).toBe(1);
    expect(new Set(pins.map((p) => p.pinnedAt!.version)).size).toBe(1);
    for (const p of pins) await p.release();
  });
});

describe('an access report keeps a warm segment across a lease or policy write', () => {
  it('a setRetention between two reports reopens nothing on the second', async () => {
    const w = await warm();
    const counts: Record<string, number> = {};
    const reporter = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting<IStorageDriver>(w.backend.storage, counts),
        registry: w.backend.registry,
      }),
      retry: false,
      cache: { genTtlMs: 0 },
    });
    expect((await reporter.subjectReport(1, { namespace: 'ns' })).segments).toEqual([SEG]);
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    for (const k of Object.keys(counts)) delete counts[k];
    expect((await reporter.subjectReport(1, { namespace: 'ns' })).segments).toEqual([SEG]);
    expect(counts.getTail ?? 0).toBe(0);
    expect(counts.getRange ?? 0).toBe(0);
  });
});

describe('a registry that returns rows without a pointerId', () => {
  it('fails a read of the segment with UnsupportedError, rather than read it', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend, retry: false }).load(SEG, IDS);
    const strip = (r: RegistryRecord | null): RegistryRecord | null => {
      if (r === null) return null;
      const rest: Record<string, unknown> = { ...r };
      delete rest.pointerId;
      return rest as unknown as RegistryRecord;
    };
    const base = backend.registry;
    const earlier: IRegistryDriver = {
      capabilities: () => base.capabilities(),
      get: async (ref) => strip(await base.get(ref)),
      create: (ref, rec, o) => base.create(ref, rec, o),
      compareAndSwap: (ref, t, p, o) => base.compareAndSwap(ref, t, p, o),
      async *list(ns) {
        for await (const r of base.list(ns)) yield strip(r)!;
      },
      delete: (ref, t) => base.delete(ref, t),
    };
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: backend.storage, registry: earlier }),
      retry: false,
    });
    await expect(store.segment('s', { namespace: 'ns' }).has(1)).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(store.segment('s', { namespace: 'ns' }).has(1)).rejects.toThrow(/pointerId/);
  });
});
