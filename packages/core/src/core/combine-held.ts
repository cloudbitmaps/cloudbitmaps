/**
 * An operand held in memory, for a batch combine: ids checked and encoded as a load checks and encodes them, then kept
 * as the per-chunk payload bytes a stored generation would hold. Pure: it knows no store and no storage.
 *
 * ```
 * input   ids | { bitmap } | { serialized }
 *   check    what a load checks: the size cap, the structure, the safe deserializer and each id's range; only a real
 *            Uint32Array skips the per-id range check, by a brand a spoof cannot carry
 *   encode   the load's own encoder, so a chunk is the bytes a load would store
 * held    keys, cardinalities and one payload per chunk, read by the pass as a stored operand's chunks are
 * ```
 */
import type { CodecInterface, EncodedChunk } from './codec';
import { plainUint32 } from './combine-feed';
import { assertChunkCardinalityInRange } from './chunk-checks';
import { MAX_REMAINDER } from './bit-route';
import { encodedChunksOfInput } from './crbm-storage-source';
import { yieldEvery } from './cooperative';
import type { Clock } from './determinism';
import { ValidationError } from './errors';
import { DecodedLoadInput, prepareLoadInput } from './load-input';
import type { LoadInput } from './load-input';

/** What each chunk costs beside its payload: the object, its key and its cardinality. */
const PER_CHUNK_BYTES = 96;

/** A held operand's chunks: ascending keys, each with its exact cardinality and its payload bytes. */
export class HeldChunks {
  /** The chunk keys, ascending. */
  readonly keys: Uint16Array;
  /** How many ids each chunk holds. */
  readonly cardinalities: Uint32Array;
  /** What it holds in memory, for a call's resident-bytes ledger. */
  readonly residentBytes: number;
  private payloads: Uint8Array[] | undefined;

  constructor(chunks: Iterable<EncodedChunk>) {
    const keys: number[] = [];
    const cards: number[] = [];
    const payloads: Uint8Array[] = [];
    let bytes = 0;
    let last = -1;
    for (const chunk of chunks) {
      const { chunkKey, payload, cardinality } = chunk;
      if (
        !Number.isInteger(chunkKey) ||
        chunkKey < 0 ||
        chunkKey > MAX_REMAINDER ||
        chunkKey <= last
      ) {
        throw new ValidationError(
          `a held chunk's key must be an integer in [0, 65535] above the last; got ${String(chunkKey)}`,
        );
      }
      assertChunkCardinalityInRange(cardinality);
      last = chunkKey;
      keys.push(chunkKey);
      cards.push(cardinality);
      payloads.push(payload);
      bytes += payload.byteLength + PER_CHUNK_BYTES;
    }
    this.keys = Uint16Array.from(keys);
    this.cardinalities = Uint32Array.from(cards);
    this.payloads = payloads;
    this.residentBytes = bytes;
  }

  /** Whether it holds no id. */
  get empty(): boolean {
    return this.keys.length === 0;
  }

  /** Whether {@link release} ran. */
  get released(): boolean {
    return this.payloads === undefined;
  }

  /**
   * The payload of the chunk at `key`, `null` when it holds none there. A view into what is held: not to be written to.
   * @throws {ValidationError} once released.
   */
  payload(key: number): Uint8Array | null {
    const payloads = this.payloads;
    if (payloads === undefined) {
      throw new ValidationError(
        'this memory operand was released: make another with store.memory()',
      );
    }
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.keys[mid]!;
      if (at === key) return payloads[mid]!;
      if (at < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Zero and drop the bytes. Every later read throws; a second call does nothing. */
  release(): void {
    const payloads = this.payloads;
    if (payloads === undefined) return;
    this.payloads = undefined;
    for (const payload of payloads) payload.fill(0);
  }
}

/**
 * Check a held operand's input as a load checks it, and hold its chunks.
 *
 * @throws {ValidationError} where a load of the same input would, and for an object with an `ascending` key, which
 * belongs to a feed.
 */
export async function prepareHeld(
  input: unknown,
  codec: CodecInterface,
  clock: Clock | undefined,
): Promise<HeldChunks> {
  if (
    typeof input === 'object' &&
    input !== null &&
    !(Symbol.iterator in input) &&
    !(Symbol.asyncIterator in input) &&
    Object.prototype.hasOwnProperty.call(input, 'ascending')
  ) {
    throw new ValidationError(
      'a memory operand takes ids, { serialized } or { bitmap }, with no `ascending` option: ids that arrive in ' +
        'chunk-key order, one key at a time, are a feed of materializeMany',
    );
  }
  const real = plainUint32(input);
  if (real === 'detached') {
    throw new ValidationError("a memory operand's ids are a Uint32Array over a detached buffer");
  }
  if (real === 'out of bounds') {
    throw new ValidationError(
      "a memory operand's ids are a resizable-buffer Uint32Array whose view is out of bounds",
    );
  }
  // A real Uint32Array holds only values in range, so the codec reads it whole; anything else goes id by id.
  const prepared =
    real !== undefined
      ? new DecodedLoadInput(codec.fromValues(real))
      : prepareLoadInput(input as LoadInput, codec, 'a memory operand');
  const encoded = await encodedChunksOfInput(prepared, codec, clock);
  const tick = yieldEvery(clock, 256);
  const chunks: EncodedChunk[] = [];
  for (const chunk of encoded) {
    chunks.push(chunk);
    const pause = tick();
    if (pause !== null) await pause;
  }
  return new HeldChunks(chunks);
}
