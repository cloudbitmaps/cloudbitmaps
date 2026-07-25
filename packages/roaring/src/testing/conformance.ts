/**
 * Shared driver conformance suite (finding V8).
 *
 * A backend is only "supported" once it's green here. Every `IWarmDriver` / `ColdChunkSource`
 * implementation — first-party (in-memory, LocalFs) and community — runs the **same** contract tests via
 * these factories, so substitutability is proven, not assumed. The factories use Vitest globals
 * (`describe`/`it`/`expect`); a driver author wires them into their own test file with a factory that
 * produces a fresh, isolated driver per call.
 *
 * An **in-repo** SDK helper for now: consumed by this repo's tests via the `@/` path alias. Publishing it
 * as a `./testing` package subpath (with `vitest` as a peerDependency) is deferred to Phase 7, when the
 * first external/community driver lands (YAGNI). It is never imported by the library entry point, so it
 * stays out of the published runtime bundle either way.
 */
import { describe, expect, it } from 'vitest';
import { SafeBitmap } from '../roaring-codec';
import { NO_ROW } from '@cloudbitmaps/core';
import type {
  ChunkRef,
  ColdChunkSource,
  IRegistryDriver,
  IWarmDriver,
  SegmentRef,
} from '@cloudbitmaps/core';
import {
  ValidationError,
  WriteConflictError,
  isTransientError,
  isWriteConflictError,
} from '@cloudbitmaps/core';

const SEG: SegmentRef = { segment: 's' };
const ref = (chunkKey: number): ChunkRef => ({ segment: 's', chunkKey });
const bytes = (...b: number[]): Uint8Array => Uint8Array.of(...b);

/** Names a conformant driver MUST reject at its boundary (grammar + traversal + control chars). */
const BAD_NAMES: readonly string[] = [
  '', // empty
  '.', // dot
  '..', // dot-dot
  'a..b', // embedded traversal
  '.hidden', // leading dot
  '-leading', // leading dash
  'a/b', // path separator
  'a\\b', // backslash
  'a b', // space
  'a\tb', // tab
  'a\nb', // newline
  'a'.repeat(257), // over the 256 length cap
];

async function expectValidationReject(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ValidationError);
}

/**
 * Contract tests for an {@link IWarmDriver}. `makeDriver` MUST return a fresh, empty, isolated driver on
 * each call (e.g. a new temp dir for a filesystem driver).
 */
