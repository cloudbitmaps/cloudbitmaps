import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { storageObjectPath } from '@/drivers/localfs/paths';
import { IntegrityError } from '@/core/errors';

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
  });

  it('a short getTail is an IntegrityError, not zero-padded bytes', async () => {
    const driver = new LocalFsStorageDriver(root);
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3, 4)));
    await shortenReads();
    await expect(driver.getTail(KEY, 4)).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('LocalFs orphan temp files', () => {
  async function plantOrphan(ageMs: number): Promise<string> {
    const final = storageObjectPath(root, KEY);
    await mkdir(dirname(final), { recursive: true });
    const orphan = `${final}.00000000-0000-4000-8000-000000000000.tmp`;
    await writeFile(orphan, 'x');
    const then = new Date(Date.now() - ageMs);
    await utimes(orphan, then, then);
    return orphan;
  }

  it('a write sweeps an old temp file beside its object and keeps a recent one', async () => {
    const driver = new LocalFsStorageDriver(root);
    const old = await plantOrphan(2 * 60 * 60 * 1000);
    const recent = `${old.replace('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111')}`;
    await writeFile(recent, 'y');
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1)));
    const names = await readdir(dirname(old));
    expect(names.some((n) => n.includes('00000000-0000-4000'))).toBe(false);
    expect(names.some((n) => n.includes('11111111-1111-4111'))).toBe(true);
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
});
