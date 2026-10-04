/**
 * The conversion the `serialized` project makes, in one place: a load's id source drained, each id checked as the
 * id path checks it, and the set handed on as portable Roaring bytes.
 *
 * Two callers use it. `tests/setup-load-via-serialized.ts` wraps core's load with it, which covers `store.load()`,
 * the `*Into` verbs and every direct caller of core's load; `tests/helpers/bulk-load.ts` uses it for the fixture
 * loader, which writes generations without going through core's load. Each records what it did in {@link routing},
 * so a test can see what core's write path received and the setup can refuse a routed file that converted nothing.
 */
import roaring from 'roaring';
import { inject } from 'vitest';
import { splitId } from '@/core/bit-route';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Which input the project hands core's load: the ids as given, or `{ serialized }`. */
    loadInput: string;
  }
}

const { RoaringBitmap32 } = roaring;

/** Whether this test file runs in the project that routes loads through `{ serialized }`. */
export function routedProject(): boolean {
  return inject('loadInput') === 'serialized';
}

/** What a load's write path was handed: the kind of each input, in order, and how many were converted. */
export const routing = { conversions: 0, received: [] as string[] };

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
