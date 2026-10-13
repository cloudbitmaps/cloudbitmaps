import { MemoryStorage, TransientError, eraseNamespace } from '@/index';
import type { IRegistryDriver } from '@/core/ports';
import type { AuditEvent } from '@/core/audit';

// `eraseNamespace` shreds its segments a few at a time. Each still goes through its own get and compare-and-swap
// fence, one segment's failure is recorded against it and stops no other, and the ledger comes back in the listing's
// order whatever order the segments finish in.

const NS = 'tenant';
const BOUND = 8; // the internal erasure bound

const name = (i: number): string => `s${String(i).padStart(3, '0')}`;

async function seeded(count: number): Promise<IRegistryDriver> {
  const { registry } = new MemoryStorage();
  for (let i = 0; i < count; i++) {
    await registry.create(
      { namespace: NS, segment: name(i) },
      { currentGen: 1, wrappedDeks: [{ keyId: 'k', wrapped: 'w' }] },
    );
  }
  return registry;
}

interface Probe {
  readonly registry: IRegistryDriver;
  readonly stats: { inflight: number; peak: number; gets: string[]; swaps: string[] };
}

/** Every `get` parks for a delay that depends on the segment, so segments finish out of listing order. */
function probe(
  inner: IRegistryDriver,
  opts: { delay?: (segment: string) => number; fail?: (segment: string) => Error | undefined } = {},
): Probe {
  const stats = { inflight: 0, peak: 0, gets: [] as string[], swaps: [] as string[] };
  const park = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const registry: IRegistryDriver = {
    capabilities: () => inner.capabilities(),
    list: (ns) => inner.list(ns),
    create: (ref, rec) => inner.create(ref, rec),
    delete: (ref, expected) => inner.delete(ref, expected),
    get: async (ref) => {
      stats.gets.push(ref.segment);
      stats.inflight++;
      stats.peak = Math.max(stats.peak, stats.inflight);
      try {
        await park(opts.delay?.(ref.segment) ?? 1);
        return await inner.get(ref);
      } finally {
        stats.inflight--;
      }
    },
    compareAndSwap: async (ref, expected, patch) => {
      stats.swaps.push(ref.segment);
      const err = opts.fail?.(ref.segment);
      if (err !== undefined) throw err;
      return inner.compareAndSwap(ref, expected, patch);
    },
  };
  return { registry, stats };
}

const statusOf = async (registry: IRegistryDriver, segment: string): Promise<string | undefined> =>
  (await registry.get({ namespace: NS, segment }))?.status;

describe('eraseNamespace shreds segments with bounded concurrency', () => {
  it('overlaps segments, never above the bound, and fences every one with its own get and swap', async () => {
    const inner = await seeded(40);
    const { registry, stats } = probe(inner);
    const res = await eraseNamespace(NS, { registry }, { confirmNamespace: NS });
    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(BOUND);
    expect(res.destroyed).toHaveLength(40);
    expect(res.destroyed.every((d) => d.destroyed && d.cryptoShredded)).toBe(true);
    expect([...stats.gets].sort()).toEqual(Array.from({ length: 40 }, (_, i) => name(i)));
    expect([...stats.swaps].sort()).toEqual(Array.from({ length: 40 }, (_, i) => name(i)));
    for (let i = 0; i < 40; i++) expect(await statusOf(inner, name(i))).toBe('destroyed');
  });

  it('returns the ledger in listing order and the same result as a serial run, however segments finish', async () => {
    const serialInner = await seeded(24);
    const serial = await eraseNamespace(
      NS,
      { registry: serialInner },
      { confirmNamespace: NS, allowCleartext: false },
    );
    // Earlier segments finish last.
    const inner = await seeded(24);
    const { registry } = probe(inner, { delay: (s) => 30 - Number(s.slice(1)) });
    const events: AuditEvent[] = [];
    const res = await eraseNamespace(
      NS,
      { registry },
      { confirmNamespace: NS, audit: { onEvent: (e) => events.push(e) } },
    );
    expect(res).toEqual(serial);
    expect(res.destroyed.map((d) => d.segment)).toEqual(serial.destroyed.map((d) => d.segment));
    // Every shred is audited once; the namespace record is last and carries the honest count.
    const erased = events.filter((e) => e.kind === 'segment.erase');
    expect(erased).toHaveLength(24);
    expect(new Set(erased.map((e) => (e as { segment: string }).segment)).size).toBe(24);
    expect(events.at(-1)).toEqual({ kind: 'namespace.erase', namespace: NS, segmentsShredded: 24 });
  });

  it('records a transient and a permanent failure against their segments and finishes the rest', async () => {
    const inner = await seeded(20);
    const { registry } = probe(inner, {
      delay: (s) => 30 - Number(s.slice(1)),
      fail: (s) =>
        s === name(3)
          ? new TransientError('registry throttled')
          : s === name(11)
            ? new Error('denied')
            : undefined,
    });
    const events: AuditEvent[] = [];
    const res = await eraseNamespace(
      NS,
      { registry },
      { confirmNamespace: NS, audit: { onEvent: (e) => events.push(e) } },
    );
    expect(res.destroyed.map((d) => d.segment)).toEqual(
      Array.from({ length: 20 }, (_, i) => name(i)),
    );
    expect(res.destroyed[3]).toMatchObject({
      destroyed: false,
      reason: 'failed: registry throttled',
    });
    expect(res.destroyed[11]).toMatchObject({ destroyed: false, reason: 'failed: denied' });
    expect(res.destroyed.filter((d) => d.destroyed)).toHaveLength(18);
    expect(await statusOf(inner, name(3))).toBe('active'); // still holds its data, and says so
    expect(await statusOf(inner, name(11))).toBe('active');
    for (const i of [0, 1, 2, 4, 10, 12, 19])
      expect(await statusOf(inner, name(i))).toBe('destroyed');
    expect(events.filter((e) => e.kind === 'segment.erase')).toHaveLength(18);
    expect(events.at(-1)).toEqual({ kind: 'namespace.erase', namespace: NS, segmentsShredded: 18 });
  });
});
