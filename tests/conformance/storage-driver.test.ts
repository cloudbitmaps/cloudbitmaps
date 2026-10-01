import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageDriverConformance } from '@/testing/conformance';
import { MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';

// Every IStorageDriver must pass the same contract.
storageDriverConformance('MemoryStorageDriver', () => new MemoryStorageDriver());

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
);
