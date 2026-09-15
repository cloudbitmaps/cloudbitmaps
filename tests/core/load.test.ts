import { randomBytes } from 'node:crypto';
import { loadSegment } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-cold-source';
import { ValidationError } from '@/core/errors';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  MemoryColdDriver,
  MemoryRegistryDriver,
  RecordingAuditSink,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { IColdDriver, SegmentRef } from '@/index';
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
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  return { cold, registry, deps: { cold, registry, codec: roaringCodec } };
}

async function generations(cold: IColdDriver, ref: SegmentRef = SEG): Promise<number[]> {
  const out: number[] = [];
  for await (const k of cold.list(ref)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function idsOf(cold: IColdDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(cold, { ...SEG, generation }, undefined);
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
    expect(await generations(w.cold)).toEqual([1]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('REPLACES rather than merges — the new generation is exactly what was streamed', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    await loadSegment(SEG, [9], w.deps);
    expect(await idsOf(w.cold, 1)).toEqual([9]);
  });

  it('keeps the grace window by default', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await loadSegment(SEG, [2], w.deps);
    const third = await loadSegment(SEG, [3], w.deps);
    // default keep: 1 — generation 1 survives as the window, generation 0 goes.
    expect(third.collected).toEqual([0]);
    expect(await generations(w.cold)).toEqual([1, 2]);
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
    expect(await generations(w.cold)).toEqual([0]);
    // And the segment still holds what it held.
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await idsOf(w.cold, 0)).toEqual([1, 2, 3]);
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
    expect(await idsOf(w.cold, 1)).toEqual([]);
  });

  it('minCardinality refuses a load that is too small to be plausible', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps);
    const r = await loadSegment(SEG, [1, 2], w.deps, { guard: { minCardinality: 5 } });
    expect(r).toMatchObject({ published: false, reason: 'min-cardinality', cardinality: 2 });
    expect(await generations(w.cold)).toEqual([0]);
  });

  it('maxShrink refuses losing more of the segment than allowed, and permits growth', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3, 4], w.deps);

    // 4 → 1 is a 75% drop; the bound allows 50%.
    const shrunk = await loadSegment(SEG, [1], w.deps, { guard: { maxShrink: 0.5 } });
    expect(shrunk).toMatchObject({ published: false, reason: 'max-shrink' });

    // 4 → 3 is a 25% drop: inside the bound.
    const ok = await loadSegment(SEG, [1, 2, 3], w.deps, { guard: { maxShrink: 0.5 } });
    expect(ok.published).toBe(true);

    // Growth is never a shrink, whatever the bound.
    const grown = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8], w.deps, {
      guard: { maxShrink: 0 },
    });
    expect(grown.published).toBe(true);
  });

  it('maxShrink does not refuse a FIRST load, which has nothing to shrink from', async () => {
    const w = world();
    const r = await loadSegment(SEG, [1], w.deps, { guard: { maxShrink: 0 } });
    expect(r.published).toBe(true);
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
    const racingCold = new Proxy(w.cold, {
      get(t, p, rx) {
        if (p !== 'put' && p !== 'putImmutable') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          const out = await inner.apply(w.cold, args);
          if (!raced) {
            raced = true;
            await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 9 }, [99], {
              registry: w.registry,
              codec: roaringCodec,
            });
          }
          return out;
        };
      },
    }) as IColdDriver;

    const r = await loadSegment(SEG, [2], { ...w.deps, cold: racingCold }, { keep: 0 });
    expect(raced).toBe(true);
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    // The orphan is cleaned up: forward-only refused it, so no reader would ever resolve it.
    expect(await generations(w.cold)).not.toContain(r.generation);
    expect((await w.registry.get(SEG))!.currentGen).toBe(9);
  });
});

describe('loadSegment — encryption', () => {
  it('carries the freshly minted DEK onto the deferred publish, so the generation is readable', async () => {
    // The guard forces write-then-publish as two steps, and the DEK is minted during the write. If it is not
    // carried across, the publish records no key and the generation it makes current is encrypted with a key
    // nothing stored — unreadable, and only discovered on the next read.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { cold, registry, codec: roaringCodec, keystore, requireEncryption: true };

    const r = await loadSegment(SEG, [1, 2, 3], deps);
    expect(r.published).toBe(true);
    const row = (await registry.get(SEG))!;
    expect(row.wrappedDeks?.length).toBeGreaterThan(0);
  });
});

describe('loadSegment — validation', () => {
  it('rejects a bad ref and bad guard values before touching storage', async () => {
    const w = world();
    await expect(loadSegment({ segment: '../bad' }, [1], w.deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(loadSegment(SEG, [1], w.deps, { keep: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { maxShrink: 1.5 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      loadSegment(SEG, [1], w.deps, { guard: { minCardinality: -1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await generations(w.cold)).toEqual([]);
  });
});
