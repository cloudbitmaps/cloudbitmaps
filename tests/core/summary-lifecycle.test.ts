import { randomBytes } from 'node:crypto';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, RegistryRecord, SegmentRef } from '@/core/ports';
import { clearSegmentRetention, setSegmentRetention } from '@/core/retention';
import { dropSegment, destroySegment } from '@/core/erasure';
import { retireExpired } from '@/core/retention-sweep';
import { summaryAgrees, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { MIN_EXPIRES_AT_MS } from '@/index';

/**
 * What the row's summary of the current generation does through the rest of a segment's life. It describes one
 * generation, so a crypto-shred or a drop clears it with the key material (sealed, it could not be opened again; clear,
 * it would outlive the segment on its tombstone). A retention policy and the writes of the due index change the row and
 * not the generation, so they leave it alone.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const META: GenerationMetadata = { def: 'v3', owner: 'growth' };
const DAY = 86_400_000;
const NOW = MIN_EXPIRES_AT_MS + 700 * DAY;

function world(keystore?: InProcessKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => NOW });
  const load = { storage, registry, codec: roaringCodec, keystore };
  const drop = { storage, registry };
  return { storage, registry, load, drop, keystore };
}
type World = ReturnType<typeof world>;

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

async function loaded(w: World, ref: SegmentRef = SEG): Promise<RegistryRecord> {
  await loadSegment(ref, [1, 2, 3], w.load, { metadata: META });
  const row = (await w.registry.get(ref))!;
  expect(row.summary).toBeDefined();
  return row;
}

describe('a crypto-shred or a drop', () => {
  it('clears the summary of a cleartext segment with its tombstone', async () => {
    const w = world();
    await loaded(w);
    const dropped = await dropSegment(SEG, w.drop, { confirmSegment: 's' });
    expect(dropped.dropped).toBe(true);
    const row = (await w.registry.get(SEG))!;
    expect(row.status).toBe('destroyed');
    expect(row.summary).toBeUndefined();
    // Nor does the tombstone keep the count or the metadata under any other name.
    expect(JSON.stringify(row)).not.toContain('growth');
    expect(JSON.stringify(row)).not.toContain('cardinality');
  });

  it('clears the sealed summary of an encrypted segment with its key material', async () => {
    const w = world(key());
    await loaded(w);
    const shred = await destroySegment(SEG, w.drop, { confirmSegment: 's' });
    expect(shred).toMatchObject({ destroyed: true, cryptoShredded: true });
    const row = (await w.registry.get(SEG))!;
    expect(row.status).toBe('destroyed');
    expect(row.wrappedDeks).toBeUndefined();
    expect(row.summary).toBeUndefined();
  });

  it('clears it on a drop of an encrypted segment as well, and on a cleartext opt-in tombstone', async () => {
    const encrypted = world(key());
    await loaded(encrypted);
    await dropSegment(SEG, encrypted.drop, { confirmSegment: 's' });
    expect((await encrypted.registry.get(SEG))!.summary).toBeUndefined();

    const cleartext = world();
    await loaded(cleartext);
    await destroySegment(SEG, cleartext.drop, { confirmSegment: 's', allowCleartext: true });
    expect((await cleartext.registry.get(SEG))!.summary).toBeUndefined();
  });

  it('clears the summary of a segment a retention sweep retires', async () => {
    const w = world();
    await loaded(w);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: NOW - DAY });
    expect((await w.registry.get(SEG))!.summary).toBeDefined();
    const result = await retireExpired(w.drop, { now: NOW });
    expect(result.retired).toBe(1);
    const row = (await w.registry.get(SEG))!;
    expect(row.status).toBe('destroyed');
    expect(row.summary).toBeUndefined();
  });
});

describe.each([
  ['cleartext', (): World => world()],
  ['encrypted', (): World => world(key())],
])('a retention policy on a %s segment', (_name, make) => {
  it('leaves the summary as it was, whether it is set, moved or cleared', async () => {
    const w = make();
    const before = await loaded(w);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: NOW + 3 * DAY });
    const set = (await w.registry.get(SEG))!;
    expect(set.token).not.toBe(before.token); // the row was written
    expect(set.summary).toEqual(before.summary);

    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: NOW + 9 * DAY });
    expect((await w.registry.get(SEG))!.summary).toEqual(before.summary);

    await clearSegmentRetention(SEG, { registry: w.registry });
    const cleared = (await w.registry.get(SEG))!;
    expect(cleared.summary).toEqual(before.summary);
    expect(cleared.retention).toBeUndefined();
  });

  it('leaves it usable: it still names the current generation, and says what the object holds', async () => {
    const w = make();
    const before = await loaded(w);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: NOW + DAY });
    const row = (await w.registry.get(SEG))!;
    const aead =
      row.wrappedDeks === undefined ? undefined : await w.keystore!.openDek(row.wrappedDeks);
    expect(summaryAgrees(usableSummary(SEG, row, aead)!, { cardinality: 3, metadata: META })).toBe(
      true,
    );
    expect(row.summary).toEqual(before.summary);
  });

  it('leaves it alone through a sweep that finds the segment not yet due', async () => {
    const w = make();
    const before = await loaded(w);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: NOW + 3 * DAY });
    const result = await retireExpired(w.drop, { now: NOW });
    expect(result.retired).toBe(0);
    expect((await w.registry.get(SEG))!.summary).toEqual(before.summary);
  });
});
