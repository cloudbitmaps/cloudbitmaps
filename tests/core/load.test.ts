import { randomBytes } from 'node:crypto';
import { expectTypeOf } from 'vitest';
import type { GuardRefusal, LoadJudgement, LoadRefusal } from '@cloudbitmaps/core';
import { loadSegment } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { FOOTER_BYTES } from '@/core/crbm/format';
import { ValidationError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import { RecordingAuditSink } from '@/index';
import type { GenKey, IStorageDriver, SegmentRef, StorageDeleteOptions } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { incarnationOf } from '@/core/token';

/**
 * `loadSegment` — replace a segment's contents with one immutable generation.
 *
 * The composition is not the interesting part; the **guard** is. A load replaces, so an upstream query that
 * returns fewer rows than usual is a shrink nobody asked for and an empty one is a wipe — and at the storage
 * layer both are an ordinary successful write. These tests pin where the guard runs (between the write and the
 * publish, the only moment where the new content is known and the old one is still authoritative), that a
 * refusal leaves nothing behind, and that a refusal is reported rather than thrown.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}

async function generations(storage: IStorageDriver, ref: SegmentRef = SEG): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(ref)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function idsOf(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push((chunkKey << 16) + r);
    }
  }
  return out.sort((a, b) => a - b);
}

describe('loadSegment — the write path as one call', () => {
  it('writes a generation, publishes it, and collects what it superseded', async () => {
    const w = world();
    const first = await loadSegment(SEG, [1, 2, 3], w.deps);
    expect(first).toMatchObject({ generation: 0, published: true, cardinality: 3 });
    expect(first.collected).toEqual([]);

    const second = await loadSegment(SEG, [4, 5], w.deps, { keep: 0 });
    expect(second).toMatchObject({ generation: 1, published: true, cardinality: 2 });
    // `keep: 0` — the superseded generation goes in the same call. Composed by hand this is the step that gets
    // left out, and the segment quietly keeps paying for every generation it ever had.
    expect(second.collected).toEqual([0]);
    expect(await generations(w.storage)).toEqual([1]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('REPLACES rather than merges — the new generation is exactly what was streamed', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    await loadSegment(SEG, [9], w.deps);
    expect(await idsOf(w.storage, 1)).toEqual([9]);
  });

  it('keeps the grace window by default', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await loadSegment(SEG, [2], w.deps);
    const third = await loadSegment(SEG, [3], w.deps);
    // default keep: 1 — generation 1 survives as the window, generation 0 goes.
    expect(third.collected).toEqual([0]);
    expect(await generations(w.storage)).toEqual([1, 2]);
  });
});

describe('loadSegment — the guard, and what a refusal leaves behind', () => {
  it('refuses an empty load over a non-empty segment, and deletes the object it wrote', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);

    const r = await loadSegment(SEG, [], w.deps);
    expect(r.published).toBe(false);
    expect(r.reason).toBe('empty');
    // The object it wrote is gone. It sat ABOVE currentGen, where collection never looks, so if the refusal did
    // not delete it nothing ever would — a leak that grows by one object per refused load, forever.
    expect(await generations(w.storage)).toEqual([0]);
    // And the segment still holds what it held.
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.storage, 0)).toEqual([1, 2, 3]);
  });

  it('allows an empty FIRST load — there is nothing to wipe', async () => {
    const w = world();
    const r = await loadSegment(SEG, [], w.deps);
    expect(r.published).toBe(true);
    expect(r.cardinality).toBe(0);
  });

  it('allowEmpty publishes the empty generation', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const r = await loadSegment(SEG, [], w.deps, { allowEmpty: true });
    expect(r.published).toBe(true);
    expect(await idsOf(w.storage, 1)).toEqual([]);
  });

  it('minCardinality refuses a load that is too small to be plausible', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps);
    const r = await loadSegment(SEG, [1, 2], w.deps, { guard: { minCardinality: 5 } });
    expect(r).toMatchObject({ published: false, reason: 'min-cardinality', cardinality: 2 });
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('minRetained refuses losing more of the segment than allowed, and permits growth', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4], w.deps);

    // 4 → 1 retains 25%; the bound demands 50%.
    const shrunk = await loadSegment(SEG, [1], w.deps, { guard: { minRetained: 0.5 } });
    expect(shrunk).toMatchObject({
      published: false,
      reason: 'min-retained',
      cardinalityBefore: 4,
    });

    // 4 → 3 retains 75%: inside the bound.
    const ok = await loadSegment(SEG, [1, 2, 3], w.deps, { guard: { minRetained: 0.5 } });
    expect(ok.published).toBe(true);

    // Growth is never a shrink, whatever the bound.
    const grown = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8], w.deps, {
      guard: { minRetained: 1 },
    });
    expect(grown.published).toBe(true);
  });

  it('pins minRetained ASYMMETRICALLY, so an inverted bound cannot pass', async () => {
    // 0.5 is the fixed point of `1 - x`, so a suite that only ever tests one-half cannot tell this bound from
    // its own inverse — the comparison mutated to the mirrored form leaves such a suite green. These two use
    // fractions where the two readings disagree.
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], w.deps); // 10 ids

    // Retaining 9/10 = 0.9. A bound of 0.8 must PASS; read as "max shrink 0.8" it would also pass, so pair it
    // with the case below where the two readings diverge.
    expect(
      (
        await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9], w.deps, {
          guard: { minRetained: 0.8 },
        })
      ).published,
    ).toBe(true);

    await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], w.deps); // back to 10
    // Retaining 2/10 = 0.2 against a bound of 0.8 must REFUSE. Under the inverted reading (max shrink 0.8) a
    // 0.8 drop is exactly permitted, so this is the case that separates them.
    expect((await loadSegment(SEG, [1, 2], w.deps, { guard: { minRetained: 0.8 } })).reason).toBe(
      'min-retained',
    );
  });

  it('is inclusive at both guard boundaries', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    // Exactly the floor retains: 2/4 = 0.5 against minRetained 0.5.
    expect(
      (await loadSegment(SEG, [1, 2], w.deps, { guard: { minRetained: 0.5 } })).published,
    ).toBe(true);
    // Exactly minCardinality passes too.
    expect(
      (await loadSegment(SEG, [1, 2], w.deps, { guard: { minCardinality: 2 } })).published,
    ).toBe(true);
  });

  it('minRetained does not refuse a FIRST load, which has nothing to shrink from', async () => {
    const w = world();
    const r = await loadSegment(SEG, [1], w.deps, { guard: { minRetained: 1 } });
    expect(r.published).toBe(true);
  });

  it('reports what the segment held, so a refusal is a diagnosis rather than a page', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    const r = await loadSegment(SEG, [1], w.deps, { guard: { minRetained: 0.9 } });
    expect(r.cardinalityBefore).toBe(4);
    expect(r.cardinality).toBe(1);
    expect(r.collected).toEqual([]); // nothing was published, so nothing was collected
  });

  it('audits a refusal — a replacement that did NOT happen is the reconcilable fact', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const audit = new RecordingAuditSink();
    await loadSegment(SEG, [], w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.load-refused',
        namespace: 'ns',
        segment: 's',
        incarnation: incarnationOf((await w.registry.get(SEG))!.token),
        generation: 1,
        reason: 'empty',
        cardinality: 0,
      },
    ]);
  });

  it('audits a publish', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await loadSegment(SEG, [1], w.deps, { audit });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.publish']);
  });
});

describe('loadSegment — racing writers', () => {
  /** `storage` with `hook` run once, around the first object put: before it lands, or after. */
  function around(
    storage: IStorageDriver,
    when: 'before' | 'after',
    hook: () => Promise<unknown>,
  ): IStorageDriver {
    let fired = false;
    return new Proxy(storage, {
      get(t, p, rx) {
        if (p !== 'put' && p !== 'putImmutable') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          if (!fired && when === 'before') {
            fired = true;
            await hook();
          }
          const out = await inner.apply(storage, args);
          if (!fired) {
            fired = true;
            await hook();
          }
          return out;
        };
      },
    }) as IStorageDriver;
  }

  it('a load that loses its generation number wrote nothing, and is audited like any refusal', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    // Another load takes the same number and lands before this one's object put.
    const racing = around(w.storage, 'before', () => loadSegment(SEG, [7], w.deps));
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: racing }, { audit });
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded', size: 0 });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.load-refused',
        namespace: 'ns',
        segment: 's',
        incarnation: incarnationOf((await w.registry.get(SEG))!.token),
        generation: 1,
        reason: 'superseded',
        cardinality: 0,
      },
    ]);
    expect(await idsOf(w.storage, 1)).toEqual([7]);
  });

  it('a refusal after another write changed the row leaves its object, superseded and guarded alike', async () => {
    // The delete is fenced on the row's token, not its pointer: a retention change moves no pointer and still
    // makes the number this call holds one it can no longer prove is its own.
    for (const [ids, reason] of [
      [[2], 'superseded'],
      [[], 'empty'],
    ] as const) {
      const w = world();
      await loadSegment(SEG, [1, 2, 3], w.deps);
      const racing = around(w.storage, 'after', () =>
        setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: Date.now() + 86_400_000 }),
      );
      const r = await loadSegment(SEG, ids, { ...w.deps, storage: racing });
      expect(r, reason).toMatchObject({ generation: 1, published: false, reason });
      expect((await w.registry.get(SEG))!.currentGen, reason).toBe(0);
      expect(await generations(w.storage), reason).toEqual([0, 1]);
    }
  });

  it('a refusal whose row was deleted while it wrote deletes its object', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const racing = around(w.storage, 'after', () => w.registry.delete(SEG));
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: racing });
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(await generations(w.storage)).toEqual([0]);
  });

  /**
   * With no row to prove the number its own, the refusal proves its object by the fingerprint its footer read, and
   * deletes it only while it is the object that read saw: its delete passes the version the driver reported on it. A
   * number can be taken again once its object is deleted, so `beforeDelete` runs between that read and the delete.
   */
  function reclaimWatched(
    storage: MemoryStorageDriver,
    registry: MemoryRegistryDriver,
    beforeDelete: () => Promise<void>,
  ): { driver: IStorageDriver; sent: { generation: number; ifVersion: string | undefined }[] } {
    const sent: { generation: number; ifVersion: string | undefined }[] = [];
    const racing = around(storage, 'after', () => registry.delete(SEG));
    const driver = new Proxy(racing, {
      get(t, p, rx) {
        if (p !== 'delete') return Reflect.get(t, p, rx) as unknown;
        return async (key: GenKey, options?: StorageDeleteOptions) => {
          sent.push({ generation: key.generation, ifVersion: options?.ifVersion });
          await beforeDelete();
          return storage.delete(key, options);
        };
      },
    }) as IStorageDriver;
    return { driver, sent };
  }

  it('a refusal whose row was deleted conditions its delete on the version its footer read reported', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    let seen: string | undefined;
    const { driver, sent } = reclaimWatched(w.storage, w.registry, async () => {
      seen = (await w.storage.getTail({ ...SEG, generation: 1 }, 0)).version;
    });
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: driver });
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(seen).toEqual(expect.any(String));
    expect(sent).toEqual([{ generation: 1, ifVersion: seen }]);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it('a refusal whose number was taken again since its footer read keeps the object now there, and still answers', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const { driver, sent } = reclaimWatched(w.storage, w.registry, async () => {
      // Its object is deleted, and another writer puts its own under the number.
      await w.storage.delete({ ...SEG, generation: 1 });
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [77], {
        codec: roaringCodec,
      });
    });
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: driver });
    // The refusal is the answer: the refused delete raises nothing out of the load.
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(sent).toHaveLength(1);
    expect(await generations(w.storage)).toEqual([0, 1]);
    expect(await idsOf(w.storage, 1)).toEqual([77]);
  });

  it('a refusal deletes with the version of the footer read that proved its object, not one read after it', async () => {
    // The object is replaced right after the read that proves it the load's own, before anything else is asked of it.
    // The delete must name the object that read saw: a version read again later names the one put since, and that
    // delete would remove it.
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const racing = around(w.storage, 'after', () => w.registry.delete(SEG));
    let replaced = false;
    const driver = new Proxy(racing, {
      get(t, p, rx) {
        if (p !== 'getTail') return Reflect.get(t, p, rx) as unknown;
        return async (key: GenKey, maxBytes: number) => {
          const read = await w.storage.getTail(key, maxBytes);
          if (!replaced && key.generation === 1 && maxBytes === FOOTER_BYTES) {
            replaced = true; // the proving footer read has landed: another writer takes the number now
            await w.storage.delete({ ...SEG, generation: 1 });
            await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [77], {
              codec: roaringCodec,
            });
          }
          return read;
        };
      },
    }) as IStorageDriver;
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: driver });
    expect(replaced).toBe(true);
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(await generations(w.storage)).toEqual([0, 1]);
    expect(await idsOf(w.storage, 1)).toEqual([77]);
  });

  it('reports superseded rather than publishing a generation no reader will resolve', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);

    // A concurrent writer publishes a HIGHER generation while this load is between its write and its publish.
    let raced = false;
    const racingStorage = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'put' && p !== 'putImmutable') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.storage, args);
          if (!raced) {
            raced = true;
            await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 9 }, [99], {
              registry: w.registry,
              codec: roaringCodec,
            });
          }
          return out;
        };
      },
    }) as IStorageDriver;

    const r = await loadSegment(SEG, [2], { ...w.deps, storage: racingStorage }, { keep: 0 });
    expect(raced).toBe(true);
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    // The object is deliberately NOT deleted here: the row changed under this call, and a generation number
    // only identifies a generation within one incarnation. It is below the winner's pointer, so ordinary
    // generation collection takes it — no leak, and no risk of deleting something that is not ours.
    expect((await w.registry.get(SEG))!.currentGen).toBe(9);
    expect(await generations(w.storage)).toContain(9);
  });

  it('refuses, and touches nothing, when the name is re-created underneath it', async () => {
    // The sharpest edge on this path. Both the publish and the refusal's cleanup address a generation by NUMBER,
    // and a number names a generation only within one incarnation of the row. Purge the row and re-create the
    // name mid-load and `nextGeneration` restarts from 0, so the number this call is holding can come to name
    // the NEW incarnation's live object. Unfenced, that is two different disasters from one race: the publish
    // lands this call's content over a segment it never read (via publishGeneration's idempotent
    // same-generation branch), and the refusal deletes a live object, leaving an active row over nothing.
    const w = world();
    for (const ids of [[1], [2], [3], [4], [5]]) await loadSegment(SEG, ids, w.deps, { keep: 9 });
    expect((await w.registry.get(SEG))!.currentGen).toBe(4); // this call will take generation 5

    let fired = false;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'putImmutable' && p !== 'put') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.storage, args);
          if (fired) return out;
          fired = true;
          // Retire the segment and re-use the name, loading until the new incarnation's own pointer reaches 5 —
          // the very number this call is holding.
          for (const g of await generations(w.storage))
            await w.storage.delete({ ...SEG, generation: g });
          await w.registry.delete(SEG);
          for (const ids of [[10], [11], [12], [13], [14], [15]]) {
            await loadSegment(SEG, ids, w.deps, { keep: 9 });
          }
          return out;
        };
      },
    }) as IStorageDriver;

    const before = (await w.registry.get(SEG))!;
    const r = await loadSegment(SEG, [42], { ...w.deps, storage: racing }, {});
    expect(fired).toBe(true);
    expect(before.currentGen).toBe(4);

    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(5); // the NEW incarnation's pointer, coincidentally the same number
    // 1. It must not have published its content into a segment it never read.
    expect(r.published).toBe(false);
    expect(await idsOf(w.storage, 5)).toEqual([15]);
    // 2. And it must not have deleted that live object on its way out.
    expect(await generations(w.storage)).toContain(5);
  });
});

