import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, TransientError, ValidationError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { recordedWaits } from '../helpers/unanswered-registry';

const REF: SegmentRef = { segment: 's' };
const X = 9;

async function setup() {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  await registry.create(REF, { currentGen: null });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, X], {
    registry,
    publish: false,
  });
  return { storage, registry };
}
async function gens(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out;
}
const isRenewal = (p: object) => 'currentGen' in p;

describe("an erasure's renewal of the row, and its deletes", () => {
  it('a renewal refused for a reason that is neither a lost race nor no answer is thrown as it is, and deletes nothing', async () => {
    const { storage, registry } = await setup();
    const reg = Object.create(registry) as IRegistryDriver;
    reg.compareAndSwap = async (ref, expected, patch, opts) => {
      if (isRenewal(patch)) throw new ValidationError('the registry refused the write');
      return registry.compareAndSwap(ref, expected, patch, opts);
    };
    await expect(
      eraseIdFromSegment(REF, X, { storage, registry: reg, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await gens(storage)).toEqual([0]);
  });

  it('a renewal with no answer, and a row that reads back as corrupt: the IntegrityError is thrown, not the TransientError', async () => {
    const { storage, registry } = await setup();
    const reg = Object.create(registry) as IRegistryDriver;
    let silent = false;
    reg.compareAndSwap = async (_ref, _expected, patch) => {
      if (!isRenewal(patch)) throw new Error('unexpected write');
      silent = true;
      throw new TransientError('timed out');
    };
    reg.get = async (ref) => {
      if (silent) throw new IntegrityError('the row does not parse');
      return registry.get(ref);
    };
    await expect(
      eraseIdFromSegment(REF, X, {
        storage,
        registry: reg,
        codec: roaringCodec,
        ...recordedWaits(),
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(await gens(storage)).toEqual([0]);
  });

  it('a renewal beaten by a writer that changed a field the pointer resolves through: superseded, and nothing is deleted', async () => {
    for (const winner of [{ keyId: 'other' }, { currentGen: null, keyId: 'other' }] as const) {
      const { storage, registry } = await setup();
      const reg = Object.create(registry) as IRegistryDriver;
      let raced = false;
      reg.compareAndSwap = async (ref, expected, patch, opts) => {
        if (!raced && isRenewal(patch)) {
          raced = true;
          await registry.compareAndSwap(ref, expected, winner);
        }
        return registry.compareAndSwap(ref, expected, patch, opts);
      };
      const out = await eraseIdFromSegment(REF, X, { storage, registry: reg, codec: roaringCodec });
      expect(out).toMatchObject({ erased: false, reason: 'superseded' });
      expect(await gens(storage)).toEqual([0]);
    }
  });

  it('a fence above the pointer that keeps losing to lease writes gives up as superseded, and deletes nothing', async () => {
    const storage = new MemoryStorageDriver();
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, [1, X], {
      registry,
      publish: false,
    });
    const reg = Object.create(registry) as IRegistryDriver;
    let n = 0;
    reg.compareAndSwap = async (ref, expected, patch, opts) => {
      if (isRenewal(patch)) {
        const row = (await registry.get(ref))!;
        await registry.compareAndSwap(ref, row.token, {
          leases: [{ holder: '00000000000000aa', generation: 0, until: 1e15 + n++ }],
        });
      }
      return registry.compareAndSwap(ref, expected, patch, opts);
    };
    const out = await eraseIdFromSegment(REF, X, {
      storage,
      registry: reg,
      codec: roaringCodec,
      ...recordedWaits(),
    });
    expect(n).toBeGreaterThan(10);
    expect(out).toMatchObject({ erased: false, reason: 'superseded' });
    expect((await gens(storage)).sort()).toEqual([0, 1]);
  });

  it('a delete of a holder that fails for a reason other than a refused condition is thrown, not reported as a move', async () => {
    const { storage, registry } = await setup();
    const st = Object.create(storage) as IStorageDriver;
    st.delete = async () => {
      throw new TransientError('the delete timed out');
    };
    await expect(
      eraseIdFromSegment(REF, X, { storage: st, registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(await gens(storage)).toEqual([0]);
  });
});
