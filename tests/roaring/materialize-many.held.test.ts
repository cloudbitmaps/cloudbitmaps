/**
 * `store.memory` and held operands of `store.materializeMany`: every input form, the load's own error table, the brand test
 * that lets only a real `Uint32Array` skip the per-id check, empty operands, `release`, the erasure counter, the chunk cache
 * and the resident-bytes ledger.
 */
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  MemoryOperand,
  StaleOperandError,
  ValidationError,
  isStaleOperandError,
} from '@/index';
import type { MaterializeResult } from '@/index';
import { batchWorld, bitmapOf, range } from '../helpers/batch-world';
import type { BatchWorld } from '../helpers/batch-world';

const IDS = [3, 7, 65_535, 65_536, 70_000, 200_000, 4_000_000, 4_294_967_295];
const DATA = { a: range(0, 200_000, 3), b: [...range(60_000, 140_000), 4_000_000] };

const published = (o: unknown): MaterializeResult => {
  const r = o as MaterializeResult;
  expect(r.published).toBe(true);
  return r;
};
const failure = (o: unknown): Error => {
  const r = o as { published: boolean; error?: Error };
  expect(r.published).toBe(false);
  return r.error!;
};
const stale = (o: unknown): StaleOperandError => {
  const e = failure(o);
  expect(isStaleOperandError(e)).toBe(true);
  expect((e as StaleOperandError).reason).toBe('erased');
  return e as StaleOperandError;
};

/** The ids a held operand holds, read back by publishing it alone. */
async function idsOfHeld(w: BatchWorld, held: MemoryOperand, dest = 'held-out'): Promise<number[]> {
  const run = await w.store.materializeMany({
    operands: { v: held },
    outputs: [{ dest: w.store.segment(dest), expr: 'v', allowEmpty: true }],
    keep: 1,
    mayBeEmpty: ['v'],
  });
  published(run.outputs[0]);
  return w.ids(dest);
}
const sorted = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((x, y) => x - y);

