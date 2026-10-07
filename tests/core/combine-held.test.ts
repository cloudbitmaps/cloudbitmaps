/**
 * Held operands in the core pass: chunks read from memory with no request, the ledger charge, the empty rule, and the
 * erasure and release checks, run over the recording source so a read of the source would be seen.
 */
import { describe, expect, it } from 'vitest';
import { HeldChunks, prepareHeld } from '@/core/combine-held';
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type { CombineManyHeld, CombineManyOperand } from '@/core/combine-many';
import { BudgetExceededError, StaleOperandError, ValidationError } from '@/core/errors';
import { roaringCodec } from '@/roaring-codec';
import { collecting, request, seed, toNative } from '../helpers/combine-many';
import type { Published } from '../helpers/combine-many';

const clock = { now: () => 0, sleep: async () => {} };
const ids = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = from; v < to; v += step) out.push(v);
  return out;
};

async function held(values: number[]): Promise<HeldChunks> {
  return prepareHeld(Uint32Array.from(values), roaringCodec, undefined);
}

function heldOperand(
  name: string,
  chunks: HeldChunks,
  extra: Partial<CombineManyHeld> = {},
): CombineManyOperand {
  return {
    name,
    ref: { segment: name },
    held: { chunks, moved: () => false, mayBeEmpty: false, ...extra },
  };
}

async function runWith(
  stored: Record<string, number[]>,
  heldOnes: CombineManyOperand[],
  exprs: Array<{ expr: never; exclude?: never[]; beforePublish?: () => void }>,
  extra: Parameters<typeof request>[2] = {},
) {
  const setup = seed(stored);
  setup.operands.push(...heldOnes);
  const run = await runCombineMany(
    compileCombineMany(
      request(
        setup,
        exprs.map((e) => collecting(e)),
        extra,
      ),
    ),
    { source: setup.source, codec: roaringCodec, clock },
  );
  return { run, setup };
}

describe('HeldChunks', () => {
  it('keeps keys, exact cardinalities and one payload per chunk, and finds a chunk by key', async () => {
    const chunks = await held([5, 6, 65_536 + 1, 3 * 65_536]);
    expect([...chunks.keys]).toEqual([0, 1, 3]);
    expect([...chunks.cardinalities]).toEqual([2, 1, 1]);
    expect(chunks.payload(1)).not.toBeNull();
    expect(chunks.payload(2)).toBeNull();
    expect(chunks.empty).toBe(false);
    expect(chunks.residentBytes).toBeGreaterThan(0);
  });

  it('refuses a chunk list that does not ascend or has a cardinality out of range', () => {
    const payload = new Uint8Array(4);
    expect(
      () =>
        new HeldChunks([
          { chunkKey: 2, payload, cardinality: 1 },
          { chunkKey: 2, payload, cardinality: 1 },
        ]),
    ).toThrow(ValidationError);
    expect(() => new HeldChunks([{ chunkKey: 70_000, payload, cardinality: 1 }])).toThrow(
      ValidationError,
    );
    expect(() => new HeldChunks([{ chunkKey: 1, payload, cardinality: 0 }])).toThrow();
  });

  it('release zeroes every payload, is harmless twice, and makes a read throw', async () => {
    const chunks = await held([1, 2, 3]);
    const payload = chunks.payload(0)!;
    chunks.release();
    chunks.release();
    expect(payload.every((b) => b === 0)).toBe(true);
    expect(chunks.released).toBe(true);
    expect(() => chunks.payload(0)).toThrow(ValidationError);
  });
});