export function warmConformance(label: string, makeDriver: () => IWarmDriver): void {
  describe(`IWarmDriver conformance: ${label}`, () => {
    it('create-if-absent, read back, then update with the token (D1)', async () => {
      const d = makeDriver();
      expect(await d.get(ref(1))).toBeNull();
      const { token: t0 } = await d.putConditional(ref(1), bytes(1, 2), NO_ROW);
      const row = await d.get(ref(1));
      expect(row).not.toBeNull();
      expect([...row!.bytes]).toEqual([1, 2]);
      expect(row!.token).toBe(t0);
      const { token: t1 } = await d.putConditional(ref(1), bytes(3), t0);
      expect(t1).not.toBe(t0);
      expect([...(await d.get(ref(1)))!.bytes]).toEqual([3]);
    });

    it('rejects create-if-absent when the row exists (D1)', async () => {
      const d = makeDriver();
      await d.putConditional(ref(1), bytes(1), NO_ROW);
      await expect(d.putConditional(ref(1), bytes(2), NO_ROW)).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('rejects a stale-token update and leaves the row unchanged (D1)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.putConditional(ref(1), bytes(1), NO_ROW);
      await d.putConditional(ref(1), bytes(2), t0);
      await expect(d.putConditional(ref(1), bytes(9), t0)).rejects.toBeInstanceOf(
        WriteConflictError,
      );
      expect([...(await d.get(ref(1)))!.bytes]).toEqual([2]);
    });

    it('fenced delete only with the current token (D2)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.putConditional(ref(1), bytes(1), NO_ROW);
      const { token: t1 } = await d.putConditional(ref(1), bytes(2), t0);
      await expect(d.deleteConditional(ref(1), t0)).rejects.toBeInstanceOf(WriteConflictError);
      await d.deleteConditional(ref(1), t1);
      expect(await d.get(ref(1))).toBeNull();
    });

    it('never reuses a token across delete→recreate (ABA-safe, D3)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.putConditional(ref(1), bytes(1), NO_ROW);
      await d.deleteConditional(ref(1), t0);
      const { token: t0b } = await d.putConditional(ref(1), bytes(2), NO_ROW);
      expect(t0b).not.toBe(t0);
      await expect(d.putConditional(ref(1), bytes(9), t0)).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('serializes concurrent read-modify-write with no lost updates (D4)', async () => {
      const d = makeDriver();
      // This asserts the OCC contract — **no lost updates** under real concurrency — not that a raw driver never
      // emits a transient fault. So the loop rides out BOTH outcomes a real caller sees:
      //   • WriteConflictError → the OCC race we are actually testing; re-read and retry, unbounded.
      //   • TransientError     → an infrastructure hiccup the production stack already absorbs, because
      //     `CloudRoaring` wraps every warm driver in `RetryingWarmDriver` by default. Retrying it here makes the
      //     contract test reflect real usage instead of failing on it. Concretely: a cold Cassandra node whose
      //     Paxos layer isn't warm yet answers a burst of `INSERT … IF NOT EXISTS` with
      //     "Server timeout … at consistency SERIAL (0 peer(s) acknowledged)" — a recurring CI flake that says
      //     nothing about lost updates. BOUNDED (unlike the conflict path) so a driver that only ever throws
      //     transients still fails loudly rather than spinning forever.
      const MAX_TRANSIENT_RETRIES = 25;
      const append = async (b: number): Promise<void> => {
        let transients = 0;
        for (;;) {
          const cur = await d.get(ref(1));
          try {
            if (cur === null) await d.putConditional(ref(1), bytes(b), NO_ROW);
            else await d.putConditional(ref(1), Uint8Array.of(...cur.bytes, b), cur.token);
            return;
          } catch (err) {
            if (isWriteConflictError(err)) continue;
            if (isTransientError(err) && ++transients <= MAX_TRANSIENT_RETRIES) {
              // Brief linear backoff — a cold coordinator needs a moment, and this keeps the burst from
              // hammering it while it settles.
              await new Promise((r) => setTimeout(r, 50 * transients));
              continue;
            }
            throw err;
          }
        }
      };
      const want = Array.from({ length: 15 }, (_v, i) => i + 1);
      await Promise.all(want.map(append));
      expect([...(await d.get(ref(1)))!.bytes].sort((a, b) => a - b)).toEqual(want);
    });

    it('lists live chunks ascending, scoped to the segment, tombstones excluded', async () => {
      const d = makeDriver();
      for (const k of [9, 2, 65_535, 0, 13])
        await d.putConditional(ref(k), bytes(k & 0xff), NO_ROW);
      const { token } = await d.putConditional(ref(4), bytes(4), NO_ROW);
      await d.deleteConditional(ref(4), token);
      await d.putConditional({ namespace: 'other', segment: 's', chunkKey: 7 }, bytes(1), NO_ROW);
      const seen: number[] = [];
      for await (const row of d.listChunks(SEG)) seen.push(row.chunkKey);
      expect(seen).toEqual([0, 2, 9, 13, 65_535]);
    });

    it('rejects out-of-range chunk keys (D7)', async () => {
      const d = makeDriver();
      for (const bad of [70_000, -1, 1.5, NaN]) {
        await expectValidationReject(d.get(ref(bad)));
      }
    });

    it('rejects traversal / invalid names on every method (D7)', async () => {
      const d = makeDriver();
      for (const name of BAD_NAMES) {
        await expectValidationReject(d.get({ segment: name, chunkKey: 0 }));
        await expectValidationReject(d.get({ namespace: name, segment: 's', chunkKey: 0 }));
        await expectValidationReject(
          d.putConditional({ segment: name, chunkKey: 0 }, bytes(1), NO_ROW),
        );
        await expectValidationReject(d.deleteConditional({ segment: name, chunkKey: 0 }, '1'));
        await expectValidationReject(drainKeys(d.listChunks({ segment: name })));
      }
    });
  });
}

/** Drain an async iterable so a generator that validates lazily actually runs (and can reject). */
async function drainKeys(it: AsyncIterable<{ chunkKey: number }>): Promise<number[]> {
  const out: number[] = [];
  for await (const row of it) out.push(row.chunkKey);
  return out;
}

/**
 * Contract tests for a {@link ColdChunkSource}. `makeSource` MUST build a fresh source seeded with the
 * given chunks (each an immutable Cold bitmap) and nothing else.
 */
export function coldChunkSourceConformance(
  label: string,
  makeSource: (chunks: Array<{ chunkKey: number; bitmap: SafeBitmap }>) => Promise<ColdChunkSource>,
): void {
  describe(`ColdChunkSource conformance: ${label}`, () => {
    it('round-trips every chunk across container types, ascending keys', async () => {
      // Distinct bitmaps spanning array-container, single-value, dense (>4096 → bitmap container), and
      // the max chunk key — so a source that mixes payloads up between chunks fails here.
      const seed = [
        { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
        { chunkKey: 5, bitmap: SafeBitmap.fromValues([7]) },
        { chunkKey: 42, bitmap: SafeBitmap.fromValues(Array.from({ length: 5000 }, (_v, i) => i)) },
        { chunkKey: 65_535, bitmap: SafeBitmap.fromValues([0, 65_535]) },
      ];
      const source = await makeSource(seed);

      expect((await source.listChunkKeys(SEG)).sort((a, b) => a - b)).toEqual([0, 5, 42, 65_535]);
      for (const { chunkKey, bitmap } of seed) {
        const got = await source.getChunk(ref(chunkKey));
        expect(got).not.toBeNull();
        expect(SafeBitmap.safeDeserialize(got!, 1 << 20).toArray()).toEqual(bitmap.toArray());
      }
    });

    it('returns null for an absent chunk and [] for an unknown segment', async () => {
      const source = await makeSource([{ chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) }]);
      expect(await source.getChunk(ref(999))).toBeNull();
      expect(await source.listChunkKeys({ segment: 'ghost' })).toEqual([]);
    });

    it('rejects traversal / invalid names (D7)', async () => {
      const source = await makeSource([{ chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) }]);
      for (const name of BAD_NAMES) {
        await expectValidationReject(source.getChunk({ segment: name, chunkKey: 0 }));
        await expectValidationReject(
          source.getChunk({ namespace: name, segment: 's', chunkKey: 0 }),
        );
        await expectValidationReject(source.listChunkKeys({ segment: name }));
      }
    });
  });
}

