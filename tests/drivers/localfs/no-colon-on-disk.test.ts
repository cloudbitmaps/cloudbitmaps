import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import type { BlobSink } from '@/core/blob';

// The gate for the WHOLE class, rather than for the sites that happened to exist when it was written.
//
// A name may contain `:`; a filesystem path may not — on Windows it opens an NTFS alternate data stream, so
// the write succeeds and `readdir` never lists the result. Every place that turns a name into a path has to
// encode it, and "every place" is the hard part: the first pass at this encoded the LocalFs drivers and
// missed the eject sink in another package entirely, and a reviewer demonstrated that adding a new temp-file
// path inside the storage driver would pass the entire suite.
//
// So this asserts on the ARTIFACT, not the code: drive the driver surface with colon names, then walk the
// whole tree and require that NO entry anywhere contains a colon — data files, registry rows, directories,
// and temp files alike. It needs no knowledge of which functions build paths, so it keeps holding after a
// refactor adds one. It runs on POSIX, where a literal colon is perfectly legal, which is the point: this
// fails loudly on Linux and macOS for a hazard that only bites on Windows.

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-nocolon-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NS = 'tenant:acme';
const SEG = 'sent:daily:2026-08-01';

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

const bytes =
  (b: Uint8Array) =>
  async (sink: BlobSink): Promise<void> => {
    await sink.write(b);
  };

describe('localfs: no colon reaches the filesystem, from any code path', () => {
  it('nothing under the storage root is named with a colon after a full exercise', async () => {
    const storage = new LocalFsStorageDriver(root);
    const registry = new LocalFsRegistryDriver(root);
    const ref = { segment: SEG, namespace: NS };

    // Snapshot the tree DURING a write as well as after. A temp file is created and unlinked inside
    // `putImmutable`, so a colon in a temp path is invisible to any walk that runs afterwards — and a temp
    // path is exactly the kind of site a later refactor adds. The sink callback runs while the handle is
    // open, which is the one moment the file is on disk.
    const duringWrite: string[] = [];
    await storage.putImmutable({ ...ref, generation: 0 }, async (sink) => {
      duringWrite.push(...(await entriesUnder(root)));
      await sink.write(new Uint8Array([1, 2, 3, 4]));
    });
    expect(duringWrite.length).toBeGreaterThan(0);
    expect(duringWrite.filter((e) => e.includes(':'))).toEqual([]);

    // Every other verb that could plausibly build a path, including the ones with no colon test of their own.
    await storage.putImmutable({ ...ref, generation: 1 }, bytes(new Uint8Array([5, 6, 7, 8])));
    await storage.getRange({ ...ref, generation: 0 }, 0, 2);
    await storage.getTail({ ...ref, generation: 0 }, 2);
    for await (const _k of storage.list(ref)) void _k;
    await storage.delete({ ...ref, generation: 1 });

    const { token } = await registry.create(ref, { currentGen: 0 });
    await registry.get(ref);
    await registry.compareAndSwap(ref, token, { currentGen: 1 });
    for await (const _r of registry.list()) void _r;
    for await (const _r of registry.list(NS)) void _r;
    await registry.delete(ref);

    const entries = await entriesUnder(root);
    expect(entries.length).toBeGreaterThan(0); // the walk actually found the tree
    expect(entries.filter((e) => e.includes(':'))).toEqual([]);
  });

  it('the names still come back intact — encoding is not sanitising', async () => {
    const registry = new LocalFsRegistryDriver(root);
    await registry.create({ segment: SEG, namespace: NS }, { currentGen: 0 });

    const seen = [];
    for await (const r of registry.list()) seen.push([r.namespace, r.segment]);
    expect(seen).toEqual([[NS, SEG]]);
  });
});
