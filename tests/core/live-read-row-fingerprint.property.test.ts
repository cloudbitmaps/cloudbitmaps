vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
/**
 * Invariant 2, as a property: over random sequences of loads, replacements of the current object under an unchanged
 * row (as a restore from outside the library makes), puts-back, reader-cache evictions, refresh lapses and reads, no
 * read ever serves an object its row did not name. A read answers only ids of generations that were published, or
 * throws `NotFoundError` for an object that is not the row's; it never answers an id only a replacement holds.
 *
 * It does not ask an `iterate` for one generation's ids. A long read can re-resolve part-way, when a collection takes
 * the generation it started on, and then describe two instants (invariant 3's stated bound): chunks of the earlier
 * generation, then of the later one. Each of those ids is still one a published generation held.
 */
import fc from 'fast-check';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { Clock, SegmentRef } from '@/index';
import { isNotFoundError } from '@/core/errors';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const B: SegmentRef = { namespace: NS, segment: 'b' };
const HI = 65_536;
/** Ids only a replacement holds. */
const MARK = 999;
const TTL = 2_000;

/** What generation `g` holds: one id per chunk, in one to three chunks. */
const published = (g: number): number[] =>
  Array.from({ length: 1 + (g % 3) }, (_, c) => c * HI + 10 + g);
/** A replacement of the same layout as generation `g` (often the same size), or a bigger one. */
const replacement = (g: number, same: boolean): number[] =>
  same
    ? published(g).map((id) => id - 10 - g + MARK)
    : Array.from({ length: 4 }, (_, c) => c * HI + MARK);

type Op =
  | { kind: 'load' }
  | { kind: 'replace'; same: boolean }
  | { kind: 'putBack' }
  | { kind: 'evict' }
  | { kind: 'lapse' }
  | { kind: 'count' }
  | { kind: 'has'; mark: boolean }
  | { kind: 'iterate' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant({ kind: 'load' as const }),
  fc.boolean().map((same) => ({ kind: 'replace' as const, same })),
  fc.constant({ kind: 'putBack' as const }),
  fc.constant({ kind: 'evict' as const }),
  fc.constant({ kind: 'lapse' as const }),
  fc.constant({ kind: 'count' as const }),
  fc.boolean().map((mark) => ({ kind: 'has' as const, mark })),
  fc.constant({ kind: 'iterate' as const }),
);

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function run(ops: readonly Op[]): Promise<void> {
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false });
  const clock = manualClock();
  const reader = new CloudRoaring({
    storage: backend,
    retry: false,
    seams: { clock },
    cache: { readerMax: 1, genTtlMs: TTL },
  });
  const a = reader.segment('a', { namespace: NS });
  const b = reader.segment('b', { namespace: NS });
  await writer.load(B, [1]);
  let gen = 0;
  await writer.load(A, published(gen), { keep: 0 });
  /** Every id a published generation of `a` held. */
  const everPublished = new Set(published(gen));
  const counts = new Set([published(gen).length]);
  /** Whether an id is one only a replacement holds: no load ever wrote one. */
  const onlyReplaced = (id: number): boolean => (id & 0xffff) === MARK;
  let replaced = false;

  const tolerate = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (err) {
      // An object that is not the row's is refused as a missing one is: never served.
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  };
  const swap = async (ids: number[]): Promise<void> => {
    await backend.storage.delete({ ...A, generation: gen });
    await bulkLoadCrbmGeneration(backend.storage, { ...A, generation: gen }, ids);
  };

  for (const op of ops) {
    switch (op.kind) {
      case 'load':
        if (replaced) {
          await swap(published(gen));
          replaced = false;
        }
        gen += 1;
        expect(await writer.load(A, published(gen), { keep: 0 })).toMatchObject({
          generation: gen,
        });
        for (const id of published(gen)) everPublished.add(id);
        counts.add(published(gen).length);
        break;
      case 'replace':
        await swap(replacement(gen, op.same));
        replaced = true;
        break;
      case 'putBack':
        if (replaced) await swap(published(gen));
        replaced = false;
        break;
      case 'evict':
        await b.has(1);
        break;
      case 'lapse':
        clock.advance(TTL + 1);
        break;
      case 'count': {
        const n = await tolerate(() => a.count());
        if (n !== undefined) expect(counts.has(n), `count ${n}`).toBe(true);
        break;
      }
      case 'has': {
        const id = op.mark ? MARK : 10 + gen;
        const held = await tolerate(() => a.has(id));
        if (op.mark) expect(held === true, 'served an id only a replacement holds').toBe(false);
        break;
      }
      case 'iterate': {
        const ids = await tolerate(async () => {
          const out: number[] = [];
          for await (const id of a.iterate()) out.push(id);
          return out;
        });
        if (ids !== undefined) {
          const where = `iterate ${JSON.stringify(ids)}`;
          expect(ids.some(onlyReplaced), `${where}: served an id only a replacement holds`).toBe(
            false,
          );
          expect(
            ids.every((id) => everPublished.has(id)),
            `${where}: an id no published generation held`,
          ).toBe(true);
          expect(ids, `${where}: ascending`).toEqual([...ids].sort((x, y) => x - y));
        }
        break;
      }
    }
  }
}

describe('no read serves an object its row did not name (invariant 2)', () => {
  it('over random loads, replacements, puts-back, evictions, lapses and reads', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        await run(ops);
      }),
      { numRuns: 60 },
    );
  });
});
