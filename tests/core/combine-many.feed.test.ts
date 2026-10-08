/**
 * The chunk-ordered feed of a batch combine: every record is checked before the pass sees it, and a bad feed is refused
 * for every fed output, never read as fewer members.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, ValidationError } from '@/core/errors';
import { runBatch } from '../helpers/combine-many';
import { feedOf, lcg, recordsOf, runFed } from '../helpers/combine-feed';
import type { Published } from '../helpers/combine-many';

const K = 65_536;
const at = (chunk: number, values: number[]): number[] => values.map((v) => chunk * K + v);
const range = (lo: number, hi: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = lo; v < hi; v += step) out.push(v);
  return out;
};
const u32 = (...ids: number[]): Uint32Array => Uint32Array.from(ids);
const ok = (o: { ok: boolean }): Published => {
  expect(o.ok).toBe(true);
  return (o as unknown as { value: Published }).value;
};
const error = (o: { ok: boolean }): Error => {
  expect(o.ok).toBe(false);
  return (o as unknown as { error: Error }).error;
};

type Resizable = new (
  length: number,
  options: { maxByteLength: number },
) => ArrayBuffer & {
  resize(length: number): void;
};
const ResizableBuffer = ArrayBuffer as unknown as Resizable;

/** A feed of `records` for operand `a`, beside a stored operand `s` an output of its own reads. */
async function feedA(records: unknown[], names = ['a'], counts?: Record<string, number>) {
  return runFed([{ expr: 'a' }, { expr: 's' }, { expr: { or: ['a', 's'] } }], {
    stored: { s: at(2, [1, 2, 3]) },
    names,
    records,
    counts: counts ?? { a: 0 },
    mayBeEmpty: ['a'],
  });
}

/** Every fed output is refused with a ValidationError carrying `message`; the stored-only one publishes. */
async function expectRefused(records: unknown[], message: RegExp, names = ['a']) {
  const { run } = await feedA(records, names, Object.fromEntries(names.map((n) => [n, 99])));
  for (const i of [0, 2]) {
    const e = error(run.outputs[i]!);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toMatch(message);
  }
  expect(ok(run.outputs[1]!).ids).toEqual(at(2, [1, 2, 3]));
  expect(run.stats.requests.publishes).toBe(1);
}

/** The records are accepted: the feed's operand `a` reads as exactly `want`. */
async function expectAccepted(records: unknown[], want: number[]) {
  const { run } = await feedA(records, ['a'], { a: want.length });
  expect(ok(run.outputs[0]!).ids).toEqual(want);
}

