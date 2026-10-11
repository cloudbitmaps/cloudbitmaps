import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, open, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { storageObjectPath } from '@/drivers/localfs/paths';
import { sweepOrphanTemps } from '@/drivers/localfs/fs-util';
import { IntegrityError, TransientError } from '@/core/errors';

const KEY = { segment: 's', generation: 1 };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-short-read-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Make every positional read return one byte fewer than asked, as a truncated file or a network filesystem can. */
async function shortenReads(): Promise<void> {
  const probe = await open(join(root, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as {
    read: (...a: unknown[]) => Promise<{ bytesRead: number; buffer: unknown }>;
  };
  await probe.close();
  const original = proto.read;
  vi.spyOn(proto, 'read').mockImplementation(function (
    this: unknown,
    buffer: unknown,
    offset: unknown,
    length: unknown,
    position: unknown,
  ) {
    return original.call(this, buffer, offset, Math.max(0, (length as number) - 1), position);
  });
}

describe('LocalFs storage reads', () => {
  it('a short getRange is an IntegrityError, not zero-padded bytes', async () => {
    const driver = new LocalFsStorageDriver(root);
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
    await shortenReads();
    await expect(driver.getRange(KEY, 0, 4)).rejects.toBeInstanceOf(IntegrityError);
  }, 5000);

  it('a short getTail is an IntegrityError, not zero-padded bytes', async () => {
    const driver = new LocalFsStorageDriver(root);
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
    await shortenReads();
    await expect(driver.getTail(KEY, 4)).rejects.toBeInstanceOf(IntegrityError);
  }, 5000);
});

describe('LocalFs orphan temp files', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const tmpName = (final: string): string => `${final}.${randomUUID()}.tmp`;

  async function plant(path: string, ageMs: number): Promise<string> {
    await writeFile(path, 'x');
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
    return path;
  }
  const dirOf = async (): Promise<string> => {
    const dir = dirname(storageObjectPath(root, KEY));
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  it('removes the old temp files this driver names, and keeps everything else', async () => {
    const dir = await dirOf();
    const final = storageObjectPath(root, KEY);
    const old = await plant(tmpName(final), 2 * DAY);
    const oldRow = await plant(tmpName(join(dir, 's.reg')), 2 * DAY);
    const fresh = await plant(tmpName(final), 60 * 1000);
    const foreign = await plant(join(dir, 'notes.tmp'), 2 * DAY);
    const target = await plant(join(dir, 'target'), 2 * DAY);
    await sweepOrphanTemps(dir);
    expect(await exists(old)).toBe(false);
    expect(await exists(oldRow)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(foreign)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it('sweeps a directory at most once an hour', async () => {
    const dir = await dirOf();
    const final = storageObjectPath(root, KEY);
    const now = Date.now();
    await sweepOrphanTemps(dir, now);
    const old = await plant(tmpName(final), 2 * DAY);
    await sweepOrphanTemps(dir, now + 60 * 1000);
    expect(await exists(old)).toBe(true);
    await sweepOrphanTemps(dir, now + 2 * 60 * 60 * 1000);
    expect(await exists(old)).toBe(false);
  });

  it('a write starts a sweep without waiting for it', async () => {
    const driver = new LocalFsStorageDriver(root);
    const dir = await dirOf();
    const old = await plant(tmpName(storageObjectPath(root, KEY)), 2 * DAY);
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1)));
    await vi.waitFor(async () => expect(await exists(old)).toBe(false));
    expect(await exists(dir)).toBe(true);
  });

  it('a write whose sink fails leaves no temp file behind', async () => {
    const driver = new LocalFsStorageDriver(root);
    await expect(
      driver.putImmutable(KEY, async () => {
        throw new Error('boom');
      }),
    ).rejects.toBeDefined();
    const dir = dirname(storageObjectPath(root, KEY));
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a write whose temp file was removed meanwhile is a TransientError, not a raw error', async () => {
    const driver = new LocalFsStorageDriver(root);
    const dir = dirname(storageObjectPath(root, KEY));
    await expect(
      driver.putImmutable(KEY, async (sink) => {
        await sink.write(Uint8Array.of(1));
        for (const name of await readdir(dir)) if (name.endsWith('.tmp')) await rm(join(dir, name));
      }),
    ).rejects.toBeInstanceOf(TransientError);
  });
});
