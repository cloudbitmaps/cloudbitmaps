import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { counting } from '../helpers/counting';

type Seg = ReturnType<CloudRoaring['segment']>;

/**
 * What the combine verbs refuse: a destination that is also one of the call's sources, and an operand list with
 * nothing in it. Both are refused before any request, and neither leaves a trace in the destination.
 */
const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

/** A memory backend whose every storage and registry driver call is counted. */
function counted() {
  const memory = new MemoryStorage();
  const storage: Record<string, number> = {};
  const registry: Record<string, number> = {};
  const backend = brandAsBackend({
    storage: counting<IStorageDriver>(memory.storage, storage),
    registry: counting<IRegistryDriver>(memory.registry, registry),
  });
  return {
    backend,
    calls: () => ({ storage: { ...storage }, registry: { ...registry } }),
    reset: () => {
      for (const c of [storage, registry]) for (const k of Object.keys(c)) delete c[k];
    },
  };
}

const generationsOf = async (s: CloudRoaring, name: string) =>
  (await s.generations({ segment: name })).map((g) => g.generation);

async function world() {
  const c = counted();
  const store = new CloudRoaring({ storage: c.backend });
  await store.load({ segment: 'x' }, [1, 2, 3, 4]);
  await store.load({ segment: 'y' }, [3, 4, 5]);
  await store.load({ segment: 'z' }, [4]);
  c.reset();
  return { store, c };
}

describe('two stores: a combine into its own source does not replace a newer load with a stale result', () => {
  it('intersectInto of a segment into itself is refused, and the other store’s load stands', async () => {
    const backend = new MemoryStorage();
    const a = new CloudRoaring({ storage: backend });
    const b = new CloudRoaring({ storage: backend });
    await a.load({ segment: 'shoppers' }, [1, 2, 3, 4]);
    await a.load({ segment: 'active' }, [1, 2, 3, 4, 5, 6, 7, 8]);
    // `a` resolves the segment, so its view of generation 0 is warm …
    expect(await drain(a.segment('shoppers').iterate())).toEqual([1, 2, 3, 4]);
    // … then another process loads generation 1 within the store's `genTtlMs`.
    await b.load({ segment: 'shoppers' }, [5, 6, 7, 8]);
    const shoppers = a.segment('shoppers');
    const outcome = await shoppers.intersectInto(shoppers, [a.segment('active')]).then(
      (res) => res,
      (err: unknown) => err,
    );
    // Whatever the call did, `b`'s generation is still what readers see.
    const fresh = new CloudRoaring({ storage: backend });
    expect(await drain(fresh.segment('shoppers').iterate())).toEqual([5, 6, 7, 8]);
    expect(outcome).toBeInstanceOf(ValidationError);
    expect(await generationsOf(fresh, 'shoppers')).toEqual([0, 1]);
  });
});

type Call = readonly [string, string, (s: Seg, dest: Seg, other: Seg) => Promise<unknown>];

/** Every verb with its destination as `this`, as an operand and as an exclude. */
const SELF_DESTINATION: readonly Call[] = [
  ['intersectInto', 'this segment', (x, _d, y) => x.intersectInto(x, [y])],
  ['unionInto', 'this segment', (x, _d, y) => x.unionInto(x, [y])],
  ['andNotInto', 'this segment', (x, _d, y) => x.andNotInto(x, [y])],
  ['intersectInto', 'an operand', (x, _d, y) => x.intersectInto(y, [y])],
  ['unionInto', 'an operand', (x, _d, y) => x.unionInto(y, [y])],
  ['andNotInto', 'an exclude', (x, _d, y) => x.andNotInto(y, [y])],
  ['intersectInto', 'an exclude', (x, _d, y) => x.intersectInto(y, [x], { exclude: [y] })],
  ['unionInto', 'an exclude', (x, _d, y) => x.unionInto(y, [x], { exclude: [y] })],
];