describe('a record is checked before the pass sees it', () => {
  it('refuses a key that is not an integer from 0 to 65535', async () => {
    for (const key of [1.5, Number.NaN, -1, 65_536, '3', null, undefined, 2 ** 40]) {
      await expectRefused(
        [{ key, operands: { a: u32(1) } }],
        /key must be an integer from 0 to 65535/,
      );
    }
    await expectAccepted([{ key: 0, operands: { a: u32(5) } }], [5]);
    await expectAccepted([{ key: 65_535, operands: { a: u32(65_535 * K + 7) } }], [65_535 * K + 7]);
  });

  it('refuses a record that is not an object', async () => {
    for (const record of [null, 5, 'x', undefined]) {
      await expectRefused([record], /a record is an object/);
    }
  });

  it('refuses a key below the previous record, and accepts the same key and a higher one', async () => {
    await expectRefused(
      [
        { key: 3, operands: { a: u32(3 * K + 1) } },
        { key: 2, operands: { a: u32(2 * K + 1) } },
      ],
      /record \d+: the key is below the previous record's: keys never go back/,
    );
    await expectAccepted(
      [
        { key: 2, operands: { a: u32(2 * K + 1) } },
        { key: 2, operands: {} },
        { key: 3, operands: { a: u32(3 * K + 1) } },
      ],
      [2 * K + 1, 3 * K + 1],
    );
  });

  it('refuses operands that is not an object, and a name that was not declared', async () => {
    for (const operands of [null, undefined, [], 'a', 3]) {
      await expectRefused([{ key: 1, operands }], /operands must be a plain object/);
    }
    await expectRefused(
      [{ key: 1, operands: { b: u32(K + 1) } }],
      /record \d+, operand "b": not a declared fed operand/,
    );
    await expectRefused(
      [{ key: 1, operands: { a: u32(K + 1), b: u32(K + 2) } }],
      /operand "b": not a declared fed operand/,
    );
    await expectRefused(
      [{ key: 1, operands: { [Symbol('a')]: u32(K + 1) } }],
      /operands has a symbol key/,
    );
    await expectAccepted([{ key: 1, operands: {} }], []);
  });

  it('refuses every value that is not a real Uint32Array, and reads none of them as fewer members', async () => {
    const spoof = {
      [Symbol.toStringTag]: 'Uint32Array',
      length: 1,
      0: K + 1,
      *[Symbol.iterator]() {
        yield K + 1;
      },
    };
    const values: Array<[string, unknown]> = [
      ['an array', [K + 1]],
      ['an Int32Array', new Int32Array([K + 1])],
      ['a negative Int32Array', new Int32Array([-1])],
      ['a Float64Array', new Float64Array([K + 1.5])],
      ['a Uint8Array', new Uint8Array([1])],
      ['a Buffer', Buffer.from([1, 2, 3, 4])],
      ['a spoofed tag', spoof],
      ['a proxy of a Uint32Array', new Proxy(u32(K + 1), {})],
      ['null', null],
      ['undefined', undefined],
      ['a number', 5],
      ['a string', 'x'],
    ];
    for (const [what, value] of values) {
      await expectRefused(
        [{ key: 1, operands: { a: value } }],
        /record \d+, operand "a": the ids must be a Uint32Array/,
      );
      void what;
    }
  });

  it('accepts what looks different and is a Uint32Array: shared memory, a subclass, another realm', async () => {
    const ids = [K + 3, K + 9, K + 12];
    const shared = new Uint32Array(new SharedArrayBuffer(12));
    shared.set(ids);
    class Lying extends Uint32Array {
      override get length(): number {
        return 1;
      }
      override [Symbol.iterator](): ArrayIterator<number> {
        return [0][Symbol.iterator]();
      }
    }
    const lying = new Lying(3);
    lying.set(ids);
    const foreign = vm.runInNewContext('new Uint32Array([65539, 65545, 65548])') as Uint32Array;
    const view = new Uint32Array(new ArrayBuffer(40), 8, 3);
    view.set(ids);
    for (const value of [shared, lying, foreign, view, u32(...ids)]) {
      await expectAccepted([{ key: 1, operands: { a: value } }], ids);
    }
  });

  it('refuses a view that a resizable buffer shrank out from under, rather than reading it as empty', async () => {
    const buffer = new ResizableBuffer(8, { maxByteLength: 16 });
    const ids = new Uint32Array(buffer, 4, 1);
    ids[0] = K + 1;
    buffer.resize(0);
    expect(ids.length).toBe(0);
    await expectRefused(
      [{ key: 1, operands: { a: ids } }],
      /out of bounds of its resizable buffer/,
    );
    // A view that tracks the length of a resizable buffer, or fits inside it, is a Uint32Array like another.
    const grown = new ResizableBuffer(8, { maxByteLength: 16 });
    const tracking = new Uint32Array(grown);
    tracking.set([K + 1, K + 2]);
    await expectAccepted([{ key: 1, operands: { a: tracking } }], [K + 1, K + 2]);
    await expectAccepted(
      [
        {
          key: 1,
          operands: { a: new Uint32Array(new ResizableBuffer(8, { maxByteLength: 16 }), 0, 0) },
        },
      ],
      [],
    );
  });

  it('refuses operands that is not a plain object, even when it would read as empty', async () => {
    class Holder {
      a = u32(K + 1);
    }
    const inherited = Object.create({ a: u32(K + 1) }) as unknown;
    for (const operands of [new Map([['a', u32(K + 1)]]), new Holder(), inherited, [u32(K + 1)]]) {
      await expectRefused([{ key: 1, operands }], /operands must be a plain object/);
    }
    // A null-prototype object and another realm's plain object are plain.
    const bare = Object.assign(Object.create(null) as Record<string, Uint32Array>, {
      a: u32(K + 1),
    });
    await expectAccepted([{ key: 1, operands: bare }], [K + 1]);
    const foreign = vm.runInNewContext('({})') as Record<string, Uint32Array>;
    foreign.a = u32(K + 1);
    await expectAccepted([{ key: 1, operands: foreign }], [K + 1]);
  });

  it('refuses an array whose buffer was detached, rather than reading it as empty', async () => {
    const ids = u32(K + 1, K + 2);
    structuredClone(ids.buffer, { transfer: [ids.buffer as ArrayBuffer] });
    await expectRefused([{ key: 1, operands: { a: ids } }], /buffer is detached/);
  });

  it('refuses ids that are not ascending, unique and inside the key, and says where', async () => {
    const cases: Array<[number[], RegExp]> = [
      [[K + 5, K + 4], /position 1 is not above the one before it/],
      [[K + 5, K + 5], /position 1 is not above the one before it/],
      [[K + 1, K + 3, K + 2], /position 2 is not above/],
      [[K - 1, K + 1], /position 0 is not inside the key/],
      [[K + 1, 2 * K], /position 1 is not inside the key/],
      [[K + 1, 2 ** 32 - 1], /position 1 is not inside the key/],
    ];
    for (const [ids, why] of cases) {
      await expectRefused([{ key: 1, operands: { a: u32(...ids) } }], why);
    }
    const tooMany = new Uint32Array(K + 1);
    await expectRefused([{ key: 1, operands: { a: tooMany } }], /more than one chunk key holds/);
    await expectAccepted(
      [{ key: 1, operands: { a: u32(K, K + 1, 2 * K - 1) } }],
      [K, K + 1, 2 * K - 1],
    );
  });

  it('refuses an operand named twice at one key, never merged, and treats an empty array as absent', async () => {
    await expectRefused(
      [
        { key: 1, operands: { a: u32(K + 1) } },
        { key: 1, operands: { a: u32(K + 2) } },
      ],
      /operand "a": named twice at one key/,
    );
    await expectAccepted(
      [
        { key: 1, operands: { a: u32() } },
        { key: 1, operands: { a: u32(K + 2) } },
      ],
      [K + 2],
    );
    // The same name at the next key is a different appearance.
    await expectAccepted(
      [
        { key: 1, operands: { a: u32(K + 1) } },
        { key: 2, operands: { a: u32(2 * K + 1) } },
      ],
      [K + 1, 2 * K + 1],
    );
  });

  it('reads the key and the operands of a record once', async () => {
    let reads = 0;
    const record = {
      get key() {
        reads++;
        return 1;
      },
      get operands() {
        reads++;
        return { a: u32(K + 1) };
      },
    };
    await expectAccepted([record], [K + 1]);
    expect(reads).toBe(2);
  });

  it('keeps a record that a producer overwrites after yielding: the ids were copied', async () => {
    const ids = u32(K + 1, K + 2);
    const records = feedOf([{ key: 1, operands: { a: ids } }]);
    const { run } = await runFed([{ expr: 'a' }], {
      fed: { a: [K + 1, K + 2] },
      feed: {
        records: {
          async *[Symbol.asyncIterator]() {
            for await (const r of records) {
              yield r;
              ids.fill(0);
            }
          },
        },
      },
    });
    expect(ok(run.outputs[0]!).ids).toEqual([K + 1, K + 2]);
  });
});

