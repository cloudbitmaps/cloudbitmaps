import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBackend,
  CloudRoaring,
  IntegrityError,
  LocalFsStorageDriver,
  LocalFsRegistryDriver,
  NotFoundError,
  runConsistencyCheck,
} from '@/index';
import type { AuditEvent, Segment, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from './helpers/bulk-load';

/**
 * Executable DR drill — the [disaster-recovery runbook](docs/guide/disaster-recovery.md)
 * turned into a gated, on-disk `backup → corrupt → restore → verify` exercise.
 *
 * Unlike `tests/core/consistency.test.ts` (in-memory drivers, a *structural* tear via `compareAndSwap`), this
 * drives the REAL `LocalFs` storage + registry tiers on a temp filesystem and corrupts actual on-disk objects, so
 * it exercises what an operator would really do. It covers both failure detectors, both documented
 * resolutions, and the runbook's advice for readers:
 *
 *   • Torn cross-tier restore (registry recovered *ahead of* storage) and a lost `.crbm` are the **one class**
 *     `checkConsistency` reports — `missing-storage-generation`. Resolved by rolling `currentGen` back to an
 *     existing generation, or by restoring the object from backup.
 *   • Byte corruption *inside* a present `.crbm` is deliberately **NOT** something `checkConsistency` can see
 *     (it verifies a generation is present, not its bytes); the trust boundary catches it on **read**, failing
 *     closed with `IntegrityError` (CRC). The drill asserts both the honest blind spot and the read-time catch,
 *     then restores from backup.
 *   • The runbook's readers: a store on a bare `IStorageDriver` follows the bucket, not a rolled-back pointer,
 *     until the generations above the pointer are deleted; and a `seg.pin()` handle whose object is replaced
 *     keeps refusing it after a restore until its store is invalidated, then reads it again.
 *
 * The objects and the registry back up / restore independently — which is the whole reason a torn restore
 * exists — so every segment here is one published generation, and each failure signal stays crisp.
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
  const storage = new LocalFsStorageDriver(root);
  const registry = new LocalFsRegistryDriver(root, { now: () => Date.now() });
  const store = new CloudRoaring({
    storage: createBackend({ storage, registry }),
    retry: false,
  });
  return { storage, registry, store };
}

async function idsOf(segment: Segment): Promise<number[]> {
  const out: number[] = [];
  for await (const id of segment.iterate()) out.push(id);
  return out.sort((a, b) => a - b);
}

const members = (store: CloudRoaring, seg: string): Promise<number[]> => idsOf(store.segment(seg));

/** A store on the bare storage driver, with no registry: what a reader wired without a backend gets. */
const bareStore = (root: string) =>
  new CloudRoaring({ storage: new LocalFsStorageDriver(root), retry: false });

describe('DR drill — backup → corrupt → restore → verify', () => {
  let root: string;
  let backup: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'crbm-dr-'));
    const { storage, registry } = stores(root);
    for (const [seg, ids] of Object.entries(FLEET)) {
      await bulkLoadCrbmGeneration(storage, { segment: seg, generation: 0 }, ids, { registry });
    }
    // "Backup" — there is no application-level snapshot API, so a real operator relies on the store's own
    // durability (object versioning over both the registry and storage prefixes). On LocalFs that is a
    // coordinated copy of the data root.
    backup = `${root}.backup`;
    cpSync(root, backup, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  });

  it('baseline: the freshly restored store is fully consistent and reads correctly', async () => {
    const { storage, registry, store } = stores(root);
    const report = await runConsistencyCheck({ storage, registry });
    expect(report).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(store, 'alpha')).toEqual(FLEET.alpha);
  });

  it('Disaster A — torn restore (registry recovered ahead of storage): detected as missing-storage-generation; rolling currentGen back to an existing generation restores consistency', async () => {
    const { storage, registry, store } = stores(root);
    const ref: SegmentRef = { segment: 'beta' };

    // Failover recovered the registry ahead of the object store: currentGen advances with no matching .crbm.
    const rec = (await registry.get(ref))!;
    expect(rec.currentGen).not.toBeNull(); // the fixture published gen 0 — a null pointer would be a different bug
    await registry.compareAndSwap(ref, rec.token, { currentGen: rec.currentGen! + 1 });

    const torn = await runConsistencyCheck({ storage, registry });
    expect(torn.inconsistent).toEqual([
      { segment: 'beta', namespace: undefined, currentGen: 1, issue: 'missing-storage-generation' },
    ]);
    // A read of the torn segment fails closed — its currentGen points at an absent generation.
    await expect(members(store, 'beta')).rejects.toBeInstanceOf(NotFoundError);

    // Resolve per the runbook (remedy (b)): roll currentGen back to the generation storage actually has (0), with the call it
    // names and the audit sink it passes, so the move is on the record.
    const events: AuditEvent[] = [];
    await store.rollback(ref, 0, { audit: { onEvent: (e) => events.push(e) } });
    expect(events).toEqual([
      {
        kind: 'segment.rollback',
        segment: 'beta',
        namespace: undefined,
        fromGeneration: 1,
        generation: 0,
      },
    ]);

    const healed = await runConsistencyCheck({ storage, registry });
    expect(healed).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(stores(root).store, 'beta')).toEqual(FLEET.beta);
  });

  it('Disaster B — a lost storage generation (the .crbm is gone): detected as missing-storage-generation; restoring the object from backup clears it', async () => {
    const gammaCrbm = crbmPath(root, 'gamma', 0);
    expect(existsSync(gammaCrbm)).toBe(true);
    rmSync(gammaCrbm); // the object store lost this generation (e.g. restored behind the registry)

    {
      const { storage, registry, store } = stores(root);
      const report = await runConsistencyCheck({ storage, registry });
      expect(report.inconsistent).toEqual([
        {
          segment: 'gamma',
          namespace: undefined,
          currentGen: 0,
          issue: 'missing-storage-generation',
        },
      ]);
      await expect(members(store, 'gamma')).rejects.toBeInstanceOf(NotFoundError);
    }

    // Restore the missing object from backup (remedy (a); storage is immutable + write-once, so the backed-up bytes are exact).
    cpSync(crbmPath(backup, 'gamma', 0), gammaCrbm);

    const { storage, registry, store } = stores(root);
    const healed = await runConsistencyCheck({ storage, registry });
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

    const { storage, registry, store } = stores(root);
    // Honest blind spot: checkConsistency reports the store as clean — it verifies the generation is present,
    // not that its bytes are intact.
    const report = await runConsistencyCheck({ storage, registry });
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

    const healed = await runConsistencyCheck({ storage, registry });
    expect(healed).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(await members(stores(root).store, 'alpha')).toEqual(FLEET.alpha);
  });

  it('Readers — a store with no registry follows the bucket, not a rolled-back pointer, until the generations above the pointer are deleted', async () => {
    const ref: SegmentRef = { segment: 'alpha' };
    const { storage, registry, store } = stores(root);
    const bad = [4, 5, 6];
    await bulkLoadCrbmGeneration(storage, { segment: 'alpha', generation: 1 }, bad, { registry });
    const bare = bareStore(root);
    expect(await members(bare, 'alpha')).toEqual(bad);

    // The operator undoes the bad load. A backend's reads follow the pointer at once.
    await store.rollback(ref, 0);
    expect(await members(store, 'alpha')).toEqual(FLEET.alpha);
    // One with no registry reads no pointer: it serves the newest generation in the bucket, so neither an
    // invalidation nor a restart moves it back while generation 1 is there.
    bare.invalidate(ref);
    expect(await members(bare, 'alpha')).toEqual(bad);
    expect(await members(bareStore(root), 'alpha')).toEqual(bad);

    // The runbook's remedy: once generation 1 is not wanted, delete it, then invalidate or restart.
    rmSync(crbmPath(root, 'alpha', 1));
    bare.invalidate(ref);
    expect(await members(bare, 'alpha')).toEqual(FLEET.alpha);
    expect(await members(bareStore(root), 'alpha')).toEqual(FLEET.alpha);
    expect(await runConsistencyCheck({ storage, registry })).toEqual({
      checked: 3,
      inconsistent: [],
      errored: [],
    });
  });

  it('Readers — a pin whose object is replaced refuses it, still refuses once a restore puts it back, and reads it again when its store is invalidated', async () => {
    const ref: SegmentRef = { segment: 'alpha' };
    const alphaCrbm = crbmPath(root, 'alpha', 0);
    const { store } = stores(root);
    const pin = await store.segment('alpha').pin();
    expect(await pin.has(1)).toBe(true); // reads the chunk holding 1, 2 and 3

    // Another object lands under the pinned key, out of band: a name purged and loaded again, say.
    const elsewhere = `${root}.elsewhere`;
    try {
      await bulkLoadCrbmGeneration(
        new LocalFsStorageDriver(elsewhere),
        { segment: 'alpha', generation: 0 },
        [1, 2, 70_001],
      );
      cpSync(crbmPath(elsewhere, 'alpha', 0), alphaCrbm);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    // It answers from what it has already read, and refuses the rest rather than read another object.
    expect(await pin.has(2)).toBe(true);
    await expect(pin.has(70_000)).rejects.toThrow(/no longer the object this handle pinned/);

    // A restore puts the pinned object back. What the store found about the pin still stands until it is told.
    cpSync(crbmPath(backup, 'alpha', 0), alphaCrbm);
    await expect(pin.has(70_000)).rejects.toThrow(/no longer the object this handle pinned/);
    store.invalidate(ref);
    expect(await idsOf(pin)).toEqual(FLEET.alpha);
    expect(await idsOf(await store.segment('alpha').pin())).toEqual(FLEET.alpha);
  });
});
