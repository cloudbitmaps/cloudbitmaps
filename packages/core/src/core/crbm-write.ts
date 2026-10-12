/**
 * Writing one immutable `.crbm` generation: from in-memory bitmaps, from already-encoded chunks, or streamed, and the
 * bucketing of loaded ids into the chunks a load writes.
 */
import { IntegrityError } from './errors';
import { yieldEvery } from './cooperative';
import type { Yielder } from './cooperative';
import type { Clock } from './determinism';
import { splitId } from './bit-route';
import type { CrbmCrypto } from './crypto';
import type { GenerationMetadata, GenKey, IStorageDriver } from './ports';
import { fingerprintFor } from './crbm/fingerprint';
import { CrbmWriter } from './crbm/writer';
import type { CodecBitmap, CodecInterface, EncodedChunk } from './codec';
import { DecodedLoadInput } from './load-input';

/**
 * How many buffered remainders bulk-load holds before flushing them into their chunk bitmaps. Bounds the
 * transient JS-side buffer to **~28 MB measured** irrespective of input size, while keeping batches large
 * enough that the per-id JS↔native crossing is amortised away.
 */
const BULK_FLUSH_IDS = 1 << 20;

/**
 * Ids between ingest-loop yields. 16x coarser than the per-chunk cadence because the per-id work is ~40 ns
 * (a `splitId` and an array push) against ~1.3 µs per chunk — matching cadences would put the yield cost on the
 * wrong side of the work it interrupts. Sized against the *slowest* ingest, an in-memory async generator at
 * ~220 ns/id, so the resulting stretch stays a few ms there and well under 1 ms on a plain array.
 */
const YIELD_EVERY_IDS = 1 << 14;

/**
 * Write one immutable generation from in-memory bitmaps. Chunks are
 * sorted ascending and empty bitmaps skipped (empty chunks are never stored). Returns the driver's
 * `{ size, sha256 }` for the written object. Pass `options.crypto` to AES-256-GCM-encrypt the generation
 * (built from the segment's DEK, with associated data bound to `(segment, generation)`).
 */
export async function writeCrbmGeneration(
  driver: IStorageDriver,
  key: GenKey,
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata } = {},
): Promise<{ size: number; sha256: string; fingerprint: string }> {
  const sorted = [...chunks].sort((a, b) => a.chunkKey - b.chunkKey);
  const { size, sha256, fingerprint } = await writeEncodedChunks(
    driver,
    key,
    encodeEach(sorted),
    options,
  );
  return { size, sha256, fingerprint };
}

/**
 * The chunks a load of ids, or of a decoded bitmap, writes: ascending by key, each non-empty and run-optimized. A decoded
 * bitmap writes its own chunks, which never touches an id. Ids, and the bitmap of a codec that cannot encode its own
 * chunks, are bucketed per chunk instead; both give the same bytes.
 */
export async function encodedChunksOfInput(
  ids: Iterable<number> | AsyncIterable<number> | DecodedLoadInput,
  codec: CodecInterface,
  clock: Clock | undefined,
): Promise<Iterable<EncodedChunk>> {
  if (ids instanceof DecodedLoadInput && ids.bitmap.encodeChunks !== undefined) {
    // The whole-bitmap steps each get a slice of their own: the decode the load made before its first request, the
    // re-encode and serialize `encodeChunks` makes when called, and then the cut, which is lazy, so the writer's
    // periodic yield interrupts it.
    const pause = yieldEvery(clock, 1);
    await pause();
    const chunks = ids.bitmap.encodeChunks();
    await pause();
    return chunks;
  }
  return encodeEach(
    await bucketIds(ids instanceof DecodedLoadInput ? ids.bitmap : ids, codec, clock),
  );
}

/** Each non-empty bitmap as the chunk it stores, in the order given. */
export function* encodeEach(
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
): Generator<EncodedChunk> {
  for (const { chunkKey, bitmap } of chunks) {
    if (bitmap.isEmpty) continue;
    // Run-encode before serializing. Storage generations are immutable and read many times, so the one-off cost
    // here buys every later read a smaller fetch — see CodecBitmap.optimize for the measured factors.
    bitmap.optimize?.();
    yield { chunkKey, payload: bitmap.serialize(), cardinality: bitmap.size };
  }
}

/**
 * Write one immutable generation from chunks already encoded, which must ascend by key (the writer refuses one
 * that does not). Returns the driver's `{ size, sha256 }` and a tally of what was written.
 */
