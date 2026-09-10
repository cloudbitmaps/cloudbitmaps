import { MIN_EXPIRES_AT_MS, ValidationError, type Clock } from '@/index';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * **A materialisation involving an expired handle is refused, not silently turned into a wipe.**
 *
 * WHY THIS FILE EXISTS. Lazy expiry is a *read* rule: past its deadline a handle answers `has: false`, `count: 0`
 * and an empty `iterate`, with no I/O. Applied unchanged to a *write*, that rule is destructive — the `*Into`
 * verbs publish a new generation of their destination, so `a.intersectInto(dest, [b])` where `b`'s deadline has
 * quietly passed writes an **empty generation over `dest`** and reports it as a successful write. Nothing in the
 * result mentions a deadline; the caller sees `cardinality: 0` and a fresh generation number, which is exactly
 * what a legitimately-empty intersection looks like.
 *
 * The two behaviours therefore have to differ, and the tests below pin the difference: the read verbs still
 * degrade to empty (that is the feature), and the three write verbs refuse with a message naming the expired
 * segments. The broader guard — refusing to publish an empty generation over a non-empty one, with an
 * `allowEmpty` override — belongs to `load()`; this is the narrow case that is unambiguously a mistake.
 */

/** A clock the test drives, so "expired" is a fact about the test rather than about wall-clock timing. */
function fakeClock(): Clock & { set: (ms: number) => void } {
  let t = MIN_EXPIRES_AT_MS;
  return {
    now: () => t,
    sleep: () => Promise.resolve(),
    set: (ms) => {
      t = ms;
    },
  };
}

const PAST = MIN_EXPIRES_AT_MS + 1_000;
const FUTURE = MIN_EXPIRES_AT_MS + 1_000_000;

describe('the *Into verbs refuse an expired handle instead of publishing over the destination', () => {
  it('refuses when an OPERAND has expired, and leaves the destination untouched', async () => {
    const clock = fakeClock();
    const { store, registry } = await loadedStore(
      { a: [1, 2, 3], b: [2, 3, 4], dest: [9] },
      { clock, coldGenTtlMs: 0 },
    );
    clock.set(PAST + 1); // b's deadline has passed
    const a = store.segment('a');
    const b = store.segment('b', { expiresAt: PAST });
    const dest = store.segment('dest');

    await expect(a.intersectInto(dest, [b])).rejects.toBeInstanceOf(ValidationError);
    await expect(a.intersectInto(dest, [b])).rejects.toThrow(/expired/);
    await expect(a.intersectInto(dest, [b])).rejects.toThrow(/\bb\b/); // names the segment at fault

    // The destination still holds generation 0 — the refusal happened before any write.
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    expect(await collect(dest.iterate())).toEqual([9]);
  });

  it('refuses when THIS handle has expired', async () => {
    const clock = fakeClock();
    const { store, registry } = await loadedStore(
      { a: [1, 2], b: [2], dest: [9] },
      { clock, coldGenTtlMs: 0 },
    );
    clock.set(PAST + 1);
    const expiredSource = store.segment('a', { expiresAt: PAST });
    await expect(
      expiredSource.intersectInto(store.segment('dest'), [store.segment('b')]),
    ).rejects.toThrow(/\ba\b/);
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
  });

  it('refuses when the DESTINATION handle has expired — a contradiction worth surfacing', async () => {
    const clock = fakeClock();
    const { store } = await loadedStore({ a: [1, 2], b: [2] }, { clock, coldGenTtlMs: 0 });
    clock.set(PAST + 1);
    const dest = store.segment('dest', { expiresAt: PAST });
    await expect(store.segment('a').intersectInto(dest, [store.segment('b')])).rejects.toThrow(
      /expired/,
    );
  });

  it('refuses when an EXCLUDE operand has expired (suppression that silently stopped suppressing)', async () => {
    const clock = fakeClock();
    const { store } = await loadedStore(
      { a: [1, 2, 3], b: [1, 2, 3], suppress: [2] },
      { clock, coldGenTtlMs: 0 },
    );
    clock.set(PAST + 1);
    await expect(
      store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')], {
        exclude: [store.segment('suppress', { expiresAt: PAST })],
      }),
    ).rejects.toThrow(/suppress/);
  });

  it('refuses for unionInto and andNotInto on the same rule', async () => {
    const clock = fakeClock();
    const { store } = await loadedStore({ a: [1], b: [2], dest: [9] }, { clock, coldGenTtlMs: 0 });
    clock.set(PAST + 1);
    const dest = store.segment('dest');
    const expiredB = store.segment('b', { expiresAt: PAST });
    await expect(store.segment('a').unionInto(dest, [expiredB])).rejects.toThrow(/unionInto/);
    await expect(store.segment('a').andNotInto(dest, [expiredB])).rejects.toThrow(/andNotInto/);
  });

  it('names EVERY expired handle in one message, deduplicated, and namespace-qualified', async () => {
    const clock = fakeClock();
    const { store, load } = await loadedStore({ b: [1], dest: [9] }, { clock, coldGenTtlMs: 0 });
    await load({ namespace: 'acme', segment: 'c' }, [1]); // a namespaced operand, to prove the qualification
    clock.set(PAST + 1);
    // `b` twice — the operand list and the exclude list both carry it — and once is enough in the message.
    // `c` lives in a namespace, and a bare segment name would be ambiguous across tenants, so it is qualified.
    const message = await store
      .segment('b', { expiresAt: PAST })
      .intersectInto(store.segment('dest'), [store.segment('b', { expiresAt: PAST })], {
        exclude: [store.segment('c', { namespace: 'acme', expiresAt: PAST })],
      })
      .then(
        () => 'no error',
        (err: unknown) => (err as Error).message,
      );
    expect(message).toContain('— b, acme/c.');
    expect(message.match(/\bb\b/g)?.length).toBe(1);
  });

  it('does NOT refuse when nothing has expired, or once the deadline is in the future again', async () => {
    const clock = fakeClock();
    const { store } = await loadedStore({ a: [1, 2, 3], b: [2, 3] }, { clock, coldGenTtlMs: 0 });
    const result = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b', { expiresAt: FUTURE })]);
    expect(result.cardinality).toBe(2);
    expect(await collect(store.segment('dest').iterate())).toEqual([2, 3]);
  });

  it('leaves the READ verbs alone — an expired operand still degrades to empty, silently and cheaply', async () => {
    const clock = fakeClock();
    const { store } = await loadedStore({ a: [1, 2, 3], b: [2, 3] }, { clock, coldGenTtlMs: 0 });
    clock.set(PAST + 1);
    const a = store.segment('a');
    const expiredB = store.segment('b', { expiresAt: PAST });
    expect(await collect(a.intersect([expiredB]))).toEqual([]); // AND with the empty set
    expect(await expiredB.count()).toBe(0);
    expect(await expiredB.has(2)).toBe(false);
    expect(await collect(a.andNot([expiredB]))).toEqual([1, 2, 3]); // excludes nothing
  });
});