describe('the feed against the same operands stored', () => {
  it('is the same, with keys cut across records at random boundaries', async () => {
    const sets = {
      a: [...at(1, range(0, 3000)), ...at(3, range(0, 100, 3)), ...at(9, range(0, 60_000, 7))],
      b: [...at(1, range(2000, 9000, 2)), ...at(2, range(0, 10)), ...at(9, range(0, 60_000, 3))],
      c: [...at(1, range(0, 65_536)), ...at(5, [4])],
      u: at(1, range(60, 70)),
    };
    const specs = [
      { expr: { and: ['a', 'b'] }, exclude: ['u'] },
      { expr: { or: ['a', 'b', 'c'] } },
      { expr: { andNot: ['c', 'a', 'b'] } },
    ];
    const want = await runBatch(sets, specs);
    for (const seed of [1, 2, 3, 4, 5]) {
      const got = await runFed(specs, {
        stored: { u: sets.u },
        fed: { a: sets.a, b: sets.b, c: sets.c },
        rng: lcg(seed),
      });
      expect(got.run.outputs).toEqual(want.run.outputs);
    }
  });

  it('keeps recordsOf honest: a key split over several records stays one key', () => {
    const records = recordsOf({ a: [K + 1], b: [K + 2], c: [K + 3] }, () => 0.1);
    expect(records.map((r) => r.key)).toEqual([1, 1, 1]);
    expect(recordsOf({ a: [K + 1], b: [K + 2] }).length).toBe(1);
  });

  it('evaluates a key no stored operand holds, and a stored key the feed has passed', async () => {
    const stored = { s: [...at(1, [1, 2]), ...at(6, [9])] };
    const fed: Record<string, number[]> = { a: [...at(1, [2, 3]), ...at(4, [7])] };
    const specs = [
      { expr: { or: ['s', 'a'] } },
      { expr: { andNot: ['a', 's'] } },
      { expr: { and: ['a', 's'] } },
    ];
    const want = await runBatch({ ...stored, ...fed }, specs);
    const got = await runFed(specs, { stored, fed });
    expect(got.run.outputs).toEqual(want.run.outputs);
  });
});

