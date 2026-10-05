import { loadSegment } from '@/core/load';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { REGISTRY_SCHEMA_VERSION } from '@/drivers/_shared/registry';
import { MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { CountingObjectStore, counting } from '../helpers/counting';

/**
 * A row an earlier release wrote is schema 2 and records no kept generations. It is read as it is: the first load
 * lists once, keeps the newest `keep` it finds, records them (stamping the row with the current schema), and every
 * load after it collects by name.
 */

const SEG: SegmentRef = { segment: 's' };

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

function world() {
  const store = new CountingObjectStore(0);
  const memory = new MemoryStorageDriver();
  const calls: Record<string, number> = {};
  const registry = new ObjectStoreRegistry(store, undefined, () => 1);
  const deps = { storage: counting<IStorageDriver>(memory, calls), registry, codec: roaringCodec };
  const key = registryObjectKey(undefined, SEG);
  const load = (n: number, keep: number) =>
    loadSegment(
      SEG,
      Array.from({ length: n + 1 }, (_, i) => i),
      deps,
      { keep },
    );
  /** What an earlier release left: the row stamped 2, with no `keptGens`. */
  const downgradeRow = (): void => {
    const row = JSON.parse(store.text(key)!) as {
      schemaVersion: number;
      record: Record<string, unknown>;
    };
    row.schemaVersion = 2;
    delete row.record.keptGens;
    store.plant(key, JSON.stringify(row));
  };
  const stamp = (): number =>
    (JSON.parse(store.text(key)!) as { schemaVersion: number }).schemaVersion;
  return { store, memory, calls, registry, load, downgradeRow, stamp };
}

describe('the first load over a schema-2 row', () => {
  it.each([3, 12])(
    'lists once at keep %i, records the window, and stamps the row',
    async (keep) => {
      const w = world();
      for (let g = 0; g <= keep + 1; g++) await w.load(g, keep);
      const was = (await w.registry.get(SEG))!;
      w.downgradeRow();
      expect(w.stamp()).toBe(2);
      expect(await w.registry.get(SEG)).toMatchObject({ currentGen: was.currentGen });
      expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();

      for (const k of Object.keys(w.calls)) delete w.calls[k];
      const next = was.currentGen! + 1;
      const r = await w.load(next, keep);
      expect(r).toMatchObject({ generation: next, published: true });
      expect(w.calls.list).toBe(1);
      expect(w.stamp()).toBe(REGISTRY_SCHEMA_VERSION);
      const row = (await w.registry.get(SEG))!;
      expect(row.keptGens).toEqual(Array.from({ length: keep }, (_, i) => next - keep + i));
      expect(await generations(w.memory)).toEqual([...row.keptGens!, next]);

      // The next load collects by name.
      for (const k of Object.keys(w.calls)) delete w.calls[k];
      await w.load(next + 1, keep);
      expect(w.calls.list).toBeUndefined();
      expect(w.calls.delete).toBe(1);
      expect(await generations(w.memory)).toHaveLength(keep + 1);
    },
  );

  it('a segment at a generation inside its window needs no listing and starts a list from its next publish', async () => {
    const w = world();
    for (let g = 0; g <= 2; g++) await w.load(g, 12);
    w.downgradeRow();
    for (const k of Object.keys(w.calls)) delete w.calls[k];
    await w.load(3, 12); // keep 12 is at least the generation: nothing to collect, nothing to list
    expect(w.calls.list).toBeUndefined();
    expect(w.stamp()).toBe(REGISTRY_SCHEMA_VERSION);
    expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();
  });
});
