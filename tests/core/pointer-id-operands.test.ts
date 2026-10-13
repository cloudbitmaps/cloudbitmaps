/**
 * `materializeMany` re-checks each subtracted pinned operand against its row just before it publishes, and refuses the
 * outputs that subtract one that moved. What it compares is the row's `pointerId`, so a lease or a policy write on the
 * operand while the call runs is not a move, even on a registry whose tokens carry no incarnation id and so can only be
 * compared whole; a write that changes what the row resolves to still is.
 */
import type { SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { CloudRoaring, MemoryStorage, StaleOperandError } from '@/index';
import type { MaterializeResult } from '@/index';
import { opaqueTokens } from '../helpers/opaque-tokens';

const OPT: SegmentRef = { segment: 'opt' };

async function world(meanwhile: (backend: MemoryStorage) => Promise<void>) {
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false });
  await writer.load({ segment: 'a' }, [1, 2, 3, 65_536]);
  await writer.load(OPT, [2, 65_536]);
  // The operand's row is read when it is pinned, and again by the re-check before the publishes: the write lands in
  // between.
  const registry = opaqueTokens(backend.registry);
  let reads = 0;
  const watched: typeof registry = {
    ...registry,
    get: async (ref) => {
      if (ref.segment === OPT.segment && ++reads === 2) await meanwhile(backend);
      return registry.get(ref);
    },
  };
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: backend.storage, registry: watched }),
    retry: false,
  });
  const run = await store.materializeMany({
    operands: { a: store.segment('a'), opt: store.segment('opt') },
    outputs: [{ dest: store.segment('d'), expr: 'a', exclude: ['opt'] }],
    keep: 1,
  });
  expect(reads, 'the write landed between the pin and the re-check').toBeGreaterThanOrEqual(2);
  return run;
}
describe('a subtracted operand written while the call runs (invariant 2)', () => {
  it('a policy write is not a move: the output publishes', async () => {
    const run = await world(async (backend) => {
      const row = (await backend.registry.get(OPT))!;
      await backend.registry.compareAndSwap(OPT, row.token, { retention: { note: 'hold' } });
    });
    expect((run.outputs[0] as MaterializeResult).published).toBe(true);
    expect(run.stats.operands.opt).toMatchObject({ moved: false });
  });

  it('a lease written and released is not a move: the output publishes', async () => {
    const run = await world(async (backend) => {
      const row = (await backend.registry.get(OPT))!;
      const leased = await backend.registry.compareAndSwap(OPT, row.token, {
        leases: [{ holder: '00112233aabbccdd', generation: 0, until: Date.now() + 60_000 }],
      });
      await backend.registry.compareAndSwap(OPT, leased.token, { leases: undefined });
    });
    expect((run.outputs[0] as MaterializeResult).published).toBe(true);
    expect(run.stats.operands.opt).toMatchObject({ moved: false });
  });

  it('a write that renews what the row resolves to is a move: the output is refused', async () => {
    const run = await world(async (backend) => {
      const row = (await backend.registry.get(OPT))!;
      await backend.registry.compareAndSwap(OPT, row.token, { currentGen: row.currentGen });
    });
    expect((run.outputs[0] as { error: Error }).error).toBeInstanceOf(StaleOperandError);
    expect(run.stats.operands.opt).toMatchObject({ moved: true });
  });
});
