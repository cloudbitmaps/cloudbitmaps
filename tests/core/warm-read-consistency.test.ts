import {
  CloudRoaring,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type {
  ChunkRef,
  IWarmDriver,
  NoRow,
  SegmentRef,
  Token,
  WarmReadOptions,
  WarmRow,
} from '@/core/ports';
import { ValidationError } from '@/core/errors';

/**
 * Phase E gap #9 — the READ paths honor `warmReadConsistency`, but the OCC read-modify-write path stays
 * strongly consistent regardless (correctness). A spy over the Warm driver records the `consistent` flag it
 * receives on each `get`/`listChunks` so we can assert exactly how the engine routes it.
 */
class SpyWarm implements IWarmDriver {
  readonly getConsistency: (boolean | undefined)[] = [];
  readonly listConsistency: (boolean | undefined)[] = [];
  constructor(private readonly inner: IWarmDriver) {}
  get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    this.getConsistency.push(opts?.consistent);
    return this.inner.get(ref, opts);
  }
  putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    return this.inner.putConditional(ref, bytes, expected);
  }
  deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    return this.inner.deleteConditional(ref, expected);
  }
  async *listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow> {
    this.listConsistency.push(opts?.consistent);
    yield* this.inner.listChunks(ref, opts);
  }
}

const store = (
  spy: SpyWarm,
  warmReadConsistency?: 'strong' | 'eventual',
  writeConcurrency?: number,
): CloudRoaring =>
  new CloudRoaring({
    warm: spy,
    cold: new MemoryColdChunkSource(),
    retry: false,
    warmReadConsistency,
    writeConcurrency,
  });

describe('Phase E gap #9 — warm read consistency routing', () => {
  it('default is strong everywhere — no read is eventual', async () => {
    const spy = new SpyWarm(new MemoryWarmDriver());
    const cr = store(spy);
    await cr.segment('s').add(1); // OCC read-modify-write
    await cr.segment('s').has(1); // point read
    await cr.segment('s').count(); // listChunks read
    // "strong" ⇒ nothing is eventually-consistent (undefined = the driver's strong default; true = explicit strong).
    expect(spy.getConsistency.every((c) => c !== false)).toBe(true);
    expect(spy.listConsistency.every((c) => c !== false)).toBe(true);
  });

  it("'eventual' lightens the read paths BUT keeps the OCC write path strong", async () => {
    const spy = new SpyWarm(new MemoryWarmDriver());
    const cr = store(spy, 'eventual');
    await cr.segment('s').add(1); // add ⇒ one OCC read-modify-write get
    await cr.segment('s').has(1); // ⇒ one read-path get
    await cr.segment('s').count(); // ⇒ one read-path listChunks
    // add()'s RMW get comes first and MUST be strong (not false) even in eventual mode; has()'s get is eventual.
    expect(spy.getConsistency[0]).not.toBe(false); // OCC read stays strong
    expect(spy.getConsistency[1]).toBe(false); // has() read is eventual
    expect(spy.listConsistency[0]).toBe(false); // count() read is eventual
  });

  it('forwards the eventual flag through the DEFAULT retry wrapper (retry left on)', async () => {
    // The only other tests use retry:false, bypassing RetryingWarmDriver — but retry is ON by default, so this
    // is the production path. A regression dropping `opts` in the decorator would silently no-op the whole #9 win.
    const spy = new SpyWarm(new MemoryWarmDriver());
    const cr = new CloudRoaring({
      warm: spy,
      cold: new MemoryColdChunkSource(),
      warmReadConsistency: 'eventual', // retry NOT disabled → engine → RetryingWarmDriver → spy
    });
    await cr.segment('s').has(1);
    await cr.segment('s').count();
    expect(spy.getConsistency).toContain(false); // survived RetryingWarmDriver.get
    expect(spy.listConsistency).toContain(false); // survived RetryingWarmDriver.listChunks
  });

  it('keeps the GDPR admin membership read STRONG even when the store is eventual', async () => {
    // A SAR / erasure must be read-your-writes — it must never miss a just-written membership because an
    // eventual read lagged. subjectReport forces `{ consistent: true }` regardless of warmReadConsistency.
    const spy = new SpyWarm(new MemoryWarmDriver());
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    const cr = new CloudRoaring({
      warm: spy,
      cold,
      registry,
      warmReadConsistency: 'eventual',
      retry: false,
    });
    spy.getConsistency.length = 0; // ignore any setup reads; measure only the admin scan
    await cr.subjectReport(1, { allNamespaces: true });
    expect(spy.getConsistency.length).toBeGreaterThan(0);
    expect(spy.getConsistency.every((c) => c === true)).toBe(true); // strong despite 'eventual'
  });
});

describe('Phase E — bounded flusher (writeConcurrency)', () => {
  it('addMany writes every distinct chunk with writeConcurrency > 1', async () => {
    const spy = new SpyWarm(new MemoryWarmDriver());
    const cr = store(spy, undefined, 4);
    const ids = [1, 70_000, 140_000, 210_000, 280_000]; // five distinct chunks (id >> 16)
    await cr.segment('s').addMany(ids);
    for (const id of ids) expect(await cr.segment('s').has(id)).toBe(true);
    expect(await cr.segment('s').count()).toBe(ids.length);
  });

  it('rejects a non-positive writeConcurrency at construction', () => {
    expect(() => store(new SpyWarm(new MemoryWarmDriver()), undefined, 0)).toThrow(ValidationError);
    expect(() => store(new SpyWarm(new MemoryWarmDriver()), undefined, -1)).toThrow(
      ValidationError,
    );
    expect(() => store(new SpyWarm(new MemoryWarmDriver()), undefined, 1.5)).toThrow(
      ValidationError,
    );
  });
});