describe('what the feed must add up to', () => {
  const sets = { a: [...at(1, range(0, 50)), ...at(3, [1, 2, 3])], b: at(2, [5, 6]) };
  const specs = [{ expr: 'a' }, { expr: { and: ['a', 'b'] } }, { expr: 's' }];
  const stored = { s: at(4, [1]) };

  /** Every fed output is refused with `message`, nothing fed was published, and the stored-only output was. */
  async function refused(options: Parameters<typeof runFed>[1], message: RegExp) {
    const published: number[] = [];
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      onPublish: (i) => published.push(i),
      ...options,
    });
    for (const i of [0, 1]) {
      const e = error(run.outputs[i]!);
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.message).toMatch(message);
    }
    expect(ok(run.outputs[2]!).ids).toEqual(at(4, [1]));
    expect(published).toEqual([2]);
  }

  it('calls a counts function exactly once, after the last record and before any publish', async () => {
    const events: string[] = [];
    let calls = 0;
    const records = recordsOf(sets).map((r) => r);
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      records: (function* () {
        for (const r of records) {
          events.push('record');
          yield r;
        }
      })(),
      counts: () => {
        calls++;
        events.push('counts');
        return { a: 53, b: 2 };
      },
      onPublish: () => events.push('publish'),
    });
    expect(calls).toBe(1);
    expect(events.indexOf('counts')).toBe(events.lastIndexOf('record') + 1);
    expect(events.indexOf('publish')).toBeGreaterThan(events.indexOf('counts'));
    expect(run.outputs.every((o) => o.ok)).toBe(true);
  });

  it('takes counts as an object, or as a function that returns a promise', async () => {
    for (const counts of [{ a: 53, b: 2 }, () => Promise.resolve({ a: 53, b: 2 })]) {
      const { run } = await runFed(specs, { stored, fed: sets, counts });
      expect(run.outputs.every((o) => o.ok)).toBe(true);
    }
  });

  it('refuses every fed output for a count that differs, is missing, is extra or is not a count', async () => {
    await refused(
      { counts: { a: 54, b: 2 } },
      /operand "a" was counted at 54 ids and the feed held 53/,
    );
    await refused({ counts: { a: 52, b: 2 } }, /counted at 52 ids and the feed held 53/);
    await refused({ counts: { a: 53 } }, /has no count for "b"/);
    await refused({ counts: { a: 53, b: 2, c: 1 } }, /names "c", which is not in feed.names/);
    await refused({ counts: { a: 53, b: -2 } }, /counts\["b"\] must be a non-negative integer/);
    await refused({ counts: { a: 53, b: 2.5 } }, /counts\["b"\] must be a non-negative integer/);
    await refused({ counts: { a: '53', b: 2 } as never }, /must be a non-negative integer/);
    await refused({ counts: () => null as never }, /must give an object/);
    await refused({ counts: () => [53, 2] as never }, /must give an object/);
  });

  it('refuses every fed output for a counts function that throws or rejects', async () => {
    await refused(
      {
        counts: () => {
          throw new Error('warehouse down');
        },
      },
      /feed.counts threw: warehouse down/,
    );
    await refused({ counts: () => Promise.reject(new Error('nope')) }, /feed.counts threw: nope/);
  });

  it('catches a feed that ended early and one that skipped a key, which no record check can see', async () => {
    const all = recordsOf(sets);
    await refused({ records: all.slice(0, 2) }, /counted at 53 ids and the feed held 50/);
    await refused(
      { records: all.filter((r) => r.key !== 3) },
      /counted at 53 ids and the feed held 50/,
    );
    await refused(
      { records: all.filter((r) => r.key !== 2) },
      /operand "b" was counted at 2 ids and the feed held 0/,
    );
  });

  it('does not call counts when a record was refused first', async () => {
    let calls = 0;
    await runFed(specs, {
      stored,
      fed: sets,
      records: [{ key: 1, operands: { a: [1] } }],
      counts: () => {
        calls++;
        return {};
      },
    });
    expect(calls).toBe(0);
  });

  it('refuses a declared name that appears in no record, before any publish, unless it may be empty', async () => {
    await refused(
      { fed: { a: sets.a }, names: ['a', 'b'], counts: { a: 53, b: 0 } },
      /operand "b" holds no id anywhere in the feed/,
    );
    // A name fed at one key only passes.
    const { run } = await runFed(specs, { stored, fed: { a: sets.a, b: at(7, [1]) } });
    expect(run.outputs.every((o) => o.ok)).toBe(true);
  });

  it('lets a name that may be empty be empty: an and empties, an exclude subtracts nothing, an or adds nothing', async () => {
    const { run } = await runFed(
      [
        { expr: { and: ['a', 'b'] } },
        { expr: 'a', exclude: ['b'] },
        { expr: { or: ['a', 'b'] } },
        { expr: 'b' },
      ],
      { fed: { a: sets.a }, names: ['a', 'b'], counts: { a: 53, b: 0 }, mayBeEmpty: ['b'] },
    );
    expect(ok(run.outputs[0]!).ids).toEqual([]);
    expect(ok(run.outputs[1]!).ids).toEqual(sets.a);
    expect(ok(run.outputs[2]!).ids).toEqual(sets.a);
    expect(ok(run.outputs[3]!).ids).toEqual([]);
  });

  it('refuses a mayBeEmpty that names something that is not a fed operand, before anything is read', async () => {
    for (const mayBeEmpty of [['s'], ['nobody'], ['a', 'a2']]) {
      await expect(
        runFed(specs, { stored, fed: sets, mayBeEmpty, pulled: undefined }),
      ).rejects.toThrow(/mayBeEmpty names ".*", which is not a fed operand/);
    }
  });

  it('refuses a name that is both stored and fed, a feed that is not async, and no counts', async () => {
    await expect(runFed(specs, { stored: { a: [1] }, fed: sets })).rejects.toThrow(
      /both a stored operand and a fed one/,
    );
    await expect(
      runFed(specs, { stored, fed: sets, feed: { records: [] as never } }),
    ).rejects.toThrow(/feed.records must be an async iterable/);
    await expect(
      runFed(specs, { stored, fed: sets, feed: { counts: undefined as never } }),
    ).rejects.toThrow(/feed.counts is required/);
    await expect(runFed([{ expr: 'zzz' }], { stored, fed: sets })).rejects.toThrow(
      /does not name an operand/,
    );
  });
});

