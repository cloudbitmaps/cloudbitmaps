import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudRoaring, MemoryStorage, NotFoundError } from '@/index';
import type { SegmentRef } from '@/index';
import type { IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { brandAsBackend } from '@/core/ports';
import { MAX_RANGES_IN_FLIGHT } from '@/core/crbm/plan-reads';
import { DEFAULT_INTERSECT_CONCURRENCY } from '@/core/engine';
import { REMEMBERED_INVALIDATIONS } from '@/core/invalidation-scope';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * The privacy note and the erasure guide promise the same bound on what a read already in progress can still yield
 * after an erasure, and it is the code's.
 *
 * WHY THIS EXISTS. The promise is a compliance one: PRIVACY.md is what an auditor reads, and docs/guide/erasure.md is
 * what an operator follows. The two were written apart, and when the engine's read-ahead changed unit (chunk keys, then
 * ranges), the guide was brought to it and the note was not, which left a written promise that the code no longer
 * matched. Each states the bound in one sentence of one shape:
 *
 *   up to N chunks for `iterate` and `count`, and up to `concurrency` + 1 keys (M by default) for a combine
 *
 * and the gate reads that sentence out of each document, with its line breaks undone, and holds every copy to the
 * same N and M, and both to the library's own default windows (the engine's, and the chunk stream's, which must agree):
 * N is the window, and M is the window and the key a combine is handing out, which it can yield too.
 * `tests/core/stream-re-resolve.test.ts` counts both in a read past its ramp-up.
 *
 * KNOWN LIMIT. The gate reads the one sentence's numbers. It cannot tell that a paragraph around it contradicts it in
 * words, which is what the review of a change to this promise is for.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = ['PRIVACY.md', 'packages/roaring/PRIVACY.md', 'docs/guide/erasure.md'] as const;

const BOUND =
  /up to (\d+) chunks for `iterate` and `count`, and up to `concurrency` \+ 1 keys \((\d+) by default\) for a combine/g;

