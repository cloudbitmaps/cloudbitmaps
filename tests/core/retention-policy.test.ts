import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  MIN_EXPIRES_AT_MS,
  bulkLoadCrbmGeneration,
  compactSegment,
  destroySegment,
  clearSegmentRetention,
  readRetentionPolicy,
  setSegmentRetention,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { UnsupportedError, ValidationError, WriteConflictError } from '@/core/errors';
import type { CompactionDeps, SegmentRef } from '@/index';
import type { IRegistryDriver } from '@/core/ports';
import { randomBytes } from 'node:crypto';

/**
 * The retention **policy** — recording *when* a segment becomes eligible for retirement. Part 2 of 3: this
 * writes and reads the intent only. Nothing here deletes anything (`dropSegment` does), and nothing here runs on
 * a timer (`retireExpired` is the sweep, and the operator schedules it).
 *
 * Two properties carry the design:
 *
 *  - **The expiry is an absolute instant the writer sets.** Anything the library could derive it from —
 *    `updatedAt`, the current generation — is rewritten by compaction, so a derived TTL would keep a busy daily
 *    bucket alive forever precisely because the daemon is doing its job. A test asserts a compaction leaves the
 *    policy untouched.
 *  - **Setting a policy on an accumulator mints the Part-1 null-gen row.** That is what makes the segment
 *    enumerable — and therefore sweepable — without changing a single read.
 */

/** Interpose on the registry's mutating methods to reproduce contention. Mirrors the Part-1 test helper. */
function wrapRegistry(
  base: IRegistryDriver,
  hooks: {
    onCreate?: () => Promise<void> | void;
    onCas?: () => 'pass' | 'conflict';
  },
): IRegistryDriver {
  return {
    capabilities: () => base.capabilities(),
    get: (ref) => base.get(ref),
    create: async (ref, rec) => {
      await hooks.onCreate?.();
      return base.create(ref, rec);
    },
    compareAndSwap: (ref, expected, patch) => {
      if (hooks.onCas?.() === 'conflict') {
        return Promise.reject(new WriteConflictError('interposed registry conflict'));
      }
      return base.compareAndSwap(ref, expected, patch);
    },
    list: (ns) => base.list(ns),
    delete: (ref) => base.delete(ref),
  };
}

const SEG: SegmentRef = { segment: 's' };
const DAY = 86_400_000;
const FUTURE = MIN_EXPIRES_AT_MS + 500 * DAY;

function world(keystore?: InProcessKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => 1_000 }, keystore };
  const store = (): CloudRoaring =>
    new CloudRoaring({
      warm,
      cold,
      registry,
      keystore,
      retry: false,
    });
  return { cold, warm, registry, deps, store };
}

