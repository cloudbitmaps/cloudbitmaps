import { CloudRoaring, MemoryStorage, WriteConflictError } from '@/index';
import { collect } from '../helpers/loaded';

/**
 * **A guarded write that judged an ABSENT segment must fence on that absence.**
 *
 * WHY THIS FILE EXISTS. `loadSegment` protects a destination by reading what it currently holds and refusing
 * an empty or implausible result over it. When the segment has no registry row there is nothing to read, so
 * `before` is `null` and every bound passes vacuously — correctly, because there is nothing to lose.
 *
 * The bug was what happened next. Both existing fences compare against a value taken FROM a row —
 * `expectFrom` against the pointer, `expectToken` against the identity — so with no row both were omitted and
 * the publish became a bare forward-only advance. A writer that created the row and published in that window
 * was then overwritten by the empty generation, and the result said `published: true` with no reason.
 *
 * `tests/core/load.test.ts` has a test named for this exact invariant ("refuses rather than wiping when
 * another loader publishes between the read and the publish") and it did NOT catch it: it fires its racer
 * from a `putImmutable` proxy, i.e. after `nextGeneration` has already chosen. Both writers then pick the
 * same generation number and the loser is stopped by the write-once collision on the object PUT — never by
 * the fence. The fence was untested in the one case where it was missing.
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

  it('load(): the same hole, on the path the guard was written for', async () => {
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
