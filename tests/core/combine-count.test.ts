import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SegmentRef } from '@/index';
import type { EngineCountOptions } from '@cloudbitmaps/core';
import { BudgetExceededError, IntegrityError, NotFoundError, ValidationError } from '@/index';
import { SegmentEngine } from '@/core/engine';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import { segmentKey } from '@/core/keys';
import { crc32c } from '@/core/crbm/crc32c';
import { FOOTER, FOOTER_BYTES, FOOTER_CRC_COVERAGE } from '@/core/crbm/format';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { seedSegment, collect } from '../helpers/loaded';
import { storeCodec } from '../helpers/store-codec';
import { writeCrbm } from '../helpers/crbm-extension';
import {
  OPS,
  C,
  TTL,
  chunk,
  countOf,
  ref,
  requests,
  rig,
  setOf,
  streamOf,
} from '../helpers/combine-count-rig';
import type { Op } from '../helpers/combine-count-rig';

/**
 * The engine's combine count: how many ids a combine of stored segments holds, without streaming them. Each case holds
 * it to the size of the combine's own result (a plain-set oracle and the stream), and to what the per-key rule promises
 * about requests: a key one include holds is answered from the index, every other key is decoded as the stream
 * decodes it.
 */

const OPERS: Op[] = ['intersect', 'union', 'andNot'];

describe('what each count equals', () => {
  // A: chunks 0..5, B: chunks 3..8 (3..5 shared, partly overlapping ids), D: one chunk away from both.
  const A = [...chunk(0, 40), ...chunk(1, 70_000 % C), ...chunk(3, 100), ...chunk(4, 5)];
  const B = [...chunk(3, 100, 50), ...chunk(4, 5, 2), ...chunk(8, 9)];
  const D = chunk(20, 7);

  it.each(OPERS)('%s over operands that share some chunks', async (op) => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    await r.load('d', D);
    const segs = [ref('a'), ref('b'), ref('d')];
    for (const n of [2, 3]) {
      const lists = [A, B, D].slice(0, n);
      const engine = r.engine();
      expect(await countOf(engine, op, segs.slice(0, n))).toBe(OPS[op](lists).length);
    }
  });

  it('one operand: an intersect or an andNot is the index sum, a union is count()', async () => {
    const r = rig();
    await r.load('a', A);
    r.reset();
    const engine = r.engine();
    expect(await countOf(engine, 'union', [ref('a')])).toBe(A.length);
    expect(await countOf(engine, 'intersect', [ref('a')])).toBe(A.length);
    expect(await countOf(engine, 'andNot', [ref('a')])).toBe(A.length);
    expect(r.calls.getRange ?? 0).toBe(0); // no payload read
  });

  it('refuses an intersect of nothing and leaves an empty range at zero', async () => {
    const r = rig();
    await r.load('a', A);
    const engine = r.engine();
    await expect(engine.combineCount([], [], 'all', 'intersect')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await countOf(engine, 'union', [ref('a'), ref('a')], { after: 9, through: 9 })).toBe(0);
  });

  it('an exclude removes its ids from the count of an intersect and of a union', async () => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    await r.load('x', [...chunk(3, 30, 60), ...chunk(0, 3)]);
    const X = [...chunk(3, 30, 60), ...chunk(0, 3)];
    const engine = r.engine();
    const without = (ids: number[]) => ids.filter((id) => !X.includes(id)).length;
    expect(await countOf(engine, 'intersect', [ref('a'), ref('b')], {}, [ref('x')])).toBe(
      without(OPS.intersect([A, B])),
    );
    expect(await countOf(engine, 'union', [ref('a'), ref('b')], {}, [ref('x')])).toBe(
      without(OPS.union([A, B])),
    );
  });
});

