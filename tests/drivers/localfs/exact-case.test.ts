import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, win32 } from 'node:path';
import { CloudRoaring, LocalFsStorage, ValidationError } from '@/index';
import { ExactCase, firstCaseDifference, isOutside } from '@/drivers/localfs/exact-case';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';

/**
 * On a case-insensitive filesystem (the macOS and Windows defaults) two names that differ only by case would name one
 * file. LocalFs resolves the name actually on disk and compares it exactly: a mis-cased name reads as absent, and a
 * write that would land on an existing case variant is refused.
 */
describe('firstCaseDifference: the comparison of a path with the one on disk', () => {
  it('is -1 when every component matches exactly', () => {
    expect(firstCaseDifference(['a', 'B', 'c.1.crbm'], ['a', 'B', 'c.1.crbm'])).toBe(-1);
    expect(firstCaseDifference([], [])).toBe(-1);
  });

  it('is the index of the first component that differs only by case', () => {
    expect(firstCaseDifference(['tenanta', 'segments', 'f'], ['TenantA', 'segments', 'f'])).toBe(0);
    expect(
      firstCaseDifference(['TenantA', 'segments', 'F.1.crbm'], ['TenantA', 'segments', 'f.1.crbm']),
    ).toBe(2);
    expect(firstCaseDifference(['a', 'b', 'c'], ['a', 'B', 'C'])).toBe(1);
  });

  it('does not call a different name, or a missing tail, a case difference', () => {
    expect(firstCaseDifference(['a', 'b'], ['a', 'other'])).toBe(-1);
    expect(firstCaseDifference(['a', 'b', 'c'], ['a', 'b'])).toBe(-1);
    expect(firstCaseDifference(['a'], ['a', 'b'])).toBe(-1);
  });
});

