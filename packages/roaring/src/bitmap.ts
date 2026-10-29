/**
 * `RoaringBitmap`: a mutable set of unsigned 32-bit ids, in TypeScript on typed arrays, with no native addon. It is a
 * thin public shell around the codec's own bitmap (`ts-roaring/bitmap.ts`): the shell checks every argument (an id is
 * an integer from 0 to 4,294,967,295, and a refusal never repeats the value), and the codec does the work.
 *
 * ```ts
 * import { RoaringBitmap } from '@cloudbitmaps/roaring';
 *
 * const a = new RoaringBitmap([1, 5, 70_000]);
 * a.add(9).has(9); // true
 * const bytes = a.serialize();
 * RoaringBitmap.deserialize(bytes).size; // 4
 * ```
 *
 * The portable bytes are the codec's, so what `serialize()` writes a store loads and what a store holds,
 * `RoaringBitmap.deserialize` reads. Bytes you did not write go through `deserialize` only: it caps their size,
 * checks their structure and builds one whole bitmap whose storage is its own, so keeping it keeps no copy of the
 * input alive.
 */
import {
  MAX_SERIALIZED_LOAD_BYTES,
  ValidationError,
  decodeSerialized,
  refusalOfId,
} from '@cloudbitmaps/core';
import type { CodecInterface } from '@cloudbitmaps/core';
import { COUNT_BY_KERNELS } from './count-route';
import { checkOptions, kindOf, picked } from './options';
import { TsBitmap, collect, tsRoaringCodec } from './ts-roaring/bitmap';

/** What {@link RoaringBitmap.deserialize} takes as its second argument. */
export interface RoaringBitmapDeserializeOptions {
  /**
   * A cap on the input's size in bytes, lower than the one every decode has (537,403,396, the most any canonical
   * 32-bit bitmap serializes to). Bytes over it are refused before any is read. It can only lower the cap: a value
   * above it, or one that is not a non-negative integer, is a `ValidationError`.
   */
  readonly maxBytes?: number;
}

/** `Object.prototype.toString`'s tag, which names a typed array's kind across realms and for `Buffer` too. */
function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

const VIEW = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewGetter = (name: 'buffer'): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(VIEW, name)?.get as (this: unknown) => unknown;
const bufferOf = viewGetter('buffer');

const plainByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')
  ?.get as (this: unknown) => unknown;
const hasSharedMemory = typeof SharedArrayBuffer === 'function';

/**
 * Whether the typed array's memory may be a `SharedArrayBuffer`'s, by brand: another thread may write it while it is
 * read. `ArrayBuffer`'s own `byteLength` getter returns for a genuine `ArrayBuffer` (so ordinary memory costs no throw)
 * and throws for anything else, which is then treated as shared and copied; a `Symbol.toStringTag` can be given any
 * value, the brand cannot. False on a runtime without a `SharedArrayBuffer`.
 */
function inSharedMemory(ids: Uint32Array): boolean {
  if (!hasSharedMemory) return false;
  try {
    plainByteLength.call(bufferOf.call(ids));
    return false;
  } catch {
    return true;
  }
}

/** An id, or the refusal that names what is wrong with it and never repeats it. */
function checkedId(id: unknown): number {
  if (typeof id !== 'number' || id >>> 0 !== id) throw refusalOfId(id);
  return id;
}

function oneIdOnly(method: string, bulk: string): ValidationError {
  return new ValidationError(`${method} takes one id; use ${bulk} for several`);
}

/**
 * The ids to act on, as something the codec reads once and never keeps: a typed array that is, or may be, in shared memory is copied first
 * (it is read twice, to see whether it ascends and then to build, and another thread could write between the reads).
 *
 * @throws {ValidationError} for anything that is not an iterable of ids, and for bytes, which would read as ids.
 */
function idsOf(values: unknown): Iterable<number> {
  if (typeof values !== 'object' || values === null || !(Symbol.iterator in values)) {
    throw new ValidationError('values must be an iterable of ids');
  }
  const tag = tagOf(values);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') {
    throw new ValidationError(
      `values are ids, and this is a ${tag === 'Uint8Array' ? 'Uint8Array or Buffer' : tag}: each byte would be ` +
        `read as an id. To read portable bytes, call RoaringBitmap.deserialize(bytes).`,
    );
  }
  if (values instanceof Uint32Array && inSharedMemory(values)) return new Uint32Array(values);
  return values as Iterable<number>;
}