describe('against a plain-set oracle, over random layouts and ranges', () => {
  // Operands of every shape a chunk takes: empty, one id, sparse, dense, a full chunk, the ends of the key space.
  const POOL: Record<string, number[]> = {
    none: [],
    one: [4 * C + 9],
    sparse: [...chunk(1, 40, 3), ...chunk(2, 500, 1000), ...chunk(7, 3)],
    dense: [...chunk(2, 9000, 100), ...chunk(3, 20_000), ...chunk(7, 4000, 6)],
    full: chunk(3, C),
    ends: [5, ...chunk(65_535, 30), ...chunk(7, 10, 8)],
    spread: [...chunk(0, 50), ...chunk(1, 5), ...chunk(2, 5), ...chunk(4, 5), ...chunk(9, 12)],
  };
  const NAMES = Object.keys(POOL);
  let r!: Awaited<ReturnType<typeof loaded>>;
  async function loaded() {
    const w = rig();
    for (const [name, ids] of Object.entries(POOL)) await w.load(name, ids);
    return w;
  }
  beforeAll(async () => {
    r = await loaded();
  });

  // Bounds anywhere in the first ten chunks, and inside the chunks of the pool's ends (the last key included).
  const bound = fc.option(
    fc.oneof(
      fc.integer({ min: 0, max: 10 * C }),
      fc.constantFrom(7 * C + 5, 7 * C + 12, 65_535 * C + 10, 65_535 * C + 29, 2 ** 32 - 1),
    ),
    { nil: undefined },
  );
  it('equals the set oracle and the stream, for all three operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 2 }),
        bound,
        bound,
        fc.integer({ min: 1, max: 5 }),
        async (names, excludes, after, through, concurrency) => {
          const segs = names.map(ref);
          const lo = after === undefined ? 0 : after + 1;
          const hi = through ?? 2 ** 32 - 1;
          const cut = (ids: number[]): number[] => ids.filter((id) => id >= lo && id <= hi);
          for (const op of OPERS) {
            const ex = op === 'andNot' ? [] : excludes.map(ref);
            const lists = names.map((n) => POOL[n]!);
            let want = OPS[op](lists);
            if (ex.length > 0) {
              const held = new Set(excludes.flatMap((e) => POOL[e]!));
              want = want.filter((id) => !held.has(id));
            }
            want = cut(want);
            const range = { after, through, concurrency };
            const got = await countOf(r.engine(), op, segs, range, ex);
            expect(
              got,
              `${op} ${names.join(',')} excl ${excludes.join(',')} ${after} ${through} c${concurrency}`,
            ).toBe(want.length);
            expect(got).toBe((await collect(streamOf(r.engine(), op, segs, range, ex))).length);
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 300_000);

  it('holds with pinned operands, and with a live operand reloaded under the same ids while it runs', async () => {
    const w = await loaded();
    let inner!: CrbmStorageChunkSource;
    w.engine({
      source: (crbm) => {
        inner = crbm;
        return crbm;
      },
    });
    const held = new Map<string, { generation: number; version: string; fingerprint: string }>();
    for (const name of NAMES) {
      const at = await inner.pinGeneration(ref(name));
      if (at !== null) held.set(name, at);
    }
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 2 }),
        fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 3 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 5 }),
        async (names, excludes, pinnedNames, moves, concurrency) => {
          const pins = new Map(
            pinnedNames.flatMap((n) => (held.has(n) ? [[segmentKey(ref(n)), held.get(n)!]] : [])),
          );
          for (const op of OPERS) {
            const segs = names.map(ref);
            const ex = op === 'andNot' ? [] : excludes.map(ref);
            let want = OPS[op](names.map((n) => POOL[n]!));
            if (ex.length > 0) {
              const heldIds = new Set(excludes.flatMap((e) => POOL[e]!));
              want = want.filter((id) => !heldIds.has(id));
            }
            const engine = w.engine({
              source: (crbm) => new PinnedStorageChunkSource(crbm, pins),
            });
            let looks = 0;
            const reload: Array<Promise<number>> = [];
            const guard = (): void => {
              looks += 1;
              // The same ids as a new generation: the pointer moves, the figure does not.
              if (moves && looks === 2) {
                const live = names.find((n) => !pins.has(segmentKey(ref(n))));
                if (live !== undefined) reload.push(w.load(live, POOL[live]!));
              }
              if (looks === 3) w.clock.advance(TTL + 1);
            };
            const got = await countOf(engine, op, segs, { concurrency, guard }, ex);
            await Promise.all(reload);
            expect(
              got,
              `${op} ${names.join(',')} excl ${excludes.join(',')} pinned ${pinnedNames.join(',')} move ${moves} c${concurrency}`,
            ).toBe(want.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 300_000);
});

describe('what a count requests, against its stream', () => {
  // Chunks of 3,000 ids at a stride (array containers of about 6 KB), so most of an object lies outside the tail the
  // open reads. A holds keys 0..99, B keys 0..9 and 100..189: ten shared keys, at the start of each object.
  const wide = (keys: number[]): number[] =>
    keys.flatMap((k) => Array.from({ length: 3000 }, (_, i) => k * C + i * 20));
  const upTo = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);
  const A = wide(upTo(100));
  const B = wide([...upTo(10), ...upTo(90, 100)]);
  const E = wide(upTo(90, 300));

  async function pair(a: number[], b: number[]) {
    const r = rig();
    await r.load('a', a);
    await r.load('b', b);
    return r;
  }
  async function cost(r: Awaited<ReturnType<typeof pair>>, op: Op, count: boolean) {
    r.reset();
    const engine = r.engine();
    const segs = [ref('a'), ref('b')];
    if (count) await countOf(engine, op, segs);
    else await collect(streamOf(engine, op, segs));
    return requests(r.calls);
  }

  it('an intersect makes exactly the requests its stream makes: the same tail reads and the same ranges', async () => {
    const r = await pair(A, B);
    const counted = await cost(r, 'intersect', true);
    const countedRanges = [...r.ranges].sort();
    const countedTails = r.calls.getTail;
    const streamed = await cost(r, 'intersect', false);
    expect(counted).toBe(streamed);
    expect(countedRanges.length).toBeGreaterThan(0);
    expect(countedRanges).toEqual([...r.ranges].sort());
    expect(countedTails).toBe(r.calls.getTail);
  });

  it.each(['union', 'andNot'] as const)(
    'a %s makes no more requests than its stream',
    async (op) => {
      const r = await pair(A, B);
      expect(await cost(r, op, true)).toBeLessThanOrEqual(await cost(r, op, false));
    },
  );

  it('a union of operands that share no key reads no range at all', async () => {
    const r = await pair(A, E);
    r.reset();
    expect(await countOf(r.engine(), 'union', [ref('a'), ref('b')])).toBe(A.length + E.length);
    expect(r.calls.getRange ?? 0).toBe(0);
    r.reset();
    await collect(streamOf(r.engine(), 'union', [ref('a'), ref('b')]));
    expect(r.calls.getRange ?? 0).toBeGreaterThan(0); // the control: its stream does read ranges
  });

  it('a union reads the bytes of the shared keys only, a fraction of what its stream reads', async () => {
    const r = await pair(A, B);
    r.reset();
    const engine = r.engine();
    expect(await countOf(engine, 'union', [ref('a'), ref('b')])).toBe(OPS.union([A, B]).length);
    const counted = r.calls.rangeBytes ?? 0;
    r.reset();
    await collect(streamOf(r.engine(), 'union', [ref('a'), ref('b')]));
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan((r.calls.rangeBytes ?? 0) / 4);
  });

  it('is charged for the keys it decodes, and refused before any read when they exceed the budget', async () => {
    const r = await pair(A, B);
    r.reset();
    const engine = r.engine();
    // ten shared keys, two operands each: twenty reads
    await expect(
      countOf(engine, 'union', [ref('a'), ref('b')], { budget: { maxRequests: 19 } }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(r.calls.getRange ?? 0).toBe(0);
    expect(
      await countOf(r.engine(), 'union', [ref('a'), ref('b')], { budget: { maxRequests: 20 } }),
    ).toBe(OPS.union([A, B]).length);
  });
});

describe('a source that reports no per-chunk counts', () => {
  it('has every key decoded, and still counts exactly', async () => {
    const A = [...chunk(0, 10), ...chunk(2, 20), ...chunk(5, 3)];
    const B = [...chunk(2, 5, 10), ...chunk(6, 4)];
    const storage = new MemoryStorageChunkSource();
    seedSegment(storage, 'a', A);
    seedSegment(storage, 'b', B);
    const engine = new SegmentEngine({ storage, codec: storeCodec });
    const segs = [{ segment: 'a' }, { segment: 'b' }];
    for (const op of OPERS) {
      expect(await countOf(engine, op, segs)).toBe(OPS[op]([A, B]).length);
    }
    expect(await countOf(engine, 'union', segs, { after: 5, through: 2 * C + 12 })).toBe(
      setOf(A, B).filter((id) => id > 5 && id <= 2 * C + 12).length,
    );
  });
});

describe('absent and foreign operands', () => {
  it('an operand that names no segment is refused, unless it is allowed', async () => {
    const r = rig();
    await r.load('a', chunk(0, 5));
    const engine = r.engine();
    const segs = [ref('a'), ref('nope')];
    await expect(countOf(engine, 'union', segs)).rejects.toBeInstanceOf(ValidationError);
    await expect(countOf(engine, 'intersect', segs)).rejects.toBeInstanceOf(ValidationError);
    expect(await countOf(engine, 'union', segs, { allowAbsentOperands: true })).toBe(5);
    expect(await countOf(engine, 'intersect', segs, { allowAbsentOperands: true })).toBe(0);
    expect(await countOf(engine, 'andNot', segs, { allowAbsentOperands: true })).toBe(5);
  });
});

describe('what the index is trusted for', () => {
  const portable = (values: number[]) => storeCodec.fromValues(values).serialize();

  /** Generation 1 of `a`: chunk 0 holds three ids and its index says `claimed`; `b` holds chunk 5 (a lone key each). */
  async function planted(claimed: number) {
    const r = rig();
    await r.load('a', [1]);
    await r.load('b', chunk(5, 4));
    let bytes = await writeCrbm(
      [{ chunkKey: 0, payload: portable([1, 2, 3]), cardinality: claimed }],
      { generation: 1 },
    );
    bytes = Uint8Array.from(bytes);
    await r.storage.putImmutable({ ...ref('a'), generation: 1 }, async (out) => out.write(bytes));
    const row = (await r.registry.get(ref('a')))!;
    await r.registry.compareAndSwap(ref('a'), row.token, { currentGen: 1 });
    return r;
  }

  it('cleartext: a key answered from the index reports the index figure (a stated limit); a decoded key is exact', async () => {
    const r = await planted(5);
    // Chunk 0 is a's alone: the index's 5, not the 3 ids it holds. Chunk 5 is b's alone: 4.
    expect(await countOf(r.engine(), 'union', [ref('a'), ref('b')])).toBe(5 + 4);
    // Held by two operands, the same chunk is decoded and counted exactly.
    await r.load('c', [1, 2, 3, 4]);
    expect(await countOf(r.engine(), 'union', [ref('a'), ref('c')])).toBe(4);
  });

  it('an intersect is exact under the same forged index: it decodes every key and answers none from the index', async () => {
    const r = await planted(5);
    await r.load('c', [1, 2, 3, 4]);
    // The forged chunk 0 claims 5 ids and holds 3. A union and a difference report the claim for a key only a holds ...
    expect(await countOf(r.engine(), 'union', [ref('a'), ref('b')])).toBe(5 + 4);
    expect(await countOf(r.engine(), 'andNot', [ref('a'), ref('b')])).toBe(5);
    // ... an intersect decodes the key every operand holds, and counts the ids there are
    expect(await countOf(r.engine(), 'intersect', [ref('a'), ref('c')])).toBe(3);
    expect(await countOf(r.engine(), 'intersect', [ref('a'), ref('b')])).toBe(0);
  });

  it('encrypted: an index changed under its seal is refused, not reported', async () => {
    const { randomBytes } = await import('node:crypto');
    const { InProcessKeystore } = await import('@/drivers/crypto');
    const { bulkLoadCrbmGeneration } = await import('../helpers/bulk-load');
    const r = rig();
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const key = { ...ref('a'), generation: 0 };
    await bulkLoadCrbmGeneration(r.storage, key, [...chunk(0, 3), ...chunk(2, 3)], {
      registry: r.registry,
      keystore,
    });
    await r.load('b', chunk(5, 4));
    // The row's summary names the object it describes; the check below is of the seal, so a row without one is read.
    const registry = new Proxy(r.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'get') return value;
        return async (at: SegmentRef) => {
          const row = await t.get(at);
          if (row === null) return null;
          const rest = { ...row };
          delete rest.summary;
          return rest;
        };
      },
    });
    const engine = () =>
      new SegmentEngine({
        storage: new CrbmStorageChunkSource(r.storage, { registry, keystore }),
        codec: storeCodec,
      });
    expect(await countOf(engine(), 'union', [ref('a'), ref('b')])).toBe(10);
    // A party that can write the bucket and not the key: one sealed-index byte flipped, both CRCs made good.
    const listed: Array<{ generation: number }> = [];
    for await (const k of r.storage.list(ref('a'))) listed.push(k);
    const size = (await r.storage.getTail(key, 1 << 20)).size;
    const bytes = Uint8Array.from((await r.storage.getRange(key, 0, size)) as Uint8Array);
    const footer = new DataView(bytes.buffer, bytes.length - FOOTER_BYTES, FOOTER_BYTES);
    const indexOffset = Number(footer.getBigUint64(FOOTER.indexOffset, true));
    bytes[indexOffset] = bytes[indexOffset]! ^ 1;
    const indexLength = Number(footer.getBigUint64(FOOTER.indexLength, true));
    footer.setUint32(
      FOOTER.indexCrc32c,
      crc32c(bytes.subarray(indexOffset, indexOffset + indexLength)),
      true,
    );
    footer.setUint32(
      FOOTER.footerCrc32c,
      crc32c(
        bytes.subarray(
          bytes.length - FOOTER_BYTES,
          bytes.length - FOOTER_BYTES + FOOTER_CRC_COVERAGE,
        ),
      ),
      true,
    );
    await r.storage.delete(key);
    await r.storage.putImmutable(key, async (out) => out.write(bytes));
    const err = await countOf(engine(), 'union', [ref('a'), ref('b')]).catch((e: unknown) => e);
    expect(err, String(err)).toBeInstanceOf(IntegrityError);
  });
});

