import { CloudRoaring, MemoryStorage, RecordingAuditSink, WriteConflictError } from '@/index';
import { collect } from '../helpers/loaded';

/**
 * **A write that found no row fences its publish on that absence, guarded or not.**
 *
 * WHY THIS FILE EXISTS. A load reads the segment's row once and fences its publish on what it found. The other two
 * fences compare against a value taken FROM a row: `expectFrom` against the pointer, `expectToken` against the
 * identity. With no row both are omitted, and without a fence on the absence itself the publish is a bare
 * forward-only advance. A writer that creates the row in that window is then published over.
 *
 * Two failures follow from that, and these tests hold both. A guarded load that judged an absent segment passed its
 * bounds vacuously (`before` is `null`), so an empty generation landed over a thousand ids another writer had just
 * loaded, reporting `published: true`. And an unguarded load (`allowEmpty: true`, no growth or retention bound) moved
 * the pointer over whatever row appeared: over another first load, or onto a row `setRetention` created. Every such
 * load is refused `superseded` instead.
 *
 * `tests/core/load.test.ts` has a test named for the guarded case ("refuses rather than wiping when another loader
 * publishes between the read and the publish") and it cannot reach this fence: it fires its racer from a
 * `putImmutable` proxy, i.e. after the load has chosen its number. Both writers then pick the same generation number
 * and the loser is stopped by the write-once collision on the object PUT, never by the fence.
 *
 * So the racer here fires from the REGISTRY READ, which is the only interleaving that reaches it.
 */

/** Run `body` while the first `registry.get` that answers "no row" for `segment` triggers `racer`. */
async function withRacerOnAbsentRow(
  backend: MemoryStorage,
  segment: string,
  racer: () => Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  const real = backend.registry.get.bind(backend.registry);
  let fired = false;
  (backend.registry as unknown as { get: typeof real }).get = async (ref) => {
    const out = await real(ref);
    if (!fired && ref.segment === segment && out === null) {
      fired = true;
      await racer();
    }
    return out;
  };
  try {
    await body();
  } finally {
    (backend.registry as unknown as { get: typeof real }).get = real;
  }
}

const THOUSAND = Array.from({ length: 1000 }, (_, i) => i);

describe('a write that judged an absent segment does not publish over one that appeared', () => {
  it('intersectInto: an empty combine cannot wipe a destination created mid-call', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, [1, 2]);
    await store.load({ segment: 'b' }, [70_000]); // a ∩ b = ∅

    let threw: unknown;
    await withRacerOnAbsentRow(
      backend,
      'dest',
      async () => {
        const other = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
        await other.load({ segment: 'dest' }, THOUSAND);
      },
      async () => {
        await store
          .segment('a')
          .intersectInto(store.segment('dest'), [store.segment('b')])
          .catch((e: unknown) => {
            threw = e;
          });
      },
    );

    // The *Into verbs report a lost race by throwing; what matters is that the ids are still there.
    expect(threw).toBeInstanceOf(WriteConflictError);
    expect(await collect(store.segment('dest').iterate())).toHaveLength(1000);
  });

  it('load(): the same hole, on the path the guard exists for', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });

    let res: { published: boolean; reason?: string } | undefined;
    await withRacerOnAbsentRow(
      backend,
      'dest',
      async () => {
        const other = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
        await other.load({ segment: 'dest' }, THOUSAND);
      },
      async () => {
        res = await store.load({ segment: 'dest' }, []);
      },
    );

    // `load()` reports rather than throws — but it must not report success.
    expect(res?.published).toBe(false);
    expect(res?.reason).toBe('superseded');
    expect(await collect(store.segment('dest').iterate())).toHaveLength(1000);
  });

  it('control: with no racer, a first write into an absent segment still publishes', async () => {
    // The fence must not cost the ordinary case anything — this is the common path.
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const res = await store.load({ segment: 'fresh' }, [1, 2, 3]);
    expect(res.published).toBe(true);
    expect(await collect(store.segment('fresh').iterate())).toEqual([1, 2, 3]);
  });
});

