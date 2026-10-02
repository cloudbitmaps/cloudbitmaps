import roaring from 'roaring';
import { vi } from 'vitest';
import { splitId } from '@/core/bit-route';
import type * as LoadModule from '@/core/load';

/**
 * Not a test: the setup of the `serialized` project in `vitest.config.ts`, which re-runs every load test with core's
 * load handed `{ serialized }` in place of the ids it was given.
 *
 * Core's load module is replaced by one whose load first drains an id source, checks each id as the id path does
 * (so a bad id is still a `ValidationError`), and passes the set on as portable Roaring bytes. The facade's
 * `store.load()`, the `*Into` verbs and every direct caller of core's load go through it, so the whole file list
 * proves the bytes path keeps the id path's guarantees without a copy of any test. An input that is not an id
 * source, or a byte array that core must refuse, passes through unchanged.
 *
 * What it cannot preserve is *when* ids are read: here they are all read before the load's first request, where
 * the id path reads them during its write. A test that depends on that order is on the ids-only list, with why.
 */
const { RoaringBitmap32 } = roaring;

async function asSerialized(input: unknown): Promise<unknown> {
  if (typeof input !== 'object' || input === null) return input;
  const tag = Object.prototype.toString.call(input).slice(8, -1);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') return input;
  const ids: number[] = [];
  if (Symbol.asyncIterator in input) {
    for await (const id of input as AsyncIterable<number>) ids.push(checked(id));
  } else if (Symbol.iterator in input) {
    for (const id of input as Iterable<number>) ids.push(checked(id));
  } else {
    return input;
  }
  return { serialized: new RoaringBitmap32(ids).serialize('portable') };
}

function checked(id: number): number {
  splitId(id); // throws the id path's ValidationError for a non-integer or out-of-range id
  return id;
}

vi.mock('@/core/load', async (importOriginal) => {
  const real = await importOriginal<typeof LoadModule>();
  const loadSegment: typeof real.loadSegment = async (ref, input, deps, options) =>
    real.loadSegment(ref, (await asSerialized(input)) as typeof input, deps, options);
  return { ...real, loadSegment };
});
