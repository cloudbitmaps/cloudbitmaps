import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring, LocalFsStorage, ValidationError } from '@/index';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';

/**
 * A name inside the 256-character cap can still make a file name the filesystem refuses once the generation, the
 * suffix and the temp file's unique part are added (255 bytes on the common filesystems). That is a typed refusal
 * before any write, never a raw `ENAMETOOLONG`, and no message carries the absolute storage root.
 */
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-long-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fill = (n: number): string => 'x'.repeat(n);
const put = (driver: LocalFsStorageDriver, segment: string, generation = 0) =>
  driver.putImmutable({ segment, generation }, async (sink) => {
    await sink.write(new Uint8Array([1]));
  });
const refusal = async (run: () => Promise<unknown>): Promise<Error> => {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).not.toContain(root);
  expect((err as Error).message).toMatch(/too long for a file name/);
  return err as Error;
};
/** Every file and directory under the root, so "nothing was written" is checked at any depth. */
const entries = async (): Promise<string[]> => (await readdir(root, { recursive: true })).sort();

describe('LocalFs: a name too long for the derived file names', () => {
  it('a storage object whose temp file name would pass 255 bytes is refused before anything is written', async () => {
    const driver = new LocalFsStorageDriver(root);
    // `<name>.0.crbm.<36>.tmp` is the name and 48 more.
    await refusal(() => put(driver, fill(208)));
    expect(await entries()).toEqual([]);
    await put(driver, fill(207));
    expect((await entries()).length).toBeGreaterThan(0);
  });

  it('a longer generation number counts against the same limit', async () => {
    const driver = new LocalFsStorageDriver(root);
    await refusal(() => put(driver, fill(204), 12_345_678));
    await put(driver, fill(200), 1);
  });

  it('a registry row whose temp file name would pass 255 bytes is refused before anything is written', async () => {
    const registry = new LocalFsRegistryDriver(root);
    await refusal(() => registry.create({ segment: fill(211) }, { currentGen: null }));
    expect(await entries()).toEqual([]);
    await registry.create({ segment: fill(210) }, { currentGen: null });
  });

  it('a namespace whose directory name passes 255 bytes is refused', async () => {
    const driver = new LocalFsStorageDriver(root);
    await refusal(() =>
      driver.putImmutable({ namespace: fill(256), segment: 's', generation: 0 }, async () => {}),
    );
    expect(await entries()).toEqual([]);
  });

  it('through the store, a load of such a name fails typed and leaves nothing behind', async () => {
    const store = new CloudRoaring({ storage: new LocalFsStorage(root) });
    await refusal(() => store.load({ segment: fill(230) }, [1, 2, 3]));
    expect(await entries()).toEqual([]);
  });

  it('a read of such a name is an absent segment, with no raw filesystem error', async () => {
    const store = new CloudRoaring({ storage: new LocalFsStorage(root) });
    for (const n of [230, 250, 256]) {
      const seg = store.segment(fill(n));
      expect(await seg.count()).toBe(0);
      expect(await seg.has(1)).toBe(false);
    }
  });
});
