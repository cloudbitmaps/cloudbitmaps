import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';

type Seg = ReturnType<CloudRoaring['segment']>;

/**
 * A combine runs on one store and takes only segments that store made. A handle of another store, even one over the
 * same backend, would be resolved by name in the receiving store and answer from the wrong segment, so it is refused
 * with a ValidationError before any request.
 */
const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

async function world() {
  const a = new CloudRoaring({ storage: new MemoryStorage() });
  const b = new CloudRoaring({ storage: new MemoryStorage() });
  await a.load({ segment: 'x' }, [1, 2, 3]);
  await a.load({ segment: 'dest' }, [9]);
  await b.load({ segment: 'x' }, [3, 4]);
  await b.load({ segment: 'dest' }, [8]);
  return { a, b };
}

const generationsOf = async (s: CloudRoaring, name: string) =>
  (await s.generations({ segment: name })).map((g) => g.generation);

type Call = readonly [string, (r: Seg, foreign: Seg, localDest: Seg) => Promise<unknown>];

/** Every verb with the foreign handle as an operand, as an exclude, or as the destination. */
const OPERAND_CALLS: readonly Call[] = [
  ['intersect', (r, f) => drain(r.intersect([f]))],
  ['union', (r, f) => drain(r.union([f]))],
  ['andNot', (r, f) => drain(r.andNot([f]))],
  ['intersectInto', (r, f, d) => r.intersectInto(d, [f])],
  ['unionInto', (r, f, d) => r.unionInto(d, [f])],
  ['andNotInto', (r, f, d) => r.andNotInto(d, [f])],
];
const EXCLUDE_CALLS: readonly Call[] = [
  ['intersect', (r, f) => drain(r.intersect([r], { exclude: [f] }))],
  ['union', (r, f) => drain(r.union([r], { exclude: [f] }))],
  ['intersectInto', (r, f, d) => r.intersectInto(d, [r], { exclude: [f] })],
  ['unionInto', (r, f, d) => r.unionInto(d, [r], { exclude: [f] })],
];
const DEST_CALLS: readonly Call[] = [
  ['intersectInto', (r, f) => r.intersectInto(f, [r])],
  ['unionInto', (r, f) => r.unionInto(f, [r])],
  ['andNotInto', (r, f) => r.andNotInto(f, [r])],
];

