import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageDriverConformance } from '@/testing/conformance';
import { MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';

// Every IStorageDriver must pass the same contract.
storageDriverConformance('MemoryStorageDriver', () => new MemoryStorageDriver(), {
  pagedListSize: 25,
  // Its check and its removal are one step, with no await between them.
  conditionalDelete: true,
});

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-conf-sdrv-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

storageDriverConformance(
  'LocalFsStorageDriver',
  () => new LocalFsStorageDriver(join(root, `d${n++}`)),
  // A filesystem has no unlink conditioned on which file is under the path (see the driver's note).
  { pagedListSize: 25, conditionalDelete: false },
);
