import fc from 'fast-check';
import { checkedChunkKeys } from '@/core/chunk-checks';
import { CHUNK_COUNT } from '@/core/bit-route';
import { IntegrityError, ValidationError } from '@/core/errors';
import { validateChunkRef, validateChunkKey } from '@/core/validate';
import { brandAsBackend } from '@/core/ports';
import { CloudRoaring, MemoryStorage } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

// The key-listing checks on untrusted keys, against straightforward reference implementations, and what a read
// of a wide segment asks of storage.

/** The reference check: copy, range-check every key, sort, then scan for a repeat. */
function referenceCheckedChunkKeys(listed: Iterable<number>): number[] {
  const keys = [...listed];
  for (const k of keys) {
    if (!Number.isInteger(k) || k < 0 || k >= CHUNK_COUNT) {
      throw new IntegrityError(`chunk key from a tier is out of range: ${k}`);
    }
  }
  keys.sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === keys[i - 1]) {
      throw new IntegrityError(`chunk key from a tier is listed twice: ${keys[i]}`);
    }
  }
  return keys;
}

type Outcome = { ok: number[] } | { err: string; name: string };
function outcome(f: () => number[]): Outcome {
  try {
    return { ok: f() };
  } catch (e) {
    const err = e as Error;
    return { err: err.message, name: err.constructor.name };
  }
}

const validKey = fc.integer({ min: 0, max: CHUNK_COUNT - 1 });
const badKey = fc.oneof(
  fc.integer({ min: -5, max: -1 }),
  fc.integer({ min: CHUNK_COUNT, max: CHUNK_COUNT + 5 }),
  fc.integer({ min: 2 ** 31 - 3, max: 2 ** 32 + 3 }),
  fc.double({ noInteger: true, min: -3, max: 70_000 }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, 0.5, 2 ** 53),
);
const anyKey = fc.oneof({ weight: 8, arbitrary: validKey }, { weight: 1, arbitrary: badKey });

const lists = fc.oneof(
  fc.array(anyKey, { maxLength: 40 }), // mixed, mostly unsorted
  fc.uniqueArray(validKey, { maxLength: 60 }).map((a) => a.sort((x, y) => x - y)), // strictly ascending
  fc.array(validKey, { maxLength: 60 }).map((a) => a.sort((x, y) => x - y)), // ascending, repeats allowed
  fc.array(validKey, { maxLength: 30 }).chain((a) => fc.constant([...a, ...a])), // duplicated
  fc.array(anyKey, { maxLength: 3 }), // tiny, including empty
);

describe('checkedChunkKeys agrees with the copy, range-check, sort and scan reference', () => {
  it('gives the same list or the same error class and message for any list', () => {
    fc.assert(
      fc.property(lists, (list) => {
        const before = [...list];
        const got = outcome(() => checkedChunkKeys(list));
        expect(got).toEqual(outcome(() => referenceCheckedChunkKeys(list)));
        expect(list).toEqual(before); // the caller's list is not touched
      }),
      { numRuns: 3000 },
    );
  });

  it('refuses a value that is not a number the way the reference does', () => {
    for (const odd of ['5', null, undefined, {}, 1n, true, [], ''] as unknown as number[]) {
      const list = [3, odd];
      expect(outcome(() => checkedChunkKeys(list))).toEqual(
        outcome(() => referenceCheckedChunkKeys(list)),
      );
    }
  });

  it('agrees on any iterable, not only an array', () => {
    fc.assert(
      fc.property(lists, (list) => {
        expect(outcome(() => checkedChunkKeys(new Set(list)))).toEqual(
          outcome(() => referenceCheckedChunkKeys(new Set(list))),
        );
        expect(outcome(() => checkedChunkKeys(list[Symbol.iterator]()))).toEqual(
          outcome(() => referenceCheckedChunkKeys(list)),
        );
      }),
      { numRuns: 500 },
    );
  });

  it('is a list of its own, so a source cannot change it after it was checked', () => {
    const src = [1, 2, 3];
    const out = checkedChunkKeys(src);
    src[0] = 99_999;
    expect(out).toEqual([1, 2, 3]);
  });

  it('refuses a sparse list the way the spread of it was refused', () => {
    // eslint-disable-next-line no-sparse-arrays
    const holey = [1, , 3] as number[];
    expect(outcome(() => checkedChunkKeys(holey))).toEqual(
      outcome(() => referenceCheckedChunkKeys(holey)),
    );
  });

  it('names the first bad key: an out-of-range key before an unsorted pair, a repeat only after the range checks', () => {
    expect(() => checkedChunkKeys([5, 3, 70_000])).toThrow(
      'chunk key from a tier is out of range: 70000',
    );
    expect(() => checkedChunkKeys([5, 5])).toThrow('chunk key from a tier is listed twice: 5');
    expect(() => checkedChunkKeys([9, 5, 5, 1.5])).toThrow('out of range: 1.5');
  });

  // A timing ratio against the reference was tried and flakes: once the property tests above have fed the function
  // arrays, sets, iterators and holes, the engine no longer compiles it as tightly, and the ratio falls from about 5x
  // to about 1x. Whether the sort runs is the cost that matters and is not a matter of timing, so it is counted.
  it('sorts only a list that is not strictly ascending, however long the list is', () => {
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      for (const n of [2_000, 20_000]) {
        sort.mockClear();
        const ascending = Array.from({ length: n }, (_, i) => i * 3);
        expect(checkedChunkKeys(ascending)).toEqual(ascending);
        expect(sort).not.toHaveBeenCalled();

        const shuffled = [...ascending].reverse();
        expect(checkedChunkKeys(shuffled)).toEqual(ascending);
        expect(sort).toHaveBeenCalledTimes(1);
      }
      sort.mockClear();
      expect(() => checkedChunkKeys([1, 1])).toThrow(IntegrityError);
      expect(sort).toHaveBeenCalledTimes(1); // a repeat is found by the sorting path
    } finally {
      sort.mockRestore();
    }
  });
});

