import { publishGeneration } from '../helpers/publish';
import { writeCrbmGeneration } from '../helpers/crbm-write';
import { eraseIdFromSegment } from '@/core/erase-id';
import { joinId } from '@/core/bit-route';
import { IntegrityError } from '@/index';
import { storeCodec } from '../helpers/store-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { zeroEntropy } from '../helpers/entropy';

// When the id is not in the current generation, the erasure searches the other generations for a holder. A stored
// chunk it reads there is untrusted bytes like any other: a chunk carrying a value past the 16-bit remainder range
// (a container key above 0) is refused, never answered "not held" because the lookup does not see that container.

const SEG = { segment: 's' };
const ID = joinId(0, 1);

/** Generation 0 is current and lacks the id; generation 1, above the pointer, has chunk 0 holding `other`. */
async function build(other: number[]) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  await writeCrbmGeneration(storage, { ...SEG, generation: 0 }, [
    { chunkKey: 0, bitmap: storeCodec.fromValues([2]) },
  ]);
  await publishGeneration(registry, { ...SEG, generation: 0 });
  await writeCrbmGeneration(storage, { ...SEG, generation: 1 }, [
    { chunkKey: 0, bitmap: storeCodec.fromValues(other) },
  ]);
  return { storage, registry };
}

const erase = (p: Awaited<ReturnType<typeof build>>) =>
  eraseIdFromSegment(SEG, ID, { ...p, codec: storeCodec, entropy: zeroEntropy });

describe('the erasure scan reads a stored chunk through the shared range check', () => {
  it('refuses a stored chunk with a container key above 0 instead of reporting the id not held', async () => {
    // 65_537 sits in container 1 and has remainder 1: a lookup of remainder 1 does not see it.
    const p = await build([2, 65_537]);
    await expect(erase(p)).rejects.toBeInstanceOf(IntegrityError);
    await expect(erase(p)).rejects.toThrow(/65537/);
  });

  it('leaves a well-formed chunk unaffected: a holder is erased, a non-holder is reported not held', async () => {
    const holder = await build([1, 2]);
    expect((await erase(holder)).erased).toBe(true);

    const clean = await build([2, 3]);
    expect((await erase(clean)).erased).toBe(false);
  });
});
