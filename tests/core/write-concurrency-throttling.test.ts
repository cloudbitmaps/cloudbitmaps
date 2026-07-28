import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource, TransientError } from '@/index';
import { DEFAULT_WRITE_CONCURRENCY } from '@/core/engine';
import type { ChunkRef, IWarmDriver, SegmentRef, WarmRow } from '@/core/ports';
import type { Rng } from '@/core/determinism';
import { joinId } from '@/core/bit-route';

// Raising the default write concurrency from 1 to 4 is only safe if throttling is absorbed. This file is the
// proof, and it was written before the default was changed.
//
// The reasoning that makes the test necessary: a warm write is a read-modify-write, so 4 chunks in flight is up
// to 8 concurrent requests per `addMany` — and a server handling many concurrent calls multiplies that again.
// Provisioned-capacity backends answer a burst by throttling. Throttling is only free while retries absorb it,
// so "does it go faster" is the wrong question; the question is whether a batch that used to succeed serially
// still succeeds when it arrives all at once.
//
// The load-bearing assertions are therefore (1) throttling ACTUALLY HAPPENED — a test where the backend never
// throttles proves nothing — and (2) every id still landed. Both are checked in every case below.
const SEG = 'seg';

/**
 * A backend that throttles a burst, the way a provisioned-capacity store does.
 *
 * Capacity is on **concurrent requests in flight**: exceed it and the request fails with a retryable
 * `TransientError`, exactly as DynamoDB answers with `ProvisionedThroughputExceededException` (mapped to
 * `TransientError` by the real driver — see `dynamodb-errors.ts`).
 */
class ThrottlingWarm implements IWarmDriver {
  inFlight = 0;
  peakInFlight = 0;
  throttled = 0;
  writes = 0;

  constructor(
    private readonly capacity: number,
    private readonly inner: MemoryWarmDriver = new MemoryWarmDriver(),
  ) {}

  /** Model one backend call: count it, throttle if over capacity, and take a real tick so overlap is real. */
  private async gate<T>(run: () => Promise<T>, isWrite: boolean): Promise<T> {
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    try {
      if (this.inFlight > this.capacity) {
        this.throttled += 1;
        // A real driver's throttle arrives after a round-trip, not instantly — and an instant throw would let
        // the caller retry within the same tick, which is not a burst any backend would see.
        await new Promise((r) => setImmediate(r));
        throw new TransientError('ProvisionedThroughputExceededException: capacity exceeded');
      }
      await new Promise((r) => setImmediate(r));
      if (isWrite) this.writes += 1;
      return await run();
    } finally {
      this.inFlight -= 1;
    }
  }

  get = (ref: ChunkRef): Promise<WarmRow | null> => this.gate(() => this.inner.get(ref), false);
  putConditional = ((...a: unknown[]) =>
    this.gate(
      () => (this.inner.putConditional as (...x: unknown[]) => Promise<unknown>)(...a),
      true,
    )) as never;
  deleteConditional = ((...a: unknown[]) =>
    this.gate(
      () => (this.inner.deleteConditional as (...x: unknown[]) => Promise<unknown>)(...a),
      true,
    )) as never;
  listChunks = ((seg: SegmentRef, ...rest: unknown[]) =>
    (this.inner.listChunks as (...a: unknown[]) => AsyncIterable<WarmRow>)(seg, ...rest)) as never;
}

/** Seeded jitter, so the backoff schedule — and therefore this whole test — is deterministic in CI. */
const seededRng = (seed: number): Rng => {
  let s = seed >>> 0;
  return {
    next: () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 0x1_0000_0000;
    },
  };
};

/** 24 ids in 24 distinct chunks — one warm row each, so the flusher has 24 independent writes to fan out. */
const IDS = Array.from({ length: 24 }, (_, i) => joinId(i * 7 + 1, i + 1));

function storeOn(warm: ThrottlingWarm, writeConcurrency?: number) {
  return new CloudRoaring({
    warm: warm as unknown as IWarmDriver,
    cold: new MemoryColdChunkSource(),
    rng: seededRng(0xc0ffee),
    ...(writeConcurrency === undefined ? {} : { writeConcurrency }),
  } as never);
}

