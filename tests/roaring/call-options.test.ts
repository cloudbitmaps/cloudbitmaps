import { CloudRoaring, MIN_EXPIRES_AT_MS, MemoryStorage, ValidationError } from '@/index';
import type { ExportSink, Segment } from '@/index';

/**
 * Every call's options, as plain JavaScript passes them. A bag that is not an object, or a key the call does not take,
 * used to read as no option at all, and that silently widened what the call did: a string scope listed or swept every
 * namespace, a `dryRun: 'true'` deleted, a guard bound written one level too high was never applied. Each is refused
 * now, with a `ValidationError` naming what is wrong, before anything is read or written; `undefined`, `null` and a
 * key whose value is `undefined` still read as absent, so a spread of options keeps working.
 */

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;

async function world() {
  const clock = { now: () => T0, sleep: (): Promise<void> => Promise.resolve() };
  const store = new CloudRoaring({ storage: new MemoryStorage(), seams: { clock } });
  await store.load({ segment: 'a' }, [1, 2, 3]);
  await store.load({ segment: 'b' }, [2, 3, 4]);
  await store.load({ namespace: 'tenantB', segment: 'old' }, [5]);
  await store.setRetention({ namespace: 'tenantB', segment: 'old' }, { expiresAt: T0 - DAY });
  return { store, a: store.segment('a'), b: store.segment('b') };
}

const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
  const ids: number[] = [];
  for await (const id of it) ids.push(id);
  return ids;
};

describe('a destructive call refuses a switch that is not a boolean', () => {
  it('retireExpired and dropSegment with dryRun: "true" delete nothing', async () => {
    const { store } = await world();
    await expect(store.retireExpired({ dryRun: 'true' as never })).rejects.toThrow(
      'retireExpired: `dryRun` must be a boolean',
    );
    await expect(
      store.dropSegment({ segment: 'a' }, { confirmSegment: 'a', dryRun: 'true' as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.retireExpired({ purgeTombstones: 'false' as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.segment('a').count()).toBe(3);
    expect(await store.segment('old', { namespace: 'tenantB' }).count()).toBe(1);
  });

  it('dropSegment without its options is a ValidationError, not a TypeError', async () => {
    const { store } = await world();
    await expect(store.dropSegment({ segment: 'a' }, undefined as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('options that are not an object are refused, where they widened the call', () => {
  it('a namespace passed on its own lists, exports, sweeps or checks nothing', async () => {
    const { store } = await world();
    expect(() => store.segments('tenantA' as never)).toThrow(ValidationError);
    const sink = {} as ExportSink;
    await expect(store.exportSegments(sink, 'tenantA' as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(store.retireExpired('tenantB' as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(store.checkConsistency('ns1' as never)).rejects.toBeInstanceOf(ValidationError);
    expect(await store.segment('old', { namespace: 'tenantB' }).count()).toBe(1);
  });

  it('a read or combine given a number for its options fails rather than reading everything', async () => {
    const { a, b } = await world();
    await expect(drain(a.iterate(5 as never))).rejects.toBeInstanceOf(ValidationError);
    await expect(drain(a.intersect([b], 5 as never))).rejects.toBeInstanceOf(ValidationError);
    await expect(drain(a.union([b], 'x' as never))).rejects.toBeInstanceOf(ValidationError);
    await expect(drain(a.andNot([b], [1] as never))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('a key a call does not take is refused by name', () => {
  it('a guard bound written one level too high does not publish the load it was meant to refuse', async () => {
    const { store } = await world();
    await expect(store.load({ segment: 'a' }, [1], { minRetained: 0.5 } as never)).rejects.toThrow(
      'load: unknown option "minRetained"',
    );
    await expect(
      store.load({ segment: 'a' }, [1], { guard: { minRetained: 0.5, bogus: 1 } as never }),
    ).rejects.toThrow('guard: unknown option "bogus"');
    expect(await store.segment('a').count()).toBe(3);
  });

  it('a misspelt read or combine option fails the call', async () => {
    const { a, b } = await world();
    await expect(drain(a.iterate({ from: 2 } as never))).rejects.toThrow(
      'iterate: unknown option "from"',
    );
    await expect(drain(a.intersect([b], { concurency: 4 } as never))).rejects.toThrow(
      'intersect: unknown option "concurency"',
    );
    const dest: Segment = a;
    await expect(a.intersectInto(dest, [b], { allowEmpty: 'yes' } as never)).rejects.toThrow(
      'intersectInto: `allowEmpty` must be a boolean',
    );
  });
});

describe('absent options still read as none', () => {
  it('undefined, null and undefined-valued keys are accepted, and the calls answer as before', async () => {
    const { store, a, b } = await world();
    const spread = { after: undefined, other: undefined } as never;
    expect(await drain(a.iterate(spread))).toEqual([1, 2, 3]);
    expect(await drain(a.iterate(null as never))).toEqual([1, 2, 3]);
    expect(await drain(a.intersect([b], null as never))).toEqual([2, 3]);
    expect(await drain(a.intersect([b], { after: 2 }))).toEqual([3]);
    const r = await store.retireExpired({ dryRun: true, namespace: 'tenantB' });
    expect(r.wouldRetire).toBe(1);
  });
});

describe('an audit or metrics sink without onEvent is refused, where it would have received nothing', () => {
  it('a bare callback passed as audit is a ValidationError before anything is written', async () => {
    const { store } = await world();
    const callback = ((e: unknown) => void e) as never;
    await expect(store.load({ segment: 'a' }, [1, 2, 3, 4], { audit: callback })).rejects.toThrow(
      'load: audit must be a sink with an onEvent(event) method',
    );
    await expect(
      store.eraseSubject(2, { allNamespaces: true, audit: callback }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.dropSegment({ segment: 'a' }, { confirmSegment: 'a', audit: callback }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.rollback({ segment: 'a' }, 0, { audit: callback })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(store.retireExpired({ audit: callback })).rejects.toBeInstanceOf(ValidationError);
    expect(await drain(store.segment('a').iterate())).toEqual([1, 2, 3]);
  });

  it('a metrics option without onEvent is refused when the store is built', () => {
    for (const bad of [5, {}, (e: unknown) => void e]) {
      expect(
        () => new CloudRoaring({ storage: new MemoryStorage(), metrics: bad as never }),
      ).toThrow('metrics must be a sink with an onEvent(event) method');
    }
  });
});
