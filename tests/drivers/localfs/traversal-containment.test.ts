import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalFsColdDriver } from '@/drivers/localfs/cold';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import type { BlobSink } from '@/core/blob';

// The safety property used to come from REFUSING names like `../../etc`. It now comes from ENCODING them, and
// that swap is only sound if containment is demonstrated rather than assumed — a rejected name obviously
// cannot escape, an accepted one has to be shown not to.
//
// So these drive the real drivers with the nastiest names the old grammar existed to keep out, against a real
// temp directory, and assert that nothing lands outside the storage root.

let root: string;
let outside: string;
beforeEach(async () => {
  outside = await mkdtemp(join(tmpdir(), 'crbm-outside-'));
  root = await mkdtemp(join(outside, 'root-'));
});
afterEach(async () => {
  await rm(outside, { recursive: true, force: true });
});

const bytes =
  (b: Uint8Array) =>
  async (sink: BlobSink): Promise<void> => {
    await sink.write(b);
  };

const HOSTILE = [
  '..',
  '../etc/passwd',
  '../../../../../../etc/passwd',
  'a/../../b',
  './x',
  '.',
  'a/b',
  'a\\b',
] as const;

async function entriesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      found.push(child);
      if (e.isDirectory()) await walk(child);
    }
  };
  await walk('');
  return found;
}

describe('a hostile name is contained, not refused', () => {
  it('writes every traversal-shaped name inside the root and nowhere else', async () => {
    const cold = new LocalFsColdDriver(root);
    const registry = new LocalFsRegistryDriver(root);

    for (const name of HOSTILE) {
      await cold.putImmutable(
        { segment: name, namespace: name, generation: 0 },
        bytes(new Uint8Array([1])),
      );
      await registry.create({ segment: name, namespace: name }, { currentGen: 0 });
    }

    // Nothing appeared beside the root, only the root itself.
    expect(await readdir(outside)).toEqual([resolve(root).split('/').pop()]);

    // And no path component anywhere under the root is a traversal or a separator.
    for (const entry of await entriesUnder(root)) {
      for (const part of entry.split('/')) {
        expect(part).not.toBe('..');
        expect(part).not.toBe('.');
      }
    }
  });

  it('round-trips those names through a real write, list and read', async () => {
    const cold = new LocalFsColdDriver(root);
    for (const name of HOSTILE) {
      const key = { segment: name, namespace: 'ns', generation: 0 };
      await cold.putImmutable(key, bytes(new Uint8Array([7, 8])));
      expect(await cold.getRange(key, 0, 2)).toEqual(new Uint8Array([7, 8]));

      const listed = [];
      for await (const k of cold.list({ segment: name, namespace: 'ns' })) listed.push(k.segment);
      expect(listed).toEqual([name]);
    }
  });

  it('keeps distinct hostile names distinct, so none aliases another', async () => {
    const registry = new LocalFsRegistryDriver(root);
    for (const name of HOSTILE) await registry.create({ segment: name }, { currentGen: 0 });

    const seen: string[] = [];
    for await (const r of registry.list()) seen.push(r.segment);
    expect(seen.sort()).toEqual([...HOSTILE].sort());
    expect(new Set(seen).size).toBe(HOSTILE.length);
  });

  it('a user namespace called `_default` does not collide with the absent namespace', async () => {
    // The bug this prevents: `_default` is the physical stand-in for "no namespace". Dropping the grammar made
    // a leading underscore spellable, so without the encoder's leading-`_` escape a caller naming their
    // namespace `_default` would read and write everyone else's un-namespaced data.
    const registry = new LocalFsRegistryDriver(root);
    await registry.create({ segment: 'mine' }, { currentGen: 1 }); // absent namespace
    await registry.create({ segment: 'theirs', namespace: '_default' }, { currentGen: 2 });

    expect((await registry.get({ segment: 'mine' }))?.currentGen).toBe(1);
    expect((await registry.get({ segment: 'theirs', namespace: '_default' }))?.currentGen).toBe(2);
    // The un-namespaced segment is NOT visible under the user's `_default` namespace…
    expect(await registry.get({ segment: 'mine', namespace: '_default' })).toBeNull();
    // …and they occupy different directories on disk.
    expect((await readdir(root)).sort()).toEqual(['%5Fdefault', '_default']);
  });

  it('the root is still a directory the drivers own — no symlink or file was substituted', async () => {
    const cold = new LocalFsColdDriver(root);
    await cold.putImmutable({ segment: '../../evil', generation: 0 }, bytes(new Uint8Array([1])));
    const st = await stat(root);
    expect(st.isDirectory()).toBe(true);
  });
});
