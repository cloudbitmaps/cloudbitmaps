import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coldChunkSourceConformance, CONFORMANCE_SEGMENT } from '@/testing/conformance';
import { MemoryStorageChunkSource, MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { CrbmStorageChunkSource, writeCrbmGeneration } from '@/core/crbm-storage-source';

// Every StorageChunkSource must pass the same contract.
coldChunkSourceConformance('MemoryStorageChunkSource', (chunks) => {
  const source = new MemoryStorageChunkSource();
  for (const { chunkKey, bitmap } of chunks)
    source.seed({ segment: CONFORMANCE_SEGMENT, chunkKey }, bitmap.serialize());
  return Promise.resolve(source);
});

// The in-memory IStorageDriver must serve the same contract through the real `.crbm` codec.
coldChunkSourceConformance('CrbmStorageChunkSource (MemoryStorageDriver)', async (chunks) => {
  const storage = new MemoryStorageDriver();
  await writeCrbmGeneration(storage, { segment: CONFORMANCE_SEGMENT, generation: 1 }, chunks);
  return new CrbmStorageChunkSource(storage);
});

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-conf-storage-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

coldChunkSourceConformance('CrbmStorageChunkSource (LocalFs)', async (chunks) => {
  const storage = new LocalFsStorageDriver(join(root, `d${n++}`));
  await writeCrbmGeneration(storage, { segment: CONFORMANCE_SEGMENT, generation: 1 }, chunks);
  return new CrbmStorageChunkSource(storage);
});
