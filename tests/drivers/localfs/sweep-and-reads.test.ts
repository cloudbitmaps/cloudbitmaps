import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { randomUUID } from 'node:crypto';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { registryRowPath } from '@/drivers/localfs/paths';
import { sweepOrphanTemps } from '@/drivers/localfs/fs-util';
import { TransientError } from '@/core/errors';

const KEY = { segment: 's', generation: 1 };
const DAY = 24 * 60 * 60 * 1000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-proposed-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );
const aged = async (p: string, ageMs = 2 * DAY): Promise<string> => {
  const then = new Date(Date.now() - ageMs);
  await utimes(p, then, then);
  return p;
};

describe('sweepOrphanTemps keeps what the library did not write (kills: pattern unanchored, pattern widened to any hex-ish id, isFile check dropped)', () => {
  it('keeps look-alike names, an aged symlink and an aged directory; removes the genuine old temp', async () => {
    const dir = join(root, 'd');
    await mkdir(dir);
    const id = randomUUID();
    const genuine = await aged(await writeFileAt(join(dir, `s.1.crbm.${id}.tmp`)));
    // our name plus a suffix: someone's backup of a temp file
    const suffixed = await aged(await writeFileAt(join(dir, `s.1.crbm.${randomUUID()}.tmp.bak`)));
    // a dotted word that is not a uuid
    const shortId = await aged(await writeFileAt(join(dir, 's.1.crbm.deadbeef.tmp')));
    const dashes = await aged(await writeFileAt(join(dir, 's.1.crbm.--.tmp')));
    // a symlink with our name, itself aged (lutimes sets the link's own times, not the target's)
    const target = await aged(await writeFileAt(join(dir, 'target')));
    const link = join(dir, `s.1.crbm.${randomUUID()}.tmp`);
    await symlink(target, link);
    const then = new Date(Date.now() - 2 * DAY);
    await lutimes(link, then, then);
    // a directory with our name, aged, holding a file
    const folder = join(dir, `s.1.crbm.${randomUUID()}.tmp`);
    await mkdir(folder);
    await writeFile(join(folder, 'inner'), 'x');
    await aged(folder);

    await sweepOrphanTemps(dir);

    expect(await exists(genuine)).toBe(false);
    for (const keep of [suffixed, shortId, dashes, target, link, folder, join(folder, 'inner')]) {
      expect(await exists(keep), keep).toBe(true);
    }
  });
});

async function writeFileAt(p: string): Promise<string> {
  await writeFile(p, 'x');
  return p;
}

describe('sweepOrphanTemps never rejects, since callers `void` it (kills: catch rethrows)', () => {
  it('resolves for a missing directory and for a path that is a file', async () => {
    await expect(sweepOrphanTemps(join(root, 'nope'))).resolves.toBeUndefined();
    const file = await writeFileAt(join(root, 'file'));
    await expect(sweepOrphanTemps(file)).resolves.toBeUndefined();
  });

  it('resolves for a directory it cannot read', async () => {
    if (process.getuid?.() === 0) return; // root reads anything: nothing to prove
    const dir = join(root, 'locked');
    await mkdir(dir);
    await chmod(dir, 0o000);
    try {
      await expect(sweepOrphanTemps(dir)).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('a registry write starts the sweep itself (kills: registry write does not start a sweep)', () => {
  it('removes an old row temp that was there before the first write, without sweepOrphanTemps being called by the test', async () => {
    const rowDir = dirname(registryRowPath(join(root, 'registry'), { segment: 'r' }));
    await mkdir(rowDir, { recursive: true });
    const old = await aged(await writeFileAt(join(rowDir, `s.reg.${randomUUID()}.tmp`)));
    const registry = new LocalFsRegistryDriver(join(root, 'registry'));
    await registry.create({ segment: 'r' }, { currentGen: 0 });
    await vi.waitFor(async () => expect(await exists(old)).toBe(false));
  });
});

describe('a registry row whose temp file was removed mid-write is a TransientError (kills: ENOENT left raw at rename)', () => {
  it('rejects with TransientError and leaves no row', async () => {
    const registry = new LocalFsRegistryDriver(join(root, 'registry'));
    const probe = await open(join(root, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const original = proto.sync;
    vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      const rowDir = dirname(registryRowPath(join(root, 'registry'), { segment: 'r' }));
      for (const n of await readdir(rowDir)) if (n.endsWith('.tmp')) await rm(join(rowDir, n));
      return original.call(this);
    });
    await expect(registry.create({ segment: 'r' }, { currentGen: 0 })).rejects.toBeInstanceOf(
      TransientError,
    );
    vi.restoreAllMocks();
    expect(await registry.get({ segment: 'r' })).toBeNull();
  });
});

describe('a read that returns a few bytes at a time still returns the right bytes (kills: read offset not advanced)', () => {
  it('getRange and getTail over reads of at most 2 bytes', async () => {
    const driver = new LocalFsStorageDriver(join(root, 'storage'));
    await driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(10, 11, 12, 13, 14, 15)));
    const probe = await open(join(root, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as {
      read: (...a: unknown[]) => Promise<unknown>;
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
      return original.call(this, buffer, offset, Math.min(2, length as number), position);
    });
    expect([...(await driver.getRange(KEY, 1, 4))]).toEqual([11, 12, 13, 14]);
    expect([...(await driver.getTail(KEY, 5)).bytes]).toEqual([11, 12, 13, 14, 15]);
  });
});