/** The codec with its decode detached: a decoded bitmap holds no view of the input's copy, and its slabs are bounded. */
const detachedCodec: CodecInterface = {
  ...tsRoaringCodec,
  safeDeserialize: (bytes, maxBytes, options) =>
    TsBitmap.safeDeserialize(bytes, maxBytes, { ...options, detached: true }),
};

function maxBytesOf(options: unknown): number {
  if (options === undefined) return MAX_SERIALIZED_LOAD_BYTES;
  if (typeof options !== 'object' || options === null) {
    throw new ValidationError(
      `deserialize takes no format argument, the format is always portable; its second argument is ` +
        `{ maxBytes } or nothing, not ${kindOf(options)}`,
    );
  }
  checkOptions(options, 'RoaringBitmap.deserialize', ['maxBytes']);
  const { maxBytes } = picked(options as RoaringBitmapDeserializeOptions | undefined, ['maxBytes']);
  if (maxBytes === undefined) return MAX_SERIALIZED_LOAD_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SERIALIZED_LOAD_BYTES) {
    throw new ValidationError(
      `maxBytes must be an integer from 0 to ${MAX_SERIALIZED_LOAD_BYTES}, the size no canonical bitmap exceeds`,
    );
  }
  return maxBytes;
}

/**
 * A mutable set of integers from 0 to 4,294,967,295 (unsigned 32-bit ids) with set algebra and the portable Roaring
 * serialization. It is not designed for subclassing, and `JSON.stringify` of one gives `"{}"`: write
 * `JSON.stringify([...bitmap])` or `bitmap.toArray()`. Passed to a method of the `roaring` package from npm in place of a
 * `RoaringBitmap32`, it answers wrongly without throwing in JavaScript (TypeScript refuses the call): decode its
 * `serialize()` bytes with that package instead.
 *
 * Every id argument is checked: a value that is not an integer in range (a fraction, `NaN`, a string, `null`, a
 * negative, one too large) throws `ValidationError`, whose message never repeats it, and the bitmap is unchanged.
 * Iterating while changing the bitmap is unsupported: collect first with `toUint32Array()`, or iterate a `clone()`.
 * Everything is synchronous.
 */
export class RoaringBitmap implements Iterable<number> {
  #bitmap: TsBitmap;

  /**
   * A bitmap of `values`: an array or another iterable of ids, a `Uint32Array` (read in place when it already ascends,
   * else sorted on a copy; it is never changed or kept), or another `RoaringBitmap` (a copy-on-write `clone()`).
   * With no argument it is empty.
   *
   * @throws {ValidationError} for an id that is not an integer from 0 to 4294967295; for a value that is not an
   * iterable (`null`, a number, a string, an object, an `ArrayBuffer`); and for a `Uint8Array`, `Uint8ClampedArray` or
   * `Buffer`, which would read each byte as an id: call {@link RoaringBitmap.deserialize} for bytes.
   */
  constructor(values?: Iterable<number>) {
    if (values === undefined) {
      this.#bitmap = TsBitmap.empty();
    } else if (RoaringBitmap.#is(values)) {
      this.#bitmap = values.#bitmap.clone();
    } else {
      this.#bitmap = TsBitmap.fromValues(idsOf(values));
    }
  }

