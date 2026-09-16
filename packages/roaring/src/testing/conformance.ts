/**
 * Shared driver conformance suite.
 *
 * A backend is only "supported" once it's green here. Every `StorageChunkSource` / `IRegistryDriver`
 * implementation — first-party (in-memory, LocalFs) and community — runs the **same** contract tests via
 * these factories, so substitutability is proven, not assumed. The factories use Vitest globals
 * (`describe`/`it`/`expect`); a driver author wires them into their own test file with a factory that
 * produces a fresh, isolated driver per call.
 *
 * An **in-repo** SDK helper for now: consumed by this repo's tests via the `@/` path alias. Publishing it
 * as a `./testing` package subpath (with `vitest` as a peerDependency) is deferred until the first
 * external or community driver lands (YAGNI). It is never imported by the library entry point, so it
 * stays out of the published runtime bundle either way.
 */
import { describe, expect, it } from 'vitest';
import { SafeBitmap } from '../roaring-codec';
import type {
  ChunkRef,
  StorageChunkSource,
  IRegistryDriver,
  RegistryRecord,
  SegmentRef,
} from '@cloudbitmaps/core';
import { ValidationError, WriteConflictError } from '@cloudbitmaps/core';

// The fixtures deliberately carry a colon. A name may contain one, and the character is only safe because
// each driver maps it onto its physical key correctly — a filesystem driver has to encode it, an object
// store takes it verbatim. Putting it in the SHARED fixture means every driver is held to that, including
// ones written after this line, rather than each being trusted to remember.
/**
 * The segment every conformance seeder must write. Exported so a driver's own test file derives the name
 * instead of restating it — a second copy that drifts makes the suite query a segment nobody seeded, which
 * fails as an empty result rather than as the mismatch it actually is.
 */
export const CONFORMANCE_SEGMENT = 's:v1';

const SEG: SegmentRef = { segment: CONFORMANCE_SEGMENT };
const ref = (chunkKey: number): ChunkRef => ({ segment: 's:v1', chunkKey });

/**
 * Names a conformant driver MUST reject. The list is short on purpose.
 *
 * A name is **any non-empty string** — there is no character allowlist, because each driver escapes what its
 * own physical layer cannot take (`encodeNameForKey` / `encodeNameForPath`). So the only refusals left are the
 * two that no encoding can fix: nothing to name, and a name too large for the key it has to fit inside.
 */
const BAD_NAMES: readonly string[] = [
  '', // nothing to name
  'a'.repeat(257), // over the encoded-length cap
];

/**
 * Names that were ILLEGAL under the old grammar and must now work end to end.
 *
 * This is the more important list. Rejecting these was the bug; accepting them without letting any of them
 * reach a key or a path literally is the fix, so a driver that merely stopped validating would pass the list
 * above and fail here.
 */
const NASTY_NAMES: readonly string[] = [
  'a/b', // would invent hierarchy in an object key
  'a\\b',
  '..', // traversal, if it ever reached a path component
  '../etc/passwd',
  '.hidden',
  '-leading',
  ':leading',
  'a b',
  'a%3Ab', // a name that SPELLS an escape; `%` escaping itself is what keeps this unambiguous
  '100%',
  'ns#1|seg#2', // the characters the key codec keeps reserved
  'con', // a Windows device name — the OLD grammar accepted this one and it broke on Windows
  'a.', // Windows strips a trailing dot, so this must not collide with `a`
  'user@example.com',
  '\u65e5\u672c\u8a9e',
];
async function expectValidationReject(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ValidationError);
}

/**
 * Contract tests for a {@link StorageChunkSource}. `makeSource` MUST build a fresh source seeded with the
 * given chunks (each an immutable Storage bitmap) and nothing else.
 */