describe('an *Into whose destination is also one of its sources is refused', () => {
  it.each(SELF_DESTINATION)('%s with the destination as %s', async (verb, role, call) => {
    const { store, c } = await world();
    const before = { x: await generationsOf(store, 'x'), y: await generationsOf(store, 'y') };
    c.reset();
    const x = store.segment('x');
    const y = store.segment('y');
    const err = await call(x, store.segment('unused'), y).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const named = role === 'this segment' ? 'x' : 'y';
    expect((err as Error).message).toMatch(
      new RegExp(`^${verb}: the destination "${named}" is also ${role} of the call, `),
    );
    expect(c.calls()).toEqual({ storage: {}, registry: {} });
    expect({ x: await generationsOf(store, 'x'), y: await generationsOf(store, 'y') }).toEqual(
      before,
    );
  });

  it('counts the same segment however the handle was made: a second handle, a pin, an explicit namespace', async () => {
    const { store } = await world();
    await store.load({ namespace: 'ns', segment: 'n' }, [1, 2]);
    const pinned = await store.segment('x').pin();
    const spellings: readonly [string, () => Promise<unknown>][] = [
      [
        'a second handle',
        () => store.segment('x').intersectInto(store.segment('x'), [store.segment('y')]),
      ],
      ['a pin as the receiver', () => pinned.unionInto(store.segment('x'), [store.segment('y')])],
      [
        'a pin as the destination',
        () => store.segment('x').unionInto(pinned, [store.segment('y')]),
      ],
      ['a pin as the operand', () => store.segment('y').unionInto(store.segment('x'), [pinned])],
      [
        'a namespace',
        () =>
          store
            .segment('n', { namespace: 'ns' })
            .unionInto(store.segment('n', { namespace: 'ns' }), [store.segment('y')]),
      ],
    ];
    for (const [name, call] of spellings) {
      await expect(call(), name).rejects.toThrow(/the destination ".*" is also /);
    }
    expect(await drain(store.segment('x').iterate())).toEqual([1, 2, 3, 4]);
  });

  it('names the namespace of a destination that has one', async () => {
    const { store } = await world();
    await store.load({ namespace: 'ns', segment: 'n' }, [1, 2]);
    const n = store.segment('n', { namespace: 'ns' });
    await expect(n.unionInto(n, [store.segment('y')])).rejects.toThrow(
      'unionInto: the destination "ns/n" is also this segment of the call',
    );
  });

  it('still writes into a segment that is none of its sources', async () => {
    const { store } = await world();
    const res = await store.segment('x').intersectInto(store.segment('out'), [store.segment('y')]);
    expect(res.published).toBe(true);
    expect(await drain(store.segment('out').iterate())).toEqual([3, 4]);
  });

  it('copies a segment, or a pin of it, into another with the segment as its own operand', async () => {
    const { store } = await world();
    const pinned = await store.segment('x').pin();
    expect((await pinned.unionInto(store.segment('copy'), [pinned])).published).toBe(true);
    expect(await drain(store.segment('copy').iterate())).toEqual([1, 2, 3, 4]);
  });
});

describe('an empty operand list is refused', () => {
  it.each(['intersect', 'union'] as const)(
    '%s([]) throws when first read, as andNot([]) does',
    async (verb) => {
      const { store, c } = await world();
      const what = verb === 'intersect' ? 'intersect with' : 'union with';
      const expected = `${verb} requires at least one segment to ${what}; to read every id of one segment, use iterate()`;
      const x = store.segment('x');
      const stream = x[verb]([]);
      await expect(drain(stream)).rejects.toThrow(expected);
      await expect(drain(x[verb]([], { exclude: [store.segment('z')] }))).rejects.toThrow(expected);
      await expect(drain(x[verb]([]).batches() as never)).rejects.toThrow(ValidationError);
      expect(c.calls()).toEqual({ storage: {}, registry: {} });
      await expect(drain(x.andNot([]))).rejects.toThrow(
        'andNot requires at least one segment to subtract',
      );
    },
  );

  it.each(['intersectInto', 'unionInto'] as const)(
    '%s(dest, []) is refused before any request and leaves dest alone',
    async (verb) => {
      const { store, c } = await world();
      const what = verb === 'intersectInto' ? 'intersect with' : 'union with';
      const before = await generationsOf(store, 'y');
      c.reset();
      await expect(store.segment('x')[verb](store.segment('y'), [])).rejects.toThrow(
        `${verb} requires at least one segment to ${what}; to read every id of one segment, use iterate()`,
      );
      await expect(
        store.segment('x')[verb](store.segment('y'), [], { exclude: [store.segment('z')] }),
      ).rejects.toThrow(ValidationError);
      expect(c.calls()).toEqual({ storage: {}, registry: {} });
      expect(await generationsOf(store, 'y')).toEqual(before);
    },
  );

  it('andNotInto(dest, []) is refused as it was', async () => {
    const { store } = await world();
    await expect(store.segment('x').andNotInto(store.segment('y'), [])).rejects.toThrow(
      'andNot requires at least one segment to subtract',
    );
  });
});