describe('loadSegment — the guard is fenced on the row it judged', () => {
  it('refuses rather than wiping when another loader publishes between the read and the publish', async () => {
    // The guard reads the "before" cardinality, then writes, then publishes. Anything that lands in between
    // voids the premise the guard judged on — and an unfenced forward-only publish would report success anyway.
    // Without the fence, two loaders on a fresh segment can land an EMPTY generation over a thousand ids, under
    // DEFAULT options, because `before` reads as "no row yet". This case does not reach the fence: its racer fires
    // from the object PUT, after `nextGeneration` has chosen, so both loaders take the same number and the
    // write-once collision stops the loser first. The fence itself is pinned in `publish-absence-fence.test.ts`.
    const w = world();
    let raced = false;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'putImmutable' && p !== 'put') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          if (!raced) {
            raced = true;
            await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps); // the other loader wins
          }
          return inner.apply(w.storage, args);
        };
      },
    }) as IStorageDriver;

    const r = await loadSegment(SEG, [], { ...w.deps, storage: racing }, {});
    expect(raced).toBe(true);
    expect(r.published).toBe(false);
    // The winner's content survives — which is the entire point.
    const row = (await w.registry.get(SEG))!;
    expect(await idsOf(w.storage, row.currentGen!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('an UNGUARDED load onto a row publishes: it judged no pointer, so only the row it read fences it', async () => {
    // The other half of the contract. An unguarded load derived nothing from the current generation, so it carries
    // no fence on the pointer; it is fenced on the row's token, as every load that found a row is.
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    const r = await loadSegment(SEG, [2, 3], w.deps, { allowEmpty: true });
    expect(r.published).toBe(true);
  });
});

