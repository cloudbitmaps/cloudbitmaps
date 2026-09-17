import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { KeyUnavailableError, ValidationError, WriteConflictError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, RecordingAuditSink, bulkLoadCrbmGeneration } from '@/index';
import type { GenKey, IStorageDriver, IKeystore, SegmentRef } from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `eraseIdFromSegment` — subject erasure on a loaded segment, one id at a time.
 *
 * There is no per-id delete on an immutable object, so erasure is what every other write is: a **new
 * generation**, streamed from the current one with a single bit cleared, published forward-only, and the
 * generation that held the bit collected before the call returns. These tests pin the two halves of that
 * contract — what the rewrite *writes* (every other chunk carried through byte-for-byte, an emptied chunk
 * dropped, keys ascending) and what it *reports* (the `reason` for each way nothing gets rewritten).
 *
 * The codec is passed explicitly: this is the core module, which is codec-agnostic; the facade binds `roaringCodec`
 * for applications.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const k = (): Uint8Array => randomBytes(32);

async function world(keystore?: IKeystore) {
  const w = await loadedStore(
    {},
    {
      retry: false,
      encryption: { keystore },
    },
  );
  const deps = { storage: w.storage, registry: w.registry, codec: roaringCodec, keystore };
  /** A FRESH store: the fixture pins a segment's generation for the store's lifetime (no clock ⇒ TTL 0). */
  const reader = (): CloudRoaring =>
    new CloudRoaring({
      storage: { storage: w.storage, registry: w.registry },
      retry: false,
      encryption: { keystore },
    });
  /** A fresh store with NO keystore — what an encrypted segment must be unreadable through. */
  const keylessReader = (): CloudRoaring =>
    new CloudRoaring({ storage: { storage: w.storage, registry: w.registry }, retry: false });
  return { ...w, deps, reader, keylessReader };
}

async function generations(storage: IStorageDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of storage.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/** Every chunk of one generation, keyed by chunk key, as the raw bytes stored in the `.crbm`. */
async function chunksOf(storage: IStorageDriver, key: GenKey): Promise<Map<number, Uint8Array>> {
  const reader = await openGenerationReader(storage, key, undefined);
  const out = new Map<number, Uint8Array>();
  for (const chunkKey of reader.chunkKeys()) out.set(chunkKey, (await reader.getChunk(chunkKey))!);
  return out;
}

const decode = (bytes: Uint8Array): number[] =>
  SafeBitmap.safeDeserialize(bytes, 1 << 20).toArray();

describe('eraseIdFromSegment — the reasons nothing is rewritten', () => {
  it("'absent': no registry row", async () => {
    const w = await world();
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'absent',
      collected: [],
    });
  });

  it("'destroyed': a crypto-shred tombstone is already unreadable", async () => {
    const w = await world();
    await w.registry.create(SEG, { currentGen: 0, status: 'destroyed' });
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'destroyed',
      collected: [],
    });
  });

  it("'no-generation': a row minted by setRetention before the first load holds no id", async () => {
    const w = await world();
    await w.registry.create(SEG, { currentGen: null });
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
  });

  it("'not-member' when the id's chunk is absent from the generation", async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]); // chunk 0 only
    const res = await eraseIdFromSegment(SEG, 70_000, w.deps); // chunk 1
    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [],
    });
  });

  it("'not-member' when the chunk is present but the bit is not", async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, 5, w.deps);
    expect(res).toMatchObject({ erased: false, reason: 'not-member', fromGeneration: 0 });
  });

  it('none of these write an object, move the pointer, or emit an audit event', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const audit = new RecordingAuditSink();
    await eraseIdFromSegment(SEG, 5, w.deps, { audit });
    await eraseIdFromSegment(SEG, 70_000, w.deps, { audit });
    await eraseIdFromSegment({ namespace: 'ns', segment: 'nope' }, 1, w.deps, { audit });
    expect(await generations(w.storage, SEG)).toEqual([0]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(audit.snapshot()).toEqual([]);
  });
});

