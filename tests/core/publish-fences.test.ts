import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { publishGeneration } from '@/core/crbm-cold-source';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, MemoryColdChunkSource, bulkLoadCrbmGeneration } from '@/index';
import type { ChunkRef, IColdDriver, IKeystore, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect, loadedStore, seedSegment } from '../helpers/loaded';

/**
 * The two fences that stand between the write-once protocol and a wrong answer, plus the three guards the suite
 * was found to be carrying without testing.
 *
 * Both fences were added after this change's own adversarial review, and neither was visible to the 1,114 tests
 * that already passed — which is the reason this file exists as its own suite rather than as cases bolted onto
 * the modules' happy paths.
 *
 *  1 · **A publish that DERIVED its content from a generation must land only on that generation.** Forward-only
 *      is right for a load (its ids come from upstream, so it loses nothing by winning), and wrong for the
 *      erasure rewrite (its content is `from` minus one bit, so winning over a newer generation silently
 *      discards whatever that generation added). `publishGeneration`'s `expectFrom` is that distinction.
 *  2 · **A segment's encryption posture is decided once, at its first generation.** A keystore is wired on the
 *      store, so it is in scope for segments deliberately left cleartext; minting a DEK on that basis alone
 *      published generations encrypted under a key that was never stored — unrecoverable, and with no race
 *      required.
 *
 * The guards: `verifyGeneration` on the erasure rewrite, the chunk-key range check on the index-only `count()`
 * path (invariant 5, on the headline read verb), and the throw when a rewrite published but could not collect.
 */

const SEG: SegmentRef = { segment: 's' };
const key32 = (): Uint8Array => randomBytes(32);

async function world(keystore?: IKeystore) {
  const w = await loadedStore({}, { keystore, retry: false });
  const deps = { cold: w.cold, registry: w.registry, codec: roaringCodec, keystore };
  /** A FRESH store: the fixture pins a segment's generation for the store's lifetime. */
  const reader = (): CloudRoaring =>
    new CloudRoaring({ cold: w.cold, registry: w.registry, keystore, retry: false });
  return { ...w, deps, reader };
}

async function generations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const k of cold.list(ref)) gens.push(k.generation);
  return gens.sort((a, b) => a - b);
}

/**
 * Wrap a cold driver so `hook` runs once, right after the first chunk read — by which point the rewrite has the
 * content it derived from in hand, and has NOT yet chosen its own generation number.
 *
 * That is the window the fence is about: a writer publishing here is one `nextGeneration` skips past, so the
 * rewrite ends up numbered *above* it and its forward-only publish would win. Both neighbouring instants are
 * already-safe cases and would test something else: before the chunk read, the interloper's `keep: 0` collection
 * can delete the generation this call is still reading (a `NotFoundError`, and the documented cost of physical
 * deletion on return); after the numbering, the interloper collides on the same number and takes a loud
 * write-once conflict.
 */
function afterFirstChunkRead(base: IColdDriver, hook: () => Promise<void>): IColdDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getTail: (k, m) => base.getTail(k, m),
    delete: (k) => base.delete(k),
    list: (ref) => base.list(ref),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    getRange: async (k, o, l) => {
      const res = await base.getRange(k, o, l);
      if (!fired) {
        fired = true;
        await hook();
      }
      return res;
    },
  };
}

