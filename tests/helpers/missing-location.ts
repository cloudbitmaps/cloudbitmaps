import { CloudRoaring, errorKind } from '@/index';
import type { StorageBackend } from '@cloudbitmaps/core';

/**
 * What a backend whose bucket or container does not exist must do: fail each call with a `ValidationError` (a wiring
 * fault) that names the location, says what to check and carries the service's error as its `cause`. It is neither an
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

function notAbsent(err: unknown, name: string): void {
  expect(err).toBeInstanceOf(Error);
  expect(errorKind(err)).not.toBe('NotFoundError');
  expect(errorKind(err)).not.toBe('TransientError');
  expect(errorKind(err)).toBe('ValidationError');
  const { message, cause } = err as Error;
  expect(message).toContain(`does not exist: ${name}; check `);
  expect(message).not.toContain('stand-in'); // the stubs' credentials
  expect(cause).toBeInstanceOf(Error);
}

/** Drain a listing, so its failure surfaces. */
async function drain(listing: AsyncIterable<unknown>): Promise<void> {
  for await (const item of listing) void item;
}

/**
 * `backend()` builds a fresh backend over the missing location each time it is called; `name` is the bucket or
 * container it names, which the error must carry.
 */
export async function expectMissingLocationFails(
  backend: () => StorageBackend,
  name = 'missing',
): Promise<void> {
  const store = new CloudRoaring({ storage: backend(), retry: false });
  const seg = store.segment('s');
  notAbsent(await failure(() => seg.has(5)), name);
  notAbsent(await failure(() => seg.count()), name);
  const direct = backend();
  notAbsent(await failure(() => direct.registry.get({ segment: 's' })), name);
  notAbsent(await failure(() => drain(direct.registry.list())), name);
  notAbsent(await failure(() => direct.registry.create({ segment: 's' }, { currentGen: 0 })), name);
  notAbsent(await failure(() => direct.storage.getRange(GEN, 0, 8)), name);
  notAbsent(await failure(() => direct.storage.getTail(GEN, 8)), name);
  notAbsent(await failure(() => direct.storage.delete(GEN)), name);
  notAbsent(await failure(() => drain(direct.storage.list({ segment: 's' }))), name);
  notAbsent(
    await failure(() =>
      direct.storage.putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array([1]));
      }),
    ),
    name,
  );
}

/** The control: in a location that exists, a missing row, object and delete still read as absent. */
export async function expectMissingObjectIsAbsent(backend: () => StorageBackend): Promise<void> {
  const direct = backend();
  expect(await direct.registry.get({ segment: 's' })).toBeNull();
  expect(errorKind(await failure(() => direct.storage.getRange(GEN, 0, 8)))).toBe('NotFoundError');
  await expect(direct.storage.delete(GEN)).resolves.toBeUndefined();
  const store = new CloudRoaring({ storage: backend(), retry: false });
  expect(await store.segment('s').has(5)).toBe(false);
}
