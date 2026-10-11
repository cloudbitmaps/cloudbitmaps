import { MemoryStorage, CloudRoaring } from '@/index';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { brandAsBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { SegmentEngine } from '@/core/engine';
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type { StorageChunkSource } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';

/**
 * A segment that resolves to nothing is ambiguous in a way that matters only as an **operand**.
 *
 * Read it directly and "empty" is right either way. Pass it to a combine and the two states diverge: a
 * suppression list with nobody on it correctly suppresses nothing, while one whose namespace you omitted
 * silently suppresses nothing — and the result is not obviously-empty, it is the full audience and plausibly
 * right. The failure mode is mailing the people who opted out.
 */
const AUDIENCE: SegmentRef = { namespace: 'audiences', segment: 'active-30d' };
const OPTOUT: SegmentRef = { namespace: 'suppression', segment: 'global-opt-out' };

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function world() {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { ...AUDIENCE, generation: 0 }, [1, 2, 3, 4], { registry });
  await bulkLoadCrbmGeneration(storage, { ...OPTOUT, generation: 0 }, [2, 3], { registry });
  const store = new CloudRoaring({ storage: backend });
  return {
    storage,
    registry,
    store,
    audience: store.segment('active-30d', { namespace: 'audiences' }),
  };
}

describe('a combine refuses an operand that names a segment which does not exist', () => {
  it('the mis-namespaced suppression list — the case that mails the opted-out', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out'); // namespace omitted: a DIFFERENT segment
    await expect(collect(w.audience.andNot([wrong]))).rejects.toThrow(ValidationError);
    await expect(collect(w.audience.andNot([wrong]))).rejects.toThrow(/does not exist/);
  });

  it('names the segment and the namespace in the message', async () => {
    const w = await world();
    await expect(
      collect(w.audience.andNot([w.store.segment('opt-out-typo', { namespace: 'suppression' })])),
    ).rejects.toThrow(/"suppression\/opt-out-typo"/);
  });

  it('the correctly addressed list still suppresses', async () => {
    const w = await world();
    const right = w.store.segment('global-opt-out', { namespace: 'suppression' });
    expect(await collect(w.audience.andNot([right]))).toEqual([1, 4]);
  });

  it('applies to `exclude` on the intersect family too', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out');
    await expect(collect(w.audience.intersect([w.audience], { exclude: [wrong] }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('applies to includes as well — both directions are wiring errors', async () => {
    const w = await world();
    await expect(collect(w.audience.intersect([w.store.segment('nope')]))).rejects.toThrow(
      ValidationError,
    );
    await expect(collect(w.audience.union([w.store.segment('nope')]))).rejects.toThrow(
      ValidationError,
    );
  });

  it('a segment that EXISTS but is empty is fine — that is the legitimate case', async () => {
    // A row minted by `setRetention` before the first load: created deliberately, holds nothing yet.
    const w = await world();
    const empty: SegmentRef = { namespace: 'suppression', segment: 'not-loaded-yet' };
    await setSegmentRetention(
      empty,
      { registry: w.registry },
      { expiresAt: Date.now() + 86_400_000 },
    );

    const handle = w.store.segment('not-loaded-yet', { namespace: 'suppression' });
    expect(await collect(w.audience.andNot([handle]))).toEqual([1, 2, 3, 4]); // suppresses nothing, correctly
  });

  it('`allowAbsentOperands: true` is the escape hatch', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out');
    expect(await collect(w.audience.andNot([wrong], { allowAbsentOperands: true }))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('reading an absent segment directly is not refused — it answers empty', async () => {
    const w = await world();
    const missing = w.store.segment('never-created', { namespace: 'audiences' });
    expect(await missing.count()).toBe(0);
    expect(await missing.has(1)).toBe(false);
    expect(await collect(missing.iterate())).toEqual([]);
  });

  it('costs nothing when every operand has data', async () => {
    const real = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...AUDIENCE, generation: 0 }, [1, 2, 3, 4], { registry });
    await bulkLoadCrbmGeneration(real, { ...OPTOUT, generation: 0 }, [2, 3], { registry });

    let registryGets = 0;
    const counting = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
        return async (ref: SegmentRef) => {
          registryGets += 1;
          return registry.get(ref);
        };
      },
    }) as unknown as MemoryRegistryDriver;

    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: real, registry: counting }),
      cache: { genTtlMs: 0 },
    });
    const audience = store.segment('active-30d', { namespace: 'audiences' });
    const optout = store.segment('global-opt-out', { namespace: 'suppression' });
    await collect(audience.andNot([optout]));
    const baseline = registryGets;

    registryGets = 0;
    await collect(audience.andNot([optout]));
    expect(registryGets).toBe(0); // no timed refresh, both operands non-empty: no existence check at all
    expect(baseline).toBeGreaterThan(0);
  });
});

