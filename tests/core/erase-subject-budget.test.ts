import { CloudRoaring, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * `eraseSubject` charges one budget unit per registered segment, and one more for each generation it opens beyond
 * the one the row names: a segment whose current generation lacks the id is searched generation by generation, and
 * with the keep-everything default of the `*Into` verbs that is one open per generation the segment ever had.
 * A segment that runs the call out of budget is reported with an `error:` note, before anything of it is deleted;
 * it is never reported as erased.
 */
const NS = 'ns';
const ID = 7;
const ref = (segment: string): SegmentRef => ({ namespace: NS, segment });

/** Load `generations` generations of `segment`, each published in turn and none collected. */
async function history(
  backend: MemoryStorage,
  segment: string,
  generations: readonly (readonly number[])[],
): Promise<void> {
  for (const [generation, ids] of generations.entries()) {
    await bulkLoadCrbmGeneration(backend.storage, { ...ref(segment), generation }, [...ids], {
      registry: backend.registry,
    });
  }
}

async function present(backend: MemoryStorage, segment: string): Promise<number[]> {
  const out: number[] = [];
  for await (const key of backend.storage.list(ref(segment))) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

async function holds(
  backend: MemoryStorage,
  segment: string,
  generation: number,
): Promise<boolean> {
  const reader = await openGenerationReader(
    backend.storage,
    { ...ref(segment), generation },
    undefined,
  );
  const bytes = await reader.getChunk(0);
  return bytes !== null && roaringCodec.safeDeserialize(bytes, 1 << 20).has(ID);
}

const cleanGenerations = (n: number): number[][] => Array.from({ length: n }, () => [1, 2, 3]);

describe('eraseSubject charges the generations it opens', () => {
  it('a segment with many superseded generations exhausts a small budget it fit in before', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'audience', cleanGenerations(5)); // current 4, four superseded, none holds the id
    const store = new CloudRoaring({ storage: backend });

    // One unit for the segment and one for each of the four superseded generations it opens: five.
    const enough = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 5 } });
    expect(enough).toEqual({ id: ID, erasedFrom: [], scannedSegments: 1 });

    const short = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 4 } });
    expect(short.erasedFrom).toHaveLength(1);
    expect(short.erasedFrom[0]).toMatchObject({ segment: 'audience', erased: false });
    expect(short.erasedFrom[0]!.note).toMatch(/^error: eraseSubject would fan out to \d+ units/);
    expect(await present(backend, 'audience')).toEqual([0, 1, 2, 3, 4]); // nothing was touched
  });

  it('refuses before deleting, and says so: a holder stays, the ledger says not erased, a re-run settles it', async () => {
    const backend = new MemoryStorage();
    // The id is in generation 0 only: dropped by the second load, and every later one lacks it.
    await history(backend, 'audience', [[ID, 1, 2], ...cleanGenerations(5)]);
    const store = new CloudRoaring({ storage: backend });
    const pointer = (await backend.registry.get(ref('audience')))!.currentGen;

    const refused = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 4 } });
    expect(refused.erasedFrom).toHaveLength(1);
    expect(refused.erasedFrom[0]).toMatchObject({ erased: false });
    expect(refused.erasedFrom[0]!.note).toMatch(/^error: /);
    expect(await present(backend, 'audience')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await holds(backend, 'audience', 0)).toBe(true); // still there, and the ledger did not claim otherwise
    expect((await backend.registry.get(ref('audience')))!.currentGen).toBe(pointer);

    const done = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 100 } });
    expect(done.erasedFrom).toHaveLength(1);
    expect(done.erasedFrom[0]).toMatchObject({ erased: true });
    expect(await present(backend, 'audience')).toEqual([5]);
  });

  it('the ledger is truthful when the budget runs out part-way through a fleet', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'a-member', [[ID, 1]]);
    await history(backend, 'b-long-history', [[ID, 1], ...cleanGenerations(6)]);
    await history(backend, 'c-member', [[ID, 2]]);
    const store = new CloudRoaring({ storage: backend });

    // Three segments and room for two opens. The members cost nothing beyond their segment's unit, so they are
    // erased on either side of the one whose history does not fit.
    const ledger = await store.eraseSubject(ID, {
      namespace: NS,
      concurrency: 1,
      budget: { maxRequests: 5 },
    });
    expect(ledger.scannedSegments).toBe(3);
    expect(ledger.erasedFrom.map((e) => [e.segment, e.erased])).toEqual([
      ['a-member', true],
      ['b-long-history', false],
      ['c-member', true],
    ]);
    expect(ledger.erasedFrom[1]!.note).toMatch(/^error: /);
    // What is reported erased is gone, and what is reported not erased is exactly as it was.
    expect(await present(backend, 'a-member')).toHaveLength(1);
    expect(await present(backend, 'c-member')).toHaveLength(1);
    expect(await present(backend, 'b-long-history')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(await holds(backend, 'b-long-history', 0)).toBe(true);
  });

  it('charges nothing for a segment whose own rewrite it is: one unit, however the rewrite reads back', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'member', [[ID, 1, 2]]);
    const store = new CloudRoaring({ storage: backend });
    const ledger = await store.eraseSubject(ID, { namespace: NS, budget: { maxRequests: 1 } });
    expect(ledger.erasedFrom).toHaveLength(1);
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
  });

  it('the default budget erases a normal fleet, history and all', async () => {
    const backend = new MemoryStorage();
    for (let i = 0; i < 40; i++) {
      await history(backend, `seg-${i}`, [
        [ID, 1, 2],
        [1, 2],
        [1, 2, 3],
      ]); // an ex-member with two later loads
    }
    const store = new CloudRoaring({ storage: backend });
    const ledger = await store.eraseSubject(ID, { namespace: NS });
    expect(ledger.scannedSegments).toBe(40);
    expect(ledger.erasedFrom).toHaveLength(40);
    expect(ledger.erasedFrom.every((e) => e.erased)).toBe(true);
    for (let i = 0; i < 40; i++) expect(await present(backend, `seg-${i}`)).toEqual([2]);
  });

  it('`budget: false` charges nothing', async () => {
    const backend = new MemoryStorage();
    await history(backend, 'audience', cleanGenerations(20));
    const store = new CloudRoaring({ storage: backend, budget: { maxRequests: 2 } });
    const ledger = await store.eraseSubject(ID, { namespace: NS, budget: false });
    expect(ledger.erasedFrom).toEqual([]);
  });
});