describe('a count that meets a move or an erasure while it runs', () => {
  const LIMIT = 4;
  // 20 keys each, A even keys, B odd keys: every key is a lone key, so the whole count comes from the index.
  const evens = Array.from({ length: 20 }, (_, i) => chunk(2 * i, 3 + i));
  const odds = Array.from({ length: 20 }, (_, i) => chunk(2 * i + 1, 2 + i));
  const A0 = evens.flat();
  const B0 = odds.flat();

  async function started(guard?: (looks: number) => void) {
    const r = rig();
    await r.load('a', A0);
    await r.load('b', B0);
    let looks = 0;
    const count = (engine = r.engine(), segs = [ref('a'), ref('b')]) =>
      countOf(engine, 'union', segs, {
        concurrency: LIMIT,
        guard: () => {
          looks += 1;
          guard?.(looks);
        },
      });
    return { r, count, looks: () => looks };
  }

  it('looks at the start and every concurrency keys, a key answered from the index being one taken', async () => {
    const { count, looks } = await started();
    expect(await count()).toBe(A0.length + B0.length);
    // 40 keys at a look every 4: the start, then before steps 5, 9, ... 37
    expect(looks()).toBe(1 + 9);
  });

  it('a load landing while it runs: the keys after the look come from the new generation, within the bound', async () => {
    // Generation 1 of a: five even keys, each holding one more id; the other even keys are gone.
    const A1 = evens.slice(0, 5).flatMap((c, i) => [...c, ...chunk(2 * i, 1, 60_000)]);
    const { r } = await started();
    const engine = r.engine();
    const run = (guard?: () => void) =>
      countOf(engine, 'union', [ref('a'), ref('b')], {
        concurrency: LIMIT,
        ...(guard ? { guard } : {}),
      });
    await run(); // the engine now holds generation 0 of both, for the TTL
    await r.load('a', A1); // another party's publish: the engine is not told
    let looks = 0;
    const got = await run(() => {
      looks += 1;
      if (looks === 2) r.clock.advance(TTL + 1); // the first look finds the pointer read again
    });
    // The count is generation 0's figure for the keys below `k` and generation 1's from `k` on, for exactly one `k`: the
    // key the look landed on, within the combine's `concurrency` + 1 keys after the load.
    const split = (k: number): number =>
      OPS.union([A0.filter((id) => id < k * C), B0.filter((id) => id < k * C)]).length +
      OPS.union([A1.filter((id) => id >= k * C), B0.filter((id) => id >= k * C)]).length;
    const splits = Array.from({ length: 41 }, (_, k) => k).filter((k) => split(k) === got);
    // (key 3 is b's alone and the same in both generations, so a split at 3 or at 4 gives the figure)
    expect(Math.max(...splits)).toBe(4);
    expect(Math.max(...splits)).toBeLessThanOrEqual(LIMIT + 1);
  });

  it('a pinned operand whose generation an erasure deleted stops the count', async () => {
    const r = rig();
    await r.load('a', A0);
    await r.load('b', B0);
    const crbm = new CrbmStorageChunkSource(r.backend.storage, {
      registry: r.registry,
      clock: r.clock,
    });
    const at = (await crbm.pinGeneration(ref('a')))!;
    const pinned = new PinnedStorageChunkSource(
      crbm,
      new Map([
        [
          segmentKey(ref('a')),
          { generation: at.generation, version: at.version, fingerprint: at.fingerprint },
        ],
      ]),
    );
    const engine = new SegmentEngine({ storage: pinned, codec: storeCodec });
    const segs = [ref('a'), ref('b')];
    expect(await countOf(engine, 'union', segs, { concurrency: LIMIT })).toBe(
      A0.length + B0.length,
    );
    // The erasure: a new generation without the ids, the pinned object deleted.
    await r.load('a', chunk(0, 1));
    await r.backend.storage.delete({ ...ref('a'), generation: 0 });
    engine.invalidate(ref('a'));
    await expect(countOf(engine, 'union', segs, { concurrency: LIMIT })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('a lease that ends mid-count stops it at the next look', async () => {
    const stop = new Error('lease ended');
    const { count } = await started((looks) => {
      if (looks === 3) throw stop;
    });
    await expect(count()).rejects.toBe(stop);
  });
});

describe('a count whose later chunks go away while it runs', () => {
  const LIMIT = 4;
  const evens = Array.from({ length: 20 }, (_, i) => chunk(2 * i, 3 + i));
  const odds = Array.from({ length: 20 }, (_, i) => chunk(2 * i + 1, 2 + i));
  const A0 = evens.flat();
  const B0 = odds.flat();
  // keys 0..3 of generation 0: two even and two odd keys
  const FIRST4 = evens.slice(0, 2).flat().length + odds.slice(0, 2).flat().length;

  type Way = 'shrinks' | 'erases' | 'drops';
  it.each<Way>(['shrinks', 'erases', 'drops'])(
    'the count ends with the figure so far when a segment %s and the re-plan has no keys',
    async (way) => {
      const r = rig();
      await r.load('a', A0);
      await r.load('b', B0);
      const engine = r.engine();
      const run = (guard?: () => void) =>
        countOf(engine, 'union', [ref('a'), ref('b')], {
          concurrency: LIMIT,
          ...(guard ? { guard } : {}),
        });
      expect(await run()).toBe(A0.length + B0.length); // the engine holds generation 0 of both
      for (const name of ['a', 'b']) {
        if (way === 'drops') {
          for await (const k of r.storage.list(ref(name)))
            await r.storage.delete({ ...ref(name), ...k });
          await r.registry.delete(ref(name));
        } else {
          // generation 1: nothing above key 1 (an erasure also removes generation 0's object)
          const next = await r.load(name, chunk(name === 'a' ? 0 : 1, 1));
          if (way === 'erases') await r.storage.delete({ ...ref(name), generation: next - 1 });
        }
      }
      let looks = 0;
      const got = await run(() => {
        looks += 1;
        if (looks === 2) r.clock.advance(TTL + 1);
      });
      expect(got).toBe(FIRST4);
      expect(looks).toBe(2); // the look that found the move ended the count
    },
  );
});

describe('a count whose pinned operand is erased while it runs', () => {
  const LIMIT = 4;
  const evens = Array.from({ length: 20 }, (_, i) => chunk(2 * i, 3 + i));
  const odds = Array.from({ length: 20 }, (_, i) => chunk(2 * i + 1, 2 + i));
  const A0 = evens.flat();
  const B0 = odds.flat();

  /** An engine over a source that pins `a` at generation 0 (and, when `unpinned`, pins nothing). */
  async function pinnedWorld(opts: { unpinned?: boolean; hideLookup?: boolean } = {}) {
    const r = rig();
    await r.load('a', A0);
    await r.load('b', B0);
    const crbm = new CrbmStorageChunkSource(r.backend.storage, {
      registry: r.registry,
      clock: r.clock,
    });
    const at = (await crbm.pinGeneration(ref('a')))!;
    const pins = new Map(
      opts.unpinned
        ? []
        : [
            [
              segmentKey(ref('a')),
              { generation: at.generation, version: at.version, fingerprint: at.fingerprint },
            ],
          ],
    );
    const engine = r.engine({
      source: (inner) => {
        const pinned = new PinnedStorageChunkSource(inner, pins);
        if (!opts.hideLookup) return pinned;
        // The same source with no lookup of the pinned object: what a count did before it looked pins up.
        return new Proxy(pinned, {
          get(t, p) {
            if (p === 'verifyPinned') return undefined;
            const v: unknown = Reflect.get(t, p, t);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
      },
    });
    return { r, engine };
  }

  it.each([2, 3])(
    'an erasure that lands at look %i of an all-index count is raised there, with no further look',
    async (at) => {
      const { r, engine } = await pinnedWorld();
      let looks = 0;
      const err = await countOf(engine, 'union', [ref('a'), ref('b')], {
        concurrency: LIMIT,
        guard: () => {
          looks += 1;
          // The count has started and read its index, and the pin's generation is replaced and its object deleted with no
          // invalidation told to the engine. The delete takes effect as it is called.
          if (looks === at) {
            void r.load('a', chunk(0, 1));
            void r.backend.storage.delete({ ...ref('a'), generation: 0 });
          }
        },
      }).catch((e: unknown) => e);
      expect(err, String(err)).toBeInstanceOf(NotFoundError);
      // looks 1 is the start; the erasure is found at the look that follows it: at most `concurrency` keys after
      expect(looks).toBe(at);
    },
  );

  it('control: without the lookup the same erasure goes unseen and the count finishes from the index', async () => {
    const { r, engine } = await pinnedWorld({ hideLookup: true });
    let looks = 0;
    const got = await countOf(engine, 'union', [ref('a'), ref('b')], {
      concurrency: LIMIT,
      guard: () => {
        looks += 1;
        if (looks === 2) void r.backend.storage.delete({ ...ref('a'), generation: 0 });
      },
    });
    expect(got).toBe(A0.length + B0.length);
  });

  it('costs one footer read per pinned operand at each look, and nothing for an operand that is not pinned', async () => {
    const run = async (opts: { unpinned?: boolean; hideLookup?: boolean }) => {
      const { r, engine } = await pinnedWorld(opts);
      r.reset();
      expect(await countOf(engine, 'union', [ref('a'), ref('b')], { concurrency: LIMIT })).toBe(
        A0.length + B0.length,
      );
      return { requests: requests(r.calls), tails: r.calls.getTail ?? 0 };
    };
    const without = await run({ hideLookup: true });
    const withPin = await run({});
    const none = await run({ unpinned: true });
    // 40 keys at a look every 4: nine looks and the one before the first key, one pinned operand
    expect(withPin.requests - without.requests).toBe(10);
    expect(withPin.tails - without.tails).toBe(10);
    // nothing pinned: a source that can look pins up asks about nothing
    expect(none).toEqual(await run({ unpinned: true, hideLookup: true }));
  });
});

describe('a lone-operand union and an operand that names no segment', () => {
  it('is refused as its stream refuses it, unless absent operands are allowed', async () => {
    const r = rig();
    await r.load('empty', []);
    await r.load('a', chunk(0, 5));
    const engine = r.engine();
    await expect(countOf(engine, 'union', [ref('typo')])).rejects.toBeInstanceOf(ValidationError);
    await expect(collect(streamOf(r.engine(), 'union', [ref('typo')]))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await countOf(engine, 'union', [ref('typo')], { allowAbsentOperands: true })).toBe(0);
    // a segment that exists and holds nothing, and one that holds ids, are counted
    expect(await countOf(engine, 'union', [ref('empty')])).toBe(0);
    expect(await countOf(engine, 'union', [ref('a')])).toBe(5);
  });
});

describe('a lone-operand andNot is count(), as its stream of the whole of the operand is', () => {
  it('makes the requests count() makes, answers the same figure, and is refused for an absent operand', async () => {
    const r = rig();
    await r.load('a', chunk(0, 5).concat(chunk(3, 7)));
    await r.load('empty', []);
    r.reset();
    const viaCount = await r.engine().count(ref('a'));
    const countCalls = { ...r.calls };
    r.reset();
    expect(await countOf(r.engine(), 'andNot', [ref('a')])).toBe(viaCount);
    expect(r.calls).toEqual(countCalls);
    expect(await collect(streamOf(r.engine(), 'andNot', [ref('a')]))).toHaveLength(viaCount);
    expect(await countOf(r.engine(), 'andNot', [ref('empty')])).toBe(0);
    // a figure of 0 asks once whether the segment exists; a figure above 0 asks nothing more than count()
    for (const op of ['union', 'andNot'] as const) {
      r.reset();
      await r.engine().count(ref('empty'));
      const base = requests(r.calls);
      r.reset();
      await countOf(r.engine(), op, [ref('empty')]);
      expect(requests(r.calls)).toBe(base + 1);
    }
    await expect(countOf(r.engine(), 'andNot', [ref('typo')])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(collect(streamOf(r.engine(), 'andNot', [ref('typo')]))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await countOf(r.engine(), 'andNot', [ref('typo')], { allowAbsentOperands: true })).toBe(
      0,
    );
  });
});

describe('the guard of a count whose version looks are off', () => {
  const LIMIT = 4;
  const keys = Array.from({ length: 20 }, (_, i) => chunk(i, 3 + i));
  const A = keys.flat();
  const B = keys.flat();

  it('an intersect of two operands runs it at the start and every concurrency keys', async () => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    let calls = 0;
    const got = await countOf(r.engine(), 'intersect', [ref('a'), ref('b')], {
      concurrency: LIMIT,
      guard: () => {
        calls += 1;
      },
    });
    expect(got).toBe(A.length);
    expect(calls).toBe(1 + 4); // the start, then before keys 5, 9, 13 and 17 of 20
  });

  it('a lease that ends in the middle of an intersect fails it at the next guard', async () => {
    const stop = new Error('lease ended');
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    let calls = 0;
    await expect(
      countOf(r.engine(), 'intersect', [ref('a'), ref('b')], {
        concurrency: LIMIT,
        guard: () => {
          calls += 1;
          if (calls === 3) throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(calls).toBe(3);
  });

  it('the options type is the one the core entry exports', () => {
    const options: EngineCountOptions = { guard: () => undefined, concurrency: 2 };
    expect(options.concurrency).toBe(2);
  });
});

describe('a move while a count decodes keys', () => {
  const LIMIT = 4;
  // Keys 0..19 held by both a and b (every key decoded), key 3 and key 10 also held by an exclude.
  const A0 = Array.from({ length: 20 }, (_, i) => chunk(i, 6 + i)).flat();
  const B0 = Array.from({ length: 20 }, (_, i) => chunk(i, 4 + i, 3)).flat();
  const X = [...chunk(3, 4, 4), ...chunk(10, 5, 2)];

  it('a load landing at a look splits the count at the look, with shared and excluded keys decoded', async () => {
    const r = rig();
    await r.load('a', A0);
    await r.load('b', B0);
    await r.load('x', X);
    // generation 1 of a: keys 4 and above hold different ids
    const A1 = [
      ...A0.filter((id) => id < 4 * C),
      ...Array.from({ length: 16 }, (_, i) => chunk(4 + i, 9 + i, 1)).flat(),
    ];
    const engine = r.engine();
    const run = (guard?: () => void) =>
      countOf(
        engine,
        'union',
        [ref('a'), ref('b')],
        { concurrency: LIMIT, ...(guard ? { guard } : {}) },
        [ref('x')],
      );
    await run();
    await r.load('a', A1);
    let looks = 0;
    const got = await run(() => {
      looks += 1;
      if (looks === 2) r.clock.advance(TTL + 1);
    });
    const without = (ids: number[]) => ids.filter((id) => !X.includes(id));
    const split = (k: number): number =>
      without(OPS.union([A0.filter((id) => id < k * C), B0.filter((id) => id < k * C)])).length +
      without(OPS.union([A1.filter((id) => id >= k * C), B0.filter((id) => id >= k * C)])).length;
    // keys below 4 are the same ids in both generations, so every split up to the look's key gives the figure
    const splits = Array.from({ length: 21 }, (_, k) => k).filter((k) => split(k) === got);
    expect(Math.max(...splits)).toBe(4);
  });

  it('is charged for the keys already taken when the new plan is checked against the budget', async () => {
    // Generation 0 shares keys 0..9 (twenty reads); generation 1 of b shares all twenty keys. After four keys the new
    // plan needs 32 more reads: 4 * 2 spent + 32 is over 35 and 32 alone is not.
    const r = rig();
    await r.load('a', A0);
    await r.load('b', Array.from({ length: 10 }, (_, i) => chunk(i, 4 + i, 3)).flat());
    const engine = r.engine();
    const run = (guard?: () => void) =>
      countOf(engine, 'union', [ref('a'), ref('b')], {
        concurrency: LIMIT,
        budget: { maxRequests: 35 },
        ...(guard ? { guard } : {}),
      });
    expect(await run()).toBeGreaterThan(0);
    await r.load('b', B0);
    let looks = 0;
    await expect(
      run(() => {
        looks += 1;
        if (looks === 2) r.clock.advance(TTL + 1);
      }),
    ).rejects.toThrow(/^unionCount would fan out to 36 units/);
  });
});

describe('a range that cuts a key one operand holds', () => {
  const lone = chunk(3, 100); // ids 3*C .. 3*C + 99, alone in a
  const other = chunk(7, 20);
  const setup = async () => {
    const r = rig();
    await r.load('a', lone);
    await r.load('b', other);
    await r.load('x', chunk(3, 5, 60));
    return r;
  };

  it.each([
    ['after inside it', { after: 3 * C + 49 }, 50 + 20, true],
    ['through inside it', { through: 3 * C + 9 }, 10, true],
    ['both inside it', { after: 3 * C + 19, through: 3 * C + 29 }, 10, true],
    ['neither (a range holding it whole)', { after: 3 * C - 1, through: 3 * C + 99 }, 100, false],
  ])('%s', async (_name, range, want, cut) => {
    const r = await setup();
    r.reset();
    expect(await countOf(r.engine(), 'union', [ref('a'), ref('b')], range)).toBe(want);
    // a cut key is decoded, so its figure is the ids the range holds, not the index's 100
    void cut;
  });

  it('an exclude holding the cut key takes its ids out of the cut chunk', async () => {
    const r = await setup();
    expect(
      await countOf(r.engine(), 'union', [ref('a'), ref('b')], { after: 3 * C + 49 }, [ref('x')]),
    ).toBe(50 - 5 + 20);
  });
});

describe('an index that disagrees with the chunk keys', () => {
  const A = [...chunk(0, 5), ...chunk(2, 7)];
  const B = chunk(5, 4);

  /** A source whose `cardinalities` names a key the segment does not hold, for the first `times` calls (or always). */
  function lying(times: number) {
    const seen = { calls: 0 };
    const source = (inner: CrbmStorageChunkSource) =>
      new Proxy(inner, {
        get(t, p) {
          const v: unknown = Reflect.get(t, p, t);
          if (p === 'cardinalities') {
            return async (at: SegmentRef) => {
              const n = (seen.calls += 1);
              const real = await t.cardinalities(at);
              if (real === null || n > times) return real;
              return new Map([...real, [999, 1]]);
            };
          }
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    return { seen, source };
  }

  it('lists the operand again, and counts exactly once the two agree', async () => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    const { seen, source } = lying(1);
    const engine = r.engine({ source });
    expect(await countOf(engine, 'union', [ref('a'), ref('b')])).toBe(A.length + B.length);
    expect(seen.calls).toBe(3); // a's counts twice, b's once
  });

  it('refuses with IntegrityError once a source has disagreed four times in a row', async () => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', B);
    const { seen, source } = lying(Infinity);
    await expect(
      countOf(r.engine({ source }), 'union', [ref('a'), ref('b')]),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(seen.calls).toBeGreaterThanOrEqual(4);
  });

  it('is not asked for by an intersect of two operands, which decodes every key', async () => {
    const r = rig();
    await r.load('a', A);
    await r.load('b', [...chunk(2, 3), ...B]);
    const { seen, source } = lying(Infinity);
    expect(await countOf(r.engine({ source }), 'intersect', [ref('a'), ref('b')])).toBe(3);
    expect(seen.calls).toBe(0);
  });
});