describe('a combine checks its own segment as it checks its operands', () => {
  // A base that names no segment is refused, rather than read as empty.
  function never(w: Awaited<ReturnType<typeof world>>) {
    return w.store.segment('never-loaded', { namespace: 'audiences' });
  }

  it('refuses a base that does not exist, on union and andNot', async () => {
    const w = await world();
    const base = never(w);
    for (const read of [() => base.andNot([w.audience]), () => base.union([w.audience])]) {
      await expect(collect(read())).rejects.toThrow(ValidationError);
      await expect(collect(read())).rejects.toThrow(/"audiences\/never-loaded" names a segment/);
    }
  });

  it('reads it as empty under `allowAbsentOperands: true`', async () => {
    const w = await world();
    expect(await collect(never(w).andNot([w.audience], { allowAbsentOperands: true }))).toEqual([]);
    // A union reads the absent base as empty, and so holds what its operand holds.
    expect(await collect(never(w).union([w.audience], { allowAbsentOperands: true }))).toEqual(
      await collect(w.audience.iterate()),
    );
  });
});

describe('an operand that was dropped or retired is refused like one that never existed', () => {
  it('an exclude whose segment was dropped does not quietly suppress nobody', async () => {
    const w = await world();
    const optout = w.store.segment('global-opt-out', { namespace: 'suppression' });
    // Control: while it exists, it suppresses.
    expect(await collect(w.audience.andNot([optout]))).toEqual([1, 4]);
    await w.store.dropSegment(OPTOUT, { confirmSegment: OPTOUT.segment });
    expect(await w.store.exists(OPTOUT)).toBe(false);
    await expect(collect(w.audience.andNot([optout]))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      collect(w.audience.intersect([w.audience], { exclude: [optout] })),
    ).rejects.toThrow(/does not exist or was dropped/);
    // And a caller that means it says so.
    expect(await collect(w.audience.andNot([optout], { allowAbsentOperands: true }))).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

/**
 * A source whose every segment is empty and absent, counting the `exists` reads in flight: a combine of many such
 * operands asks after each of them, and must not ask after all of them at once (invariant 6).
 */
class AbsentEverywhere implements StorageChunkSource {
  inFlight = 0;
  peak = 0;
  readonly asked: string[] = [];
  async getChunk(): Promise<Uint8Array | null> {
    return null;
  }
  async listChunkKeys(): Promise<number[]> {
    return [];
  }
  async exists(ref: SegmentRef): Promise<boolean> {
    this.asked.push(ref.segment);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    // One turn of the microtask queue: every read the caller starts at once is in flight before any settles.
    await null;
    this.inFlight -= 1;
    return false;
  }
}

describe('the existence check is a bounded fan-out', () => {
  const WIDE = 40;
  const refs = Array.from({ length: WIDE }, (_, i): SegmentRef => ({ segment: `gone-${i}` }));

  it('a combine asks after at most 16 operands at once, and names every one that is absent', async () => {
    const source = new AbsentEverywhere();
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    const error = await collect(engine.intersect(refs)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(source.asked).toHaveLength(WIDE);
    expect(source.peak).toBe(16);
    const message = (error as Error).message;
    expect(message.startsWith('intersect: operand "gone-0", "gone-1",')).toBe(true);
    expect(message).toContain(`"gone-${WIDE - 1}" names a segment`);
  });

  it('an exclude list is asked after the same way, includes first', async () => {
    const source = new AbsentEverywhere();
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    await expect(collect(engine.andNot(refs[0]!, refs.slice(1)))).rejects.toThrow(
      /^andNot: operand "gone-0", "gone-1",/,
    );
    expect(source.peak).toBe(16);
    expect(source.asked).toEqual(refs.map((r) => r.segment));
  });

  it('a batch combine asks after its operands with the same bound and the same words', async () => {
    const source = new AbsentEverywhere();
    const operands = refs.map((ref) => ({ name: ref.segment, ref }));
    const compiled = compileCombineMany({
      operands,
      outputs: [
        {
          expr: { or: refs.map((r) => r.segment) },
          publish: async () => undefined,
        },
      ],
      keep: 1,
      maxBufferedBytes: 1 << 26,
      publishConcurrency: 1,
      concurrency: 1,
    });
    const error = await runCombineMany(compiled, {
      source,
      codec: roaringCodec,
      clock: { now: () => 0, sleep: async () => {} },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(source.peak).toBe(16);
    expect((error as Error).message).toMatch(
      /^materializeMany: operand "gone-0", .*"gone-39" names a segment that does not exist or was dropped/,
    );
  });
});
