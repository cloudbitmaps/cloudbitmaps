import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { openGenerationReader } from '@/core/crbm-cold-source';
import { KeyUnavailableError, ValidationError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, RecordingAuditSink, bulkLoadCrbmGeneration } from '@/index';
import type { GenKey, IColdDriver, IKeystore, SegmentRef } from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `eraseIdFromSegment` — subject erasure on a loaded segment, one id at a time.
 *
 * There is no per-id delete on an immutable object, so erasure is what every other write is: a **new
 * generation**, streamed from the current one with a single bit cleared, published forward-only, and the
 * generation that held the bit collected before the call returns. These tests pin the two halves of that
 * contract — what the rewrite *writes* (every other chunk carried through byte-for-byte, an emptied chunk
 * dropped, keys ascending) and what it *reports* (the `reason` for each way nothing gets rewritten).
 *
 * The codec is passed explicitly: this is the core module, which is codec-agnostic; the facade binds `roaringCodec`
 * for applications.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const k = (): Uint8Array => randomBytes(32);

async function world(keystore?: IKeystore) {
  const w = await loadedStore({}, { keystore, retry: false });
  const deps = { cold: w.cold, registry: w.registry, codec: roaringCodec, keystore };
  /** A FRESH store: the fixture pins a segment's generation for the store's lifetime (no clock ⇒ TTL 0). */
  const reader = (): CloudRoaring =>
    new CloudRoaring({ cold: w.cold, registry: w.registry, keystore, retry: false });
  /** A fresh store with NO keystore — what an encrypted segment must be unreadable through. */
  const keylessReader = (): CloudRoaring =>
    new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });
  return { ...w, deps, reader, keylessReader };
}

async function generations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/** Every chunk of one generation, keyed by chunk key, as the raw bytes stored in the `.crbm`. */
async function chunksOf(cold: IColdDriver, key: GenKey): Promise<Map<number, Uint8Array>> {
  const reader = await openGenerationReader(cold, key, undefined);
  const out = new Map<number, Uint8Array>();
  for (const chunkKey of reader.chunkKeys()) out.set(chunkKey, (await reader.getChunk(chunkKey))!);
  return out;
}

const decode = (bytes: Uint8Array): number[] =>
  SafeBitmap.safeDeserialize(bytes, 1 << 20).toArray();

describe('eraseIdFromSegment — the reasons nothing is rewritten', () => {
  it("'absent': no registry row", async () => {
    const w = await world();
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'absent',
      collected: [],
    });
  });

  it("'destroyed': a crypto-shred tombstone is already unreadable", async () => {
    const w = await world();
    await w.registry.create(SEG, { currentGen: 0, status: 'destroyed' });
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'destroyed',
      collected: [],
    });
  });

  it("'no-generation': a row minted by setRetention before the first load holds no id", async () => {
    const w = await world();
    await w.registry.create(SEG, { currentGen: null });
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
  });

  it("'not-member' when the id's chunk is absent from the generation", async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]); // chunk 0 only
    const res = await eraseIdFromSegment(SEG, 70_000, w.deps); // chunk 1
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [],
    });
  });

  it("'not-member' when the chunk is present but the bit is not", async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, 5, w.deps);
    expect(res).toMatchObject({ erased: false, reason: 'not-member', fromGeneration: 0 });
  });

  it('none of these write an object, move the pointer, or emit an audit event', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const audit = new RecordingAuditSink();
    await eraseIdFromSegment(SEG, 5, w.deps, { audit });
    await eraseIdFromSegment(SEG, 70_000, w.deps, { audit });
    await eraseIdFromSegment({ namespace: 'ns', segment: 'nope' }, 1, w.deps, { audit });
    expect(await generations(w.cold, SEG)).toEqual([0]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(audit.snapshot()).toEqual([]);
  });
});

