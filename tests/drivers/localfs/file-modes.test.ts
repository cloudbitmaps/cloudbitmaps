import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsStorage } from '@/index';

/**
 * A segment holds cleartext bitmaps, so on a shared machine only the owner may read or list what LocalFs stores. Modes
 * mean nothing on Windows, where the check does not run.
 */
const posix = process.platform !== 'win32';
let dir: string;
let previousUmask: number;

beforeEach(async () => {
  previousUmask = process.umask(0o022);
  dir = await mkdtemp(join(tmpdir(), 'cbm-modes-'));
});
afterEach(async () => {
  process.umask(previousUmask);
  await rm(dir, { recursive: true, force: true });
});

async function walk(path: string): Promise<Array<{ path: string; mode: number; dir: boolean }>> {
  const out: Array<{ path: string; mode: number; dir: boolean }> = [];
  for (const name of await readdir(path)) {
    const full = join(path, name);
    const info = await stat(full);
    out.push({ path: full, mode: info.mode & 0o777, dir: info.isDirectory() });
    if (info.isDirectory()) out.push(...(await walk(full)));
  }
  return out;
}

describe.skipIf(!posix)('LocalFs creates what it stores owner-only, whatever the umask', () => {
  it('objects, rows and every directory under the root', async () => {
    const root = join(dir, 'data', 'nested');
    const backend = new LocalFsStorage(root);
    await backend.storage.putImmutable({ segment: 's', generation: 0 }, (sink) =>
      sink.write(Uint8Array.of(1, 2, 3)),
    );
    await backend.registry.create({ segment: 's' }, { currentGen: 0 });
    const entries = await walk(root);
    expect(entries.length).toBeGreaterThan(4);
    for (const e of entries) expect(e.mode, e.path).toBe(e.dir ? 0o700 : 0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it('only the root and what is below it are private: missing parents above the root keep the default', async () => {
    const root = join(dir, 'a', 'b', 'root');
    const backend = new LocalFsStorage(root);
    await backend.registry.create({ segment: 's' }, { currentGen: 0 });
    expect((await stat(join(dir, 'a'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, 'a', 'b'))).mode & 0o777).toBe(0o755);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it('a directory that already exists keeps its mode, and a rewritten row is private', async () => {
    const root = join(dir, 'wide');
    await mkdir(join(root, 'registry', '_default'), { recursive: true });
    await chmod(join(root, 'registry', '_default'), 0o755);
    const backend = new LocalFsStorage(root);
    const { token } = await backend.registry.create({ segment: 's' }, { currentGen: 0 });
    expect((await stat(join(root, 'registry', '_default'))).mode & 0o777).toBe(0o755);
    await backend.registry.compareAndSwap({ segment: 's' }, token, { currentGen: 1 });
    for (const e of (await walk(join(root, 'registry'))).filter((x) => !x.dir)) {
      expect(e.mode, e.path).toBe(0o600);
    }
  });
});
