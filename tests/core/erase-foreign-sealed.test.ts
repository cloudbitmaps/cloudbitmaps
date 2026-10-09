import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/core/audit';
import type { CodecBitmap } from '@/core/codec';
import { writeCrbmGenerationStream } from '@/core/crbm-storage-source';
import { FOOTER, FOOTER_BYTES } from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * On an encrypted segment, an object sealed under a key its row does not hold: a first load's that lost the race to the
 * one that published, or one that crashed before its publish, each under a key it made and never stored. No read of the
 * segment can open it, so the erasure cannot search it, and it counts as a holder, as it does on a row with no pointer:
 * it is deleted, above the pointer or below it, under the renewal of the row and a read of the row before each delete,
 * and listed in `collected`. Only a searched object that held the id makes the answer `erased: true`.
 *
 * Which objects those are is decided by the index: one whose index does not open under the row's key was never
 * sealed under it. One whose index opens under the row's key, and whose chunk then does not, is that segment's own
 * object, corrupt, and the erasure still says so with `IntegrityError`. The current generation is never deleted.
 */
const REF: SegmentRef = { segment: 's' };
const X = 9;
/** Loads keep five generations below the pointer, so a load's own collection leaves the objects these tests place. */
const KEEP = { keep: 5 };

function world() {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
  const deps = { storage, registry, codec: roaringCodec, keystore };
  return { storage, registry, keystore, deps };
}
type W = ReturnType<typeof world>;

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A first load's object under a key it made and never stored: it read no row, wrote, and never published. */
async function sealedElsewhere(w: W, generation: number, ids: number[]): Promise<void> {
  await bulkLoadCrbmGeneration(w.storage, { ...REF, generation }, ids, {
    registry: new MemoryRegistryDriver(),
    keystore: w.keystore,
    publish: false,
  });
}

/** The whole object at `generation`. */
async function bytesOf(storage: IStorageDriver, generation: number): Promise<Uint8Array> {
  return (await storage.getTail({ ...REF, generation }, 1 << 30)).bytes;
}

/** Replace the object at `generation` with `change` of its bytes, as damage or a forger would. */
async function rewriteObject(
  storage: IStorageDriver,
  generation: number,
  change: (bytes: Uint8Array) => Uint8Array,
): Promise<void> {
  const changed = change(Uint8Array.from(await bytesOf(storage, generation)));
  await storage.delete({ ...REF, generation });
  await storage.putImmutable({ ...REF, generation }, async (out) => out.write(changed));
}

/** Where the footer starts, and its fields' offsets in it. */
const footerAt = (bytes: Uint8Array): number => bytes.length - FOOTER_BYTES;
const u64 = (bytes: Uint8Array, at: number): number =>
  Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at, true));

/** A byte of the index flipped, its checksum left as it was. */
function flipIndexByte(bytes: Uint8Array): Uint8Array {
  bytes[u64(bytes, footerAt(bytes) + FOOTER.indexOffset)]! ^= 0x01;
  return bytes;
}

/** The ids as the ascending chunks a generation is written from. */
async function* chunksOf(ids: number[]): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
  const byChunk = new Map<number, number[]>();
  for (const id of ids) byChunk.set(id >>> 16, [...(byChunk.get(id >>> 16) ?? []), id & 0xffff]);
  for (const chunkKey of [...byChunk.keys()].sort((a, b) => a - b)) {
    yield { chunkKey, bitmap: roaringCodec.fromValues(byChunk.get(chunkKey)!) };
  }
}

/**
 * An object sealed under the row's own key whose index opens, and whose chunks were sealed for another context, so
 * none of them opens: the segment's own object, corrupt.
 */
async function corruptUnderRowKey(w: W, generation: number, ids: number[]): Promise<void> {
  const row = (await w.registry.get(REF))!;
  const aead = await w.keystore.openDek(row.wrappedDeks!);
  await writeCrbmGenerationStream(w.storage, { ...REF, generation }, chunksOf(ids), {
    crypto: {
      aead,
      aadFor: (scope) =>
        typeof scope === 'number'
          ? aadFor(REF, generation + 1000, scope)
          : aadFor(REF, generation, scope),
    },
  });
}

