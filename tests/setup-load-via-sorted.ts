import { afterAll, vi } from 'vitest';
import type * as LoadModule from '@/core/load';

/**
 * Not a test: the setup of the `sorted` project in `vitest.config.ts`, which re-runs every routed load test with core's
 * load handed the same ids in ascending order and `sorted: true`.
 *
 * Core's load module is replaced by one whose load first drains an id source, checks each id as the id path does (so a
 * bad id is still a `ValidationError`), sorts them, repeats kept, and passes them on as a source of the same kind, with
 * `sorted: true` added to the options (`tests/helpers/load-routing.ts`). The facade's `store.load()`, the `*Into` verbs
 * and every direct caller of core's load go through it, and the fixture loader in `tests/helpers/bulk-load.ts` converts
 * the same way, so the file list proves the sorted path keeps the id path's guarantees without a copy of any test. An
 * input that is not an id source passes through unchanged, with the options as given. A routed file that converts no
 * load fails.
 *
 * What it cannot preserve is the order the caller gave the ids in, and when the caller's own source is read: here it is
 * read whole before the load's first request, and the sorted copy is read during the write. A test that depends on
 * either belongs on the sorted project's exclusion list, with why; the list also holds a few heavy files whose loads only
 * build what another behaviour is tested over.
 */
vi.mock('@/core/load', async (importOriginal) => {
  const real = await importOriginal<typeof LoadModule>();
  const { kindOf, routing, toSorted } = await import('./helpers/load-routing');
  const loadSegment: typeof real.loadSegment = async (ref, input, deps, options) => {
    const sorted = await toSorted(input);
    if (sorted === undefined) {
      routing.received.push(kindOf(input));
      return real.loadSegment(ref, input, deps, options);
    }
    routing.received.push('sorted');
    return real.loadSegment(ref, sorted, deps, { ...options, sorted: true });
  };
  return { ...real, loadSegment };
});

// A file on the sorted project's list that converted no load ran a third time for nothing. Fail it, so the list cannot
// claim coverage the run did not give.
afterAll(async () => {
  const { routing } = await import('./helpers/load-routing');
  if (routing.conversions === 0) {
    throw new Error(
      "this file is on the sorted project's list, and none of its loads was converted to sorted ids: route its " +
        'loads, or move it to the exclusion list with the reason',
    );
  }
});
