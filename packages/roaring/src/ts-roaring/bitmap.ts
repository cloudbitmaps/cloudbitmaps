/**
 * A Roaring bitmap of unsigned 32-bit ids in TypeScript, behind the codec seam: {@link tsRoaringCodec} is a
 * `CodecInterface` that stores the same portable Roaring bytes as the native codec (CRoaring through `roaring`), with no
 * native addon.
 *
 * It implements the data structure of Chambi, Lemire, Kaser and Godin, "Better bitmap performance with Roaring bitmaps"
 * (2016), with the run containers of Lemire, Ssi-Yan-Kai and Kaser, "Consistently faster and smaller compressed bitmaps
 * with Roaring" (2016), and the implementation notes of Lemire et al., "Roaring Bitmaps: Implementation of an Optimized
 * Software Library" (2018); the links are in the package README's credits. An id is split into a 16-bit key and a 16-bit
 * remainder; the remainders of one key sit in a container (an array, a bitset or runs: `containers.ts`), and the
 * containers sit in ascending key order beside their keys. The portable bytes are `wire.ts`.
 *
 *   TsBitmap
 *     keys:  [ 0      3      40000 ]     ascending 16-bit keys
 *     conts: [ ARRAY  RUN    BITSET ]    one container each, with its cardinality kept
 *     size:  total cardinality, kept as containers change
 *
 * What it keeps to, which the oracle suite holds it to against CRoaring and against the stored-byte rule:
 *
 *   - `serialize()` writes the containers as they are: one made from ids is an array or a bitset by cardinality, one
 *     decoded from run bytes stays a run until it changes;
 *   - `optimize()` re-encodes each container canonically (a run only when strictly smaller than the plain body), so
 *     `serialize()` afterwards depends on the set alone;
 *   - `safeDeserialize` runs the layout check first (`portable/layout.ts`), so the structure every operation assumes is
 *     proven before a container is built, and refuses what the native path refuses, with `IntegrityError`;
 *   - a combine builds its result into fresh containers, shares nothing with its operand and never changes it.
 *
 * Writing an id that is not an integer from 0 to 4,294,967,295 throws `ValidationError`; reading one (`has`) says no
 * and removing one does nothing. This is the simple form: a combine goes through bitset words, and speed work is
 * layered on after the contract holds.
 *
 * @see https://github.com/RoaringBitmap/RoaringFormatSpec
 */
import type { CodecBitmap, CodecInterface, EncodedChunk } from '@cloudbitmaps/core';
import { IntegrityError, ValidationError } from '@cloudbitmaps/core';
import {
  arrayContainer,
  cloneContainer,
  containerAdd,
  containerAnd,
  containerAndNot,
  containerHas,
  containerMax,
  containerOr,
  containerRemove,
  fromSortedLows,
  optimize,
  toLows,
  type Container,
} from './containers';
import { decodeContainers, serializeContainers, trailingBytes } from './wire';

const MAX_ID = 0xffff_ffff;

function isId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ID;
}

function checkedId(value: number): number {
  if (!isId(value))
    throw new ValidationError(`${String(value)} is not an integer from 0 to ${MAX_ID}`);
  return value;
}

/** The ids of `values`, checked, as one `Uint32Array`. */
function collect(values: Iterable<number>): Uint32Array {
  const list = Array.isArray(values) ? (values as number[]) : Array.from(values);
  const out = new Uint32Array(list.length);
  for (let i = 0; i < list.length; i++) out[i] = checkedId(list[i] as number);
  return out;
}

