import { afterAll, vi } from 'vitest';
import type * as LoadModule from '@/core/load';

/**
 * Not a test: the setup of the `serialized` project in `vitest.config.ts`, which re-runs every load test with core's
 * load handed `{ serialized }` in place of the ids it was given.
 *
 * Core's load module is replaced by one whose load first drains an id source, checks each id as the id path does
 * (so a bad id is still a `ValidationError`), and passes the set on as portable Roaring bytes
 * (`tests/helpers/load-routing.ts`). The facade's `store.load()`, the `*Into` verbs and every direct caller of core's
 * load go through it, and the fixture loader in `tests/helpers/bulk-load.ts` converts the same way, so the file list
 * proves the bytes path keeps the id path's guarantees without a copy of any test. An input that is not an id
 * source, or a byte array that core must refuse, passes through unchanged. A routed file that converts no load
 * fails.
 *
 * What it cannot preserve is *when* ids are read: here they are all read before the load's first request, where
 * the id path reads them during its write. A test that depends on that order is on the ids-only list, with why.
 */
vi.mock('@/core/load', async (importOriginal) => {
  const real = await importOriginal<typeof LoadModule>();
  const { kindOf, routing, toSerialized } = await import('./helpers/load-routing');
  const loadSegment: typeof real.loadSegment = async (ref, input, deps, options) => {
    const converted = (await toSerialized(input)) as typeof input;
    routing.received.push(kindOf(converted));
    return real.loadSegment(ref, converted, deps, options);
  };
  return { ...real, loadSegment };
});

// A file on the routed list that converted no load ran twice for nothing: its loads all go some way this project
// does not route. Fail it, so the list cannot claim coverage the run did not give.
afterAll(async () => {
  const { routing } = await import('./helpers/load-routing');
  if (routing.conversions === 0) {
    throw new Error(
      "this file is on the serialized project's list, and none of its loads was converted to { serialized }: " +
        'route its loads, or move it to the ids-only list with the reason',
    );
  }
});
