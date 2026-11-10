import { randomBytes } from 'node:crypto';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { runConsistencyCheck } from '@/core/consistency';
import { openSummary, sealSummary, tailBytesFit } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

/**
 * `checkConsistency({ summaries: true })` holds each row's summary against its object and reports `summary-mismatch`
 * where they differ. It opens objects only when asked: the default check only looks for them. A sealed summary is
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
  it('a coherent store reports nothing, and the default check only looks for the object', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3], { metadata: { a: 1 } });
    const plain = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
    expect(plain).toEqual({ checked: 1, inconsistent: [], errored: [] });
    // One zero-length tail read, which proves the object is there and opens nothing.
    expect(w.calls.getTail).toBe(1);
    const deep = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry },
      { summaries: true },
    );
    expect(deep).toEqual({ checked: 1, inconsistent: [], errored: [], summariesUnchecked: 0 });
    // The open's own tail read is the only one more: it answers whether the object is there as well.
    expect(w.calls.getTail).toBe(2);
  });

  it('a row whose count or metadata differs from its object is a summary-mismatch', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3], { metadata: { a: 1 } });
    const row = (await w.registry.get(SEG))!;
    const { fingerprint, tailBytes } = row.summary as { fingerprint: string; tailBytes: number };
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: { generation: 0, cardinality: 99, fingerprint, tailBytes, metadata: { a: 1 } },
    });
    const report = await w.store.checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 0, issue: 'summary-mismatch' },
    ]);
    const again = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, again.token, {
      summary: { generation: 0, cardinality: 3, fingerprint, tailBytes, metadata: { a: 2 } },
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
        tailBytes,
        metadata: { a: 1 },
      },
    });
    expect((await w.store.checkConsistency({ summaries: true })).inconsistent).toHaveLength(1);
    // Without asking, the check does not look.
    expect((await w.store.checkConsistency()).inconsistent).toEqual([]);
  });

  // No read uses a summary of these kinds, so the object is opened unchecked: each is a row the check reports, not one
  // it passes. Four shapes on a row with no keys; a shipped registry refuses each when it writes the row.
  // A registry of your own can hand over a row whose summary no read uses; the helper returns a registry that changes
  // each row's summary (or drops it) on get and list.
  const summaryOverride = (
    w: ReturnType<typeof world>,
    change: (summary: Record<string, unknown>) => Record<string, unknown> | undefined,
  ): IRegistryDriver => {
    const patched = (row: RegistryRecord): RegistryRecord => {
      const summary = change({ ...(row.summary ?? {}) });
      const rest: Record<string, unknown> = { ...row };
      delete rest.summary;
      return (summary === undefined ? rest : { ...rest, summary }) as unknown as RegistryRecord;
    };
    return {
      capabilities: () => w.registry.capabilities(),
      get: async (ref) => {
        const row = await w.registry.get(ref);
        return row === null ? row : patched(row);
      },
      create: (ref, rec, o) => w.registry.create(ref, rec, o),
      compareAndSwap: (ref, t, patch, o) => w.registry.compareAndSwap(ref, t, patch, o),
      list: async function* (ns) {
        for await (const row of w.registry.list(ns)) yield patched(row);
      },
      delete: (ref, t) => w.registry.delete(ref, t),
    };
  };

  it.each([['abc'], [5], ['0:1']])(
    'a clear summary whose fingerprint is %j, from a registry of your own, is a summary-mismatch',
    async (fingerprint) => {
      const w = world(false);
      await w.store.load(SEG, [1, 2, 3]);
      const registry = summaryOverride(w, (s) => ({ ...s, fingerprint }));
      const report = await runConsistencyCheck(
        { storage: w.storage, registry },
        { summaries: true },
      );
      expect(report.inconsistent).toEqual([
        { segment: 's', namespace: 'ns', currentGen: 0, issue: 'summary-mismatch' },
      ]);
      expect(report.summariesUnchecked).toBe(0);
    },
  );

  it.each([
    [
      'a sealed summary on a row with no keys',
      (s: Record<string, unknown>) => ({ generation: s.generation, sealed: 'AAAA' }),
    ],
    [
      'a clear summary of another generation than the pointer',
      (s: Record<string, unknown>) => ({ ...s, generation: 1 }),
    ],
    [
      'a clear summary whose tailBytes no object of its size can have',
      (s: Record<string, unknown>) => ({ ...s, tailBytes: 1e9 }),
    ],
  ])('%s, from a registry of your own, is a summary-mismatch', async (_name, change) => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3]);
    const registry = summaryOverride(w, change);
    const report = await runConsistencyCheck({ storage: w.storage, registry }, { summaries: true });
    expect(report.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 0, issue: 'summary-mismatch' },
    ]);
    expect(report.summariesUnchecked).toBe(0);
  });

  it('the summaries a shipped registry stores are not reported: a coherent one, and none', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3]);
    await w.store.load(SEG, [1, 2, 3, 4]);
    for (const registry of [w.registry, summaryOverride(w, () => undefined)]) {
      const report = await runConsistencyCheck(
        { storage: w.storage, registry },
        { summaries: true },
      );
      expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], summariesUnchecked: 0 });
    }
    // A rollback onto an older generation leaves a summary of that generation, which is the pointer's.
    await w.store.rollback(SEG, 0);
    expect((await w.store.checkConsistency({ summaries: true })).inconsistent).toEqual([]);
  });

  it('a keyed row keeps its behaviour for each shape: its sealed and other-generation shapes are not reported, and are counted as unchecked', async () => {
    const w = world(true);
    await w.store.load(SEG, [1, 2, 3]);
    // (A keyed row's tailBytes is inside its sealed summary, so a clear one is not a shape a keyed row has.)
    for (const [i, change] of [
      (s: Record<string, unknown>) => ({ generation: s.generation, sealed: 'AAAA' }),
      (s: Record<string, unknown>) => ({ ...s, generation: 1 }),
    ].entries()) {
      const registry = summaryOverride(w, change);
      const report = await runConsistencyCheck(
        { storage: w.storage, registry, keystore: w.keystore },
        { summaries: true },
      );
      expect(report.inconsistent).toEqual([]);
      expect([i, report.summariesUnchecked]).toEqual([i, 1]);
    }
  });

  it('the default check does not look at any of the shapes', async () => {
    const w = world(false);
    await w.store.load(SEG, [1, 2, 3]);
    for (const change of [
      (s: Record<string, unknown>) => ({ generation: s.generation, sealed: 'AAAA' }),
      (s: Record<string, unknown>) => ({ ...s, generation: 1 }),
      (s: Record<string, unknown>) => ({ ...s, tailBytes: 1e9 }),
      (s: Record<string, unknown>) => ({ ...s, fingerprint: 'abc' }),
    ]) {
      const registry = summaryOverride(w, change);
      const report = await runConsistencyCheck({ storage: w.storage, registry });
      expect(report).toEqual({ checked: 1, inconsistent: [], errored: [] });
    }
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
    const { fingerprint, tailBytes } = openSummary(
      aead,
      SEG,
      row.summary as { generation: number; sealed: string },
    );
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: sealSummary(aead, SEG, 0, 99, fingerprint, tailBytes),
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

  it('a sealed summary whose tailBytes the object does not bear out is a summary-mismatch', async () => {
    const w = world(true);
    await w.store.load(SEG, [1, 70_000, 140_000, 210_000, 280_000]);
    const row = (await w.registry.get(SEG))!;
    const aead = await w.keystore.openDek(row.wrappedDeks!);
    const opened = openSummary(aead, SEG, row.summary as { generation: number; sealed: string });
    const wrong = opened.tailBytes + 8;
    // Still a number a sealed summary of this object can carry, so the summary is used and held to the object.
    expect(tailBytesFit(wrong, Number(opened.fingerprint.split(':')[0]))).toBe(true);
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: sealSummary(
        aead,
        SEG,
        0,
        opened.cardinality,
        opened.fingerprint,
        wrong,
        opened.metadata,
      ),
    });
    const report = await w.store.checkConsistency({ summaries: true });
    expect(report.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 0, issue: 'summary-mismatch' },
    ]);
    expect(report.summariesUnchecked).toBe(0);
  });
});
