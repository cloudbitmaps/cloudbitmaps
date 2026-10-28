/**
 * A Roaring bitmap of unsigned 32-bit ids in TypeScript, behind the codec seam: {@link tsRoaringCodec} is a
 * `CodecInterface` that stores the same portable Roaring bytes as CRoaring (through `roaring`, the reference the tests compare it
 * against), with no native addon.
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
 *     proven before a container is built, and refuses what CRoaring's validator refuses, with `IntegrityError`;
 *   - a combine never changes its operand. A key only this bitmap holds keeps its container by reference (it can be a
 *     run), an unshared bitset's words are reused in place, and a key only the operand holds is copied in for a union;
 *     a pair of containers combines into an array or a bitset, except that two run containers keep a run result while
 *     it is the smaller form (the written rule is in `containers.ts`).
 *   - `clone` shares every container with the original and flags it, so the first write on either side copies it.
 *
 * `andCardinality` (and the or, xor and andNot counts derived from it), `intersects`, `isSubset` and `isEqual` answer from
 * the containers without building a result: they change neither bitmap and allocate nothing per call.
 *
 * Writing an id that is not an integer from 0 to 4,294,967,295 throws `ValidationError`; reading one (`has`) says no
 * and removing one does nothing. A combine works on each pair of containers by their kinds (`containers.ts` has the
 * table), `addMany` and `removeMany` group sorted ids by key and touch each container once, and iteration is a class
 * that walks the containers where they are (`iterator.ts`; a bitmap must not be mutated while it is iterated).
 *
 * `encodeChunks` takes a snapshot of the containers and marks each shared, so the bitmap may change while the chunks
 * are read: a change copies a shared container first, and the chunks stay what they were when it was called. It
 * optimizes and serializes one container per step, so a writer can yield between steps. Membership and bytes are
 * unchanged, but every container is now flagged shared, so the next write to each copies it once.
 *
 * @see https://github.com/RoaringBitmap/RoaringFormatSpec
 */
import type { CodecBitmap, CodecInterface, EncodedChunk } from '@cloudbitmaps/core';
import { IntegrityError, ValidationError, refusalOfId } from '@cloudbitmaps/core';
import {
  Container,
  appendIds,
  arrayContainer,
  cloneContainer,
  containerAdd,
  containerAddSorted,
  containerAnd,
  containerAndCard,
  containerAndNot,
  containerHas,
  containerMax,
  containerMin,
  containerOr,
  containerRemove,
  containerXor,
  containersEqual,
  containersIntersect,
  containersSubset,
  fromSortedIds,
  optimize,
  orManyContainers,
  orRunIdsWalk,
  RUN,
  walksRunIds,
} from './containers';
import { BitmapIterator } from './iterator';
import { decodeContainers, serializeContainers, trailingBytes } from './wire';

const MAX_ID = 0xffff_ffff;

function isId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ID;
}

function checkedId(value: number): number {
  if (!isId(value)) throw refusalOfId(value);
  return value;
}

/**
 * The ids of `values`, checked, as a `Uint32Array`: `values` itself when it is one (every element of it is an id), else
 * a new one the caller may sort. An array is read once; another iterable is read once into a buffer that doubles, so no
 * intermediate array of the ids is built.
 */
export function collect(values: Iterable<number>): Uint32Array {
  if (values instanceof Uint32Array) return values;
  if (Array.isArray(values)) {
    const list = values as number[];
    const out = new Uint32Array(list.length);
    let i = 0;
    try {
      for (; i < list.length; i++) {
        const v = list[i] as number;
        // `v >>> 0 === v` is an integer from 0 to 2^32 - 1 and nothing else (NaN, fractions, strings and null fail it).
        if (v >>> 0 !== v) throw refusalOfId(v);
        out[i] = v;
      }
    } catch (error) {
      // `>>>` coerces a value that is not a number, and the coercion can throw (a BigInt, a Symbol, an object with no
      // primitive form, a `valueOf` that throws): whatever fails on a value that is not a number is that value's
      // refusal, and a check per value to tell it apart in the loop would cost every build. A failure on a number
      // (its own refusal, or a getter that throws) is rethrown as it is.
      const v: unknown = list[i];
      if (typeof v !== 'number') throw refusalOfId(v);
      throw error;
    }
    return out;
  }
  let out = new Uint32Array(1_024);
  let n = 0;
  for (const v of values) {
    if (n === out.length) {
      const grown = new Uint32Array(2 * n);
      grown.set(out);
      out = grown;
    }
    out[n++] = checkedId(v);
  }
  return out.subarray(0, n);
}

