import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring } from '@/index';
import type { SegmentRef } from '@/index';
import { MIN_EXPIRES_AT_MS, SWEEP_MARK } from '@/core/retention';
import { dueBucket, dueIndexRef, isDueIndexRow } from '@/core/due-index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { GcsRegistryDriver } from '@/gcs/registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { faultyRegistry } from '../helpers/lost-answer';
import { recordedWaits } from '../helpers/unanswered-registry';
import { StubBlobService, xmlError } from '../helpers/azure-blob-stub';
import { STUB_GCS_BUCKET, StubGcsService } from '../helpers/gcs-stub';

/**
 * The retention sweep's deletes of a row or a due-index pointer settle by reading the row: a delete whose answer was
 * lost, or whose resend met its own landing, is a delete that happened, and is reported as one. A row still there
 * after the failed delete stays a refusal or a lost race, as it was.
 *
 * Faults, as the registry meets them: (a) the delete landed and its answer was lost; (b) it landed and the answer was
 * a conflict; (c) it never landed.
 */

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const isDue = (ref: SegmentRef) => isDueIndexRow({ namespace: ref.namespace });
const isRow = (ref: SegmentRef) => !isDue(ref);
const pointerOf = (ref: SegmentRef, at: number) => dueIndexRef(dueBucket(at), ref);

/** A tombstone this sweep wrote two days ago, past its grace, with nothing under it. */
const staleTombstone = {
  currentGen: null,
  status: 'destroyed',
  retention: { expiresAt: T0 - 3 * DAY, [SWEEP_MARK]: T0 - 2 * DAY },
} as const;

type Kind = 'memory' | 'localfs';

describe.each<Kind>(['memory', 'localfs'])('a sweep delete whose answer was lost (%s)', (kind) => {
  let dir: string | undefined;
  beforeEach(async () => {
    dir = kind === 'localfs' ? await mkdtemp(join(tmpdir(), 'cbm-sweeplost-')) : undefined;
  });
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  function world() {
    const storage: IStorageDriver =
      dir === undefined ? new MemoryStorageDriver() : new LocalFsStorageDriver(dir);
    const raw: IRegistryDriver =
      dir === undefined
        ? new MemoryRegistryDriver({ now: () => T0 })
        : new LocalFsRegistryDriver(dir, { now: () => T0 });
    const registry = faultyRegistry(raw);
    const waits = recordedWaits();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      retry: false,
      seams: { clock: waits.clock, rng: waits.rng },
    });
    return { raw, registry, store };
  }
  type World = ReturnType<typeof world>;

  async function dueRows(w: World): Promise<string[]> {
    const out: string[] = [];
    for await (const r of w.raw.list()) if (isDue(r)) out.push(r.segment);
    return out;
  }

  describe('a purge', () => {
    it.each(['a', 'b'] as const)('is reported as a purge (%s)', async (fault) => {
      const w = world();
      await w.raw.create(SEG, staleTombstone);
      await w.raw.create(pointerOf(SEG, T0 - DAY), { currentGen: null });
      w.registry.arm('delete', fault, (ref) => isRow(ref) && ref.segment === 's');

      const res = await w.store.retireExpired({ now: T0 });

      expect(res).toMatchObject({ tombstonesPurged: 1, purgeFaults: 0 });
      expect(res.entries).toMatchObject([{ segment: 's', action: 'purged-tombstone' }]);
      expect(await w.raw.get(SEG)).toBeNull();
      expect(await dueRows(w)).toEqual([]);
    });

    it('that never landed is a refusal, and the next call purges it', async () => {
      const w = world();
      await w.raw.create(SEG, staleTombstone);
      w.registry.arm('delete', 'c', (ref) => isRow(ref));

      const res = await w.store.retireExpired({ now: T0 });
      expect(res.purgeFaults).toBe(1);
      expect(res.entries).toMatchObject([{ action: 'skipped' }]);
      expect(await w.raw.get(SEG)).not.toBeNull();

      const again = await w.store.retireExpired({ now: T0 });
      expect(again).toMatchObject({ tombstonesPurged: 1, purgeFaults: 0 });
    });

    it('whose conflict finds the row still there stays a lost race', async () => {
      const w = world();
      await w.raw.create(SEG, staleTombstone);
      w.registry.arm('delete', 'd', (ref) => isRow(ref));

      const res = await w.store.retireExpired({ now: T0 });

      expect(res.entries).toMatchObject([{ action: 'skipped', reason: 'failed: contended' }]);
      expect(res.tombstonesPurged).toBe(0);
      expect(res.purgeFaults).toBe(0);
      expect(await w.raw.get(SEG)).not.toBeNull();
    });

    it('does not stop purging after three lost answers in a row', async () => {
      const w = world();
      for (const segment of ['t1', 't2', 't3', 't4'])
        await w.raw.create({ namespace: 'ns', segment }, staleTombstone);
      w.registry.arm('delete', 'a', isRow, 3);

      const res = await w.store.retireExpired({ now: T0 });

      expect(res).toMatchObject({ tombstonesPurged: 4, purgeFaults: 0 });
    });
  });

  describe('an empty segment retired', () => {
    it.each(['a', 'b'] as const)(
      'is not counted as a fault when its row delete lost its answer (%s)',
      async (fault) => {
        const w = world();
        await w.raw.create(SEG, { currentGen: null, retention: { expiresAt: T0 - DAY } });
        w.registry.arm('delete', fault, (ref) => isRow(ref));

        const res = await w.store.retireExpired({ now: T0 });

        expect(res).toMatchObject({ retired: 1, purgeFaults: 0 });
        expect(await w.raw.get(SEG)).toBeNull();
        expect(await dueRows(w)).toEqual([]);
      },
    );
  });

  describe('a due-index pointer', () => {
    it('removed by a retirement is no fault when its delete lost its answer', async () => {
      const w = world();
      await w.raw.create(SEG, { currentGen: null, retention: { expiresAt: T0 - DAY } });
      await w.raw.create(pointerOf(SEG, T0 - DAY), { currentGen: null });
      w.registry.arm('delete', 'a', isDue);

      const res = await w.store.retireExpired({ now: T0 });

      expect(res).toMatchObject({ retired: 1, purgeFaults: 0 });
      expect(await dueRows(w)).toEqual([]);
    });

    it('of a foreign tombstone is no fault when its delete lost its answer', async () => {
      const w = world();
      await w.raw.create(SEG, { currentGen: null, status: 'destroyed' });
      await w.raw.create(pointerOf(SEG, T0 - DAY), { currentGen: null });
      w.registry.arm('delete', 'a', isDue);

      const res = await w.store.retireExpired({ now: T0 });

      expect(res.purgeFaults).toBe(0);
      expect(await dueRows(w)).toEqual([]);
      expect(await w.raw.get(SEG)).not.toBeNull();
    });

    it('of a segment that is gone (litter) is no fault when its delete lost its answer', async () => {
      const w = world();
      await w.raw.create(pointerOf(SEG, T0 - DAY), { currentGen: null });
      w.registry.arm('delete', 'a', isDue);

      const res = await w.store.retireExpired({ now: T0 });

      expect(res.purgeFaults).toBe(0);
      expect(await dueRows(w)).toEqual([]);
    });

    it('that never landed is counted', async () => {
      const w = world();
      await w.raw.create(pointerOf(SEG, T0 - DAY), { currentGen: null });
      w.registry.arm('delete', 'c', isDue);

      const res = await w.store.retireExpired({ now: T0 });

      expect(res.purgeFaults).toBe(1);
      expect(await dueRows(w)).toHaveLength(1);
    });
  });
});