describe('store.memory: the input forms', () => {
  it('holds ids from an array, a Set, a generator, an async generator, a Uint32Array, a bitmap and bytes', async () => {
    const w = await batchWorld();
    const want = sorted(IDS);
    async function* later(): AsyncGenerator<number> {
      for (const id of IDS) yield id;
    }
    const bytes = bitmapOf(IDS).serialize('portable');
    const forms: Array<[string, Parameters<typeof w.store.memory>[0]]> = [
      ['array', [...IDS].reverse()],
      ['set', new Set(IDS)],
      [
        'generator',
        (function* () {
          yield* IDS;
        })(),
      ],
      ['async generator', later()],
      ['Uint32Array', Uint32Array.from(IDS)],
      ['bitmap', { bitmap: bitmapOf(IDS) }],
      ['serialized', { serialized: bytes }],
    ];
    for (const [name, input] of forms) {
      const held = await w.store.memory(input);
      expect(held, name).toBeInstanceOf(MemoryOperand);
      expect(await idsOfHeld(w, held, `out-${name.replace(' ', '-')}`), name).toEqual(want);
    }
  });

  it('is not a constructible handle, and no other verb takes it', async () => {
    const w = await batchWorld(DATA);
    const vip = await w.store.memory([1, 2, 3]);
    expect(() => new (MemoryOperand as unknown as new (v: unknown) => unknown)({})).toThrow(
      ValidationError,
    );
    const a = w.store.segment('a') as unknown as Record<string, (...args: unknown[]) => unknown>;
    const heldOnly =
      /^a memory operand from store\.memory\(\) is an operand of store\.materializeMany\(\) only/;
    const read = async (stream: unknown): Promise<void> => {
      for await (const _ of stream as AsyncIterable<number>) void _;
    };
    for (const verb of ['intersect', 'union', 'andNot']) {
      // A combine refuses a held operand, or one in `exclude`, when its result is read: a ValidationError, never a
      // TypeError from reading it as a segment.
      await expect(read(a[verb]!([vip])), verb).rejects.toThrow(ValidationError);
      await expect(read(a[verb]!([vip])), verb).rejects.toThrow(heldOnly);
      await expect(read(a[verb]!(['a'])), verb).rejects.toThrow(
        'an operand must be a segment from store.segment()',
      );
    }
    for (const verb of ['intersect', 'union']) {
      await expect(read(a[verb]!([], { exclude: [vip] })), verb).rejects.toThrow(heldOnly);
    }
    const d = w.store.segment('d');
    for (const verb of ['intersectInto', 'unionInto', 'andNotInto']) {
      // An `*Into` call refuses it before reading anything, as an operand, an exclude or the destination.
      await expect(a[verb]!(d, [vip]), verb).rejects.toThrow(heldOnly);
      await expect(a[verb]!(vip, []), verb).rejects.toThrow(heldOnly);
    }
    for (const verb of ['intersectInto', 'unionInto']) {
      await expect(a[verb]!(d, [], { exclude: [vip] }), verb).rejects.toThrow(heldOnly);
    }
    for (const value of [null, 5, {}, 'a']) {
      await expect(a['intersectInto']!(d, [value]), String(value)).rejects.toThrow(
        'an operand must be a segment from store.segment()',
      );
    }
    expect(await w.store.exists({ segment: 'd' })).toBe(false);
    await expect(
      w.store.materializeMany({
        operands: { a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        keep: 1,
        // a held operand as an exclude name that the call does not hold is an unknown operand
        ...({ mayBeEmpty: ['vip'] } as object),
      }),
    ).rejects.toThrow(/mayBeEmpty names "vip", which is not an operand of this call;/);
  });

  it('refuses a forged handle with a ValidationError naming the operand', async () => {
    const w = await batchWorld(DATA);
    const forged = Object.create(MemoryOperand.prototype) as MemoryOperand;
    await expect(
      w.store.materializeMany({
        operands: { fake: forged, a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        keep: 1,
      }),
    ).rejects.toThrow(/operands\["fake"\] is not a memory operand/);
  });

  it('holds the real contents of a Uint32Array subclass whose length and iterator lie', async () => {
    const w = await batchWorld();
    class Liar extends Uint32Array {
      override get length(): number {
        return 1;
      }
      override [Symbol.iterator](): ArrayIterator<number> {
        return [0][Symbol.iterator]() as ArrayIterator<number>;
      }
    }
    expect(await idsOfHeld(w, await w.store.memory(Liar.from([5, 9, 70_000])), 'liar')).toEqual([
      5, 9, 70_000,
    ]);
  });

  it('refuses an object with an `ascending` key, naming the feed', async () => {
    const w = await batchWorld();
    const input = { ids: Uint32Array.from([1, 2]), ascending: true } as never;
    await expect(w.store.memory(input)).rejects.toThrow(/feed/);
    await expect(w.store.memory(input)).rejects.toBeInstanceOf(ValidationError);
  });

  it('holds what the ids were when it was made, not what they became', async () => {
    const w = await batchWorld();
    const ids = Uint32Array.from([5, 6, 7]);
    const bitmap = bitmapOf([5, 6, 7]);
    const a = await w.store.memory(ids);
    const b = await w.store.memory({ bitmap });
    ids[0] = 99;
    bitmap.add(1000);
    expect(await idsOfHeld(w, a, 'oa')).toEqual([5, 6, 7]);
    expect(await idsOfHeld(w, b, 'ob')).toEqual([5, 6, 7]);
  });
});

describe("store.memory: the load's own error table", () => {
  const concat = Uint8Array.from([
    ...bitmapOf([1, 2]).serialize('portable'),
    ...bitmapOf([3]).serialize('portable'),
  ]);
  async function* badAsync(): AsyncGenerator<number> {
    yield 1;
    yield -1;
  }
  const table: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['a number', () => 5],
    ['a Uint8Array as ids', () => Uint8Array.from([1, 2])],
    ['a Buffer as ids', () => Buffer.from([1, 2])],
    ['an unknown key', () => ({ foo: [1] })],
    ['two keys', () => ({ serialized: new Uint8Array(0), bitmap: bitmapOf([1]) })],
    ['serialized that is not bytes', () => ({ serialized: 'nope' })],
    ['serialized garbage', () => ({ serialized: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]) })],
    ['two bitmaps back to back', () => ({ serialized: concat })],
    ['a bitmap with no serialize', () => ({ bitmap: {} })],
    [
      'a bitmap over the cap',
      () => ({
        bitmap: { serialize: () => new Uint8Array(0), getSerializationSizeInBytes: () => 2 ** 31 },
      }),
    ],
    ['a negative id', () => [1, -1]],
    ['a fractional id', () => [1.5]],
    ['an id past 2^32', () => [2 ** 32]],
    ['NaN', () => [Number.NaN]],
    ['a string id', () => ['7']],
    ['a bad id from an async iterable', () => badAsync()],
    ['an Int32Array holding -1', () => Int32Array.from([-1])],
    ['a Float64Array holding 1.5', () => Float64Array.from([1.5])],
    ['a Float64Array holding NaN', () => Float64Array.from([Number.NaN])],
  ];
  for (const [name, input] of table) {
    it(`refuses ${name} as a load does, with the same class`, async () => {
      const w = await batchWorld();
      const load = await w.store.load({ segment: 'x' }, input() as never).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      const memory = await w.store.memory(input() as never).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(load, 'the load refuses it').toBeInstanceOf(Error);
      expect(memory, 'memory refuses it').toBeInstanceOf(Error);
      expect(memory!.constructor).toBe(load!.constructor);
      expect(memory!.constructor).toBe(ValidationError);
      expect(memory!.message).not.toMatch(/\ba load\b/);
    });
  }
});

