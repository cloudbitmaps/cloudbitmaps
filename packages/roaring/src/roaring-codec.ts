/**
 * SafeBitmap — the thin wrapper around the `roaring` (CRoaring) engine that owns the
 * untrusted-bytes boundary.
 *
 * All (de)serialization uses the **portable** format — the stable, bounds-checked one. The
 * `unsafe_frozen_*` formats are never used (they are explicitly documented as crash/attack
 * vectors). Every deserialize is preceded by a hard size cap and a structural check, because the native
 * portable deserializer bounds its reads and checks nothing else (see `portable/layout.ts`).
 */
// `roaring` is a CommonJS native addon. A *named* ESM import (`import { RoaringBitmap32 } from 'roaring'`)
// crashes Node's ESM loader — its static lexer can't see the CJS module's exports — so we take the runtime
// values off the module's default export (Node maps a CJS module's `module.exports` to `default`). This
// keeps the shipped ESM bundle importable under Node ESM. The instance type is derived from the value so we
// still get a `RoaringBitmap32` type without a (conflicting) second import.
import roaring from 'roaring';
import type {
  CodecBitmap,
  CodecInterface,
  EncodedChunk,
  LoadInput,
  PortableBitmap,
} from '@cloudbitmaps/core';
import { IntegrityError, decodeSerialized } from '@cloudbitmaps/core';
import { checkPortableLayout, containerPayloads } from './portable/layout';

const { RoaringBitmap32, SerializationFormat, DeserializationFormat } = roaring;
type RoaringBitmap32 = InstanceType<typeof RoaringBitmap32>;

export class SafeBitmap implements CodecBitmap {
  private readonly bitmap: RoaringBitmap32;

  private constructor(bitmap: RoaringBitmap32) {
    this.bitmap = bitmap;
  }

  static empty(): SafeBitmap {
    return new SafeBitmap(new RoaringBitmap32());
  }

  static fromValues(values: Iterable<number>): SafeBitmap {
    return new SafeBitmap(new RoaringBitmap32(values));
  }

  /**
   * Cap the size, check the structure, then deserialize with the **portable** format.
   * Throws `IntegrityError` if the input exceeds `maxBytes`, is not a well-formed portable bitmap, or fails to
   * decode — the native addon is never handed unbounded, malformed or unsafe-format input. With `whole`, bytes
   * after the bitmap's last container are refused too; without it they are ignored, as the native decoder ignores
   * them.
   *
   * The structural check is what makes the decoded bitmap's answers mean anything. The native deserializer
   * bounds its reads and checks nothing else, so bytes of the right length and the wrong shape (containers or
   * values out of order, overlapping runs, a cardinality that disagrees with the bits) decode into a bitmap
   * whose `maximum()`, `has()` and `size` are wrong, and some of those shapes crash the process when used.
   */
  static safeDeserialize(
    bytes: Uint8Array,
    maxBytes: number,
    options: { readonly whole?: boolean } = {},
  ): SafeBitmap {
    if (bytes.length > maxBytes) {
      throw new IntegrityError(`serialized bitmap is ${bytes.length}B, exceeds cap ${maxBytes}B`);
    }
    const end = checkPortableLayout(bytes);
    if (options.whole === true && end !== bytes.byteLength) {
      throw new IntegrityError(
        `portable roaring: ${bytes.byteLength - end} bytes follow the bitmap's last container, which ends at ` +
          `byte ${end}. One buffer holds one bitmap: to load several as one segment, combine them first ` +
          `(RoaringBitmap32.orMany) and serialize the result.`,
      );
    }
    try {
      return new SafeBitmap(RoaringBitmap32.deserialize(bytes, DeserializationFormat.portable));
    } catch (err) {
      throw new IntegrityError(`failed to deserialize bitmap: ${(err as Error).message}`);
    }
  }

  /** The `roaring` bitmap this wraps, for a caller that was handed it once and keeps no wrapper. */
  unwrap(): RoaringBitmap32 {
    return this.bitmap;
  }

  serialize(): Uint8Array {
    return this.bitmap.serialize(SerializationFormat.portable);
  }

  /**
   * Convert containers to run-encoding where that is smaller. Representation only — membership is untouched, and
   * the portable format still round-trips through {@link RoaringCodec.safeDeserialize}.
   *
   * Roaring's third container type is a RUN, and no implementation selects it on its own: it takes an explicit
   * `runOptimize()` pass. Nothing here made that call, so run-shaped ids paid array or bitset prices — measured
   * at **570×** for a contiguous 1M-id range (128.1 KiB → 0.2 KiB) and **63×** for a 2,000-run shape
   * (536.5 KiB → 8.5 KiB). Sparse ids come out byte-identical, so this is never a losing trade; roaring keeps
   * whichever encoding is smaller per container.
   *
   * Those two factors are THIS CALL's own before/after on the same ids. They are not the ones the site quotes
   * (543× and 63×) — those compare the optimized encoding against the best *fixed* representation at its floor,
   * a different baseline that happens to land near 63× on the run shape too. `pnpm bench:encoding` prints both
   * columns; don't carry a figure between them without checking which denominator it had.
   *
   * Called only when writing an immutable objects generation — see {@link CodecBitmap.optimize} for why the read
   * path deliberately does not.
   *
   * CANONICAL, which `runOptimize()` alone is not. Where a container's run and array encodings are the same size
   * (cardinality = 2 × runs + 1: three values in one run, five in two), CRoaring keeps whichever kind the
   * container already has. A chunk built from ids starts as an array and stays one; the same set reached through
   * `addRange`, an earlier `runOptimize()` or an operation over run containers is a run, and serializes to other
   * bytes. Undoing run compression first starts every container where one built from ids starts, so the bytes
   * depend on membership alone. On a bitmap built from ids there is nothing to undo.
   */
  optimize(): void {
    this.bitmap.removeRunCompression();
    this.bitmap.runOptimize();
  }

