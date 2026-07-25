import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalFsWarmDriver } from '@/drivers/localfs/warm';
import { warmRowPath } from '@/drivers/localfs/paths';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';
import { IntegrityError } from '@/core/errors';

// The portable IWarmDriver contract (OCC/ABA/listChunks/traversal) is covered by the shared conformance
// suite (tests/conformance/warm.test.ts). This file holds only LocalFs-specific behavior.
let root: string;
let warm: LocalFsWarmDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-warm-'));
  warm = new LocalFsWarmDriver(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const REF: ChunkRef = { segment: 's', chunkKey: 7 };
const bytes = (...b: number[]): Uint8Array => Uint8Array.of(...b);

describe('LocalFsWarmDriver — filesystem specifics', () => {
  it('persists across driver instances (durable)', async () => {
    await warm.putConditional(REF, bytes(5, 6), NO_ROW);
    const reopened = new LocalFsWarmDriver(root);
    expect([...(await reopened.get(REF))!.bytes]).toEqual([5, 6]);
  });

  it('runs writes to different chunks concurrently (no false serialization)', async () => {
    const refs = Array.from({ length: 8 }, (_v, i) => ({ segment: 's', chunkKey: i }) as ChunkRef);
    await Promise.all(refs.map((r, i) => warm.putConditional(r, bytes(i), NO_ROW)));
    for (let i = 0; i < refs.length; i++) {
      expect([...(await warm.get(refs[i]!))!.bytes]).toEqual([i]);
    }
  });

  it('fails fast on a truncated/corrupt row (IntegrityError)', async () => {
    await warm.putConditional(REF, bytes(1, 2), NO_ROW);
    await writeFile(warmRowPath(root, REF), Uint8Array.of(1, 2)); // < 5-byte header
    await expect(warm.get(REF)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses to follow a symlink at the row path', async () => {
    const secret = join(root, 'secret.bin');
    await writeFile(secret, 'topsecret');
    const rowPath = warmRowPath(root, REF);
    await mkdir(dirname(rowPath), { recursive: true });
    await symlink(secret, rowPath);
    expect(await warm.get(REF)).toBeNull(); // ELOOP → treated as absent, not followed
  });
});
