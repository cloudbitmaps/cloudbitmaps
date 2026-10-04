/**
 * What a load accepts: ids, or a whole bitmap as `{ serialized }` bytes or as a `{ bitmap }` that serializes to
 * them.
 *
 * Every bitmap input takes one path. The bytes are size-capped, checked structurally and decoded by the codec's
 * safe deserializer into a bitmap of the codec's own, which then writes its chunks straight from its containers:
 * no id passes through JavaScript. `{ bitmap }` is only a spelling of `{ serialized }`, serialized once, here, so
 * a caller's bitmap is never trusted as a structure and a change made to it after the call is not loaded.
 *
 * All of it runs before the load's first request, so a malformed input costs no round trip and writes nothing.
 */
import type { CodecBitmap, CodecInterface } from './codec';
import type { CombinedChunk } from './engine';
import { ValidationError, isIntegrityError } from './errors';

/**
 * Anything that serializes itself to portable Roaring: `roaring`'s `RoaringBitmap32` is one. Typed by shape, so
 * no codec's own class appears in a signature. A bitmap that can also say how large its serialization is
 * (`getSerializationSizeInBytes`) is asked first, so one over the cap is refused before it is serialized.
 */
export interface PortableBitmap {
  serialize(format: 'portable'): Uint8Array;
  getSerializationSizeInBytes?(format: 'portable'): number;
}

/**
 * What a load writes as the segment's new contents.
 *
 * - **ids**: an iterable or async iterable of integers in `[0, 2^32)`, consumed lazily. Not a `Uint8Array`,
 *   `Uint8ClampedArray` or `Buffer`, which a load refuses, since each byte would load as an id.
 * - **`{ serialized }`**: one bitmap in the portable Roaring format, checked before anything is written.
 * - **`{ bitmap }`**: an object with `serialize('portable')`, loaded as `{ serialized: bitmap.serialize('portable') }`.
 */
export type LoadInput =
  | Iterable<number>
  | AsyncIterable<number>
  | { readonly serialized: Uint8Array }
  | { readonly bitmap: PortableBitmap };

/**
 * No canonical 32-bit Roaring bitmap serializes to more than this. Under the run cookie, the larger of the two
 * headers, it is a 4-byte cookie, 8,192 bytes of run flags and 8 bytes of header for each of the 65,536
 * containers, and no container's body is over 8,192 bytes: a bitset is 8,192, and a run container is kept only
 * where it is smaller. 537,403,396 bytes, about 512.5 MiB.
 */
export const MAX_SERIALIZED_LOAD_BYTES = 4 + 8_192 + 8 * 65_536 + 65_536 * 8_192;

/** A bitmap input, decoded into the codec's own bitmap: written from its chunks, never id by id. */
export class DecodedLoadInput {
  constructor(readonly bitmap: CodecBitmap) {}
}

/**
 * The brand a flavor puts on an object to hand a load the chunks of a combine's result, in place of ids:
 * `{ [Symbol.for(CHUNK_INPUT_BRAND)]: AsyncIterable<{ chunkKey, bitmap }> }`. A registered symbol, so it names the
 * input without core exporting anything: `loadSegment`'s public input type is unchanged, and so is its entry.
 *
 * Whoever holds the object can pass any chunks, so the load checks every one as it does an id's chunk: the key,
 * the order, the values and the size ({@link collectChunks}).
 */
export const CHUNK_INPUT_BRAND = 'cloudbitmaps.load-input.chunks';

/** A combine's result as the bitmaps of its chunks, ascending by key: written as they are, never id by id. */
export class ChunkLoadInput {
  constructor(readonly chunks: AsyncIterable<CombinedChunk>) {}
}

/** `Object.prototype.toString`'s tag, which names a typed array's kind across realms and for `Buffer` too. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/** The typed arrays' own accessors, which read the view itself whatever a subclass or another realm defines. */
const VIEW = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewGetter = (name: 'buffer' | 'byteOffset' | 'byteLength'): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(VIEW, name)?.get as (this: unknown) => unknown;
const bufferOf = viewGetter('buffer');
const byteOffsetOf = viewGetter('byteOffset');
const byteLengthOf = viewGetter('byteLength');

/**
 * The bytes a `Uint8Array` really holds, as a plain view the check and the decoder both read: never through a
 * getter a subclass overrides, so the two cannot be shown different bytes. A detached buffer holds none.
 */
function plainView(bytes: Uint8Array, what: string): Uint8Array {
  let buffer: ArrayBufferLike;
  let offset: number;
  let length: number;
  try {
    buffer = bufferOf.call(bytes) as ArrayBufferLike;
    offset = byteOffsetOf.call(bytes) as number;
    length = byteLengthOf.call(bytes) as number;
  } catch {
    throw new ValidationError(`${what} must be a Uint8Array of portable Roaring bytes`);
  }
  return length === 0 ? new Uint8Array(0) : new Uint8Array(buffer, offset, length);
}