describe('an object sealed under a key the row does not hold', () => {
  it('below the pointer, with no searched holder: it alone goes, and the generation the window keeps stays', async () => {
    const w = world();
    await loadSegment(REF, [1, 2], w.deps, KEEP); // 0, kept below the pointer
    await sealedElsewhere(w, 1, [X]); // a first load that crashed, under a key of its own
    await loadSegment(REF, [1, 2, 3], w.deps, KEEP); // 2, current
    expect(await generations(w.storage)).toEqual([0, 1, 2]);
    const before = (await w.registry.get(REF))!;

    const audit = new RecordingAuditSink();
    expect(await eraseIdFromSegment(REF, 4242, w.deps, { audit })).toEqual({
      segment: 's',
      namespace: undefined,
      erased: false,
      reason: 'not-member',
      fromGeneration: 2,
      collected: [1],
    });
    expect(await generations(w.storage)).toEqual([0, 2]);
    const row = (await w.registry.get(REF))!;
    expect(row.currentGen).toBe(2);
    expect(row.pointerId).not.toBe(before.pointerId);
    // The deletion is audited, with no generation the id was found in, since none was.
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.collect', segment: 's', incarnation: expect.any(String), collected: [1] },
    ]);
  });

  it('below the pointer, beside a searched holder: the collection takes it with the rest, and the id is erased', async () => {
    const w = world();
    await loadSegment(REF, [1, 2, 5], w.deps, KEEP); // 0 holds 5
    await sealedElsewhere(w, 1, [7]);
    await loadSegment(REF, [1, 2, 3], w.deps, KEEP); // 2, current, without 5
    expect(await eraseIdFromSegment(REF, 5, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 0,
      collected: [0, 1],
    });
    expect(await generations(w.storage)).toEqual([2]);
  });

  it('above the pointer: the object of a first load that lost the race goes under the fence', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null }); // made ahead of its data
    await loadSegment(REF, [1, 2], w.deps, KEEP); // the first load that published: 0, under the key it made
    await sealedElsewhere(w, 1, [X]); // the one that lost, under the key it made
    const before = (await w.registry.get(REF))!;
    expect(await eraseIdFromSegment(REF, 4242, w.deps)).toMatchObject({
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [1],
    });
    expect(await generations(w.storage)).toEqual([0]);
    const row = (await w.registry.get(REF))!;
    expect(row.currentGen).toBe(0);
    expect(row.pointerId).not.toBe(before.pointerId);
  });

  it('above the pointer, beside a holder: both go, and the id is erased from the one searched', async () => {
    const w = world();
    await loadSegment(REF, [1], w.deps, KEEP);
    await loadSegment(REF, [1, X], w.deps, KEEP);
    await rollbackSegment(REF, 0, w.deps); // 1, holding the id, is above the pointer
    await sealedElsewhere(w, 2, [3]);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 1,
      collected: [1, 2],
    });
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('on a row with no pointer that holds a key: it goes as a sealed holder', async () => {
    const w = world();
    const minted = await w.keystore.createDek();
    await w.registry.create(REF, { currentGen: null, wrappedDeks: minted.wrapped });
    await sealedElsewhere(w, 0, [X]);
    expect(await eraseIdFromSegment(REF, X, w.deps)).toEqual({
      segment: 's',
      namespace: undefined,
      erased: false,
      reason: 'no-generation',
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([]);
  });
});

describe('the last look at the bucket counts an object it cannot search', () => {
  it('one sealed elsewhere that appears during the deletes is left, and the erasure asks for a re-run', async () => {
    const w = world();
    const minted = await w.keystore.createDek();
    await w.registry.create(REF, { currentGen: null, wrappedDeks: minted.wrapped });
    await sealedElsewhere(w, 0, [X]);
    // While the erasure deletes the object at 0, a first load of its own key writes one at 5.
    let planted = false;
    const storage = Object.create(w.storage) as IStorageDriver;
    storage.delete = async (key) => {
      await w.storage.delete(key);
      if (!planted) {
        planted = true;
        await sealedElsewhere(w, 5, [3]);
      }
    };
    await expect(eraseIdFromSegment(REF, X, { ...w.deps, storage })).rejects.toSatisfy(
      (e: unknown) => e instanceof WriteConflictError && /generation 5\b.*re-run/.test(e.message),
    );
    expect(planted).toBe(true);
    expect(await generations(w.storage)).toEqual([5]);
  });
});

