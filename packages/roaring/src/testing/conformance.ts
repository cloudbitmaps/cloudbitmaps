/**
 * Shared driver conformance suite.
 *
 * A backend is only "supported" once it's green here. Every `StorageChunkSource` / `IStorageDriver` / `IRegistryDriver`
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
import { createHash } from 'node:crypto';
import type {
  ChunkRef,
  GenKey,
  StorageChunkSource,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
} from '@cloudbitmaps/core';
import { NotFoundError, ValidationError, WriteConflictError } from '@cloudbitmaps/core';

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
 * Names a conformant driver MUST accept: a sample of names that start with something other than a letter or digit
 * or hold a character outside `[A-Za-z0-9._:-]`, plus two plain names that are Windows hazards, a device name and a
 * trailing dot.
 *
 * This is the more important list. A driver that refused characters it could not store, rather than escaping
 * them, would pass the list above and fail here.
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
  'ns#1|seg#2', // outside the key alphabet, so escaped like any other such character
  'con', // a Windows device name — letters only, and it breaks on Windows unless escaped
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
export function storageChunkSourceConformance(
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

    it('accepts a sample of names outside the plain alphabet, and the Windows hazards', async () => {
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

/** The storage-driver cases {@link storageDriverConformance} runs; an emulator that cannot model one skips it by name. */
export type StorageDriverCase =
  | 'write-once round trip'
  | 'collision'
  | 'collision on a large upload'
  | 'missing object'
  | 'out-of-range read'
  | 'tail size'
  | 'idempotent delete'
  | 'delete of an absent key beside its neighbours'
  | 'list read-after-delete';

/** `n` bytes that differ at every offset, so a read from the wrong offset cannot match by accident. */
function patterned(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_v, i) => (i * 31 + 7) % 251);
}

/**
 * The first index at which two byte arrays differ, or -1 when they hold the same bytes. A deep `toEqual` walks a
 * typed array element by element: on 6 MiB it took about 9 s locally and up to 30 s on a CI runner, enough to run the
 * large-object case past its timeout. This loop takes milliseconds, and a failure names the byte.
 */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

async function putBytes(
  d: IStorageDriver,
  key: GenKey,
  bytes: Uint8Array,
): Promise<{ size: number; sha256: string }> {
  return d.putImmutable(key, async (sink) => {
    // Two writes, so a driver that keeps only the last `write` (or the first) fails here. Each from a buffer the caller
    // overwrites once the write resolves, as a caller may: a driver that kept a reference to it stores the overwrite.
    const half = Math.floor(bytes.length / 2);
    for (const part of [bytes.subarray(0, half), bytes.subarray(half)]) {
      const scratch = part.slice();
      await sink.write(scratch);
      scratch.fill(0xa5);
    }
  });
}

