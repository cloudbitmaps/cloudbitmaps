import { describe, expect, it } from 'vitest';
import { IntegrityError, NotFoundError, TransientError, ValidationError } from '@/index';
import { SegmentEngine } from '@/core/engine';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import { RetryingStorageChunkSource } from '@/drivers/retry/retrying-chunk-source';
import { segmentKey } from '@/core/keys';
import type { IStorageDriver } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { storeCodec } from '../helpers/store-codec';
import { chunk, countOf, ref, rig } from '../helpers/combine-count-rig';
import type { Op } from '../helpers/combine-count-rig';

/**
 * The look at a pinned operand's object, before the first key and at each look after it, fails closed: an object that
 * is gone or replaced raises the pin's NotFoundError, any other fault the look meets is raised as it is, and only a
 * transient fault is retried. Each case warms the pin's reader first, so only the look can notice what follows.
 */

/** Six keys of `a` and six of `b`, fewer than the default look cadence: no look runs but the one before the first key. */
const A0 = Array.from({ length: 6 }, (_, i) => chunk(2 * i, 3 + i)).flat();
const B0 = Array.from({ length: 6 }, (_, i) => chunk(2 * i + 1, 2 + i)).flat();
const ALL = A0.length + B0.length;

type TailFault = (real: () => Promise<{ bytes: Uint8Array; size: number }>) => Promise<{
  bytes: Uint8Array;
  size: number;
}>;

async function world(opts: { retry?: boolean } = {}) {
  const r = rig();
  await r.load('a', A0);
  await r.load('b', B0);
  let fault: TailFault | undefined;
  let tails = 0;
  const storage = new Proxy(r.backend.storage, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (prop !== 'getTail') return typeof value === 'function' ? value.bind(t) : value;
      return (key: { segment: string }, maxBytes: number) => {
        const real = () => (value as IStorageDriver['getTail']).call(t, key as never, maxBytes);
        if (key.segment !== 'a' || fault === undefined) return real();
        tails += 1;
        return fault(real);
      };
    },
  }) as IStorageDriver;
  const crbm = new CrbmStorageChunkSource(storage, { registry: r.registry, clock: r.clock });
  const at = (await crbm.pinGeneration(ref('a')))!;
  const pins = new Map([
    [
      segmentKey(ref('a')),
      { generation: at.generation, version: at.version, fingerprint: at.fingerprint },
    ],
  ]);
  const pinned = new PinnedStorageChunkSource(crbm, pins);
  const source = opts.retry
    ? new RetryingStorageChunkSource(pinned, {
        clock: { ...r.clock, sleep: () => Promise.resolve() },
        rng: { next: () => 0 },
      })
    : pinned;
  const engine = new SegmentEngine({ storage: source, codec: storeCodec, clock: r.clock });
  const count = (op: Op = 'union') => countOf(engine, op, [ref('a'), ref('b')]);
  return {
    r,
    engine,
    count,
    tails: () => tails,
    arm: (f: TailFault) => {
      fault = f;
    },
  };
}

describe('the look at a pinned operand fails closed', () => {
  it('control: a warm pinned count with no fault answers from the index', async () => {
    const w = await world();
    expect(await w.count()).toBe(ALL);
    w.arm((real) => real());
    expect(await w.count()).toBe(ALL);
    expect(w.tails()).toBe(1);
  });

  it.each<[string, TailFault, unknown]>([
    [
      'access denied (a plain driver fault)',
      () => Promise.reject(new Error('AccessDenied')),
      Error,
    ],
    [
      'a missing bucket or a range past the end',
      () => Promise.reject(new ValidationError('range not satisfiable')),
      ValidationError,
    ],
    [
      'a foreign footer under the key',
      async (real) => {
        const { size } = await real();
        return { bytes: new Uint8Array(Math.min(size, 4096)).fill(7), size };
      },
      IntegrityError,
    ],
    [
      'a smaller object under the key',
      () => Promise.resolve({ bytes: new Uint8Array(5), size: 5 }),
      NotFoundError,
    ],
  ])('%s is raised, never swallowed', async (_name, fault, kind) => {
    const w = await world();
    expect(await w.count()).toBe(ALL);
    w.arm(fault);
    const err = await w.count().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(kind as new () => Error);
    if (kind === Error) expect((err as Error).message).toBe('AccessDenied');
  });

  it('the footer reads of the look are not charged to the budget, as the streams charge no tail read', async () => {
    const w = await world();
    w.arm((real) => real());
    // Every key is a lone key, so none is decoded: the budget has nothing to charge but the footer reads, and they are many
    expect(
      await countOf(w.engine, 'union', [ref('a'), ref('b')], {
        concurrency: 1,
        budget: { maxRequests: 1 },
      }),
    ).toBe(ALL);
    expect(w.tails()).toBeGreaterThan(6);
  });

  it('an object deleted after the pin raises the pin NotFoundError', async () => {
    const w = await world();
    expect(await w.count()).toBe(ALL);
    await w.r.backend.storage.delete({ ...ref('a'), generation: 0 });
    await expect(w.count()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an object replaced under the same number raises the pin NotFoundError', async () => {
    const w = await world();
    expect(await w.count()).toBe(ALL);
    await w.r.backend.storage.delete({ ...ref('a'), generation: 0 });
    // The same layout with every id one higher: the same size, another footer checksum.
    await bulkLoadCrbmGeneration(
      w.r.backend.storage,
      { ...ref('a'), generation: 0 },
      A0.map((id) => id + 1),
    );
    await expect(w.count()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a transient fault is retried, then the count goes on', async () => {
    const w = await world({ retry: true });
    expect(await w.count()).toBe(ALL);
    let failed = 0;
    w.arm((real) => {
      if (failed++ === 0) return Promise.reject(new TransientError('throttled'));
      return real();
    });
    expect(await w.count()).toBe(ALL);
    expect(w.tails()).toBe(2);
  });

  it.each<Op>(['union', 'andNot'])(
    'a %s of fewer keys than the look cadence, started after an erasure, raises NotFoundError',
    async (op) => {
      const w = await world();
      expect(await w.count(op)).toBeGreaterThan(0);
      await w.r.backend.storage.delete({ ...ref('a'), generation: 0 });
      await expect(w.count(op)).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});
