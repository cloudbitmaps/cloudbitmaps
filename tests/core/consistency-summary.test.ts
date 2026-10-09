import { randomBytes } from 'node:crypto';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { runConsistencyCheck } from '@/core/consistency';
import { openSummary, sealSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

/**
 * `checkConsistency({ summaries: true })` holds each row's summary against its object and reports `summary-mismatch`
 * where they differ. It opens objects only when asked: the default check lists, as it always did. A sealed summary is
 * held against its object when the store has the key, and is counted as unchecked when it does not.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world(encrypted: boolean) {
  const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
  const backend = new MemoryStorage();
  const store = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(encrypted ? { encryption: { keystore } } : {}),
  });
  const calls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(backend.storage, calls);
  return { keystore, backend, store, storage, calls, registry: backend.registry };
}

describe('checkConsistency with summaries', () => {
  it('a coherent store reports nothing, and the default check opens no object', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3], { metadata: { a: 1 } });
    const plain = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
    expect(plain).toEqual({ checked: 1, inconsistent: [], errored: [] });
    expect(w.calls.getTail ?? 0).toBe(0);
    const deep = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry },
      { summaries: true },
    );
    expect(deep).toEqual({ checked: 1, inconsistent: [], errored: [], summariesUnchecked: 0 });
    expect(w.calls.getTail).toBe(1);
  });

  it('a row whose count or metadata differs from its object is a summary-mismatch', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3], { metadata: { a: 1 } });
    const row = (await w.registry.get(SEG))!;
    const fingerprint = (row.summary as { fingerprint: string }).fingerprint;
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: { generation: 0, cardinality: 99, fingerprint, metadata: { a: 1 } },
    });
    const report = await w.store.checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 0, issue: 'summary-mismatch' },
    ]);
    const again = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, again.token, {
      summary: { generation: 0, cardinality: 3, fingerprint, metadata: { a: 2 } },
    });
    expect((await w.store.checkConsistency({ summaries: true })).inconsistent).toHaveLength(1);
    // The count and metadata it says, of another object than the one under its number.
    const third = (await w.registry.get(SEG))!;
    const [size, crc] = fingerprint.split(':').map(Number) as [number, number];
    await w.registry.compareAndSwap(SEG, third.token, {
      summary: {
        generation: 0,
        cardinality: 3,
        fingerprint: `${size}:${(crc ^ 1) >>> 0}`,
        metadata: { a: 1 },
      },
    });
    expect((await w.store.checkConsistency({ summaries: true })).inconsistent).toHaveLength(1);
    // Without asking, the check does not look.
    expect((await w.store.checkConsistency()).inconsistent).toEqual([]);
  });

  it('a torn restore is still the missing generation, and is not also a mismatch', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3]);
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    const report = await w.store.checkConsistency({ summaries: true });
    expect(report.inconsistent.map((i) => i.issue)).toEqual(['missing-storage-generation']);
  });

  it('a sealed summary is checked with the key, and counted as unchecked without it', async () => {
    const w = world(true);
    await w.store.load(SEG, [1, 2, 3]);
    const row = (await w.registry.get(SEG))!;
    const aead = await w.keystore.openDek(row.wrappedDeks!);
    const { fingerprint } = openSummary(
      aead,
      SEG,
      row.summary as { generation: number; sealed: string },
    );
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: sealSummary(aead, SEG, 0, 99, fingerprint),
    });
    const withKey = await w.store.checkConsistency({ summaries: true });
    expect(withKey.inconsistent.map((i) => i.issue)).toEqual(['summary-mismatch']);
    expect(withKey.summariesUnchecked).toBe(0);
    const keyless = await new CloudRoaring({ storage: w.backend, retry: false }).checkConsistency({
      summaries: true,
    });
    expect(keyless.inconsistent).toEqual([]);
    expect(keyless.summariesUnchecked).toBe(1);
  });
});
