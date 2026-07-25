import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryConformance } from '@/testing/conformance';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';

// A monotonic fake clock so createdAt/updatedAt are deterministic and updatedAt advances on each mutation.
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

// Every IRegistryDriver must pass the same contract (finding V8).
registryConformance('MemoryRegistryDriver', () => new MemoryRegistryDriver({ now: ticking() }));

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
);
