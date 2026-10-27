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

/** The bucket's object keys and the row's pointer, to prove nothing moved. */
async function snapshot(p: Awaited<ReturnType<typeof build>>) {
  const keys: number[] = [];
  for await (const key of p.storage.list(SEG)) keys.push(key.generation);
  return { keys: keys.sort(), row: await p.registry.get(SEG) };
}

const erase = (p: Awaited<ReturnType<typeof build>>) =>
  eraseIdFromSegment(SEG, ID, { ...p, codec: storeCodec, entropy: zeroEntropy });

describe('the erasure scan reads a stored chunk through the shared range check', () => {
  it('refuses a stored chunk with a container key above 0 instead of reporting the id not held', async () => {
    // 65_537 sits in container 1 and has remainder 1: a lookup of remainder 1 does not see it.
    const p = await build([2, 65_537]);
    const err = await erase(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    // The refusal names neither the stored value nor a chunk key (which here is part of the erased id).
    expect((err as Error).message).not.toMatch(/65537|chunk \d/);
  });

  it('writes and deletes nothing after the refusal', async () => {
    const p = await build([2, 65_537]);
    const calls: string[] = [];
    const watch = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const v = Reflect.get(t, prop, receiver) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            calls.push(`${name}.${String(prop)}`);
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const before = await snapshot(p);
    await expect(
      eraseIdFromSegment(SEG, ID, {
        storage: watch('storage', p.storage),
        registry: watch('registry', p.registry),
        codec: storeCodec,
        entropy: zeroEntropy,
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(calls.filter((c) => /put|delete|create|update|cas|write|set/i.test(c))).toEqual([]);
    expect(await snapshot(p)).toEqual(before);
  });

  it('leaves a well-formed chunk unaffected: a holder is erased, a non-holder is reported not held', async () => {
    const holder = await build([1, 2]);
    expect((await erase(holder)).erased).toBe(true);

    const clean = await build([2, 3]);
    expect((await erase(clean)).erased).toBe(false);
  });
});