describe('fed outputs are atomic', () => {
  const sets = { a: [...at(1, range(0, 50)), ...at(3, [1, 2, 3])], b: at(2, [5, 6]) };
  const stored = { s: at(4, [1]) };
  const specs = [{ expr: 'a' }, { expr: { or: ['a', 's'] } }, { expr: 's' }];

  it('publishes none of them when the last record is bad, and the stored-only one still publishes', async () => {
    const published: number[] = [];
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const records = [...recordsOf(sets), { key: 9, operands: { a: [1] } }];
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      records,
      pulled,
      onPublish: (i) => published.push(i),
    });
    expect(error(run.outputs[0]!)).toBeInstanceOf(ValidationError);
    expect(error(run.outputs[1]!)).toBeInstanceOf(ValidationError);
    expect(ok(run.outputs[2]!).ids).toEqual(at(4, [1]));
    expect(published).toEqual([2]);
    expect(pulled.taken).toBe(records.length);
  });

  it('stops the feed at the first bad record, and tells the iterator', async () => {
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const records = [
      { key: 1, operands: { a: u32(K + 1) } },
      { key: 1, operands: { a: u32(K + 2) } },
      ...Array.from({ length: 50 }, (_, i) => ({ key: 2 + i, operands: { a: u32((2 + i) * K) } })),
    ];
    await runFed(specs, { stored, fed: sets, records, pulled });
    expect(pulled.taken).toBe(2);
    expect(pulled.returnedEarly).toBe(true);
  });

  it('hands an iterator that throws to every fed output as the error it threw', async () => {
    const boom = new Error('warehouse closed the cursor');
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      feed: {
        records: {
          async *[Symbol.asyncIterator]() {
            yield { key: 1, operands: { a: u32(K + 1) } };
            throw boom;
          },
        },
      },
    });
    expect(error(run.outputs[0]!)).toBe(boom);
    expect(error(run.outputs[1]!)).toBe(boom);
    expect(ok(run.outputs[2]!).ids).toEqual(at(4, [1]));
  });

  it('publishes a fed output only after the feed has been read to its end', async () => {
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    let finishedAtFirstPublish: boolean | undefined;
    await runFed(specs, {
      stored,
      fed: sets,
      pulled,
      onPublish: (i) => {
        if (i < 2) finishedAtFirstPublish ??= pulled.finished;
      },
    });
    expect(finishedAtFirstPublish).toBe(true);
  });
});

describe('a feed beside a range', () => {
  it('matches the same operands stored, and still refuses a bad record outside the range', async () => {
    const sets = {
      a: [...at(1, range(0, 3000)), ...at(3, range(0, 100, 3)), ...at(9, range(0, 60_000, 7))],
      b: [...at(1, range(2000, 9000, 2)), ...at(3, range(0, 10)), ...at(9, range(0, 60_000, 3))],
    };
    const specs = [{ expr: { and: ['a', 'b'] } }, { expr: { or: ['a', 'b'] } }];
    for (const [after, through] of [
      [K + 100, 3 * K + 50],
      [3 * K + 6, 9 * K + 1000],
      [10 * K, 11 * K],
      [5, 4],
    ] as const) {
      const want = await runBatch(sets, specs, { after, through });
      const got = await runFed(specs, { fed: sets, rng: lcg(after), extra: { after, through } });
      expect(got.run.outputs).toEqual(want.run.outputs);
    }
    const bad = [...recordsOf(sets), { key: 12, operands: { a: u32(11 * K) } }];
    const { run } = await runFed(specs, {
      fed: sets,
      records: bad,
      extra: { after: K, through: 2 * K },
    });
    expect(error(run.outputs[0]!)).toBeInstanceOf(ValidationError);
  });
});

