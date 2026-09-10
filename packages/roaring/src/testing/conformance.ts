/**
 * Shared driver conformance suite (finding V8).
 *
 * A backend is only "supported" once it's green here. Every `ColdChunkSource` / `IRegistryDriver`
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
import type {
  ChunkRef,
  ColdChunkSource,
  IRegistryDriver,
  RegistryRecord,
  SegmentRef,
} from '@cloudbitmaps/core';
import { ValidationError, WriteConflictError } from '@cloudbitmaps/core';

const SEG: SegmentRef = { segment: 's' };
const ref = (chunkKey: number): ChunkRef => ({ segment: 's', chunkKey });

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

async function drainRecords(it: AsyncIterable<RegistryRecord>): Promise<RegistryRecord[]> {
  const out: RegistryRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/**
 * Contract tests for an {@link IRegistryDriver}. `makeDriver` MUST return a fresh, empty, isolated driver on
 * each call. The OCC contract (create / token-fenced CAS / ABA) plus the registry's record semantics (forward
 * currentGen, status, clearable keyId, discovery).
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
      expect(rec!.status).toBe('active'); // default
      expect(rec!.retention).toEqual({ days: 30 });
      expect(rec!.token).toBe(t0);
      expect(rec!.updatedAt).toBeGreaterThanOrEqual(rec!.createdAt);

      const { token: t1 } = await d.compareAndSwap(SEG, t0, {
        currentGen: 4,
        residency: { region: 'eu' },
      });
      expect(t1).not.toBe(t0);
      const rec2 = await d.get(SEG);
      expect(rec2!.currentGen).toBe(4);
      expect(rec2!.residency).toEqual({ region: 'eu' });
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

    it('round-trips a non-default status + both governance blobs set at create', async () => {
      const d = makeDriver();
      await d.create(SEG, {
        currentGen: 2,
        status: 'destroyed',
        retention: { days: 30 },
        residency: { region: 'eu' },
      });
      const rec = await d.get(SEG);
      expect(rec).toMatchObject({
        currentGen: 2,
        status: 'destroyed',
        retention: { days: 30 },
        residency: { region: 'eu' },
      });
    });

    it('a patch can set and later CLEAR an optional field (keyId — crypto-shred path)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0, keyId: 'k1' });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { keyId: undefined });
      expect((await d.get(SEG))!.keyId).toBeUndefined();
      // unrelated patch leaves it cleared
      await d.compareAndSwap(SEG, t1, { residency: { region: 'eu' } });
      const rec = await d.get(SEG);
      expect(rec!.keyId).toBeUndefined();
      expect(rec!.residency).toEqual({ region: 'eu' });
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
      await d.compareAndSwap(SEG, t1, { keyId: 'k2' });
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

    // R8 — `currentGen: null` ("this segment exists and has no Cold generation yet") is a first-class stored
    // value, not a missing field. It is what lets a retention policy be recorded ahead of the first load, so every driver must
    // round-trip it through create, CAS, get AND list. Serialization is where this breaks silently: a driver
    // that JSON-drops it, coerces it to 0, or (the subtle one) merges a patch with `patch.currentGen ?? prev`
    // would leave the pointer at the old generation and read stale Cold data no one asked for.
    it('round-trips a null currentGen through create, list, and CAS in both directions (R8)', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: null, retention: { expiresAt: 42 } });
      const rec = await d.get(SEG);
      expect(rec!.currentGen).toBeNull();
      expect(rec!.status).toBe('active'); // null gen is a LIVE segment, not a tombstone
      expect(rec!.retention).toEqual({ expiresAt: 42 });
      // Enumeration must carry the WHOLE row, not just the pointer. A fleet sweep reads the policy straight out
      // of `list()` rather than paying a `get()` per segment, so a driver whose projection drops `retention` — or
      // stringifies the number — makes every segment read as "no policy" and **nothing ever expires**. That fails
      // open on a retention commitment and is visible only to someone reading a ledger.
      const listed = await drainRecords(d.list());
      expect(listed.map((r) => r.currentGen)).toEqual([null]);
      expect(listed[0]!.retention).toEqual({ expiresAt: 42 });

      // null → 0: the first load publishing a generation onto an existing row.
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { currentGen: 0 });
      expect((await d.get(SEG))!.currentGen).toBe(0);

      // 0 → null: clearing the pointer. The value is legal, so a driver must actually apply it; treating the
      // patch field as absent (the `??` merge bug) would silently leave `currentGen: 0` here.
      await d.compareAndSwap(SEG, t1, { currentGen: null });
      expect((await d.get(SEG))!.currentGen).toBeNull();

      // A patch that does not mention `currentGen` must NOT disturb it — the other half of the same trap.
      const cleared = await d.get(SEG);
      await d.compareAndSwap(SEG, cleared!.token, { keyId: 'k7' });
      const after = await d.get(SEG);
      expect(after!.currentGen).toBeNull();
      expect(after!.keyId).toBe('k7');
    });

    // R9 — a `destroyed` tombstone is still a record. `list()` must yield it: `runConsistencyCheck` skips
    // tombstones itself, and the retention sweep can only clean up a dead row it can *see* — a driver that filters
    // by status turns that cleanup into a permanent silent no-op while rows accumulate forever.
    it('yields destroyed tombstones from list(), and refuses an undefined currentGen patch (R9)', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.compareAndSwap(SEG, token, { status: 'destroyed' });
      const listed = await drainRecords(d.list());
      expect(listed.map((r) => [r.segment, r.status])).toEqual([['s', 'destroyed']]);

      // `{ currentGen: undefined }` type-checks without `exactOptionalPropertyTypes`, and it used to be a no-op
      // (the merge was `??`). Under presence-based merging it would silently un-publish the segment's Cold data,
      // so it is refused rather than coerced. Omitting the key is how you leave the pointer alone.
      const live = makeDriver();
      const { token: t0 } = await live.create(SEG, { currentGen: 3 });
      await expectValidationReject(
        live.compareAndSwap(SEG, t0, { currentGen: undefined, keyId: 'k1' }),
      );
      expect((await live.get(SEG))!.currentGen).toBe(3); // and the pointer is untouched
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