/** The ids of `values` that are ids, in a new `Uint32Array`: what a removal acts on, which ignores the rest. */
function collectLenient(values: Iterable<number>): Uint32Array {
  if (values instanceof Uint32Array) return values.slice();
  const list = Array.isArray(values) ? (values as number[]) : Array.from(values);
  const out = new Uint32Array(list.length);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i] as number;
    if (v >>> 0 === v) out[n++] = v;
  }
  return out.subarray(0, n);
}

/** The most ids one key's group of an `addMany` can hold and still go into its container one id at a time. */
const FEW_IDS = 4;

/**
 * `ids` ascending: itself when it already is, else sorted, in place when `owned` (a new array that is the caller's own)
 * and in a copy when it is the caller's.
 */
function sortedIds(ids: Uint32Array, owned: boolean): Uint32Array {
  for (let i = 1; i < ids.length; i++) {
    if ((ids[i - 1] as number) > (ids[i] as number)) return (owned ? ids : ids.slice()).sort();
  }
  return ids;
}

/** The index of the first of the ascending `keys`, from index `from`, that is `>= key`. */
function lowerBound(keys: readonly number[], key: number, from = 0): number {
  let lo = from;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] as number) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Like {@link lowerBound}, but by doubling steps from `from`, so it costs the log of the distance, not of the length. */
function gallopKeys(keys: readonly number[], key: number, from: number): number {
  let step = 1;
  let lo = from;
  let hi = from;
  while (hi < keys.length && (keys[hi] as number) < key) {
    lo = hi + 1;
    hi += step;
    step *= 2;
  }
  return lowerBoundIn(keys, key, lo, Math.min(hi, keys.length));
}

function lowerBoundIn(keys: readonly number[], key: number, from: number, to: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] as number) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const OR = 0;
const AND = 1;
const AND_NOT = 2;
const XOR = 3;
type Combine = typeof OR | typeof AND | typeof AND_NOT | typeof XOR;

function combineContainers(op: Combine, a: Container, b: Container): Container | null {
  if (op === OR) return containerOr(a, b, !a.shared || a.kind === RUN);
  if (op === AND) return containerAnd(a, b, !a.shared);
  if (op === XOR) return containerXor(a, b, !a.shared);
  return containerAndNot(a, b, !a.shared);
}

export class TsBitmap implements CodecBitmap {
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
   * refused too; without it they are ignored. With `detached`, every container gets storage of its own, copied out of
   * the input, so nothing the result holds is a view of one shared buffer: a bitmap that is kept and then reduced
   * does not keep the whole input alive.
   *
   * @throws {IntegrityError} if the input exceeds `maxBytes`, is not a well-formed portable bitmap, or (with `whole`)
   * has bytes after it.
   */
  static safeDeserialize(
    bytes: Uint8Array,
    maxBytes: number,
    options: { readonly whole?: boolean; readonly detached?: boolean } = {},
  ): TsBitmap {
    if (bytes.length > maxBytes) {
      throw new IntegrityError(`serialized bitmap is ${bytes.length}B, exceeds cap ${maxBytes}B`);
    }
    const { keys, conts, end } = decodeContainers(bytes, options.detached === true);
    if (options.whole === true && end !== bytes.byteLength) {
      throw trailingBytes(bytes.byteLength, end);
    }
    let size = 0;
    for (let i = 0; i < conts.length; i++) size += (conts[i] as Container).card;
    return new TsBitmap(keys, conts, size);
  }