/** The index of the first of the ascending `keys` that is `>= key`. */
function lowerBound(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] as number) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class TsBitmap implements CodecBitmap {
  #keys: number[];
  #conts: Container[];
  #size: number;

  private constructor(keys: number[], conts: Container[], size: number) {
    this.#keys = keys;
    this.#conts = conts;
    this.#size = size;
  }

  static empty(): TsBitmap {
    return new TsBitmap([], [], 0);
  }

  static fromValues(values: Iterable<number>): TsBitmap {
    const bitmap = TsBitmap.empty();
    bitmap.addMany(values);
    return bitmap;
  }

  /**
   * Cap the size, check the structure, then build the containers. With `whole`, bytes after the last container are
   * refused too; without it they are ignored.
   *
   * @throws {IntegrityError} if the input exceeds `maxBytes`, is not a well-formed portable bitmap, or (with `whole`)
   * has bytes after it.
   */
  static safeDeserialize(
    bytes: Uint8Array,
    maxBytes: number,
    options: { readonly whole?: boolean } = {},
  ): TsBitmap {
    if (bytes.length > maxBytes) {
      throw new IntegrityError(`serialized bitmap is ${bytes.length}B, exceeds cap ${maxBytes}B`);
    }
    const { keys, conts, end } = decodeContainers(bytes);
    if (options.whole === true && end !== bytes.byteLength) {
      throw trailingBytes(bytes.byteLength, end);
    }
    return new TsBitmap(
      keys,
      conts,
      conts.reduce((sum, c) => sum + c.card, 0),
    );
  }

  serialize(): Uint8Array {
    return serializeContainers(this.#keys, this.#conts);
  }

  /** Re-encode each container canonically; membership is untouched. */
  optimize(): void {
    this.#conts = this.#conts.map(optimize);
  }

  /**
   * The set as storage chunks, optimized first: each payload is the portable bytes of a one-container bitmap holding
   * that chunk's low 16 bits. Every payload is written before this returns, so a change to the bitmap while the
   * chunks are read cannot alter bytes already promised.
   */
  encodeChunks(): Iterable<EncodedChunk> {
    this.optimize();
    return this.#conts.map((c, i) => ({
      chunkKey: this.#keys[i] as number,
      payload: serializeContainers([0], [c]),
      cardinality: c.card,
    }));
  }

  maximum(): number | undefined {
    const last = this.#conts.length - 1;
    if (last < 0) return undefined;
    return (this.#keys[last] as number) * 65_536 + containerMax(this.#conts[last] as Container);
  }

  add(value: number): void {
    checkedId(value);
    const key = value >>> 16;
    const low = value & 0xffff;
    const at = lowerBound(this.#keys, key);
    const found = this.#keys[at] === key;
    if (!found) {
      this.#insert(at, key, arrayContainer(Uint16Array.of(low), 1));
      this.#size++;
      return;
    }
    const before = this.#conts[at] as Container;
    const after = containerAdd(before, low);
    this.#conts[at] = after;
    this.#size += after.card - before.card;
  }

  addMany(values: Iterable<number>): void {
    const ids = collect(values).sort();
    for (let i = 0; i < ids.length;) {
      const key = (ids[i] as number) >>> 16;
      let end = i;
      while (end < ids.length && (ids[end] as number) >>> 16 === key) end++;
      const lows = new Uint16Array(end - i);
      let count = 0;
      let previous = -1;
      for (; i < end; i++) {
        const low = (ids[i] as number) & 0xffff;
        if (low !== previous) lows[count++] = low;
        previous = low;
      }
      this.#merge(key, fromSortedLows(lows, count));
    }
  }

  remove(value: number): void {
    if (!isId(value)) return;
    const key = value >>> 16;
    const at = lowerBound(this.#keys, key);
    if (this.#keys[at] !== key) return;
    const before = this.#conts[at] as Container;
    const after = containerRemove(before, value & 0xffff);
    if (after === null) {
      this.#keys.splice(at, 1);
      this.#conts.splice(at, 1);
      this.#size -= before.card;
      return;
    }
    this.#conts[at] = after;
    this.#size += after.card - before.card;
  }

  removeMany(values: Iterable<number>): void {
    for (const value of values) this.remove(value);
  }

  has(value: number): boolean {
    if (!isId(value)) return false;
    const key = value >>> 16;
    const at = lowerBound(this.#keys, key);
    return this.#keys[at] === key && containerHas(this.#conts[at] as Container, value & 0xffff);
  }

  get size(): number {
    return this.#size;
  }

  get isEmpty(): boolean {
    return this.#size === 0;
  }

  clone(): TsBitmap {
    return new TsBitmap(this.#keys.slice(), this.#conts.map(cloneContainer), this.#size);
  }

  orInPlace(other: CodecBitmap): void {
    const that = TsBitmap.#of(other);
    this.#combine(that, containerOr, true, true, (c) => cloneContainer(c));
  }

  andInPlace(other: CodecBitmap): void {
    const that = TsBitmap.#of(other);
    this.#combine(that, containerAnd, false, false, () => null);
  }

  andNotInPlace(other: CodecBitmap): void {
    const that = TsBitmap.#of(other);
    this.#combine(that, containerAndNot, true, false, () => null);
  }

  *[Symbol.iterator](): IterableIterator<number> {
    const scratch = new Uint16Array(65_536);
    for (let i = 0; i < this.#conts.length; i++) {
      const base = (this.#keys[i] as number) * 65_536;
      const n = toLows(this.#conts[i] as Container, scratch);
      for (let k = 0; k < n; k++) yield base + (scratch[k] as number);
    }
  }

  toArray(): number[] {
    return Array.from(this.toUint32Array());
  }

  /** The ids as a new ascending `Uint32Array`. */
  toUint32Array(): Uint32Array {
    const out = new Uint32Array(this.#size);
    const scratch = new Uint16Array(65_536);
    let at = 0;
    for (let i = 0; i < this.#conts.length; i++) {
      const base = (this.#keys[i] as number) * 65_536;
      const n = toLows(this.#conts[i] as Container, scratch);
      for (let k = 0; k < n; k++) out[at++] = base + (scratch[k] as number);
    }
    return out;
  }

  static #of(other: CodecBitmap): TsBitmap {
    if (!(other instanceof TsBitmap)) {
      throw new ValidationError('a TypeScript roaring bitmap combines only with another one');
    }
    return other;
  }

  #insert(at: number, key: number, container: Container): void {
    if (at === this.#keys.length) {
      this.#keys.push(key);
      this.#conts.push(container);
    } else {
      this.#keys.splice(at, 0, key);
      this.#conts.splice(at, 0, container);
    }
  }

  /** Union `group` (the values of one key, owned by the caller) into the container under `key`. */
  #merge(key: number, group: Container): void {
    const at = lowerBound(this.#keys, key);
    if (this.#keys[at] !== key) {
      this.#insert(at, key, group);
      this.#size += group.card;
      return;
    }
    const before = this.#conts[at] as Container;
    const after = containerOr(before, group);
    this.#conts[at] = after;
    this.#size += after.card - before.card;
  }

  /**
   * Walk both key lists and rebuild this one: where both hold a key, `both` of the two containers; where only this
   * does, its container if `keepOurs`; where only `that` does, `theirs` of its container if `keepTheirs`. A `null`
   * drops the key.
   */
  #combine(
    that: TsBitmap,
    both: (a: Container, b: Container) => Container | null,
    keepOurs: boolean,
    keepTheirs: boolean,
    theirs: (c: Container) => Container | null,
  ): void {
    const keys: number[] = [];
    const conts: Container[] = [];
    const push = (key: number, c: Container | null): void => {
      if (c === null) return;
      keys.push(key);
      conts.push(c);
    };
    const a = this.#keys;
    const b = that.#keys;
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const ka = i < a.length ? (a[i] as number) : Infinity;
      const kb = j < b.length ? (b[j] as number) : Infinity;
      if (ka === kb) {
        push(ka, both(this.#conts[i] as Container, that.#conts[j] as Container));
        i++;
        j++;
      } else if (ka < kb) {
        if (keepOurs) push(ka, this.#conts[i] as Container);
        i++;
      } else {
        if (keepTheirs) push(kb, theirs(that.#conts[j] as Container));
        j++;
      }
    }
    this.#keys = keys;
    this.#conts = conts;
    this.#size = conts.reduce((sum, c) => sum + c.card, 0);
  }
}

/** The TypeScript Roaring codec: the same portable bytes as the native codec, with no native addon. */
export const tsRoaringCodec: CodecInterface = {
  empty: () => TsBitmap.empty(),
  fromValues: (values) => TsBitmap.fromValues(values),
  safeDeserialize: (bytes, maxBytes, options) => TsBitmap.safeDeserialize(bytes, maxBytes, options),
  owns: (bitmap) => bitmap instanceof TsBitmap,
};
