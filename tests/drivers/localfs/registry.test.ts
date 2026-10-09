import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { REGISTRY_SCHEMA_VERSION } from '@/drivers/_shared/registry';
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

    // Stamped and structurally complete, then one thing wrong at a time. The control first: the base row reads, so
    // each refusal below is about the one field it changes.
    const token = `${'0'.repeat(32)}.0.${'0'.repeat(16)}`;
    const base = {
      segment: 's',
      currentGen: 0,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      token,
      pointerId: token,
    };
    const stamped = (record: object, deleted = false): string =>
      JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, deleted, record });
    await writeRaw('s.reg', stamped(base));
    expect(await d.get({ segment: 's' })).toMatchObject({ currentGen: 0, token });
    for (const [record, why] of [
      [{ ...base, currentGen: -1 }, /invalid currentGen/],
      [{ ...base, status: 'huh' }, /unknown status/],
      [{ ...base, dirtyChunkCount: 0 }, /does not declare \(dirtyChunkCount\)/],
      // A token in no form the library writes fails the read, naming the file.
      [
        { ...base, token: '1e3' },
        /token is not one a shipped registry writes \("1e3"\): .*s\.reg$/,
      ],
    ] as const) {
      await writeRaw('s.reg', stamped(record));
      await expect(d.get({ segment: 's' })).rejects.toThrow(why);
    }
  });

  it('reads a stamped row, and refuses an unstamped or future-stamped one (format freeze)', async () => {
    const d = new LocalFsRegistryDriver(root);
    const token = `${'0'.repeat(32)}.0.${'0'.repeat(16)}`;
    const record = {
      segment: 's',
      currentGen: 2,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      token,
      pointerId: token,
    };
    await writeRaw(
      's.reg',
      JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, deleted: false, record }),
    );
    expect((await d.get({ segment: 's' }))!.currentGen).toBe(2);
    // a row with no stamp is not one this build wrote
    await writeRaw('s.reg', JSON.stringify({ deleted: false, record }));
    await expect(d.get({ segment: 's' })).rejects.toBeInstanceOf(IntegrityError);
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

describe('a row is read only under the name it was written for', () => {
  it('refuses a row copied under another name, which an erasure would otherwise miss as a different segment', async () => {
    const { readFile } = await import('node:fs/promises');
    const reg = new LocalFsRegistryDriver(root);
    await reg.create({ segment: 'orig' }, { currentGen: 0 });
    await writeRaw('copy.reg', await readFile(join(regDir(), 'orig.reg'), 'utf8'));
    await expect(reg.get({ segment: 'copy' })).rejects.toThrow(
      /names another segment than the one it is stored for/,
    );
    await expect(reg.get({ segment: 'copy' })).rejects.toBeInstanceOf(IntegrityError);
    // Control: the original reads, and a namespaced row is held to its namespace.
    expect(await reg.get({ segment: 'orig' })).toMatchObject({ segment: 'orig', currentGen: 0 });
    await reg.create({ namespace: 'ns', segment: 'n' }, { currentGen: 0 });
    expect(await reg.get({ namespace: 'ns', segment: 'n' })).toMatchObject({
      namespace: 'ns',
      segment: 'n',
    });
  });

  it('a listing refuses it too, as it refuses any other corrupt row', async () => {
    const { readFile } = await import('node:fs/promises');
    const reg = new LocalFsRegistryDriver(root);
    await reg.create({ segment: 'orig' }, { currentGen: 0 });
    await writeRaw('copy.reg', await readFile(join(regDir(), 'orig.reg'), 'utf8'));
    await expect(
      (async () => {
        for await (const _ of reg.list()) void _;
      })(),
    ).rejects.toThrow(/names another segment than the one it is stored for/);
  });
});