describe('memory', () => {
  it('holds a key or two of 10,000 fed operands, not the feed: 800 ids each, 31 MB a key as Uint32Arrays', async () => {
    const operands = 10_000;
    const keys = 5;
    const per = 800;
    const names = Array.from({ length: operands }, (_, i) => `c${i}`);
    const budget = 128 * 1024 * 1024;
    let built = 0;
    const { run } = await runFed(
      [{ expr: { and: ['c0', 'c1'] } }, { expr: { or: ['c2', 'c3', 'c9999'] }, exclude: ['c4'] }],
      {
        names,
        counts: Object.fromEntries(names.map((n) => [n, per * keys])),
        feed: {
          records: {
            async *[Symbol.asyncIterator]() {
              for (let key = 1; key <= keys; key++) {
                // The caller's record of one key is built here and dropped once yielded.
                const record: Record<string, Uint32Array> = {};
                for (let i = 0; i < operands; i++) {
                  const ids = new Uint32Array(per);
                  for (let j = 0; j < per; j++) ids[j] = key * K + ((i % 7) + j * 3);
                  record[names[i]!] = ids;
                }
                built++;
                yield { key, operands: record };
              }
            },
          },
        },
        extra: { maxBufferedBytes: budget },
      },
    );
    expect(built).toBe(keys);
    expect(run.outputs.every((o) => o.ok)).toBe(true);
    // c0 and c1 differ by 1 mod 3, so their ids never meet; c2 and c3 and c9999 do not all overlap.
    expect(ok(run.outputs[0]!).ids.length).toBe(0);
    expect(ok(run.outputs[1]!).ids.length).toBeGreaterThan(0);
    const { highWaterBytes } = run.stats.memory;
    // The whole feed would be five keys of 31 MB: the ledger held about two (the key in hand and the one that proved it whole).
    const oneKey = operands * 3_098;
    expect(highWaterBytes).toBeLessThanOrEqual(budget);
    expect(highWaterBytes).toBeGreaterThan(oneKey);
    expect(highWaterBytes).toBeLessThan(2.2 * oneKey);
    expect(run.stats.feed).toEqual({ records: keys, keys, ids: operands * per * keys });
  }, 120_000);

  it('fails as soon as the ledger passes the budget, long before the whole feed was read', async () => {
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const keys = 400;
    const records = Array.from({ length: keys }, (_, i) => ({
      key: i + 1,
      operands: { a: Uint32Array.from(range(0, 3000), (v) => (i + 1) * K + v) },
    }));
    const budget = 120_000;
    const { run } = await runFed([{ expr: 'a' }, { expr: 's' }], {
      stored: { s: at(2, [1, 2]) },
      fed: { a: [] },
      names: ['a'],
      records,
      counts: { a: 3000 * keys },
      pulled,
      extra: { maxBufferedBytes: budget },
    });
    expect(error(run.outputs[0]!)).toBeInstanceOf(BudgetExceededError);
    expect(error(run.outputs[0]!).message).toMatch(/maxBufferedBytes/);
    expect(pulled.taken).toBeLessThan(30);
    expect(pulled.returnedEarly).toBe(true);
    expect(run.stats.memory.highWaterBytes).toBeLessThanOrEqual(budget);
    // Stored-only outputs of the call are not the feed's to refuse.
    expect(ok(run.outputs[1]!).ids).toEqual(at(2, [1, 2]));
  });

  it('gives up every fed output and the feed when the fed outputs themselves pass the budget, not only the one that grew', async () => {
    const keys = 20;
    const records = Array.from({ length: keys }, (_, i) => ({
      key: i + 1,
      operands: {
        a: Uint32Array.from({ length: 3000 }, (_, v) => (i + 1) * K + v * 2),
        b: Uint32Array.from({ length: 3000 }, (_, v) => (i + 1) * K + v * 2 + 1),
      },
    }));
    // Each record fits the budget; the two fed outputs' buffers, growing a chunk a key, do not.
    const budget = 250_000;
    const { run, pulled } = await runFed([{ expr: 'a' }, { expr: 'b' }, { expr: 's' }], {
      stored: { s: at(2, [1, 2]) },
      names: ['a', 'b'],
      records,
      counts: { a: 3000 * keys, b: 3000 * keys },
      extra: { maxBufferedBytes: budget },
    });
    for (const i of [0, 1]) {
      expect(error(run.outputs[i]!)).toBeInstanceOf(BudgetExceededError);
      expect(error(run.outputs[i]!).message).toMatch(/the feed and the fed outputs/);
    }
    expect(pulled.returnedEarly).toBe(true);
    expect(pulled.taken).toBeLessThan(keys);
    expect(run.stats.memory.highWaterBytes).toBeLessThanOrEqual(budget);
    expect(ok(run.outputs[2]!).ids).toEqual(at(2, [1, 2]));
    expect(run.stats.requests.publishes).toBe(1);
  });

  it('refuses alone a fed output whose object does not fit at its publish, once the feed was read, and publishes the others', async () => {
    const keys = 20;
    const records = Array.from({ length: keys }, (_, i) => ({
      key: i + 1,
      operands: {
        a: Uint32Array.from({ length: 3000 }, (_, v) => (i + 1) * K + v * 2),
        b: Uint32Array.from({ length: 3000 }, (_, v) => (i + 1) * K + v * 2 + 1),
      },
    }));
    // The feed and both fed outputs' buffers fit; the first output's object, written beside them, does not.
    const budget = 400_000;
    const { run, pulled } = await runFed([{ expr: 'a' }, { expr: 'b' }, { expr: 's' }], {
      stored: { s: at(2, [1, 2]) },
      names: ['a', 'b'],
      records,
      counts: { a: 3000 * keys, b: 3000 * keys },
      extra: { maxBufferedBytes: budget },
    });
    expect(pulled.finished).toBe(true);
    expect(error(run.outputs[0]!)).toBeInstanceOf(BudgetExceededError);
    expect(error(run.outputs[0]!).message).toMatch(/publishing output 0/);
    expect(ok(run.outputs[1]!).ids.length).toBe(3000 * keys);
    expect(ok(run.outputs[2]!).ids).toEqual(at(2, [1, 2]));
    expect(run.stats.memory.highWaterBytes).toBeLessThanOrEqual(budget);
  });
});

