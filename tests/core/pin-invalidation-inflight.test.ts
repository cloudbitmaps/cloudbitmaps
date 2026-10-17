import { MemoryStorage, CloudRoaring, NotFoundError } from '@/index';
import type { Segment, SegmentRef } from '@/index';
import type { IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { brandAsBackend } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * An invalidation reaches every pin of the segment, including one whose read is in flight when it runs.
 *
 * A pin reads through an engine of its own, and a combine with a pinned operand through another, over the store's one
 * chunk cache. The store's writes (`eraseSubject`, `load`, `rollback`, `dropSegment`) and `invalidate` drop the
 * segment's decoded chunks from that cache, pins' included. A pinned read that had already sent its request when that
 * ran must not then write what it read back into the cache: the next read of the pin would be served the erased
 * generation from memory, with no request, for as long as the entry stayed cached, after the erasure had reported the
 * id gone. Instead the pin opens its object again, and fails if the object is gone (`reading.md`, "store.invalidate";
 * the `Segment.pin` doc).
 *
 * Each case holds the pinned read on a gate after its range request has read the bytes, runs the verb, then lets the
 * read finish. The held read meets the invalidation before it hands its chunk out, so it looks its pin up again: it
 * answers from the pinned object where the verb left it in place, and fails with `NotFoundError` where the verb deleted
 * it, as the pin's next read does.
 */
const NS = 'ns';
const REF: SegmentRef = { namespace: NS, segment: 's' };
const C = 65_536;
const ERASED = C + 4_464; // 70,000, in chunk 1
const HIGH = 3 * C + 5; // in chunk 3
const IDS = [1, 2, 3, ERASED, ERASED + 1, HIGH];

interface Held {
  /** Settles once the held request has read its bytes. */
  readonly reached: Promise<void>;
  release(): void;
}

/** A storage driver that counts reads, and can hold the next range read of one segment until it is released. */
function gatedStorage(inner: IStorageDriver) {
  let hold: { segment: string; reached: () => void; gate: Promise<void> } | undefined;
  let reads = 0;
  const storage: IStorageDriver = {
    capabilities: () => inner.capabilities(),
    getRange: async (key, offset, length) => {
      reads += 1;
      const bytes = await inner.getRange(key, offset, length);
      const h = hold;
      if (h !== undefined && key.segment === h.segment) {
        hold = undefined;
        h.reached();
        await h.gate;
      }
      return bytes;
    },
    getTail: (key, maxBytes) => {
      reads += 1;
      return inner.getTail(key, maxBytes);
    },
    putImmutable: (key, write) => inner.putImmutable(key, write),
    list: (ref) => inner.list(ref),
    delete: (key, options) => inner.delete(key, options),
  };
  return {
    storage,
    reads: () => reads,
    holdNextRange(segment: string): Held {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      hold = { segment, reached, gate };
      return { reached: arrived, release };
    },
  };
}

/**
 * A store over a gated driver, with `IDS` at generation 0 of `REF`, and `extra` loaded at the next generations. No
 * timed refresh (`cache.genTtlMs: 0`), so a reader keeps no chunks of its own and every chunk read is a range request.
 */
async function world(extra: ReadonlyArray<readonly number[]> = []) {
  const backend = new MemoryStorage();
  const gated = gatedStorage(backend.storage);
  const { registry } = backend;
  await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, IDS, { registry });
  for (const [i, ids] of extra.entries()) {
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: i + 1 }, ids, {
      registry,
    });
  }
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: gated.storage, registry }),
    cache: { genTtlMs: 0 },
  });
  const seg = store.segment('s', { namespace: NS });
  return { backend, gated, store, seg };
}

const PAST = Date.parse('2020-01-01T00:00:00Z');

