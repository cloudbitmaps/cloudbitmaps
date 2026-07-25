import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-lfsreg-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const regDir = (): string => join(root, '_default', 'registry');
const writeRaw = async (file: string, content: string): Promise<void> => {
  await mkdir(regDir(), { recursive: true });
  await writeFile(join(regDir(), file), content, 'utf8');
};

describe('LocalFsRegistryDriver corruption + edge handling', () => {
  it('rejects a non-JSON / malformed / under-validated row with IntegrityError (invariant 5)', async () => {
    const d = new LocalFsRegistryDriver(root);
    await writeRaw('s.reg', '{not json');
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(IntegrityError);

    await writeRaw('s.reg', JSON.stringify({ deleted: false, record: { segment: 's' } })); // missing fields
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(IntegrityError);

    // structurally complete but a corrupt currentGen / status / non-canonical token
    const base = {
      segment: 's',
      currentGen: 0,
      dirtyChunkCount: 0,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      token: '0',
    };
    await writeRaw(
      's.reg',
      JSON.stringify({ deleted: false, record: { ...base, currentGen: -1 } }),
    );
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(IntegrityError);
    await writeRaw('s.reg', JSON.stringify({ deleted: false, record: { ...base, status: 'huh' } }));
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(IntegrityError);
    await writeRaw('s.reg', JSON.stringify({ deleted: false, record: { ...base, token: '1e3' } }));
    // token only consulted on the next mutation (counterOf) — create-over a live row is a conflict first,
    // so probe via compareAndSwap which reads the token.
    await expect(
      d.compareAndSwap({ segment: 's' }, '1e3', { currentGen: 1 }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('reads a legacy row (no schemaVersion) but rejects a future-stamped one (format freeze)', async () => {
    const d = new LocalFsRegistryDriver(root);
    const record = {
      segment: 's',
      currentGen: 2,
      dirtyChunkCount: 0,
      status: 'active',
      consecutiveFailures: 0,
      createdAt: 1,
      updatedAt: 1,
      token: '0',
    };
    // pre-freeze row (no stamp) must stay readable across the upgrade → tolerated as v1
    await writeRaw('s.reg', JSON.stringify({ deleted: false, record }));
    expect((await d.get({ segment: 's' }))!.currentGen).toBe(2);
    // a row from a newer, incompatible writer must fail closed rather than be misparsed
    await writeRaw('s.reg', JSON.stringify({ schemaVersion: 999, deleted: false, record }));
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('list() skips a planted non-segment .reg file instead of aborting', async () => {
    const d = new LocalFsRegistryDriver(root);
    await d.create({ segment: 'good' }, { currentGen: 0 });
    await writeRaw('.reg', 'x'); // empty stem — not a valid segment name
    await writeRaw('not a segment.reg', 'x'); // invalid grammar (space)
    await writeRaw('README.txt', 'x'); // wrong suffix
    const segs: string[] = [];
    for await (const r of d.list()) segs.push(r.segment);
    expect(segs).toEqual(['good']); // the planted files are skipped, not fatal
  });

  it('rejects an oversized governance blob at write (never bricks the row)', async () => {
    const d = new LocalFsRegistryDriver(root);
    const huge = { blob: 'x'.repeat(128 * 1024) }; // > the 64 KiB governance cap
    await expect(
      d.create({ segment: 's' }, { currentGen: 0, retention: huge }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The row was never written, so the segment is still usable.
    expect(await d.get({ segment: 's' })).toBeNull();
    await d.create({ segment: 's' }, { currentGen: 0 });
    expect((await d.get({ segment: 's' }))!.currentGen).toBe(0);
  });
});
