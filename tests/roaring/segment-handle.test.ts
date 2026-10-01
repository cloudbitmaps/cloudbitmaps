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