async function generationsOf(d: IStorageDriver, ref: SegmentRef): Promise<number[]> {
  const out: number[] = [];
  for await (const k of d.list(ref)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * Contract tests for an {@link IStorageDriver} — the contract its doc comment lists: write-once with
 * `WriteConflictError` on a collision, `NotFoundError` for a missing object, `ValidationError` for an out-of-range
 * read, `getTail`'s true total size, idempotent `delete` (of an absent key too, with neighbours present), and a `list`
 * that is read-after-delete. `makeDriver` MUST
 * return a driver over an empty, isolated keyspace on each call.
 *
 * `skip` names the cases a backend cannot exercise (a local emulator that does not model a contract), so each
 * skip is visible at the call site, with the reason beside it, rather than hidden in a weakened assertion.
 */
export function storageDriverConformance(
  label: string,
  makeDriver: () => IStorageDriver,
  options: {
    readonly skip?: readonly StorageDriverCase[];
    /**
     * Size of the object the `collision on a large upload` case writes. Pass one above the driver's single-request
     * upload threshold to exercise its multipart or resumable path, where the write-once precondition is
     * sent on a different request than a small object's. Omitted, the case does not run.
     */
    readonly largeBytes?: number;
  } = {},
): void {
  const skipped = new Set<StorageDriverCase>(options.skip ?? []);
  const test = (name: StorageDriverCase, fn: () => Promise<void>): void => {
    (skipped.has(name) ? it.skip : it)(name, fn);
  };
  const key = (generation: number): GenKey => ({ segment: CONFORMANCE_SEGMENT, generation });

  describe(`IStorageDriver conformance: ${label}`, () => {
    test('write-once round trip', async () => {
      const d = makeDriver();
      expect(d.capabilities().rangeRead).toBe(true);
      const bytes = patterned(1000);
      const put = await putBytes(d, key(0), bytes);
      expect(put.size).toBe(1000);
      expect(put.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(await d.getRange(key(0), 0, 1000)).toEqual(bytes);
      expect(await d.getRange(key(0), 100, 50)).toEqual(bytes.subarray(100, 150));
      expect(await d.getRange(key(0), 950, 50)).toEqual(bytes.subarray(950)); // exactly to the end
    });

    test('collision', async () => {
      const d = makeDriver();
      const first = patterned(300);
      await putBytes(d, key(0), first);
      await expect(putBytes(d, key(0), patterned(400))).rejects.toBeInstanceOf(WriteConflictError);
      // Write-once means the loser changed nothing: the stored object is still the first.
      expect(await d.getRange(key(0), 0, 300)).toEqual(first);
      expect((await d.getTail(key(0), 10)).size).toBe(300);

      // And under a race: a driver that checks for the object and then writes passes the sequential collision above,
      // and stores both writers' bytes under one number, one of them lost. Exactly one lands, and the object is its.
      const racers = [patterned(500), patterned(501)];
      const settled = await Promise.allSettled(racers.map((b) => putBytes(d, key(1), b)));
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(WriteConflictError);
      const winner = racers[settled.findIndex((r) => r.status === 'fulfilled')]!;
      expect((await d.getTail(key(1), 0)).size).toBe(winner.length);
      expect(await d.getRange(key(1), 0, winner.length)).toEqual(winner);
    });

    if (options.largeBytes !== undefined) {
      const large = options.largeBytes;
      test('collision on a large upload', async () => {
        const d = makeDriver();
        const first = patterned(large);
        await putBytes(d, key(0), first);
        await expect(putBytes(d, key(0), patterned(large + 1))).rejects.toBeInstanceOf(
          WriteConflictError,
        );
        // The loser changed nothing: the stored object is still the first, byte for byte.
        expect((await d.getTail(key(0), 10)).size).toBe(large);
        expect(firstDifference(await d.getRange(key(0), 0, large), first)).toBe(-1);
        expect(await generationsOf(d, SEG)).toEqual([0]);
      });
    }

    test('missing object', async () => {
      const d = makeDriver();
      await expect(d.getRange(key(0), 0, 10)).rejects.toBeInstanceOf(NotFoundError);
      await expect(d.getTail(key(0), 10)).rejects.toBeInstanceOf(NotFoundError);
      // A zero-byte tail is how a load checks that the generation number it is about to take is free.
      await expect(d.getTail(key(0), 0)).rejects.toBeInstanceOf(NotFoundError);
      await putBytes(d, key(1), patterned(100));
      await expect(d.getRange(key(0), 0, 10)).rejects.toBeInstanceOf(NotFoundError); // a neighbour is not it
      await expect(d.getTail(key(0), 0)).rejects.toBeInstanceOf(NotFoundError);
    });

    test('out-of-range read', async () => {
      const d = makeDriver();
      await putBytes(d, key(0), patterned(100));
      // Runs past the end, starts past the end, and malformed ranges: each is refused, never a short read.
      await expect(d.getRange(key(0), 90, 20)).rejects.toBeInstanceOf(ValidationError);
      await expect(d.getRange(key(0), 500, 10)).rejects.toBeInstanceOf(ValidationError);
      await expect(d.getRange(key(0), -1, 10)).rejects.toBeInstanceOf(ValidationError);
      await expect(d.getRange(key(0), 0, -1)).rejects.toBeInstanceOf(ValidationError);
      await expect(d.getRange(key(0), 1.5, 10)).rejects.toBeInstanceOf(ValidationError);
    });

    test('tail size', async () => {
      const d = makeDriver();
      const bytes = patterned(1000);
      await putBytes(d, key(0), bytes);
      // The size is the object's, not the length of the tail returned.
      const small = await d.getTail(key(0), 64);
      expect(small.size).toBe(1000);
      expect(small.bytes).toEqual(bytes.subarray(936));
      const whole = await d.getTail(key(0), 5000);
      expect(whole.size).toBe(1000);
      expect(whole.bytes).toEqual(bytes);
      const none = await d.getTail(key(0), 0);
      expect(none.size).toBe(1000);
      expect(none.bytes.length).toBe(0);
      // An empty object is an object: its tail is empty and its size is 0, not a refused range.
      await putBytes(d, key(1), new Uint8Array(0));
      const empty = await d.getTail(key(1), 10);
      expect(empty.size).toBe(0);
      expect(empty.bytes.length).toBe(0);
    });

    test('idempotent delete', async () => {
      const d = makeDriver();
      await d.delete(key(0)); // absent: a no-op
      await putBytes(d, key(0), patterned(10));
      await d.delete(key(0));
      await d.delete(key(0)); // already gone: a no-op
      await expect(d.getTail(key(0), 10)).rejects.toBeInstanceOf(NotFoundError);
    });

    // Collection deletes a generation by name without knowing whether it is there, so an absent name between two
    // present ones has to be a no-op that touches neither.
    test('delete of an absent key beside its neighbours', async () => {
      const d = makeDriver();
      await putBytes(d, key(1), patterned(10));
      await putBytes(d, key(3), patterned(12));
      await d.delete(key(2));
      await d.delete(key(0));
      await d.delete(key(4));
      expect(await generationsOf(d, SEG)).toEqual([1, 3]);
      expect((await d.getTail(key(1), 10)).size).toBe(10);
      expect((await d.getTail(key(3), 12)).size).toBe(12);
    });

    test('list read-after-delete', async () => {
      const d = makeDriver();
      const other: SegmentRef = { segment: 'other' };
      expect(await generationsOf(d, SEG)).toEqual([]);
      await putBytes(d, key(0), patterned(10));
      await putBytes(d, key(1), patterned(10));
      await putBytes(d, key(2), patterned(10));
      await putBytes(d, { ...other, generation: 0 }, patterned(10));
      // Read-after-put, then read-after-delete, with no wait in between: a listing that lags fails here.
      expect(await generationsOf(d, SEG)).toEqual([0, 1, 2]);
      await d.delete(key(1));
      expect(await generationsOf(d, SEG)).toEqual([0, 2]);
      await d.delete(key(0));
      await d.delete(key(2));
      expect(await generationsOf(d, SEG)).toEqual([]);
      expect(await generationsOf(d, other)).toEqual([0]); // another segment's generation is not this one's
    });

    // A driver whose key leaves out the namespace, folds two names into one spelling, or lists by a bare prefix passes
    // every case above, and then serves one tenant's ids to another and deletes another segment's objects.
    it('keeps every name and namespace apart: its own bytes, its own listing, its own delete', async () => {
      const d = makeDriver();
      const refs: SegmentRef[] = [
        { segment: 's' },
        { namespace: 'n', segment: 's' },
        { namespace: '_default', segment: 's' },
        { segment: 's.1' },
        { segment: 's0' },
        { segment: 's1' },
        { segment: 'a/b' },
        { segment: 'a_b' },
        { segment: 'a:b' },
        { segment: 'a%3Ab' },
        { segment: 'a.' },
        { segment: 'a' },
        { namespace: 'a', segment: 'b/c' },
        { namespace: 'a/b', segment: 'c' },
        ...NASTY_NAMES.map((namespace) => ({ namespace, segment: 'x' })),
      ];
      const sizeOf = (i: number): number => 10 + i;
      for (const [i, ref] of refs.entries()) {
        await putBytes(d, { ...ref, generation: 0 }, patterned(sizeOf(i)));
      }
      for (const [i, ref] of refs.entries()) {
        const gen = { ...ref, generation: 0 };
        expect((await d.getTail(gen, 0)).size, JSON.stringify(ref)).toBe(sizeOf(i));
        expect(await d.getRange(gen, 0, sizeOf(i))).toEqual(patterned(sizeOf(i)));
        expect(await generationsOf(d, ref), JSON.stringify(ref)).toEqual([0]);
      }
      await d.delete({ ...refs[0]!, generation: 0 });
      expect(await generationsOf(d, refs[0]!)).toEqual([]);
      for (const ref of refs.slice(1)) {
        expect(await generationsOf(d, ref), JSON.stringify(ref)).toEqual([0]);
      }
    });

    it('lists and deletes generations by number, not by a prefix of one', async () => {
      const d = makeDriver();
      for (const g of [1, 10, 11]) await putBytes(d, key(g), patterned(g));
      expect(await generationsOf(d, SEG)).toEqual([1, 10, 11]);
      await d.delete(key(1));
      expect(await generationsOf(d, SEG)).toEqual([10, 11]);
      expect((await d.getTail(key(10), 0)).size).toBe(10);
    });

    // A driver that commits what it was given when the writer fails leaves a truncated generation holding a number.
    it('a write whose writer fails stores nothing, and the key can be written after', async () => {
      const d = makeDriver();
      await expect(
        d.putImmutable(key(0), async (sink) => {
          await sink.write(patterned(10));
          throw new Error('the source failed');
        }),
      ).rejects.toThrow('the source failed');
      expect(await generationsOf(d, SEG)).toEqual([]);
      await expect(d.getTail(key(0), 0)).rejects.toBeInstanceOf(NotFoundError);
      await putBytes(d, key(0), patterned(20));
      expect((await d.getTail(key(0), 0)).size).toBe(20);
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

    // ── a caller's `held` row ─────────────────────────────────────────────────────────────────────────────
    // `held` is a hint that may spare a read, never the fence: it must not change what any write answers.
    it('a compare-and-swap with the row it read as `held` lands, as one without it does', async () => {
      const d = makeDriver();
      await d.create(SEG, { currentGen: 0 });
      const held = (await d.get(SEG))!;
      const { token } = await d.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held });
      expect(token).not.toBe(held.token);
      expect(await d.get(SEG)).toMatchObject({ currentGen: 1, token });
      const next = (await d.get(SEG))!;
      await d.compareAndSwap(SEG, next.token, { currentGen: 2 }, { held: next });
      expect((await d.get(SEG))!.currentGen).toBe(2);
    });

    it('a compare-and-swap with a stale `held` row loses as a lost race does, and changes nothing', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0 });
      const held = (await d.get(SEG))!;
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { currentGen: 1 }); // another writer, after the read
      await expect(
        d.compareAndSwap(SEG, held.token, { currentGen: 9 }, { held }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect(await d.get(SEG)).toMatchObject({ currentGen: 1, token: t1 });
      // a row deleted and created again since is no different
      await d.delete(SEG);
      await d.create(SEG, { currentGen: 0 });
      await expect(
        d.compareAndSwap(SEG, held.token, { currentGen: 9 }, { held }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect((await d.get(SEG))!.currentGen).toBe(0);
    });

    it('a `held` row that is a copy, or of another token than `expected`, is read for as without it', async () => {
      const d = makeDriver();
      await d.create(SEG, { currentGen: 0 });
      const first = (await d.get(SEG))!;
      await d.compareAndSwap(SEG, first.token, { currentGen: 1 });
      const current = (await d.get(SEG))!;
      // `expected` names the current row: the older `held` is not the row it fences on, so it is not used
      await d.compareAndSwap(SEG, current.token, { currentGen: 2 }, { held: first });
      // a copy no driver returned
      const copy = structuredClone((await d.get(SEG))!);
      await d.compareAndSwap(SEG, copy.token, { currentGen: 3 }, { held: copy });
      // a `held` that lies about the row cannot change what a write lands on
      const lie: RegistryRecord = { ...(await d.get(SEG))!, currentGen: 99, keyId: 'forged' };
      await d.compareAndSwap(SEG, lie.token, { currentGen: 4 }, { held: lie });
      expect(await d.get(SEG)).toMatchObject({ currentGen: 4 });
      expect((await d.get(SEG))!.keyId).toBeUndefined();
    });

    it('a create with `held: null` makes the row when there is none, and conflicts when there is one', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 }, { held: null });
      expect(await d.get(SEG)).toMatchObject({ currentGen: 0, token });
      await expect(d.create(SEG, { currentGen: 1 }, { held: null })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
      expect(await d.get(SEG)).toMatchObject({ currentGen: 0, token });
      // a row that was deleted is no row, whether the driver removed it or left a tombstone
      await d.delete(SEG);
      const { token: again } = await d.create(SEG, { currentGen: 2 }, { held: null });
      expect(again).not.toBe(token);
      expect(await d.get(SEG)).toMatchObject({ currentGen: 2, token: again });
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

      // `{ currentGen: undefined }` type-checks without `exactOptionalPropertyTypes`. Under presence-based merging
      // it would silently un-publish the segment's Storage data, so it is refused rather than coerced. Omitting the key is how you leave the pointer alone.
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
    // wrote segment names into its key VERBATIM would pass every test above this one. `NASTY_NAMES`, which the
    // storage-source suite also runs, is what catches it. The failure it guards against is
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
    it('with overwhelming probability never re-issues a token across repeated delete-and-recreate cycles (ABA-safe)', async () => {
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

    // ── `delete` with an expected token ──────────────────────────────────────────────────────────────────
    // A delete decided from a row read earlier must not take a row created after that read. The token is the
    // row's identity, so a delete that carries it is refused for any other incarnation.
    it('delete with the current token deletes the row', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG, token);
      expect(await d.get(SEG)).toBeNull();
      expect(await drainSegments(d.list())).toEqual([]);
      const { token: next } = await d.create(SEG, { currentGen: 0 }); // the name is free again, with a fresh token
      expect(next).not.toBe(token);
    });

    it('delete with a stale token throws and leaves the row', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 0 });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { currentGen: 1 });
      await expect(d.delete(SEG, t0)).rejects.toBeInstanceOf(WriteConflictError);
      const row = await d.get(SEG);
      expect(row).toMatchObject({ currentGen: 1, status: 'active', token: t1 });
      await d.compareAndSwap(SEG, t1, { currentGen: 2 }); // still live, and its token still works
    });

    it('delete with a token from before a delete-and-recreate leaves the new row', async () => {
      const d = makeDriver();
      const { token: old } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG, old);
      const { token: fresh } = await d.create(SEG, { currentGen: 5 });
      // The replayed or delayed delete: same name, the token of an incarnation that is gone.
      await expect(d.delete(SEG, old)).rejects.toBeInstanceOf(WriteConflictError);
      expect(await d.get(SEG)).toMatchObject({ currentGen: 5, token: fresh });
    });

    it('delete with a token against an absent or already-deleted row throws', async () => {
      const d = makeDriver();
      await expect(d.delete(SEG, '1')).rejects.toBeInstanceOf(WriteConflictError); // never existed
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.delete(SEG, token);
      await expect(d.delete(SEG, token)).rejects.toBeInstanceOf(WriteConflictError); // tombstoned
      expect(await d.get(SEG)).toBeNull();
    });

    it('delete without a token is unchanged: it takes the row at whatever token it carries', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 0 });
      await d.compareAndSwap(SEG, token, { currentGen: 1 });
      await d.delete(SEG);
      expect(await d.get(SEG)).toBeNull();
      await d.delete(SEG); // and stays idempotent
    });

    // ── `summary`: the row's cached description of its current generation ─────────────────────────────────
    // A driver stores it like any other field. A driver that dropped it would still be correct, only slower, so
    // the reason to hold every driver to it is the other direction: a driver that kept a summary a patch cleared,
    // or lost one a patch did not mention, would describe the wrong generation.
    const clearSummary: RegistrySummary = {
      generation: 3,
      cardinality: 12_000_000,
      metadata: { def: 'v41', landedAt: 1_790_000_000_000 },
    };
    const sealedSummary: RegistrySummary = {
      generation: 4,
      sealed: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIj',
    };

    it('round-trips a summary of either shape through create, get, list and compare-and-swap', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 3, summary: clearSummary });
      expect((await d.get(SEG))!.summary).toEqual(clearSummary);
      expect((await drainRecords(d.list()))[0]!.summary).toEqual(clearSummary);

      // A sealed summary goes with wrapped keys: an encrypted segment's row never carries a clear one.
      const wrappedDeks = [{ keyId: 'active', wrapped: 'YWN0aXZlLXdyYXBwZWQ=' }];
      await d.compareAndSwap(SEG, t0, { currentGen: 4, wrappedDeks, summary: sealedSummary });
      expect((await d.get(SEG))!.summary).toEqual(sealedSummary);
      expect((await drainRecords(d.list()))[0]!.summary).toEqual(sealedSummary);
    });

    // A write must store the summary it was called with. A driver that checks it at the call and serialises the
    // caller's object after awaiting the row would store whatever the caller changed in between: a row every later
    // read refuses, or another write's metadata.
    it('stores the summary as it was when the write was called, whatever the caller changes after', async () => {
      const d = makeDriver();
      const asCalled = { generation: 3, cardinality: 5, metadata: { day: 'mon' } };
      const mine = structuredClone(asCalled);
      const created = d.create(SEG, { currentGen: 3, summary: mine });
      mine.cardinality = -1;
      mine.metadata.day = 'x'.repeat(2000);
      const { token } = await created;
      expect((await d.get(SEG))!.summary).toEqual(asCalled);

      const next = { generation: 4, cardinality: 6, metadata: { day: 'tue' } };
      const theirs = structuredClone(next);
      const swapped = d.compareAndSwap(SEG, token, { currentGen: 4, summary: theirs });
      theirs.generation = 9;
      theirs.metadata.day = 'wed';
      await swapped;
      expect((await d.get(SEG))!.summary).toEqual(next);
      expect((await drainRecords(d.list()))[0]!.summary).toEqual(next);
    });

    it('keeps a summary across a patch that does not mention it, and clears it when told to', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 3, summary: clearSummary });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { retention: { expiresAt: 9 } });
      expect((await d.get(SEG))!.summary).toEqual(clearSummary);
      await d.compareAndSwap(SEG, t1, { status: 'destroyed', summary: undefined });
      const rec = await d.get(SEG);
      expect(rec!.summary).toBeUndefined();
      expect(rec!.retention).toEqual({ expiresAt: 9 });
    });

    it('refuses a malformed summary and leaves the row unchanged', async () => {
      const d = makeDriver();
      const bad = { generation: 3, cardinality: -1 } as RegistrySummary;
      await expectValidationReject(d.create(SEG, { currentGen: 3, summary: bad }));
      expect(await d.get(SEG)).toBeNull();
      const { token } = await d.create(SEG, { currentGen: 3, summary: clearSummary });
      await expectValidationReject(d.compareAndSwap(SEG, token, { summary: bad }));
      expect(await d.get(SEG)).toMatchObject({ token, summary: clearSummary });
    });

    // ── `keptGens`: the generations a load keeps below the pointer ─────────────────────────────────────────
    // A driver that kept the list across a patch that moved the pointer would hold a window that names the wrong
    // generations, and a load would delete by name on the strength of it. One that dropped it is correct and slow.
    it('round-trips the kept generations through create, get, list and compare-and-swap', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 5, keptGens: [2, 4] });
      expect((await d.get(SEG))!.keptGens).toEqual([2, 4]);
      expect((await drainRecords(d.list()))[0]!.keptGens).toEqual([2, 4]);
      await d.compareAndSwap(SEG, t0, { currentGen: 6, keptGens: [4, 5] });
      expect((await d.get(SEG))!.keptGens).toEqual([4, 5]);
      expect((await drainRecords(d.list()))[0]!.keptGens).toEqual([4, 5]);
    });

    it('keeps the kept generations across a patch that leaves the pointer, and drops them when it moves it', async () => {
      const d = makeDriver();
      const { token: t0 } = await d.create(SEG, { currentGen: 5, keptGens: [2, 4] });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { retention: { expiresAt: 9 } });
      expect((await d.get(SEG))!.keptGens).toEqual([2, 4]);
      const { token: t2 } = await d.compareAndSwap(SEG, t1, { currentGen: 6 });
      expect((await d.get(SEG))!.keptGens).toBeUndefined();
      await d.compareAndSwap(SEG, t2, { currentGen: 7, keptGens: [] });
      expect((await d.get(SEG))!.keptGens).toEqual([]);
    });

    it('clears the kept generations when told to', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 5, keptGens: [4] });
      await d.compareAndSwap(SEG, token, { keptGens: undefined });
      expect((await d.get(SEG))!.keptGens).toBeUndefined();
    });

    it('refuses kept generations that are out of order, or not below the pointer, and leaves the row unchanged', async () => {
      const d = makeDriver();
      await expectValidationReject(d.create(SEG, { currentGen: 5, keptGens: [4, 2] }));
      await expectValidationReject(d.create(SEG, { currentGen: 5, keptGens: [2, 5] }));
      expect(await d.get(SEG)).toBeNull();
      const { token } = await d.create(SEG, { currentGen: 5, keptGens: [4] });
      await expectValidationReject(d.compareAndSwap(SEG, token, { keptGens: [4, 5] }));
      await expectValidationReject(d.compareAndSwap(SEG, token, { currentGen: 3, keptGens: [4] }));
      expect(await d.get(SEG)).toMatchObject({ token, keptGens: [4] });
    });

    it('stores the kept generations as they were when the write was called', async () => {
      const d = makeDriver();
      const mine = [1, 2];
      const created = d.create(SEG, { currentGen: 5, keptGens: mine });
      mine.push(99);
      await created;
      expect((await d.get(SEG))!.keptGens).toEqual([1, 2]);
    });

    // ── `leases`: the holds on a segment's generations ───────────────────────────────────────────────────────
    // A lease names a generation a holder pinned and does not follow the pointer: a driver that dropped it when the
    // pointer moved would let the next load collect a leased generation.
    it('round-trips leases through compare-and-swap, get and list, and keeps them across a pointer move', async () => {
      const d = makeDriver();
      const entry = { holder: '00112233aabbccdd', generation: 3, until: 1_900_000_000_000 };
      const { token: t0 } = await d.create(SEG, { currentGen: 5 });
      const { token: t1 } = await d.compareAndSwap(SEG, t0, { leases: [entry] });
      expect((await d.get(SEG))!.leases).toEqual([entry]);
      expect((await drainRecords(d.list()))[0]!.leases).toEqual([entry]);
      const { token: t2 } = await d.compareAndSwap(SEG, t1, { currentGen: 6, keptGens: [5] });
      expect((await d.get(SEG))!.leases).toEqual([entry]);
      const { token: t3 } = await d.compareAndSwap(SEG, t2, { retention: { expiresAt: 9 } });
      expect((await d.get(SEG))!.leases).toEqual([entry]);
      await d.compareAndSwap(SEG, t3, { leases: undefined });
      expect((await d.get(SEG))!.leases).toBeUndefined();
    });

    it('refuses malformed leases and leaves the row unchanged', async () => {
      const d = makeDriver();
      const { token } = await d.create(SEG, { currentGen: 5 });
      const ok = { holder: '00112233aabbccdd', generation: 3, until: 1_900_000_000_000 };
      await expectValidationReject(
        d.compareAndSwap(SEG, token, { leases: [{ ...ok, holder: 'x' }] }),
      );
      await expectValidationReject(d.compareAndSwap(SEG, token, { leases: [ok, ok] }));
      await expectValidationReject(
        d.compareAndSwap(SEG, token, { leases: [{ ...ok, until: -1 }] }),
      );
      expect(await d.get(SEG)).toMatchObject({ token });
      expect((await d.get(SEG))!.leases).toBeUndefined();
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

    // A registry keyed by the segment name alone, keeping the namespace as a column it filters listings on, passes every
    // case above; through a store, one tenant's first load then publishes over another tenant's row.
    it('one segment name in several namespaces is several rows, each written and deleted alone', async () => {
      const d = makeDriver();
      const refs: SegmentRef[] = [
        { segment: 's' },
        { namespace: 'n', segment: 's' },
        { namespace: '_default', segment: 's' },
        { namespace: 'a', segment: 'b/c' },
        { namespace: 'a/b', segment: 'c' },
        ...NASTY_NAMES.map((namespace) => ({ namespace, segment: 's' })),
      ];
      const tokens = new Map<number, string>();
      for (const [i, ref] of refs.entries()) {
        tokens.set(i, (await d.create(ref, { currentGen: i })).token);
      }
      for (const [i, ref] of refs.entries()) {
        const rec = await d.get(ref);
        expect(rec?.currentGen, JSON.stringify(ref)).toBe(i);
        expect(rec?.namespace).toBe(ref.namespace);
        expect(rec?.segment).toBe(ref.segment);
      }
      // A swap of one and a delete of another touch only themselves.
      await d.compareAndSwap(refs[1]!, tokens.get(1)!, { currentGen: 100 });
      await d.delete(refs[2]!);
      for (const [i, ref] of refs.entries()) {
        const want = i === 1 ? 100 : i === 2 ? undefined : i;
        expect((await d.get(ref))?.currentGen, JSON.stringify(ref)).toBe(want);
      }
      const live = refs.filter((_ref, i) => i !== 2);
      for (const namespace of new Set(live.map((ref) => ref.namespace))) {
        if (namespace === undefined) continue;
        const want = live.filter((ref) => ref.namespace === namespace).map((ref) => ref.segment);
        expect((await drainSegments(d.list(namespace))).sort(), namespace).toEqual(want.sort());
      }
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

    it('a delete fenced on a token it read before a swap loses to it: the row survives', async () => {
      const [a, b] = makeDrivers();
      const { token } = await a.create(SEG, { currentGen: 0 });
      await b.compareAndSwap(SEG, token, { currentGen: 1 }); // lands between the delete's read and its write
      await expect(a.delete(SEG, token)).rejects.toBeInstanceOf(WriteConflictError);
      expect((await a.get(SEG))?.currentGen).toBe(1);
    });

    it('two deletes fenced on the same token: exactly one lands', async () => {
      const [a, b] = makeDrivers();
      const { token } = await a.create(SEG, { currentGen: 0 });
      expectOneWinner(await Promise.allSettled([a.delete(SEG, token), b.delete(SEG, token)]));
      expect(await a.get(SEG)).toBeNull();
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

/**
 * What {@link registryDeleteConformance} needs to see past the port: the driver, and the backend behind it.
 *
 * `stored` says whether the backend still holds anything for a row, a tombstone included. Through the port a deleted
 * row and a tombstoned one look the same (`get` answers `null`, `list` skips both); what tells them apart is whether
 * a later full listing still has an object to read, which is the cost a hard delete exists to remove.
 */
export interface RegistryDeleteHarness {
  readonly driver: IRegistryDriver;
  /** Whether the backend holds anything for `ref`: a live row, or the tombstone a delete left in its place. */
  stored(ref: SegmentRef): Promise<boolean>;
  /**
   * Put `text` at `ref`'s row, as another writer left it: here, a row as a release before 0.12 wrote it. Omitted by
   * a registry that persists nothing a test can plant (the in-memory one).
   */
  plantRow?(ref: SegmentRef, text: string): Promise<void>;
}

/** A `destroyed` row exactly as a release before 0.12 serialized one: schema 1, and a bare decimal token. */
function legacyRowText(ref: SegmentRef, token: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    deleted: false,
    record: {
      ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }),
      segment: ref.segment,
      currentGen: 4,
      status: 'destroyed',
      retention: { expiresAt: 1_000_000_000_000, retiredBySweepAt: 1_000_000_000_000 },
      createdAt: 10,
      updatedAt: 20,
      token,
    },
  });
}

/**
 * Contract tests for what `delete` leaves behind, which differs by driver and is declared by
 * `capabilities().conditionalDelete`:
 *
 * - **`true`**: a delete removes a row whose token carries an incarnation id from the backend for good, and does so
 *   only while the row is still the version it read. A row a release before 0.12 wrote has a bare decimal token and
 *   is tombstoned, never removed: a process still on that release, re-creating the name over nothing, would issue
 *   those same counters again from 0.
 * - **`false` or absent**: every delete leaves a tombstone, which a later full listing still reads.
 *
 * Either way `get` answers `null` afterwards, `list` skips the row, and a name created again is a new incarnation that
 * refuses every token an earlier one held.
 */
export function registryDeleteConformance(label: string, make: () => RegistryDeleteHarness): void {
  describe(`IRegistryDriver delete conformance: ${label}`, () => {
    const removes = (h: RegistryDeleteHarness): boolean =>
      h.driver.capabilities().conditionalDelete === true;

    it('says whether a delete removes a row: conditionalDelete is a boolean, or absent', () => {
      const flag = make().driver.capabilities().conditionalDelete;
      expect(flag === undefined || typeof flag === 'boolean').toBe(true);
    });

    it('a delete fenced on the current token removes the row where the registry says so, and tombstones it otherwise', async () => {
      const h = make();
      const { token } = await h.driver.create(SEG, { currentGen: 0, status: 'destroyed' });
      expect(await h.stored(SEG)).toBe(true);
      await h.driver.delete(SEG, token);
      expect(await h.driver.get(SEG)).toBeNull();
      expect(await drainSegments(h.driver.list())).toEqual([]);
      expect(await h.stored(SEG), 'what the backend still holds for the row').toBe(!removes(h));
    });

    it('a delete with no token does the same', async () => {
      const h = make();
      await h.driver.create(SEG, { currentGen: null });
      await h.driver.delete(SEG);
      expect(await h.driver.get(SEG)).toBeNull();
      expect(await h.stored(SEG)).toBe(!removes(h));
      await h.driver.delete(SEG); // and stays idempotent
      expect(await h.stored(SEG)).toBe(!removes(h));
    });

    it('a delete fenced on a stale token removes nothing: the row stays stored and live', async () => {
      const h = make();
      const { token: t0 } = await h.driver.create(SEG, { currentGen: 0 });
      const { token: t1 } = await h.driver.compareAndSwap(SEG, t0, { currentGen: 1 });
      await expect(h.driver.delete(SEG, t0)).rejects.toBeInstanceOf(WriteConflictError);
      expect(await h.stored(SEG)).toBe(true);
      expect(await h.driver.get(SEG)).toMatchObject({ currentGen: 1, token: t1 });
    });

    it('a name deleted and created again is a new incarnation: every earlier token is refused', async () => {
      const h = make();
      const held: string[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const { token: t0 } = await h.driver.create(SEG, { currentGen: null });
        const { token: t1 } = await h.driver.compareAndSwap(SEG, t0, { currentGen: cycle });
        held.push(t0, t1);
        await h.driver.delete(SEG, t1);
      }
      expect(new Set(held).size).toBe(held.length);
      const { token: live } = await h.driver.create(SEG, { currentGen: 0 });
      expect(held).not.toContain(live);
      for (const stale of held) {
        await expect(h.driver.compareAndSwap(SEG, stale, { currentGen: 9 })).rejects.toBeInstanceOf(
          WriteConflictError,
        );
        await expect(h.driver.delete(SEG, stale)).rejects.toBeInstanceOf(WriteConflictError);
      }
      expect(await h.driver.get(SEG)).toMatchObject({ currentGen: 0, token: live });
    });

    it('a row a release before 0.12 wrote is tombstoned, never removed', async (ctx) => {
      const h = make();
      if (h.plantRow === undefined) return ctx.skip();
      for (const ref of [SEG, { namespace: 'tenant:acme', segment: 'legacy' }]) {
        await h.plantRow(ref, legacyRowText(ref, '7'));
        expect(await h.driver.get(ref)).toMatchObject({ token: '7' }); // a control: the planted row reads
        await h.driver.delete(ref, '7');
        expect(await h.driver.get(ref)).toBeNull();
        expect(await h.stored(ref), 'the tombstone stays').toBe(true);
      }
      // The same once this release has written the row: its token gains a write part and still has no incarnation.
      const ref = { segment: 'legacy-written' };
      await h.plantRow(ref, legacyRowText(ref, '7'));
      const { token } = await h.driver.compareAndSwap(ref, '7', { retention: { note: 'x' } });
      await h.driver.delete(ref, token);
      expect(await h.stored(ref)).toBe(true);
    });
  });
}
