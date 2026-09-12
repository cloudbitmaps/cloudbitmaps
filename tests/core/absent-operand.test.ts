import {
  CloudRoaring,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/index';

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
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  await bulkLoadCrbmGeneration(cold, { ...AUDIENCE, generation: 0 }, [1, 2, 3, 4], { registry });
  await bulkLoadCrbmGeneration(cold, { ...OPTOUT, generation: 0 }, [2, 3], { registry });
  const store = new CloudRoaring({ cold, registry });
  return {
    cold,
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

  it('reading an absent segment directly is unchanged — it answers empty', async () => {
    const w = await world();
    const missing = w.store.segment('never-created', { namespace: 'audiences' });
    expect(await missing.count()).toBe(0);
    expect(await missing.has(1)).toBe(false);
    expect(await collect(missing.iterate())).toEqual([]);
  });

  it('costs nothing when every operand has data', async () => {
    const real = new MemoryColdDriver();
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

    const store = new CloudRoaring({ cold: real, registry: counting, coldGenTtlMs: 0 });
    const audience = store.segment('active-30d', { namespace: 'audiences' });
    const optout = store.segment('global-opt-out', { namespace: 'suppression' });
    await collect(audience.andNot([optout]));
    const baseline = registryGets;

    registryGets = 0;
    await collect(audience.andNot([optout]));
    expect(registryGets).toBe(0); // pinned store, both operands non-empty: no existence check at all
    expect(baseline).toBeGreaterThan(0);
  });
});
