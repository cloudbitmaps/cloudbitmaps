import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coldChunkSourceConformance } from '@/testing/conformance';
import { MemoryColdChunkSource, MemoryColdDriver } from '@/drivers/memory';
import { LocalFsColdDriver } from '@/drivers/localfs/cold';
import { CrbmColdChunkSource, writeCrbmGeneration } from '@/core/crbm-cold-source';

// Every ColdChunkSource must pass the same contract (finding V8).
coldChunkSourceConformance('MemoryColdChunkSource', (chunks) => {
  const source = new MemoryColdChunkSource();
  for (const { chunkKey, bitmap } of chunks)
    source.seed({ segment: 's', chunkKey }, bitmap.serialize());
  return Promise.resolve(source);
});

// The in-memory IColdDriver (Phase 4d) must serve the same contract through the real `.crbm` codec.
coldChunkSourceConformance('CrbmColdChunkSource (MemoryColdDriver)', async (chunks) => {
  const cold = new MemoryColdDriver();
  await writeCrbmGeneration(cold, { segment: 's', generation: 1 }, chunks);
  return new CrbmColdChunkSource(cold);
});

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-conf-cold-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

coldChunkSourceConformance('CrbmColdChunkSource (LocalFs)', async (chunks) => {
  const cold = new LocalFsColdDriver(join(root, `d${n++}`));
  await writeCrbmGeneration(cold, { segment: 's', generation: 1 }, chunks);
  return new CrbmColdChunkSource(cold);
});