describe('a publish derived from one generation lands only on that generation', () => {
  it('a load that publishes mid-rewrite is not clobbered: the erasure reports superseded', async () => {
    // The finding: `nextGeneration` picks a number above everything in the bucket, so the rewrite's publish used
    // to out-rank the load's and win — and the `keep: 0` collection then deleted the load's object. The load
    // returns a normal result and emits `segment.publish`, so nothing anywhere would have said the set was lost.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);

    const cold = afterFirstChunkRead(w.cold, async () => {
      await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3, 99], {
        registry: w.registry,
      });
    });

    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
    expect(res.collected).toEqual([]); // nothing collected — we did not become current

    // The load stands, whole, and its object is still there.
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3, 99]);
    expect(await generations(w.cold, SEG)).toContain(1);
  });

  it('two erasures racing: the loser reports superseded instead of resurrecting the first id', async () => {
    // The worst output this module can produce is a FALSE Art. 17 receipt. Before the fence, both calls returned
    // `erased: true` with a `segment.rewrite` event, and the second one's generation — derived from gen 0 —
    // put the first one's id back while collecting the generation that had evidenced its removal. The tell was
    // that both receipts named `fromGeneration: 0`.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);

    let inner: Awaited<ReturnType<typeof eraseIdFromSegment>> | undefined;
    const cold = afterFirstChunkRead(w.cold, async () => {
      inner = await eraseIdFromSegment(SEG, 1, w.deps); // a second erasure, start to finish
    });

    const outer = await eraseIdFromSegment(SEG, 2, { ...w.deps, cold });

    expect(inner).toMatchObject({ erased: true, fromGeneration: 0 });
    expect(outer).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
    // Exactly one erasure is attested, and the id it erased is really gone.
    expect(await collect(w.reader().segment('s').iterate())).toEqual([2, 3]);
  });

  it('a publish that lands DURING the verification read is still fenced out', async () => {
    // The pre-check before the verify catches the common interleaving, so this is the case that isolates the
    // fence itself: the pointer moves inside the window between that check and the compare-and-swap.
    //
    // It needs the interloper to publish a generation BELOW the rewrite's own number, or forward-only would have
    // refused it anyway. An orphan object — a load that wrote and crashed before publishing — is exactly that
    // setup: `nextGeneration` skips past it, so the rewrite is numbered 2 while the orphan sits at 1, and a
    // verify-and-publish of that orphan lands underneath us. Un-fenced, our generation 2 out-ranks it, wins, and
    // the `keep: 0` collection then deletes the object we just discarded.
    const w = await world();
    await w.load(SEG, [1, 2, 3]); // gen 0, published
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3, 99]); // no registry ⇒ orphan

    let landed = false;
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      delete: (k) => w.cold.delete(k),
      list: (ref) => w.cold.list(ref),
      // `verifyGeneration` is the only thing that opens a reader on the generation we just wrote.
      getTail: async (k, m) => {
        const res = await w.cold.getTail(k, m);
        if (!landed && k.generation >= 2) {
          landed = true;
          await publishGeneration(w.registry, { ...SEG, generation: 1 });
        }
        return res;
      },
    };

    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
    expect(res.collected).toEqual([]);
    // The orphan's publish stands, whole — including the id it added that our rewrite never knew about.
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3, 99]);
  });

  it('control: with no concurrent writer the rewrite publishes and collects', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1, collected: [0] });
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 3]);
    expect(await generations(w.cold, SEG)).toEqual([1]); // physically gone on return
  });

  it('publishGeneration with expectFrom refuses every pointer that is not exactly it', async () => {
    // The fence in isolation, including the two states that are not a number: no row, and a row that has no
    // generation yet. A publish derived from generation `from` is valid against neither.
    const w = await world();
    expect(await publishGeneration(w.registry, { ...SEG, generation: 1 }, { expectFrom: 0 })).toBe(
      false,
    );

    await w.registry.create(SEG, { currentGen: null });
    expect(await publishGeneration(w.registry, { ...SEG, generation: 1 }, { expectFrom: 0 })).toBe(
      false,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBeNull();

    await w.registry.compareAndSwap(SEG, (await w.registry.get(SEG))!.token, { currentGen: 4 });
    expect(await publishGeneration(w.registry, { ...SEG, generation: 5 }, { expectFrom: 0 })).toBe(
      false,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(4); // the pointer never moved
    // …and it lands when the pointer is where the caller derived from.
    expect(await publishGeneration(w.registry, { ...SEG, generation: 5 }, { expectFrom: 4 })).toBe(
      true,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
  });

  it('a load still publishes forward-only — the fence is opt-in, not the new default', async () => {
    // The counter-test. A load's ids come from upstream, so it must keep winning over a newer generation; if
    // `expectFrom` had been made unconditional this would fail, and re-running a batch job would start throwing.
    const w = await world();
    await w.load(SEG, [1]);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [7, 8], {
      registry: w.registry,
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await collect(w.reader().segment('s').iterate())).toEqual([7, 8]);
  });
});

describe("a segment's encryption posture is decided at its first generation", () => {
  it('a keystore-wired load onto a cleartext segment stays cleartext and stays readable', async () => {
    // The bug two independent reviews reproduced, and it needed no race: the load minted a DEK because the row
    // carried none, encrypted the generation, and the publish's advance branch dropped the wrapping — so the
    // pointer advanced to an object encrypted under a key that existed in no persistent store. The data was
    // unrecoverable the moment the call returned, and the call reported success.
    const keystore = new InProcessKeystore({ keys: { k1: key32() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    }); // cleartext, no keystore

    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3, 4], {
      registry: w.registry,
      keystore, // …and now one is wired
    });

    const rec = (await w.registry.get(SEG))!;
    expect(rec.currentGen).toBe(1);
    expect(rec.wrappedDeks).toBeUndefined(); // the segment is still cleartext, so no key was minted
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3, 4]);
    // Readable WITHOUT the keystore too — the proof that nothing was encrypted under a stranded key.
    const keyless = new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });
    expect(await keyless.segment('s').count()).toBe(4);
  });

  it('requireEncryption refuses that load instead of silently downgrading it', async () => {
    // The other half: a caller who genuinely demands encryption must be told the segment cannot have it, not
    // handed a cleartext generation.
    const keystore = new InProcessKeystore({ keys: { k1: key32() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });

    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: w.registry,
        keystore,
        requireEncryption: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0); // nothing published
  });

  it('publishGeneration refuses new key material on an advance, rather than dropping it', async () => {
    // The fence itself, and the reason it is a throw: the object is already written, so the only two silent
    // outcomes are an unreadable generation (dropping the wrapping) or a row that advertises encryption over
    // cleartext objects — which is what makes `destroySegment` emit `segment.erase`, defined as "unreadable
    // everywhere, backups included", over plaintext that stays readable from any copy.
    const keystore = new InProcessKeystore({ keys: { k1: key32() }, activeKeyId: 'k1' });
    const w = await world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    const minted = await keystore.createDek();

    await expect(
      publishGeneration(w.registry, { ...SEG, generation: 1 }, { wrappedDeks: minted.wrapped }),
    ).rejects.toBeInstanceOf(ValidationError);
    const rec = (await w.registry.get(SEG))!;
    expect(rec.currentGen).toBe(0); // the pointer never moved
    expect(rec.wrappedDeks).toBeUndefined();
  });

  it('an encrypted segment still reuses its own DEK across generations', async () => {
    // The counter-test: the posture rule must not break the case it exists to protect.
    const keystore = new InProcessKeystore({ keys: { k1: key32() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      keystore,
    });
    const first = (await w.registry.get(SEG))!.wrappedDeks;
    expect(first?.length).toBeGreaterThan(0);

    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(first); // same DEK, not a second one
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 3]);
  });

  it('intersectInto on a keystore-wired store leaves a cleartext destination readable', async () => {
    // The second entry point the review found: `materialize` passes the store's keystore unconditionally, so a
    // `*Into` onto a destination that already had a cleartext generation destroyed it and returned a success.
    const keystore = new InProcessKeystore({ keys: { k1: key32() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.load('a', [1, 2, 3]);
    await w.load('b', [2, 3, 4]);
    // Loaded WITHOUT the keystore, unlike the fixture's own `load`: this destination is cleartext, which is the
    // whole premise. (`a` and `b` are encrypted, and the store reads them with its keystore.)
    await bulkLoadCrbmGeneration(w.cold, { segment: 'dest', generation: 0 }, [99], {
      registry: w.registry,
    });

    const store = w.reader();
    const res = await store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')]);
    expect(res.cardinality).toBe(2);
    expect((await w.registry.get({ segment: 'dest' }))!.wrappedDeks).toBeUndefined();
    expect(await collect(w.reader().segment('dest').iterate())).toEqual([2, 3]);
  });
});

describe('a materialisation reports whether it actually landed', () => {
  it('throws instead of naming a generation that never became current', async () => {
    // `MaterializeResult.generation` is documented as "the destination's new current generation". A `*Into` is
    // not derived from `dest`'s content, so forward-only is the right publish rule for it — but the REPORTING
    // was wrong: `bulkLoadCrbmGeneration` used its publish outcome only to gate the audit event and did not
    // return it, so a materialisation whose publish lost the race resolved successfully, naming an orphan.
    // The destination held the other writer's content and the caller was told otherwise.
    const w = await world();
    await w.load('a', [1, 2, 3]);
    await w.load('b', [2, 3, 4]);
    await w.load('dest', [99]); // dest has gen 0, so ours will be numbered 1

    // A writer that publishes generation 2 of `dest` while our object is being written.
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      getTail: (k, m) => w.cold.getTail(k, m),
      delete: (k) => w.cold.delete(k),
      list: (ref) => w.cold.list(ref),
      putImmutable: async (k, fn) => {
        const res = await w.cold.putImmutable(k, fn);
        if (k.segment === 'dest' && k.generation === 1) {
          await bulkLoadCrbmGeneration(w.cold, { segment: 'dest', generation: 2 }, [7, 8], {
            registry: w.registry,
          });
        }
        return res;
      },
    };
    const store = new CloudRoaring({ cold, registry: w.registry, retry: false });

    await expect(
      store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')]),
    ).rejects.toBeInstanceOf(WriteConflictError);

    // The winner's content is what `dest` holds, and our object is the orphan.
    expect((await w.registry.get({ segment: 'dest' }))!.currentGen).toBe(2);
    expect(await collect(w.reader().segment('dest').iterate())).toEqual([7, 8]);
  });

  it('emits segment.publish for the generation it published, like the load it is', async () => {
    // A `*Into` is a load in disguise, and it was the one write path that could make a generation current and
    // leave nothing in the compliance trail: `materialize` never threaded an audit sink and the verbs exposed
    // no way to pass one. `docs/guide/dashboards.md` reads `segment.publish` as "a loaded generation became
    // current", which this is.
    const w = await world();
    await w.load('a', [1, 2, 3]);
    await w.load('b', [2, 3, 4]);
    const events: Array<{ kind: string; segment?: string; generation?: number }> = [];
    const audit = {
      onEvent: (e: { kind: string; segment?: string; generation?: number }) => void events.push(e),
    };

    const store = w.reader();
    await store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')], { audit });

    expect(events).toEqual([{ kind: 'segment.publish', segment: 'dest', generation: 0 }]);
  });

  it('a streaming combine writes nothing, so it emits nothing', async () => {
    // The counter-test: `audit` sits on the shared options type, and the read verbs must ignore it rather than
    // attesting to a publish that did not happen.
    const w = await world();
    await w.load('a', [1, 2, 3]);
    await w.load('b', [2, 3, 4]);
    const events: unknown[] = [];
    const audit = { onEvent: (e: unknown) => void events.push(e) };

    const store = w.reader();
    expect(await collect(store.segment('a').intersect([store.segment('b')], { audit }))).toEqual([
      2, 3,
    ]);
    expect(events).toEqual([]);
  });

  it('control: an uncontended materialisation reports the generation it published', async () => {
    const w = await world();
    await w.load('a', [1, 2, 3]);
    await w.load('b', [2, 3, 4]);
    await w.load('dest', [99]);

    const store = w.reader();
    const res = await store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')]);
    expect(res).toMatchObject({ generation: 1, cardinality: 2 });
    expect((await w.registry.get({ segment: 'dest' }))!.currentGen).toBe(1);
    expect(await collect(w.reader().segment('dest').iterate())).toEqual([2, 3]);
  });

  it('a load reports the same fact, rather than leaving the caller to infer it', async () => {
    // The flag on the result, in isolation: a load whose publish no-ops because a newer generation is already
    // current wrote a durable object that no reader will ever resolve.
    const w = await world();
    await w.load(SEG, [1]); // gen 0
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [5], { registry: w.registry });
    const late = await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2], {
      registry: w.registry,
    });
    expect(late.becameCurrent).toBe(false);
    expect(late.cardinality).toBe(2); // the write itself succeeded…
    expect((await w.registry.get(SEG))!.currentGen).toBe(5); // …and changed nothing

    // With no registry there is no pointer, so there is nothing to report.
    const noReg = await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 9 }, [9]);
    expect(noReg.becameCurrent).toBeUndefined();
  });
});