describe('a purge over a store that turns the resend of a landed delete into a conflict', () => {
  const ROW = 'registry/_default/s.reg';
  const ref: SegmentRef = { segment: 's' };
  const sweep = (registry: IRegistryDriver) =>
    new CloudRoaring({
      storage: brandAsBackend({ storage: new MemoryStorageDriver(), registry }),
      retry: false,
      seams: { clock: { now: () => T0, sleep: async () => {} } },
    }).retireExpired({ now: T0 });

  it('on Azure Blob, where the client resends a delete after a 503', async () => {
    const stub = new StubBlobService();
    await stub.start();
    try {
      const registry = new AzureBlobRegistryDriver({
        containerClient: stub.client({ retryOptions: { retryDelayInMs: 1, maxRetryDelayInMs: 2 } }),
        now: () => T0,
      });
      await registry.create(ref, staleTombstone);
      let deletes = 0;
      stub.plan = (req) =>
        req.method === 'DELETE' && req.name === ROW && ++deletes === 1
          ? { respond: xmlError(503, 'ServerBusy'), apply: true }
          : undefined;

      const res = await sweep(registry);

      expect(deletes).toBe(2);
      expect(res).toMatchObject({ tombstonesPurged: 1, purgeFaults: 0 });
      expect(res.entries).toMatchObject([{ action: 'purged-tombstone' }]);
      expect(stub.blobs.has(ROW)).toBe(false);
    } finally {
      await stub.stop();
    }
  });

  it('on GCS with a conditional delete, where the SDK resends a delete after a 503', async () => {
    const stub = new StubGcsService();
    await stub.start();
    try {
      const registry = new GcsRegistryDriver({
        storage: stub.client(),
        bucket: STUB_GCS_BUCKET,
        conditionalDelete: true,
        now: () => T0,
      });
      await registry.create(ref, staleTombstone);
      stub.arm({
        op: 'delete',
        status: 503,
        afterApplying: true,
        name: (n) => n.endsWith('s.reg'),
      });

      const res = await sweep(registry);

      expect(stub.count('delete')).toBe(2);
      expect(res).toMatchObject({ tombstonesPurged: 1, purgeFaults: 0 });
      expect(res.entries).toMatchObject([{ action: 'purged-tombstone' }]);
    } finally {
      await stub.stop();
    }
  });
});
