import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { roaringCodec } from '@/roaring-codec';

/**
 * The write paths' summary, on the local-filesystem backend: the row on disk carries the summary of the current
 * generation, a guarded load sizes it from the row and reads no object for it, a load over an object removed from
 * outside still keeps the generation below it, and a rollback and an erasure write the summary of what they make
 * current. The same decisions the in-memory tests hold, over real files and a registry that survives a reopen.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const META: GenerationMetadata = { def: 'v3', owner: 'growth' };
const idsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-summary-localfs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function world(keystore?: InProcessKeystore) {
  const tails: number[] = [];
  const disk = new LocalFsStorageDriver(root);
  /** The storage the loads see, which records how many bytes each tail read asks for. */
  const storage = new Proxy(disk as IStorageDriver, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      if (p !== 'getTail') return value.bind(t);
      return (key: Parameters<IStorageDriver['getTail']>[0], max: number) => {
        tails.push(max);
        return (value as IStorageDriver['getTail']).call(t, key, max);
      };
    },
  });
  const registry = new LocalFsRegistryDriver(root, { now: () => 1_000 });
  return {
    disk,
    storage,
    registry,
    tails,
    deps: { storage, registry, codec: roaringCodec, keystore },
  };
}
type World = ReturnType<typeof world>;

/** What a registry opened over the same directory afterwards says the segment's summary is. */
async function describedOnDisk(keystore?: InProcessKeystore) {
  const reopened = new LocalFsRegistryDriver(root, { now: () => 1_000 });
  const row = (await reopened.get(SEG))!;
  const aead = row.wrappedDeks === undefined ? undefined : await keystore!.openDek(row.wrappedDeks);
  return { row, described: usableSummary(SEG, row, aead) };
}

async function present(w: World): Promise<number[]> {
  const out: number[] = [];
  for await (const k of w.disk.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

const key = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

describe.each([
  ['cleartext', (): InProcessKeystore | undefined => undefined],
  ['encrypted', (): InProcessKeystore | undefined => key()],
])('on the local-filesystem backend, a %s segment', (_name, makeKeystore) => {
  it('has the summary and metadata of the current generation on its row, which a reopened registry reads back', async () => {
    const keystore = makeKeystore();
    const w = world(keystore);
    await loadSegment(SEG, idsOf(4), w.deps, { keep: 9, metadata: META });
    const first = await describedOnDisk(keystore);
    const { row } = first;
    expect(row.summary).toBeDefined();
    expect('sealed' in row.summary!).toBe(keystore !== undefined);
    expect(first.described).toEqual({ cardinality: 4, metadata: META });

    await loadSegment(SEG, idsOf(7), w.deps, { keep: 9, metadata: { def: 'v4' } });
    const second = await describedOnDisk(keystore);
    expect(second.described).toEqual({ cardinality: 7, metadata: { def: 'v4' } });
  });

  it('is sized by a guarded load from the row: no object is opened for it', async () => {
    const keystore = makeKeystore();
    const w = world(keystore);
    await loadSegment(SEG, idsOf(3), w.deps, { metadata: META });
    await loadSegment(SEG, idsOf(5), w.deps, { metadata: META });
    w.tails.length = 0;
    await loadSegment(SEG, idsOf(8), w.deps, { metadata: META });
    // Two checks of existence (the next number, then the current object), and no read of an index.
    expect(w.tails).toEqual([0, 0]);
  });

  it('does not delete the only generation left before the tear, when the current object was removed from outside', async () => {
    const keystore = makeKeystore();
    const w = world(keystore);
    for (const n of [3, 5, 8]) await loadSegment(SEG, idsOf(n), w.deps, { metadata: META });
    expect(await present(w)).toEqual([1, 2]);
    await w.disk.delete({ ...SEG, generation: 2 });
    const r = await loadSegment(SEG, idsOf(10), w.deps, { metadata: META });
    expect(r).toMatchObject({ generation: 3, published: true });
    expect(await present(w)).toEqual([1, 3]);
  });

  it('is written for the target by a rollback, and by an erasure for what it makes current', async () => {
    const keystore = makeKeystore();
    const w = world(keystore);
    await loadSegment(SEG, idsOf(3), w.deps, { keep: 9, metadata: META });
    await loadSegment(SEG, idsOf(6), w.deps, { keep: 9, metadata: { def: 'v4' } });

    await rollbackSegment(SEG, 0, { storage: w.storage, registry: w.registry, keystore });
    let seen = await describedOnDisk(keystore);
    expect(seen.row.currentGen).toBe(0);
    expect(seen.described).toEqual({ cardinality: 3, metadata: META });

    const result = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(result).toMatchObject({ erased: true });
    seen = await describedOnDisk(keystore);
    expect(seen.row.currentGen).toBe(result.generation);
    expect(seen.described).toEqual({ cardinality: 2, metadata: META });
  });
});