export function coldChunkSourceConformance(
  label: string,
  makeSource: (
    chunks: Array<{ chunkKey: number; bitmap: SafeBitmap }>,
  ) => Promise<StorageChunkSource>,
): void {
  describe(`StorageChunkSource conformance: ${label}`, () => {
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

    it('rejects only the two names no encoding can fix', async () => {
      const source = await makeSource([{ chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) }]);
      for (const name of BAD_NAMES) {
        await expectValidationReject(source.getChunk({ segment: name, chunkKey: 0 }));
        await expectValidationReject(
          source.getChunk({ namespace: name, segment: 's', chunkKey: 0 }),
        );
        await expectValidationReject(source.listChunkKeys({ segment: name }));
      }
    });

    it('accepts every name the old grammar refused, without letting one reach a key literally', async () => {
      const source = await makeSource([{ chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) }]);
      for (const name of NASTY_NAMES) {
        // A miss is fine — the point is that it VALIDATES and resolves rather than throwing ValidationError.
        await expect(
          source.getChunk({ segment: name, chunkKey: 0 }).catch((e: unknown) => {
            if (e instanceof ValidationError) throw e;
            return null;
          }),
        ).resolves.not.toThrow();
        await expect(
          Promise.resolve(source.listChunkKeys({ namespace: name, segment: 's' })).catch(
            (e: unknown) => {
              if (e instanceof ValidationError) throw e;
              return null;
            },
          ),
        ).resolves.not.toThrow();
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

    it('create, read back the full record, then CAS with the token', async () => {
      const d = makeDriver();
      expect(await d.get(SEG)).toBeNull();
      const { token: t0 } = await d.create(SEG, {
        currentGen: 3,
        keyId: 'k1',
        retention: { days: 30 },
      });
      const rec = await d.get(SEG);
      expect(rec).not.toBeNull();
      expect(rec!.segment).toBe(SEG.segment);
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

    it('rejects create when the row exists', async () => {
      const d = makeDriver();
      await d.create(SEG, { currentGen: 0 });
      await expect(d.create(SEG, { currentGen: 1 })).rejects.toBeInstanceOf(WriteConflictError);
    });

    it('rejects a stale-token CAS and leaves the record unchanged', async () => {
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

    it('rejects an unknown status and a non-serializable governance blob', async () => {
      const d = makeDriver();
      await expectValidationReject(d.create(SEG, { currentGen: 0, status: 'bogus' as 'active' }));
      await expectValidationReject(
        d.create(SEG, {
          currentGen: 0,
          retention: { big: 1n } as unknown as Record<string, unknown>,
        }),
      );
    });

    it('never reuses a token across delete→recreate (ABA-safe)', async () => {
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
      await d.create({ namespace: 'tenant:acme', segment: 'c:1' }, { currentGen: 0 });
      await d.delete({ segment: 'b' });
      // The UNSCOPED list is the one that matters here: it has to recover a namespace from however the driver
      // stored it, which is where a filesystem driver's encoding has to be undone. Fleet-wide scans — the
      // retention sweep, the consistency check, subject erasure, eject — all ride on this call, so a driver
      // that can write a namespace it cannot enumerate takes every one of them down.
      expect((await drainSegments(d.list())).sort()).toEqual(['a', 'c:1']);
      expect(await drainSegments(d.list('tenant:acme'))).toEqual(['c:1']);
      expect((await drainSegments(d.list(undefined))).sort()).toEqual(['a', 'c:1']);
    });

    it('rejects a negative / non-integer currentGen', async () => {
      const d = makeDriver();
      for (const bad of [-1, 1.5, NaN]) {
        await expectValidationReject(d.create(SEG, { currentGen: bad }));
      }
      const { token } = await d.create(SEG, { currentGen: 0 });
      await expectValidationReject(d.compareAndSwap(SEG, token, { currentGen: -5 }));
    });

    // `currentGen: null` ("this segment exists and has no Storage generation yet") is a first-class stored
    // value, not a missing field. It is what lets a retention policy be recorded ahead of the first load, so every driver must
    // round-trip it through create, CAS, get AND list. Serialization is where this breaks silently: a driver
    // that JSON-drops it, coerces it to 0, or (the subtle one) merges a patch with `patch.currentGen ?? prev`
    // would leave the pointer at the old generation and read stale Storage data no one asked for.
    it('round-trips a null currentGen through create, list, and CAS in both directions', async () => {
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

    // A `destroyed` tombstone is still a record. `list()` must yield it: `runConsistencyCheck` skips
    // tombstones itself, and the retention sweep can only clean up a dead row it can *see* — a driver that filters
    // by status turns that cleanup into a permanent silent no-op while rows accumulate forever.
    it('yields destroyed tombstones from list(), and refuses an undefined currentGen patch', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.compareAndSwap(SEG, token, { status: 'destroyed' });
      const listed = await drainRecords(d.list());
      expect(listed.map((r) => [r.segment, r.status])).toEqual([[SEG.segment, 'destroyed']]);

      // `{ currentGen: undefined }` type-checks without `exactOptionalPropertyTypes`, and it used to be a no-op
      // (the merge was `??`). Under presence-based merging it would silently un-publish the segment's Storage data,
      // so it is refused rather than coerced. Omitting the key is how you leave the pointer alone.
      const live = makeDriver();
      const { token: t0 } = await live.create(SEG, { currentGen: 3 });
      await expectValidationReject(
        live.compareAndSwap(SEG, t0, { currentGen: undefined, keyId: 'k1' }),
      );
      expect((await live.get(SEG))!.currentGen).toBe(3); // and the pointer is untouched
    });

    it('rejects traversal / invalid names on every method', async () => {
      const d = makeDriver();
      for (const name of BAD_NAMES) {
        await expectValidationReject(d.get({ segment: name }));
        await expectValidationReject(d.get({ namespace: name, segment: 's' }));
        await expectValidationReject(d.create({ segment: name }, { currentGen: 0 }));
        await expectValidationReject(d.compareAndSwap({ segment: name }, '1', { currentGen: 0 }));
        await expectValidationReject(d.delete({ segment: name }));
      }
    });

    // Every registry fixture above is `s:v1`-shaped, and `:` happens to encode to itself — so a driver that
    // wrote segment names into its key VERBATIM passed this whole suite. `NASTY_NAMES` is the list that
    // catches that, and until now only the storage-source suite used it. The failure it guards against is
    // quiet: an unencoded `a/b` writes to a key whose parsed form no longer round-trips, so the segment
    // stays readable through `get` while vanishing from `list` — and from every sweep that drives off it.
    it('round-trips names that need encoding, through create, get AND list', async () => {
      for (const segment of NASTY_NAMES) {
        const d = makeDriver();
        await d.create({ segment }, { currentGen: 4 });

        const got = await d.get({ segment });
        expect(got, `get() lost ${JSON.stringify(segment)}`).not.toBeNull();
        expect(got!.segment).toBe(segment);
        expect(got!.currentGen).toBe(4);

        const listed: string[] = [];
        for await (const rec of d.list()) listed.push(rec.segment);
        expect(listed, `list() lost ${JSON.stringify(segment)}`).toContain(segment);
      }
    });

    // The single-cycle ABA case above covers one delete→recreate. This is the repeated case, and it is the
    // one that catches a counter which advances on *some* transitions but not all: such a driver still hands
    // out a fresh token each cycle, so `t0b !== t0` holds every time, while two incarnations several cycles
    // apart quietly collide. Tokens are opaque strings, so the contract is asserted as identity — no token
    // is ever issued twice, and no retired token is ever accepted again — not as a numbering scheme.
    it('never re-issues a token across repeated delete-and-recreate cycles (ABA-safe)', async () => {
      const d = makeDriver();
      const retired: string[] = [];
      for (let cycle = 0; cycle < 4; cycle++) {
        const { token } = await d.create(SEG, { currentGen: cycle });
        retired.push(token);
        await d.delete(SEG);
      }
      expect(new Set(retired).size, 'a token was issued to two different incarnations').toBe(
        retired.length,
      );
      // The live incarnation must refuse every token any previous one ever held.
      const { token: live } = await d.create(SEG, { currentGen: 0 });
      expect(retired).not.toContain(live);
      for (const stale of retired) {
        await expect(
          d.compareAndSwap(SEG, stale, { currentGen: 99 }),
          `a retired token (${stale}) was accepted by the live row`,
        ).rejects.toBeInstanceOf(WriteConflictError);
      }
      expect((await d.get(SEG))!.currentGen).toBe(0); // and none of them moved the pointer
      await d.compareAndSwap(SEG, live, { currentGen: 1 }); // the current token still works
    });

    it('refuses a compare-and-swap against a tombstoned row, and leaves it deleted', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG);
      // A stale token holder must not be able to resurrect a deleted row — that row may have been
      // crypto-shredded or erased, and un-deleting it would undo a compliance action.
      await expect(d.compareAndSwap(SEG, token, { currentGen: 1 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
      expect(await d.get(SEG)).toBeNull();
    });

    // `delete is idempotent` above asserts only that a repeat call does not throw, which a driver that
    // re-tombstones on every call also satisfies. Observable state must be unchanged too.
    it('re-deleting an already-tombstoned row leaves the row observably unchanged', async () => {
      const d = makeDriver();
      const { token: first } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG);
      const listedOnce = [];
      for await (const r of d.list()) listedOnce.push(r);

      await d.delete(SEG);
      await d.delete(SEG);

      expect(await d.get(SEG)).toBeNull();
      const listedThrice = [];
      for await (const r of d.list()) listedThrice.push(r);
      expect(listedThrice).toEqual(listedOnce);
      // Still ABA-safe: the recreate's token is new, and the original stays refused.
      const { token: next } = await d.create(SEG, { currentGen: 0 });
      expect(next).not.toBe(first);
      await expect(d.compareAndSwap(SEG, first, { currentGen: 9 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('list(namespace) excludes a namespace that merely shares its prefix', async () => {
      const d = makeDriver();
      await d.create({ namespace: 'ns', segment: 'a' }, { currentGen: 0 });
      await d.create({ namespace: 'ns2', segment: 'b' }, { currentGen: 0 });
      await d.create({ namespace: 'nsextra', segment: 'c' }, { currentGen: 0 });
      const seen: string[] = [];
      for await (const rec of d.list('ns')) seen.push(rec.segment);
      expect(seen).toEqual(['a']);
    });
  });
}

/**
 * Contract tests for an {@link IRegistryDriver} under **concurrent writers** — `makeDrivers` MUST return two
 * independent driver instances over the **same** backing store, as two processes would see it.
 *
 * This exists because {@link registryConformance} drives one driver sequentially, and `ObjectStoreRegistry`
 * checks the OCC token in memory before it ever issues a conditional write. That in-process check answers
 * every sequential case, so the store-level precondition — the only thing that fences writers *across*
 * processes, and the entire reason these drivers are built on conditional writes — is never load-bearing
 * there. A backend that accepted `If-Match` and ignored it passed the full suite; so did a GCS driver whose
 * writes were not fenced at all. These cases are what make the fence testable.
 */
export function registryConcurrency(
  label: string,
  makeDrivers: () => readonly [IRegistryDriver, IRegistryDriver],
): void {
  describe(`IRegistryDriver concurrency: ${label}`, () => {
    /** Exactly one of two racing writers wins; the loser reports a conflict, not a crash or a silent no-op. */
    const expectOneWinner = (results: PromiseSettledResult<unknown>[]): void => {
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(WriteConflictError);
    };

    it('two concurrent creates of the same segment: exactly one wins', async () => {
      const [a, b] = makeDrivers();
      expectOneWinner(
        await Promise.allSettled([
          a.create(SEG, { currentGen: 0 }),
          b.create(SEG, { currentGen: 0 }),
        ]),
      );
      expect((await a.get(SEG))!.currentGen).toBe(0);
    });

    it('two concurrent swaps from the same token: exactly one wins, and the pointer lands once', async () => {
      const [a, b] = makeDrivers();
      const { token } = await a.create(SEG, { currentGen: 0 });
      expectOneWinner(
        await Promise.allSettled([
          a.compareAndSwap(SEG, token, { currentGen: 1 }),
          b.compareAndSwap(SEG, token, { currentGen: 2 }),
        ]),
      );
      // The loser's write must not have landed on top of the winner's.
      const after = await a.get(SEG);
      expect([1, 2]).toContain(after!.currentGen);
      expect(after!.token).not.toBe(token);
      // And the winner's token is the only one that can swap again.
      await expect(a.compareAndSwap(SEG, token, { currentGen: 9 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('a delete racing a swap leaves exactly one outcome, never both', async () => {
      const [a, b] = makeDrivers();
      const { token } = await a.create(SEG, { currentGen: 0 });
      const [del, cas] = await Promise.allSettled([
        a.delete(SEG),
        b.compareAndSwap(SEG, token, { currentGen: 1 }),
      ]);
      const row = await a.get(SEG);
      if (cas.status === 'fulfilled') {
        // The swap won the fence. The delete then either tombstoned the swapped row (row gone) or lost.
        expect(row === null || row.currentGen === 1).toBe(true);
      } else {
        expect((cas as PromiseRejectedResult).reason).toBeInstanceOf(WriteConflictError);
        expect(del.status).toBe('fulfilled');
        expect(row).toBeNull();
      }
    });

    it('a reader never observes a row as absent while a writer is overwriting it', async () => {
      const [a, b] = makeDrivers();
      let { token } = await a.create(SEG, { currentGen: 0 });
      // Hammer the row while reading it. A store that reads in two round trips (metadata, then bytes pinned
      // to that version) loses its pin on every one of these writes; if it answers that with `null`, a live
      // row disappears — which is what `ObjectVersionRaced` and the bounded re-read exist to prevent.
      for (let i = 1; i <= 12; i++) {
        const [, read] = await Promise.all([
          b.compareAndSwap(SEG, token, { currentGen: i }).then((r) => {
            token = r.token;
          }),
          a.get(SEG),
        ]);
        expect(read, `get() reported an absent row on overwrite ${i}`).not.toBeNull();
      }
    });
  });
}