describe('validateChunkKey agrees with the per-key reference check', () => {
  /** The reference check, with `validateChunkRef`'s message. */
  const reference = (k: number): void => {
    if (!Number.isInteger(k) || k < 0 || k > 0xffff) {
      throw new ValidationError('chunkKey must be an integer in [0, 65535]');
    }
  };
  const run = (f: () => void): Outcome => outcome(() => (f(), []));

  it('gives the same answer, and the same message, for any value', () => {
    fc.assert(
      fc.property(fc.oneof(validKey, badKey, fc.constantFrom(65_535, 65_536, -1)), (k) => {
        const direct = run(() => validateChunkKey(k));
        expect(direct).toEqual(run(() => reference(k)));
        expect(run(() => validateChunkRef({ segment: 's', chunkKey: k }))).toEqual(direct);
        if ('err' in direct) expect(direct.name).toBe(ValidationError.name);
      }),
      { numRuns: 1000 },
    );
  });

  it.each([0, 65_535])('accepts %i and refuses a string, null and undefined', (k) => {
    expect(run(() => validateChunkKey(k))).toEqual({ ok: [] });
    for (const bad of ['5', null, undefined, {}, 1n] as unknown[]) {
      expect(run(() => validateChunkKey(bad as number))).toEqual(
        run(() => reference(bad as number)),
      );
    }
  });
});

describe('a read of a wide segment asks storage for the same requests', () => {
  /** Every call on a driver, by method name. */
  function counted<T extends object>(target: T, calls: string[]): T {
    return new Proxy(target, {
      get(t, prop, receiver) {
        const v = Reflect.get(t, prop, receiver) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  }

  it('cold and warm, a page of ids of a 4,096-chunk segment costs the same number and kind of requests', async () => {
    const b = new MemoryStorage();
    const ids: number[] = [];
    for (let c = 0; c < 4096; c++) ids.push(c * CHUNK_COUNT + (c % 7));
    await bulkLoadCrbmGeneration(
      b.storage,
      { namespace: 'ns', segment: 'wide', generation: 0 },
      ids,
      { registry: b.registry },
    );
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(b.storage, calls),
        registry: counted(b.registry, calls),
      }),
      cache: { genTtlMs: 60_000 },
    });
    const seg = store.segment('wide', { namespace: 'ns' });
    const page = async (): Promise<number[]> => {
      const out: number[] = [];
      for await (const id of seg.iterate({ after: ids[100]!, through: ids[103]! })) out.push(id);
      return out;
    };
    const tally = (): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const c of calls) t[c] = (t[c] ?? 0) + 1;
      calls.length = 0;
      return t;
    };

    expect(await page()).toEqual(ids.slice(101, 104));
    const cold = tally();
    expect(await page()).toEqual(ids.slice(101, 104));
    const warm = tally();
    expect({ cold, warm }).toMatchInlineSnapshot(`
      {
        "cold": {
          "capabilities": 1,
          "get": 1,
          "getRange": 1,
          "getTail": 1,
        },
        "warm": {},
      }
    `);
  });
});

describe('checkedChunkKeys, given a list that is not a plain array', () => {
  it('copies the list as the spread did, whatever kind of array a source hands over', () => {
    class NoSort extends Array<number> {}
    NoSort.prototype.sort = function (this: number[]) {
      return this;
    } as never;
    const iteratingAs = (held: number[], yields: number[]): number[] =>
      Object.defineProperty([...held], Symbol.iterator, {
        value: function* () {
          yield* yields;
        },
      });
    const lists: (() => number[])[] = [
      () => NoSort.from([3, 1, 2]),
      () => NoSort.from([3, 1, 3]),
      () => iteratingAs([1, 2], [70_000]),
      () => iteratingAs([5, 3], [1, 2]),
      () => new Proxy([3, 1, 2], {}),
    ];
    for (const make of lists) {
      const got = outcome(() => checkedChunkKeys(make()));
      expect(got).toEqual(outcome(() => referenceCheckedChunkKeys(make())));
      if ('ok' in got)
        expect(Object.getPrototypeOf(checkedChunkKeys(make()))).toBe(Array.prototype);
    }
  });
});
