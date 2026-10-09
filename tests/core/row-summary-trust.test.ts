import { randomBytes } from 'node:crypto';
import { KeyUnavailableError } from '@/core/errors';
import type {
  IRegistryDriver,
  IStorageDriver,
  ClearRegistrySummary,
  RegistryRecord,
  RegistrySummary,
  SealedRegistrySummary,
  SegmentRef,
} from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage, destroySegment } from '@/index';
import { counting } from '../helpers/counting';

/**
 * What a count trusts of the row. The row's summary is believed for the generation it names, in the shape the row's
 * keys call for, and is held against the object whenever the object is opened anyway: a disagreement stops this
 * process from using that summary and fails nothing. A cold count is not confirmed against the object, which the docs
 * say wherever they say what `count()` trusts.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const TTL = 2_000;
const META = { def: 'v41' };

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

function world(
  options: { encrypted?: boolean; requireEncryption?: boolean; keyless?: boolean } = {},
) {
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const backend = new MemoryStorage();
  const clock = manualClock();
  const writer = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(options.encrypted ? { encryption: { keystore } } : {}),
  });
  const calls: Record<string, number> = {};
  const tamper: { row: (row: RegistryRecord) => RegistryRecord } = { row: (row) => row };
  const storage = counting<IStorageDriver>(backend.storage, calls);
  const registry = new Proxy(backend.registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return value;
      return async (ref: SegmentRef) => {
        const row = await t.get(ref);
        return row === null ? null : tamper.row(row);
      };
    },
  }) as IRegistryDriver;
  const reader = (): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      retry: false,
      seams: { clock },
      ...(options.encrypted && options.keyless !== true ? { encryption: { keystore } } : {}),
      ...(options.requireEncryption ? { encryption: { keystore, required: true } } : {}),
    });
  return { keystore, backend, tamper, writer, reader, clock, calls, registry: backend.registry };
}

/**
 * The row with `summary` in place of its own: a clear one names the object the row's own summary named, so only what
 * it says of that object differs.
 */
const withSummary =
  (summary: Omit<ClearRegistrySummary, 'fingerprint'> | SealedRegistrySummary | undefined) =>
  (row: RegistryRecord): RegistryRecord => ({
    ...row,
    summary:
      summary === undefined || 'sealed' in summary
        ? summary
        : ({
            ...summary,
            fingerprint: (row.summary as { fingerprint?: string } | undefined)?.fingerprint,
          } as RegistrySummary),
  });

describe('a summary that disagrees with its object', () => {
  it('is believed by a cold count, caught by the next open, and not used again: nothing fails', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3], { metadata: META });
    w.tamper.row = withSummary({ generation: 0, cardinality: 99, metadata: META });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(99); // the row's word, not confirmed on the cold path
    expect(await seg.has(1)).toBe(true); // the open holds the row's summary against the object
    expect(await seg.count()).toBe(3); // distrusted: the same snapshot now answers from the object
    expect(await seg.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: META,
      sizeBytes: expect.any(Number),
    });
    // A later resolution of the same row, after the TTL, does not trust it again.
    w.clock.advance(TTL + 1);
    expect(await seg.count()).toBe(3);
  });

  it("distrusting one segment leaves another's summary in use", async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    await w.writer.load({ ...SEG, segment: 'other' }, [1, 2, 3, 4]);
    w.tamper.row = (row) =>
      row.segment === 's' ? withSummary({ generation: 0, cardinality: 99 })(row) : row;
    const store = w.reader();
    await store.segment('s', { namespace: 'ns' }).has(1);
    w.calls.getTail = 0;
    expect(await store.segment('other', { namespace: 'ns' }).count()).toBe(4);
    expect(w.calls.getTail ?? 0).toBe(0);
  });

  // `stat()` answers from the row as a count does, so a cold one says what the row claims, and so does `generations()`,
  // which reads the row and opens nothing; once an open has found the disagreement, `stat()` says what the object says.
  it('metadata that differs is the same disagreement', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3], { metadata: META });
    w.tamper.row = withSummary({ generation: 0, cardinality: 3, metadata: { def: 'forged' } });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect((await store.generations(SEG)).at(-1)?.metadata).toEqual({ def: 'forged' });
    expect((await seg.stat()).metadata).toEqual({ def: 'forged' });
    expect(await seg.has(1)).toBe(true);
    expect((await seg.stat()).metadata).toEqual(META);
  });

  it('a row with metadata over an object with none is a disagreement', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3]);
    w.tamper.row = withSummary({ generation: 0, cardinality: 3, metadata: META });
    const store = w.reader();
    const seg = store.segment('s', { namespace: 'ns' });
    expect((await store.generations(SEG)).at(-1)?.metadata).toEqual(META);
    expect((await seg.stat()).metadata).toEqual(META);
    expect(await seg.has(1)).toBe(true);
    expect(await seg.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      sizeBytes: expect.any(Number),
    });
  });

  it('an agreeing summary stays in use after the open', async () => {
    const w = world();
    await w.writer.load(SEG, [1, 2, 3], { metadata: META });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await seg.has(1);
    w.calls.getTail = 0;
    w.clock.advance(TTL + 1);
    expect(await seg.stat()).toEqual({
      generation: 0,
      cardinality: 3,
      metadata: META,
      sizeBytes: expect.any(Number),
    });
    expect(w.calls.getTail ?? 0).toBe(0);
  });
});

describe('an encrypted segment', () => {
  it('a sealed summary that does not open (moved from another generation) is no summary', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3], { metadata: META });
    const first = (await w.registry.get(SEG))!.summary;
    await w.writer.load(SEG, [1, 2, 3, 4, 5], { metadata: META });
    // Generation 1's row carries generation 0's sealed bytes under generation 1's number.
    w.tamper.row = withSummary({ generation: 1, sealed: (first as { sealed: string }).sealed });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(5);
    expect(w.calls.getTail).toBe(1);
  });

  it('a clear summary beside wrapped keys is no summary', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    w.tamper.row = withSummary({ generation: 0, cardinality: 77 });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(3);
  });

  it('a store with no keystore refuses a count, as it refuses a read', async () => {
    const w = world({ encrypted: true, keyless: true });
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await expect(seg.count()).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(seg.has(1)).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});

describe('requireEncryption', () => {
  it('a cleartext row is refused by a count and a stat, with no read of the object', async () => {
    const w = world({ requireEncryption: true });
    await w.writer.load(SEG, [1, 2, 3]);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    await expect(seg.count()).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(seg.stat()).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(w.calls.getTail ?? 0).toBe(0);
  });
});

describe('a row that names nothing to read', () => {
  it('a destroyed row counts 0 and opens nothing', async () => {
    const w = world({ encrypted: true });
    await w.writer.load(SEG, [1, 2, 3]);
    await destroySegment(SEG, { registry: w.registry }, { confirmSegment: 's' });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(0);
    expect(await seg.stat()).toEqual({ generation: null, cardinality: 0, sizeBytes: null });
    expect(w.calls.getTail ?? 0).toBe(0);
  });

  it('a null pointer counts 0 and opens nothing', async () => {
    const w = world();
    await w.writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(0);
    expect(await seg.stat()).toEqual({ generation: null, cardinality: 0, sizeBytes: null });
    expect(w.calls.getTail ?? 0).toBe(0);
  });
});
