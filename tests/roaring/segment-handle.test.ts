import { runInNewContext } from 'node:vm';
import { CloudRoaring, MemoryStorage, Segment, ValidationError } from '@/index';

/**
 * A `Segment` is not constructible: a handle is wired to the store's engine, caches and write path, so it comes
 * from `store.segment()` or `seg.pin()`. The class stays exported for `instanceof` and for annotating a variable.
 * `Segment`'s constructor is private in the types, so each call below goes through a cast, as plain JavaScript would.
 */
const construct = Segment as unknown as new (...args: unknown[]) => Segment;

describe('a Segment handle is not constructible', () => {
  it('throws ValidationError for `new Segment(...)`, whatever it is given', () => {
    expect(() => new construct()).toThrow(ValidationError);
    expect(() => new construct({})).toThrow(ValidationError);
    // the positional shape the constructor took before it became private
    expect(
      () =>
        new construct(
          {},
          { segment: 's' },
          {},
          {},
          () => 0,
          () => 0,
          () => 0,
        ),
    ).toThrow(/not constructed directly/);
  });

  it('throws for a subclass and for Reflect.construct', () => {
    class Sub extends construct {}
    expect(() => new Sub({})).toThrow(ValidationError);
    expect(() => Reflect.construct(construct, [{}])).toThrow(ValidationError);
  });

  it('still refuses after the store has minted handles, so the store path leaves no door open', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    const live = store.segment('s');
    expect(() => new construct({})).toThrow(ValidationError);
    await store.load({ segment: 's' }, [1, 2, 3]);
    const pinned = await live.pin();
    expect(() => new construct({})).toThrow(ValidationError);
    expect(live).toBeInstanceOf(Segment);
    expect(pinned).toBeInstanceOf(Segment);
    expect(await pinned.count()).toBe(3);
  });

  it('key() is equal across a handle and its pin, and differs by segment and namespace', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 's' }, [1]);
    const live = store.segment('s');
    const pinned = await live.pin();
    expect(pinned.key()).toBe(live.key());
    expect(store.segment('t').key()).not.toBe(live.key());
    expect(store.segment('s', { namespace: 'ns' }).key()).not.toBe(live.key());
  });
});

describe('a handle takes no deadline', () => {
  const MESSAGE = 'segment: unknown option "expiresAt"; a handle takes { namespace } only';
  /** `expiresAt` is not in `SegmentOptions`, so each call goes through a cast, as plain JavaScript would. */
  const segmentOf = (store: CloudRoaring, options: unknown): Segment =>
    store.segment('s', options as Parameters<CloudRoaring['segment']>[1]);

  it('refuses an `expiresAt` with ValidationError, whatever its value, rather than ignore it', () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    for (const expiresAt of [Date.now() + 86_400_000, Date.now() - 86_400_000, 0, null, 'soon']) {
      expect(() => segmentOf(store, { expiresAt })).toThrow(ValidationError);
      expect(() => segmentOf(store, { namespace: 'ns', expiresAt })).toThrow(MESSAGE);
    }
  });

  it('refuses an `expiresAt` no scan of plain own keys would see: inherited, non-enumerable, or a getter of a class', () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    const deadline = Date.now() + 86_400_000;
    const notEnumerable = Object.defineProperty({}, 'expiresAt', {
      value: deadline,
      enumerable: false,
    });
    class Options {
      get expiresAt(): number {
        return deadline;
      }
    }
    expect(() => segmentOf(store, notEnumerable)).toThrow(MESSAGE);
    for (const options of [Object.create({ expiresAt: deadline }), new Options()]) {
      expect(() => segmentOf(store, options)).toThrow(ValidationError);
      expect(() => segmentOf(store, options)).toThrow(/options must be a plain object/);
    }
  });

  it('takes a plain object of any realm, and one with no prototype', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 's', namespace: 'ns' }, [1, 2, 3]);
    const otherRealm = runInNewContext('({ namespace: "ns" })') as unknown;
    const noPrototype = Object.assign(Object.create(null) as object, { namespace: 'ns' });
    for (const options of [{ namespace: 'ns' }, otherRealm, noPrototype]) {
      expect(await segmentOf(store, options).count()).toBe(3);
    }
  });

  it('reads as any handle does with `expiresAt` absent or undefined', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 's' }, [1, 2, 3]);
    expect(await segmentOf(store, { expiresAt: undefined }).count()).toBe(3);
    expect(await store.segment('s', {}).count()).toBe(3);
  });
});

describe('a handle takes { namespace } only', () => {
  it('refuses a misspelt option by name, rather than address the default namespace', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'x' }, [1, 2, 3]);
    const options = { nameSpace: 'tenant' } as unknown as { namespace?: string };
    expect(() => store.segment('x', options)).toThrow(ValidationError);
    expect(() => store.segment('x', options)).toThrow(
      'segment: unknown option "nameSpace"; a handle takes { namespace } only',
    );
  });

  it('refuses options that are not an object, such as a namespace passed on its own', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    await store.load({ namespace: 'tenant', segment: 'a' }, [1]);
    for (const bad of ['tenant', 5, ['tenant']]) {
      expect(() => store.segment('a', bad as never)).toThrow(
        'segment: options must be an object such as { namespace }',
      );
    }
    expect(await store.segment('a', { namespace: 'tenant' }).count()).toBe(1);
  });

  it('still takes absent, null and undefined-valued options, so a spread of options keeps working', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    const spread = { namespace: undefined, other: undefined } as unknown as { namespace?: string };
    expect(await store.segment('a').count()).toBe(3);
    expect(await store.segment('a', null as never).count()).toBe(3);
    expect(await store.segment('a', spread).count()).toBe(3);
  });
});