describe('the guards the suite was carrying untested', () => {
  it('the erasure rewrite verifies what it wrote before publishing (IntegrityError, pointer unmoved)', async () => {
    // Deleting the `verifyGeneration` call left all 1,114 tests passing. It is the integrity gate on the one path
    // that rewrites a whole segment for a GDPR erasure: without it, a rewrite that silently dropped a chunk would
    // be published as the erasure's authoritative generation, and `keep: 0` would then collect the generation
    // that held the true data.
    const w = await world();
    await w.load(SEG, [1, 2, 70_000, 140_000]); // three chunks, so a dropped one is detectable
    // Truncate the re-read: the freshly written object reports a short chunk-key set on verification.
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      delete: (k) => w.cold.delete(k),
      list: (ref) => w.cold.list(ref),
      // The index lives in the tail, so corrupting the tail read of the NEW generation is what a dropped chunk
      // would look like to the verifier.
      getTail: async (k, m) =>
        k.generation === 1 ? w.cold.getTail({ ...k, generation: 0 }, m) : w.cold.getTail(k, m),
    };

    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, cold })).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(0); // never published
    expect(await generations(w.cold, SEG)).toContain(0); // and the real data survives
    expect(await collect(w.reader().segment('s').iterate())).toEqual([1, 2, 70_000, 140_000]);
  });

  it('count() range-checks a chunk key that came from the index, not just from a chunk list', async () => {
    // Invariant 5 ("range-check every chunk key that comes back from storage") is enforced in exactly two
    // places, and the index-only `count()` path — the headline read verb on a loaded segment — had no coverage:
    // the existing out-of-range test uses a source with no `cardinalities`, so it exercises the other one.
    const cold = new MemoryColdChunkSource();
    seedSegment(cold, 's', [1, 2, 3]);
    const hostile: MemoryColdChunkSource = Object.create(cold) as MemoryColdChunkSource;
    Object.assign(hostile, {
      getChunk: (ref: ChunkRef) => cold.getChunk(ref),
      listChunkKeys: (ref: SegmentRef) => cold.listChunkKeys(ref),
      cardinalities: () => Promise.resolve(new Map([[70_000, 3]])), // > 0xffff
    });

    const store = new CloudRoaring({ cold: hostile, retry: false });
    await expect(store.segment('s').count()).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a rewrite that published but could not collect throws rather than attesting the erasure', async () => {
    // `EraseIdResult.collected`'s contract: "a rewrite that published but could not collect throws instead of
    // reporting `erased: true` over bytes that are still there". Nothing exercised it, and it is the branch that
    // decides whether an Art. 17 ledger over-attests.
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      getTail: (k, m) => w.cold.getTail(k, m),
      list: (ref) => w.cold.list(ref),
      delete: () => Promise.reject(new Error('object lock')),
    };

    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, cold })).rejects.toThrow(/object lock/);
    // The publish DID land — that is why this must throw rather than report success: the bit is out of the
    // current generation but the object that held it is still in the bucket.
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await generations(w.cold, SEG)).toEqual([0, 1]);
  });
});
