import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalFsColdDriver } from '@/drivers/localfs/cold';
import { coldObjectPath, segmentsDir } from '@/drivers/localfs/paths';
import type { BlobSink } from '@/core/blob';
import type { GenKey } from '@/core/ports';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';

let root: string;
let driver: LocalFsColdDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-cold-'));
  driver = new LocalFsColdDriver(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const KEY: GenKey = { segment: 's', generation: 1 };
const writeBytes =
  (...parts: Uint8Array[]) =>
  async (sink: BlobSink): Promise<void> => {
    for (const p of parts) await sink.write(p);
  };

describe('LocalFsColdDriver', () => {
  it('advertises range-read capability', () => {
    expect(driver.capabilities().rangeRead).toBe(true);
  });

  it('writes a generation and reports its size + sha256', async () => {
    const body = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
    const { size, sha256 } = await driver.putImmutable(
      KEY,
      writeBytes(body.subarray(0, 4), body.subarray(4)),
    );
    expect(size).toBe(7);
    expect(sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('round-trips via getRange and getTail', async () => {
    const body = Uint8Array.from({ length: 50 }, (_v, i) => i);
    await driver.putImmutable(KEY, writeBytes(body));
    expect([...(await driver.getRange(KEY, 10, 4))]).toEqual([10, 11, 12, 13]);
    const tail = await driver.getTail(KEY, 8);
    expect(tail.size).toBe(50);
    expect([...tail.bytes]).toEqual([42, 43, 44, 45, 46, 47, 48, 49]);
    // tail larger than the file returns the whole file.
    expect((await driver.getTail(KEY, 1000)).bytes.length).toBe(50);
  });

  it('rejects an out-of-range read', async () => {
    await driver.putImmutable(KEY, writeBytes(Uint8Array.of(1, 2, 3)));
    await expect(driver.getRange(KEY, 2, 5)).rejects.toBeInstanceOf(ValidationError);
    await expect(driver.getRange(KEY, -1, 1)).rejects.toBeInstanceOf(ValidationError);
  });

  it('is write-once: a second put on the same key is rejected (conflict)', async () => {
    await driver.putImmutable(KEY, writeBytes(Uint8Array.of(1)));
    await expect(driver.putImmutable(KEY, writeBytes(Uint8Array.of(2)))).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    // the original is intact
    expect([...(await driver.getRange(KEY, 0, 1))]).toEqual([1]);
  });

  it('reads of a missing generation raise NotFoundError', async () => {
    await expect(driver.getRange(KEY, 0, 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(driver.getTail(KEY, 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists generations and supports idempotent delete', async () => {
    await driver.putImmutable({ segment: 's', generation: 1 }, writeBytes(Uint8Array.of(1)));
    await driver.putImmutable({ segment: 's', generation: 4 }, writeBytes(Uint8Array.of(1)));
    await driver.putImmutable({ segment: 'other', generation: 9 }, writeBytes(Uint8Array.of(1)));

    const gens: number[] = [];
    for await (const k of driver.list({ segment: 's' })) gens.push(k.generation);
    expect(gens.sort((a, b) => a - b)).toEqual([1, 4]); // not 'other'

    await driver.delete({ segment: 's', generation: 1 });
    await driver.delete({ segment: 's', generation: 1 }); // no-op, no throw
    const after: number[] = [];
    for await (const k of driver.list({ segment: 's' })) after.push(k.generation);
    expect(after).toEqual([4]);
  });

  it('list of a never-written segment is empty', async () => {
    const gens: GenKey[] = [];
    for await (const k of driver.list({ segment: 'ghost' })) gens.push(k);
    expect(gens).toEqual([]);
  });

  it('two concurrent puts on the same key: exactly one wins, no temp left', async () => {
    const results = await Promise.allSettled([
      driver.putImmutable(KEY, writeBytes(Uint8Array.of(1))),
      driver.putImmutable(KEY, writeBytes(Uint8Array.of(2))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WriteConflictError);
    const names = await readdir(segmentsDir(root, KEY));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a failing write callback cleans up the temp file and rethrows', async () => {
    const boom = new Error('boom');
    await expect(driver.putImmutable(KEY, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await readdir(segmentsDir(root, KEY))).toEqual([]); // no temp, no final
  });

  it('allows zero-length reads at and within bounds', async () => {
    await driver.putImmutable(KEY, writeBytes(Uint8Array.of(1, 2, 3)));
    expect((await driver.getRange(KEY, 0, 0)).length).toBe(0);
    expect((await driver.getRange(KEY, 3, 0)).length).toBe(0); // offset == size, len 0
  });

  it('list ignores orphan temp, foreign, and non-canonical files', async () => {
    await driver.putImmutable({ segment: 's', generation: 2 }, writeBytes(Uint8Array.of(1)));
    const dir = segmentsDir(root, { segment: 's' });
    await writeFile(join(dir, 's.5.crbm.abc123.tmp'), 'x'); // orphan temp
    await writeFile(join(dir, 'README.txt'), 'x'); // foreign
    await writeFile(join(dir, 's.07.crbm'), 'x'); // non-canonical (leading zero)
    const gens: number[] = [];
    for await (const k of driver.list({ segment: 's' })) gens.push(k.generation);
    expect(gens).toEqual([2]);
  });

  it('refuses to follow a symlink at the object path', async () => {
    const secret = join(root, 'secret.bin');
    await writeFile(secret, 'topsecret');
    const target = coldObjectPath(root, KEY);
    await mkdir(dirname(target), { recursive: true });
    await symlink(secret, target);
    await expect(driver.getRange(KEY, 0, 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('isolates two named namespaces sharing a segment+generation', async () => {
    await driver.putImmutable(
      { namespace: 'acme', segment: 's', generation: 1 },
      writeBytes(Uint8Array.of(1)),
    );
    await driver.putImmutable(
      { namespace: 'globex', segment: 's', generation: 1 },
      writeBytes(Uint8Array.of(2)),
    );
    expect([
      ...(await driver.getRange({ namespace: 'acme', segment: 's', generation: 1 }, 0, 1)),
    ]).toEqual([1]);
    expect([
      ...(await driver.getRange({ namespace: 'globex', segment: 's', generation: 1 }, 0, 1)),
    ]).toEqual([2]);
  });

  it('isolates namespaces and rejects traversal in names', async () => {
    await driver.putImmutable(
      { namespace: 'acme', segment: 's', generation: 1 },
      writeBytes(Uint8Array.of(7)),
    );
    // a different namespace doesn't see it
    const gens: number[] = [];
    for await (const k of driver.list({ segment: 's' })) gens.push(k.generation);
    expect(gens).toEqual([]);
    await expect(
      driver.getRange({ namespace: '../../etc', segment: 's', generation: 1 }, 0, 1),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