/**
 * Whether `buffer` is a `SharedArrayBuffer`, by its brand: the type's own `byteLength` getter throws on anything
 * else, where a `Symbol.toStringTag` can be given any value. False on a runtime without one.
 */
const sharedByteLength =
  typeof SharedArrayBuffer === 'function'
    ? (Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as
        ((this: unknown) => unknown) | undefined)
    : undefined;
function isShared(buffer: ArrayBufferLike): boolean {
  if (sharedByteLength === undefined) return false;
  try {
    sharedByteLength.call(buffer);
    return true;
  } catch {
    return false;
  }
}

function overCap(what: string, length: number): ValidationError {
  return new ValidationError(
    `${what} is ${length} bytes, more than any canonical 32-bit bitmap serializes to ` +
      `(${MAX_SERIALIZED_LOAD_BYTES}). Call runOptimize() on the bitmap before serializing it.`,
  );
}

/**
 * Check a load's input and decode a bitmap input, before the load makes any request.
 *
 * @returns ids unchanged, to be consumed lazily by the write, or the decoded bitmap.
 * @throws {ValidationError} for a byte array passed as ids; bytes that are malformed, over the cap, or followed by
 * more bytes; a `{ bitmap }` with no `serialize` method, or whose `serialize('portable')` returns no `Uint8Array`;
 * and anything that is none of the three inputs. An error the caller's own `serialize` throws propagates as it is.
 */
export function prepareLoadInput(
  input: LoadInput,
  codec: CodecInterface,
): Iterable<number> | AsyncIterable<number> | DecodedLoadInput | ChunkLoadInput {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError(
      `a load takes ids, { serialized } or { bitmap }; got ${String(input)}`,
    );
  }
  const tag = tagOf(input);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') {
    throw new ValidationError(
      `a load's ids cannot be a ${tag} or Buffer: each byte would be loaded as an id. Pass portable Roaring ` +
        `bytes as { serialized }, and ids as a Uint32Array or an array of numbers.`,
    );
  }
  if (Symbol.iterator in input || Symbol.asyncIterator in input) return input;
  const chunks = (input as { [brand: symbol]: unknown })[Symbol.for(CHUNK_INPUT_BRAND)];
  if (chunks !== undefined) {
    if (typeof chunks !== 'object' || chunks === null || !(Symbol.asyncIterator in chunks)) {
      throw new ValidationError('a load takes chunks as an async iterable of { chunkKey, bitmap }');
    }
    return new ChunkLoadInput(chunks as AsyncIterable<CombinedChunk>);
  }
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'serialized') {
    return decode((input as { serialized: unknown }).serialized, '{ serialized }', codec);
  }
  if (keys.length === 1 && keys[0] === 'bitmap') {
    const bitmap = (input as { bitmap: unknown }).bitmap as Partial<PortableBitmap> | null;
    if (typeof bitmap !== 'object' || bitmap === null || typeof bitmap.serialize !== 'function') {
      throw new ValidationError(`{ bitmap } needs an object with serialize('portable')`);
    }
    const what = "{ bitmap }'s serialize('portable')";
    if (typeof bitmap.getSerializationSizeInBytes === 'function') {
      const size = bitmap.getSerializationSizeInBytes('portable');
      if (typeof size === 'number' && size > MAX_SERIALIZED_LOAD_BYTES) throw overCap(what, size);
    }
    return decode(bitmap.serialize('portable'), what, codec);
  }
  throw new ValidationError(
    `a load takes ids (an iterable of integers), { serialized } or { bitmap }, as the only key; got an object ` +
      `with keys [${keys.join(', ')}]. Load options go in the next argument.`,
  );
}

function decode(bytes: unknown, what: string, codec: CodecInterface): DecodedLoadInput {
  if (typeof bytes !== 'object' || bytes === null || tagOf(bytes) !== 'Uint8Array') {
    throw new ValidationError(`${what} must be a Uint8Array of portable Roaring bytes`);
  }
  const view = plainView(bytes as Uint8Array, what);
  if (view.byteLength > MAX_SERIALIZED_LOAD_BYTES) throw overCap(what, view.byteLength);
  // Bytes in a SharedArrayBuffer are copied: another thread could change them between the check and the decode.
  const own = isShared(view.buffer) ? new Uint8Array(view) : view;
  try {
    return new DecodedLoadInput(
      codec.safeDeserialize(own, MAX_SERIALIZED_LOAD_BYTES, { whole: true }),
    );
  } catch (err) {
    // The codec reports bytes it refuses as corrupt; here they are the caller's input, not a stored object.
    if (!isIntegrityError(err)) throw err;
    throw new ValidationError(`${what} is not a valid bitmap: ${(err as Error).message}`);
  }
}