describe('store.memory: only a real Uint32Array skips the per-id check', () => {
  it('accepts a real, a subclassed, a cross-realm and a SharedArrayBuffer-backed Uint32Array', async () => {
    const w = await batchWorld();
    const want = [5, 70_000, 4_294_967_295];
    class Liar extends Uint32Array {
      override get length(): number {
        return 1;
      }
      override [Symbol.iterator](): ArrayIterator<number> {
        return [0][Symbol.iterator]() as ArrayIterator<number>;
      }
    }
    const shared = new Uint32Array(new SharedArrayBuffer(12));
    shared.set(want);
    const crossRealm = vm.runInNewContext('new Uint32Array([5, 70000, 4294967295])') as Uint32Array;
    for (const [name, input] of [
      ['real', Uint32Array.from(want)],
      ['subclass that lies about its length and iterator', Liar.from(want)],
      ['cross-realm', crossRealm],
      ['shared', shared],
      [
        'a view into a larger buffer',
        new Uint32Array(Uint32Array.from([9, ...want, 9]).buffer, 4, 3),
      ],
    ] as const) {
      expect(await idsOfHeld(w, await w.store.memory(input), 'brand'), name).toEqual(want);
    }
  });

  it('sends every other typed array, a spoof and a proxy through the per-id check', async () => {
    const w = await batchWorld();
    const spoof = {
      [Symbol.toStringTag]: 'Uint32Array',
      *[Symbol.iterator]() {
        yield 4;
        yield -1;
      },
    };
    const proxy = new Proxy(Uint32Array.from([1, 2]), {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          return function* () {
            yield 2 ** 32 + 7;
          };
        }
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    for (const [name, input] of [
      ['Int32Array([-1])', Int32Array.from([-1])],
      ['Float64Array([1.5])', Float64Array.from([1.5])],
      ['Float64Array([NaN])', Float64Array.from([Number.NaN])],
      ['number[] with a bad id', [1, 2 ** 32]],
      ['a toStringTag spoof', spoof],
      ['a proxy of a Uint32Array', proxy],
    ] as const) {
      await expect(w.store.memory(input as never), name).rejects.toBeInstanceOf(ValidationError);
    }
    // the same typed arrays holding valid ids are accepted: they are checked, not refused
    for (const input of [
      Int32Array.from([5, 6]),
      Float64Array.from([5, 6]),
      Uint16Array.from([5, 6]),
    ]) {
      expect(await idsOfHeld(w, await w.store.memory(input), 'ok')).toEqual([5, 6]);
    }
  });

  it('refuses a Uint32Array over a detached buffer rather than reading it as empty', async () => {
    const w = await batchWorld();
    const buf = new ArrayBuffer(8);
    const view = new Uint32Array(buf);
    structuredClone(buf, { transfer: [buf] });
    await expect(w.store.memory(view)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('an empty held operand', () => {
  it('is accepted by store.memory, and refused by the call unless its name is in mayBeEmpty', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    for (const input of [[], new Uint32Array(0), { bitmap: bitmapOf([]) }]) {
      const none = await w.store.memory(input as never);
      w.resetCalls();
      await expect(
        w.store.materializeMany({
          operands: { a: s('a'), none },
          outputs: [{ dest: s('d1'), expr: { and: ['a', 'none'] } }],
          keep: 1,
        }),
      ).rejects.toThrow(/operand "none" holds no id/);
      expect(w.calls.storage + w.calls.registry).toBe(0);
    }
  });

  it('with mayBeEmpty, an AND empties and an exclude subtracts nothing', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const none = await w.store.memory([]);
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), none },
      outputs: [
        { dest: s('and'), expr: { and: ['a', 'none'] }, allowEmpty: true },
        { dest: s('minus'), expr: 'a', exclude: ['none'] },
        { dest: s('or'), expr: { or: ['b', 'none'] } },
      ],
      mayBeEmpty: ['none'],
      keep: 1,
    });
    run.outputs.forEach((o) => published(o));
    expect(await w.ids('and')).toEqual([]);
    expect(await w.ids('minus')).toEqual(DATA.a);
    expect(await w.ids('or')).toEqual(sorted(DATA.b));
  });

  it('names only operands it can empty: a stored name in mayBeEmpty is refused', async () => {
    const w = await batchWorld(DATA);
    const none = await w.store.memory([]);
    await expect(
      w.store.materializeMany({
        operands: { a: w.store.segment('a'), none },
        outputs: [{ dest: w.store.segment('d'), expr: 'a', exclude: ['none'] }],
        mayBeEmpty: ['none', 'a'],
        keep: 1,
      }),
    ).rejects.toThrow(/mayBeEmpty names "a", a stored operand;/);
  });
});

