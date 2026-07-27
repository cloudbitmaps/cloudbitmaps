/**
 * SafeBitmap — the thin wrapper around the `roaring` (CRoaring) engine that owns the
 * untrusted-bytes boundary (finding S1).
 *
 * All (de)serialization uses the **portable** format — the stable, validated one. The
 * `unsafe_frozen_*` formats are never used (they are explicitly documented as crash/attack
 * vectors). Every deserialize is preceded by a hard size cap.
 */
// `roaring` is a CommonJS native addon. A *named* ESM import (`import { RoaringBitmap32 } from 'roaring'`)
// crashes Node's ESM loader — its static lexer can't see the CJS module's exports — so we take the runtime
// values off the module's default export (Node maps a CJS module's `module.exports` to `default`). This
// keeps the shipped ESM bundle importable under Node ESM. The instance type is derived from the value so we
// still get a `RoaringBitmap32` type without a (conflicting) second import.
import roaring from 'roaring';
import type { CodecBitmap, CodecInterface } from '@cloudbitmaps/core';
import { IntegrityError } from '@cloudbitmaps/core';

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
   * S1: validate size, then deserialize with the **portable** (validated) format.
   * Throws `IntegrityError` if the input exceeds `maxBytes` or fails to decode — the
   * native addon is never handed unbounded or unsafe-format input.
   */
  static safeDeserialize(bytes: Uint8Array, maxBytes: number): SafeBitmap {
    if (bytes.length > maxBytes) {
      throw new IntegrityError(`serialized bitmap is ${bytes.length}B, exceeds cap ${maxBytes}B`);
    }
    try {
      return new SafeBitmap(RoaringBitmap32.deserialize(bytes, DeserializationFormat.portable));
    } catch (err) {
      throw new IntegrityError(`failed to deserialize bitmap: ${(err as Error).message}`);
    }
  }

  serialize(): Uint8Array {
    return this.bitmap.serialize(SerializationFormat.portable);
  }

  /**
   * Largest value, or `undefined` when empty. O(1) — roaring reads it off the container index, so the engine's
   * per-chunk range assertion costs one call per chunk rather than a walk per id.
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
}

/**
 * The roaring {@link CodecInterface} — the flagship codec, delegating to {@link SafeBitmap}'s statics. This is
 * the default the `CloudRoaring` facade injects into the engine; `core/` itself never hard-references it once a
 * caller supplies a codec. Moves to `@cloudbitmaps/roaring` when the package split lands ([DECISIONS #58]).
 */
export const roaringCodec: CodecInterface = {
  empty: () => SafeBitmap.empty(),
  fromValues: (values) => SafeBitmap.fromValues(values),
  safeDeserialize: (bytes, maxBytes) => SafeBitmap.safeDeserialize(bytes, maxBytes),
};
