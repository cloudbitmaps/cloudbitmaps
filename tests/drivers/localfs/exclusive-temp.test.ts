import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A queue of ids the next temp names will use, falling back to the real generator, so a test can plant a file at the
// name a write is about to choose.
const uuids: string[] = [];
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuids.shift() ?? actual.randomUUID() };
});

import { randomUUID } from 'node:crypto';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { storageObjectPath } from '@/drivers/localfs/paths';

const KEY = { segment: 's', generation: 1 };
let root: string;

beforeEach(async () => {
  uuids.length = 0;
  root = await mkdtemp(join(tmpdir(), 'cbm-excl-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe('the temp file is created exclusively (kills: O_EXCL dropped)', () => {
  it('a file already at the temp name is neither truncated nor written through', async () => {
    const storage = join(root, 'storage');
    const driver = new LocalFsStorageDriver(storage);
    const id = randomUUID();
    const final = storageObjectPath(storage, KEY);
    await mkdir(dirname(final), { recursive: true });
    const planted = `${final}.${id}.tmp`;
    await writeFile(planted, 'planted');
    uuids.push(id);
    await expect(
      driver.putImmutable(KEY, (sink) => sink.write(Uint8Array.of(1, 2, 3))),
    ).rejects.toBeDefined();
    expect(await readFile(planted, 'utf8')).toBe('planted');
    expect(await exists(final)).toBe(false);
  });
});
