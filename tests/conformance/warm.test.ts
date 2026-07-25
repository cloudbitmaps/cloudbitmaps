import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmConformance } from '@/testing/conformance';
import { MemoryWarmDriver } from '@/drivers/memory';
import { LocalFsWarmDriver } from '@/drivers/localfs/warm';

// Every IWarmDriver must pass the same contract (finding V8).
warmConformance('MemoryWarmDriver', () => new MemoryWarmDriver());

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-conf-warm-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// A fresh, isolated directory per driver instance so tests don't share state.
warmConformance('LocalFsWarmDriver', () => new LocalFsWarmDriver(join(root, `d${n++}`)));