describe('eraseIdFromSegment — the rewrite', () => {
  it('writes the current generation without the id, publishes it, and collects the old one', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3, 70_000, 200_000]); // chunks 0, 1 and 3
    const before = await chunksOf(w.cold, { ...SEG, generation: 0 });

    const res = await eraseIdFromSegment(SEG, 2, w.deps);

    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: true,
      fromGeneration: 0,
      generation: 1,
      collected: [0],
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    // The physical half: the generation that held the bit is gone from the bucket when the call returns.
    expect(await generations(w.cold, SEG)).toEqual([1]);

    const after = await chunksOf(w.cold, { ...SEG, generation: 1 });
    expect([...after.keys()]).toEqual([...before.keys()]); // same chunk set — no chunk was emptied
    expect(decode(after.get(0)!)).toEqual([1, 3]); // the one chunk that changed
    // Every other chunk is carried through byte-for-byte: the rewrite re-encodes, but the same set encodes the
    // same way, so an untouched chunk's bytes are identical to what the load wrote.
    expect(after.get(1)).toEqual(before.get(1));
    expect(after.get(3)).toEqual(before.get(3));
  });

  it('drops a chunk the removal emptied — the new chunk set is the old minus that chunk', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 70_000]); // 70_000 is alone in chunk 1
    const before = await chunksOf(w.cold, { ...SEG, generation: 0 });
    expect([...before.keys()]).toEqual([0, 1]);

    const res = await eraseIdFromSegment(SEG, 70_000, w.deps);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });

    const after = await chunksOf(w.cold, { ...SEG, generation: 1 });
    expect([...after.keys()]).toEqual([0]); // empty chunks are never stored
    expect(after.get(0)).toEqual(before.get(0));
  });

  it('keeps chunk keys ascending regardless of where the erased id sat', async () => {
    const w = await world();
    const ids = [5, 70_000, 200_000, 300_000, 460_000]; // chunks 0, 1, 3, 4, 7
    await w.load(SEG, ids);
    await eraseIdFromSegment(SEG, 200_000, w.deps); // empties chunk 3
    const reader = await openGenerationReader(w.cold, { ...SEG, generation: 1 }, undefined);
    const keys = [...reader.chunkKeys()];
    expect(keys).toEqual([0, 1, 4, 7]);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('emits one segment.rewrite at the publish — and NOT a segment.publish', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const audit = new RecordingAuditSink();
    await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.rewrite', namespace: 'ns', segment: 's', fromGeneration: 0, generation: 1 },
    ]);
  });

  it('takes the generation after any staged, unpublished object — and collects that orphan too', async () => {
    // A load that wrote its object and crashed before publishing leaves gen 5 above `currentGen` 0. A rewrite
    // that consulted only the pointer would pick gen 1 forever and never conflict; `nextGeneration` skips past
    // the orphan, and the `keep: 0` collection then takes every generation below the new pointer.
    const w = await world();
    await w.load(SEG, [1, 2]);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [9]); // no registry ⇒ never published

    const res = await eraseIdFromSegment(SEG, 1, w.deps);

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 6 });
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 5]);
    expect(await generations(w.cold, SEG)).toEqual([6]);
    expect(await collect(w.reader().segment('s', { namespace: 'ns' }).iterate())).toEqual([2]);
  });

  it('is what a fresh reader sees: has() false, count decremented, the rest intact', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3, 70_000]);
    await eraseIdFromSegment(SEG, 70_000, w.deps);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.has(70_000)).toBe(false);
    expect(await seg.has(1)).toBe(true);
    expect(await seg.count()).toBe(3);
    expect(await collect(seg.iterate())).toEqual([1, 2, 3]);
  });

  it('is idempotent — a second call finds no member and writes nothing', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    await eraseIdFromSegment(SEG, 2, w.deps);
    const again = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(again).toMatchObject({ erased: false, reason: 'not-member', fromGeneration: 1 });
    expect(await generations(w.cold, SEG)).toEqual([1]);
  });
});

describe('eraseIdFromSegment — encryption', () => {
  it('reuses the segment DEK: the rewrite reads with the keystore and is unreadable without it', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.load(SEG, [1, 2, 3]);
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;

    const res = await eraseIdFromSegment(SEG, 2, w.deps);

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore); // same DEK, not re-minted
    expect(await collect(w.reader().segment('s', { namespace: 'ns' }).iterate())).toEqual([1, 3]);
    await expect(
      collect(w.keylessReader().segment('s', { namespace: 'ns' }).iterate()),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('refuses to rewrite an encrypted segment without a keystore — a lost key, not a cleartext segment', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.load(SEG, [1, 2, 3]);
    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, keystore: undefined }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(await generations(w.cold, SEG)).toEqual([0]); // nothing written
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('requireEncryption refuses a cleartext segment', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, requireEncryption: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generations(w.cold, SEG)).toEqual([0]);
  });
});

describe('eraseIdFromSegment — validation', () => {
  it('rejects a non-u32 id and a bad segment ref before touching storage', async () => {
    const w = await world();
    await expect(eraseIdFromSegment(SEG, -1, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(eraseIdFromSegment(SEG, 2 ** 32, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(eraseIdFromSegment({ segment: '../bad' }, 1, w.deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