export async function writeEncodedChunks(
  driver: IStorageDriver,
  key: GenKey,
  chunks: Iterable<EncodedChunk>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata },
): Promise<{
  size: number;
  sha256: string;
  chunkCount: number;
  cardinality: number;
  fingerprint: string;
}> {
  // The single longest blocking stretch in a bulk load: serialize + CRC32C + frame, once per chunk, ~62,000
  // times. `await writer.addChunk(...)` looks like it yields and does not — the sink buffers in memory, so the
  // promise is already resolved and awaiting it is a microtask. See {@link yieldEvery}.
  const tick = yieldEvery(options.clock);
  let chunkCount = 0;
  let cardinality = 0;
  let identity: { readonly size: number; readonly footerCrc: number } | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
    });
    for (const chunk of chunks) {
      await writer.addChunk(chunk.chunkKey, chunk.payload, chunk.cardinality);
      chunkCount++;
      cardinality += chunk.cardinality;
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
    identity = writer.identity;
  });
  if (identity === undefined) {
    throw new IntegrityError(
      `the driver committed ${key.segment}.${key.generation} without writing it`,
    );
  }
  // The fingerprint of what this call wrote, which tells it from an object stored later under the same key.
  return {
    size,
    sha256,
    chunkCount,
    cardinality,
    fingerprint: fingerprintFor(identity.size, identity.footerCrc),
  };
}

/** What {@link writeCrbmGenerationStream} wrote: the driver's `{ size, sha256 }` + a tally of the generation. */
interface StreamWriteResult {
  readonly size: number;
  readonly sha256: string;
  /** Non-empty chunk keys written, in ascending order (for the post-write verify, since the stream is consumed). */
  readonly chunkKeys: number[];
  /** Total ids written. */
  readonly cardinality: number;
  /** The fingerprint of what this call wrote ({@link CrbmReader.fingerprint}), which tells it from another object under its key. */
  readonly fingerprint: string;
}

/**
 * Streaming variant of {@link writeCrbmGeneration} for a **constant-memory** rewrite (the erasure rewrite, a
 * sorted load): consumes an **already-ascending** async stream of `{ chunkKey, bitmap }`, feeding each to the
 * codec and freeing it, instead of materializing the whole generation. Paired with a streaming storage sink (S3
 * multipart / LocalFs temp file), the writer itself holds ~one chunk + one part. Returns a tally so the caller can verify
 * the re-opened object without re-iterating the (now-consumed) stream. Input **must** be ascending by `chunkKey`
 * — the codec rejects an out-of-order chunk; empty bitmaps are skipped.
 */
export async function writeCrbmGenerationStream(
  driver: IStorageDriver,
  key: GenKey,
  chunks: AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata } = {},
): Promise<StreamWriteResult> {
  const chunkKeys: number[] = [];
  let cardinality = 0;
  // A rewrite runs this over a whole segment. The `for await` is not itself a yield — a stream backed by
  // already-resident chunks resolves on a microtask — so it needs the same periodic macrotask as the
  // non-streaming writer above.
  const tick = yieldEvery(options.clock);
  let identity: { readonly size: number; readonly footerCrc: number } | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
    });
    for await (const { chunkKey, bitmap } of chunks) {
      if (bitmap.isEmpty) continue;
      bitmap.optimize?.(); // same storage-write rationale as the non-streaming writer above
      await writer.addChunk(chunkKey, bitmap.serialize(), bitmap.size);
      chunkKeys.push(chunkKey);
      cardinality += bitmap.size;
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
    identity = writer.identity;
  });
  if (identity === undefined) {
    throw new IntegrityError(
      `the driver committed ${key.segment}.${key.generation} without writing it`,
    );
  }
  return {
    size,
    sha256,
    chunkKeys,
    cardinality,
    fingerprint: fingerprintFor(identity.size, identity.footerCrc),
  };
}