describe('the pass yields while it converts a dense record', () => {
  it('hands the loop back once every 256 operands', async () => {
    let yields = 0;
    const operands = 3000;
    const names = Array.from({ length: operands }, (_, i) => `c${i}`);
    const record: Record<string, Uint32Array> = {};
    for (const name of names) record[name] = u32(K + 1, K + 2);
    await runFed([{ expr: 'c0' }], {
      names,
      counts: Object.fromEntries(names.map((n) => [n, 2])),
      records: [{ key: 1, operands: record }],
      clock: {
        now: () => 0,
        sleep: async () => {},
        yieldNow: async () => {
          yields++;
        },
      },
    });
    expect(yields).toBeGreaterThanOrEqual(Math.floor(operands / 256));
  });
});

describe('an erasure in the store while a fed call runs', () => {
  const sets = {
    a: [...at(1, range(0, 50)), ...at(2, [1, 2, 3]), ...at(3, [4])],
    b: at(2, [5, 6]),
  };
  const stored = { s: at(4, [1]) };
  const specs = [{ expr: 'a' }, { expr: { or: ['a', 'b'] } }, { expr: 's' }, { expr: 'b' }];

  const epoch = (state: { n: number }) => ({ moved: () => state.n !== 0 });

  it('refuses every fed output before any publishes when it lands between two records', async () => {
    const state = { n: 0 };
    const published: number[] = [];
    const pulled = { taken: 0, returnedEarly: false, finished: false };
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      onPublish: (i) => published.push(i),
      feed: {
        epoch: epoch(state),
        records: feedOf(recordsOf(sets), pulled, (i) => {
          if (i === 1) state.n++;
        }),
      },
    });
    for (const i of [0, 1, 3]) {
      const e = error(run.outputs[i]!) as Error & { code: string; reason: string; operand: string };
      expect(e.code).toBe('stale-operand');
      expect(e.reason).toBe('erased');
    }
    expect((error(run.outputs[0]!) as unknown as { operand: string }).operand).toBe('a');
    expect((error(run.outputs[3]!) as unknown as { operand: string }).operand).toBe('b');
    expect(published).toEqual([2]);
    expect(ok(run.outputs[2]!).ids).toEqual(at(4, [1]));
    expect(pulled.returnedEarly).toBe(true);
    expect(pulled.taken).toBeLessThan(recordsOf(sets).length);
  });

  it('refuses at the first record when it landed before the call read anything', async () => {
    const { run, pulled } = await runFed(specs, {
      stored,
      fed: sets,
      feed: { epoch: { moved: () => true } },
    });
    expect(pulled.taken).toBe(0);
    expect((error(run.outputs[0]!) as unknown as { reason: string }).reason).toBe('erased');
  });

  it('refuses the fed outputs not yet published when it lands during a publish, and not those that began', async () => {
    const state = { n: 0 };
    const published: number[] = [];
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      extra: { publishConcurrency: 1 },
      onPublish: (i) => {
        published.push(i);
        if (i === 1) state.n++;
      },
      feed: { epoch: epoch(state) },
    });
    expect(published).toEqual([0, 1, 2]);
    expect(run.outputs[0]!.ok).toBe(true);
    expect(run.outputs[1]!.ok).toBe(true);
    expect(run.outputs[2]!.ok).toBe(true);
    expect((error(run.outputs[3]!) as unknown as { reason: string }).reason).toBe('erased');
  });

  it('refuses a fed output that waited for room in the budget while an erasure ran', async () => {
    const dense = {
      a: [...at(1, range(0, 3000)), ...at(2, range(0, 3000)), ...at(3, range(0, 3000))],
    };
    const fedSpecs = [{ expr: 'a' }, { expr: { or: ['a'] } }];
    let contended = 0;
    // Sweep budgets: at some, the second output cannot be admitted until the first has settled.
    for (let budget = 60_000; budget <= 130_000; budget += 1_000) {
      const events: string[] = [];
      const state = { n: 0 };
      const { run } = await runFed(fedSpecs, {
        fed: dense,
        extra: { maxBufferedBytes: budget, publishConcurrency: 2 },
        onPublish: (i) => {
          events.push(`p${i}`);
          if (i === 0) {
            void Promise.resolve().then(() => {
              events.push('erase');
              state.n++;
            });
          }
        },
        feed: { epoch: epoch(state) },
      });
      // Nothing fed may start its publish after the erasure.
      const erase = events.indexOf('erase');
      if (erase >= 0) expect(events.slice(erase)).not.toContain('p1');
      const second = run.outputs[1]!;
      if (
        !second.ok &&
        (second as unknown as { error: { reason?: string } }).error.reason === 'erased'
      ) {
        contended++;
      }
    }
    expect(contended).toBeGreaterThan(0);
  });

  it('does not touch an erasure that lands after the last fed publish began', async () => {
    const state = { n: 0 };
    const { run } = await runFed(specs, {
      stored,
      fed: sets,
      extra: { publishConcurrency: 1 },
      onPublish: (i) => {
        if (i === 3) state.n++;
      },
      feed: { epoch: epoch(state) },
    });
    expect(run.outputs.every((o) => o.ok)).toBe(true);
  });

  it('leaves a call with no feed to the stored operands alone', async () => {
    const { run } = await runBatch({ s: at(4, [1]) }, [{ expr: 's' }]);
    expect(run.outputs[0]!.ok).toBe(true);
  });
});

