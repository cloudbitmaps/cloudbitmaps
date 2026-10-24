/**
 * The codec selection point and the load-input and decode helpers the `CloudRoaring` facade builds on.
 *
 * The store's codec is the TypeScript Roaring codec (`ts-roaring/bitmap.ts`): the portable format, read and written in
 * JavaScript with no native addon. Every deserialize is preceded by a hard size cap and a structural check
 * (`portable/layout.ts`). The `unsafe_frozen_*` formats are never used.
 */
import type { CodecInterface, LoadInput, PortableBitmap } from '@cloudbitmaps/core';
import { tsRoaringCodec } from './ts-roaring/bitmap';

/**
 * An iterable that serializes itself to portable Roaring (an object with `Symbol.iterator` and a `serialize` method: a
 * caller's `RoaringBitmap32` from the `roaring` package, another copy's bitmap, or a `RoaringBitmap` of this
 * package), passed where ids go, loads as `{ bitmap }`: from its containers, through the same check as any bytes,
 * never id by id. Its `serialize` decides, even where it disagrees with what it iterates. Any other input passes
 * through unchanged, so the core's own rules apply to it: a byte array (`Uint8Array`, `Buffer`) is refused as ids even
 * with a `serialize` of its own, and an object that is not iterable is read as `{ serialized }` or `{ bitmap }` or
 * refused, whatever else it has.
 */
export function bitmapAsLoadInput(input: LoadInput): LoadInput {
  if (typeof input !== 'object' || input === null) return input;
  const tag = Object.prototype.toString.call(input).slice(8, -1);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') return input;
  return Symbol.iterator in input &&
    typeof (input as { serialize?: unknown }).serialize === 'function'
    ? { bitmap: input as unknown as PortableBitmap }
    : input;
}

let activeCodec: CodecInterface = tsRoaringCodec;

/**
 * The codec the store hands to the engine at every site that injects one (`CloudRoaring`, a load, a pin and an export): the TypeScript codec unless a harness has flipped it with {@link setFlagshipCodec}.
 * Internal: no public entry exports it, and a store cannot be configured with a codec.
 */
export function flagshipCodec(): CodecInterface {
  return activeCodec;
}

/** Flip the codec the store uses, for the whole process. Test and bench harnesses only; returns the previous one. */
export function setFlagshipCodec(codec: CodecInterface): CodecInterface {
  const previous = activeCodec;
  activeCodec = codec;
  return previous;
}
