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
import { ValidationError, isIntegrityError } from './errors';

/**
 * Anything that serializes itself to portable Roaring: `roaring`'s `RoaringBitmap32` is one. Typed by shape, so
 * no codec's own class appears in a signature.
 */
export interface PortableBitmap {
  serialize(format: 'portable'): Uint8Array;
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
 * The largest portable serialization a canonical 32-bit Roaring bitmap can have: every one of the 65,536
 * containers a full bitset, behind an 8-byte header and 8 bytes of header per container. About 512.5 MiB.
 */
export const MAX_SERIALIZED_LOAD_BYTES = 8 + 65_536 * (8 + 8_192);

/** A bitmap input, decoded into the codec's own bitmap: written from its chunks, never id by id. */
export class DecodedLoadInput {
  constructor(readonly bitmap: CodecBitmap) {}
}

/** `Object.prototype.toString`'s tag, which names a typed array's kind across realms and for `Buffer` too. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * Check a load's input and decode a bitmap input, before the load makes any request.
 *
 * @returns ids unchanged, to be consumed lazily by the write, or the decoded bitmap.
 * @throws {ValidationError} for a byte array passed as ids, malformed or oversized bytes, a `{ bitmap }` without a
 * working `serialize('portable')`, and anything that is none of the three inputs.
 */
export function prepareLoadInput(
  input: LoadInput,
  codec: CodecInterface,
): Iterable<number> | AsyncIterable<number> | DecodedLoadInput {
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
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'serialized') {
    return decode((input as { serialized: unknown }).serialized, '{ serialized }', codec);
  }
  if (keys.length === 1 && keys[0] === 'bitmap') {
    const bitmap = (input as { bitmap: unknown }).bitmap as Partial<PortableBitmap> | null;
    if (typeof bitmap !== 'object' || bitmap === null || typeof bitmap.serialize !== 'function') {
      throw new ValidationError(`{ bitmap } needs an object with serialize('portable')`);
    }
    return decode(bitmap.serialize('portable'), "{ bitmap }'s serialize('portable')", codec);
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
  const length = (bytes as Uint8Array).byteLength;
  if (length > MAX_SERIALIZED_LOAD_BYTES) {
    throw new ValidationError(
      `${what} is ${length} bytes, over the ${MAX_SERIALIZED_LOAD_BYTES} a 32-bit bitmap's canonical ` +
        `encoding can take. Call runOptimize() on the bitmap before serializing it.`,
    );
  }
  try {
    return new DecodedLoadInput(
      codec.safeDeserialize(bytes as Uint8Array, MAX_SERIALIZED_LOAD_BYTES),
    );
  } catch (err) {
    // The codec reports bytes it refuses as corrupt; here they are the caller's input, not a stored object.
    if (!isIntegrityError(err)) throw err;
    throw new ValidationError(`${what} is not a valid bitmap: ${(err as Error).message}`);
  }
}