describe('a fed call is one group', () => {
  it('runs every output together where the same outputs without a feed would be split', async () => {
    const stored: Record<string, number[]> = {};
    for (let i = 0; i < 6; i++) stored[`s${i}`] = at(1, range(i, 60_000, 7));
    const specs = Object.keys(stored).map((n) => ({ expr: n }));
    const budget = 100_000;
    const split = await runBatch(stored, specs, { maxBufferedBytes: budget });
    expect(split.run.stats.groups).toBeGreaterThan(1);
    const fed = await runFed([...specs, { expr: 'a' }], {
      stored,
      fed: { a: at(1, [1, 2]) },
      extra: { maxBufferedBytes: budget },
    });
    expect(fed.run.stats.groups).toBe(1);
  });
});

describe('a producer that is slow but ends', () => {
  it('completes correctly, and every fed output waits for it', async () => {
    const sets = { a: [...at(1, range(0, 50)), ...at(3, [1, 2, 3])] };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const published: number[] = [];
    const { run } = await runFed([{ expr: 'a' }, { expr: 's' }], {
      stored: { s: at(4, [1]) },
      fed: sets,
      records: recordsOf(sets),
      counts: async () => {
        await sleep(40);
        return { a: 53 };
      },
      feed: {
        records: {
          async *[Symbol.asyncIterator]() {
            for (const r of recordsOf(sets)) {
              await sleep(25);
              yield r;
            }
            await sleep(25);
          },
        },
      },
      onPublish: (i) => published.push(i),
    });
    expect(ok(run.outputs[0]!).ids).toEqual(sets.a);
    expect(ok(run.outputs[1]!).ids).toEqual(at(4, [1]));
    // The stored-only output is in the same group, so it publishes after the feed ended too.
    expect(published.length).toBe(2);
  });
});
