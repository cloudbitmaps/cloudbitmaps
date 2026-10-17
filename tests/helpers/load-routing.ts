/**
 * The conversions the `serialized` and `sorted` projects make, in one place: a load's id source drained, each id
 * checked as the id path checks it, and the set handed on as portable Roaring bytes, or as the same ids in ascending
 * order for a load with `sorted: true`.
 *
 * Two callers use each. `tests/setup-load-via-serialized.ts` and `tests/setup-load-via-sorted.ts` wrap core's load,
 * which covers `store.load()`, the `*Into` verbs and every direct caller of core's load; `tests/helpers/bulk-load.ts`
 * uses them for the fixture loader, which writes generations without going through core's load. Each records what it
 * did in {@link routing}, so a test can see what core's write path received and the setup can refuse a routed file
 * that converted nothing.
 */
import roaring from 'roaring';
import { inject } from 'vitest';
import { splitId } from '@/core/bit-route';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Which input the project hands core's load: the ids as given, `{ serialized }`, or sorted ids. */
    loadInput: string;
  }
}

const { RoaringBitmap32 } = roaring;

/** Whether this test file runs in the project that routes loads through `{ serialized }`. */
export function routedProject(): boolean {
  return inject('loadInput') === 'serialized';
}

/** Whether this test file runs in the project that sorts the ids of each load and passes `sorted: true`. */
export function sortedProject(): boolean {
  return inject('loadInput') === 'sorted';
}

/**
 * What a load's write path was handed: the kind of each input, in order, and how many were converted. `onPull`, when a
 * test sets it, is called when the write path first reads a sorted conversion's ids, so a test can see that it reads
 * them during the write.
 */
export const routing = {
  conversions: 0,
  received: [] as string[],
  onPull: undefined as (() => void) | undefined,
};

/** The kind of a load input, as the routing records it. */
export function kindOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return typeof input;
  const tag = Object.prototype.toString.call(input).slice(8, -1);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') return 'bytes';
  if (Symbol.iterator in input || Symbol.asyncIterator in input) return 'ids';
  if ('serialized' in input) return 'serialized';
  if ('bitmap' in input) return 'bitmap';
  return 'other';
}

/**
 * `input` as `{ serialized }` when it is an id source; anything else unchanged, a byte array included, which core
 * must refuse. A bad id throws the id path's `ValidationError` for it.
 */
export async function toSerialized(input: unknown): Promise<unknown> {
  if (kindOf(input) !== 'ids') return input;
  const ids: number[] = [];
  if (Symbol.asyncIterator in (input as object)) {
    for await (const id of input as AsyncIterable<number>) ids.push(checked(id));
  } else {
    for (const id of input as Iterable<number>) ids.push(checked(id));
  }
  routing.conversions++;
  return { serialized: new RoaringBitmap32(ids).serialize('portable') };
}

function checked(id: number): number {
  splitId(id); // throws the id path's ValidationError for a non-integer or out-of-range id
  return id;
}

/**
 * `input`'s ids in ascending order, repeats kept, as the same kind of source (a generator for a sync one, an async
 * generator for an async one), or `undefined` when `input` is not an id source. A bad id throws the id path's
 * `ValidationError` for it, as {@link toSerialized} does.
 */
export async function toSorted(
  input: unknown,
): Promise<Iterable<number> | AsyncIterable<number> | undefined> {
  if (kindOf(input) !== 'ids') return undefined;
  const ids: number[] = [];
  const async = Symbol.asyncIterator in (input as object);
  if (async) {
    for await (const id of input as AsyncIterable<number>) ids.push(checked(id));
  } else {
    for (const id of input as Iterable<number>) ids.push(checked(id));
  }
  ids.sort((a, b) => a - b);
  routing.conversions++;
  function* sync(): Generator<number> {
    routing.onPull?.();
    yield* ids;
  }
  async function* stream(): AsyncGenerator<number> {
    routing.onPull?.();
    yield* ids;
  }
  return async ? stream() : sync();
}