describe('setRetention / getRetention / clearRetention', () => {
  it('mints a null-gen row for an accumulator, leaving every read unchanged', async () => {
    const w = world();
    const store = w.store();
    await store.segment('s').addMany([1, 2, 3, 100_000]);
    expect(await w.registry.get(SEG)).toBeNull(); // an accumulator has no row at all…

    const res = await store.setRetention(SEG, { expiresAt: FUTURE });
    expect(res).toEqual({
      segment: 's',
      namespace: undefined,
      expiresAt: FUTURE,
      createdRow: true,
    });

    // …and now it does — enumerable by every fleet-wide operation, which is the entire point of Part 1.
    const rec = (await w.registry.get(SEG))!;
    expect(rec.currentGen).toBeNull(); // claims NO Cold generation, so reads resolve exactly as before
    expect(rec.status).toBe('active');
    expect(rec.retention).toEqual({ expiresAt: FUTURE });

    // The reads themselves, after the row exists.
    const s = w.store().segment('s');
    expect(await s.count()).toBe(4);
    expect(await s.has(100_000)).toBe(true);
    expect(await w.store().getRetention(SEG)).toEqual({ expiresAt: FUTURE });
  });

  it('updates the policy on a segment that already has a row, preserving the rest of it', async () => {
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const before = (await w.registry.get(SEG))!;

    const res = await w.store().setRetention(SEG, { expiresAt: FUTURE });
    expect(res.createdRow).toBe(false);
    const after = (await w.registry.get(SEG))!;
    expect(after.retention).toEqual({ expiresAt: FUTURE });
    expect(after.currentGen).toBe(0); // the pointer is untouched
    expect(after.createdAt).toBe(before.createdAt);
    expect(await w.store().segment('s').count()).toBe(2);
  });

  it('owns one key: other governance metadata on the row survives set and clear', async () => {
    const w = world();
    await w.registry.create(SEG, {
      currentGen: null,
      retention: { legalHold: 'case-1234', note: 'keep' },
    });

    await w.store().setRetention(SEG, { expiresAt: FUTURE });
    expect((await w.registry.get(SEG))!.retention).toEqual({
      legalHold: 'case-1234',
      note: 'keep',
      expiresAt: FUTURE,
    });

    expect(await w.store().clearRetention(SEG)).toBe(true);
    expect((await w.registry.get(SEG))!.retention).toEqual({
      legalHold: 'case-1234',
      note: 'keep',
    });
  });

  it('clears the whole field when removing the expiry empties it', async () => {
    // A row left carrying `{}` reads as "has retention metadata" to anything inspecting it — an empty object is
    // not the same statement as no policy.
    const w = world();
    await w.store().segment('s').add(1);
    await w.store().setRetention(SEG, { expiresAt: FUTURE });
    expect(await w.store().clearRetention(SEG)).toBe(true);
    expect((await w.registry.get(SEG))!.retention).toBeUndefined();
    expect(await w.store().getRetention(SEG)).toBeNull();
  });

  it('clearRetention reports whether anything was actually cleared', async () => {
    const w = world();
    expect(await w.store().clearRetention(SEG)).toBe(false); // no row at all
    await w.store().segment('s').add(1);
    expect(await w.store().clearRetention(SEG)).toBe(false); // still no row — writing one to say "no policy" is litter
    expect(await w.registry.get(SEG)).toBeNull();

    await w.store().setRetention(SEG, { expiresAt: FUTURE });
    expect(await w.store().clearRetention(SEG)).toBe(true);
    expect(await w.store().clearRetention(SEG)).toBe(false); // idempotent
  });

  it('is idempotent and overwrites a prior expiry', async () => {
    const w = world();
    await w.store().setRetention(SEG, { expiresAt: FUTURE });
    await w.store().setRetention(SEG, { expiresAt: FUTURE });
    expect(await w.store().getRetention(SEG)).toEqual({ expiresAt: FUTURE });
    await w.store().setRetention(SEG, { expiresAt: FUTURE + DAY });
    expect(await w.store().getRetention(SEG)).toEqual({ expiresAt: FUTURE + DAY });
  });

  describe('validation', () => {
    it('rejects an epoch-SECONDS value — the typo that would retire the segment immediately', async () => {
      // `Date.now() / 1000 + 30 * 86400` is a natural thing to write and lands in 1970: already expired. Without
      // this guard it is not an error, it is a deletion on the next sweep.
      const w = world();
      const seconds = Math.floor(FUTURE / 1000);
      await expect(w.store().setRetention(SEG, { expiresAt: seconds })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(w.store().setRetention(SEG, { expiresAt: seconds })).rejects.toThrow(/SECONDS/);
      expect(await w.registry.get(SEG)).toBeNull(); // and nothing was written
    });

    it('rejects a non-integer, NaN, Infinity or negative expiry', async () => {
      const w = world();
      for (const bad of [1.5, NaN, Infinity, -1, -FUTURE]) {
        await expect(w.store().setRetention(SEG, { expiresAt: bad })).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
    });

    it('accepts a past-but-plausible expiry — backfilling a policy is normal', async () => {
      const w = world();
      await w.store().setRetention(SEG, { expiresAt: MIN_EXPIRES_AT_MS });
      expect(await w.store().getRetention(SEG)).toEqual({ expiresAt: MIN_EXPIRES_AT_MS });
    });

    it('refuses to put a policy on a crypto-shredded tombstone', async () => {
      const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
      const w = world(keystore);
      const minted = await keystore.createDek();
      await w.registry.create(SEG, { currentGen: 0, wrappedDeks: minted.wrapped });
      await destroySegment(SEG, { registry: w.registry, warm: w.warm }, { confirmSegment: 's' });

      // A tombstone has nothing left to retire; a policy on one would have a sweep "retiring" it forever.
      await expect(w.store().setRetention(SEG, { expiresAt: FUTURE })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await w.store().getRetention(SEG)).toBeNull();
      expect(await w.store().clearRetention(SEG)).toBe(false);
    });

    it('needs a registry in the store config', async () => {
      const store = new CloudRoaring({
        warm: new MemoryWarmDriver(),
        cold: new CrbmColdChunkSource(new MemoryColdDriver()),
        retry: false,
      });
      await expect(store.setRetention(SEG, { expiresAt: FUTURE })).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      await expect(store.getRetention(SEG)).rejects.toBeInstanceOf(UnsupportedError);
      await expect(store.clearRetention(SEG)).rejects.toBeInstanceOf(UnsupportedError);
    });

    it('validates the segment ref like every other admin call', async () => {
      const w = world();
      await expect(
        w.store().setRetention({ segment: '../etc/passwd' }, { expiresAt: FUTURE }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('a malformed policy is visible, not silently "never expires"', () => {
    it('reads as `invalid` rather than null', async () => {
      const w = world();
      // How this happens in practice: a hand-edited row, an older writer, or a restore from a different schema.
      await w.registry.create(SEG, { currentGen: null, retention: { expiresAt: 'tomorrow' } });
      expect(await w.store().getRetention(SEG)).toBe('invalid');
      // Seconds stored directly (bypassing the setter's guard) is the same class of problem.
      await w.registry.create(
        { segment: 'secs' },
        { currentGen: null, retention: { expiresAt: 1_786_000_000 } },
      );
      expect(await w.store().getRetention({ segment: 'secs' })).toBe('invalid');
    });

    it('the reader distinguishes all three states', () => {
      expect(readRetentionPolicy(undefined)).toBeNull();
      expect(readRetentionPolicy({})).toBeNull();
      expect(readRetentionPolicy({ legalHold: 'x' })).toBeNull();
      expect(readRetentionPolicy({ expiresAt: FUTURE })).toEqual({ expiresAt: FUTURE });
      expect(readRetentionPolicy({ expiresAt: null })).toBe('invalid');
      // The CONTAINER, not just the value: `in` dereferences its operand, so these used to throw an untyped
      // `TypeError` — and the sweep calls this outside its per-segment `try`, so one such row aborted the whole
      // fleet sweep and the healthy expired segment beside it was never retired.
      for (const bad of [null, 'nope', 42, [], true]) {
        expect(readRetentionPolicy(bad as never)).toBe('invalid');
      }
      expect(readRetentionPolicy({ expiresAt: 1.5 })).toBe('invalid');
      expect(readRetentionPolicy({ expiresAt: 1_786_000_000 })).toBe('invalid');
    });

    it('a set fixes it — writing over an invalid value is allowed', async () => {
      const w = world();
      await w.registry.create(SEG, { currentGen: null, retention: { expiresAt: 'tomorrow' } });
      await w.store().setRetention(SEG, { expiresAt: FUTURE });
      expect(await w.store().getRetention(SEG)).toEqual({ expiresAt: FUTURE });
    });
  });

  describe('contention — the CAS retry the module exists for', () => {
    // Without these, `RETENTION_CAS_ATTEMPTS = 5 → 1` passes the whole suite: the retry loop is dead code to it.
    it('recovers when a compaction bootstrap creates the row first', async () => {
      const w = world();
      await w.store().segment('s').addMany([1, 2, 3]);
      // The race the code comments name: our `get()` sees no row, and a bootstrap publishes gen 0 before our
      // `create` lands. The policy must still end up on the row, and `createdRow` must tell the truth about who
      // made it.
      let raced = false;
      const registry = wrapRegistry(w.registry, {
        onCreate: async () => {
          if (raced) return;
          raced = true;
          await compactSegment(SEG, w.deps, { owner: 'worker-1' }); // publishes gen 0, so our create conflicts
        },
      });

      const res = await setSegmentRetention(SEG, { registry }, { expiresAt: FUTURE });
      expect(res.createdRow).toBe(false);
      const rec = (await w.registry.get(SEG))!;
      expect(rec.currentGen).toBe(0); // the bootstrap's pointer survived
      expect(rec.retention).toEqual({ expiresAt: FUTURE }); // and so did our policy
    });

    it('reports a conflict rather than partially applying, when contention never clears', async () => {
      const w = world();
      await w.registry.create(SEG, { currentGen: null });
      const registry = wrapRegistry(w.registry, { onCas: () => 'conflict' });
      await expect(
        setSegmentRetention(SEG, { registry }, { expiresAt: FUTURE }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect((await w.registry.get(SEG))!.retention).toBeUndefined(); // nothing landed
    });

    it('clearRetention behaves the same way under sustained contention', async () => {
      const w = world();
      await w.store().setRetention(SEG, { expiresAt: FUTURE });
      const registry = wrapRegistry(w.registry, { onCas: () => 'conflict' });
      await expect(clearSegmentRetention(SEG, { registry })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
      expect((await w.registry.get(SEG))!.retention).toEqual({ expiresAt: FUTURE }); // still set
    });
  });

  describe('the policy survives the segment lifecycle', () => {
    it('a compaction does not move the expiry — the reason it is absolute, not derived', async () => {
      // This is the whole argument for a writer-set instant. Compaction rewrites `currentGen` and `updatedAt`, so
      // a policy derived from either would slide forward on every cycle and a busy daily bucket would never
      // expire — its expiry postponed by exactly the maintenance meant to keep it cheap.
      const w = world();
      await w.store().segment('s').addMany([1, 2, 3]);
      await w.store().setRetention(SEG, { expiresAt: FUTURE });

      const res = await compactSegment(SEG, w.deps, { owner: 'worker-1' });
      expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0 });
      expect((await w.registry.get(SEG))!.retention).toEqual({ expiresAt: FUTURE });

      // …and again across a second, ordinary (non-bootstrap) compaction.
      await w.store().segment('s').add(4);
      const second = await compactSegment(SEG, w.deps, { owner: 'worker-1' });
      expect(second).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
      expect((await w.registry.get(SEG))!.retention).toEqual({ expiresAt: FUTURE });
    });

    it('the policy is carried by `list()`, so a fleet sweep needs no per-segment read', async () => {
      const w = world();
      for (const day of ['2026-08-03', '2026-08-04']) {
        await w.store().segment(day).add(1);
        await w.store().setRetention({ segment: day }, { expiresAt: FUTURE });
      }
      const seen = new Map<string, unknown>();
      for await (const rec of w.registry.list()) seen.set(rec.segment, rec.retention);
      expect(seen.get('2026-08-03')).toEqual({ expiresAt: FUTURE });
      expect(seen.get('2026-08-04')).toEqual({ expiresAt: FUTURE });
    });
  });
});
