import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  IntegrityError,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  MemoryWarmDriver,
  NotFoundError,
  bulkLoadCrbmGeneration,
  runConsistencyCheck,
} from '@/index';
import type { SegmentRef } from '@/index';

/**
 * Executable DR drill (test-strategy T5) — the [disaster-recovery runbook](docs/guide/disaster-recovery.md)
 * turned into a gated, on-disk `backup → corrupt → restore → verify` exercise.
 *
 * Unlike `tests/core/consistency.test.ts` (in-memory drivers, a *structural* tear via `compareAndSwap`), this
 * drives the REAL `LocalFs` cold + registry tiers on a temp filesystem and corrupts actual on-disk objects, so
 * it exercises what an operator would really do. It covers both failure detectors and both documented
 * resolutions:
 *
 *   • Torn cross-tier restore (registry recovered *ahead of* cold) and a lost `.crbm` are the **one class**
 *     `checkConsistency` reports — `missing-cold-generation`. Resolved by rolling `currentGen` back to an
 *     existing generation, or by restoring the object from backup.
 *   • Byte corruption *inside* a present `.crbm` is deliberately **NOT** something `checkConsistency` can see
 *     (it verifies a generation is present, not its bytes); the trust boundary catches it on **read**, failing
 *     closed with `IntegrityError` (CRC). The drill asserts both the honest blind spot and the read-time catch,
 *     then restores from backup.
 *
 * Cold + registry are the two tiers that back up / restore independently (the whole reason a torn restore
 * exists), so segments here are cold-only (no Warm delta) to keep each failure signal crisp.
 */

const NS = '_default'; // LocalFs default-namespace directory segment
const crbmPath = (root: string, seg: string, gen: number): string =>
  join(root, NS, 'segments', `${seg}.${gen}.crbm`);

/** Ids per seeded segment (strided so they span several chunks). */
const FLEET: Record<string, number[]> = {
  alpha: [1, 2, 3, 70_000, 140_001],
  beta: [10, 20, 30, 200_000],
  gamma: [5, 65_537, 131_072, 262_144],
};

function stores(root: string) {
  const cold = new LocalFsColdDriver(root);
  const registry = new LocalFsRegistryDriver(root, { now: () => Date.now() });
  // Warm is memory: the DR failure modes here live in cold+registry; segments carry no Warm delta.
  const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, registry, retry: false });
  return { cold, registry, store };
}

async function members(store: CloudRoaring, seg: string): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(seg).iterate()) out.push(id);
  return out.sort((a, b) => a - b);
}