describe('loadSegment — encryption', () => {
  it('loads an encrypted segment REPEATEDLY — the guard reads the previous generation through its own key', async () => {
    // The guard has to open the current generation to size it, and a `.crbm` is encrypted per generation with
    // AAD bound to that generation number. Taking the crypto from the caller cannot work — only this call
    // learns which generation is current — so it derives it from the row. Without that, every encrypted
    // segment's SECOND load throws, and the only workaround is `allowEmpty: true`, which disables the wipe
    // guard: the sensitive segments would be exactly the ones left unprotected.
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { storage, registry, codec: roaringCodec, keystore, requireEncryption: true };

    expect((await loadSegment(SEG, [1, 2, 3], deps)).published).toBe(true);
    expect((await loadSegment(SEG, [4, 5, 6], deps)).published).toBe(true);
    // And the guard actually functions on an encrypted segment rather than silently seeing zero.
    const refused = await loadSegment(SEG, [], deps);
    expect(refused).toMatchObject({ published: false, reason: 'empty' });
  });
});

describe('loadSegment — validation', () => {
  it('rejects a bad ref and bad guard values before touching storage', async () => {
    const w = world();
    await expect(loadSegment({ segment: '' }, [1], w.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(loadSegment(SEG, [1], w.deps, { keep: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // Not a number, not whole, not finite: each would otherwise reach the collection and collect, or keep, the wrong set.
    for (const keep of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(loadSegment(SEG, [1], w.deps, { keep })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { minRetained: 1.5 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { minCardinality: -1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generations(w.storage)).toEqual([]);
  });
});

describe('two loads onto a segment with no row, under allowEmpty and no guard', () => {
  // Invariant 1's fence on absence, for loads that judged nothing. Neither load found a row, so each fences its publish
  // on that absence: the first to publish creates the row, and the other is refused, whichever number it holds. Both
  // loads write their object before either publishes (the gate holds each one right after its put), so they hold
  // different numbers: the first takes 0, the second sees that object and takes 1.
  async function raced(firstToPublish: 'lower' | 'higher') {
    const w = world();
    const held: { release: () => void; arrived: Promise<void> }[] = [];
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      list: (ref) => w.storage.list(ref),
      delete: (k, o) => w.storage.delete(k, o),
      putImmutable: async (k, fn) => {
        const out = await w.storage.putImmutable(k, fn);
        let arrive!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>((r) => (arrive = r));
        const gate = new Promise<void>((r) => (release = r));
        held.push({ release, arrived });
        arrive();
        await gate;
        return out;
      },
    };
    const deps = { ...w.deps, storage };
    const audits = { lower: new RecordingAuditSink(), higher: new RecordingAuditSink() };
    const lower = loadSegment(SEG, [1], deps, { allowEmpty: true, audit: audits.lower });
    await until(() => held.length === 1);
    const higher = loadSegment(SEG, [2], deps, { allowEmpty: true, audit: audits.higher });
    await until(() => held.length === 2);

    const [a, b] = firstToPublish === 'lower' ? [0, 1] : [1, 0];
    held[a]!.release();
    const first = await (a === 0 ? lower : higher);
    held[b]!.release();
    const second = await (b === 0 ? lower : higher);
    return {
      w,
      audits,
      lower: a === 0 ? first : second,
      higher: a === 0 ? second : first,
    };
  }
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  };

  it('the higher is refused when the lower publishes first: one lands, the refusal is audited, and the next load collects its object', async () => {
    const { w, audits, lower, higher } = await raced('lower');
    expect([lower.generation, higher.generation]).toEqual([0, 1]);
    expect(lower.published).toBe(true);
    expect(higher).toMatchObject({ published: false, reason: 'superseded' });
    expect(audits.higher.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'segment.load-refused',
        generation: 1,
        reason: 'superseded',
      }),
    ]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.storage, 0)).toEqual([1]);
    // The row it met is another load's, so the refusal cannot prove the number its own: its object stays above the
    // pointer, and the next load's check meets it, numbers past it by a listing, and that listing deletes it.
    expect(await generations(w.storage)).toEqual([0, 1]);
    expect(await loadSegment(SEG, [3], w.deps)).toMatchObject({ generation: 2, published: true });
    expect(await generations(w.storage)).toEqual([0, 2]);
  });

  it('the lower one is superseded when the higher publishes first', async () => {
    const { w, audits, lower, higher } = await raced('higher');
    expect([lower.generation, higher.generation]).toEqual([0, 1]);
    expect(higher.published).toBe(true);
    expect(lower).toMatchObject({ published: false, reason: 'superseded' });
    expect(audits.lower.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'segment.load-refused',
        generation: 0,
        reason: 'superseded',
      }),
    ]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await idsOf(w.storage, 1)).toEqual([2]);
  });
});

describe('judgeLoad — the refusal it reports', () => {
  it('has a type a caller can name: every load refusal but a lost race', () => {
    expectTypeOf<NonNullable<LoadJudgement['wouldRefuse']>>().toEqualTypeOf<GuardRefusal>();
    expectTypeOf<GuardRefusal>().toEqualTypeOf<Exclude<LoadRefusal, 'superseded'>>();
  });
});
