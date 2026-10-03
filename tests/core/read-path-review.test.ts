import { randomBytes } from 'node:crypto';
import { KeyUnavailableError, TransientError, ValidationError } from '@/core/errors';
import type { IKeystore } from '@/core/crypto';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { runConsistencyCheck } from '@/core/consistency';
import { sealSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';
import { seededStore } from '../helpers/loaded';

/**
 * Corners of the read path: the key an encrypted segment's count unwraps, what a caller can do to what `stat()`
 * returns, how long a disagreeing summary stays distrusted, faults on the count's own path, and the checks around it.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const TTL = 2_000;

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => {},
    advance: (ms) => {
      t += ms;
    },
  };
}

function world(options: { encrypted?: boolean } = {}) {
  const real = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const opens = { n: 0, fail: undefined as Error | undefined };
  const keystore = new Proxy(real, {
    get(t, p, rx) {
      if (p !== 'openDek') return Reflect.get(t, p, rx) as unknown;
      return async (wrapped: Parameters<IKeystore['openDek']>[0]) => {
        opens.n += 1;
        if (opens.fail !== undefined) throw opens.fail;
        return real.openDek(wrapped);
      };
    },
  });
  const backend = new MemoryStorage();
  const clock = manualClock();
  const writer = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(options.encrypted ? { encryption: { keystore: real } } : {}),
  });
  const calls: Record<string, number> = {};
  const tamper: { row: (row: RegistryRecord) => RegistryRecord } = { row: (row) => row };
  const fault: { gets: number } = { gets: 0 };
  const storage = counting<IStorageDriver>(backend.storage, calls);
  const registry = new Proxy(backend.registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return value;
      return async (ref: SegmentRef) => {
        if (fault.gets > 0) {
          fault.gets -= 1;
          throw new TransientError('registry unavailable');
        }
        const row = await t.get(ref);
        return row === null ? null : tamper.row(row);
      };
    },
  }) as IRegistryDriver;
  const reader = (retry = false, extra: object = {}): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      ...(retry ? {} : { retry: false }),
      seams: { clock },
      ...(options.encrypted ? { encryption: { keystore } } : {}),
      ...extra,
    });
  return {
    backend,
    writer,
    reader,
    clock,
    calls,
    opens,
    tamper,
    fault,
    real,
    registry: backend.registry,
  };
}

describe('the key an encrypted count unwraps', () => {
  it('is unwrapped once across TTL refreshes, with a count or a count and a has in each window', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    for (let i = 0; i < 5; i++) {
      expect(await seg.count()).toBe(3);
      expect(await seg.has(1)).toBe(true);
      w.clock.advance(TTL + 1);
    }
    expect(w.opens.n).toBe(1);
  });

  it('a count alone, five windows running, is one unwrap', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    for (let i = 0; i < 5; i++) {
      expect(await seg.count()).toBe(3);
      w.clock.advance(TTL + 1);
    }
    expect(w.opens.n).toBe(1);
  });

  it('a different key (the name purged and loaded again) is unwrapped afresh', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(3);
    await w.registry.delete(SEG);
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    await w.writer.load(SEG, [7, 8, 9, 10]);
    w.clock.advance(TTL + 1);
    expect(await seg.count()).toBe(4);
    expect(w.opens.n).toBe(2);
  });

  it('a keystore fault is asked about once, not again by the error path', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    w.opens.fail = new TransientError('kms throttled');
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await expect(seg.count()).rejects.toBeInstanceOf(TransientError);
    expect(w.opens.n).toBe(1);
  });
});

describe('what stat() hands back', () => {
  it('is a frozen copy: changing it changes nothing the store holds', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3], { metadata: { a: 'x' } });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    const first = await seg.stat();
    expect(Object.isFrozen(first.metadata)).toBe(true);
    expect(() => {
      (first.metadata as Record<string, string>).a = 'EVIL';
    }).toThrow();
    await seg.has(1);
    expect((await seg.stat()).metadata).toEqual({ a: 'x' });
    expect(await seg.count()).toBe(3);
    const entry = (await store.generations(SEG))[0]!;
    expect(Object.isFrozen(entry.metadata)).toBe(true);
  });

  it('an expired handle answers no generation and a count of 0', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns', expiresAt: 1_000_000_000_000 });
    expect(await seg.stat()).toMatchObject({ cardinality: 3 });
    w.clock.advance(1_000_000_000_001);
    expect(await seg.stat()).toEqual({ generation: null, cardinality: 0 });
  });

  it('a pin of a segment with no generation keeps answering none after a load', async () => {
    const w = world();
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    const store = w.reader();
    const pinned = await store.segment('s', { namespace: 'ns' }).pin();
    await w.writer.load(SEG, [1, 2]);
    expect(await pinned.stat()).toEqual({ generation: null, cardinality: 0 });
    expect(await store.segment('s', { namespace: 'ns' }).stat()).toMatchObject({ generation: 0 });
  });

  it('a source with no summary answers from its count, and from its generation when it has one', async () => {
    const { store } = seededStore({ users: [5, 100_000] });
    expect(await store.segment('users').stat()).toMatchObject({ cardinality: 2 });
  });
});

describe('distrust', () => {
  const lie = (row: RegistryRecord): RegistryRecord => ({
    ...row,
    summary: { generation: row.currentGen as number, cardinality: 99 },
  });

  it('ends with the incarnation: a purged and re-created name is trusted again', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    w.tamper.row = lie;
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await seg.has(1); // the open finds the lie
    await w.registry.delete(SEG);
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    await w.writer.load(SEG, [4, 5, 6, 7]);
    w.tamper.row = (row) => row;
    w.clock.advance(TTL + 1);
    w.calls.getTail = 0;
    expect(await seg.count()).toBe(4);
    expect(w.calls.getTail ?? 0).toBe(0);
  });

  it('ends at the next load: the summary of the generation after is used', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3], { keep: 9 });
    w.tamper.row = lie;
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await seg.has(1);
    w.tamper.row = (row) => row;
    await w.writer.load(SEG, [1, 2, 3, 4], { keep: 9 });
    w.clock.advance(TTL + 1);
    w.calls.getTail = 0;
    expect(await seg.count()).toBe(4);
    expect(w.calls.getTail ?? 0).toBe(0);
  });

  it('invalidate() forgets it for that segment', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    w.tamper.row = lie;
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    await seg.has(1);
    w.tamper.row = (row) => row;
    store.invalidate(SEG);
    w.calls.getTail = 0;
    expect(await seg.count()).toBe(3);
    expect(w.calls.getTail ?? 0).toBe(0);
  });
});

describe('the count through the default read retries', () => {
  it('rides out one transient registry fault', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader(true).segment('s', { namespace: 'ns' });
    w.fault.gets = 1;
    expect(await seg.count()).toBe(3);
    expect(w.fault.gets).toBe(0);
  });
});

describe('a refresh keeps the open reader through counts alone', () => {
  it('has, a window of counts, then a has: no tail read', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3, 70_000]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await seg.has(1);
    for (let i = 0; i < 3; i++) {
      w.clock.advance(TTL + 1);
      expect(await seg.count()).toBe(4);
    }
    w.calls.getTail = 0;
    expect(await seg.has(70_000)).toBe(true);
    expect(w.calls.getTail ?? 0).toBe(0);
  });
});

describe('checkConsistency with summaries', () => {
  it('refuses a summaries option that is not a boolean', async () => {
    const w = world();
    await expect(
      runConsistencyCheck(
        { storage: w.backend.storage, registry: w.registry },
        { summaries: 'true' as unknown as boolean },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a row with no summary costs no object read', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { summary: undefined });
    const calls: Record<string, number> = {};
    const counted = counting<IStorageDriver>(w.backend.storage, calls);
    const report = await runConsistencyCheck(
      { storage: counted, registry: w.registry },
      { summaries: true },
    );
    expect(report.inconsistent).toEqual([]);
    expect(calls.getTail ?? 0).toBe(0);
  });

  it('a sealed summary moved from another generation, or a key that does not open, is unchecked', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3], { keep: 9 });
    const first = (await w.registry.get(SEG))!.summary as { sealed: string };
    await w.writer.load(SEG, [1, 2, 3, 4], { keep: 9 });
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, {
      summary: { generation: 1, sealed: first.sealed },
    });
    const moved = await runConsistencyCheck(
      { storage: w.backend.storage, registry: w.registry, keystore: w.real },
      { summaries: true },
    );
    expect(moved.inconsistent).toEqual([]);
    expect(moved.summariesUnchecked).toBe(1);
    // A good summary, and a keystore that cannot open the segment's key.
    const again = (await w.registry.get(SEG))!;
    const aead = await w.real.openDek(again.wrappedDeks!);
    await w.registry.compareAndSwap(SEG, again.token, { summary: sealSummary(aead, SEG, 1, 4) });
    const cannotOpen = {
      openDek: async () => {
        throw new KeyUnavailableError('no such key');
      },
    } as unknown as IKeystore;
    const keyless = await runConsistencyCheck(
      { storage: w.backend.storage, registry: w.registry, keystore: cannotOpen },
      { summaries: true },
    );
    expect(keyless.inconsistent).toEqual([]);
    expect(keyless.summariesUnchecked).toBe(1);
  });
});
