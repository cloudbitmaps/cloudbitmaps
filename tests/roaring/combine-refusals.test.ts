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

  it('writes into the same name in another namespace, and into the default-namespace spelling _default', async () => {
    const { store } = await world();
    await store.load({ namespace: 'ns', segment: 'x' }, [9]);
    await store.load({ namespace: '_default', segment: 'x' }, [8]);
    const x = store.segment('x');
    const y = store.segment('y');
    for (const other of [
      store.segment('x', { namespace: 'ns' }),
      store.segment('x', { namespace: '_default' }),
    ]) {
      const res = await x.intersectInto(other, [y]);
      expect(res.published).toBe(true);
      expect(await drain(other.iterate())).toEqual([3, 4]);
      expect(await drain(x.iterate())).toEqual([1, 2, 3, 4]);
    }
  });

  it('copies a segment, or a pin of it, with materializeMany and one operand', async () => {
    const { store } = await world();
    const pinned = await store.segment('x').pin();
    await store.materializeMany({
      operands: { src: pinned },
      outputs: [{ dest: store.segment('copy'), expr: { or: ['src'] } }],
      keep: 2,
    });
    expect(await drain(store.segment('copy').iterate())).toEqual([1, 2, 3, 4]);
  });
});

describe('a copy of a live segment is of one generation', () => {
  it('materializeMany with one operand reads one instant while a load lands mid-copy', async () => {
    const CHUNKS = 400;
    const gen0: number[] = [];
    const gen1: number[] = [];
    for (let c = 0; c < CHUNKS; c++)
      for (let i = 0; i < 3000; i++) {
        gen0.push(c * 65536 + i * 20);
        gen1.push(c * 65536 + i * 20 + 1);
      }
    const mem = new MemoryStorage();
    let hook: (() => Promise<void>) | undefined;
    let ranges = 0;
    const storage = new Proxy(mem.storage, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver) as unknown;
        if (typeof v !== 'function') return v;
        if (key !== 'getRange') return (v as (...a: unknown[]) => unknown).bind(target);
        return async (...a: unknown[]) => {
          ranges++;
          if (hook !== undefined && ranges === 2) {
            const h = hook;
            hook = undefined;
            await h();
          }
          return (v as (...a: unknown[]) => unknown).apply(target, a);
        };
      },
    });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: storage as IStorageDriver, registry: mem.registry }),
    });
    await store.load({ segment: 'src' }, gen0);
    hook = async () => {
      await store.load({ segment: 'src' }, gen1);
    };
    const src = store.segment('src');
    await store.materializeMany({
      operands: { src },
      outputs: [{ dest: store.segment('dest'), expr: { or: ['src'] } }],
      keep: 1,
      concurrency: 1,
    });
    expect(hook, 'the load landed during the copy').toBeUndefined();
    const out = await drain(new CloudRoaring({ storage: mem }).segment('dest').iterate());
    const generation = (id: number) => ((id % 65536) % 20 === 0 ? 0 : 1);
    expect(new Set(out.map(generation)).size).toBe(1);
    expect(out).toHaveLength(gen0.length);
  }, 60_000);
});

