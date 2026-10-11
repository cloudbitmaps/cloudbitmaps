import { MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { ValidationError } from '@/core/errors';
import type { IStorageDriver } from '@/core/ports';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = { segment: 's', generation: 1 };

const DRIVERS: [string, () => Promise<{ driver: IStorageDriver; done: () => Promise<void> }>][] = [
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
];

describe.each(DRIVERS)('getTail length checks: %s', (_label, make) => {
  it.each([
    [Number.NaN],
    [1.5],
    [-1.5],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    [2 ** 53],
    [-(2 ** 53)],
    [2 ** 60],
  ])('refuses a tail length of %s with a ValidationError', async (length) => {
    const { driver, done } = await make();
    try {
      await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
      await expect(driver.getTail(KEY, length)).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await done();
    }
  });

  it('still answers 0, a length inside the object and a length past it', async () => {
    const { driver, done } = await make();
    try {
      await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
      expect((await driver.getTail(KEY, 0)).bytes.length).toBe(0);
      const negative = await driver.getTail(KEY, -1);
      expect([negative.bytes.length, negative.size]).toEqual([0, 4]);
      expect((await driver.getTail(KEY, Number.MAX_SAFE_INTEGER)).bytes.length).toBe(4);
      expect([...(await driver.getTail(KEY, 2)).bytes]).toEqual([3, 4]);
      expect([...(await driver.getTail(KEY, 99)).bytes]).toEqual([1, 2, 3, 4]);
    } finally {
      await done();
    }
  });
});

describe.each(DRIVERS)('number checks on a range and a generation: %s', (_label, make) => {
  it.each([0.5, -1, 1.5, 2 ** 53, Number.NaN])(
    'refuses a range offset of %s on an object that exists',
    async (offset) => {
      const { driver, done } = await make();
      try {
        await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
        await expect(driver.getRange(KEY, offset, 1)).rejects.toThrow(
          `range offset must be an integer of at least 0; got ${offset}`,
        );
      } finally {
        await done();
      }
    },
  );

  it.each([1.5, -1, 2 ** 53, Number.NaN])(
    'refuses a range length of %s on an object that exists',
    async (length) => {
      const { driver, done } = await make();
      try {
        await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
        await expect(driver.getRange(KEY, 2, length)).rejects.toThrow(
          `range length must be an integer of at least 0; got ${length}`,
        );
      } finally {
        await done();
      }
    },
  );

  it('answers a range inside the object, an empty one included', async () => {
    const { driver, done } = await make();
    try {
      await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
      expect([...(await driver.getRange(KEY, 1, 2))]).toEqual([2, 3]);
      expect((await driver.getRange(KEY, 0, 0)).length).toBe(0);
    } finally {
      await done();
    }
  });

  it.each([-1, 1.5, 2 ** 53])(
    'refuses a generation of %s on a write and on a read',
    async (generation) => {
      const { driver, done } = await make();
      try {
        const key = { segment: 's', generation };
        const wording = `generation must be an integer of at least 0; got ${generation}`;
        await expect(
          driver.putImmutable(key, (sink) => sink.write(Uint8Array.of(1))),
        ).rejects.toThrow(wording);
        await expect(driver.getRange(key, 0, 1)).rejects.toThrow(wording);
      } finally {
        await done();
      }
    },
  );
});