describe('a combine takes only segments of its own store', () => {
  it.each(OPERAND_CALLS)('%s refuses an operand of another store', async (verb, call) => {
    const { a, b } = await world();
    const before = await generationsOf(a, 'dest');
    const err = await call(a.segment('x'), b.segment('x'), a.segment('dest')).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      `${verb}: an operand belongs to another store; combine segments of one store: open each with this store's segment()`,
    );
    expect(await generationsOf(a, 'dest')).toEqual(before);
    expect(await drain(a.segment('dest').iterate())).toEqual([9]);
    expect(await drain(a.segment('x').iterate())).toEqual([1, 2, 3]);
  });

  it.each(EXCLUDE_CALLS)('%s refuses an exclude of another store', async (verb, call) => {
    const { a, b } = await world();
    const before = await generationsOf(a, 'dest');
    const err = await call(a.segment('x'), b.segment('x'), a.segment('dest')).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(
      new RegExp(`^${verb}: an exclude belongs to another store; `),
    );
    expect(await generationsOf(a, 'dest')).toEqual(before);
  });

  it.each(DEST_CALLS)('%s refuses a destination of another store', async (verb, call) => {
    const { a, b } = await world();
    const beforeA = await generationsOf(a, 'dest');
    const beforeB = await generationsOf(b, 'dest');
    const err = await call(a.segment('x'), b.segment('dest'), a.segment('dest')).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(
      new RegExp(`^${verb}: the destination belongs to another store; `),
    );
    expect(await generationsOf(a, 'dest')).toEqual(beforeA);
    expect(await generationsOf(b, 'dest')).toEqual(beforeB);
    expect(await drain(b.segment('dest').iterate())).toEqual([8]);
  });

  it('refuses a handle of another store whose segment name the receiver lacks, as another store', async () => {
    const { a, b } = await world();
    await b.load({ segment: 'only-b' }, [1]);
    await expect(drain(a.segment('x').intersect([b.segment('only-b')]))).rejects.toThrow(
      /belongs to another store/,
    );
  });

  it('refuses two store objects over one shared storage', async () => {
    const storage = new MemoryStorage();
    const a = new CloudRoaring({ storage });
    const c = new CloudRoaring({ storage });
    await a.load({ segment: 'x' }, [1, 2, 3]);
    await a.load({ segment: 'dest' }, [9]);
    const before = await generationsOf(a, 'dest');
    for (const [, call] of [...OPERAND_CALLS, ...EXCLUDE_CALLS]) {
      await expect(call(a.segment('x'), c.segment('x'), a.segment('dest'))).rejects.toThrow(
        /belongs to another store/,
      );
    }
    await expect(a.segment('x').intersectInto(c.segment('dest'), [a.segment('x')])).rejects.toThrow(
      /the destination belongs to another store/,
    );
    expect(await generationsOf(a, 'dest')).toEqual(before);
  });

  it('accepts pinned and leased handles of its own store', async () => {
    const { a } = await world();
    await a.load({ segment: 'y' }, [2, 3, 4]);
    const pinned = await a.segment('y').pin();
    const leased = await a.segment('y').pin({ leaseUntil: Date.now() + 600_000 });
    const { generation, fingerprint } = pinned.pinnedAt!;
    const at = await a.segment('y').pinAt({ generation: generation!, fingerprint: fingerprint! });
    for (const h of [pinned, leased, at]) {
      expect(await drain(a.segment('x').intersect([h]))).toEqual([2, 3]);
      expect(await drain(a.segment('x').union([h]))).toEqual([1, 2, 3, 4]);
      expect(await drain(a.segment('x').andNot([h]))).toEqual([1]);
    }
    await a.segment('x').intersectInto(a.segment('dest'), [leased]);
    expect(await drain(a.segment('dest').iterate())).toEqual([2, 3]);
    // A pinned handle passed as the receiver and as a destination's operand is the same store too.
    expect(await drain(pinned.intersect([a.segment('x')]))).toEqual([2, 3]);
    await leased.release();
  });

  it('refuses a pin of another store', async () => {
    const { a, b } = await world();
    const pinned = await b.segment('x').pin();
    const leased = await b.segment('x').pin({ leaseUntil: Date.now() + 600_000 });
    const before = await generationsOf(a, 'dest');
    for (const h of [pinned, leased]) {
      await expect(drain(a.segment('x').intersect([h]))).rejects.toThrow(
        /belongs to another store/,
      );
      await expect(a.segment('x').intersectInto(a.segment('dest'), [h])).rejects.toThrow(
        /belongs to another store/,
      );
      await expect(drain(h.intersect([a.segment('x')]))).rejects.toThrow(
        /belongs to another store/,
      );
    }
    expect(await generationsOf(a, 'dest')).toEqual(before);
    await leased.release();
  });

  it('a message names no segment, namespace or key', async () => {
    const a = new CloudRoaring({ storage: new MemoryStorage() });
    const b = new CloudRoaring({ storage: new MemoryStorage() });
    await a.load({ segment: 'secret-seg', namespace: 'secret-ns' }, [1]);
    await b.load({ segment: 'secret-seg', namespace: 'secret-ns' }, [1]);
    const mine = a.segment('secret-seg', { namespace: 'secret-ns' });
    const theirs = b.segment('secret-seg', { namespace: 'secret-ns' });
    const errs = await Promise.all([
      drain(mine.intersect([theirs])).catch((e: Error) => e),
      mine.intersectInto(mine, [theirs]).catch((e: Error) => e),
      a
        .materializeMany({
          operands: { p: theirs },
          outputs: [{ dest: a.segment('out'), expr: 'p' }],
          keep: 1,
        })
        .catch((e: Error) => e),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as Error).message).not.toMatch(/secret/);
    }
  });
});

describe('materializeMany takes only segments of its own store', () => {
  it('refuses an operand of another store and publishes nothing', async () => {
    const { a, b } = await world();
    const before = await generationsOf(a, 'dest');
    const err = await a
      .materializeMany({
        operands: { ax: a.segment('x'), bx: b.segment('x') },
        outputs: [{ dest: a.segment('dest'), expr: { and: ['ax', 'bx'] } }],
        keep: 1,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      "materializeMany: an operand belongs to another store; combine segments of one store: open each with this store's segment()",
    );
    expect(await generationsOf(a, 'dest')).toEqual(before);
    expect(await drain(a.segment('dest').iterate())).toEqual([9]);
  });

  it('refuses a destination of another store and publishes nothing', async () => {
    const { a, b } = await world();
    const beforeA = await generationsOf(a, 'dest');
    const beforeB = await generationsOf(b, 'dest');
    const err = await a
      .materializeMany({
        operands: { ax: a.segment('x') },
        outputs: [
          { dest: a.segment('dest'), expr: 'ax' },
          { dest: b.segment('dest'), expr: 'ax' },
        ],
        keep: 1,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(
      /^materializeMany: the destination belongs to another store/,
    );
    expect(await generationsOf(a, 'dest')).toEqual(beforeA);
    expect(await generationsOf(b, 'dest')).toEqual(beforeB);
  });

  it('refuses a store object over the same storage, and takes its own pinned handle', async () => {
    const storage = new MemoryStorage();
    const a = new CloudRoaring({ storage });
    const c = new CloudRoaring({ storage });
    await a.load({ segment: 'x' }, [1, 2, 3]);
    await expect(
      a.materializeMany({
        operands: { p: c.segment('x') },
        outputs: [{ dest: a.segment('out'), expr: 'p' }],
        keep: 1,
      }),
    ).rejects.toThrow(/belongs to another store/);
    await a.materializeMany({
      operands: { p: await a.segment('x').pin() },
      outputs: [{ dest: a.segment('out'), expr: 'p' }],
      keep: 1,
    });
    expect(await drain(a.segment('out').iterate())).toEqual([1, 2, 3]);
  });
});