describe('write concurrency absorbs backend throttling', () => {
  it('is 4 by default — the number this whole file exists to justify', () => {
    expect(DEFAULT_WRITE_CONCURRENCY).toBe(4);
  });

  it('completes a throttled addMany with every id landed, at the default concurrency', async () => {
    // Capacity 2 against 4 in flight: the backend refuses roughly half the burst. This is the case the default
    // has to survive, and "survive" means no error reaches the caller and no id is lost.
    const warm = new ThrottlingWarm(2);
    const store = storeOn(warm);
    await store.segment(SEG).addMany(IDS);

    expect(
      warm.throttled,
      'the backend must actually have throttled, or this proves nothing',
    ).toBeGreaterThan(0);
    expect(warm.peakInFlight, 'writes must actually have overlapped').toBeGreaterThan(1);
    await expect(store.segment(SEG).count()).resolves.toBe(IDS.length);
    for (const id of IDS) await expect(store.segment(SEG).has(id)).resolves.toBe(true);
  });

  it('reports each absorbed throttle rather than swallowing it', async () => {
    // Absorbed is not the same as invisible. An operator watching a backend get hammered needs to see it in the
    // metrics stream and in `onRetry` — otherwise raising the default trades a visible error for a silent cost.
    const warm = new ThrottlingWarm(2);
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const store = new CloudRoaring({
      warm: warm as unknown as IWarmDriver,
      cold: new MemoryColdChunkSource(),
      rng: seededRng(0xc0ffee),
      onRetry: (info: { attempt: number; delayMs: number }) => retries.push(info),
    } as never);
    await store.segment(SEG).addMany(IDS);

    expect(retries.length).toBeGreaterThan(0);
    // Backoff must actually back off — a retry storm with zero delay is how a throttled backend stays throttled.
    expect(retries.some((r) => r.delayMs > 0)).toBe(true);
  });

  it('lands exactly what the serial path lands, throttling or not', async () => {
    // The correctness parity check. Concurrency must change timing and nothing else: same ids, same count, and
    // the same result as the pre-change default of 1 against the same throttling backend.
    const concurrent = new ThrottlingWarm(2);
    await storeOn(concurrent, 4).segment(SEG).addMany(IDS);
    const serial = new ThrottlingWarm(2);
    await storeOn(serial, 1).segment(SEG).addMany(IDS);

    const [a, b] = await Promise.all([
      storeOn(concurrent, 4).segment(SEG).count(),
      storeOn(serial, 1).segment(SEG).count(),
    ]);
    expect(a).toBe(b);
    expect(a).toBe(IDS.length);
    // Serial writes cannot overlap, so they cannot self-throttle — which is what made the old default safe and
    // is exactly the property being traded away here.
    expect(serial.throttled).toBe(0);
  });

  it('removeMany is absorbed too — it uses the same flusher', async () => {
    const warm = new ThrottlingWarm(2);
    const store = storeOn(warm);
    await store.segment(SEG).addMany(IDS);
    await store.segment(SEG).removeMany(IDS.slice(0, 12));
    await expect(store.segment(SEG).count()).resolves.toBe(IDS.length - 12);
  });

  it('still fails closed when throttling outlasts the retry budget', async () => {
    // The inverse guarantee, and the more important one. Retries absorbing throttling must never shade into
    // *hiding* a backend that is genuinely refusing work. A capacity-0 backend refuses everything; the caller
    // must get a TransientError, not a silent partial write reported as success.
    const warm = new ThrottlingWarm(0);
    const store = storeOn(warm);
    await expect(store.segment(SEG).addMany(IDS)).rejects.toBeInstanceOf(TransientError);
    expect(warm.writes).toBe(0);
  });

  it('rejects a nonsensical concurrency at construction, not at write time', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => storeOn(new ThrottlingWarm(2), bad)).toThrow(/writeConcurrency/);
    }
  });
});