describe('DR drill — backup → corrupt → restore → verify (test-strategy T5)', () => {
  let root: string;
  let backup: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'crbm-dr-'));
    const { cold, registry } = stores(root);
    for (const [seg, ids] of Object.entries(FLEET)) {
      await bulkLoadCrbmGeneration(cold, { segment: seg, generation: 0 }, ids, { registry });
    }
    // "Backup" — there is no application-level snapshot API, so a real operator relies on the store's own
    // durability (S3 versioning + DynamoDB PITR). On LocalFs that is a coordinated copy of the data root.
    backup = `${root}.backup`;
    cpSync(root, backup, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  });

  it('baseline: the freshly restored store is fully consistent and reads correctly', async () => {
    const { cold, registry, store } = stores(root);
    const report = await runConsistencyCheck({ cold, registry });
    expect(report).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(store, 'alpha')).toEqual(FLEET.alpha);
  });

  it('Disaster A — torn restore (registry recovered ahead of cold): detected as missing-cold-generation; rolling currentGen back to an existing generation restores consistency', async () => {
    const { cold, registry, store } = stores(root);
    const ref: SegmentRef = { segment: 'beta' };

    // Failover recovered the registry ahead of the object store: currentGen advances with no matching .crbm.
    const rec = (await registry.get(ref))!;
    await registry.compareAndSwap(ref, rec.token, { currentGen: rec.currentGen + 1 });

    const torn = await runConsistencyCheck({ cold, registry });
    expect(torn.inconsistent).toEqual([
      { segment: 'beta', namespace: undefined, currentGen: 1, issue: 'missing-cold-generation' },
    ]);
    // A read of the torn segment fails closed — its currentGen points at an absent generation.
    await expect(members(store, 'beta')).rejects.toBeInstanceOf(NotFoundError);

    // Resolve per the runbook: roll currentGen back to the generation cold actually has (0).
    const now = (await registry.get(ref))!;
    await registry.compareAndSwap(ref, now.token, { currentGen: 0 });

    const healed = await runConsistencyCheck({ cold, registry });
    expect(healed).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(stores(root).store, 'beta')).toEqual(FLEET.beta);
  });

  it('Disaster B — a lost cold generation (the .crbm is gone): detected as missing-cold-generation; restoring the object from backup clears it', async () => {
    const gammaCrbm = crbmPath(root, 'gamma', 0);
    expect(existsSync(gammaCrbm)).toBe(true);
    rmSync(gammaCrbm); // the object store lost this generation (e.g. restored behind the registry)

    {
      const { cold, registry, store } = stores(root);
      const report = await runConsistencyCheck({ cold, registry });
      expect(report.inconsistent).toEqual([
        { segment: 'gamma', namespace: undefined, currentGen: 0, issue: 'missing-cold-generation' },
      ]);
      await expect(members(store, 'gamma')).rejects.toBeInstanceOf(NotFoundError);
    }

    // Restore the missing object from backup (cold is immutable + write-once, so the backed-up bytes are exact).
    cpSync(crbmPath(backup, 'gamma', 0), gammaCrbm);

    const { cold, registry, store } = stores(root);
    const healed = await runConsistencyCheck({ cold, registry });
    expect(healed).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(store, 'gamma')).toEqual(FLEET.gamma);
  });

  it('Disaster C — byte corruption inside a present .crbm: checkConsistency canNOT see it (documented limit), but a read fails closed with IntegrityError; restoring from backup repairs it', async () => {
    const alphaCrbm = crbmPath(root, 'alpha', 0);
    const bytes = readFileSync(alphaCrbm);
    const original = Buffer.from(bytes);
    // Flip a byte in the payload region (well before the index/footer). A single flipped byte breaks the
    // per-chunk CRC32C guarding native deserialize — the object still *exists* at full length, so the
    // presence-only consistency sweep stays blind to it.
    const at = Math.floor(bytes.length / 3);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    writeFileSync(alphaCrbm, bytes);

    const { cold, registry, store } = stores(root);
    // Honest blind spot: checkConsistency reports the store as clean — it verifies the generation is present,
    // not that its bytes are intact.
    const report = await runConsistencyCheck({ cold, registry });
    expect(report).toEqual({ checked: 3, inconsistent: [], errored: [] });
    // The trust boundary catches the corruption on read, failing closed with a typed IntegrityError. Assert
    // BOTH the type and that it's specifically the per-chunk *payload* CRC that fired (not the index/footer
    // CRC) — so the coverage this drill claims can't silently drift if the fixture's byte layout changes.
    const readErr = await members(store, 'alpha').then(
      () => null,
      (e: unknown) => e,
    );
    expect(readErr).toBeInstanceOf(IntegrityError);
    expect((readErr as Error).message).toMatch(/payload CRC/i);

    // Restore the good object from backup (verify our reference copy is genuinely intact bytes).
    expect(readFileSync(crbmPath(backup, 'alpha', 0)).equals(original)).toBe(true);
    cpSync(crbmPath(backup, 'alpha', 0), alphaCrbm);

    const healed = await runConsistencyCheck({ cold, registry });
    expect(healed).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(stores(root).store, 'alpha')).toEqual(FLEET.alpha);
  });
});
