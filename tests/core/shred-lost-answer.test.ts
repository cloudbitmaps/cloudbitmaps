import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudRoaring, RecordingAuditSink, destroySegment, eraseNamespace } from '@/index';
import type { RetireEntry, SegmentRef } from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { TransientError } from '@/core/errors';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { incarnationOf } from '@/core/token';
import { InProcessKeystore } from '@/drivers/crypto';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { faultyRegistry, faultyStorage } from '../helpers/lost-answer';
import { withoutTokenReports } from '../helpers/no-token-reports';
import { recordedWaits } from '../helpers/unanswered-registry';

/**
 * A crypto-shred, a drop's tombstone and a retirement settle a write that landed and lost its answer by reading the
 * row back: a tombstone that carries a token this call sent is this call's own, and is reported and audited as one.
 *
 * Faults, as the registry meets them: (a) the write landed and its answer was lost; (b) it landed and the answer was a
 * conflict that may follow its own landing; (c) it never landed. The (c) cases pass before and after the change: they
 * hold that a write that did not land is never claimed. The double fault (the answer and every read-back lost) is the
 * documented limit.
 */

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const CONFIRM = { confirmSegment: 's' };
const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

type Kind = 'memory' | 'localfs';

describe.each<Kind>(['memory', 'localfs'])('a shred whose answer was lost (%s)', (kind) => {
  let dir: string | undefined;
  beforeEach(async () => {
    dir = kind === 'localfs' ? await mkdtemp(join(tmpdir(), 'cbm-lost-')) : undefined;
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
    const deps = { registry, clock: waits.clock, rng: waits.rng };
    const audit = new RecordingAuditSink();
    const storeOver = (s: IStorageDriver, r: IRegistryDriver): CloudRoaring =>
      new CloudRoaring({
        storage: brandAsBackend({ storage: s, registry: r }),
        retry: false,
        seams: { clock: waits.clock, rng: waits.rng },
      });
    return {
      storage,
      raw,
      registry,
      deps,
      audit,
      store: () => storeOver(storage, registry),
      storeOver,
    };
  }
  type World = ReturnType<typeof world>;

  /** `n` generations of `ref`, sealed under a key unless `plain`. */
  async function load(w: World, ref: SegmentRef, n: number, plain = false): Promise<void> {
    const ks = plain ? undefined : keystore();
    for (let g = 0; g < n; g++) {
      await bulkLoadCrbmGeneration(w.storage, { ...ref, generation: g }, [g + 1, 10], {
        registry: w.raw,
        keystore: ks,
      });
    }
  }
  const present = async (w: World, ref: SegmentRef = SEG): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of w.storage.list(ref)) out.push(k.generation);
    return out.sort((a, b) => a - b);
  };
  const kinds = (w: World): string[] => w.audit.snapshot().map((e) => e.kind);
  const incarnationNow = async (w: World, ref: SegmentRef = SEG): Promise<string | undefined> =>
    incarnationOf((await w.raw.get(ref))!.token);
  const isSegment = (name: string) => (ref: SegmentRef) => ref.segment === name;

  describe('destroySegment', () => {
    it.each(['a', 'b'] as const)(
      'reports and audits a shred whose write landed (%s)',
      async (fault) => {
        const w = world();
        await load(w, SEG, 1);
        w.registry.arm('compareAndSwap', fault);

        const res = await destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit });

        expect(res).toMatchObject({ destroyed: true, cryptoShredded: true });
        expect(res.reason).toBeUndefined();
        expect(w.audit.snapshot()).toEqual([
          {
            kind: 'segment.erase',
            namespace: 'ns',
            segment: 's',
            incarnation: await incarnationNow(w),
          },
        ]);
        expect((await w.raw.get(SEG))?.wrappedDeks).toBeUndefined();
      },
    );

    it('throws a shred that never landed, leaves the row, and its re-run shreds and audits', async () => {
      const w = world();
      await load(w, SEG, 1);
      w.registry.arm('compareAndSwap', 'c');

      await expect(
        destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit }),
      ).rejects.toBeInstanceOf(TransientError);
      expect((await w.raw.get(SEG))?.status).toBe('active');
      expect(w.audit.snapshot()).toEqual([]);

      const again = await destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit });
      expect(again).toMatchObject({ destroyed: true, cryptoShredded: true });
      expect(kinds(w)).toEqual(['segment.erase']);
    });

    it('throws when the read-back failed too, and its re-run answers already with no event (the documented limit)', async () => {
      const w = world();
      await load(w, SEG, 1);
      w.registry.arm('compareAndSwap', 'a');
      w.registry.failReads(3);

      await expect(
        destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit }),
      ).rejects.toBeInstanceOf(TransientError);
      w.registry.failReads(0);
      expect((await w.raw.get(SEG))?.status).toBe('destroyed');

      const again = await destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit });
      expect(again).toMatchObject({ destroyed: true, cryptoShredded: false, reason: 'already' });
      expect(w.audit.snapshot()).toEqual([]);
    });

    it('reports a landed shred from the read-back itself, not from a second read of the row', async () => {
      const w = world();
      await load(w, SEG, 1);
      w.registry.arm('compareAndSwap', 'a');
      w.registry.failReads(1, 1); // the read-back answers; the next read of the row fails

      const res = await destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit });

      expect(res).toMatchObject({ destroyed: true, cryptoShredded: true });
      expect(kinds(w)).toEqual(['segment.erase']);
    });

    it('does not take a tombstone another call wrote for its own', async () => {
      const w = world();
      await load(w, SEG, 1);
      w.registry.arm('compareAndSwap', 'c');
      w.registry.between(async () => {
        await destroySegment(SEG, { registry: w.raw }, CONFIRM); // another process shreds it first
      });

      const res = await destroySegment(SEG, w.deps, { ...CONFIRM, audit: w.audit });

      expect(res).toMatchObject({ destroyed: true, cryptoShredded: false, reason: 'already' });
      expect(w.audit.snapshot()).toEqual([]);
    });

    it("keeps today's behaviour on a registry that reports no write tokens", async () => {
      const w = world();
      await load(w, SEG, 1);
      w.registry.arm('compareAndSwap', 'a');
      const deps = { ...w.deps, registry: withoutTokenReports(w.registry) };

      await expect(
        destroySegment(SEG, deps, { ...CONFIRM, audit: w.audit }),
      ).rejects.toBeInstanceOf(TransientError);
      expect(w.audit.snapshot()).toEqual([]);
    });
  });

  describe('eraseNamespace', () => {
    async function two(w: World): Promise<void> {
      await load(w, { namespace: 'ns', segment: 'a' }, 1);
      await load(w, { namespace: 'ns', segment: 'b' }, 1);
    }
    const options = (w: World) => ({ confirmNamespace: 'ns', audit: w.audit });

    it.each(['a', 'b'] as const)(
      'reports and counts a shred whose write landed (%s)',
      async (fault) => {
        const w = world();
        await two(w);
        w.registry.arm('compareAndSwap', fault, isSegment('a'));

        const { destroyed } = await eraseNamespace('ns', w.deps, options(w));

        expect(destroyed.map((d) => [d.segment, d.destroyed, d.cryptoShredded, d.reason])).toEqual([
          ['a', true, true, undefined],
          ['b', true, true, undefined],
        ]);
        const events = w.audit.snapshot();
        expect(events.filter((e) => e.kind === 'segment.erase')).toHaveLength(2);
        expect(events.at(-1)).toEqual({
          kind: 'namespace.erase',
          namespace: 'ns',
          segmentsShredded: 2,
        });
      },
    );

    it('records a shred that never landed as failed, with destroyed false', async () => {
      const w = world();
      await two(w);
      w.registry.arm('compareAndSwap', 'c', isSegment('a'));

      const { destroyed } = await eraseNamespace('ns', w.deps, options(w));

      const a = destroyed.find((d) => d.segment === 'a')!;
      expect(a.destroyed).toBe(false);
      expect(a.reason).toMatch(/^failed: /);
      expect(w.audit.snapshot().at(-1)).toMatchObject({ segmentsShredded: 1 });
    });
  });

  describe('dropSegment', () => {
    it.each(['a', 'b'] as const)(
      'shreds, sweeps and audits after a lost answer (%s)',
      async (fault) => {
        const w = world();
        await load(w, SEG, 2);
        w.registry.arm('compareAndSwap', fault);

        const res = await w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit });

        expect(res).toMatchObject({
          dropped: true,
          cryptoShredded: true,
          generationsDeleted: [0, 1],
          generationsRemaining: [],
        });
        expect(res.reason).toBeUndefined();
        expect(w.audit.snapshot()).toEqual([
          {
            kind: 'segment.erase',
            namespace: 'ns',
            segment: 's',
            incarnation: await incarnationNow(w),
          },
          {
            kind: 'segment.dispose',
            namespace: 'ns',
            segment: 's',
            incarnation: await incarnationNow(w),
            generationsDeleted: 2,
          },
        ]);
        expect(await present(w)).toEqual([]);
      },
    );

    it('throws a shred that never landed, deleting nothing', async () => {
      const w = world();
      await load(w, SEG, 2);
      w.registry.arm('compareAndSwap', 'c');

      await expect(
        w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit }),
      ).rejects.toBeInstanceOf(TransientError);
      expect(await present(w)).toEqual([0, 1]);
      expect(w.audit.snapshot()).toEqual([]);
    });
  });

  describe('dropSegment of a segment with no row', () => {
    const orphans = async (w: World): Promise<void> => {
      for (const generation of [0, 1]) {
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation }, [generation + 1], {});
      }
    };

    it.each(['a', 'b'] as const)('settles its tombstone create (%s)', async (fault) => {
      const w = world();
      await orphans(w);
      w.registry.arm('create', fault);

      const res = await w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit });

      expect(res).toMatchObject({
        dropped: true,
        cryptoShredded: false,
        generationsDeleted: [0, 1],
        generationsRemaining: [],
      });
      expect(res.reason).toBeUndefined();
      expect(w.audit.snapshot()).toEqual([
        {
          kind: 'segment.dispose',
          namespace: 'ns',
          segment: 's',
          incarnation: await incarnationNow(w),
          generationsDeleted: 2,
        },
      ]);
    });

    it('does not take a tombstone another writer created for its own', async () => {
      const w = world();
      await orphans(w);
      w.registry.arm('create', 'c');
      w.registry.between(async () => {
        await w.raw.create(SEG, { currentGen: 1, status: 'destroyed' });
      });

      const res = await w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit });

      expect(res).toMatchObject({ dropped: true, reason: 'already', generationsDeleted: [0, 1] });
    });

    it('throws a create that never landed, writing no row and deleting nothing', async () => {
      const w = world();
      await orphans(w);
      w.registry.arm('create', 'c');

      await expect(
        w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit }),
      ).rejects.toBeInstanceOf(TransientError);
      expect(await w.raw.get(SEG)).toBeNull();
      expect(await present(w)).toEqual([0, 1]);
    });
  });

  describe('retireExpired', () => {
    const entryOf = (entries: readonly RetireEntry[]): RetireEntry => entries[0]!;

    async function expired(w: World, n = 2): Promise<void> {
      await load(w, SEG, n);
      await w.storeOver(w.storage, w.raw).setRetention(SEG, { expiresAt: T0 - DAY });
    }

    it.each(['a', 'b'] as const)(
      'retires through a shred whose write landed (%s)',
      async (fault) => {
        const w = world();
        await expired(w);
        w.registry.arm('compareAndSwap', fault, () => true);
        // The policy write above is made on the raw registry; only the sweep's own shred is armed.

        const res = await w.store().retireExpired({ now: T0, audit: w.audit });

        expect(entryOf(res.entries)).toMatchObject({
          action: 'retired',
          result: {
            dropped: true,
            cryptoShredded: true,
            generationsDeleted: [0, 1],
            generationsRemaining: [],
          },
        });
        expect(entryOf(res.entries)).not.toHaveProperty('fault');
        expect(kinds(w)).toEqual(['segment.erase', 'segment.dispose']);
        expect(await present(w)).toEqual([]);
      },
    );

    it('reports a shred that landed and a listing that then failed, with what is left', async () => {
      const w = world();
      await expired(w);
      const storage = faultyStorage(w.storage);
      storage.failListsAfter(async () => (await w.raw.get(SEG))?.status === 'destroyed', 1);

      const res = await w.storeOver(storage, w.registry).retireExpired({ now: T0, audit: w.audit });

      expect(entryOf(res.entries)).toMatchObject({
        action: 'retired',
        result: { dropped: true, cryptoShredded: true, generationsRemaining: [0, 1] },
      });
      expect(entryOf(res.entries)).toHaveProperty('fault');
      expect(kinds(w)).toEqual(['segment.erase']);
    });

    it('reports a lost shred answer whose read-back also failed, with what is left and no event', async () => {
      const w = world();
      await expired(w);
      w.registry.arm('compareAndSwap', 'a');
      w.registry.failReads(3);

      const res = await w.store().retireExpired({ now: T0, audit: w.audit });

      expect(entryOf(res.entries)).toMatchObject({
        action: 'retired',
        result: { dropped: true, cryptoShredded: true, generationsRemaining: [0, 1] },
      });
      expect(entryOf(res.entries)).toHaveProperty('fault');
      expect(w.audit.snapshot()).toEqual([]);
      expect(await present(w)).toEqual([0, 1]);
    });

    it("does not claim a tombstone of another incarnation that carries the sweep's mark", async () => {
      const w = world();
      await expired(w);
      w.registry.arm('compareAndSwap', 'a');
      w.registry.failReads(3);
      w.registry.between(async () => {
        // The segment is purged and created again as a tombstone with this sweep's mark, as the shred's answer is lost.
        await w.raw.delete(SEG);
        await w.raw.create(SEG, {
          currentGen: null,
          status: 'destroyed',
          retention: { retiredBySweepAt: T0 },
        });
      });

      const res = await w.store().retireExpired({ now: T0, audit: w.audit });

      expect(entryOf(res.entries)).toMatchObject({ action: 'skipped' });
      expect(res.retired).toBe(0);
    });

    it('leaves the segment for the next call when the shred never landed', async () => {
      const w = world();
      await expired(w);
      w.registry.arm('compareAndSwap', 'c');

      const res = await w.store().retireExpired({ now: T0, audit: w.audit });

      expect(entryOf(res.entries)).toMatchObject({ action: 'skipped' });
      expect((await w.raw.get(SEG))?.status).toBe('active');
      expect(await present(w)).toEqual([0, 1]);

      const next = await w.store().retireExpired({ now: T0, audit: w.audit });
      expect(entryOf(next.entries)).toMatchObject({ action: 'retired' });
    });
  });

  describe('a cleartext destroy', () => {
    const destroyEvent = async (w: World, ref: SegmentRef = SEG) => ({
      kind: 'segment.destroy',
      namespace: ref.namespace,
      segment: ref.segment,
      incarnation: await incarnationNow(w, ref),
      objectsReadable: true,
    });

    it('destroySegment with allowCleartext emits segment.destroy, and not segment.erase', async () => {
      const w = world();
      await load(w, SEG, 1, true);

      const res = await destroySegment(SEG, w.deps, {
        ...CONFIRM,
        allowCleartext: true,
        audit: w.audit,
      });

      expect(res).toMatchObject({ destroyed: true, cryptoShredded: false });
      expect(w.audit.snapshot()).toEqual([await destroyEvent(w)]);
      expect(await present(w)).toEqual([0]);
    });

    it('its re-run emits nothing, and a cleartext segment refused without allowCleartext emits nothing', async () => {
      const w = world();
      await load(w, SEG, 1, true);
      await destroySegment({ namespace: 'ns', segment: 'other' }, w.deps, {
        confirmSegment: 'other',
        audit: w.audit,
      });
      await load(w, { namespace: 'ns', segment: 'kept' }, 1, true);
      const refused = await destroySegment({ namespace: 'ns', segment: 'kept' }, w.deps, {
        confirmSegment: 'kept',
        audit: w.audit,
      });
      expect(refused.reason).toBe('cleartext');

      await destroySegment(SEG, w.deps, { ...CONFIRM, allowCleartext: true, audit: w.audit });
      const again = await destroySegment(SEG, w.deps, {
        ...CONFIRM,
        allowCleartext: true,
        audit: w.audit,
      });

      expect(again.reason).toBe('already');
      expect(w.audit.snapshot()).toHaveLength(1);
    });

    it('a lost answer is settled and audited the same way', async () => {
      const w = world();
      await load(w, SEG, 1, true);
      w.registry.arm('compareAndSwap', 'a');

      await destroySegment(SEG, w.deps, { ...CONFIRM, allowCleartext: true, audit: w.audit });

      expect(w.audit.snapshot()).toEqual([await destroyEvent(w)]);
    });

    it('eraseNamespace with allowCleartext emits one per cleartext segment it tombstoned, counted in none of segmentsShredded', async () => {
      const w = world();
      const a = { namespace: 'ns', segment: 'a' };
      await load(w, a, 1, true);
      await load(w, { namespace: 'ns', segment: 'b' }, 1);

      await eraseNamespace('ns', w.deps, {
        confirmNamespace: 'ns',
        allowCleartext: true,
        audit: w.audit,
      });

      const events = w.audit.snapshot();
      expect(events.filter((e) => e.kind === 'segment.destroy')).toEqual([
        await destroyEvent(w, a),
      ]);
      expect(events.filter((e) => e.kind === 'segment.erase')).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        kind: 'namespace.erase',
        namespace: 'ns',
        segmentsShredded: 1,
      });
    });

    it('a cleartext dropSegment emits segment.dispose only', async () => {
      const w = world();
      await load(w, SEG, 1, true);
      await w.store().dropSegment(SEG, { ...CONFIRM, audit: w.audit });
      expect(kinds(w)).toEqual(['segment.dispose']);
    });
  });
});
