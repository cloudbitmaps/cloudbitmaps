import { MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { ValidationError } from '@/core/errors';
import type { IStorageDriver } from '@/core/ports';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = { segment: 's', generation: 1 };

describe.each([
  [
    'memory',
    async () => ({ driver: new MemoryStorageDriver() as IStorageDriver, done: async () => {} }),
  ],
  [
    'localfs',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cbm-tail-'));
      return {
        driver: new LocalFsStorageDriver(root) as IStorageDriver,
        done: () => rm(root, { recursive: true, force: true }),
      };
    },
  ],
])('getTail length checks: %s', (_label, make) => {
  it.each([[Number.NaN], [1.5], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    'refuses a tail length of %s with a ValidationError',
    async (length) => {
      const { driver, done } = await make();
      try {
        await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
        await expect(driver.getTail(KEY, length)).rejects.toBeInstanceOf(ValidationError);
      } finally {
        await done();
      }
    },
  );

  it('still answers 0, a length inside the object and a length past it', async () => {
    const { driver, done } = await make();
    try {
      await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
      expect((await driver.getTail(KEY, 0)).bytes.length).toBe(0);
      const negative = await driver.getTail(KEY, -1);
      expect([negative.bytes.length, negative.size]).toEqual([0, 4]);
      expect((await driver.getTail(KEY, 2 ** 60)).bytes.length).toBe(4);
      expect([...(await driver.getTail(KEY, 2)).bytes]).toEqual([3, 4]);
      expect([...(await driver.getTail(KEY, 99)).bytes]).toEqual([1, 2, 3, 4]);
    } finally {
      await done();
    }
  });
});
