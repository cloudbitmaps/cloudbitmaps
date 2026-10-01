import { CloudRoaring } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { SegmentRef } from '@/index';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { loadedStore } from '../helpers/loaded';

/**
 * An access report (GDPR Art. 15) reads the membership of every registered segment. A store keeps a resolved
 * snapshot per segment that may be up to `cache.genTtlMs` behind the registry, or have no timed refresh
 * (`genTtlMs: 0`). `eraseSubject` invalidates what it derived; a load or an erasure from ANOTHER process does not
 * reach this store's cache, so the report has to compare each segment's row with what the cache holds.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 'seg' };
const ONLY_ME = { namespace: 'ns' } as const;

describe.each([
  ['the default TTL', undefined],
  ['no timed refresh (genTtlMs: 0)', { genTtlMs: 0 }],
])('subjectReport is current as of the registry row — %s', (_label, cache) => {
  async function world() {
    // `loadedStore` defaults to no timed refresh when neither a clock nor a TTL is given, so the default-TTL case
    // builds its own reader; a real clock makes the window (2 s) far longer than this test runs.
    const w = await loadedStore();
    await w.load(REF, [1, 2]);
    const reader = new CloudRoaring({ storage: w.backend, ...(cache ? { cache } : {}) });
    const other = new CloudRoaring({ storage: w.backend });
    return { ...w, reader, other };
  }

  it('shows a generation another store loaded, at once', async () => {
    const { reader, other } = await world();
    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([]); // warms the snapshot

    const res = await other.load(REF, [1, 2, 77]);
    expect(res.published).toBe(true);

    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([REF]);
  });

  it('stops showing an id another store erased, at once', async () => {
    const { reader, other } = await world();
    await other.load(REF, [1, 2, 77]);
    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([REF]); // warms the snapshot

    await other.eraseSubject(77, ONLY_ME);

    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([]);
  });
});

describe('subjectReport does not re-resolve a segment whose row has not moved', () => {
  it('a second report over unchanged segments reads no segment and fetches no row', async () => {
    const w = await loadedStore();
    await w.load(REF, [1, 2, 77]);
    await w.load({ ...REF, segment: 'seg2' }, [3]);
    const counts: Record<string, number> = {};
    const registry = counting(w.registry, counts);
    const storage = counting(w.storage, counts);
    const reader = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: 0 },
    });

    const first = await reader.subjectReport(77, ONLY_ME); // warms both segments
    expect(first.segments).toEqual([REF]);
    expect(first.scannedSegments).toBe(2);

    for (const k of Object.keys(counts)) counts[k] = 0;
    const second = await reader.subjectReport(77, ONLY_ME);
    expect(second).toEqual(first);

    expect(counts.get ?? 0).toBe(0); // no registry row fetched beyond the listing
    expect(counts.getTail ?? 0).toBe(0); // no generation reopened
    expect(counts.getRange ?? 0).toBe(0); // no chunk re-read: served from the cache
    expect(counts.list).toBe(1); // the one registry scan the report starts from
  });
});

describe('subjectReport tells a re-created name from the old one at the same generation number', () => {
  it('a segment retired, purged and loaded again from generation 0 is re-read, not served from the snapshot', async () => {
    const w = await loadedStore();
    await w.load(REF, [1, 2, 77]); // generation 0
    const reader = new CloudRoaring({ storage: w.backend, cache: { genTtlMs: 0 } });
    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([REF]); // warms generation 0 of incarnation 1

    // Another process retires the name completely and loads it again: the new row restarts at generation 0.
    for await (const k of w.storage.list(REF)) await w.storage.delete(k);
    await w.registry.delete(REF);
    await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const row = await w.registry.get(REF);
    expect(row?.currentGen).toBe(0); // same number as the snapshot this store holds

    expect((await reader.subjectReport(77, ONLY_ME)).segments).toEqual([]);
  });
});
