/**
 * Writing one immutable `.crbm` generation: from in-memory bitmaps, from already-encoded chunks, or streamed.
 */
import { IntegrityError, ValidationError } from './errors';
import type { Entropy } from './determinism';
import { yieldEvery } from './cooperative';
import type { Yielder } from './cooperative';
import type { CrbmCrypto } from './crypto';
import type { GenerationMetadata, GenKey, IStorageDriver } from './ports';
import { fingerprintFor } from './crbm/fingerprint';
import { CrbmWriter } from './crbm/writer';
import type { CodecBitmap, EncodedChunk } from './codec';

/**
 * What every writer of a generation takes. `entropy` is required: it is the source of the write's identity (a
 * cleartext generation's footer nonce, see `CrbmWriter`'s `entropy`), and a call that could leave it out would
 * write an object no different from any other writer's of the same ids.
 */
export interface WriteOptions {
  readonly crypto?: CrbmCrypto;
  readonly clock?: Yielder;
  readonly metadata?: GenerationMetadata;
  readonly entropy: Entropy;
}

/**
 * The entropy a write was given, or a {@link ValidationError} naming the verb that has none. Checked where a write
 * begins, before any id is read or object put, so a caller wired without a source fails at once instead of writing a
 * generation with no identity.
 */
export function requireEntropy(entropy: Entropy | undefined, verb: string): Entropy {
  if (typeof entropy !== 'function') {
    throw new ValidationError(
      `${verb} needs an entropy source (\`entropy\`): the footer of every generation it writes carries 12 random bytes of the write's identity`,
    );
  }
  return entropy;
}

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
  options: WriteOptions,
): Promise<{ size: number; sha256: string; fingerprint: string; tailBytes: number }> {
  const sorted = [...chunks].sort((a, b) => a.chunkKey - b.chunkKey);
  const { size, sha256, fingerprint, tailBytes } = await writeEncodedChunks(
    driver,
    key,
    encodeEach(sorted),
    options,
  );
  return { size, sha256, fingerprint, tailBytes };
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
  options: WriteOptions,
): Promise<{
  size: number;
  sha256: string;
  chunkCount: number;
  cardinality: number;
  fingerprint: string;
  /** The bytes after the chunk payloads ({@link CrbmReader.tailBytes}). */
  tailBytes: number;
}> {
  // The single longest blocking stretch in a bulk load: serialize + CRC32C + frame, once per chunk, ~62,000
  // times. `await writer.addChunk(...)` looks like it yields and does not — the sink buffers in memory, so the
  // promise is already resolved and awaiting it is a microtask. See {@link yieldEvery}.
  const tick = yieldEvery(options.clock);
  let chunkCount = 0;
  let cardinality = 0;
  let identity: CrbmWriter['identity'] | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
      entropy: options.entropy,
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
    tailBytes: identity.tailBytes,
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
  /** The bytes after the chunk payloads ({@link CrbmReader.tailBytes}). */
  readonly tailBytes: number;
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
  options: WriteOptions,
): Promise<StreamWriteResult> {
  const chunkKeys: number[] = [];
  let cardinality = 0;
  // A rewrite runs this over a whole segment. The `for await` is not itself a yield — a stream backed by
  // already-resident chunks resolves on a microtask — so it needs the same periodic macrotask as the
  // non-streaming writer above.
  const tick = yieldEvery(options.clock);
  let identity: CrbmWriter['identity'] | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
      entropy: options.entropy,
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
    tailBytes: identity.tailBytes,
  };
}
