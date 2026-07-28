import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource, ValidationError } from '@/index';
import type { ChunkRef, IWarmDriver, SegmentRef, WarmRow } from '@/core/ports';
import { joinId } from '@/core/bit-route';

// `addMany`/`removeMany` take a sync OR async iterable, so a database cursor streams straight in.
//
// The ergonomic half is trivial. The half worth testing is the cost, because the obvious implementation of
// "accept a stream" is quietly catastrophic: buffer N ids, flush them to the backend, repeat. That bounds
// memory and, with ids arriving in arbitrary order, makes every flush touch nearly every chunk *again* — an
// 11M-id stream at a 1M-id buffer would issue 11x the OCC round-trips of a single pass. In a library whose
// headline claim is honest cost, that is not a bounded-memory strategy; it is a different bug.
//
// So the invariant these tests defend is: **each chunk is written exactly once, however long the stream.**
// A test that only checked "the ids landed" would pass against the 11x version.
const SEG = 'stream';

/** Counts backend writes per chunk, so write amplification is directly observable. */
class CountingWarm implements IWarmDriver {
  writesByChunk = new Map<number, number>();

  constructor(private readonly inner: MemoryWarmDriver = new MemoryWarmDriver()) {}

  private note(chunkKey: number): void {
    this.writesByChunk.set(chunkKey, (this.writesByChunk.get(chunkKey) ?? 0) + 1);
  }
  get totalWrites(): number {
    return [...this.writesByChunk.values()].reduce((a, b) => a + b, 0);
  }
  get worstChunk(): number {
    return Math.max(0, ...this.writesByChunk.values());
  }

  get = (ref: ChunkRef): Promise<WarmRow | null> => this.inner.get(ref);
  putConditional = ((ref: ChunkRef, ...rest: unknown[]) => {
    this.note(ref.chunkKey);
    return (this.inner.putConditional as (...a: unknown[]) => unknown)(ref, ...rest);
  }) as never;
  deleteConditional = ((...a: unknown[]) =>
    (this.inner.deleteConditional as (...x: unknown[]) => unknown)(...a)) as never;
  listChunks = ((seg: SegmentRef, ...rest: unknown[]) =>
    (this.inner.listChunks as (...a: unknown[]) => AsyncIterable<WarmRow>)(seg, ...rest)) as never;
}

const storeOn = (warm: IWarmDriver) =>
  new CloudRoaring({ warm, cold: new MemoryColdChunkSource() } as never);

/**
 * Ids deliberately INTERLEAVED across chunks rather than grouped — `chunk 0, chunk 1, … chunk 0, chunk 1, …`.
 * Grouped input would let even a naive buffer-and-flush implementation look clean, because each flush would
 * touch few chunks. Interleaving is both the realistic shape of a database cursor and the worst case.
 */
const CHUNKS = 40;
const PER_CHUNK = 50;
const INTERLEAVED = Array.from({ length: CHUNKS * PER_CHUNK }, (_, i) =>
  joinId(i % CHUNKS, Math.floor(i / CHUNKS) + 1),
);