describe('eraseIdFromSegment — the rewrite', () => {
  it('writes the current generation without the id, publishes it, and collects the old one', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3, 70_000, 200_000]); // chunks 0, 1 and 3
    const before = await chunksOf(w.storage, { ...SEG, generation: 0 });

    const res = await eraseIdFromSegment(SEG, 2, w.deps);

    expect(res).toEqual({
      segment: 's',
      namespace: 'ns',
      erased: true,
      fromGeneration: 0,
      generation: 1,
      collected: [0],
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    // The physical half: the generation that held the bit is gone from the bucket when the call returns.
    expect(await generations(w.storage, SEG)).toEqual([1]);

    const after = await chunksOf(w.storage, { ...SEG, generation: 1 });
    expect([...after.keys()]).toEqual([...before.keys()]); // same chunk set — no chunk was emptied
    expect(decode(after.get(0)!)).toEqual([1, 3]); // the one chunk that changed
    // Every other chunk is carried through byte-for-byte: the rewrite re-encodes, but the same set encodes the
    // same way, so an untouched chunk's bytes are identical to what the load wrote.
    expect(after.get(1)).toEqual(before.get(1));
    expect(after.get(3)).toEqual(before.get(3));
  });

  it('drops a chunk the removal emptied — the new chunk set is the old minus that chunk', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 70_000]); // 70_000 is alone in chunk 1
    const before = await chunksOf(w.storage, { ...SEG, generation: 0 });
    expect([...before.keys()]).toEqual([0, 1]);

    const res = await eraseIdFromSegment(SEG, 70_000, w.deps);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });

    const after = await chunksOf(w.storage, { ...SEG, generation: 1 });
    expect([...after.keys()]).toEqual([0]); // empty chunks are never stored
    expect(after.get(0)).toEqual(before.get(0));
  });

  it('keeps chunk keys ascending regardless of where the erased id sat', async () => {
    const w = await world();
    const ids = [5, 70_000, 200_000, 300_000, 460_000]; // chunks 0, 1, 3, 4, 7
    await w.load(SEG, ids);
    await eraseIdFromSegment(SEG, 200_000, w.deps); // empties chunk 3
    const reader = await openGenerationReader(w.storage, { ...SEG, generation: 1 }, undefined);
    const keys = [...reader.chunkKeys()];
    expect(keys).toEqual([0, 1, 4, 7]);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('emits one segment.rewrite at the publish — and NOT a segment.publish', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const audit = new RecordingAuditSink();
    await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.rewrite', namespace: 'ns', segment: 's', fromGeneration: 0, generation: 1 },
    ]);
  });

  it('takes the generation after any staged, unpublished object — and collects that orphan too', async () => {
    // A load that wrote its object and crashed before publishing leaves gen 5 above `currentGen` 0. A rewrite
    // that consulted only the pointer would pick gen 1 forever and never conflict; `nextGeneration` skips past
    // the orphan, and the `keep: 0` collection then takes every generation below the new pointer.
    const w = await world();
    await w.load(SEG, [1, 2]);
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 5 }, [9]); // no registry ⇒ never published

    const res = await eraseIdFromSegment(SEG, 1, w.deps);

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 6 });
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 5]);
    expect(await generations(w.storage, SEG)).toEqual([6]);
    expect(await collect(w.reader().segment('s', { namespace: 'ns' }).iterate())).toEqual([2]);
  });

  it('is what a fresh reader sees: has() false, count decremented, the rest intact', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3, 70_000]);
    await eraseIdFromSegment(SEG, 70_000, w.deps);
    const seg = w.reader().segment('s', { namespace: 'ns' });
    expect(await seg.has(70_000)).toBe(false);
    expect(await seg.has(1)).toBe(true);
    expect(await seg.count()).toBe(3);
    expect(await collect(seg.iterate())).toEqual([1, 2, 3]);
  });

  it('is idempotent — a second call finds no member and writes nothing', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    await eraseIdFromSegment(SEG, 2, w.deps);
    const again = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(again).toMatchObject({ erased: false, reason: 'not-member', fromGeneration: 1 });
    expect(await generations(w.storage, SEG)).toEqual([1]);
  });
});

describe('eraseIdFromSegment — encryption', () => {
  it('reuses the segment DEK: the rewrite reads with the keystore and is unreadable without it', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.load(SEG, [1, 2, 3]);
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;

    const res = await eraseIdFromSegment(SEG, 2, w.deps);

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore); // same DEK, not re-minted
    expect(await collect(w.reader().segment('s', { namespace: 'ns' }).iterate())).toEqual([1, 3]);
    await expect(
      collect(w.keylessReader().segment('s', { namespace: 'ns' }).iterate()),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('refuses to rewrite an encrypted segment without a keystore — a lost key, not a cleartext segment', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.load(SEG, [1, 2, 3]);
    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, keystore: undefined }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(await generations(w.storage, SEG)).toEqual([0]); // nothing written
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('requireEncryption refuses a cleartext segment', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, requireEncryption: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generations(w.storage, SEG)).toEqual([0]);
  });
});

