import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';

/**
 * One `FileHandle.write` can write fewer bytes than it was asked to and not fail: on a full disk, past a quota, on some
 * network filesystems. The LocalFs drivers write every byte, so a row or an object is stored whole or not at all. Here
 * the real `write` is made to write at most 7 bytes a call.
 */
let dir: string;
let restore: (() => void) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cbm-short-'));
  const probe = await open(join(dir, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as {
    write: (...a: unknown[]) => Promise<{ bytesWritten: number }>;
  };
  await probe.close();
  const original = proto.write;
  proto.write = function (
    this: unknown,
    buffer: unknown,
    offset?: unknown,
    length?: unknown,
    ...rest: unknown[]
  ) {
    const bytes = buffer as Uint8Array;
    const from = typeof offset === 'number' ? offset : 0;
    const asked = typeof length === 'number' ? length : bytes.length - from;
    return original.call(this, bytes, from, Math.min(asked, 7), ...rest);
  };
  restore = () => {
    proto.write = original;
  };
});

afterEach(async () => {
  restore?.();
  await rm(dir, { recursive: true, force: true });
});

describe('a LocalFs write that the filesystem shortens', () => {
  it('putImmutable stores every byte it reports', async () => {
    const storage = new LocalFsStorageDriver(join(dir, 'storage'));
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const put = await storage.putImmutable({ segment: 's', generation: 0 }, async (sink) => {
      await sink.write(bytes.subarray(0, 500));
      await sink.write(bytes.subarray(500));
    });
    expect(put.size).toBe(1000);
    const tail = await storage.getTail({ segment: 's', generation: 0 }, 2000);
    expect(tail.size).toBe(1000);
    expect(Buffer.from(tail.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a registry row is stored whole, and reads back', async () => {
    const registry = new LocalFsRegistryDriver(join(dir, 'registry'));
    const { token } = await registry.create({ segment: 's' }, { currentGen: 0 });
    expect(await registry.get({ segment: 's' })).toMatchObject({ currentGen: 0, token });
    const raw = await readFile(join(dir, 'registry', '_default', 's.reg')).catch(() => null);
    if (raw !== null) expect(() => JSON.parse(raw.toString('utf8')) as unknown).not.toThrow();
  });
});

describe('what a refused registry row puts in its message', () => {
  it('a hostile stored value is shown cut short, and the row by its path under the root, not the absolute one', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    restore?.();
    restore = undefined;
    const registry = new LocalFsRegistryDriver(join(dir, 'registry'));
    await registry.create({ segment: 's' }, { currentGen: 0 });
    const file = join(dir, 'registry', '_default', 'registry', 's.reg');
    const row = JSON.parse(await readFile(file, 'utf8')) as { record: Record<string, unknown> };
    row.record.status = 'x'.repeat(1_000_000);
    await mkdir(join(dir, 'registry', '_default', 'registry'), { recursive: true });
    await writeFile(file, JSON.stringify(row));
    const err = await registry.get({ segment: 's' }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeLessThan(400);
    expect((err as Error).message).not.toContain(dir);
    expect((err as Error).message).toContain('s.reg');
  });
});
