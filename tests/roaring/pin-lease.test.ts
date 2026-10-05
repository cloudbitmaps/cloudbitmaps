import {
  CloudRoaring,
  LEASE_SKEW_MS,
  LeaseExpiredError,
  LeaseLimitError,
  MAX_LEASE_MS,
  MAX_LEASES_PER_SEGMENT,
  MemoryStorage,
  NotFoundError,
  UnsupportedError,
  ValidationError,
  isLeaseExpiredError,
  type Segment,
  type SegmentRef,
} from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { MemoryStorageDriver } from '@/drivers/memory';
import { counting } from '../helpers/counting';
import { collect } from '../helpers/loaded';

/**
 * A pinned handle with a lease: it holds its generation out of a load's collection until the lease ends, and a read of
 * it after that throws at every site, never empty. Two stores share one backend, as a refresh job and the tasks of a
 * send do, so a load never invalidates the pin and it is the lease that holds the generation.
 */

const HOUR = 3_600_000;
const T0 = 2_000_000_000_000;
const REF: SegmentRef = { namespace: 'ns', segment: 'audience' };
const OTHER: SegmentRef = { namespace: 'ns', segment: 'other' };
const THIRD: SegmentRef = { namespace: 'ns', segment: 'third' };
const SMALL = Array.from({ length: 200 }, (_, i) => i);

/** Ids in `chunks` different chunks, three each. */
const spread = (chunks: number): number[] =>
  Array.from({ length: chunks * 3 }, (_, i) => Math.floor(i / 3) * 65_536 + (i % 3));

function harness() {
  const state = { t: T0 };
  const clock = { now: () => state.t, sleep: () => Promise.resolve() };
  let n = 7;
  const rng = {
    next: () => {
      n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
      return n / 2_147_483_648;
    },
  };
  const memory = new MemoryStorage();
  const storageCalls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const readerBackend = brandAsBackend({
    storage: counting<IStorageDriver>(memory.storage, storageCalls),
    registry: counting<IRegistryDriver>(memory.registry, registryCalls),
  });
  const make = (storage: MemoryStorage | typeof readerBackend) =>
    new CloudRoaring({ storage, seams: { clock, rng }, cache: { genTtlMs: 0 } });
  return {
    state,
    memory,
    storageCalls,
    registryCalls,
    writer: make(memory),
    reader: make(readerBackend),
    advance: (ms: number) => (state.t += ms),
    reset: () => {
      for (const c of [storageCalls, registryCalls]) for (const k of Object.keys(c)) delete c[k];
    },
  };
}
type H = ReturnType<typeof harness>;

async function seeded(ids = SMALL, h = harness()) {
  await h.writer.load(REF, ids);
  await h.writer.load(OTHER, ids);
  await h.writer.load(THIRD, ids);
  return h;
}

/** Load `count` larger generations of REF from the writer's store, at `keep`. */
async function churn(h: H, count: number, keep?: number): Promise<void> {
  const have = (await h.memory.registry.get(REF))!.currentGen as number;
  for (let g = have + 1; g <= have + count; g++) {
    const r = await h.writer.load(
      REF,
      Array.from({ length: 200 + g }, (_, i) => i),
      keep === undefined ? {} : { keep },
    );
    expect(r.published).toBe(true);
  }
}