/** Whether the temp root is case-insensitive: a file written with one case is found by another. */
async function insensitive(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'crbm-case-probe-'));
  try {
    await writeFile(join(dir, 'Probe'), 'x');
    return await stat(join(dir, 'pROBE')).then(
      () => true,
      () => false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const INSENSITIVE = await insensitive();
const TITLE = INSENSITIVE
  ? 'LocalFs on a case-insensitive filesystem'
  : 'LocalFs on a case-insensitive filesystem (skipped here: this temp root is case-sensitive, so no two names alias)';

// CI's macOS job sets CB_EXPECT_CASE_INSENSITIVE=1: a runner image whose temp root turns out case-sensitive fails here
// rather than skipping the suite below and going green having tested nothing.
it.runIf(process.env.CB_EXPECT_CASE_INSENSITIVE === '1')(
  'the temp root is case-insensitive, as this run expects',
  () => {
    expect(INSENSITIVE).toBe(true);
  },
);

describe.skipIf(!INSENSITIVE)(TITLE, () => {
  let root: string;
  let store: CloudRoaring;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crbm-case-'));
    store = new CloudRoaring({ storage: new LocalFsStorage(root) });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const counted = (namespace: string, segment: string): Promise<number> =>
    store.segment(segment, { namespace }).count();

  it('a name in another case reads as absent, in the namespace and the segment', async () => {
    await store.load({ namespace: 'TenantA', segment: 'audience' }, [1, 2, 3]);
    expect(await counted('TenantA', 'audience')).toBe(3);
    expect(await counted('tenanta', 'audience')).toBe(0);
    expect(await counted('TenantA', 'AUDIENCE')).toBe(0);
    expect(await counted('tenanta', 'AUDIENCE')).toBe(0);
    expect(await store.segment('audience', { namespace: 'tenanta' }).has(1)).toBe(false);
  });

  it('a write that would land on an existing case variant is refused, and changes nothing', async () => {
    await store.load({ namespace: 'TenantA', segment: 'audience' }, [1, 2, 3]);
    for (const ref of [
      { namespace: 'tenanta', segment: 'audience' },
      { namespace: 'TenantA', segment: 'Audience' },
    ]) {
      const err = await store.load(ref, [9]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(
        /differ only by case on a case-insensitive filesystem/,
      );
      expect((err as Error).message).not.toContain(root);
    }
    expect(await counted('TenantA', 'audience')).toBe(3);
  });

  it('names that differ in more than case, and the exact name itself, still work', async () => {
    await store.load({ namespace: 'TenantA', segment: 'audience' }, [1]);
    await store.load({ namespace: 'TenantA', segment: 'audience' }, [1, 2]);
    await store.load({ namespace: 'TenantB', segment: 'audience' }, [5]);
    await store.load({ namespace: 'TenantA', segment: 'other' }, [7, 8, 9]);
    expect(await counted('TenantA', 'audience')).toBe(2);
    expect(await counted('TenantB', 'audience')).toBe(1);
    expect(await counted('TenantA', 'other')).toBe(3);
  });

  it('the registry: a case variant reads as absent, is refused on create, and a delete leaves the row', async () => {
    const registry = new LocalFsRegistryDriver(join(root, 'reg'));
    await registry.create({ segment: 'Seg' }, { currentGen: 0 });
    expect(await registry.get({ segment: 'seg' })).toBeNull();
    await expect(registry.create({ segment: 'seg' }, { currentGen: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await registry.delete({ segment: 'seg' });
    expect((await registry.get({ segment: 'Seg' }))?.currentGen).toBe(0);
    await registry.create({ namespace: 'NS', segment: 'a' }, { currentGen: 0 });
    const seen: string[] = [];
    for await (const row of registry.list('ns')) seen.push(row.segment);
    expect(seen).toEqual([]);
  });

  it('the storage driver: a delete or a listing in another case touches nothing', async () => {
    const storage = new LocalFsStorageDriver(join(root, 'obj'));
    const key = { namespace: 'NS', segment: 'Seg', generation: 1 };
    await storage.putImmutable(key, async (sink) => {
      await sink.write(new Uint8Array([1, 2, 3]));
    });
    await storage.delete({ ...key, namespace: 'ns' });
    await storage.delete({ ...key, segment: 'seg' });
    expect((await storage.getTail(key, 8)).size).toBe(3);
    const listed: number[] = [];
    for await (const k of storage.list({ namespace: 'ns', segment: 'Seg' }))
      listed.push(k.generation);
    for await (const k of storage.list({ namespace: 'NS', segment: 'seg' }))
      listed.push(k.generation);
    expect(listed).toEqual([]);
    await expect(storage.getRange({ ...key, segment: 'seg' }, 0, 1)).rejects.toThrow(
      /no such generation/,
    );
  });

  it('two concurrent creates of case variants: one wins, the other is refused, and no row is overwritten', async () => {
    for (let trial = 0; trial < 5; trial++) {
      const registry = new LocalFsRegistryDriver(join(root, `race${trial}`));
      const [first, second] = await Promise.allSettled([
        registry.create({ namespace: 'Foo', segment: 's' }, { currentGen: 1 }),
        registry.create({ namespace: 'foo', segment: 's' }, { currentGen: 2 }),
      ]);
      const outcomes = [first, second];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(ValidationError);
      const winner = first.status === 'fulfilled' ? 'Foo' : 'foo';
      expect((await registry.get({ namespace: winner, segment: 's' }))?.currentGen).toBe(
        first.status === 'fulfilled' ? 1 : 2,
      );
    }
  });

  it('namespaces that begin with two dots and differ only by case cannot share files', async () => {
    await store.load({ namespace: '..Acme', segment: 'audience' }, [1, 2, 3]);
    expect(await counted('..Acme', 'audience')).toBe(3);
    expect(await counted('..acme', 'audience')).toBe(0);
    const err = await store
      .load({ namespace: '..acme', segment: 'audience' }, [9])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/differ only by case on a case-insensitive filesystem/);
    const registry = new LocalFsRegistryDriver(join(root, 'reg'));
    await registry.create({ namespace: '..Ns', segment: 'a' }, { currentGen: 0 });
    await expect(
      registry.create({ namespace: '..ns', segment: 'a' }, { currentGen: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await counted('..Acme', 'audience')).toBe(3);
  });

  it('an existing root whose own path is in another case is not mistaken for a mismatch', async () => {
    await mkdir(join(root, 'Sub'), { recursive: true });
    const viaOtherCase = new CloudRoaring({ storage: new LocalFsStorage(join(root, 'sUB')) });
    await viaOtherCase.load({ segment: 's' }, [1, 2]);
    expect(await viaOtherCase.segment('s').count()).toBe(2);
    expect(await viaOtherCase.segment('s').count()).toBe(2);
  });
});

describe('isOutside: containment by path component, not by string prefix', () => {
  it('a relative path that leaves the root is outside', () => {
    expect(isOutside('..')).toBe(true);
    expect(isOutside(`..${sep}x`)).toBe(true);
    expect(isOutside(`..${sep}..${sep}x`)).toBe(true);
    expect(isOutside(resolve('/elsewhere'))).toBe(true);
    expect(isOutside('..\\x', win32)).toBe(true);
    expect(isOutside('C:\\other', win32)).toBe(true);
  });

  it('a name that merely begins with two dots is inside, and so is the root itself', () => {
    expect(isOutside('')).toBe(false);
    expect(isOutside('..acme')).toBe(false);
    expect(isOutside('...')).toBe(false);
    expect(isOutside(['..acme', 'segments', 's.0.crbm'].join(sep))).toBe(false);
    expect(isOutside(['a', '..b'].join(sep))).toBe(false);
    expect(isOutside('..acme\\segments', win32)).toBe(false);
  });
});

/**
 * A case-folding root emulated with symlinks, so a case-sensitive disk (Linux CI) holds both call sites that decide
 * whether a path is inside the root. The probe in `folds()` stats an entry and its case-swapped name and compares
 * inode and device, and `stat` and `realpath` follow symlinks: every cased entry has its case-swapped twin as a
 * symlink to it, so the root reads as folding, and `..acme` resolves to the directory `..Acme`.
 */
describe('a case-folding root emulated with symlinks: names that begin with two dots', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crbm-case-emul-'));
    // On a disk that really folds case the twin already exists as the same entry, so a taken name is fine.
    const link = (target: string, name: string): Promise<void> =>
      symlink(target, join(root, name)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
    await mkdir(join(root, 'Ab'));
    await link('Ab', 'aB');
    await mkdir(join(root, '..Acme'));
    for (const name of ['..aCME', '..acme', '..ACME']) await link('..Acme', name);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('the root reads as folding, and a path in another case of a ..-leading directory differs', async () => {
    const exact = new ExactCase(root);
    expect(await exact.folds()).toBe(true);
    expect(await exact.differs(join(root, '..acme', 'segments', 's.1.crbm'))).toBe(true);
    expect(await exact.differs(join(root, '..Acme', 'segments', 's.1.crbm'))).toBe(false);
  });

  it('the storage driver refuses a write under the other spelling as a case variant', async () => {
    const storage = new LocalFsStorageDriver(root);
    const put = storage.putImmutable(
      { namespace: '..acme', segment: 's', generation: 1 },
      async (sink) => {
        await sink.write(new Uint8Array([1]));
      },
    );
    await expect(put).rejects.toBeInstanceOf(ValidationError);
    await expect(put).rejects.toThrow(/differ only by case on a case-insensitive filesystem/);
  });
});