describe('release', () => {
  it('makes every later use throw, is harmless twice, and zeroes the bytes', async () => {
    const w = await batchWorld(DATA);
    const vip = await w.store.memory(IDS);
    const chunks = (vip as unknown as { view: { chunks: { payload(k: number): Uint8Array } } }).view
      .chunks;
    const payload = chunks.payload(0);
    expect(payload.some((b) => b !== 0)).toBe(true);
    vip.release();
    vip.release();
    expect(payload.every((b) => b === 0)).toBe(true);
    w.resetCalls();
    await expect(
      w.store.materializeMany({
        operands: { vip, a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'vip' }],
        keep: 1,
      }),
    ).rejects.toThrow(/operands\["vip"\] was released/);
    expect(w.calls.storage + w.calls.registry).toBe(0);
  });

  it('a release while a call runs fails the outputs that read it, never reads zeros', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const vip = await w.store.memory(range(0, 150_000, 2));
    w.hooks.beforeRange = () => {
      w.hooks.beforeRange = undefined;
      vip.release();
    };
    const run = await w.store.materializeMany({
      operands: { vip, a: s('a') },
      outputs: [
        { dest: s('with-vip'), expr: { and: ['a', 'vip'] } },
        { dest: s('without'), expr: 'a' },
      ],
      keep: 1,
    });
    expect(failure(run.outputs[0])).toBeInstanceOf(ValidationError);
    published(run.outputs[1]);
    expect(await w.store.exists({ segment: 'with-vip' })).toBe(false);
  });
});