  serialize(): Uint8Array {
    return serializeContainers(this.#keys, this.#conts);
  }

  /** Re-encode each container canonically; membership is untouched. */
  optimize(): void {
    const conts = this.#conts;
    for (let i = 0; i < conts.length; i++) conts[i] = optimize(conts[i] as Container);
  }

  /** Whether at least one container is held as runs. */
  hasRunContainer(): boolean {
    for (let i = 0; i < this.#conts.length; i++)
      if ((this.#conts[i] as Container).kind === RUN) return true;
    return false;
  }

  /**
   * The set as storage chunks: each payload is the portable bytes of a one-container bitmap holding that chunk's low 16
   * bits, optimized the way {@link optimize} does. Nothing is built until a chunk is asked for, so a writer that yields
   * between chunks runs this in slices. The call snapshots the containers and marks each shared, so a change to the
   * bitmap while the chunks are read copies a container instead of altering what the chunks will say. The bitmap's own
   * containers are not optimized by it.
   */
  encodeChunks(): Iterable<EncodedChunk> {
    const keys = this.#keys.slice();
    const conts = this.#conts.slice();
    for (let i = 0; i < conts.length; i++) (conts[i] as Container).shared = true;
    return {
      *[Symbol.iterator](): Iterator<EncodedChunk> {
        for (let i = 0; i < conts.length; i++) {
          const c = optimize(conts[i] as Container);
          yield {
            chunkKey: keys[i] as number,
            payload: serializeContainers([0], [c]),
            cardinality: c.card,
          };
        }
      },
    };
  }

  /** The smallest id, or `undefined` when the bitmap is empty. */
  minimum(): number | undefined {
    if (this.#conts.length === 0) return undefined;
    return (this.#keys[0] as number) * 65_536 + containerMin(this.#conts[0] as Container);
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

  /**
   * Add the ids. They are grouped by key in ascending order, so each container is touched once, a key already held is
   * merged where it is, and the new keys are put in with one pass over the key list however many there are.
   */
  addMany(values: Iterable<number>): void {
    const ids = sortedIds(collect(values), !(values instanceof Uint32Array));
    const fresh: Array<{ key: number; group: Container }> = [];
    let at = 0;
    for (let i = 0; i < ids.length;) {
      const key = (ids[i] as number) >>> 16;
      let end = i + 1;
      while (end < ids.length && (ids[end] as number) >>> 16 === key) end++;
      const first = i;
      i = end;
      at = gallopKeys(this.#keys, key, at);
      if (this.#keys[at] === key) {
        const before = this.#conts[at] as Container;
        // A group of a few goes into the container it meets without a container of its own. A run container is never
        // written in place, so the result may be it when the ids add nothing.
        // A larger group into a run container is walked from the ids, again with no container for the group.
        const after =
          end - first <= FEW_IDS
            ? containerAddSorted(before, ids, first, end)
            : walksRunIds(before, end - first)
              ? orRunIdsWalk(before, ids, first, end)
              : containerOr(
                  before,
                  fromSortedIds(ids, first, end),
                  !before.shared || before.kind === RUN,
                );
        this.#conts[at] = after;
        this.#size += after.card - before.card;
      } else {
        const group = fromSortedIds(ids, first, end);
        fresh.push({ key, group });
        this.#size += group.card;
      }
    }
    if (fresh.length > 0) this.#insertAll(fresh);
  }

  /** Remove the id (anything that is not an id is ignored); whether it was there. */
  remove(value: number): boolean {
    if (!isId(value)) return false;
    const key = value >>> 16;
    const at = lowerBound(this.#keys, key);
    if (this.#keys[at] !== key) return false;
    const before = this.#conts[at] as Container;
    const after = containerRemove(before, value & 0xffff);
    if (after === null) {
      this.#keys.splice(at, 1);
      this.#conts.splice(at, 1);
      this.#size -= before.card;
      return true;
    }
    this.#conts[at] = after;
    this.#size += after.card - before.card;
    return after.card !== before.card;
  }

  /** Remove every id. Containers a clone shares are left to it. */
  clear(): void {
    this.#keys = [];
    this.#conts = [];
    this.#size = 0;
  }

  /** Remove the ids (anything that is not an id is ignored), grouped by key; the keys left empty go in one pass. */
  removeMany(values: Iterable<number>): void {
    const ids = sortedIds(collectLenient(values), true);
    const keys = this.#keys;
    const conts = this.#conts;
    let at = 0;
    let emptied = 0;
    for (let i = 0; i < ids.length;) {
      const key = (ids[i] as number) >>> 16;
      let end = i + 1;
      while (end < ids.length && (ids[end] as number) >>> 16 === key) end++;
      const from = i;
      i = end;
      at = gallopKeys(keys, key, at);
      if (keys[at] !== key) continue;
      const before = conts[at] as Container;
      if (before.card === 0) continue;
      const after = containerAndNot(before, fromSortedIds(ids, from, end), !before.shared);
      this.#size -= before.card - (after === null ? 0 : after.card);
      if (after === null) {
        conts[at] = EMPTIED;
        emptied++;
      } else {
        conts[at] = after;
      }
    }
    if (emptied > 0) this.#dropEmptied();
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
    const conts = new Array<Container>(this.#conts.length);
    // The copy shares each container with this bitmap and both mark it shared, so the first write on either side copies
    // it; a clone that is only read, or combined into fresh containers, never pays for a copy.
    for (let i = 0; i < conts.length; i++) {
      const c = this.#conts[i] as Container;
      c.shared = true;
      conts[i] = c;
    }
    return new TsBitmap(this.#keys.slice(), conts, this.#size);
  }

  orInPlace(other: CodecBitmap): void {
    this.#combine(TsBitmap.#of(other), OR);
  }

  andInPlace(other: CodecBitmap): void {
    this.#combine(TsBitmap.#of(other), AND);
  }

  andNotInPlace(other: CodecBitmap): void {
    this.#combine(TsBitmap.#of(other), AND_NOT);
  }

  /** Flip the ids `other` holds, in one pass over the pair of each key. */
  xorInPlace(other: CodecBitmap): void {
    this.#combine(TsBitmap.#of(other), XOR);
  }

  /** How many ids both bitmaps hold, counted without building the intersection. */
  andCardinality(other: CodecBitmap): number {
    const that = TsBitmap.#of(other);
    const a = this.#keys;
    const b = that.#keys;
    let n = 0;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const ka = a[i] as number;
      const kb = b[j] as number;
      if (ka === kb) {
        n += containerAndCard(this.#conts[i++] as Container, that.#conts[j++] as Container);
      } else if (ka < kb) {
        i = gallopKeys(a, kb, i + 1);
      } else {
        j = gallopKeys(b, ka, j + 1);
      }
    }
    return n;
  }

  /** How many ids either bitmap holds. */
  orCardinality(other: CodecBitmap): number {
    return this.#size + TsBitmap.#of(other).#size - this.andCardinality(other);
  }

  /** How many ids exactly one of the bitmaps holds. */
  xorCardinality(other: CodecBitmap): number {
    return this.#size + TsBitmap.#of(other).#size - 2 * this.andCardinality(other);
  }

  /** How many ids this bitmap holds that `other` lacks. */
  andNotCardinality(other: CodecBitmap): number {
    return this.#size - this.andCardinality(other);
  }

  /** Whether the bitmaps share an id; stops at the first one found. */
  intersects(other: CodecBitmap): boolean {
    const that = TsBitmap.#of(other);
    const a = this.#keys;
    const b = that.#keys;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const ka = a[i] as number;
      const kb = b[j] as number;
      if (ka === kb) {
        if (containersIntersect(this.#conts[i++] as Container, that.#conts[j++] as Container)) {
          return true;
        }
      } else if (ka < kb) {
        i = gallopKeys(a, kb, i + 1);
      } else {
        j = gallopKeys(b, ka, j + 1);
      }
    }
    return false;
  }

  /** Whether every id of this bitmap is in `other`; stops at the first container that is not inside its partner. */
  isSubset(other: CodecBitmap): boolean {
    const that = TsBitmap.#of(other);
    if (this.#size > that.#size) return false;
    const a = this.#keys;
    const b = that.#keys;
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      j = gallopKeys(b, a[i] as number, j);
      if (j === b.length || b[j] !== a[i]) return false;
      const c = this.#conts[i] as Container;
      if (!containersSubset(c, that.#conts[j++] as Container)) return false;
    }
    return true;
  }

  /** Whether both hold the same ids, whatever the kinds of their containers. */
  isEqual(other: CodecBitmap): boolean {
    const that = TsBitmap.#of(other);
    if (this.#size !== that.#size || this.#keys.length !== that.#keys.length) return false;
    for (let i = 0; i < this.#keys.length; i++) {
      if (this.#keys[i] !== that.#keys[i]) return false;
      if (!containersEqual(this.#conts[i] as Container, that.#conts[i] as Container)) return false;
    }
    return true;
  }

  [Symbol.iterator](): IterableIterator<number> {
    return new BitmapIterator(this.#keys, this.#conts);
  }

  toArray(): number[] {
    return Array.from(this.toUint32Array());
  }

  /** The ids as a new ascending `Uint32Array`. */
  toUint32Array(): Uint32Array {
    const out = new Uint32Array(this.#size);
    let at = 0;
    for (let i = 0; i < this.#conts.length; i++) {
      at = appendIds(this.#conts[i] as Container, out, at, (this.#keys[i] as number) * 65_536);
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

  /** Put the new keys, ascending and none held, in: after the last key by pushing, else in one merge pass. */
  #insertAll(fresh: ReadonlyArray<{ key: number; group: Container }>): void {
    const keys = this.#keys;
    const conts = this.#conts;
    if (
      keys.length === 0 ||
      (keys[keys.length - 1] as number) < (fresh[0] as { key: number }).key
    ) {
      for (const { key, group } of fresh) {
        keys.push(key);
        conts.push(group);
      }
      return;
    }
    const outKeys: number[] = [];
    const outConts: Container[] = [];
    let i = 0;
    let j = 0;
    while (i < keys.length || j < fresh.length) {
      if (
        j === fresh.length ||
        (i < keys.length && (keys[i] as number) < (fresh[j] as { key: number }).key)
      ) {
        outKeys.push(keys[i] as number);
        outConts.push(conts[i++] as Container);
      } else {
        const next = fresh[j++] as { key: number; group: Container };
        outKeys.push(next.key);
        outConts.push(next.group);
      }
    }
    this.#keys = outKeys;
    this.#conts = outConts;
  }

  /** Remove the keys whose container was emptied by {@link removeMany}, in one pass. */
  #dropEmptied(): void {
    let kept = 0;
    for (let i = 0; i < this.#conts.length; i++) {
      if (this.#conts[i] === EMPTIED) continue;
      this.#keys[kept] = this.#keys[i] as number;
      this.#conts[kept++] = this.#conts[i] as Container;
    }
    this.#keys.length = kept;
    this.#conts.length = kept;
  }

  /**
   * Walk both key lists and rebuild this one: where both hold a key, the combine of the two containers; where only this
   * does, its container, unless the operation is an intersection; where only `that` does, a copy of its container for a
   * union and nothing otherwise. A combine that leaves no value drops the key. An intersection jumps over a stretch of
   * keys the other side lacks by doubling steps, so a few keys against many cost the few.
   */
  #combine(that: TsBitmap, op: Combine): void {
    const a = this.#keys;
    const b = that.#keys;
    const ca = this.#conts;
    const cb = that.#conts;
    const keys: number[] = [];
    const conts: Container[] = [];
    let size = 0;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const ka = a[i] as number;
      const kb = b[j] as number;
      if (ka === kb) {
        const c = combineContainers(op, ca[i++] as Container, cb[j++] as Container);
        if (c !== null) {
          keys.push(ka);
          conts.push(c);
          size += c.card;
        }
      } else if (ka < kb) {
        if (op === AND) {
          i = gallopKeys(a, kb, i + 1);
        } else {
          keys.push(ka);
          conts.push(ca[i] as Container);
          size += (ca[i++] as Container).card;
        }
      } else if (op === AND) {
        j = gallopKeys(b, ka, j + 1);
      } else {
        if (op === OR || op === XOR) {
          keys.push(kb);
          conts.push(cloneContainer(cb[j] as Container));
          size += (cb[j] as Container).card;
        }
        j++;
      }
    }
    if (op !== AND) {
      for (; i < a.length; i++) {
        keys.push(a[i] as number);
        conts.push(ca[i] as Container);
        size += (ca[i] as Container).card;
      }
    }
    if (op === OR || op === XOR) {
      for (; j < b.length; j++) {
        keys.push(b[j] as number);
        conts.push(cloneContainer(cb[j] as Container));
        size += (cb[j] as Container).card;
      }
    }
    this.#keys = keys;
    this.#conts = conts;
    this.#size = size;
  }

  /** The ids both bitmaps hold, as a new bitmap; neither operand changes and no container of either is kept. */
  static and(a: CodecBitmap, b: CodecBitmap): TsBitmap {
    return TsBitmap.#fresh(TsBitmap.#of(a), TsBitmap.#of(b), AND);
  }

  /** The ids either holds, as a new bitmap; neither operand changes. */
  static or(a: CodecBitmap, b: CodecBitmap): TsBitmap {
    return TsBitmap.#fresh(TsBitmap.#of(a), TsBitmap.#of(b), OR);
  }

  /**
   * The ids any of `bitmaps` holds, as a new bitmap that owns all its storage; no operand changes and none is flagged.
   * The containers of each key are gathered across the inputs and united in one pass (see {@link orManyContainers}),
   * counted once. A key only one input holds is copied as it is, a run included.
   */
  static orMany(bitmaps: readonly CodecBitmap[]): TsBitmap {
    const byKey = new Map<number, Container[]>();
    for (const input of bitmaps) {
      const that = TsBitmap.#of(input);
      for (let i = 0; i < that.#keys.length; i++) {
        const key = that.#keys[i] as number;
        const held = byKey.get(key);
        if (held === undefined) byKey.set(key, [that.#conts[i] as Container]);
        else held.push(that.#conts[i] as Container);
      }
    }
    const keys = Array.from(byKey.keys()).sort((x, y) => x - y);
    const conts: Container[] = [];
    let size = 0;
    for (const key of keys) {
      const held = byKey.get(key) as Container[];
      const c = held.length === 1 ? cloneContainer(held[0] as Container) : orManyContainers(held);
      conts.push(c);
      size += c.card;
    }
    return new TsBitmap(keys, conts, size);
  }

  /** The ids exactly one holds, as a new bitmap; neither operand changes. */
  static xor(a: CodecBitmap, b: CodecBitmap): TsBitmap {
    return TsBitmap.#fresh(TsBitmap.#of(a), TsBitmap.#of(b), XOR);
  }

  /** The ids of `a` that `b` lacks, as a new bitmap; neither operand changes. */
  static andNot(a: CodecBitmap, b: CodecBitmap): TsBitmap {
    return TsBitmap.#fresh(TsBitmap.#of(a), TsBitmap.#of(b), AND_NOT);
  }

  /**
   * The same walk as {@link TsBitmap.#combine}, building a new bitmap and leaving both operands whole. Where both hold
   * a key, the pair combines into a fresh container (the in-place form is never taken, so no storage of either operand
   * is written). A container only `x` holds is kept by reference and flagged shared, so a later write to `x` or to the
   * result copies it once; for an intersection nothing of `x` is kept, so nothing is flagged. A container only `y`
   * holds is copied in for a union or a symmetric difference.
   */
  static #fresh(x: TsBitmap, y: TsBitmap, op: Combine): TsBitmap {
    const a = x.#keys;
    const b = y.#keys;
    const ca = x.#conts;
    const cb = y.#conts;
    const keys: number[] = [];
    const conts: Container[] = [];
    let size = 0;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const ka = a[i] as number;
      const kb = b[j] as number;
      if (ka === kb) {
        const c = freshPair(op, ca[i++] as Container, cb[j++] as Container);
        if (c !== null) {
          keys.push(ka);
          conts.push(c);
          size += c.card;
        }
      } else if (ka < kb) {
        if (op === AND) {
          i = gallopKeys(a, kb, i + 1);
        } else {
          const c = ca[i++] as Container;
          c.shared = true;
          keys.push(ka);
          conts.push(c);
          size += c.card;
        }
      } else if (op === AND) {
        j = gallopKeys(b, ka, j + 1);
      } else {
        if (op === OR || op === XOR) {
          keys.push(kb);
          conts.push(cloneContainer(cb[j] as Container));
          size += (cb[j] as Container).card;
        }
        j++;
      }
    }
    if (op !== AND) {
      for (; i < a.length; i++) {
        const c = ca[i] as Container;
        c.shared = true;
        keys.push(a[i] as number);
        conts.push(c);
        size += c.card;
      }
    }
    if (op === OR || op === XOR) {
      for (; j < b.length; j++) {
        keys.push(b[j] as number);
        conts.push(cloneContainer(cb[j] as Container));
        size += (cb[j] as Container).card;
      }
    }
    return new TsBitmap(keys, conts, size);
  }
}

/** A pair of containers combined into a container of its own (`null` when nothing is left); neither is written. */
function freshPair(op: Combine, a: Container, b: Container): Container | null {
  if (op === OR) return containerOr(a, b, false);
  if (op === AND) return containerAnd(a, b, false);
  if (op === AND_NOT) return containerAndNot(a, b, false);
  return containerXor(a, b, false);
}

/** Stands for a container {@link TsBitmap.removeMany} emptied, until the keys left empty are dropped. */
const EMPTIED = arrayContainer(new Uint16Array(0), 0);

/** The TypeScript Roaring codec: the same portable bytes as CRoaring, with no native addon. */
export const tsRoaringCodec: CodecInterface = {
  empty: () => TsBitmap.empty(),
  fromValues: (values) => TsBitmap.fromValues(values),
  safeDeserialize: (bytes, maxBytes, options) => TsBitmap.safeDeserialize(bytes, maxBytes, options),
  owns: (bitmap) => bitmap instanceof TsBitmap,
  intersectSmallestFirst: true,
};