const generationsOf = async (h: H): Promise<number[]> => {
  const out: number[] = [];
  for await (const k of h.memory.storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
};

const lease = (h: H, ms = 72 * HOUR) =>
  h.reader.segment(REF.segment, { namespace: 'ns' }).pin({ leaseUntil: h.state.t + ms });
const plain = (h: H, ref = OTHER) => h.reader.segment(ref.segment, { namespace: ref.namespace });

describe('pin({ leaseUntil }): the call', () => {
  it('records one entry for the holder, and reports it on the handle', async () => {
    const h = await seeded();
    const until = h.state.t + 5 * HOUR;
    const snap = await h.reader
      .segment(REF.segment, { namespace: 'ns' })
      .pin({ leaseUntil: until });
    expect(snap.lease).toMatchObject({ until });
    expect(snap.lease?.holder).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.isFrozen(snap.lease)).toBe(true);
    const row = (await h.memory.registry.get(REF))!;
    expect(row.leases).toEqual([{ holder: snap.lease?.holder, generation: 0, until }]);
    expect(snap.pinnedAt?.generation).toBe(0);
    expect(await snap.count()).toBe(200);
    expect(plain(h).lease).toBeUndefined();
    expect((await plain(h).pin()).lease).toBeUndefined();
  });

  it('two pins hold two entries with two holders', async () => {
    const h = await seeded();
    const a = await lease(h);
    const b = await lease(h);
    expect(a.lease?.holder).not.toBe(b.lease?.holder);
    expect((await h.memory.registry.get(REF))!.leases).toHaveLength(2);
  });

  it('costs one row read, one write and one tail read; an unleased pin costs the read and the tail read', async () => {
    const h = await seeded();
    h.reset();
    await plain(h, REF).pin();
    expect(h.registryCalls).toMatchObject({ get: 1 });
    expect(h.registryCalls.compareAndSwap).toBeUndefined();
    expect(h.storageCalls.getTail).toBe(1);
    h.reset();
    await lease(h);
    expect(h.registryCalls.get).toBe(1);
    expect(h.registryCalls.compareAndSwap).toBe(1);
    // The version names the row the write made, so this open is not the earlier pin's shared one.
    expect(h.storageCalls.getTail).toBe(1);
  });

  it('takes the lease before it opens the object: the write precedes the tail read', async () => {
    const h = await seeded();
    const order: string[] = [];
    const reg = h.memory.registry;
    const real = reg.compareAndSwap.bind(reg);
    reg.compareAndSwap = ((...a: Parameters<typeof real>) => {
      order.push('lease');
      return real(...a);
    }) as typeof reg.compareAndSwap;
    const st = h.memory.storage;
    const tail = st.getTail.bind(st);
    st.getTail = ((...a: Parameters<typeof tail>) => {
      order.push('open');
      return tail(...a);
    }) as typeof st.getTail;
    await lease(h);
    expect(order).toEqual(['lease', 'open']);
  });

  it.each([
    ['an unknown key', { leaseUntil: T0 + HOUR, ttl: 5 }, /unknown option "ttl"/],
    ['a string', { leaseUntil: String(T0 + HOUR) }, /integer epoch-MILLISECONDS/],
    ['a fraction', { leaseUntil: T0 + 1.5 }, /integer/],
    ['NaN', { leaseUntil: Number.NaN }, /integer/],
    ['now', { leaseUntil: T0 }, /not after now/],
    ['epoch seconds', { leaseUntil: Math.floor(T0 / 1000) + 3600 }, /MILLISECONDS/],
    ['past the longest lease', { leaseUntil: T0 + MAX_LEASE_MS + 1 }, /14 days/],
  ])('refuses %s before any request', async (_name, options, message) => {
    const h = await seeded();
    h.reset();
    await expect(
      h.reader.segment(REF.segment, { namespace: 'ns' }).pin(options as { leaseUntil: number }),
    ).rejects.toThrow(message);
    await expect(
      h.reader.segment(REF.segment, { namespace: 'ns' }).pin(options as { leaseUntil: number }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(h.registryCalls).toEqual({});
    expect(h.storageCalls).toEqual({});
  });

  it('accepts exactly the longest lease', async () => {
    const h = await seeded();
    const snap = await h.reader
      .segment(REF.segment, { namespace: 'ns' })
      .pin({ leaseUntil: h.state.t + MAX_LEASE_MS });
    expect(snap.lease?.until).toBe(T0 + MAX_LEASE_MS);
  });

  it('refuses a lease that outlasts the handle own deadline, and a non-object option', async () => {
    const h = await seeded();
    const seg = h.reader.segment(REF.segment, { namespace: 'ns', expiresAt: T0 + HOUR });
    await expect(seg.pin({ leaseUntil: T0 + 2 * HOUR })).rejects.toThrow(/expiresAt/);
    await expect(seg.pin({ leaseUntil: T0 + HOUR })).resolves.toBeDefined();
    await expect(
      h.reader
        .segment(REF.segment, { namespace: 'ns' })
        .pin(5 as unknown as { leaseUntil: number }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(plain(h, REF).pin({})).resolves.toBeDefined();
    await expect(plain(h, REF).pin(undefined)).resolves.toBeDefined();
  });

  it('needs a registry, and a segment that has a generation', async () => {
    const bare = new CloudRoaring({ storage: new MemoryStorageDriver() });
    await expect(bare.segment('s').pin({ leaseUntil: Date.now() + HOUR })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    const h = harness();
    const err = await h.reader
      .segment('nothing-here')
      .pin({ leaseUntil: h.state.t + HOUR })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(await h.memory.registry.get({ segment: 'nothing-here' })).toBeNull();
  });

  it('the 65th live lease throws LeaseLimitError and writes nothing; one that ended makes room', async () => {
    const h = await seeded();
    for (let i = 0; i < MAX_LEASES_PER_SEGMENT; i++) await lease(h, HOUR);
    const before = (await h.memory.registry.get(REF))!;
    await expect(lease(h)).rejects.toBeInstanceOf(LeaseLimitError);
    expect((await h.memory.registry.get(REF))!.token).toBe(before.token);
    h.advance(HOUR + LEASE_SKEW_MS);
    await expect(lease(h)).resolves.toBeDefined();
    expect((await h.memory.registry.get(REF))!.leases).toHaveLength(1);
  });

  it('a failed open releases the lease it took', async () => {
    const h = await seeded();
    const st = h.memory.storage;
    const tail = st.getTail.bind(st);
    st.getTail = (() => Promise.reject(new Error('disk on fire'))) as typeof st.getTail;
    await expect(lease(h)).rejects.toThrow('disk on fire');
    st.getTail = tail;
    expect((await h.memory.registry.get(REF))!.leases).toBeUndefined();
  });
});

/** Every way a handle is read, as an operand, an exclude, a receiver and an `*Into` of a combine. */
const SITES: Array<[string, (leased: Segment, h: H) => Promise<unknown>]> = [
  ['has', (l) => l.has(1)],
  ['count', (l) => l.count()],
  ['stat', (l) => l.stat()],
  ['iterate', (l) => collect(l.iterate())],
  ['iterate().batches()', async (l) => collect(flat(l.iterate().batches()))],
  ['everyNth', (l) => collect(l.everyNth(1))],
  ['costReport', (l) => l.costReport()],
  ['pin()', (l) => l.pin()],
  ['intersect (receiver)', (l, h) => collect(l.intersect([plain(h)]))],
  ['intersect (operand)', (l, h) => collect(plain(h).intersect([l]))],
  [
    'intersect (exclude)',
    (l, h) => collect(plain(h).intersect([plain(h, THIRD)], { exclude: [l] })),
  ],
  ['union (receiver)', (l, h) => collect(l.union([plain(h)]))],
  ['union (operand)', (l, h) => collect(plain(h).union([l]))],
  ['union (exclude)', (l, h) => collect(plain(h).union([plain(h, THIRD)], { exclude: [l] }))],
  ['union of nothing but an exclude', (l, h) => collect(plain(h).union([], { exclude: [l] }))],
  ['andNot (receiver)', (l, h) => collect(l.andNot([plain(h)]))],
  ['andNot (exclude)', (l, h) => collect(plain(h).andNot([l]))],
  ['intersect batches (operand)', async (l, h) => collect(flat(plain(h).intersect([l]).batches()))],
  ['intersectInto (receiver)', (l, h) => l.intersectInto(dest(h), [plain(h)])],
  ['intersectInto (operand)', (l, h) => plain(h).intersectInto(dest(h), [l])],
  [
    'intersectInto (exclude)',
    (l, h) => plain(h).intersectInto(dest(h), [plain(h, THIRD)], { exclude: [l] }),
  ],
  ['intersectInto (dest)', (l, h) => plain(h).intersectInto(l, [plain(h, THIRD)])],
  ['unionInto (operand)', (l, h) => plain(h).unionInto(dest(h), [l])],
  ['andNotInto (exclude)', (l, h) => plain(h).andNotInto(dest(h), [l])],
];

const dest = (h: H): Segment => h.reader.segment('dest', { namespace: 'ns' });
async function* flat(batches: AsyncIterable<Uint32Array>): AsyncGenerator<number> {
  for await (const b of batches) yield* b;
}

describe('every read site of a leased handle', () => {
  it.each(SITES)('%s answers while the lease is live', async (_name, run) => {
    const h = await seeded();
    const snap = await lease(h);
    await run(snap, h);
  });

  it.each(SITES)(
    '%s throws LeaseExpiredError once the lease has ended, and reads nothing',
    async (_name, run) => {
      const h = await seeded();
      const snap = await lease(h, HOUR);
      h.advance(HOUR);
      h.reset();
      const err = await run(snap, h).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isLeaseExpiredError(err)).toBe(true);
      expect(err).toBeInstanceOf(LeaseExpiredError);
      expect((err as LeaseExpiredError).reason).toBe('expired');
      expect((err as LeaseExpiredError).until).toBe(T0 + HOUR);
      expect(h.storageCalls.getRange ?? 0).toBe(0);
    },
  );

  it.each(SITES)('%s throws with reason released after release()', async (_name, run) => {
    const h = await seeded();
    const snap = await lease(h);
    await snap.release();
    const err = await run(snap, h).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as LeaseExpiredError).reason).toBe('released');
  });

  it('a live lease reads as the plain pin does: a leased exclude subtracts, a leased operand intersects', async () => {
    const h = await seeded();
    await h.writer.load(REF, [0, 1, 2, 3, 4]);
    const small = await lease(h);
    expect(await collect(plain(h, THIRD).andNot([small]))).toEqual(SMALL.slice(5));
    expect(await collect(plain(h, THIRD).intersect([small]))).toEqual([0, 1, 2, 3, 4]);
    expect(await collect(plain(h, THIRD).intersect([plain(h)], { exclude: [small] }))).toEqual(
      SMALL.slice(5),
    );
    expect(await collect(plain(h, THIRD).union([small], { exclude: [small] }))).toEqual(
      SMALL.slice(5),
    );
  });

  it('the boundary is the instant: one millisecond short reads, the instant throws', async () => {
    const h = await seeded();
    const snap = await lease(h, HOUR);
    h.advance(HOUR - 1);
    await expect(snap.count()).resolves.toBe(200);
    h.advance(1);
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('a leased exclude past its lease is never skipped, even when another handle has expired by expiresAt', async () => {
    const h = await seeded();
    const optOut = await lease(h, HOUR);
    h.advance(HOUR);
    const gone = h.reader.segment(OTHER.segment, { namespace: 'ns', expiresAt: T0 + 1 });
    const err = await collect(gone.intersect([plain(h, REF)], { exclude: [optOut] })).catch(
      (e: unknown) => e,
    );
    expect(isLeaseExpiredError(err)).toBe(true);
    const err2 = await collect(plain(h, REF).intersect([gone], { exclude: [optOut] })).catch(
      (e: unknown) => e,
    );
    expect(isLeaseExpiredError(err2)).toBe(true);
  });

  it('a lease that outlives a small generation cached reader still throws: it never answers from the cache', async () => {
    const h = await seeded();
    const snap = await lease(h, HOUR);
    await expect(snap.count()).resolves.toBe(200);
    await expect(snap.has(5)).resolves.toBe(true);
    h.advance(HOUR + 1);
    await expect(snap.has(5)).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(collect(snap.iterate())).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('expiresAt is unchanged: an expired unleased handle reads empty, and an expired exclude is refused', async () => {
    const h = await seeded();
    const expired = h.reader.segment(OTHER.segment, { namespace: 'ns', expiresAt: T0 + 1 });
    h.advance(10);
    expect(await expired.count()).toBe(0);
    // An expired exclusion is a lapsed suppression list: refused with a ValidationError, never dropped.
    await expect(collect(plain(h, REF).andNot([expired]))).rejects.toBeInstanceOf(ValidationError);
    await expect(collect(plain(h, REF).andNot([expired]))).rejects.toThrow(
      /exclusions have expired/,
    );
  });

  it('a leased exclude that is past its lease and past its expiresAt throws LeaseExpiredError: the lease is checked first', async () => {
    const h = await seeded();
    const seg = h.reader.segment(REF.segment, { namespace: 'ns', expiresAt: T0 + 2 * HOUR });
    const optOut = await seg.pin({ leaseUntil: T0 + HOUR });
    h.advance(3 * HOUR); // past the lease and past expiresAt
    const live = plain(h, THIRD);
    for (const read of [
      collect(live.andNot([optOut])),
      collect(live.intersect([plain(h)], { exclude: [optOut] })),
      collect(live.union([plain(h)], { exclude: [optOut] })),
    ]) {
      await expect(read).rejects.toBeInstanceOf(LeaseExpiredError);
    }
    // An unleased handle past its expiresAt, in the same position, is the expired-exclusion rule's.
    const plainExpired = h.reader.segment(OTHER.segment, { namespace: 'ns', expiresAt: T0 + HOUR });
    await expect(collect(live.andNot([plainExpired]))).rejects.toBeInstanceOf(ValidationError);
  });

  it('a leased exclude past its lease throws LeaseExpiredError, in every combine, whatever the other handles are', async () => {
    const h = await seeded();
    const optOut = await lease(h, HOUR);
    h.advance(HOUR);
    const live = plain(h, THIRD);
    const reads = [
      collect(live.intersect([plain(h)], { exclude: [optOut] })),
      collect(live.union([plain(h)], { exclude: [optOut] })),
      collect(live.andNot([optOut])),
    ];
    for (const r of reads) await expect(r).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('a handle with both a lease and an expiresAt throws once the lease is past, and still when expiresAt is too', async () => {
    const h = await seeded();
    const seg = h.reader.segment(REF.segment, { namespace: 'ns', expiresAt: T0 + 2 * HOUR });
    const snap = await seg.pin({ leaseUntil: T0 + HOUR });
    h.advance(HOUR + HOUR / 2); // the lease is past, expiresAt is not
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
    h.advance(HOUR); // both are past: the lease still wins, nothing reads empty
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('pin() from a leased handle past its lease throws; before it, it returns an unleased pin and writes nothing', async () => {
    const h = await seeded();
    const snap = await lease(h, HOUR);
    h.reset();
    const again = await snap.pin();
    expect(again.lease).toBeUndefined();
    expect(h.registryCalls.compareAndSwap).toBeUndefined();
    h.advance(HOUR);
    await expect(snap.pin()).rejects.toBeInstanceOf(LeaseExpiredError);
  });
});

describe('a stream checks the lease each time it reads a chunk', () => {
  const ids = spread(4); // chunks 0..3, three ids each

  it('ids: the chunk already being read finishes, and the next chunk throws', async () => {
    const h = await seeded(ids);
    const snap = await lease(h, HOUR);
    const it = snap.iterate()[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(0);
    h.advance(HOUR); // the lease ends between two pulls
    expect((await it.next()).value).toBe(1);
    expect((await it.next()).value).toBe(2);
    await expect(it.next()).rejects.toBeInstanceOf(LeaseExpiredError); // the first id of chunk 1
  });

  it('batches: the next batch throws', async () => {
    const h = await seeded(ids);
    const snap = await lease(h, HOUR);
    const it = snap.iterate().batches()[Symbol.asyncIterator]();
    expect(Array.from((await it.next()).value as Uint32Array)).toEqual([0, 1, 2]);
    h.advance(HOUR);
    await expect(it.next()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('a combine with a leased operand throws at the next chunk, per id and per batch', async () => {
    const h = await seeded(ids);
    const snap = await lease(h, HOUR);
    const perId = plain(h, OTHER).intersect([snap])[Symbol.asyncIterator]();
    expect((await perId.next()).value).toBe(0);
    const perBatch = plain(h, OTHER).intersect([snap]).batches()[Symbol.asyncIterator]();
    expect((await perBatch.next()).done).toBe(false);
    h.advance(HOUR);
    await expect(
      (async () => {
        for (;;) if ((await perId.next()).done === true) return;
      })(),
    ).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(perBatch.next()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('breaking out of a leased stream still ends the engine reads', async () => {
    const h = await seeded(ids);
    const snap = await lease(h, HOUR);
    for await (const id of snap.iterate()) {
      expect(id).toBe(0);
      break;
    }
    await expect(snap.count()).resolves.toBe(ids.length);
  });

  it('an unleased stream is the engine stream, untouched', async () => {
    const h = await seeded(ids);
    const s = plain(h, REF).iterate();
    expect(Object.getPrototypeOf(s)).not.toBe(Object.prototype);
  });

  it('an *Into that reads a leased operand fails when the lease ends, and leaves its destination as it was', async () => {
    const h = await seeded(spread(2000));
    await h.writer.load({ namespace: 'ns', segment: 'dest' }, [9]);
    const snap = await lease(h, HOUR);
    const real = h.memory.storage.getRange.bind(h.memory.storage);
    let reads = 0;
    h.memory.storage.getRange = ((...a: Parameters<typeof real>) => {
      reads += 1;
      if (reads === 2) h.advance(HOUR);
      return real(...a);
    }) as typeof h.memory.storage.getRange;
    const err = await plain(h, OTHER)
      .intersectInto(dest(h), [snap])
      .catch((e: unknown) => e);
    h.memory.storage.getRange = real;
    expect(reads).toBeGreaterThan(1);
    expect(isLeaseExpiredError(err)).toBe(true);
    expect(await dest(h).count()).toBe(1);
  });
});

describe('a stream built while the lease is live and pulled after it ended never ends empty', () => {
  // Chunk 0 and chunk 1 share no id, so the combines below have no result: nothing would reach a per-chunk check.
  const zero = [0, 1, 2];
  const one = [65_536, 65_537];

  async function setup() {
    const h = harness();
    await h.writer.load(REF, zero);
    await h.writer.load(OTHER, one);
    await h.writer.load({ namespace: 'ns', segment: 'dest' }, [9]);
    return h;
  }

  it('everyNth: a stream built live and pulled after the lease throws, even with no rank in its range', async () => {
    const h = await setup();
    const snap = await lease(h, 1_000);
    const empty = snap.everyNth(1_000_000); // no window of a million ids: nothing to yield
    const some = snap.everyNth(1);
    h.advance(1_000);
    await expect(collect(empty)).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(collect(some)).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(collect(snap.everyNth(1))).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('everyNth: a handle past its lease and its expiresAt throws, and does not read empty', async () => {
    const h = await setup();
    const seg = h.reader.segment(REF.segment, { namespace: 'ns', expiresAt: T0 + 2_000 });
    const snap = await seg.pin({ leaseUntil: T0 + 1_000 });
    h.advance(3_000);
    await expect(collect(snap.everyNth(1))).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('everyNth: a lease that ends mid-stream throws at the next chunk', async () => {
    const h = await seeded(spread(4));
    const snap = await lease(h, HOUR);
    const it = snap.everyNth(3)[Symbol.asyncIterator](); // the third id of each chunk of three
    expect((await it.next()).value).toBe(2);
    h.advance(HOUR);
    await expect(it.next()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('a stream object built live and consumed late throws on its first pull', async () => {
    const h = await setup();
    const snap = await lease(h, 1_000);
    const other = plain(h, OTHER);
    const streams = [
      snap.intersect([other]),
      snap.andNot([snap]),
      other.intersect([snap]),
      snap.iterate({ after: 1_000_000 }),
    ];
    const batched = [snap.intersect([other]).batches(), snap.andNot([snap]).batches()];
    h.advance(1_000);
    for (const s of streams) await expect(collect(s)).rejects.toBeInstanceOf(LeaseExpiredError);
    for (const b of batched)
      await expect(collect(flat(b))).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('an *Into whose lease ends before its first chunk fails, and never publishes an empty generation', async () => {
    const h = await setup();
    const snap = await lease(h, 1_000);
    const reg = h.memory.registry;
    const real = reg.get.bind(reg);
    let armed = true;
    reg.get = ((...a: Parameters<typeof real>) => {
      if (armed) {
        armed = false;
        h.advance(1_000); // the lease ends after the call's own checks, before its first pull
      }
      return real(...a);
    }) as typeof reg.get;
    const err = await plain(h, OTHER)
      .intersectInto(dest(h), [snap], { allowEmpty: true })
      .catch((e: unknown) => e);
    reg.get = real;
    expect(isLeaseExpiredError(err)).toBe(true);
    expect(await dest(h).count()).toBe(1);
  });
});

describe('pinAt(at, { leaseUntil })', () => {
  /** What an earlier pin recorded of REF's current generation, for a pinAt later. */
  async function recorded(h: H) {
    const first = await plain(h, REF).pin();
    const { generation, fingerprint } = first.pinnedAt as {
      generation: number;
      fingerprint: string;
    };
    return { generation, fingerprint };
  }
  const leasedAt = (h: H, at: { generation: number; fingerprint: string }, ms = 72 * HOUR) =>
    plain(h, REF).pinAt(at, { leaseUntil: h.state.t + ms });

  it('holds a past generation through later loads, and a read after the lease throws', async () => {
    const h = await seeded();
    const at = await recorded(h);
    await churn(h, 1); // generation 0 is the window's one kept generation
    const snap = await leasedAt(h, at);
    expect(snap.pinnedAt?.generation).toBe(0);
    expect(snap.lease?.holder).toMatch(/^[0-9a-f]{16}$/);
    expect((await h.memory.registry.get(REF))!.leases).toEqual([
      { holder: snap.lease?.holder, generation: 0, until: snap.lease?.until },
    ]);
    await churn(h, 40);
    expect(await generationsOf(h)).toContain(0);
    expect(await snap.count()).toBe(200);
    await snap.release();
    await churn(h, 16);
    expect(await generationsOf(h)).not.toContain(0);
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('costs one row read, one write and one tail read, the write before the tail read', async () => {
    const h = await seeded();
    const at = await recorded(h);
    h.reset();
    await leasedAt(h, at);
    expect(h.registryCalls.get).toBe(1);
    expect(h.registryCalls.compareAndSwap).toBe(1);
    expect(h.storageCalls.getTail).toBe(1);
  });

  it('a fingerprint that is not the object releases the lease it took, and throws NotFoundError', async () => {
    const h = await seeded();
    const at = await recorded(h);
    const err = await leasedAt(h, { generation: at.generation, fingerprint: '1:2' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect((await h.memory.registry.get(REF))!.leases).toBeUndefined();
  });

  it('a generation above the pointer is NotFoundError and writes no lease', async () => {
    const h = await seeded();
    const at = await recorded(h);
    const before = (await h.memory.registry.get(REF))!;
    await expect(
      leasedAt(h, { generation: 9, fingerprint: at.fingerprint }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await h.memory.registry.get(REF))!.token).toBe(before.token);
  });

  it('`at` still refuses an unknown key, leaseUntil among them; the options refuse unknown keys too', async () => {
    const h = await seeded();
    const at = await recorded(h);
    const seg = plain(h, REF);
    await expect(seg.pinAt({ ...at, leaseUntil: h.state.t + HOUR } as never)).rejects.toThrow(
      /unknown option "leaseUntil"/,
    );
    await expect(seg.pinAt(at, { leaseUntil: h.state.t + HOUR, ttl: 1 } as never)).rejects.toThrow(
      /unknown option "ttl"/,
    );
    await expect(seg.pinAt(at, { leaseUntil: h.state.t } as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(seg.pinAt(at, { leaseUntil: h.state.t + MAX_LEASE_MS + 1 })).rejects.toThrow(
      /14 days/,
    );
    await expect(seg.pinAt(at, {})).resolves.toBeDefined();
    await expect(seg.pinAt(at)).resolves.toBeDefined();
  });

  it('needs a registry', async () => {
    const bare = new CloudRoaring({ storage: new MemoryStorageDriver() });
    await expect(
      bare
        .segment('s')
        .pinAt({ generation: 0, fingerprint: '1:2' }, { leaseUntil: Date.now() + HOUR }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('pinAt from a leased handle past its lease throws', async () => {
    const h = await seeded();
    const at = await recorded(h);
    const snap = await leasedAt(h, at, HOUR);
    h.advance(HOUR);
    await expect(snap.pinAt(at)).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it.each(SITES)(
    '%s throws LeaseExpiredError on a pinAt handle past its lease',
    async (_name, run) => {
      const h = await seeded();
      const at = await recorded(h);
      const snap = await leasedAt(h, at, HOUR);
      h.advance(HOUR);
      const err = await run(snap, h).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isLeaseExpiredError(err)).toBe(true);
    },
  );
});

describe('release()', () => {
  it('removes the entry with one read and one write, and a second call makes no request', async () => {
    const h = await seeded();
    const snap = await lease(h);
    h.reset();
    await snap.release();
    expect(h.registryCalls.get).toBe(1);
    expect(h.registryCalls.compareAndSwap).toBe(1);
    expect((await h.memory.registry.get(REF))!.leases).toBeUndefined();
    h.reset();
    await snap.release();
    await snap.release();
    expect(h.registryCalls).toEqual({});
  });

  it('does nothing on a handle with no lease, and after the lease and margin have ended', async () => {
    const h = await seeded();
    h.reset();
    await plain(h, REF).release();
    const snap = await lease(h, HOUR);
    h.advance(HOUR + LEASE_SKEW_MS);
    h.reset();
    await snap.release();
    expect(h.registryCalls).toEqual({});
  });

  it('a failed release is thrown, the handle already throws on reads, and a second call tries again', async () => {
    const h = await seeded();
    const snap = await lease(h);
    const reg = h.memory.registry;
    const real = reg.compareAndSwap.bind(reg);
    reg.compareAndSwap = (() =>
      Promise.reject(new Error('registry down'))) as typeof reg.compareAndSwap;
    await expect(snap.release()).rejects.toThrow('registry down');
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
    reg.compareAndSwap = real;
    await snap.release();
    expect((await h.memory.registry.get(REF))!.leases).toBeUndefined();
  });
});

describe('the holder', () => {
  it('is 64 bits from the store rng, so two stores with different rngs never share one', async () => {
    const h = await seeded();
    const a = await lease(h);
    const other = new CloudRoaring({
      storage: h.memory,
      seams: {
        clock: { now: () => h.state.t, sleep: () => Promise.resolve() },
        rng: { next: () => 0.123456789 },
      },
      cache: { genTtlMs: 0 },
    });
    const b = await other
      .segment(REF.segment, { namespace: 'ns' })
      .pin({ leaseUntil: h.state.t + HOUR });
    expect(a.lease?.holder).not.toBe(b.lease?.holder);
    expect(b.lease?.holder).toMatch(/^[0-9a-f]{16}$/);
  });
});

/** The consumer's acceptance: a refresh job loads, the tasks of a send pin, and nothing but the lease holds the generation. */
describe('a leased generation survives later loads, collection resumes, and a read after it throws', () => {
  it.each([
    ['keep 1', 1],
    ['keep 12', 12],
  ])('survives 12 later loads at %s, and 100 more at the default', async (_name, keep) => {
    const h = await seeded(spread(300));
    const snap = await lease(h);
    const expected = spread(300);
    await churn(h, 12, keep);
    expect(await generationsOf(h)).toContain(0);
    expect(await snap.count()).toBe(expected.length);
    expect(await collect(snap.iterate())).toEqual(expected);
    await churn(h, 100);
    expect(await generationsOf(h)).toContain(0);
    expect(await collect(snap.iterate())).toEqual(expected);
    expect((await h.memory.registry.get(REF))!.currentGen).toBe(112);
  });

  it('a small pinned generation survives the same, and answers from its object, not from luck', async () => {
    const h = await seeded();
    const snap = await lease(h);
    await churn(h, 112, 1);
    expect(await generationsOf(h)).toContain(0);
    expect(await snap.count()).toBe(200);
  });

  it('collection resumes at the first listing after the lease and its margin: within 16 later loads', async () => {
    const h = await seeded();
    const snap = await lease(h, HOUR);
    await churn(h, 12);
    h.advance(HOUR + LEASE_SKEW_MS - 1);
    await churn(h, 4); // generation 16: a listing, one millisecond short of the end
    expect(await generationsOf(h)).toContain(0);
    h.advance(1);
    await churn(h, 15); // generations 17..31: no listing, so the ended lease still leaves it
    expect(await generationsOf(h)).toContain(0);
    await churn(h, 1); // generation 32: the listing takes it
    expect(await generationsOf(h)).not.toContain(0);
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('after the lease a read throws at every moment, whether the object is there or not, and never reads empty', async () => {
    const h = await seeded();
    const snap = await lease(h, HOUR);
    await churn(h, 5);
    h.advance(HOUR);
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError); // object still there
    await expect(collect(snap.iterate())).rejects.toBeInstanceOf(LeaseExpiredError);
    h.advance(LEASE_SKEW_MS);
    await churn(h, 40); // the object is gone now
    expect(await generationsOf(h)).not.toContain(0);
    await expect(snap.count()).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(snap.has(3)).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(collect(snap.iterate())).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('release() lets the next listing take the generation at once', async () => {
    const h = await seeded();
    const snap = await lease(h);
    await churn(h, 15);
    expect(await generationsOf(h)).toContain(0);
    await snap.release();
    await churn(h, 1); // generation 16
    expect(await generationsOf(h)).not.toContain(0);
  });

  it('two senders hold two generations; releasing one frees only its own', async () => {
    const h = await seeded();
    const a = await lease(h);
    await churn(h, 1);
    const b = await lease(h);
    await churn(h, 20);
    expect(await generationsOf(h)).toEqual(expect.arrayContaining([0, 1]));
    await a.release();
    await churn(h, 12); // through generation 32: the listing at 32
    const have = await generationsOf(h);
    expect(have).not.toContain(0);
    expect(have).toContain(1);
    expect(await b.count()).toBe(201);
  });
});
