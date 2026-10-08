import { describe, expect, it } from 'vitest';
import { loadSegment } from '@/core/load';
import { ValidationError } from '@/core/errors';
import { CloudRoaring, MemoryStorage, RecordingAuditSink } from '@/index';
import type { SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `guard.maxGrowth` — the ceiling to `minRetained`'s floor.
 *
 * A source that lands duplicated, or joined on the wrong key, grows a segment as quietly as a partial one shrinks it,
 * and both are an ordinary successful write at the storage layer. These tests pin the bound itself (strict above the
 * ceiling, inclusive at it, never a shrink, nothing to multiply on a first or empty segment), its order behind the
 * older bounds, its validation before any request, and the one way it could be silently vacuous: with
 * `allowEmpty: true` nothing else reads the current size or fences the publish on it, so the bound must turn both on.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const ids = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}

describe('guard.maxGrowth on load', () => {
  it('refuses a generation above the ceiling, reports both sizes, and leaves the segment as it was', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    const r = await loadSegment(SEG, ids(151), w.deps, { guard: { maxGrowth: 1.5 } });
    expect(r).toMatchObject({
      published: false,
      reason: 'max-growth',
      cardinality: 151,
      cardinalityBefore: 100,
      collected: [],
    });
    expect((await w.registry.get(SEG))?.currentGen).toBe(0);
  });

  it('is inclusive at the ceiling', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    const r = await loadSegment(SEG, ids(150), w.deps, { guard: { maxGrowth: 1.5 } });
    expect(r.published).toBe(true);
  });

  it('never refuses a shrink, and `1` means never grow', async () => {
    // A bound read the wrong way round ("max shrink") would refuse the first and pass the second.
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    expect((await loadSegment(SEG, ids(10), w.deps, { guard: { maxGrowth: 1 } })).published).toBe(
      true,
    );
    expect((await loadSegment(SEG, ids(11), w.deps, { guard: { maxGrowth: 1 } })).reason).toBe(
      'max-growth',
    );
    expect(
      (await loadSegment(SEG, ids(10, 5), w.deps, { guard: { maxGrowth: 1 } })).published,
    ).toBe(true);
  });

  it('`0` means no bound', async () => {
    const w = world();
    await loadSegment(SEG, ids(10), w.deps);
    const r = await loadSegment(SEG, ids(10_000), w.deps, { guard: { maxGrowth: 0 } });
    expect(r.published).toBe(true);
  });

  it('does not judge a first load, which has no size to multiply', async () => {
    const w = world();
    const r = await loadSegment(SEG, ids(1000), w.deps, { guard: { maxGrowth: 1 } });
    expect(r).toMatchObject({ published: true, cardinalityBefore: null });
  });

  it('does not judge a load onto an empty segment, so refilling one is never wedged', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    await loadSegment(SEG, [], w.deps, { allowEmpty: true });
    const r = await loadSegment(SEG, ids(100), w.deps, { guard: { maxGrowth: 1 } });
    expect(r).toMatchObject({ published: true, cardinalityBefore: 0 });
  });

  it('is judged after the older bounds, so a load that breaks one of them keeps its reason', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    const r = await loadSegment(SEG, ids(1000), w.deps, {
      guard: { minCardinality: 10_000, maxGrowth: 1.5 },
    });
    expect(r.reason).toBe('min-cardinality');
  });

  it('audits the refusal with its reason', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await loadSegment(SEG, ids(100), w.deps);
    await loadSegment(SEG, ids(200), w.deps, { guard: { maxGrowth: 1.5 }, audit });
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'segment.load-refused',
        reason: 'max-growth',
        cardinality: 200,
      }),
    ]);
  });

  it('judges the bound as it was when the call began, whatever the caller does to its guard object meanwhile', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    const guard = { maxGrowth: 1.5 };
    // Changed once the load is under way: at its first row read, e.g. one object reused for the next segment's load.
    const realGet = w.registry.get.bind(w.registry);
    w.registry.get = async (ref) => {
      guard.maxGrowth = 100;
      return realGet(ref);
    };
    const r = await loadSegment(SEG, ids(151), w.deps, { guard });
    w.registry.get = realGet;
    expect(guard.maxGrowth).toBe(100);
    expect(r.reason).toBe('max-growth');
  });

  it('names a value that is not a number by its type, never as a number', async () => {
    const w = world();
    await expect(
      loadSegment(SEG, ids(3), w.deps, { guard: { maxGrowth: '2' as unknown as number } }),
    ).rejects.toThrow(/got a string$/);
    await expect(
      loadSegment(SEG, ids(3), w.deps, { guard: { maxGrowth: Object.create(null) as number } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '2' as unknown as number])(
    'refuses maxGrowth %s before any request',
    async (maxGrowth) => {
      const w = world();
      let requests = 0;
      const realGet = w.registry.get.bind(w.registry);
      w.registry.get = (ref) => {
        requests++;
        return realGet(ref);
      };
      await expect(loadSegment(SEG, ids(3), w.deps, { guard: { maxGrowth } })).rejects.toThrow(
        /^guard\.maxGrowth must be 0 \(no bound\) or a factor of at least 1/,
      );
      await expect(
        loadSegment(SEG, ids(3), w.deps, { guard: { maxGrowth } }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(requests).toBe(0);
    },
  );
});

describe('guard.maxGrowth with allowEmpty: true', () => {
  it('still reads the size before, so the bound is not vacuous', async () => {
    const w = world();
    await loadSegment(SEG, ids(100), w.deps);
    const r = await loadSegment(SEG, ids(1000), w.deps, {
      allowEmpty: true,
      guard: { maxGrowth: 1.5 },
    });
    expect(r).toMatchObject({ published: false, reason: 'max-growth', cardinalityBefore: 100 });
  });

  it('costs no request: the size comes from the row it already read, as for minRetained', async () => {
    const counts: number[] = [];
    for (const guard of [{ minRetained: 0.5 }, { maxGrowth: 1.5 }, {}]) {
      const w = world();
      await loadSegment(SEG, ids(100), w.deps);
      let requests = 0;
      for (const driver of [w.registry, w.storage] as unknown as Record<string, unknown>[]) {
        for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(driver))) {
          const fn = driver[name];
          if (name === 'constructor' || typeof fn !== 'function') continue;
          driver[name] = (...args: unknown[]) => {
            requests++;
            return (fn as (...a: unknown[]) => unknown).apply(driver, args);
          };
        }
      }
      const r = await loadSegment(SEG, ids(120), w.deps, { allowEmpty: true, guard });
      expect(r.published).toBe(true);
      counts.push(requests);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
    // The control: an unguarded load makes the same requests, since the row it reads anyway carries the size.
    expect(counts[2]).toBe(counts[0]);
  });

  it('fences the publish on what it judged: a segment that appears in between makes it superseded', async () => {
    // A load that finds a row is fenced on that row's token whatever its options, so the case the bound itself
    // fences is the one with no row. The guarded load judged "no current generation", so no ceiling applied; a
    // writer then creates the segment with 10 ids. Publishing 1,000 over them on the strength of the stale verdict is
    // what the fence on that absence refuses.
    const run = async (guard: { maxGrowth?: number }) => {
      const w = world();
      const realGet = w.registry.get.bind(w.registry);
      let raced = false;
      // The racer runs once, right after the guarded load's row read, and its own reads pass straight through.
      w.registry.get = async (ref) => {
        const row = await realGet(ref);
        if (!raced) {
          raced = true;
          await loadSegment(SEG, ids(10), w.deps);
        }
        return row;
      };
      const r = await loadSegment(SEG, ids(1000), w.deps, { allowEmpty: true, guard });
      w.registry.get = realGet;
      const summary = (await w.registry.get(SEG))?.summary;
      return { r, current: summary && 'cardinality' in summary ? summary.cardinality : undefined };
    };

    const guarded = await run({ maxGrowth: 1.5 });
    expect(guarded.r).toMatchObject({ published: false, reason: 'superseded' });
    expect(guarded.current).toBe(10);

    // Control: without the bound, `allowEmpty: true` onto a segment with no row is the one bare forward-only publish.
    const unguarded = await run({});
    expect(unguarded.r.published).toBe(true);
    expect(unguarded.current).toBe(1000);
  });
});

describe('guard.maxGrowth on the write verbs that route through load', () => {
  it('an *Into refuses with max-growth and the destination still reads', async () => {
    const { store } = await loadedStore({ a: ids(1000), b: ids(1000), dest: ids(10) });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], { guard: { maxGrowth: 2 } });
    expect(res).toMatchObject({
      published: false,
      reason: 'max-growth',
      cardinality: 1000,
      cardinalityBefore: 10,
    });
    expect(await collect(store.segment('dest').iterate())).toEqual(ids(10));
  });

  it('a materializeMany output is refused alone, and its neighbours publish', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage(), cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, ids(1000));
    await store.load({ segment: 'd-grow' }, ids(10));
    await store.load({ segment: 'd-ok' }, ids(900));
    const s = (n: string) => store.segment(n);
    const run = await store.materializeMany({
      operands: { a: s('a') },
      outputs: [
        { dest: s('d-grow'), expr: 'a', guard: { maxGrowth: 2 } },
        { dest: s('d-ok'), expr: 'a', guard: { maxGrowth: 2 } },
      ],
      keep: 1,
    });
    expect(run.outputs[0]).toMatchObject({ published: false, reason: 'max-growth' });
    expect(run.outputs[1]).toMatchObject({ published: true, cardinality: 1000 });
    expect(await s('d-grow').count()).toBe(10);
  });

  it.each([
    [
      { minCardinality: 1.5 },
      /^outputs\[0\]\.guard\.minCardinality must be a non-negative integer; got 1\.5$/,
    ],
    [{ minRetained: 2 }, /^outputs\[0\]\.guard\.minRetained must be a fraction in 0\.\.1; got 2$/],
  ])(
    'the shared check keeps the batch messages of the older bounds (%o)',
    async (guard, message) => {
      const store = new CloudRoaring({ storage: new MemoryStorage(), cache: { genTtlMs: 0 } });
      await store.load({ segment: 'a' }, ids(10));
      await expect(
        store.materializeMany({
          operands: { a: store.segment('a') },
          outputs: [{ dest: store.segment('d'), expr: 'a', guard }],
          keep: 1,
        }),
      ).rejects.toThrow(message);
    },
  );

  it('a materializeMany output with a bad maxGrowth fails the call before any request, naming the output', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage(), cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, ids(10));
    const s = (n: string) => store.segment(n);
    await expect(
      store.materializeMany({
        operands: { a: s('a') },
        outputs: [
          { dest: s('d1'), expr: 'a' },
          { dest: s('d2'), expr: 'a', guard: { maxGrowth: 0.9 } },
        ],
        keep: 1,
      }),
    ).rejects.toThrow(
      /outputs\[1\]\.guard\.maxGrowth must be 0 \(no bound\) or a factor of at least 1; got 0\.9/,
    );
    expect(await store.exists({ segment: 'd1' })).toBe(false);
  });
});
