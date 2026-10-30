import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SegmentRef } from '@/index';
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
  const world = (async () => {
    const r = rig();
    for (const [name, ids] of Object.entries(POOL)) await r.load(name, ids);
    return r;
  })();

  const bound = fc.option(fc.integer({ min: 0, max: 10 * C }), { nil: undefined });
  it('equals the set oracle and the stream, for all three operations', async () => {
    const r = await world;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
        fc.option(fc.constantFrom(...NAMES), { nil: undefined }),
        bound,
        bound,
        async (names, exclude, after, through) => {
          const segs = names.map(ref);
          const lo = after === undefined ? 0 : after + 1;
          const hi = through ?? 2 ** 32 - 1;
          const cut = (ids: number[]): number[] => ids.filter((id) => id >= lo && id <= hi);
          for (const op of OPERS) {
            const ex = op === 'andNot' || exclude === undefined ? [] : [ref(exclude)];
            const lists = names.map((n) => POOL[n]!);
            let want = OPS[op](lists);
            if (ex.length > 0) want = want.filter((id) => !POOL[exclude!]!.includes(id));
            want = cut(want);
            const range = { after, through };
            const got = await countOf(r.engine(), op, segs, range, ex);
            expect(got, `${op} ${names.join(',')} ${String(exclude)} ${after} ${through}`).toBe(
              want.length,
            );
            expect(got).toBe((await collect(streamOf(r.engine(), op, segs, range, ex))).length);
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);
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

  it('an intersect makes exactly the requests its stream makes', async () => {
    const r = await pair(A, B);
    expect(await cost(r, 'intersect', true)).toBe(await cost(r, 'intersect', false));
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
    // Keys 0..3 are counted from generation 0 before the look; the rest from generation 1.
    const first4 = evens.slice(0, 2).flat().length + odds.slice(0, 2).flat().length;
    const rest = OPS.union([A1.filter((id) => id >= 4 * C), B0.filter((id) => id >= 4 * C)]).length;
    expect(got).toBe(first4 + rest);
    // What it served of generation 0 after the load landed is four keys: within the combine's `concurrency` + 1.
    expect(4).toBeLessThanOrEqual(LIMIT + 1);
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