describe('eraseIdFromSegment — validation', () => {
  it('rejects a non-u32 id and a bad segment ref before touching storage', async () => {
    const w = await world();
    await expect(eraseIdFromSegment(SEG, -1, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(eraseIdFromSegment(SEG, 2 ** 32, w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(eraseIdFromSegment({ segment: '' }, 1, w.deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('eraseIdFromSegment — a collect that could not run is never a clean receipt', () => {
  it('throws rather than reporting erased: true over generations still holding the id', async () => {
    // `erased: true` means the bit is physically gone on return, and `collected` is the evidence for the
    // physical half of an Art. 17 erasure. So the one thing this call must never do is report a clean receipt
    // over bytes that are still there.
    //
    // The window is narrow but entirely in-repo: a retirement tombstones the row between the rewrite's publish
    // and its collect — so the collect takes the destroyed branch — and the sweep's own retirement stamp writes
    // that still-destroyed row again while the collect is listing. The collect then cannot prove the segment is
    // the same incarnation it read, and must refuse. Refusing is only safe if it is DISTINGUISHABLE from
    // "there was nothing to collect", which an empty array is not — hence a throw.
    const w = await world();
    await w.load(SEG, [1, 42]);
    await w.load(SEG, [1, 42]);

    const registry = w.registry;
    const tombstoneOnPublish = new Proxy(registry, {
      get(target, prop, rx) {
        if (prop !== 'compareAndSwap') return Reflect.get(target, prop, rx) as unknown;
        return async (ref: SegmentRef, token: unknown, patch: Record<string, unknown>) => {
          const out = await (
            target.compareAndSwap as never as (...a: unknown[]) => Promise<unknown>
          )(ref, token, patch);
          if (patch.currentGen === 2) {
            const row = (await target.get(ref))!;
            await target.compareAndSwap(ref, row.token, { status: 'destroyed' });
          }
          return out;
        };
      },
    });

    const bumpDuringList = new Proxy(w.storage, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef): AsyncIterable<GenKey> {
          let fired = false;
          for await (const key of w.storage.list(ref)) {
            yield key;
            if (!fired) {
              fired = true;
              const row = await registry.get(ref);
              if (row?.status === 'destroyed') {
                await registry.compareAndSwap(ref, row.token, { status: 'destroyed' });
              }
            }
          }
        };
      },
    });

    await expect(
      eraseIdFromSegment(SEG, 42, {
        ...w.deps,
        storage: bumpDuringList as typeof w.storage,
        registry: tombstoneOnPublish as typeof registry,
      }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    // The proof the throw was warranted: the generations that hold the id are all still in the bucket.
    expect(await generations(w.storage, SEG)).toEqual([0, 1, 2]);
  });
});

describe('eraseIdFromSegment — the receipt check asserts the outcome, not who caused it', () => {
  it('does NOT throw when a concurrent collector took the holder generation first', async () => {
    // The receipt claim is "the generation holding the id is gone from the bucket". A holder missing from
    // `collected` does not contradict that — someone else may simply have got there first, and the most
    // ordinary someone is `gcOrphanGenerations(ref, deps, { keep: 0 })`, the call this library tells operators
    // to run. Checking `collected.includes(holder)` alone turns a SUCCESSFUL erasure into a WriteConflictError,
    // and the re-run then reports `not-member`, so no run ever produces the receipt.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);

    let fired = false;
    const raced = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'list') return Reflect.get(t, p, rx) as unknown;
        return async function* (ref: SegmentRef): AsyncIterable<GenKey> {
          if (!fired && (await w.registry.get(SEG))?.currentGen === 1) {
            fired = true;
            await gcOrphanGenerations(
              SEG,
              { storage: w.storage, registry: w.registry },
              { keep: 0 },
            );
          }
          yield* w.storage.list(ref);
        };
      },
    }) as typeof w.storage;

    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, storage: raced });
    expect(res.erased).toBe(true);
    expect(fired).toBe(true); // the race really happened
    expect(await generations(w.storage, SEG)).toEqual([1]); // and the holder really is gone
  });

  it('DOES throw when the holder generation is still in the bucket', async () => {
    // The other direction: a collect that declined leaves the holder in place, and that must never be
    // reported as `erased: true`. Without this the empty-list decline is indistinguishable from success.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);

    let armed = false;
    const flaky = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'get') return Reflect.get(t, p, rx) as unknown;
        return async (r: SegmentRef) => {
          const row = await t.get(r);
          if (armed && row !== null && row.currentGen === 1) {
            armed = false;
            return null; // the collect finds no authoritative row and declines with an empty list
          }
          return row;
        };
      },
    });
    armed = true;
    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, registry: flaky as typeof w.registry }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await generations(w.storage, SEG)).toContain(0); // the holder survived — hence the throw
  });
});

