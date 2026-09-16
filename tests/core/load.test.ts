import { randomBytes } from 'node:crypto';
import { loadSegment } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { ValidationError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  MemoryStorageDriver,
  MemoryRegistryDriver,
  RecordingAuditSink,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';

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
    // its own inverse — mutating the comparison to the mirrored form left every test green. These two use
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
  it('reports superseded rather than publishing a generation no reader will resolve', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);

    // A concurrent writer publishes a HIGHER generation while this load is between its write and its publish.
    let raced = false;
    const racingCold = new Proxy(w.storage, {
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

    const r = await loadSegment(SEG, [2], { ...w.deps, storage: racingCold }, { keep: 0 });
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
    // Reproduced before the fence existed: two loaders on a fresh segment let an EMPTY generation land over a
    // thousand ids, under DEFAULT options, because `before` had been read as "no row yet".
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

  it('an UNGUARDED load stays forward-only, so a concurrent publish does not make it refuse', async () => {
    // The other half of the contract. Forward-only is right when nothing was derived: the ids come from
    // upstream, so losing a race costs nothing the winner did not also bring. Fencing every load would make
    // routine concurrent loading fail for no benefit.
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
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { minRetained: 1.5 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { minCardinality: -1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generations(w.storage)).toEqual([]);
  });
});
