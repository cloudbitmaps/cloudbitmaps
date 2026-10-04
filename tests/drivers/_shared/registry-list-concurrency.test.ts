import type { ObjectRow } from '@/drivers/_shared/object-registry';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { CountingObjectStore } from '../../helpers/counting';

// A registry listing is one list plus reads of the rows, 48 at a time. The bound sits under the 50 sockets an SDK
// client has by default, so the reads queue in the pool rather than on the wire.
const BOUND = 48;

/** A store whose reads park on a timer, counting how many are in flight. */
class ParkingStore extends CountingObjectStore {
  inflight = 0;
  peak = 0;
  override async read(key: string): Promise<ObjectRow | null> {
    this.inflight++;
    this.peak = Math.max(this.peak, this.inflight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      return await super.read(key);
    } finally {
      this.inflight--;
    }
  }
}

describe('ObjectStoreRegistry.list reads rows with bounded concurrency', () => {
  it('overlaps the row reads up to the bound and returns every row once, in key order', async () => {
    const store = new ParkingStore(0);
    const registry = new ObjectStoreRegistry(store, undefined, () => 1);
    const count = 250;
    for (let i = 0; i < count; i++) {
      await registry.create({ segment: `s${String(i).padStart(4, '0')}` }, { currentGen: 1 });
    }
    store.peak = 0;
    const seen: string[] = [];
    for await (const rec of registry.list()) seen.push(rec.segment);
    expect(store.peak).toBe(BOUND);
    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    expect(seen).toEqual([...seen].sort());
  });
});