describe('eraseIdFromSegment — what a re-run after a failed collect actually reports', () => {
  // This matrix is documented in four places an operator is pointed at: this module's `collected` doc, the
  // ledger entry note, the API reference and both privacy documents. It has been written down wrongly twice —
  // once describing behaviour from before the superseded-generation search existed, once generalising the
  // Storage-`delete`-fault outcome to a cause that does not share it. Prose cannot be trusted here, so the matrix
  // is asserted: if one of these outcomes changes, the sentence that describes it has to change with it.

  it('a Storage delete fault: the re-run erases and gives the receipt the failed call could not', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    let broken = true;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'delete') return Reflect.get(t, p, rx) as unknown;
        return async (key: GenKey) => {
          if (broken) throw new Error('storage delete fault');
          return w.storage.delete(key);
        };
      },
    }) as typeof w.storage;

    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, storage: flaky })).rejects.toThrow();
    broken = false;
    const rerun = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(rerun.erased).toBe(true);
    expect(rerun.fromGeneration).toBe(0); // found in the SUPERSEDED generation, not the current one
    expect(rerun.collected).toContain(0);
  });

  it('a racing collector got there first: not-member, and NO run holds a receipt', async () => {
    // Driven, not hand-built: the first call really fails its collect, a real concurrent collector really takes
    // the holder, and only then do we look at what a re-run says. Constructing the end state directly would
    // pass even if `eraseIdFromSegment` stopped searching superseded generations altogether.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);

    let broken = true;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'delete') return Reflect.get(t, p, rx) as unknown;
        return async (key: GenKey) => {
          if (broken) throw new Error('storage delete fault');
          return w.storage.delete(key);
        };
      },
    }) as typeof w.storage;

    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, storage: flaky })).rejects.toThrow();
    broken = false;
    // The racing collector is the very call the guide tells operators to run.
    await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { keep: 0 });

    const rerun = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(rerun.erased).toBe(false);
    expect(rerun.reason).toBe('not-member'); // the bit is gone, and no run says so
    expect(await generations(w.storage, SEG)).toEqual([1]);
  });

  it('the registry row is gone: the fleet scan does not even reach the segment', async () => {
    // The sharp edge behind "an empty ledger is not by itself proof the id is gone". Driven through the facade,
    // because the point is what the FLEET-WIDE scan does: with no row there is no segment to enumerate, so the
    // objects outlive it as orphans and only `checkConsistency` finds them.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    await w.registry.delete(SEG);

    const ledger = await w.reader().eraseSubject(2, { namespace: SEG.namespace });
    expect(ledger.erasedFrom).toEqual([]);
    expect(ledger.scannedSegments).toBe(0); // not scanned at all — not "scanned and found clean"
    expect(await generations(w.storage, SEG)).toEqual([0]); // and the id is STILL in the bucket
  });

  it('an ex-member erasure emits NO audit event and carries no generation', async () => {
    // The receipt for this path is the ledger entry alone. Nothing is rewritten and nothing is published — the
    // generation holding the id is simply collected — so a control reconciling "one `segment.rewrite` per
    // ledger entry" would flag a correct erasure. Four documents say so; this is what holds them to it.
    const w = await world();
    await w.load(SEG, [1, 2, 3]); // gen 0 holds the id
    await w.load(SEG, [1, 3]); // gen 1 — a re-seed that dropped it; `keep: 1` retains gen 0
    await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { keep: 1 });

    const audit = new RecordingAuditSink();
    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(res.erased).toBe(true);
    expect(res.fromGeneration).toBe(0); // the superseded generation it was found in
    expect(res.generation).toBeUndefined(); // nothing was written
    expect(audit.snapshot()).toHaveLength(0);
  });
});
