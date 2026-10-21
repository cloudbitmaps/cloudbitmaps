/**
 * The codec selection point and the load-input and decode helpers the `CloudRoaring` facade builds on.
 *
 * The store's codec is the TypeScript Roaring codec (`ts-roaring/bitmap.ts`): the portable format, read and written in
 * JavaScript with no native addon. Every deserialize is preceded by a hard size cap and a structural check
 * (`portable/layout.ts`). The `unsafe_frozen_*` formats are never used.
 */
import type { CodecInterface, CodecBitmap, LoadInput, PortableBitmap } from '@cloudbitmaps/core';
import { ValidationError, decodeSerialized } from '@cloudbitmaps/core';
import { tsRoaringCodec } from './ts-roaring/bitmap';

/**
 * Whatever serializes itself to portable Roaring (an object with a `serialize` method: a caller's `RoaringBitmap32`
 * from the `roaring` package, or a bitmap {@link deserializePortable} returned), passed where ids go, loads as
 * `{ bitmap }`: from its containers, through the same check as any bytes, never id by id. Any other input passes
 * through unchanged. An object with its own `serialize` that is also iterable is serialized, not iterated.
 */
export function bitmapAsLoadInput(input: LoadInput): LoadInput {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { serialize?: unknown }).serialize === 'function'
    ? { bitmap: input as unknown as PortableBitmap }
    : input;
}

let activeCodec: CodecInterface = tsRoaringCodec;

/**
 * The codec the store hands to the engine at every site that injects one (`CloudRoaring`, a load, a pin, an export
 * and {@link deserializePortable}): the TypeScript codec unless a harness has flipped it with {@link setFlagshipCodec}.
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

/**
 * A decoded bitmap that can only be read: what {@link deserializePortable} returns. Its ids come out ascending when
 * it is iterated, which is a promise. It is a `PortableBitmap`, so a load takes it as `{ bitmap }`, and the library
 * keeps no reference to it. What {@link deserializePortable} returns has these members only: a call to any other
 * throws `TypeError`, it has no `getSerializationSizeInBytes`, and `serialize` takes exactly `'portable'`. Its class
 * is not part of the contract: do not cast it and do not test it with `instanceof`. Passed to a method of the `roaring`
 * package from npm in place of a `RoaringBitmap32`, it answers wrongly: decode its bytes first. `JSON.stringify` of one gives `"{}"`; write
 * `JSON.stringify([...bitmap])`. For the rest of a Roaring library's API, decode its portable bytes with that library.
 */
export interface ReadonlyBitmap extends PortableBitmap, Iterable<number> {
  /** How many ids it holds. */
  readonly size: number;
  /** Whether it holds `id`. */
  has(id: number): boolean;
}

/**
 * What {@link deserializePortable} returns: a decoded bitmap with four of the members of {@link ReadonlyBitmap} and
 * nothing else (the type's optional `getSerializationSizeInBytes` is absent), so a call written for a
 * `RoaringBitmap32` (`add`, `andInPlace`, `toArray`, …) throws `TypeError` rather than changing the bitmap or
 * answering wrongly. The decoded bitmap sits in a private field. It is not exported from the package.
 */
class ReadonlyRoaringView implements ReadonlyBitmap {
  readonly #bitmap: CodecBitmap;

  constructor(bitmap: CodecBitmap) {
    this.#bitmap = bitmap;
  }

  get size(): number {
    return this.#bitmap.size;
  }

  has(id: number): boolean {
    return this.#bitmap.has(id);
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.#bitmap[Symbol.iterator]();
  }

  /** The portable bytes, for exactly the argument `'portable'`; any other call is a `ValidationError`. */
  serialize(...args: unknown[]): Uint8Array {
    if (args.length !== 1 || args[0] !== 'portable') {
      const got =
        args.length === 0
          ? 'no argument'
          : args.map((a) => (typeof a === 'string' ? `'${a}'` : typeof a)).join(', ');
      throw new ValidationError(
        `a decoded bitmap serializes only as serialize('portable'); got ${got}`,
      );
    }
    return this.#bitmap.serialize();
  }
}

/**
 * Decode portable Roaring bytes you hold into a {@link ReadonlyBitmap}, through the check a `{ serialized }` load
 * makes first: a size cap, a structural check, one whole bitmap, and only then the decoder.
 *
 * @param bytes a `Uint8Array`, which a Node `Buffer` is.
 * @throws {ValidationError} for bytes that are not exactly one well-formed portable bitmap, as a load refuses them.
 */
export function deserializePortable(bytes: Uint8Array): ReadonlyBitmap {
  return new ReadonlyRoaringView(decodeSerialized(bytes, flagshipCodec()));
}