async function* streamOf(ids: readonly number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

describe('addMany/removeMany over a stream', () => {
  it('accepts an async iterable and lands every id', async () => {
    const store = storeOn(new MemoryWarmDriver());
    await store.segment(SEG).addMany(streamOf(INTERLEAVED));
    await expect(store.segment(SEG).count()).resolves.toBe(INTERLEAVED.length);
    for (const id of INTERLEAVED) await expect(store.segment(SEG).has(id)).resolves.toBe(true);
  });

  it('writes each chunk EXACTLY ONCE — the property a buffer-and-flush version would break', async () => {
    // This is the whole point of the file. Interleaved input across 40 chunks: a correct implementation issues
    // 40 writes. An implementation that flushed its buffer to the backend mid-stream would issue a multiple of
    // that, and would still pass every other test here.
    const warm = new CountingWarm();
    await storeOn(warm as unknown as IWarmDriver)
      .segment(SEG)
      .addMany(streamOf(INTERLEAVED));
    expect(warm.worstChunk).toBe(1);
    expect(warm.totalWrites).toBe(CHUNKS);
  });

  it('costs the same whether the ids arrive as an array or a stream', async () => {
    // Streaming must be an input-shape choice, never a cost choice. If these diverge, callers are silently
    // penalised for using the ergonomic API — which would make the feature worse than the hand-batching it
    // replaces.
    const viaArray = new CountingWarm();
    await storeOn(viaArray as unknown as IWarmDriver)
      .segment(SEG)
      .addMany(INTERLEAVED);
    const viaStream = new CountingWarm();
    await storeOn(viaStream as unknown as IWarmDriver)
      .segment(SEG)
      .addMany(streamOf(INTERLEAVED));
    expect(viaStream.totalWrites).toBe(viaArray.totalWrites);
  });

  it('removeMany streams too, and the two compose to the right set', async () => {
    const store = storeOn(new MemoryWarmDriver());
    await store.segment(SEG).addMany(streamOf(INTERLEAVED));
    await store.segment(SEG).removeMany(streamOf(INTERLEAVED.slice(0, 500)));
    await expect(store.segment(SEG).count()).resolves.toBe(INTERLEAVED.length - 500);
    await expect(store.segment(SEG).has(INTERLEAVED[0] as number)).resolves.toBe(false);
    await expect(store.segment(SEG).has(INTERLEAVED[500] as number)).resolves.toBe(true);
  });

  it('applies a batch set-wise without breaking the adds/removes disjoint invariant (I1)', async () => {
    // The batch is now folded in with `orInPlace`/`andNotInPlace` rather than id-by-id, so the invariant that
    // an id is never simultaneously in `adds` and `removes` is now enforced by set algebra instead of by a
    // loop. Re-adding something previously removed, and vice versa, is what exercises it.
    const store = storeOn(new MemoryWarmDriver());
    const ids = [joinId(1, 10), joinId(1, 11), joinId(2, 12)];
    await store.segment(SEG).addMany(ids);
    await store.segment(SEG).removeMany(ids);
    await expect(store.segment(SEG).count()).resolves.toBe(0);
    await store.segment(SEG).addMany(streamOf(ids)); // re-add what was just removed
    await expect(store.segment(SEG).count()).resolves.toBe(ids.length);
    for (const id of ids) await expect(store.segment(SEG).has(id)).resolves.toBe(true);
  });

  it('deduplicates within a batch, matching the set semantics of the sync path', async () => {
    const store = storeOn(new MemoryWarmDriver());
    const dup = joinId(3, 7);
    await store.segment(SEG).addMany(streamOf([dup, dup, dup]));
    await expect(store.segment(SEG).count()).resolves.toBe(1);
  });

  it('rejects a bad id mid-stream before writing anything', async () => {
    // Validation happens while staging and the backend is only touched once the stream is fully consumed, so a
    // malformed id anywhere means zero writes rather than a half-applied batch. Worth pinning: streaming makes
    // "we already wrote some of it" the easy mistake.
    const warm = new CountingWarm();
    const store = storeOn(warm as unknown as IWarmDriver);
    async function* withBadId(): AsyncGenerator<number> {
      yield joinId(1, 1);
      yield joinId(2, 2);
      yield 2 ** 32; // out of the u32 range
    }
    await expect(store.segment(SEG).addMany(withBadId())).rejects.toBeInstanceOf(ValidationError);
    expect(warm.totalWrites).toBe(0);
  });

  it('propagates a source failure instead of silently writing the prefix', async () => {
    const warm = new CountingWarm();
    const store = storeOn(warm as unknown as IWarmDriver);
    async function* boom(): AsyncGenerator<number> {
      yield joinId(1, 1);
      throw new Error('cursor died');
    }
    await expect(store.segment(SEG).addMany(boom())).rejects.toThrow('cursor died');
    expect(warm.totalWrites).toBe(0);
  });

  it('handles an empty stream as a no-op', async () => {
    const warm = new CountingWarm();
    const store = storeOn(warm as unknown as IWarmDriver);
    await store.segment(SEG).addMany(streamOf([]));
    expect(warm.totalWrites).toBe(0);
    await expect(store.segment(SEG).count()).resolves.toBe(0);
  });
});