describe('an operand list holds segments only', () => {
  const NOT_SEGMENTS: readonly unknown[] = [null, 5, {}, 'a'];
  const message = 'an operand must be a segment from store.segment()';

  it('every combine and *Into refuses a value that is not a segment, before reading anything', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    await store.load({ segment: 'dest' }, [9]);
    const a = store.segment('a');
    const dest = store.segment('dest');
    for (const bad of NOT_SEGMENTS) {
      const x = bad as Segment;
      const drain = async (it: AsyncIterable<number>) => {
        for await (const _ of it) void _;
      };
      await expect(drain(a.intersect([x]))).rejects.toThrow(message);
      await expect(drain(a.union([x]))).rejects.toThrow(message);
      await expect(drain(a.andNot([x]))).rejects.toThrow(message);
      await expect(drain(a.intersect([a], { exclude: [x] }))).rejects.toThrow(message);
      await expect(drain(a.union([a], { exclude: [x] }))).rejects.toThrow(message);
      await expect(a.intersectInto(dest, [x])).rejects.toThrow(message);
      await expect(a.unionInto(dest, [x])).rejects.toThrow(message);
      await expect(a.andNotInto(dest, [x])).rejects.toThrow(message);
      await expect(a.intersectInto(x, [a])).rejects.toThrow(message);
      await expect(a.intersectInto(dest, [x])).rejects.toBeInstanceOf(ValidationError);
    }
    // No refused call wrote the destination.
    expect((await store.generations({ segment: 'dest' })).length).toBe(1);
  });
});

describe('an operand list is an array', () => {
  const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
    const ids: number[] = [];
    for await (const id of it) ids.push(id);
    return ids;
  };

  async function fixture() {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3, 4, 5]);
    await store.load({ segment: 'b' }, [2, 3, 4, 5, 6]);
    await store.load({ segment: 'opt' }, [3, 4]);
    await store.load({ segment: 'dest' }, [9]);
    return {
      store,
      a: store.segment('a'),
      b: store.segment('b'),
      opt: store.segment('opt'),
      dest: store.segment('dest'),
    };
  }

  it('refuses a list of operands that is not an array, with ValidationError, before reading anything', async () => {
    const { store, a, b, dest } = await fixture();
    // A single segment where a list belongs, a Set, a string and nothing: each is a plain-JavaScript slip.
    for (const bad of [b, new Set([b]), 'b', undefined]) {
      const list = bad as unknown as Segment[];
      await expect(drain(a.intersect(list))).rejects.toThrow(
        'intersect: `others` must be an array of segments',
      );
      await expect(drain(a.union(list))).rejects.toThrow(
        'union: `others` must be an array of segments',
      );
      await expect(drain(a.andNot(list))).rejects.toThrow(
        'andNot: `excludes` must be an array of segments',
      );
      await expect(a.intersectInto(dest, list)).rejects.toThrow(
        'intersectInto: `others` must be an array of segments',
      );
      await expect(a.unionInto(dest, list)).rejects.toThrow(
        'unionInto: `others` must be an array of segments',
      );
      await expect(a.andNotInto(dest, list)).rejects.toThrow(
        'andNotInto: `excludes` must be an array of segments',
      );
      await expect(a.intersectInto(dest, list)).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await store.generations({ segment: 'dest' })).length).toBe(1);
  });

  it('refuses an `exclude` that is not an array, rather than dropping it and returning the excluded ids', async () => {
    const { store, a, b, opt, dest } = await fixture();
    for (const bad of [new Set([opt]), opt, 'opt']) {
      const exclude = bad as unknown as Segment[];
      const message = '`exclude` must be an array of segments';
      await expect(drain(a.intersect([b], { exclude }))).rejects.toThrow(message);
      await expect(drain(a.union([b], { exclude }))).rejects.toThrow(message);
      await expect(a.intersectInto(dest, [b], { exclude, allowEmpty: true })).rejects.toThrow(
        message,
      );
      await expect(a.unionInto(dest, [b], { exclude, allowEmpty: true })).rejects.toThrow(message);
      await expect(drain(a.intersect([b], { exclude }))).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await drain(store.segment('dest').iterate())).toEqual([9]);
  });

  it('still reads an empty, null or absent `exclude` as none, and an array as the list', async () => {
    const { a, b, opt } = await fixture();
    for (const exclude of [[], null, undefined]) {
      const options = { exclude } as unknown as { exclude?: Segment[] };
      expect(await drain(a.intersect([b], options))).toEqual([2, 3, 4, 5]);
    }
    expect(await drain(a.intersect([b], { exclude: [opt] }))).toEqual([2, 5]);
    expect(await drain(a.union([b], { exclude: [opt] }))).toEqual([1, 2, 5, 6]);
  });
});
