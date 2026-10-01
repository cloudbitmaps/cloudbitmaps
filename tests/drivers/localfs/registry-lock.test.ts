import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { WriteConflictError } from '@/core/errors';
import { LocalFsRegistryDriver, localFsRowLockCount } from '@/drivers/localfs/registry';

const SEG = { segment: 'row' };

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'crbm-reg-lock-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Two instances race a swap from one token: exactly one may win, and the loser must see a conflict. */
async function raceOne(a: LocalFsRegistryDriver, b: LocalFsRegistryDriver): Promise<void> {
  const { token } = await a.create(SEG, { currentGen: 0 });
  const results = await Promise.allSettled([
    a.compareAndSwap(SEG, token, { currentGen: 1 }),
    b.compareAndSwap(SEG, token, { currentGen: 2 }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(lost.reason).toBeInstanceOf(WriteConflictError);
}

describe('LocalFsRegistryDriver: one lock per row across the process', () => {
  it('serializes two instances on the same root', async () => {
    const root = join(base, 'same');
    await raceOne(new LocalFsRegistryDriver(root), new LocalFsRegistryDriver(root));
  });

  it('serializes a root reached through a symlink', async () => {
    const real = join(base, 'real-root');
    await mkdir(real, { recursive: true });
    const link = join(base, 'link-root');
    await symlink(real, link);
    await raceOne(new LocalFsRegistryDriver(real), new LocalFsRegistryDriver(link));
  });

  it('serializes a root given as a relative path', async () => {
    const root = join(base, 'rel-root');
    await mkdir(root, { recursive: true });
    await raceOne(
      new LocalFsRegistryDriver(root),
      new LocalFsRegistryDriver(relative(process.cwd(), root)),
    );
  });

  it('serializes a relative root whose directories do not exist yet', async () => {
    const root = join(base, 'not', 'yet');
    await raceOne(
      new LocalFsRegistryDriver(root),
      new LocalFsRegistryDriver(relative(process.cwd(), root)),
    );
  });

  it('keeps different rows independent and leaves no lock behind', async () => {
    const root = join(base, 'empties');
    const a = new LocalFsRegistryDriver(root);
    const b = new LocalFsRegistryDriver(root);
    await Promise.all([
      a.create({ segment: 'x' }, { currentGen: 0 }),
      b.create({ segment: 'y' }, { currentGen: 0 }),
      a.create({ segment: 'z' }, { currentGen: 0 }),
    ]);
    await b.delete({ segment: 'x' });
    await expect(a.compareAndSwap({ segment: 'y' }, 'wrong', { currentGen: 1 })).rejects.toThrow();
    // A failed operation releases its entry too.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(localFsRowLockCount()).toBe(0);
  });
});