describe("an object sealed under the row's own key that does not open is corrupt, and says so", () => {
  it('above the pointer: IntegrityError, and nothing is deleted or written', async () => {
    const w = world();
    await loadSegment(REF, [1, 2], w.deps, KEEP);
    await corruptUnderRowKey(w, 1, [X]);
    const before = (await w.registry.get(REF))!;
    await expect(eraseIdFromSegment(REF, X, w.deps)).rejects.toBeInstanceOf(IntegrityError);
    expect(await generations(w.storage)).toEqual([0, 1]);
    expect((await w.registry.get(REF))!.token).toBe(before.token);
  });

  it('below the pointer: IntegrityError, and nothing is deleted', async () => {
    const w = world();
    await loadSegment(REF, [1, 2], w.deps, KEEP);
    await corruptUnderRowKey(w, 1, [X]);
    await loadSegment(REF, [1, 2, 3], w.deps, KEEP); // 2, current; 1 is below it
    await expect(eraseIdFromSegment(REF, X, w.deps)).rejects.toBeInstanceOf(IntegrityError);
    expect(await generations(w.storage)).toContain(1);
  });

  it('the current generation is never deleted: one the row has no key for still throws', async () => {
    // A rollback with no key at hand checks only that the target is encrypted, so it can make current an object sealed
    // under another key. Every read of the segment then fails, and so does the erasure, which deletes nothing.
    const w = world();
    await loadSegment(REF, [1, 2], w.deps, KEEP);
    await sealedElsewhere(w, 1, [X]);
    await rollbackSegment(
      REF,
      1,
      { storage: w.storage, registry: w.registry },
      { allowForward: true },
    );
    expect((await w.registry.get(REF))!.currentGen).toBe(1);
    await expect(eraseIdFromSegment(REF, X, w.deps)).rejects.toBeInstanceOf(IntegrityError);
    expect(await generations(w.storage)).toEqual([0, 1]);
  });
});

describe('an encrypted object under a cleartext row with a pointer', () => {
  // A key is made only for a segment's first generation, onto no row or a row with no pointer and no key; a load onto a
  // cleartext row with a pointer writes cleartext, a publish that would add a key to it is refused, and a rollback
  // refuses an encrypted target on it. So an encrypted object there is a first load's that minted a key and crashed, or
  // lost the race to a cleartext first load: no reader of the row can open it.
  const plain = (w: W) => ({ storage: w.storage, registry: w.registry, codec: roaringCodec });

  it('below the pointer: it is a holder the erasure cannot search, and goes', async () => {
    const w = world();
    await sealedElsewhere(w, 0, [X]); // an encrypted first load that crashed
    await loadSegment(REF, [1, 2], plain(w), KEEP); // a cleartext first load publishes 1
    expect((await w.registry.get(REF))!.wrappedDeks).toBeUndefined();
    expect(await eraseIdFromSegment(REF, 4242, w.deps)).toMatchObject({
      erased: false,
      reason: 'not-member',
      fromGeneration: 1,
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([1]);
  });

  it('above the pointer: the object of an encrypted first load that lost the race goes under the fence', async () => {
    const w = world();
    await loadSegment(REF, [1, 2], plain(w), KEEP); // the cleartext first load that published 0
    await sealedElsewhere(w, 1, [X]); // the encrypted one that lost
    const before = (await w.registry.get(REF))!;
    expect(await eraseIdFromSegment(REF, X, plain(w))).toMatchObject({
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [1],
    });
    expect(await generations(w.storage)).toEqual([0]);
    expect((await w.registry.get(REF))!.pointerId).not.toBe(before.pointerId);
  });

  it("the row's own cleartext object that is corrupt still throws IntegrityError, and nothing is deleted", async () => {
    const w = world();
    await loadSegment(REF, [1, X], plain(w), KEEP); // 0
    await loadSegment(REF, [1, 2], plain(w), KEEP); // 1, current
    await rewriteObject(w.storage, 0, flipIndexByte);
    await expect(eraseIdFromSegment(REF, X, plain(w))).rejects.toBeInstanceOf(IntegrityError);
    expect(await generations(w.storage)).toEqual([0, 1]);
  });
});