describe('a held operand in the pass', () => {
  it('gives the same ids as the operand stored, and makes no request for it', async () => {
    const a = ids(0, 200_000, 3);
    const b = [...ids(60_000, 140_000), 4_000_000];
    const stored = await runWith({ a, b }, [], [{ expr: { and: ['a', 'b'] } as never }]);
    const mixed = await runWith(
      { a },
      [heldOperand('b', await held(b))],
      [{ expr: { and: ['a', 'b'] } as never }],
    );
    expect(mixed.run.outputs[0]).toEqual(stored.run.outputs[0]);
    const onlyHeld = await runWith({}, [heldOperand('b', await held(b))], [{ expr: 'b' as never }]);
    expect(onlyHeld.run.stats.requests.rangeReads).toBe(0);
    expect(onlyHeld.setup.source.opened).toEqual([]);
    expect(onlyHeld.setup.source.singles).toEqual([]);
    // the control: the same operand stored does open a stream
    expect(mixed.setup.source.opened.map((o) => o.segment)).toEqual(['a']);
    expect((onlyHeld.run.outputs[0] as { ok: true; value: Published }).value.ids).toEqual(
      toNative(b).toArray(),
    );
  });

  it('counts the held bytes in the ledger, and refuses a call that cannot hold them', async () => {
    const chunks = await held(ids(0, 20 * 65_536, 1_000));
    const ok = await runWith({}, [heldOperand('b', chunks)], [{ expr: 'b' as never }]);
    expect(ok.run.stats.memory.highWaterBytes).toBeGreaterThanOrEqual(chunks.residentBytes);
    await expect(
      runWith({}, [heldOperand('b', chunks)], [{ expr: 'b' as never }], {
        maxBufferedBytes: chunks.residentBytes - 1,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // one handle under two names is charged once
    const twice = await runWith(
      {},
      [heldOperand('b', chunks), heldOperand('c', chunks)],
      [{ expr: { and: ['b', 'c'] } as never }],
      { maxBufferedBytes: chunks.residentBytes * 4 },
    );
    const other = await held(ids(0, 20 * 65_536, 1_000));
    const distinct = await runWith(
      {},
      [heldOperand('b', chunks), heldOperand('c', other)],
      [{ expr: { and: ['b', 'c'] } as never }],
      { maxBufferedBytes: chunks.residentBytes * 4 },
    );
    expect(distinct.run.stats.memory.highWaterBytes - twice.run.stats.memory.highWaterBytes).toBe(
      other.residentBytes,
    );
  });

  it('refuses an empty held operand when compiling, and accepts one that may be empty', async () => {
    const none = await held([]);
    expect(none.empty).toBe(true);
    expect(() =>
      compileCombineMany(
        request({ source: seed({}).source, operands: [heldOperand('n', none)] }, [
          collecting({ expr: 'n' as never }),
        ]),
      ),
    ).toThrow(/operand "n" holds no id/);
    const run = await runWith(
      { a: [1, 2, 70_000] },
      [heldOperand('n', none, { mayBeEmpty: true })],
      [{ expr: 'a' as never, exclude: ['n'] as never[] }, { expr: { and: ['a', 'n'] } as never }],
    );
    expect((run.run.outputs[0] as { ok: true; value: Published }).value.ids).toEqual([
      1, 2, 70_000,
    ]);
    expect((run.run.outputs[1] as { ok: true; value: Published }).value.ids).toEqual([]);
  });

  it('fails the outputs that read an operand an erasure made stale, before any read, and none other', async () => {
    const chunks = await held([1, 2, 3]);
    const run = await runWith(
      { a: [1, 2, 3, 70_000] },
      [heldOperand('v', chunks, { moved: () => true })],
      [{ expr: { and: ['a', 'v'] } as never }, { expr: 'a' as never }],
    );
    const stale = (run.run.outputs[0] as { ok: false; error: StaleOperandError }).error;
    expect(stale).toBeInstanceOf(StaleOperandError);
    expect(stale.reason).toBe('erased');
    expect(stale.operand).toBe('v');
    expect(run.run.outputs[1]!.ok).toBe(true);
  });

  it('checks again immediately before each publish: an erasure after the reads fails the output', async () => {
    const chunks = await held([1, 2, 3]);
    let reads = 0;
    let erased = false;
    const run = await runWith(
      { a: [1, 2, 3, 70_000] },
      [heldOperand('v', chunks, { moved: () => (reads++, erased) })],
      [
        {
          expr: { and: ['a', 'v'] } as never,
          // runs after the output was built, just before its publish
          beforePublish: () => {
            erased = true;
          },
        },
      ],
    );
    expect((run.run.outputs[0] as { ok: false; error: unknown }).error).toBeInstanceOf(
      StaleOperandError,
    );
    expect(reads).toBeGreaterThan(1);
  });
});

describe('an erasure that lands while the pass reads', () => {
  it('stops reading the held operand at the next key and fails the outputs that read it', async () => {
    const chunks = await held(ids(0, 6 * 65_536, 40_000));
    expect(chunks.keys.length).toBeGreaterThan(4);
    const reads: number[] = [];
    const payload = chunks.payload.bind(chunks);
    chunks.payload = (key: number) => {
      reads.push(key);
      return payload(key);
    };
    let checks = 0;
    // the first check is the start of the call, the second the first key the pass reads, then the erasure lands
    const run = await runWith(
      { a: ids(0, 6 * 65_536, 5) },
      [heldOperand('v', chunks, { moved: () => ++checks > 2 })],
      [{ expr: { and: ['a', 'v'] } as never }],
    );
    const failed = (run.run.outputs[0] as { ok: false; error: StaleOperandError }).error;
    expect(failed).toBeInstanceOf(StaleOperandError);
    expect(failed.reason).toBe('erased');
    expect(reads.length).toBeLessThan(chunks.keys.length);
  });
});

describe('prepareHeld', () => {
  it('refuses an `ascending` option and names the feed', async () => {
    await expect(
      prepareHeld({ ids: Uint32Array.from([1]), ascending: true }, roaringCodec, undefined),
    ).rejects.toThrow(/feed/);
  });
});
