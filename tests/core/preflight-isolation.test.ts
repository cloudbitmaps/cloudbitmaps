import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { PREFLIGHT_NAMESPACE, PREFLIGHT_SEGMENT } from '@/core/preflight';
import { RESERVED_NAMESPACE_PREFIX } from '@/core/validate';
import { runPreflight } from '@/core/preflight';
import { counterEntropy } from '../helpers/entropy';

/**
 * The probe lives in a namespace inside the reserved `cbm.due.` prefix. A probe object or a probe row that is planted
 * (a run cut off mid-way leaves the first; a hostile or confused writer could leave either) is never read as a
 * segment by the scans, the sweeps, the erasures, the export or the collection of a load.
 */

const PROBE = { namespace: PREFLIGHT_NAMESPACE, segment: PREFLIGHT_SEGMENT };
const drain = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

/** A store with one real segment of ids 1..3 over two generations, a probe object and a probe row planted. */
async function planted() {
  const memory = new MemoryStorage();
  const store = new CloudRoaring({ storage: memory });
  await store.load({ segment: 's' }, [1, 2, 3]);
  await store.load({ segment: 's' }, [1, 2, 3, 4]);
  for (const generation of [5, 6]) {
    await memory.storage.putImmutable({ ...PROBE, generation }, async (sink) =>
      sink.write(new Uint8Array([1, 2, 3])),
    );
  }
  await memory.registry.create(PROBE, { currentGen: 5 });
  const probeObjects = async () =>
    (await drain(memory.storage.list(PROBE))).map((k) => k.generation);
  const probeRow = async () => (await memory.registry.get(PROBE)) !== null;
  return { memory, store, probeObjects, probeRow };
}

describe('a planted probe object or row is never a segment', () => {
  it('the namespace is one an application cannot name', async () => {
    expect(PREFLIGHT_NAMESPACE.startsWith(RESERVED_NAMESPACE_PREFIX)).toBe(true);
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(store.load(PROBE, [1])).rejects.toBeInstanceOf(ValidationError);
    expect(() => store.segment(PROBE.segment, { namespace: PROBE.namespace })).toThrow(
      ValidationError,
    );
  });

  it('segments() lists only the real segment', async () => {
    const { store } = await planted();
    expect((await drain(store.segments())).map((s) => s.segment)).toEqual(['s']);
  });

  it('checkConsistency() counts one segment and finds nothing wrong', async () => {
    const { store } = await planted();
    const report = await store.checkConsistency({ generations: true, summaries: true });
    expect(report.checked).toBe(1);
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([]);
  });

  it('retireExpired() scans one segment, in the fleet scan and the index scan, and touches no probe', async () => {
    const { store, probeObjects, probeRow } = await planted();
    for (const scan of ['fleet', 'index'] as const) {
      const out = await store.retireExpired({ scan, now: Date.now() + 10 * 365 * 86_400_000 });
      expect(out.retired).toBe(0);
      expect(out.scanned).toBeLessThanOrEqual(1);
    }
    expect(await probeObjects()).toEqual([5, 6]);
    expect(await probeRow()).toBe(true);
  });

  it('the erasures read one segment and leave the probe alone', async () => {
    const { store, probeObjects, probeRow } = await planted();
    const report = await store.subjectReport(2, { allNamespaces: true });
    expect(report.scannedSegments).toBe(1);
    expect(report.segments.map((s) => s.segment)).toEqual(['s']);
    const erased = await store.eraseSubject(2, { allNamespaces: true });
    expect(erased.scannedSegments).toBe(1);
    expect(erased.erasedFrom.map((e) => `${e.segment}:${String(e.erased)}`)).toEqual(['s:true']);
    expect(await probeObjects()).toEqual([5, 6]);
    expect(await probeRow()).toBe(true);
  });

  it('exportSegments() exports one segment', async () => {
    const { store } = await planted();
    const opened: string[] = [];
    const manifest = await store.exportSegments({
      open: (ref) => {
        opened.push(`${ref.namespace ?? ''}/${ref.segment}`);
        return { write: () => undefined, close: () => undefined };
      },
    });
    expect(manifest.totalSegments).toBe(1);
    expect(manifest.failed).toEqual([]);
    expect(opened).toEqual(['/s']);
  });

  it('the collection of a load, and the drop of a segment, delete none of the probe', async () => {
    const { store, probeObjects, probeRow } = await planted();
    for (let i = 0; i < 4; i++) await store.load({ segment: 's' }, [i + 10], { keep: 1 });
    expect(await probeObjects()).toEqual([5, 6]);
    await store.dropSegment({ segment: 's' }, { confirmSegment: 's' });
    expect(await probeObjects()).toEqual([5, 6]);
    expect(await probeRow()).toBe(true);
  });

  it('a preflight beside a planted probe leaves it, names it, and removes only its own', async () => {
    const { memory, probeObjects } = await planted();
    const out = await runPreflight({
      storage: memory.storage,
      registry: memory.registry,
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      entropy: counterEntropy(),
    });
    // The planted row is at the probe address, so the registry check names it; the object steps are not affected.
    expect(out.checks.find((c) => c.name === 'registry')?.status).toBe('problem');
    expect(out.checks.find((c) => c.name === 'list')?.detail).toContain('2 other probe objects');
    expect(await probeObjects()).toEqual([5, 6]);
  });
});
