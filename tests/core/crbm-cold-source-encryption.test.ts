import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  CapabilityError,
  IntegrityError,
  KeyUnavailableError,
  ValidationError,
} from '@/core/errors';
import type { IColdDriver, IKeystore, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };
const IDS = [1, 2, 3, 100_000, 2_000_000_000];
const k = (): Uint8Array => randomBytes(32);

function world() {
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  return { cold, registry };
}

async function members(
  cold: IColdDriver,
  registry: MemoryRegistryDriver,
  keystore?: IKeystore,
): Promise<number[]> {
  const source = new CrbmColdChunkSource(cold, { registry, keystore });
  const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold: source, retry: false });
  const out: number[] = [];
  for await (const id of store.segment('s').iterate()) out.push(id);
  return out;
}

describe('CrbmColdChunkSource — encryption end-to-end (Phase 4e)', () => {
  it('bulk-loads encrypted, stores the wrapped DEK, and reads back with the keystore', async () => {
    const { cold, registry } = world();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, { registry, keystore });

    // The registry row carries the wrapped DEK; the cold object is encrypted (its footer hides cardinality).
    const rec = (await registry.get(SEG))!;
    expect(rec.wrappedDeks).toHaveLength(1);
    expect(rec.wrappedDeks![0]!.keyId).toBe('k1');

    expect(await members(cold, registry, keystore)).toEqual([...IDS].sort((a, b) => a - b));
  });

  it('reading an encrypted segment WITHOUT a keystore throws KeyUnavailableError', async () => {
    const { cold, registry } = world();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, { registry, keystore });
    await expect(members(cold, registry /* no keystore */)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
  });

  it('reading with a keystore that lacks the KEK throws KeyUnavailableError', async () => {
    const { cold, registry } = world();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, {
      registry,
      keystore: new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' }),
    });
    const wrongKeystore = new InProcessKeystore({ keys: { other: k() }, activeKeyId: 'other' });
    await expect(members(cold, registry, wrongKeystore)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
  });

  it('reading with the right keyId but the wrong key bytes throws IntegrityError', async () => {
    const { cold, registry } = world();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, {
      registry,
      keystore: new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' }),
    });
    // Same keyId 'k1' but a different 32-byte value → unwrap fails authentication.
    const imposter = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await expect(members(cold, registry, imposter)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('recovery KEK: a segment wrapped under active+recovery reads with the recovery key alone', async () => {
    const { cold, registry } = world();
    const activeKek = k();
    const recoveryKek = k();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, {
      registry,
      keystore: new InProcessKeystore({
        keys: { active: activeKek, recovery: recoveryKek },
        activeKeyId: 'active',
        recoveryKeyId: 'recovery',
      }),
    });
    expect((await registry.get(SEG))!.wrappedDeks).toHaveLength(2);

    // The operator who lost the active KEK reads with the offline recovery KEK only.
    const recoveryOnly = new InProcessKeystore({
      keys: { recovery: recoveryKek },
      activeKeyId: 'recovery',
    });
    expect(await members(cold, registry, recoveryOnly)).toEqual([...IDS].sort((a, b) => a - b));
  });

  it('bulk-load encryption requires a registry to store the wrapped DEK', async () => {
    const { cold } = world();
    await expect(
      bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, {
        keystore: new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' }),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('constructing a source with a keystore but no registry fails fast', () => {
    expect(
      () =>
        new CrbmColdChunkSource(new MemoryColdDriver(), {
          keystore: new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' }),
        }),
    ).toThrow(CapabilityError);
  });

  it('cleartext still works with no keystore (encryption is opt-in)', async () => {
    const { cold, registry } = world();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, { registry }); // no keystore
    expect((await registry.get(SEG))!.wrappedDeks).toBeUndefined();
    expect(await members(cold, registry)).toEqual([...IDS].sort((a, b) => a - b));
  });
});

// The Memory tiers clone object references; this proves the wrapped-DEK list survives a real JSON
// serialize↔parse round-trip through the persistent LocalFs cold + registry drivers (the realistic failure mode).
describe('CrbmColdChunkSource — encryption over persistent (LocalFs) drivers', () => {
  let root: string;
  let n = 0;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crbm-enc-localfs-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('bulk-loads encrypted to disk and reads it back through LocalFs + the keystore', async () => {
    const dir = join(root, `d${n++}`);
    const cold = new LocalFsColdDriver(dir);
    const registry = new LocalFsRegistryDriver(dir);
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, IDS, { registry, keystore });

    const rec = (await registry.get(SEG))!;
    expect(rec.wrappedDeks).toHaveLength(1); // survived the JSON envelope on disk

    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(cold, { registry, keystore }),
      retry: false,
    });
    const out: number[] = [];
    for await (const id of store.segment('s').iterate()) out.push(id);
    expect(out).toEqual([...IDS].sort((a, b) => a - b));
  });
});