describe('an invalidation reaches a pinned read in flight', () => {
  it('control: with no read in flight, an erasure leaves a pin failing, not answering from memory', async () => {
    const { store, seg } = await world();
    const pin = await seg.pin();
    expect(await pin.has(ERASED)).toBe(true); // its chunk is now cached under the pin's key

    const ledger = await store.eraseSubject(ERASED, { namespace: NS });
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });

    await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a pinned has() whose request was in flight during an erasure does not cache what it read', async () => {
    const { gated, store, seg } = await world();
    const pin = await seg.pin();

    const held = gated.holdNextRange('s');
    const inflight = pin.has(ERASED);
    await held.reached;
    const ledger = await store.eraseSubject(ERASED, { namespace: NS });
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
    expect(await seg.has(ERASED)).toBe(false);
    held.release();
    await expect(inflight).rejects.toBeInstanceOf(NotFoundError);

    await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a pinned iterate() whose stream was in flight during an erasure does not cache what it read', async () => {
    const { gated, store, seg } = await world();
    const pin = await seg.pin();

    const held = gated.holdNextRange('s');
    const it = pin.iterate()[Symbol.asyncIterator]();
    const first = it.next();
    await held.reached;
    const ledger = await store.eraseSubject(HIGH, { namespace: NS });
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });
    held.release();
    await expect(first).rejects.toBeInstanceOf(NotFoundError);

    await expect(pin.has(HIGH)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a combine with a pinned operand, in flight during an erasure, does not cache what it read of the pin', async () => {
    const { backend, gated, store, seg } = await world();
    await bulkLoadCrbmGeneration(
      backend.storage,
      { namespace: NS, segment: 'o', generation: 0 },
      [ERASED, 5 * C],
      { registry: backend.registry },
    );
    const other = store.segment('o', { namespace: NS });
    const pin = await seg.pin();

    const held = gated.holdNextRange('s');
    const it = other.intersect([pin])[Symbol.asyncIterator]();
    const first = it.next();
    await held.reached;
    await store.eraseSubject(ERASED, { namespace: NS });
    held.release();
    await expect(first).rejects.toBeInstanceOf(NotFoundError);

    await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * Each path that invalidates the segment, with a pinned `has()` held in flight across it. `expect` is what the held
   * read and the next pinned read do: read the pinned object again (it is still there), or fail because it is gone.
   * Either way the next read is not answered from memory: one that answers must have reached storage.
   */
  type World = Awaited<ReturnType<typeof world>>;
  const VERBS: ReadonlyArray<{
    name: string;
    /** Generations loaded above `IDS` before the pin is taken: the pin holds the newest. */
    extra?: ReadonlyArray<readonly number[]>;
    /** Runs before the pin is taken. */
    prepare?(w: World): Promise<unknown>;
    run(w: World): Promise<unknown>;
    expect: 'reads again' | 'NotFoundError';
  }> = [
    {
      name: 'invalidate',
      run: ({ store }) => Promise.resolve(store.invalidate(REF)),
      expect: 'reads again',
    },
    {
      name: 'load, with keep: 0',
      run: ({ store }) => store.load(REF, [1, 2, 3], { keep: 0 }),
      expect: 'NotFoundError',
    },
    {
      name: 'load, keeping the pinned generation',
      run: ({ store }) => store.load(REF, [1, 2, 3]),
      expect: 'reads again',
    },
    {
      name: 'rollback',
      extra: [IDS],
      run: ({ store }) => store.rollback(REF, 0),
      expect: 'reads again',
    },
    {
      name: 'dropSegment',
      run: ({ store }) => store.dropSegment(REF, { confirmSegment: 's' }),
      expect: 'NotFoundError',
    },
    {
      name: 'retireExpired',
      prepare: ({ backend }) =>
        setSegmentRetention(REF, { registry: backend.registry }, { expiresAt: PAST }),
      run: ({ store }) => store.retireExpired({ now: PAST + 1 }),
      expect: 'NotFoundError',
    },
    {
      name: 'an intersectInto the segment',
      prepare: ({ backend }) =>
        bulkLoadCrbmGeneration(
          backend.storage,
          { namespace: NS, segment: 'src', generation: 0 },
          [1, 2],
          { registry: backend.registry },
        ),
      run: ({ store, seg }) => store.segment('src', { namespace: NS }).intersectInto(seg, []),
      expect: 'reads again',
    },
    {
      name: "subjectReport, finding the row moved under the store's view",
      // A live read first, so the store holds a view of generation 0 for the report to find out of date.
      prepare: ({ seg }) => seg.has(1),
      run: async ({ backend, store }) => {
        await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 1 }, [1, 2, 3], {
          registry: backend.registry,
        });
        await store.subjectReport(1, { namespace: NS });
      },
      expect: 'reads again',
    },
  ];

  for (const verb of VERBS) {
    it(`${verb.name}: the next pinned read is not answered from memory`, async () => {
      const w = await world(verb.extra);
      const { gated, seg } = w;
      await verb.prepare?.(w);
      const pin: Segment = await seg.pin();

      const held = gated.holdNextRange('s');
      const inflight = pin.has(ERASED);
      await held.reached;
      await verb.run(w);
      held.release();
      if (verb.expect === 'NotFoundError') {
        await expect(inflight).rejects.toBeInstanceOf(NotFoundError);
      } else {
        expect(await inflight).toBe(true);
      }

      const before = gated.reads();
      if (verb.expect === 'NotFoundError') {
        await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
      } else {
        expect(await pin.has(ERASED)).toBe(true);
        expect(gated.reads()).toBeGreaterThan(before);
      }
    });
  }
});