/** The generations `segment`'s objects hold, ascending. */
async function objects(backend: MemoryStorage, segment: string): Promise<number[]> {
  const out: number[] = [];
  for await (const k of backend.storage.list({ segment })) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('an unguarded write that found no row fences on that absence too', () => {
  const racingLoad = (backend: MemoryStorage) => async (): Promise<void> => {
    const other = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await other.load({ segment: 'dest' }, THOUSAND);
  };

  it('load({ allowEmpty: true }): refused and audited, and its object is left for the next load to collect', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const audit = new RecordingAuditSink();

    let res: Awaited<ReturnType<CloudRoaring['load']>> | undefined;
    await withRacerOnAbsentRow(backend, 'dest', racingLoad(backend), async () => {
      res = await store.load({ segment: 'dest' }, [5, 6], { allowEmpty: true, audit });
    });

    // The other load created the row at 0; this one saw that object, took 1, and its publish met the row.
    expect(res).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'segment.load-refused',
        generation: 1,
        reason: 'superseded',
      }),
    ]);
    expect((await backend.registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    expect(await collect(store.segment('dest').iterate())).toHaveLength(1000);
    // The row changed under it, so the refusal cannot prove the number its own and leaves the object above the
    // pointer. The next load's check meets it, numbers above it by a listing, and that listing deletes it.
    expect(await objects(backend, 'dest')).toEqual([0, 1]);
    expect(await store.load({ segment: 'dest' }, [7])).toMatchObject({
      generation: 2,
      published: true,
    });
    expect(await objects(backend, 'dest')).toEqual([0, 2]);
  });

  it('an *Into with allowEmpty: true: a lost race throws, and the destination keeps its ids', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, [1, 2]);
    await store.load({ segment: 'b' }, [70_000]); // a ∩ b = ∅

    let threw: unknown;
    await withRacerOnAbsentRow(backend, 'dest', racingLoad(backend), async () => {
      await store
        .segment('a')
        .intersectInto(store.segment('dest'), [store.segment('b')], { allowEmpty: true })
        .catch((e: unknown) => {
          threw = e;
        });
    });

    expect(threw).toBeInstanceOf(WriteConflictError);
    expect((await backend.registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    expect(await collect(store.segment('dest').iterate())).toHaveLength(1000);
  });

  it('a materializeMany output with allowEmpty: true: reported as a lost race, and the destination keeps its ids', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, [1, 2]);
    await store.load({ segment: 'b' }, [70_000]);

    let run: Awaited<ReturnType<CloudRoaring['materializeMany']>> | undefined;
    await withRacerOnAbsentRow(backend, 'dest', racingLoad(backend), async () => {
      run = await store.materializeMany({
        operands: { a: store.segment('a'), b: store.segment('b') },
        outputs: [{ dest: store.segment('dest'), expr: { and: ['a', 'b'] }, allowEmpty: true }],
        keep: 1,
      });
    });

    expect(run!.outputs[0]).toMatchObject({
      published: false,
      error: expect.any(WriteConflictError),
    });
    expect((await backend.registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    expect(await collect(store.segment('dest').iterate())).toHaveLength(1000);
  });

  it('a row setRetention creates while the load writes refuses it, and the row keeps its policy', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const expiresAt = Date.now() + 86_400_000;

    let res: Awaited<ReturnType<CloudRoaring['load']>> | undefined;
    await withRacerOnAbsentRow(
      backend,
      'dest',
      async () => {
        const other = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
        await other.setRetention({ segment: 'dest' }, { expiresAt });
      },
      async () => {
        res = await store.load({ segment: 'dest' }, [1, 2, 3], { allowEmpty: true });
      },
    );

    // The row it would have published onto names no generation: the load found none, and a row appeared.
    expect(res).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    const row = (await backend.registry.get({ segment: 'dest' }))!;
    expect(row.currentGen).toBeNull();
    expect(row.retention).toBeDefined();
    expect(await store.exists({ segment: 'dest' })).toBe(false);
    // Its object is left in the bucket. The next load numbers past it; that row recorded no kept generations, so the
    // load's listing keeps the newest one below its pointer, this object, and the load after it pushes it out.
    expect(await objects(backend, 'dest')).toEqual([0]);
    expect(await store.load({ segment: 'dest' }, [4])).toMatchObject({
      generation: 1,
      published: true,
    });
    expect((await backend.registry.get({ segment: 'dest' }))!.retention).toEqual(row.retention);
    expect(await collect(store.segment('dest').iterate())).toEqual([4]);
    expect(await objects(backend, 'dest')).toEqual([0, 1]);
    expect(await store.load({ segment: 'dest' }, [5])).toMatchObject({
      generation: 2,
      published: true,
    });
    expect(await objects(backend, 'dest')).toEqual([1, 2]);
  });
});