describe('an empty operand list', () => {
  it('is refused by intersect, when first read, with no request', async () => {
    const { store, c } = await world();
    const expected =
      'intersect requires at least one segment to intersect with; to read every id of one segment, use iterate()';
    const x = store.segment('x');
    await expect(drain(x.intersect([]))).rejects.toThrow(expected);
    await expect(drain(x.intersect([], { exclude: [store.segment('z')] }))).rejects.toThrow(
      expected,
    );
    await expect(drain(x.intersect([]).batches() as never)).rejects.toThrow(ValidationError);
    expect(c.calls()).toEqual({ storage: {}, registry: {} });
  });

  it('is refused by intersectInto before any request, and the message points a copier at materializeMany', async () => {
    const { store, c } = await world();
    const before = await generationsOf(store, 'y');
    c.reset();
    await expect(store.segment('x').intersectInto(store.segment('y'), [])).rejects.toThrow(
      /^intersectInto requires at least one segment to intersect with; to copy this segment into dest, call materializeMany\(\{ operands: \{ src: thisSegment \}/,
    );
    expect(c.calls()).toEqual({ storage: {}, registry: {} });
    expect(await generationsOf(store, 'y')).toEqual(before);
  });

  it('reads the receiver itself for union and andNot, streamed and into a destination', async () => {
    const { store } = await world();
    const x = store.segment('x');
    expect(await drain(x.union([]))).toEqual([1, 2, 3, 4]);
    expect(await drain(x.andNot([]))).toEqual([1, 2, 3, 4]);
    expect(await drain(x.union([], { exclude: [store.segment('z')] }))).toEqual([1, 2, 3]);
    expect((await x.unionInto(store.segment('u'), [])).published).toBe(true);
    expect(await drain(store.segment('u').iterate())).toEqual([1, 2, 3, 4]);
    expect((await x.andNotInto(store.segment('a'), [])).published).toBe(true);
    expect(await drain(store.segment('a').iterate())).toEqual([1, 2, 3, 4]);
    // The destination still cannot be the receiver.
    await expect(x.andNotInto(x, [])).rejects.toThrow(
      /^andNotInto: the destination "x" is also this segment/,
    );
  });

  it('keeps the retention guide’s head-and-tail union working for a window of one day', async () => {
    const { store } = await world();
    const days = ['x'].map((d) => store.segment(d));
    expect(await drain(days[0]!.union(days.slice(1), { allowAbsentOperands: true }))).toEqual([
      1, 2, 3, 4,
    ]);
    const window = store.segment('active-7d', { namespace: 'windows' });
    expect(
      (await days[0]!.unionInto(window, days.slice(1), { allowAbsentOperands: true })).published,
    ).toBe(true);
    expect(await drain(window.iterate())).toEqual([1, 2, 3, 4]);
  });
});

describe('a load of ids read from the segment it writes is refused', () => {
  async function twoStores() {
    const backend = new MemoryStorage();
    const a = new CloudRoaring({ storage: backend });
    const b = new CloudRoaring({ storage: backend });
    await a.load({ segment: 'x' }, [1, 2, 3, 4]);
    await a.load({ segment: 'active' }, [1, 2, 3, 4, 5, 6, 7, 8]);
    await a.load({ segment: 'extra' }, [100]);
    await a.load({ segment: 'optout' }, [1]);
    // `a` resolves x, then another store loads a newer generation within `genTtlMs`.
    await drain(a.segment('x').iterate());
    await b.load({ segment: 'x' }, [5, 6, 7, 8]);
    return { backend, a };
  }

  const READS: readonly [string, (a: CloudRoaring) => AsyncIterable<number>][] = [
    ['intersect', (a) => a.segment('x').intersect([a.segment('active')])],
    ['union', (a) => a.segment('x').union([a.segment('extra')])],
    ['andNot', (a) => a.segment('x').andNot([a.segment('optout')])],
    ['iterate', (a) => a.segment('x').iterate()],
    ['an operand', (a) => a.segment('active').intersect([a.segment('x')])],
    [
      'an exclude',
      (a) => a.segment('active').intersect([a.segment('active')], { exclude: [a.segment('x')] }),
    ],
  ];

  it.each(READS)(
    'load(x, <%s of x>) is refused and the other store’s load stands',
    async (_name, read) => {
      const { backend, a } = await twoStores();
      const outcome = await a.load({ segment: 'x' }, read(a)).then(
        (r) => r,
        (e: unknown) => e,
      );
      const fresh = new CloudRoaring({ storage: backend });
      expect(await drain(fresh.segment('x').iterate())).toEqual([5, 6, 7, 8]);
      expect(outcome).toBeInstanceOf(ValidationError);
      expect((outcome as Error).message).toMatch(
        /^load: the ids come from a read of the segment "x" that is being loaded/,
      );
      expect((outcome as Error).message).toContain('This release has no fenced in-place update');
    },
  );

  it('refuses everyNth of a pin of x loaded into x', async () => {
    const { a } = await twoStores();
    const pinned = await a.segment('x').pin();
    await expect(a.load({ segment: 'x' }, pinned.everyNth(1))).rejects.toThrow(ValidationError);
  });

  it('loads a copy of the same-named segment from a store over another backend, and refuses a store over the same backend instance', async () => {
    const { backend, a } = await twoStores();
    const other = new CloudRoaring({ storage: new MemoryStorage() });
    await other.load({ segment: 'x' }, [40, 41]);
    expect((await a.load({ segment: 'x' }, other.segment('x').iterate())).published).toBe(true);
    expect(
      (await a.load({ segment: 'x' }, other.segment('x').intersect([other.segment('x')])))
        .published,
    ).toBe(true);
    const sibling = new CloudRoaring({ storage: backend });
    await expect(a.load({ segment: 'x' }, sibling.segment('x').iterate())).rejects.toThrow(
      ValidationError,
    );
  });

  it('an *Into range error names the *Into verb', async () => {
    const { store } = await world();
    const x = store.segment('x');
    for (const verb of ['intersectInto', 'unionInto', 'andNotInto'] as const) {
      await expect(
        x[verb](store.segment('out'), [store.segment('y')], { after: -1 }),
      ).rejects.toThrow(`${verb}: after must be an integer from 0 to 4294967295`);
    }
    await expect(
      x.intersectInto(store.segment('out'), [store.segment('y')], { concurrency: 0 }),
    ).rejects.toThrow('intersectInto: concurrency must be an integer of at least 1; got 0');
  });

  it('still loads ids read from another segment, or a stream the caller wrapped', async () => {
    const { a } = await twoStores();
    expect((await a.load({ segment: 'y' }, a.segment('active').iterate())).published).toBe(true);
    async function* wrapped() {
      yield* a.segment('x').iterate();
    }
    expect((await a.load({ segment: 'x' }, wrapped())).published).toBe(true);
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
        ['intersectInto', () => x.intersectInto(store.segment('out'), [y], opts)],
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

  it('refuses a version that is not a string with a message of its own, and names version among the keys', async () => {
    const { store } = await world();
    const at = (await store.segment('x').pin()).pinnedAt!;
    await expect(store.segment('x').pinAt({ ...at, version: 7 } as never)).rejects.toThrow(
      /^pinAt: `version`, when given, is the string a pin recorded/,
    );
    await expect(
      store.segment('x').pinAt({ generation: 0, fingerprint: at.fingerprint!, extra: 1 } as never),
    ).rejects.toThrow(
      'pinAt: unknown option "extra"; pinAt takes { generation, fingerprint } and a pin\'s `version`, which it does not read',
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