  /**
   * This set as storage chunks, cut from its own containers: {@link optimize} and one `serialize` when called, then
   * a lazy header walk that copies one container out per step (`containerPayloads`). Per container and per byte,
   * never per id, and the payloads are the ones {@link SafeBitmap.fromValues} of each chunk's low 16 bits would
   * serialize to. The walk trusts the bytes it cuts because the native serializer wrote them, from a bitmap that
   * passed the structural check when it was decoded.
   */
  encodeChunks(): Iterable<EncodedChunk> {
    this.optimize();
    return containerPayloads(this.serialize());
  }

  /**
   * Largest value, or `undefined` when empty. O(1) — roaring reads it off the last container, so the engine's
   * per-chunk range assertion costs one call per chunk rather than a walk per id. The last container holds the
   * largest value only because {@link SafeBitmap.safeDeserialize} refuses bytes whose containers or values are
   * out of order.
   */
  maximum(): number | undefined {
    return this.bitmap.isEmpty ? undefined : this.bitmap.maximum();
  }

  add(value: number): void {
    this.bitmap.add(value);
  }

  addMany(values: Iterable<number>): void {
    this.bitmap.addMany(values);
  }

  remove(value: number): void {
    this.bitmap.remove(value);
  }

  removeMany(values: Iterable<number>): void {
    this.bitmap.removeMany(values);
  }

  has(value: number): boolean {
    return this.bitmap.has(value);
  }

  get size(): number {
    return this.bitmap.size;
  }

  get isEmpty(): boolean {
    return this.bitmap.isEmpty;
  }

  clone(): SafeBitmap {
    return new SafeBitmap(this.bitmap.clone());
  }

  // The binary set ops take the `CodecBitmap` interface type (per the seam), but a single store is
  // single-codec (homogeneity contract), so `other` is always a `SafeBitmap` here — reach its private
  // `bitmap` (accessible on same-class instances) for the native op.
  /** In-place union: `this = this ∪ other`. */
  orInPlace(other: CodecBitmap): void {
    this.bitmap.orInPlace((other as SafeBitmap).bitmap);
  }

  /** In-place difference: `this = this \ other`. */
  andNotInPlace(other: CodecBitmap): void {
    this.bitmap.andNotInPlace((other as SafeBitmap).bitmap);
  }

  /** In-place intersection: `this = this ∩ other`. */
  andInPlace(other: CodecBitmap): void {
    this.bitmap.andInPlace((other as SafeBitmap).bitmap);
  }

  /** Ascending iterator over the set values. */
  [Symbol.iterator](): IterableIterator<number> {
    return this.bitmap[Symbol.iterator]();
  }

  toArray(): number[] {
    return this.bitmap.toArray();
  }

  /** The values as one fresh ascending `Uint32Array`, exported natively. */
  toUint32Array(): Uint32Array {
    return this.bitmap.toUint32Array();
  }
}

/**
 * A bare `RoaringBitmap32` of this package's own `roaring`, passed where ids go, loads as `{ bitmap }`: from its
 * containers, through the same check as any bytes, never id by id. Any other input passes through unchanged, and a
 * bitmap from another copy of `roaring` is loaded as the ids it iterates, which is correct and slower.
 */
export function bitmapAsLoadInput(input: LoadInput): LoadInput {
  return input instanceof RoaringBitmap32 ? { bitmap: input as PortableBitmap } : input;
}

/**
 * The roaring {@link CodecInterface} — the flagship codec, delegating to {@link SafeBitmap}'s statics. This is
 * the default the `CloudRoaring` facade injects into the engine; `core/` itself never hard-references it once a
 * caller supplies a codec.
 */
export const roaringCodec: CodecInterface = {
  empty: () => SafeBitmap.empty(),
  fromValues: (values) => SafeBitmap.fromValues(values),
  safeDeserialize: (bytes, maxBytes, options) =>
    SafeBitmap.safeDeserialize(bytes, maxBytes, options),
  owns: (bitmap) => bitmap instanceof SafeBitmap,
};

/**
 * Decode portable Roaring bytes you hold into a `RoaringBitmap32`, through the check a `{ serialized }` load makes
 * first: a size cap, a structural check, one whole bitmap, and only then the native decoder.
 *
 * @param bytes a `Uint8Array`, which a Node `Buffer` is.
 * @throws {ValidationError} for bytes that are not exactly one well-formed portable bitmap, as a load refuses them.
 */
export function deserializePortable(bytes: Uint8Array): RoaringBitmap32 {
  return (decodeSerialized(bytes, roaringCodec) as SafeBitmap).unwrap();
}
