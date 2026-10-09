import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  registryConformance,
  registryConcurrency,
  registryDeleteConformance,
} from '@/testing/conformance';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { registryRowPath } from '@/drivers/localfs/paths';

// A monotonic fake clock so createdAt/updatedAt are deterministic and updatedAt advances on each mutation.
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

// Every IRegistryDriver must pass the same contract.
registryConformance('MemoryRegistryDriver', () => new MemoryRegistryDriver({ now: ticking() }), {
  pagedListSize: 25,
});

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-conf-reg-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

registryConformance(
  'LocalFsRegistryDriver',
  () => new LocalFsRegistryDriver(join(root, `d${n++}`), { now: ticking() }),
  { pagedListSize: 25 },
);

// Two instances over ONE root — the configuration in which a per-instance lock lets both pass the token check.
let shared = 0;
registryConcurrency('LocalFsRegistryDriver (two instances, one root)', () => {
  const dir = join(root, `shared${shared++}`);
  return [
    new LocalFsRegistryDriver(dir, { now: ticking() }),
    new LocalFsRegistryDriver(dir, { now: ticking() }),
  ];
});

// What a delete leaves behind. The in-memory registry keeps nothing once a row is gone; the local-filesystem one
// unlinks a row born with an incarnation id, under its row lock, and tombstones one a release before 0.12 wrote.
registryDeleteConformance('MemoryRegistryDriver', () => {
  const driver = new MemoryRegistryDriver({ now: ticking() });
  return { driver, stored: async (ref) => (await driver.get(ref)) !== null };
});

registryDeleteConformance('LocalFsRegistryDriver', () => {
  const dir = join(root, `del${n++}`);
  return {
    driver: new LocalFsRegistryDriver(dir, { now: ticking() }),
    stored: async (ref) =>
      access(registryRowPath(dir, ref)).then(
        () => true,
        () => false,
      ),
    plantRow: async (ref, text) => {
      const path = registryRowPath(dir, ref);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
  };
});