/** Route each id into its chunk's bitmap, consuming the source lazily. Returns the chunks, ascending by key. */
async function bucketIds(
  ids: Iterable<number> | AsyncIterable<number>,
  codec: CodecInterface,
  clock: Clock | undefined,
): Promise<Array<{ chunkKey: number; bitmap: CodecBitmap }>> {
  const byChunk = new Map<number, CodecBitmap>();
  // Batched per chunk, not one native `add()` per id.
  //
  // The obvious loop — `bitmap.add(remainder)` for every id — crosses the JS↔native boundary once per id, and
  // measured **1,679 ms for 1M ids** with no yield point anywhere in it. Since this is a synchronous stretch on
  // Node's only thread, a caller who wires it to a request handler stalls every other request on that instance
  // for over a second (measured separately: a 0.7 ms health check took 275 ms).
  //
  // Buffering the remainders and inserting them per chunk in one `fromValues`/`addMany` call amortises that
  // boundary crossing across the whole batch.
  //
  // WHY THE BUFFER IS CAPPED. Bucketing *everything* first and inserting once per chunk at the end is faster
  // still, but it holds every remainder as a JS number before any bitmap compression happens — and with up to
  // 65,536 chunks in play that is unbounded in exactly the way this library refuses to be. So the buffer is
  // flushed whenever the total pending count crosses `BULK_FLUSH_IDS`, bounding the extra memory regardless of
  // input size or key distribution while still getting the batching win. That bound is **~28 MB measured** at
  // 1M staged ids across ~65,000 chunks — not the ~8 MB a naive 8-bytes-per-number estimate gives, because the
  // cost is dominated by per-array and Map overhead across tens of thousands of small arrays.
  const pendingByChunk = new Map<number, number[]>();
  let pending = 0;
  // Yield periodically, NOT per chunk — see {@link yieldEvery} for why per-unit async is a 7x regression here.
  const tickChunk = yieldEvery(clock);
  const tickId = yieldEvery(clock, YIELD_EVERY_IDS);
  // Yield every N chunks, NOT per chunk. Measured: handing each chunk's insert to the threadpool
  // (`fromArrayAsync`) costs ~9 µs of dispatch against ~1.5 µs of actual work once ids are spread across
  // ~61,000 chunks — 636 ms versus 92 ms, a 7x regression that would have undone the per-chunk batching this
  // function already does. Keeping the inserts synchronous and interrupting them periodically gets the
  // starvation fix without the cost — measured on the per-chunk insert microbenchmark: 88 ms wall against a
  // 92 ms unyielded baseline. The whole-load end-to-end figures are a DIFFERENT experiment and live in
  // `cooperative.ts`. Quoting this 92 ms baseline beside that experiment's 450 ms stall would describe a 92 ms
  // operation with 450 ms of starvation inside it, which is impossible on its face.
  //
  // The yield must be a REAL macrotask. `await Promise.resolve()` is a microtask and never lets I/O run, which
  // is the trap that makes naive "just await something" fixes measure as no change at all.
  const flushPending = async (): Promise<void> => {
    for (const [chunkKey, rems] of pendingByChunk) {
      if (rems.length === 0) continue;
      const existingBitmap = byChunk.get(chunkKey);
      if (existingBitmap === undefined) byChunk.set(chunkKey, codec.fromValues(rems));
      else existingBitmap.addMany(rems);
      rems.length = 0;
      const pause = tickChunk();
      if (pause !== null) await pause;
    }
    pending = 0;
  };
  /** Bucket one id. Returns true when the pending buffer is full and must be flushed. */
  const ingest = (id: number): boolean => {
    const { chunkKey, remainder } = splitId(id); // validates the u32 range
    let bucket = pendingByChunk.get(chunkKey);
    if (bucket === undefined) {
      bucket = [];
      pendingByChunk.set(chunkKey, bucket);
    }
    bucket.push(remainder);
    return ++pending >= BULK_FLUSH_IDS;
  };
  // The two ingest loops are deliberately NOT collapsed into one `for await` over a normalising wrapper.
  //
  // That is the tidier code and it was measured at **20x** the cost: routing a sync source through an async
  // generator forces a microtask per id, and over 1M ids that is 224 ms against 11 ms for a plain `for..of` —
  // 55% of a whole bulk load spent on iteration protocol rather than on work. Since an array, a Set and a
  // generator are what callers actually hand this function most of the time, the sync path is the common one.
  //
  // Note that `for await` yields nothing to the event loop either way: a microtask per id still drains before
  // the loop turns a phase. Both paths therefore need the same explicit yield.
  if (Symbol.asyncIterator in ids) {
    for await (const id of ids as AsyncIterable<number>) {
      if (ingest(id)) await flushPending();
      const pause = tickId();
      if (pause !== null) await pause;
    }
  } else {
    for (const id of ids as Iterable<number>) {
      if (ingest(id)) await flushPending();
      const pause = tickId();
      if (pause !== null) await pause;
    }
  }
  await flushPending();

  // Every chunk in the map received at least one id, so no bitmap here is empty.
  return [...byChunk]
    .map(([chunkKey, bitmap]) => ({ chunkKey, bitmap }))
    .sort((a, b) => a.chunkKey - b.chunkKey);
}