describe('a handle belongs to one store', () => {
  it('is refused by another store, before any request', async () => {
    const w = await batchWorld(DATA);
    const vip = await w.store.memory([1, 2, 3]);
    w.resetCalls();
    await expect(
      w.other.materializeMany({
        operands: { vip, a: w.other.segment('a') },
        outputs: [{ dest: w.other.segment('d'), expr: 'vip' }],
        keep: 1,
      }),
    ).rejects.toThrow(/made by another store/);
    expect(w.calls.storage + w.calls.registry).toBe(0);
  });
});

describe('an erasure in the store', () => {
  const erase = (w: BatchWorld, store = w.store) =>
    store.eraseSubject(4_000_000, { allNamespaces: true });

  it('makes a handle made before it stale, and a handle made after it works', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const before = await w.store.memory([1, 2, 3]);
    await erase(w);
    const after = await w.store.memory([4, 5, 6]);
    w.resetCalls();
    const run = await w.store.materializeMany({
      operands: { before, after, a: s('a') },
      outputs: [
        { dest: s('o-before'), expr: 'before' },
        { dest: s('o-after'), expr: 'after' },
        { dest: s('o-stored'), expr: 'a' },
        { dest: s('o-both'), expr: { or: ['after', 'before'] } },
      ],
      keep: 1,
    });
    expect(stale(run.outputs[0]).operand).toBe('before');
    published(run.outputs[1]);
    published(run.outputs[2]);
    expect(stale(run.outputs[3]).operand).toBe('before');
    expect(await w.store.exists({ segment: 'o-before' })).toBe(false);
    expect(await w.store.exists({ segment: 'o-both' })).toBe(false);
    expect(await w.ids('o-after')).toEqual([4, 5, 6]);
  });

  it('is refused before any request, even for an output that also reads a stored operand', async () => {
    const w = await batchWorld(DATA);
    const before = await w.store.memory([1, 2, 3]);
    await erase(w);
    w.resetCalls();
    const run = await w.store.materializeMany({
      operands: { before, a: w.store.segment('a') },
      outputs: [{ dest: w.store.segment('o'), expr: { and: ['a', 'before'] } }],
      keep: 1,
    });
    stale(run.outputs[0]);
    expect(w.calls.ranges).toBe(0);
  });

  it('refuses a handle made while an erasure is still running, and accepts one made after it ends', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const probe = w.store as unknown as { erasuresRunning: number };
    // Hold the erasure at its first registry read so that it is still running while the handle is made and the call runs.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    w.hooks.beforeRowRead = async () => {
      if (!armed) return;
      armed = false;
      await gate;
    };
    const erasure = erase(w);
    for (let i = 0; i < 1_000 && probe.erasuresRunning === 0; i++) await Promise.resolve();
    expect(probe.erasuresRunning).toBe(1);
    const during = await w.store.memory([1, 2, 3]);
    const run = await w.store.materializeMany({
      operands: { during },
      outputs: [{ dest: s('o-during'), expr: 'during' }],
      keep: 1,
    });
    expect(stale(run.outputs[0]).operand).toBe('during');
    expect(await w.store.exists({ segment: 'o-during' })).toBe(false);
    release();
    await erasure;
    // the handle made while it ran stays refused once it ended, and one made after works
    const again = await w.store.materializeMany({
      operands: { during },
      outputs: [{ dest: s('o-again'), expr: 'during' }],
      keep: 1,
    });
    stale(again.outputs[0]);
    const after = await w.store.memory([4, 5]);
    const ok = await w.store.materializeMany({
      operands: { after },
      outputs: [{ dest: s('o-after'), expr: 'after' }],
      keep: 1,
    });
    published(ok.outputs[0]);
    expect(await w.ids('o-after')).toEqual([4, 5]);
  });

  it('refuses a handle made while erasures overlap, until the last of them has ended', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const waiting: Array<() => void> = [];
    let armed = true;
    w.hooks.beforeRowRead = async () => {
      if (armed) await new Promise<void>((resolve) => waiting.push(resolve));
    };
    // One row read at a time, so that each erasure is held at exactly one.
    const first = w.store.eraseSubject(4_000_000, { allNamespaces: true, concurrency: 1 });
    const second = w.store.eraseSubject(4_000_001, { allNamespaces: true, concurrency: 1 });
    for (let i = 0; i < 1_000 && waiting.length < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(waiting.length).toBe(2);
    armed = false;
    const use = async (h: MemoryOperand, dest: string) =>
      (
        await w.store.materializeMany({
          operands: { h },
          outputs: [{ dest: s(dest), expr: 'h' }],
          keep: 1,
        })
      ).outputs[0];
    // Two erasures running, whatever the counter reads: a handle made now is refused.
    const both = await w.store.memory([1, 2, 3]);
    expect(stale(await use(both, 'o-both')).operand).toBe('h');
    waiting.shift()!();
    await Promise.race([first, second]);
    // One has ended and one still runs: a handle made now is refused too.
    const one = await w.store.memory([1, 2, 3]);
    stale(await use(one, 'o-one'));
    while (waiting.length > 0) waiting.shift()!();
    await Promise.all([first, second]);
    stale(await use(both, 'o-both-again'));
    const after = await w.store.memory([4, 5]);
    published(await use(after, 'o-after'));
    expect(await w.ids('o-after')).toEqual([4, 5]);
  });

  it('an erasure that starts while a handle is being made makes it stale', async () => {
    const w = await batchWorld(DATA);
    async function* slow(): AsyncGenerator<number> {
      yield 1;
      await erase(w);
      yield 2;
    }
    const vip = await w.store.memory(slow());
    const run = await w.store.materializeMany({
      operands: { vip },
      outputs: [{ dest: w.store.segment('o'), expr: 'vip' }],
      keep: 1,
    });
    stale(run.outputs[0]);
  });

  it('is not seen when it runs in another store: that is deliberate, and documented', async () => {
    const w = await batchWorld(DATA);
    const vip = await w.store.memory([1, 2, 3]);
    await erase(w, w.other);
    const run = await w.store.materializeMany({
      operands: { vip },
      outputs: [{ dest: w.store.segment('o'), expr: 'vip' }],
      keep: 1,
    });
    published(run.outputs[0]);
  });

  it('during the call, before an output is published, fails that output and no other', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const vip = await w.store.memory(range(0, 100, 5));
    // A destination that holds a generation is published by a compare-and-swap, which the hook can see.
    await w.load('o-1', [1]);
    w.hooks.beforeCas = async (seg) => {
      if (seg === 'o-1') {
        w.hooks.beforeCas = undefined;
        await erase(w);
      }
    };
    const run = await w.store.materializeMany({
      operands: { vip, a: s('a') },
      publishConcurrency: 1,
      outputs: [
        { dest: s('o-1'), expr: 'a' },
        { dest: s('o-2'), expr: { and: ['a', 'vip'] } },
        { dest: s('o-3'), expr: 'a', exclude: ['vip'] },
        { dest: s('o-4'), expr: 'a' },
      ],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(stale(run.outputs[1]).operand).toBe('vip');
    expect(stale(run.outputs[2]).operand).toBe('vip');
    published(run.outputs[3]);
    expect(await w.store.exists({ segment: 'o-2' })).toBe(false);
  });

  it('a stored-only call reads no counter; rollback and retireExpired do not move it', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const probe = w.store as unknown as { epochNow(): number; erasureEpoch: number };
    const spy = vi.spyOn(probe, 'epochNow');
    published(
      (
        await w.store.materializeMany({
          operands: { a: s('a') },
          outputs: [{ dest: s('d-stored'), expr: 'a' }],
          keep: 1,
        })
      ).outputs[0],
    );
    expect(spy).not.toHaveBeenCalled();
    const vip = await w.store.memory([1]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await w.store.materializeMany({
      operands: { a: s('a'), vip },
      outputs: [{ dest: s('d-held'), expr: 'vip' }],
      keep: 1,
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const mid = probe.erasureEpoch;
    await w.load('b', [1, 2, 3]);
    await w.store.rollback({ segment: 'b' }, 0);
    await w.store.retireExpired({ namespace: 'x' });
    expect(probe.erasureEpoch).toBe(mid);
    // such a handle is still good
    published(
      (
        await w.store.materializeMany({
          operands: { vip },
          outputs: [{ dest: s('d-still'), expr: 'vip' }],
          keep: 1,
        })
      ).outputs[0],
    );
  });
});

describe('the chunk cache and the ledger', () => {
  it('a call over held operands leaves the shared cache as it was, and a hot stored chunk survives a large one', async () => {
    const events: Array<{ kind: string; hit?: boolean }> = [];
    const w = await batchWorld(DATA, { metrics: { onEvent: (e) => events.push(e as never) } });
    const s = (n: string) => w.store.segment(n);
    const cache = (w.store as unknown as { cache: { size: number } }).cache;
    expect(await s('a').has(6)).toBe(true);
    const warm = cache.size;
    events.length = 0;
    // 1,000 chunks held: far more than a hot one's share
    const wide = await w.store.memory(range(0, 1_000 * 65_536, 65_537));
    const run = await w.store.materializeMany({
      operands: { wide, a: s('a') },
      outputs: [{ dest: s('d'), expr: { or: ['wide', 'a'] } }],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(events.filter((e) => e.kind === 'cache')).toEqual([]);
    expect(cache.size).toBe(warm);
    w.calls.ranges = 0;
    expect(await s('a').has(6)).toBe(true);
    expect(w.calls.ranges).toBe(0);
    // control: the observation does see a chunk that is cached
    events.length = 0;
    expect(await s('b').has(61_000)).toBe(true);
    expect(cache.size).toBeGreaterThan(warm);
    expect(events.some((e) => e.kind === 'cache')).toBe(true);
  });

  it('a held operand never aliases a stored segment, whatever either is called', async () => {
    const w = await batchWorld({ m0: [1, 2, 3], m1: [10, 11], 'mem:0': [20], held: [30] });
    const s = (n: string) => w.store.segment(n);
    const vip = await w.store.memory([100, 101]);
    const run = await w.store.materializeMany({
      operands: {
        m0: s('m0'),
        m1: s('m1'),
        'mem:0': s('mem:0'),
        held: s('held'),
        x: vip,
        y: await w.store.memory([200]),
      },
      outputs: [
        { dest: s('o1'), expr: { or: ['m0', 'x'] } },
        { dest: s('o2'), expr: { or: ['m1', 'y', 'mem:0'] } },
        { dest: s('o3'), expr: { or: ['held', 'x', 'y'] } },
      ],
      keep: 1,
    });
    run.outputs.forEach((o) => published(o));
    expect(await w.ids('o1')).toEqual([1, 2, 3, 100, 101]);
    expect(await w.ids('o2')).toEqual([10, 11, 20, 200]);
    expect(await w.ids('o3')).toEqual([30, 100, 101, 200]);
  });

  it('counts a held operand against maxBufferedBytes while the call runs', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const big = await w.store.memory(range(0, 100 * 65_536, 3_000));
    const base = await w.store.materializeMany({
      operands: { big },
      outputs: [{ dest: s('d1'), expr: 'big' }],
      keep: 1,
    });
    published(base.outputs[0]);
    const resident = base.stats.memory.highWaterBytes;
    expect(resident).toBeGreaterThan(20_000);
    const run = w.store.materializeMany({
      operands: { big },
      outputs: [{ dest: s('d2'), expr: 'big' }],
      maxBufferedBytes: 10_000,
      keep: 1,
    });
    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(run).rejects.toThrow(/held operands/);
    // a held operand is a read of memory, not of the store
    w.resetCalls();
    await w.store.materializeMany({
      operands: { big },
      outputs: [{ dest: s('d3'), expr: 'big' }],
      keep: 1,
    });
    expect(w.calls.ranges).toBe(0);
  });
});
