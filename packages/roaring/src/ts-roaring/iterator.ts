/**
 * The ascending iterator over a Roaring bitmap's ids: a class with its own state, not a generator, so a step is one
 * method call and a result object, with no suspended frame and no scratch buffer of 65,536 entries per iterator. It
 * walks one container at a time in place: an array by index, a run container by run and value, a bitset by word and the
 * lowest set bit of what is left of it.
 */
import { ARRAY, BITSET, WORDS, type Container } from './containers';

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

export class BitmapIterator implements IterableIterator<number> {
  readonly #keys: readonly number[];
  readonly #conts: readonly Container[];
  /** The container being walked, as an index into `#conts`, and its kind, storage and offset. */
  #at = -1;
  #kind: number = ARRAY;
  #u16: Uint16Array = new Uint16Array(0);
  #words: Uint32Array = new Uint32Array(0);
  #off = 0;
  /** Added to every remainder: the container's key times 65,536. */
  #base = 0;
  /** An array: the next index and one past the last. A run container: the next run's index and the run count. A bitset: the word index. */
  #pos = 0;
  #end = 0;
  /** A run container: the next value and the last of the current run. A bitset: what is left of the current word. */
  #next = 0;
  #last = -1;

  constructor(keys: readonly number[], conts: readonly Container[]) {
    this.#keys = keys;
    this.#conts = conts;
  }

  [Symbol.iterator](): this {
    return this;
  }

  next(): IteratorResult<number, undefined> {
    for (;;) {
      if (this.#kind === ARRAY) {
        if (this.#pos < this.#end) {
          return { done: false, value: this.#base + (this.#u16[this.#pos++] as number) };
        }
      } else if (this.#kind === BITSET) {
        let w = this.#next;
        while (w === 0 && ++this.#pos < WORDS) w = this.#words[this.#pos] as number;
        if (w !== 0) {
          const lowest = w & -w;
          this.#next = w ^ lowest;
          return {
            done: false,
            value: this.#base + this.#pos * 32 + 31 - Math.clz32(lowest),
          };
        }
      } else {
        if (this.#next <= this.#last) return { done: false, value: this.#base + this.#next++ };
        if (this.#pos < this.#end) {
          const r = this.#off + 2 * this.#pos++;
          this.#next = this.#u16[r] as number;
          this.#last = this.#next + (this.#u16[r + 1] as number);
          continue;
        }
      }
      if (!this.#advance()) return DONE;
    }
  }

  /** Move to the next container; `false` when there is none. */
  #advance(): boolean {
    if (++this.#at >= this.#conts.length) {
      this.#at = this.#conts.length;
      this.#kind = ARRAY;
      this.#pos = 0;
      this.#end = 0;
      return false;
    }
    const c = this.#conts[this.#at] as Container;
    this.#kind = c.kind;
    this.#base = (this.#keys[this.#at] as number) * 65_536;
    this.#off = c.off;
    if (c.kind === ARRAY) {
      this.#u16 = c.data as Uint16Array;
      this.#pos = c.off;
      this.#end = c.off + c.len;
    } else if (c.kind === BITSET) {
      this.#words = c.data as Uint32Array;
      this.#pos = 0;
      this.#next = this.#words[0] as number;
    } else {
      this.#u16 = c.data as Uint16Array;
      this.#pos = 0;
      this.#end = c.len;
      this.#next = 0;
      this.#last = -1;
    }
    return true;
  }
}
