import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsSink } from '@/bin/export-segments';
import { ValidationError } from '@/index';

/**
 * The exporter writes only into directories it made, or ones an earlier run of it left (owner-only, as it makes
 * them). It does not write through a symlink at, or a directory it finds that is not owner-only or not its user's.
 */
describe('export-segments: the output directory tree', () => {
  let out: string;
  let elsewhere: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'crbm-out-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'crbm-elsewhere-'));
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  const write = async (ref: { namespace?: string; segment: string }): Promise<void> => {
    const writer = await fsSink(out).open(ref, '.ndjson');
    await writer.write(new Uint8Array([49, 10]));
    await writer.close();
  };

  it('refuses a namespace directory that is a symlink, and writes nothing through it', async () => {
    await symlink(elsewhere, join(out, 'ns'));
    await expect(write({ namespace: 'ns', segment: 's' })).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses the default namespace directory when it is a symlink', async () => {
    await symlink(elsewhere, join(out, '_default'));
    await expect(write({ segment: 's' })).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a namespace path that is a file', async () => {
    await writeFile(join(out, 'ns'), 'x');
    await expect(write({ namespace: 'ns', segment: 's' })).rejects.toBeInstanceOf(ValidationError);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a directory that others can write or read (a mode the exporter never makes)',
    async () => {
      await mkdir(join(out, 'ns'));
      await chmod(join(out, 'ns'), 0o755);
      await expect(write({ namespace: 'ns', segment: 's' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await readdir(join(out, 'ns'))).toEqual([]);
    },
  );

  it('writes into a directory it made, including on a second run over the same output', async () => {
    await write({ namespace: 'ns', segment: 's' });
    await write({ namespace: 'ns', segment: 's' });
    await write({ namespace: 'ns', segment: 't' });
    expect((await readdir(join(out, 'ns'))).sort()).toEqual(['s.ndjson', 't.ndjson']);
  });

  it('writes into a directory an earlier run left, owner-only', async () => {
    await mkdir(join(out, 'ns'), { mode: 0o700 });
    await write({ namespace: 'ns', segment: 's' });
    expect(await readdir(join(out, 'ns'))).toEqual(['s.ndjson']);
  });
});