/** Every bound a text states, as `[iterate and count, combine default]`, with its line breaks undone. */
export function boundsIn(text: string): Array<[number, number]> {
  return [...text.replace(/\s+/g, ' ').matchAll(BOUND)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('the in-flight bound after an erasure', () => {
  it.each(DOCS)('%s states it once, and it is the library default window', (rel) => {
    const found = boundsIn(readFileSync(join(ROOT, rel), 'utf8'));
    expect(found, `${rel} must state the bound in the one sentence shape`).toHaveLength(1);
    // the iterate and count window, and the combine's default `concurrency` and the key in hand: the engine's window,
    // and the reader's own
    expect(found[0]).toEqual([DEFAULT_INTERSECT_CONCURRENCY, DEFAULT_INTERSECT_CONCURRENCY + 1]);
    expect(DEFAULT_INTERSECT_CONCURRENCY).toBe(MAX_RANGES_IN_FLIGHT);
  });

  it('is the same in every document that makes the promise', () => {
    const all = DOCS.map((rel) => JSON.stringify(boundsIn(readFileSync(join(ROOT, rel), 'utf8'))));
    expect(new Set(all).size).toBe(1);
  });

  it('notices a copy that changed its numbers or its words, and ignores look-alikes', () => {
    const sentence =
      'up to 32 chunks for `iterate` and `count`, and up to `concurrency` + 1\nkeys (33 by default) for a combine';
    expect(boundsIn(`A read ${sentence}.`)).toEqual([[32, 33]]);
    // a changed number is read as the changed number
    expect(boundsIn(sentence.replace('up to 32 chunks', 'up to 8 chunks'))).toEqual([[8, 33]]);
    expect(boundsIn(sentence.replace('(33 by default)', '(8 by default)'))).toEqual([[32, 8]]);
    // a reworded sentence is not the bound, so it is found missing rather than read as something else
    expect(boundsIn(sentence.replace('for a combine', 'for combines'))).toEqual([]);
    expect(boundsIn(sentence.replace('`iterate` and `count`', '`iterate`'))).toEqual([]);
    // the earlier wording, without the key in hand, is not the bound either
    expect(
      boundsIn(
        'up to 32 chunks for `iterate` and `count`, and up to `concurrency` keys (32 by default) for a combine',
      ),
    ).toEqual([]);
    // look-alikes elsewhere: a window of 32 chunk reads, a pointer refresh, a different bound
    expect(boundsIn('up to 32 chunks ahead of the writer, and up to 32 reads in flight')).toEqual(
      [],
    );
    expect(boundsIn('up to `concurrency` ranges per operand (32 by default)')).toEqual([]);
    expect(
      boundsIn('up to `concurrency` + 1 keys per operand (33 by default) for a combine'),
    ).toEqual([]);
  });
});

/**
 * The bound holds for a pinned read too. A pin never moves to another generation, so where a live read in progress
 * moves on, a pinned one, a pinned operand of a combine included, finds out at its next chunk whether its object is
 * still there, and fails with `NotFoundError` once the erasure has deleted it: what it can still yield after the
 * erasure is what it had already taken, within the same bound.
 *
 * The segment is 200 chunks of one id each, so the whole object is one range, and on a store with a timed refresh its
 * reader keeps every chunk: a pinned stream that did not look again would serve every remaining chunk, the erased id
 * among them, from memory.
 */
describe('a pinned read in progress after an erasure', () => {
  const NS = 'ns';
  const C = 65_536;
  const CHUNKS = 200;
  const REF: SegmentRef = { namespace: NS, segment: 's' };
  const IDS = Array.from({ length: CHUNKS }, (_, c) => c * C + 1);
  const ERASED = 150 * C + 1;

  /** A driver that counts its reads, and can hold the next range or tail read, once it has its bytes, until released. */
  function gated(inner: IStorageDriver) {
    let hold: { reached: () => void; gate: Promise<void> } | undefined;
    let holdTail: { reached: () => void; gate: Promise<void> } | undefined;
    const reads = { range: 0, tail: 0 };
    const storage: IStorageDriver = {
      capabilities: () => inner.capabilities(),
      getRange: async (key, offset, length) => {
        reads.range += 1;
        const bytes = await inner.getRange(key, offset, length);
        const h = hold;
        if (h !== undefined) {
          hold = undefined;
          h.reached();
          await h.gate;
        }
        return bytes;
      },
      getTail: async (key, maxBytes) => {
        reads.tail += 1;
        const read = await inner.getTail(key, maxBytes);
        const h = holdTail;
        if (h !== undefined) {
          holdTail = undefined;
          h.reached();
          await h.gate;
        }
        return read;
      },
      putImmutable: (key, write) => inner.putImmutable(key, write),
      list: (ref) => inner.list(ref),
      delete: (key, options) => inner.delete(key, options),
    };
    const holding = (set: (h: { reached: () => void; gate: Promise<void> }) => void) => {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      set({ reached, gate: new Promise<void>((resolve) => (release = resolve)) });
      return { arrived, release };
    };
    const holdNextRange = () => holding((h) => (hold = h));
    const holdNextTail = () => holding((h) => (holdTail = h));
    return { storage, holdNextRange, holdNextTail, reads };
  }

  /** `s` in the erasure's namespace, and a copy of it in another, which the erasure leaves alone. */
  async function world(genTtlMs: number | undefined, readerMax?: number) {
    const backend = new MemoryStorage();
    const { registry } = backend;
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, IDS, { registry });
    await bulkLoadCrbmGeneration(
      backend.storage,
      { namespace: 'elsewhere', segment: 'o', generation: 0 },
      IDS,
      { registry },
    );
    const g = gated(backend.storage);
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: g.storage, registry }),
      cache: {
        ...(genTtlMs === undefined ? {} : { genTtlMs }),
        ...(readerMax === undefined ? {} : { readerMax }),
      },
    });
    return { store, g, seg: store.segment('s', { namespace: NS }) };
  }

  /** Pull the rest of `it`: the ids it yields, and how it ended. */
  async function rest(it: AsyncIterator<number>): Promise<{ ids: number[]; error: unknown }> {
    const ids: number[] = [];
    try {
      for (let r = await it.next(); r.done !== true; r = await it.next()) ids.push(r.value);
    } catch (error) {
      return { ids, error };
    }
    return { ids, error: undefined };
  }

  const chunksOf = (ids: readonly number[]): number =>
    new Set(ids.map((id) => Math.floor(id / C))).size;

  const STORES = [
    ['a store with a timed refresh', undefined],
    ['a store with no timed refresh', 0],
  ] as const;

  it.each(STORES)(
    '%s: a pinned iterate() yields no more than the bound, then fails',
    async (_name, ttl) => {
      const { store, seg } = await world(ttl);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe(IDS[0]);
      expect((await store.eraseSubject(ERASED, { namespace: NS })).erasedFrom).toHaveLength(1);

      const after = await rest(it);
      expect(after.ids).not.toContain(ERASED);
      expect(chunksOf(after.ids)).toBeLessThanOrEqual(DEFAULT_INTERSECT_CONCURRENCY);
      expect(after.error).toBeInstanceOf(NotFoundError);
    },
  );

  it.each(STORES)(
    '%s: a combine with a pinned operand yields no more than the bound, then fails',
    async (_name, ttl) => {
      const { store, seg } = await world(ttl);
      const other = store.segment('o', { namespace: 'elsewhere' });
      const pin = await seg.pin();
      const it = other.intersect([pin])[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe(IDS[0]);
      expect((await store.eraseSubject(ERASED, { namespace: NS })).erasedFrom).toHaveLength(1);

      const after = await rest(it);
      expect(after.ids).not.toContain(ERASED);
      expect(chunksOf(after.ids)).toBeLessThanOrEqual(DEFAULT_INTERSECT_CONCURRENCY + 1);
      expect(after.error).toBeInstanceOf(NotFoundError);
    },
  );

  it('a pinned has() in flight meets the erasure before it answers, and fails as the next one does', async () => {
    const { store, g, seg } = await world(0); // no timed refresh: the reader keeps no chunks, so the read is a request
    const pin = await seg.pin();
    const held = g.holdNextRange();
    const inflight = pin.has(ERASED);
    await held.arrived;
    await store.eraseSubject(ERASED, { namespace: NS });
    held.release();
    await expect(inflight).rejects.toBeInstanceOf(NotFoundError);

    await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a pinned has() whose reader kept every chunk fails after the erasure', async () => {
    const { store, seg } = await world(undefined);
    const pin = await seg.pin();
    expect(await pin.has(ERASED)).toBe(true);
    await store.eraseSubject(ERASED, { namespace: NS });

    await expect(pin.has(ERASED)).rejects.toBeInstanceOf(NotFoundError);
    await expect(pin.has(IDS[1]!)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(STORES)(
    '%s: an invalidation that leaves the object in place lets a pinned read carry on with the ranges it holds',
    async (_name, ttl) => {
      const { store, g, seg } = await world(ttl);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe(IDS[0]);
      const before = { ...g.reads };
      store.invalidate(REF);

      const after = await rest(it);
      expect(after.error).toBeUndefined();
      expect(after.ids).toEqual(IDS.slice(1));
      expect(g.reads.range).toBe(before.range); // nothing it held is read again
      expect(g.reads.tail).toBe(before.tail + 1); // the one open that finds the object still there
    },
  );

  it.each(STORES)(
    "%s: another segment's invalidation costs a pinned read no request",
    async (_name, ttl) => {
      const { store, g, seg } = await world(ttl);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      await it.next();
      const before = { ...g.reads };
      store.invalidate({ namespace: NS, segment: 'unrelated' });

      const after = await rest(it);
      expect(after.ids).toEqual(IDS.slice(1));
      expect(g.reads).toEqual(before);
    },
  );

  it.each(STORES)(
    "%s: another segment's invalidation costs a pinned read no request once its reader has left the reader cache",
    async (_name, ttl) => {
      const { store, g, seg } = await world(ttl, 1);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      await it.next();
      // The reader cache holds one reader, so reading another segment lets the pin's go.
      expect(await store.segment('o', { namespace: 'elsewhere' }).has(IDS[0]!)).toBe(true);
      const before = { ...g.reads };
      store.invalidate({ namespace: NS, segment: 'unrelated' });

      const after = await rest(it);
      expect(after.ids).toEqual(IDS.slice(1));
      expect(g.reads).toEqual(before);
    },
  );

  it.each(STORES)(
    '%s: past 1,024 other segments invalidated, a pinned read whose reader has gone opens its object once',
    async (_name, ttl) => {
      const { store, g, seg } = await world(ttl, 1);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      await it.next();
      expect(await store.segment('o', { namespace: 'elsewhere' }).has(IDS[0]!)).toBe(true);
      const before = { ...g.reads };
      for (let i = 0; i <= REMEMBERED_INVALIDATIONS; i++) {
        store.invalidate({ namespace: NS, segment: `other${i}` });
      }

      const after = await rest(it);
      expect(after.ids).toEqual(IDS.slice(1));
      expect(g.reads).toEqual({ range: before.range, tail: before.tail + 1 });
    },
  );

  it.each(STORES)(
    '%s: an open that finds the object still there, overtaken by the erasure, still ends in NotFoundError',
    async (_name, ttl) => {
      const { store, g, seg } = await world(ttl);
      const pin = await seg.pin();
      const it = pin.iterate()[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe(IDS[0]);
      // An invalidation that leaves the object: the stream's next chunk opens it again, and that open is held after
      // its tail read has found the object, while the erasure deletes it and invalidates the segment once more.
      store.invalidate(REF);
      const held = g.holdNextTail();
      const next = it.next();
      await held.arrived;
      expect((await store.eraseSubject(ERASED, { namespace: NS })).erasedFrom).toHaveLength(1);
      held.release();

      const ids: number[] = [];
      const first = await next.then(
        (r) => r,
        (error: unknown) => ({ error }),
      );
      const after = 'error' in first ? { ids, error: first.error } : await rest(it);
      if (!('error' in first) && first.done !== true) after.ids.unshift(first.value);
      expect(after.ids).not.toContain(ERASED);
      expect(chunksOf(after.ids)).toBeLessThanOrEqual(DEFAULT_INTERSECT_CONCURRENCY);
      expect(after.error).toBeInstanceOf(NotFoundError);
    },
  );
});

/**
 * The bound holds for a live read that plans its keys again. The erasure invalidates the segment, so a running `iterate`
 * or combine of the store that erased looks at its segments before the next key it takes, finds the rewritten
 * generation and plans its keys from it, dropping what it had requested: here the erased id is the only id of its
 * chunk, which the rewritten generation no longer lists. The read yields nothing of the erased generation from the next
 * key on, well within the bound, and every other id.
 */
describe('a live read in progress that plans again after the erasure', () => {
  const NS = 'ns';
  const C = 65_536;
  const REF: SegmentRef = { namespace: NS, segment: 's' };
  const IDS = Array.from({ length: 200 }, (_, c) => c * C + 1);

  async function world() {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, IDS, { registry });
    // the other operand, in a namespace the erasure leaves alone
    await bulkLoadCrbmGeneration(
      storage,
      { namespace: 'elsewhere', segment: 'every', generation: 0 },
      IDS,
      { registry },
    );
    const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }) });
    return { store, seg: store.segment('s', { namespace: NS }) };
  }

  it.each([
    ['iterate', 1],
    ['iterate', 150],
    ['intersect', 1],
    ['intersect', 150],
  ] as const)('%s, the erased id alone in chunk %s', async (verb, chunk) => {
    const { store, seg } = await world();
    const erased = chunk * C + 1;
    const stream =
      verb === 'iterate'
        ? seg.iterate()
        : seg.intersect([store.segment('every', { namespace: 'elsewhere' })]);
    const it = stream[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(IDS[0]);
    expect((await store.eraseSubject(erased, { namespace: NS })).erasedFrom).toHaveLength(1);

    const ids: number[] = [];
    for (let r = await it.next(); r.done !== true; r = await it.next()) ids.push(r.value);
    expect(ids).not.toContain(erased);
    expect(ids).toEqual(IDS.slice(1).filter((id) => id !== erased));
  });
});
