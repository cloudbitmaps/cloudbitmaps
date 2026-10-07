/**
 * The chunk-ordered feed of a batch combine: every record is checked before the pass sees it, and a bad feed is refused
 * for every fed output, never read as fewer members.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
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
      /key 2: the key is below the previous record's \(3\)/,
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
      await expectRefused([{ key: 1, operands }], /operands must be an object/);
    }
    await expectRefused(
      [{ key: 1, operands: { b: u32(K + 1) } }],
      /key 1, operand "b": not a declared fed operand/,
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
        /key 1, operand "a": the ids must be a Uint32Array/,
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