describe('a bad range or count names the verb that was asked', () => {
  const BOUND = 'must be an integer from 0 to 4294967295';

  it.each(['after', 'through'] as const)(
    'a bad `%s` is prefixed with its verb, on every verb that takes a range',
    async (bound) => {
      const { store } = await world();
      const x = store.segment('x');
      const y = store.segment('y');
      const pinned = await x.pin();
      const opts = { [bound]: -1 };
      const calls: readonly [string, () => Promise<unknown>][] = [
        ['iterate', () => drain(x.iterate(opts))],
        ['iterate', () => drain(x.iterate(opts).batches() as never)],
        ['intersect', () => drain(x.intersect([y], opts))],
        ['union', () => drain(x.union([y], opts))],
        ['andNot', () => drain(x.andNot([y], opts))],
        ['everyNth', () => drain(pinned.everyNth(2, opts))],
        ['intersect', () => x.intersectInto(store.segment('out'), [y], opts)],
        [
          'materializeMany',
          () =>
            store.materializeMany({
              operands: { x, y },
              outputs: [{ dest: store.segment('out'), expr: { and: ['x', 'y'] } }],
              keep: 0,
              ...opts,
            }),
        ],
      ];
      for (const [verb, call] of calls) {
        await expect(call(), verb).rejects.toThrow(`${verb}: ${bound} ${BOUND}`);
      }
    },
  );

  it('a bad `n` and a bad `concurrency` are prefixed the same way', async () => {
    const { store } = await world();
    const x = store.segment('x');
    const y = store.segment('y');
    const pinned = await x.pin();
    await expect(drain(pinned.everyNth(0))).rejects.toThrow(
      'everyNth: n must be an integer of at least 1; got 0',
    );
    const concurrency = 0;
    for (const verb of ['intersect', 'union'] as const) {
      await expect(drain(x[verb]([y], { concurrency }))).rejects.toThrow(
        `${verb}: concurrency must be an integer of at least 1; got 0`,
      );
    }
    await expect(drain(x.andNot([y], { concurrency }))).rejects.toThrow(
      'andNot: concurrency must be an integer of at least 1; got 0',
    );
    await expect(
      store.materializeMany({
        operands: { x, y },
        outputs: [{ dest: store.segment('out'), expr: { and: ['x', 'y'] } }],
        keep: 0,
        concurrency,
      }),
    ).rejects.toThrow('materializeMany: concurrency must be an integer from 1 to 1024; got 0');
  });

  it('absent operands are named in the plural for two and the singular for one', async () => {
    const { store } = await world();
    const x = store.segment('x');
    await expect(drain(x.union([store.segment('g1'), store.segment('g2')]))).rejects.toThrow(
      /^union: operands "g1", "g2" name segments that do not exist or were dropped, so they would contribute nothing/,
    );
    await expect(drain(x.union([store.segment('g1')]))).rejects.toThrow(
      /^union: operand "g1" names a segment that does not exist or was dropped, so it would contribute nothing/,
    );
    await expect(
      store.materializeMany({
        operands: { g1: store.segment('g1'), g2: store.segment('g2') },
        outputs: [{ dest: store.segment('out'), expr: { or: ['g1', 'g2'] } }],
        keep: 0,
      }),
    ).rejects.toThrow(/^materializeMany: operands "g1", "g2" name segments that do not exist/);
  });
});

describe('pinAt takes a pin’s record whole', () => {
  it('reopens the generation a numbered pinnedAt names, version and all', async () => {
    const { store } = await world();
    const first = await store.segment('x').pin();
    const at = first.pinnedAt!;
    expect(at.generation).toBe(0);
    const again = await store.segment('x').pinAt(at as never);
    expect(await drain(again.iterate())).toEqual([1, 2, 3, 4]);
    expect(again.pinnedAt).toEqual(at);
  });

  it('refuses a version that is not a string, and says pinAt takes the three fields', async () => {
    const { store } = await world();
    const at = (await store.segment('x').pin()).pinnedAt!;
    await expect(store.segment('x').pinAt({ ...at, version: 7 } as never)).rejects.toThrow(
      /^pinAt: pass \{ generation, fingerprint \}/,
    );
    await expect(
      store.segment('x').pinAt({ generation: 0, fingerprint: at.fingerprint!, extra: 1 } as never),
    ).rejects.toThrow(
      'pinAt: unknown option "extra"; pinAt takes { generation, fingerprint } only',
    );
  });

  it('says there is nothing to reopen for a pin of a segment with no generation', async () => {
    const { store } = await world();
    const never = await store.segment('never-loaded').pin();
    expect(never.pinnedAt).toEqual({ generation: null, version: null, fingerprint: null });
    await expect(store.segment('x').pinAt(never.pinnedAt as never)).rejects.toThrow(
      'pinAt: the pin named no generation (the segment had none when it was pinned), so there is nothing to reopen',
    );
  });
});
