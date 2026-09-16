import fc from 'fast-check';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import {
  coldObjectFilename,
  coldObjectPath,
  parseGeneration,
  parseRegistryRow,
  registryRowPath,
} from '@/drivers/localfs/paths';
import type { BlobSink } from '@/core/blob';
import type { GenKey } from '@/core/ports';

// A name may hold `:`; a path may not. On Windows `dedup:2026-08-01.0.crbm` names an NTFS ALTERNATE DATA
// STREAM on a file called `dedup` — the write can succeed while `readdir` never lists the result, which is
// worse than an error because nothing reports it. So the driver percent-encodes on the way to a path.
//
// These run on POSIX in CI too, where the literal colon would have been *accepted*. That is exactly why the
// encoding is unconditional and why these assert the encoding itself, not merely that a round-trip works:
// on a POSIX runner a driver that skipped encoding would pass every round-trip test and still lose data on
// a user's Windows box.

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-colon-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes =
  (b: Uint8Array) =>
  async (sink: BlobSink): Promise<void> => {
    await sink.write(b);
  };

describe('localfs: colons never reach the filesystem', () => {
  it('no path component contains a literal colon', () => {
    const key: GenKey = {
      segment: 'sent:daily:2026-08-01',
      namespace: 'tenant:acme',
      generation: 3,
    };
    const storage = coldObjectPath(root, key);
    const reg = registryRowPath(root, key);
    // `root` is a tmpdir path we do not control; assert only on what the driver appended.
    for (const p of [storage, reg]) expect(p.slice(root.length)).not.toContain(':');
    expect(basename(storage)).toBe('sent%3Adaily%3A2026-08-01.3.crbm');
    expect(basename(reg)).toBe('sent%3Adaily%3A2026-08-01.reg');
    expect(storage).toContain('tenant%3Aacme');
  });

  it('a colon segment round-trips through a real write, list and read', async () => {
    const driver = new LocalFsStorageDriver(root);
    const key: GenKey = { segment: 'dedup:2026-08-01', namespace: 'tenant:acme', generation: 0 };
    const payload = new Uint8Array([1, 2, 3, 4]);
    await driver.putImmutable(key, bytes(payload));

    const listed = [];
    for await (const k of driver.list({ segment: key.segment, namespace: key.namespace }))
      listed.push(k);
    expect(listed).toEqual([
      { segment: 'dedup:2026-08-01', namespace: 'tenant:acme', generation: 0 },
    ]);

    expect(await driver.getRange(key, 0, payload.length)).toEqual(payload);
  });

  it('the registry row for a colon segment round-trips', async () => {
    const registry = new LocalFsRegistryDriver(root);
    const ref = { segment: 'user:123:seen', namespace: 'tenant:acme' };
    await registry.create(ref, { currentGen: 7 });
    const row = await registry.get(ref);
    expect(row).toMatchObject({
      currentGen: 7,
      segment: 'user:123:seen',
      namespace: 'tenant:acme',
    });

    const names = await readdir(join(root, 'tenant%3Aacme', 'registry'));
    expect(names).toEqual(['user%3A123%3Aseen.reg']);
  });

  it('parseGeneration only matches the ENCODED filename, never the literal one', () => {
    expect(parseGeneration('a:b', 'a%3Ab.4.crbm')).toBe(4);
    expect(parseGeneration('a:b', 'a:b.4.crbm')).toBeNull();
    expect(coldObjectFilename('a:b', 4)).toBe('a%3Ab.4.crbm');
  });

  it('parseRegistryRow refuses a planted literal-colon file rather than aliasing it', async () => {
    // POSIX will hold `a:b.reg` next to the driver's own `a%3Ab.reg`. Both "decode" to `a:b`; reporting the
    // name twice would hand list() a segment whose row path resolves to only one of the two files.
    expect(parseRegistryRow('a%3Ab.reg')).toBe('a:b');
    expect(parseRegistryRow('a:b.reg')).toBeNull();
    // MULTI-colon, deliberately: with a single colon a decoder that replaced only the FIRST occurrence
    // would look correct. With two it returns a name that no longer round-trips, so the row is silently
    // SKIPPED by list() — a segment that exists, holds data, and is invisible to every sweep.
    expect(parseRegistryRow('user%3A123%3Aseen.reg')).toBe('user:123:seen');
    expect(parseRegistryRow('sent%3Adaily%3A2026-08-01.reg')).toBe('sent:daily:2026-08-01');
    // The escape is case-sensitive; `%3a` is not one the driver ever writes.
    expect(parseRegistryRow('a%3ab.reg')).toBeNull();
    // A stem that is not a legal name after decoding is skipped, as before.
    expect(parseRegistryRow('a%41b.reg')).toBeNull();
    expect(parseRegistryRow('_default.reg')).toBeNull();
  });

  it('a planted literal-colon row is skipped by a real list(), not surfaced', async () => {
    const registry = new LocalFsRegistryDriver(root);
    await registry.create({ segment: 'sent:daily:2026-08-01' }, { currentGen: 1 });
    await writeFile(join(root, '_default', 'registry', 'sent:daily:2026-08-01.reg'), '{}');

    const seen = [];
    for await (const r of registry.list()) seen.push(r.segment);
    expect(seen).toEqual(['sent:daily:2026-08-01']);
  });

  it('a planted literal-colon DIRECTORY is skipped, so one namespace is never reported twice', async () => {
    // The sibling of the `.reg` round-trip check, on `parseNamespaceDir`. Its doc says getting this wrong does
    // not fail one segment — it aborts the whole enumeration, taking the consistency check, the retention
    // sweep and subject erasure with it. Nothing tested it.
    const registry = new LocalFsRegistryDriver(root);
    await registry.create({ segment: 's', namespace: 'tenant:acme' }, { currentGen: 0 });
    await mkdir(join(root, 'tenant:acme', 'registry'), { recursive: true });
    await writeFile(join(root, 'tenant:acme', 'registry', 's.reg'), '{}');

    const seen = [];
    for await (const r of registry.list()) seen.push(r.namespace);
    expect(seen).toEqual(['tenant:acme']); // once, from `tenant%3Aacme` — not twice
  });

  it('property: the encoding round-trips, and near-identical names never share a path', () => {
    // Derive the pair from ONE base by inserting colons, so a COLLIDING pair is the common draw rather than
    // a once-in-a-blue-moon one. Two independently generated names essentially never collide, which is how a
    // mutation that simply STRIPPED colons (making `a:b` and `ab` the same path) slipped past an earlier
    // version of this property.
    const BASE = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9.-]{0,16}$/);
    const POSITIONS = fc.array(fc.nat({ max: 16 }), { maxLength: 3 });
    const withColons = (base: string, at: number[]): string =>
      at
        .map((i) => Math.min(i, base.length - 1))
        .sort((x, y) => y - x)
        .reduce((acc, i) => (i <= 0 ? acc : acc.slice(0, i) + ':' + acc.slice(i)), base);

    fc.assert(
      fc.property(BASE, POSITIONS, POSITIONS, (base, pa, pb) => {
        const a = withColons(base, pa);
        const b = withColons(base, pb);
        fc.pre(!a.includes('..') && !b.includes('..'));

        const fa = coldObjectFilename(a, 0);
        expect(fa.includes(':')).toBe(false);
        expect(parseGeneration(a, fa)).toBe(0);
        // A real decode, through the parser that reads a name back off disk — the earlier version of this
        // property only ever re-ENCODED, so a broken decoder satisfied it.
        expect(parseRegistryRow(basename(registryRowPath(root, { segment: a })))).toBe(a);
        if (a !== b) expect(fa).not.toBe(coldObjectFilename(b, 0));
      }),
      { numRuns: 500 },
    );
  });
});