  /**
   * Decode portable Roaring bytes you hold, through the check a `{ serialized }` load makes first: a size cap, a
   * structural check and one whole bitmap, and only then the decoder. The result keeps nothing of `bytes` or of
   * the private copy made of it: a bitset has an array of its own and arrays and runs sit on slabs of at most 64 KB, so
   * a large input that is decoded and then reduced is freed, except that at most one 64 KB slab stays alive for each
   * array or run container that survives.
   *
   * @param bytes a `Uint8Array`, which a Node `Buffer` is.
   * @param options `{ maxBytes }` lowers the size cap below the default of 537,403,396 bytes.
   * @throws {ValidationError} for something that is not a `Uint8Array`; an empty or detached one (an empty buffer is
   * not a bitmap: `new RoaringBitmap()` is the empty set); one over the cap or `maxBytes`; bytes that are not exactly
   * one well-formed portable bitmap, including bytes after its last container; a second argument that is not
   * `undefined` or an object whose only key is `maxBytes` (a format argument such as `'portable'` is one); and a
   * `maxBytes` that is not an integer from 0 to the cap.
   */
  static deserialize(bytes: Uint8Array, options?: RoaringBitmapDeserializeOptions): RoaringBitmap {
    const maxBytes = maxBytesOf(options);
    return RoaringBitmap.#wrap(
      decodeSerialized(bytes, detachedCodec, 'the buffer', {
        maxBytes,
        refuseEmpty: true,
      }) as TsBitmap,
    );
  }

  /** Whether `value` is a `RoaringBitmap` of this copy of the package. */
  static #is(value: unknown): value is RoaringBitmap {
    return typeof value === 'object' && value !== null && #bitmap in value;
  }

  static #wrap(bitmap: TsBitmap): RoaringBitmap {
    const out = new RoaringBitmap();
    out.#bitmap = bitmap;
    return out;
  }

  /** The codec bitmap of an operand, or a refusal that says what combines with what. */
  static #operand(other: unknown): TsBitmap {
    if (!RoaringBitmap.#is(other)) {
      throw new ValidationError(
        'a RoaringBitmap combines only with another RoaringBitmap of this copy of the package',
      );
    }
    return other.#bitmap;
  }

  /** How many ids it holds. */
  get size(): number {
    return this.#bitmap.size;
  }

  /** Whether it holds no id. */
  get isEmpty(): boolean {
    return this.#bitmap.isEmpty;
  }

  /**
   * Whether it holds `id`.
   *
   * @throws {ValidationError} for a value that is not an integer from 0 to 4294967295.
   */
  has(id: number): boolean {
    return this.#bitmap.has(checkedId(id));
  }

  /** The smallest id, or `undefined` when it is empty. */
  minimum(): number | undefined {
    return this.#bitmap.minimum();
  }

  /** The largest id, or `undefined` when it is empty. */
  maximum(): number | undefined {
    return this.#bitmap.maximum();
  }

  /**
   * Add one id; returns this bitmap, for chaining.
   *
   * @throws {ValidationError} for a value that is not an integer from 0 to 4294967295, and for a second argument:
   * use {@link RoaringBitmap.addMany} to add several.
   */
  add(id: number): this {
    if (arguments.length !== 1) throw oneIdOnly('add', 'addMany');
    this.#bitmap.add(checkedId(id));
    return this;
  }

  /**
   * Add every id of `values` (an iterable of ids, or a `Uint32Array`); returns this bitmap. Nothing is added if any
   * of them is refused.
   *
   * @throws {ValidationError} as the constructor does.
   */
  addMany(values: Iterable<number>): this {
    if (RoaringBitmap.#is(values)) this.#bitmap.orInPlace(values.#bitmap);
    else this.#bitmap.addMany(idsOf(values));
    return this;
  }

  /**
   * Remove one id; whether it was there.
   *
   * @throws {ValidationError} for a value that is not an integer from 0 to 4294967295, and for a second argument:
   * use {@link RoaringBitmap.removeMany} to remove several.
   */
  remove(id: number): boolean {
    if (arguments.length !== 1) throw oneIdOnly('remove', 'removeMany');
    return this.#bitmap.remove(checkedId(id));
  }

  /**
   * Remove every id of `values` (an iterable of ids, or a `Uint32Array`); returns this bitmap. Nothing is removed if
   * any of them is refused.
   *
   * @throws {ValidationError} as the constructor does.
   */
  removeMany(values: Iterable<number>): this {
    if (RoaringBitmap.#is(values)) this.#bitmap.andNotInPlace(values.#bitmap);
    else this.#bitmap.removeMany(collect(idsOf(values)));
    return this;
  }

  /** Remove every id. */
  clear(): void {
    this.#bitmap.clear();
  }

  /**
   * A copy. It is copy-on-write: the copy costs the key list and one flag per container, not the ids, and the first
   * write to a container on either side copies that container once.
   */
  clone(): RoaringBitmap {
    return RoaringBitmap.#wrap(this.#bitmap.clone());
  }

  /**
   * Keep only the ids `other` also holds; returns this bitmap. `other` is not changed, and may be this bitmap.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  andInPlace(other: RoaringBitmap): this {
    this.#bitmap.andInPlace(RoaringBitmap.#operand(other));
    return this;
  }

  /**
   * Add the ids `other` holds; returns this bitmap. `other` is not changed, and may be this bitmap.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  orInPlace(other: RoaringBitmap): this {
    this.#bitmap.orInPlace(RoaringBitmap.#operand(other));
    return this;
  }

  /**
   * Remove the ids `other` holds; returns this bitmap. `other` is not changed, and may be this bitmap.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  andNotInPlace(other: RoaringBitmap): this {
    this.#bitmap.andNotInPlace(RoaringBitmap.#operand(other));
    return this;
  }

  /**
   * Flip the ids `other` holds: keep those only this bitmap holds, add those only `other` holds; returns this bitmap.
   * `other` is not changed, and may be this bitmap (the result is then empty).
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  xorInPlace(other: RoaringBitmap): this {
    this.#bitmap.xorInPlace(RoaringBitmap.#operand(other));
    return this;
  }

  /**
   * How many ids both bitmaps hold, without building the intersection. Neither bitmap changes; `other` may be this one.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  andCardinality(other: RoaringBitmap): number {
    const that = RoaringBitmap.#operand(other);
    return COUNT_BY_KERNELS
      ? this.#bitmap.andCardinality(that)
      : TsBitmap.and(this.#bitmap, that).size;
  }

  /**
   * How many ids either bitmap holds. Neither bitmap changes; `other` may be this one.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  orCardinality(other: RoaringBitmap): number {
    const that = RoaringBitmap.#operand(other);
    return COUNT_BY_KERNELS
      ? this.#bitmap.orCardinality(that)
      : TsBitmap.or(this.#bitmap, that).size;
  }

  /**
   * How many ids exactly one of the bitmaps holds. Neither bitmap changes; `other` may be this one.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  xorCardinality(other: RoaringBitmap): number {
    const that = RoaringBitmap.#operand(other);
    return COUNT_BY_KERNELS
      ? this.#bitmap.xorCardinality(that)
      : TsBitmap.xor(this.#bitmap, that).size;
  }

  /**
   * How many ids this bitmap holds that `other` lacks. Neither bitmap changes; `other` may be this one.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  andNotCardinality(other: RoaringBitmap): number {
    const that = RoaringBitmap.#operand(other);
    return COUNT_BY_KERNELS
      ? this.#bitmap.andNotCardinality(that)
      : TsBitmap.andNot(this.#bitmap, that).size;
  }

  /**
   * Whether the bitmaps share an id. Neither bitmap changes; `other` may be this one.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  intersects(other: RoaringBitmap): boolean {
    const that = RoaringBitmap.#operand(other);
    return COUNT_BY_KERNELS
      ? this.#bitmap.intersects(that)
      : !TsBitmap.and(this.#bitmap, that).isEmpty;
  }

  /**
   * Whether every id of this bitmap is in `other` (an empty bitmap is a subset of every bitmap, itself included). Neither
   * bitmap changes. Unlike the `roaring` package, which answers `false`, a value that is not a bitmap is refused.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  isSubset(other: RoaringBitmap): boolean {
    return this.#bitmap.isSubset(RoaringBitmap.#operand(other));
  }

  /**
   * Whether both bitmaps hold exactly the same ids, whatever the kinds of their containers or the bytes they would
   * serialize to. Neither bitmap changes.
   *
   * @throws {ValidationError} if `other` is not a `RoaringBitmap` of this copy of the package.
   */
  isEqual(other: RoaringBitmap): boolean {
    return this.#bitmap.isEqual(RoaringBitmap.#operand(other));
  }

  /**
   * The ids both bitmaps hold, as a new bitmap. Neither operand changes, and the result holds storage of its own.
   *
   * @throws {ValidationError} if an operand is not a `RoaringBitmap` of this copy of the package.
   */
  static and(a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap {
    return RoaringBitmap.#wrap(TsBitmap.and(RoaringBitmap.#operand(a), RoaringBitmap.#operand(b)));
  }

  /**
   * The ids either bitmap holds, as a new bitmap. Neither operand changes. A container only `a` holds is shared with
   * the result copy-on-write, so the next write to it, on either side, copies it once.
   *
   * @throws {ValidationError} if an operand is not a `RoaringBitmap` of this copy of the package.
   */
  static or(a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap {
    return RoaringBitmap.#wrap(TsBitmap.or(RoaringBitmap.#operand(a), RoaringBitmap.#operand(b)));
  }

  /**
   * The ids exactly one of the bitmaps holds, as a new bitmap. Neither operand changes (see {@link RoaringBitmap.or}
   * for what is shared).
   *
   * @throws {ValidationError} if an operand is not a `RoaringBitmap` of this copy of the package.
   */
  static xor(a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap {
    return RoaringBitmap.#wrap(TsBitmap.xor(RoaringBitmap.#operand(a), RoaringBitmap.#operand(b)));
  }

  /**
   * The ids of `a` that `b` lacks, as a new bitmap. Neither operand changes (see {@link RoaringBitmap.or} for what is
   * shared).
   *
   * @throws {ValidationError} if an operand is not a `RoaringBitmap` of this copy of the package.
   */
  static andNot(a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap {
    return RoaringBitmap.#wrap(
      TsBitmap.andNot(RoaringBitmap.#operand(a), RoaringBitmap.#operand(b)),
    );
  }

  /**
   * The union of every bitmap of `bitmaps`, as a new bitmap that owns its storage (an empty list gives the empty set).
   * No operand changes, and none is flagged: the result accumulates in containers of its own.
   *
   * @throws {ValidationError} if `bitmaps` is not an iterable, or holds anything that is not a `RoaringBitmap` of this
   * copy of the package; nothing is combined then.
   */
  static orMany(bitmaps: Iterable<RoaringBitmap>): RoaringBitmap {
    if (typeof bitmaps !== 'object' || bitmaps === null || !(Symbol.iterator in bitmaps)) {
      throw new ValidationError('orMany takes an iterable of RoaringBitmap');
    }
    const parts = Array.from(bitmaps, (b) => RoaringBitmap.#operand(b));
    return RoaringBitmap.#wrap(TsBitmap.orMany(parts));
  }

  /** The ids in ascending order, each once. A bitmap that changes during the walk gives unspecified ids, and no error. */
  [Symbol.iterator](): IterableIterator<number> {
    return this.#bitmap[Symbol.iterator]();
  }

  /** The ids as a new ascending array. A bitmap too large to allocate as one throws the runtime's `RangeError`. */
  toArray(): number[] {
    return this.#bitmap.toArray();
  }

  /** The ids as a new ascending `Uint32Array` the caller owns, never a view of the bitmap's storage. */
  toUint32Array(): Uint32Array {
    return this.#bitmap.toUint32Array();
  }

  /**
   * The portable Roaring bytes, in a new `Uint8Array`. Call {@link RoaringBitmap.runOptimize} first when the bitmap was
   * decoded from bytes another writer made: its run containers stay as they were, and a bitmap that serializes over
   * the size cap is refused by a load.
   *
   * @param format `'portable'`, the only format there is, or nothing.
   * @throws {ValidationError} for any other argument.
   */
  serialize(format?: 'portable'): Uint8Array {
    if (format !== undefined && format !== 'portable') {
      throw new ValidationError(
        `a bitmap serializes only as serialize() or serialize('portable'); got ${kindOf(format)}`,
      );
    }
    return this.#bitmap.serialize();
  }

  /**
   * Re-encode every container in the smallest form (a run container only where it is strictly smaller than the plain
   * one), so `serialize()` afterwards depends on the set alone. Membership is unchanged.
   *
   * @returns whether the bitmap holds at least one run container afterwards, not whether anything changed.
   */
  runOptimize(): boolean {
    this.#bitmap.optimize();
    return this.#bitmap.hasRunContainer();
  }
}
