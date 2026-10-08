import { CloudRoaring, isNotFoundError, isTransientError } from '@/index';
import type { StorageBackend } from '@cloudbitmaps/core';

/**
 * What a backend whose bucket or container does not exist must do: fail each call with an error that is neither an
 * absent row (`null`), an absent object (`NotFoundError`) nor a fault worth retrying (`TransientError`). Read as an
 * absence, a misnamed or deleted bucket would answer every read as an empty segment.
 */

const GEN = { segment: 's', generation: 0 };

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

function notAbsent(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect(isNotFoundError(err)).toBe(false);
  expect(isTransientError(err)).toBe(false);
}

/** `backend()` builds a fresh backend over the missing location each time it is called. */
export async function expectMissingLocationFails(backend: () => StorageBackend): Promise<void> {
  const store = new CloudRoaring({ storage: backend(), retry: false });
  const seg = store.segment('s');
  notAbsent(await failure(() => seg.has(5)));
  notAbsent(await failure(() => seg.count()));
  const direct = backend();
  notAbsent(await failure(() => direct.registry.get({ segment: 's' })));
  notAbsent(await failure(() => direct.storage.getRange(GEN, 0, 8)));
  notAbsent(await failure(() => direct.storage.getTail(GEN, 8)));
  notAbsent(await failure(() => direct.storage.delete(GEN)));
}

/** The control: in a location that exists, a missing row, object and delete still read as absent. */
export async function expectMissingObjectIsAbsent(backend: () => StorageBackend): Promise<void> {
  const direct = backend();
  expect(await direct.registry.get({ segment: 's' })).toBeNull();
  expect(isNotFoundError(await failure(() => direct.storage.getRange(GEN, 0, 8)))).toBe(true);
  await expect(direct.storage.delete(GEN)).resolves.toBeUndefined();
  const store = new CloudRoaring({ storage: backend(), retry: false });
  expect(await store.segment('s').has(5)).toBe(false);
}