/** Drain a registry `list` into an array (segment names) so a lazily-validating generator actually runs. */
async function drainSegments(it: AsyncIterable<{ segment: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const r of it) out.push(r.segment);
  return out;
}

/**
 * Contract tests for an {@link IRegistryDriver}. `makeDriver` MUST return a fresh, empty, isolated driver on
 * each call. Mirrors the Warm OCC contract (create / token-fenced CAS / ABA) plus the registry's record
 * semantics (forward currentGen, status, clearable keyId, discovery).
 */
export function registryConformance(label: string, makeDriver: () => IRegistryDriver): void {
  describe(`IRegistryDriver conformance: ${label}`, () => {
    it('advertises strongRead', () => {
      expect(makeDriver().capabilities().strongRead).toBe(true);
    });

    it('create, read back the full record, then CAS with the token (R1)', async () => {
      const d = makeDriver();
      expect(await d.get(SEG)).toBeNull();
      const { token: t0 } = await d.create(SEG, {
        currentGen: 3,
        keyId: 'k1',
        retention: { days: 30 },
      });
      const rec = await d.get(SEG);
      expect(rec).not.toBeNull();
      expect(rec!.segment).toBe('s');
      expect(rec!.currentGen).toBe(3);
      expect(rec!.keyId).toBe('k1');
      expect(rec!.dirtyChunkCount).toBe(0); // default
      expect(rec!.status).toBe('active'); // default
      expect(rec!.retention).toEqual({ days: 30 });
      expect(rec!.token).toBe(t0);
      expect(rec!.updatedAt).toBeGreaterThanOrEqual(rec!.createdAt);

      const { token: t1 } = await d.compareAndSwap(SEG, t0, {
        currentGen: 4,
        status: 'compacting',
      });
      expect(t1).not.toBe(t0);
      const rec2 = await d.get(SEG);
      expect(rec2!.currentGen).toBe(4);
      expect(rec2!.status).toBe('compacting');
      expect(rec2!.createdAt).toBe(rec!.createdAt); // createdAt preserved across CAS
    });

    it('rejects create when the row exists (R1)', async () => {
      const d = makeDriver();
      await d.create(SEG, { currentGen: 0 });
      await expect(d.create(SEG, { currentGen: 1 })).rejects.toBeInstanceOf(WriteConflictError);
    });

    it('rejects a stale-token CAS and leaves the record unchanged (R2)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0 });
      await d.compareAndSwap(SEG, t0, { currentGen: 1 });
      await expect(d.compareAndSwap(SEG, t0, { currentGen: 9 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
      expect((await d.get(SEG))!.currentGen).toBe(1);
    });

    it('CAS against an absent row is a conflict', async () => {
      const d = makeDriver();
      await expect(d.compareAndSwap(SEG, '1', { currentGen: 1 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('round-trips non-default status / dirtyChunkCount / governance set at create', async () => {
      const d = makeDriver();
      await d.create(SEG, {
        currentGen: 2,
        dirtyChunkCount: 7,
        status: 'compacting',
        retention: { days: 30 },
        residency: { region: 'eu' },
      });
      const rec = await d.get(SEG);
      expect(rec).toMatchObject({
        currentGen: 2,
        dirtyChunkCount: 7,
        status: 'compacting',
        retention: { days: 30 },
        residency: { region: 'eu' },
      });
    });

    it('round-trips the daemon-health fields — consecutiveFailures + lastCompactedAt (Phase D)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0 });
      const created = await d.get(SEG);
      expect(created!.consecutiveFailures).toBe(0); // defaulted on create
      expect(created!.lastCompactedAt).toBeUndefined(); // absent until first compaction
      // A successful compaction stamps both via CAS.
      await d.compareAndSwap(SEG, t0, { lastCompactedAt: 123_456, consecutiveFailures: 3 });
      const rec = await d.get(SEG);
      expect(rec!.lastCompactedAt).toBe(123_456);
      expect(rec!.consecutiveFailures).toBe(3);
    });

    it('a patch can set and later CLEAR an optional field (keyId — crypto-shred path)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0, keyId: 'k1' });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { keyId: undefined });
      expect((await d.get(SEG))!.keyId).toBeUndefined();
      // unrelated patch leaves it cleared
      await d.compareAndSwap(SEG, t1, { dirtyChunkCount: 5 });
      const rec = await d.get(SEG);
      expect(rec!.keyId).toBeUndefined();
      expect(rec!.dirtyChunkCount).toBe(5);
    });

    it('round-trips the wrapped-DEK list through create → get → CAS-clear (crypto-shred path)', async () => {
      const d = makeDriver();
      const wrappedDeks = [
        { keyId: 'active', wrapped: 'YWN0aXZlLXdyYXBwZWQ=' },
        { keyId: 'recovery', wrapped: 'cmVjb3Zlcnktd3JhcHBlZA==' },
      ];
      const { token: t0 } = await d.create(SEG, { currentGen: 0, wrappedDeks });
      // Survives the create→get round-trip intact (every backend must serialize the list of {keyId, wrapped}).
      expect((await d.get(SEG))!.wrappedDeks).toEqual(wrappedDeks);
      // Survives an unrelated patch (not accidentally dropped)...
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { currentGen: 1 });
      expect((await d.get(SEG))!.wrappedDeks).toEqual(wrappedDeks);
      // ...and crypto-shred CLEARS it (the linchpin: the only DEK copy is gone).
      await d.compareAndSwap(SEG, t1, { wrappedDeks: undefined, status: 'destroyed' });
      const rec = await d.get(SEG);
      expect(rec!.wrappedDeks).toBeUndefined();
      expect(rec!.status).toBe('destroyed');
    });

    it('clears one governance field via patch without disturbing the other', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, {
        currentGen: 0,
        retention: { days: 30 },
        residency: { region: 'eu' },
      });
      // Clear retention only; residency must survive (guards the `'k' in patch` clear-vs-preserve idiom).
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { retention: undefined });
      expect((await d.get(SEG))!.retention).toBeUndefined();
      expect((await d.get(SEG))!.residency).toEqual({ region: 'eu' });
      // An unrelated patch leaves retention cleared and residency intact.
      await d.compareAndSwap(SEG, t1, { dirtyChunkCount: 1 });
      const rec = await d.get(SEG);
      expect(rec!.retention).toBeUndefined();
      expect(rec!.residency).toEqual({ region: 'eu' });
    });

    it('rejects an unknown status and a non-serializable governance blob (R7)', async () => {
      const d = makeDriver();
      await expectValidationReject(d.create(SEG, { currentGen: 0, status: 'bogus' as 'active' }));
      await expectValidationReject(
        d.create(SEG, {
          currentGen: 0,
          retention: { big: 1n } as unknown as Record<string, unknown>,
        }),
      );
    });

    it('never reuses a token across delete→recreate (ABA-safe, R3)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG);
      expect(await d.get(SEG)).toBeNull();
      const { token: t0b } = await d.create(SEG, { currentGen: 7 });
      expect(t0b).not.toBe(t0);
      await expect(d.compareAndSwap(SEG, t0, { currentGen: 9 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('delete is idempotent', async () => {
      const d = makeDriver();
      await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG);
      await d.delete(SEG); // no throw
      expect(await d.get(SEG)).toBeNull();
    });

    it('lists live records, scoped by namespace, excluding deleted', async () => {
      const d = makeDriver();
      await d.create({ segment: 'a' }, { currentGen: 0 });
      await d.create({ segment: 'b' }, { currentGen: 0 });
      await d.create({ namespace: 'tenant', segment: 'c' }, { currentGen: 0 });
      await d.delete({ segment: 'b' });
      expect((await drainSegments(d.list())).sort()).toEqual(['a', 'c']);
      expect(await drainSegments(d.list('tenant'))).toEqual(['c']);
      expect((await drainSegments(d.list(undefined))).sort()).toEqual(['a', 'c']);
    });

    it('rejects a negative / non-integer currentGen (R7)', async () => {
      const d = makeDriver();
      for (const bad of [-1, 1.5, NaN]) {
        await expectValidationReject(d.create(SEG, { currentGen: bad }));
      }
      const { token } = await d.create(SEG, { currentGen: 0 });
      await expectValidationReject(d.compareAndSwap(SEG, token, { currentGen: -5 }));
    });

    it('rejects traversal / invalid names on every method (R7)', async () => {
      const d = makeDriver();
      for (const name of BAD_NAMES) {
        await expectValidationReject(d.get({ segment: name }));
        await expectValidationReject(d.get({ namespace: name, segment: 's' }));
        await expectValidationReject(d.create({ segment: name }, { currentGen: 0 }));
        await expectValidationReject(d.compareAndSwap({ segment: name }, '1', { currentGen: 0 }));
        await expectValidationReject(d.delete({ segment: name }));
      }
    });
  });
}
