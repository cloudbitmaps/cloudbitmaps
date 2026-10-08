import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CountingMetricsSink,
  NotFoundError,
  RecordingAuditSink,
  StaleOperandError,
  ValidationError,
} from '@/index';
import type {
  MaterializeDryRunResult,
  MaterializeManyDryRun,
  MaterializeManyOptions,
  MaterializeManyRun,
  MaterializeResult,
} from '@/index';
import { judgeLoad, loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  TransientError,
  UnsupportedError,
  ValidationError as CoreValidationError,
} from '@/core/errors';
import type { IRegistryDriver, IStorageDriver } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { batchWorld, range } from '../helpers/batch-world';
import { feedOf, lcg, recordsOf } from '../helpers/combine-feed';

/**
 * `materializeMany({ dryRun: true })`: every output computed and judged as its publish would be, nothing written.
 *
 * What a caller relies on, and so what these pin: it writes nothing at all (no object, no pointer, no audit event); each
 * result's size is the size the publish writes; `wouldRefuse` is the reason the publish would give, for every bound; what
 * fails a publish fails the dry run's output too; and a call without `dryRun` is exactly what it was, types included.
 */

const DATA = {
  a: range(0, 5_000),
  b: range(2_000, 9_000),
  optout: range(0, 9_000, 10),
  small: range(0, 100),
  big: range(0, 3_000),
};

const dry = (o: unknown): MaterializeDryRunResult => {
  const r = o as MaterializeDryRunResult;
  expect(r).toMatchObject({ dryRun: true, published: false });
  return r;
};

describe('materializeMany({ dryRun: true })', () => {
  it('writes nothing, and reports what each publish would write and what it would replace', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const audit = new RecordingAuditSink();
    const before = await w.ids('small');
    w.resetCalls();
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), optout: s('optout') },
      outputs: [
        { dest: s('small'), expr: { and: ['a', 'b'] }, exclude: ['optout'], audit },
        { dest: s('fresh'), expr: { or: ['a', 'b'] }, audit },
      ],
      keep: 1,
      dryRun: true,
    });
    expect(w.calls.puts).toBe(0);
    expect(w.calls.rowWrites).toBe(0);
    expect(audit.snapshot()).toEqual([]);
    expect(await w.ids('small')).toEqual(before);
    expect(await w.store.exists({ segment: 'fresh' })).toBe(false);
    expect(run.stats.requests.publishes).toBe(0);
    expect(run.stats.requests.attributed.put).toBe(0);
    // One read of each dest's row: `small`'s carries its size, and `fresh` has none.
    const { rangeReads, registryReads, attributed } = run.stats.requests;
    expect(attributed.get - rangeReads - registryReads).toBe(2);

    const [first, second] = run.outputs.map(dry);
    expect(first).toEqual({
      dryRun: true,
      published: false,
      cardinality: 3_000 - 300,
      cardinalityBefore: 100,
    });
    expect(second).toEqual({
      dryRun: true,
      published: false,
      cardinality: 9_000,
      cardinalityBefore: null,
    });

    // The same call without `dryRun` writes exactly what the dry run counted.
    const published = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), optout: s('optout') },
      outputs: [
        { dest: s('small'), expr: { and: ['a', 'b'] }, exclude: ['optout'] },
        { dest: s('fresh'), expr: { or: ['a', 'b'] } },
      ],
      keep: 1,
    });
    expect(published.outputs.map((o) => (o as MaterializeResult).cardinality)).toEqual([
      first!.cardinality,
      second!.cardinality,
    ]);
  });

  it('reports the reason each bound would refuse the publish, and none when it would publish', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    // Each destination has a current generation to judge against.
    for (const [d, ids] of [
      ['d-empty', range(0, 10)],
      ['d-min', range(0, 10)],
      ['d-shrink', range(0, 1_000)],
      ['d-grow', range(0, 1_000)],
      ['d-ok', range(0, 2_000)],
      ['d-allowed', range(0, 10)],
    ] as const) {
      await w.load(d, ids);
    }
    const judged = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), small: s('small'), big: s('big') },
      outputs: [
        { dest: s('d-empty'), expr: { andNot: ['small', 'a'] } },
        { dest: s('d-min'), expr: 'small', guard: { minCardinality: 1_000 } },
        { dest: s('d-shrink'), expr: 'small', guard: { minRetained: 0.5 } },
        { dest: s('d-grow'), expr: 'big', guard: { maxGrowth: 2 } },
        { dest: s('d-ok'), expr: 'big', guard: { maxGrowth: 2, minRetained: 0.5 } },
        { dest: s('d-allowed'), expr: { andNot: ['small', 'a'] }, allowEmpty: true },
      ],
      keep: 1,
      dryRun: true,
    });
    expect(judged.outputs.map((o) => dry(o).wouldRefuse)).toEqual([
      'empty',
      'min-cardinality',
      'min-retained',
      'max-growth',
      undefined,
      undefined,
    ]);
    expect(judged.outputs.map((o) => dry(o).cardinalityBefore)).toEqual([
      10, 10, 1_000, 1_000, 2_000, 10,
    ]);
    // And a publish of the same outputs is refused for exactly those reasons.
    const real = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), small: s('small'), big: s('big') },
      outputs: [
        { dest: s('d-empty'), expr: { andNot: ['small', 'a'] } },
        { dest: s('d-min'), expr: 'small', guard: { minCardinality: 1_000 } },
        { dest: s('d-shrink'), expr: 'small', guard: { minRetained: 0.5 } },
        { dest: s('d-grow'), expr: 'big', guard: { maxGrowth: 2 } },
        { dest: s('d-ok'), expr: 'big', guard: { maxGrowth: 2, minRetained: 0.5 } },
        { dest: s('d-allowed'), expr: { andNot: ['small', 'a'] }, allowEmpty: true },
      ],
      keep: 1,
    });
    expect(real.outputs.map((o) => (o as MaterializeResult).reason)).toEqual([
      'empty',
      'min-cardinality',
      'min-retained',
      'max-growth',
      undefined,
      undefined,
    ]);
  });

  it('fails an output for what would fail its publish: a destroyed destination', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    await w.load('gone', range(0, 10));
    await w.store.dropSegment({ segment: 'gone' }, { confirmSegment: 'gone' });
    const run = await w.store.materializeMany({
      operands: { a: s('a') },
      outputs: [
        { dest: s('gone'), expr: 'a' },
        { dest: s('kept'), expr: 'a' },
      ],
      keep: 1,
      dryRun: true,
    });
    expect(run.outputs[0]).toMatchObject({ published: false, error: expect.any(ValidationError) });
    expect((run.outputs[0] as { error: Error }).error.message).toMatch(
      /is destroyed .* refusing to write/,
    );
    expect(dry(run.outputs[1]).cardinality).toBe(5_000);
  });

  it('refuses a dryRun that is not a boolean, and a destination that is an operand, before any request', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    w.resetCalls();
    await expect(
      w.store.materializeMany({
        operands: { a: s('a') },
        outputs: [{ dest: s('d'), expr: 'a' }],
        keep: 1,
        dryRun: 'yes' as unknown as true,
      }),
    ).rejects.toThrow(/dryRun must be a boolean/);
    await expect(
      w.store.materializeMany({
        operands: { a: s('a'), b: s('b') },
        outputs: [{ dest: s('b'), expr: { and: ['a', 'b'] } }],
        keep: 1,
        dryRun: true,
      }),
    ).rejects.toThrow(/is also an operand of the call/);
    expect(w.calls.storage + w.calls.registry).toBe(0);
  });

  it('takes a feed, and an erasure while it runs fails the fed outputs as it would a publish', async () => {
    const w = await batchWorld({ optout: DATA.optout });
    const s = (n: string) => w.store.segment(n);
    const fed = { us: range(0, 6_000), engaged: range(3_000, 9_000) };
    const feed = () => ({
      names: Object.keys(fed),
      records: feedOf(recordsOf(fed, lcg(7))),
      counts: Object.fromEntries(Object.entries(fed).map(([k, v]) => [k, v.length])),
    });
    const run = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: feed(),
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [{ dest: s('send'), expr: { and: ['us', 'engaged'] }, exclude: ['optout'] }],
      keep: 1,
      dryRun: true,
    });
    expect(dry(run.outputs[0]).cardinality).toBe(3_000 - 300);
    expect(run.stats.feed?.ids).toBe(12_000);

    const erasing = await w.store.materializeMany({
      operands: { optout: s('optout') },
      feed: {
        ...feed(),
        records: (async function* () {
          let i = 0;
          for await (const r of feedOf(recordsOf(fed, lcg(7)))) {
            if (i++ === 1) await w.store.eraseSubject(4_000_000, { allNamespaces: true });
            yield r;
          }
        })(),
      },
      maxBufferedBytes: 64 * 1024 * 1024,
      outputs: [{ dest: s('send'), expr: { and: ['us', 'engaged'] } }],
      keep: 1,
      dryRun: true,
    });
    expect(erasing.outputs[0]).toMatchObject({
      published: false,
      error: expect.any(StaleOperandError),
    });
  });

  it('publishes what was reviewed on leased pins, and an erasure between the calls fails the outputs that read it', async () => {
    const w = await batchWorld(DATA);
    const until = Date.now() + 3_600_000;
    const a = await w.store.segment('a').pin({ leaseUntil: until });
    const b = await w.store.segment('b').pin({ leaseUntil: until });
    const outputs = [
      { dest: w.store.segment('d-a'), expr: 'a' },
      { dest: w.store.segment('d-b'), expr: 'b' },
    ];
    const review = await w.store.materializeMany({
      operands: { a, b },
      outputs,
      keep: 1,
      dryRun: true,
    });
    // Another writer moves `a` after the review: the leased pin still reads the generation that was reviewed.
    await w.load('a', range(0, 10), w.other);
    const same = await w.store.materializeMany({ operands: { a, b }, outputs, keep: 1 });
    expect(same.outputs.map((o) => (o as MaterializeResult).cardinality)).toEqual(
      review.outputs.map((o) => dry(o).cardinality),
    );

    // Now an erasure of an id `a` held lands between a review and its publish.
    const again = await w.store.materializeMany({
      operands: { a, b },
      outputs,
      keep: 1,
      dryRun: true,
    });
    expect(dry(again.outputs[0]).cardinality).toBe(5_000);
    await w.store.eraseSubject(42, { allNamespaces: true });
    const after = await w.store.materializeMany({ operands: { a, b }, outputs, keep: 1 });
    expect(after.outputs[0]).toMatchObject({
      published: false,
      error: expect.any(NotFoundError),
    });
    expect(await w.ids('d-a')).not.toContain(42);
    expect((after.outputs[1] as MaterializeResult).published).toBe(true);
  });

  it('counts the overlap of each output with what is live, in a second dry run, as the guide shows', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    await w.load('d-0', range(0, 4_000)); // live: 0..3999
    const operands = { a: s('a'), b: s('b') };
    const outputs = [
      { dest: s('d-0'), expr: { and: ['a', 'b'] } }, // new: 2000..4999
      { dest: s('d-1'), expr: 'a' }, // no current generation yet
    ];
    const overlap = await w.store.materializeMany({
      operands: {
        ...operands,
        ...Object.fromEntries(outputs.map((o, i) => ['live-' + i, o.dest])),
      },
      outputs: outputs.map((o, i) => ({
        dest: s('overlap-' + i),
        expr: { and: [o.expr, 'live-' + i] },
        allowEmpty: true,
      })),
      allowAbsentOperands: true,
      keep: 1,
      dryRun: true,
    });
    expect(overlap.outputs.map((o) => dry(o).cardinality)).toEqual([2_000, 0]);
    expect(await w.store.exists({ segment: 'overlap-0' })).toBe(false);
  });

  it('holds the memory a publish would, so it is admitted and refused for memory where the publish would be', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const call = {
      operands: { a: s('a'), b: s('b') },
      outputs: [
        { dest: s('m-1'), expr: { or: ['a', 'b'] } },
        { dest: s('m-2'), expr: 'a' },
      ],
      keep: 1,
      publishConcurrency: 1,
    };
    const looked = await w.store.materializeMany({ ...call, dryRun: true });
    const wrote = await w.store.materializeMany(call);
    expect(looked.stats.memory.highWaterBytes).toBe(wrote.stats.memory.highWaterBytes);
    expect(looked.stats.groups).toBe(wrote.stats.groups);
  });

  it('reports its op to the metrics sink, as a publishing call does', async () => {
    const metrics = new CountingMetricsSink();
    const w = await batchWorld(DATA, { metrics });
    const s = (n: string) => w.store.segment(n);
    await w.store.materializeMany({
      operands: { a: s('a') },
      outputs: [{ dest: s('d'), expr: 'a' }],
      keep: 1,
      dryRun: true,
    });
    expect(metrics.snapshot().ops.materializeMany?.count).toBe(1);
  });

  it('keeps the types of a call without dryRun exactly as they were', () => {
    type Store = Awaited<ReturnType<typeof batchWorld>>['store'];
    const call = (store: Store, options: MaterializeManyOptions) => store.materializeMany(options);
    expectTypeOf(call).returns.resolves.toEqualTypeOf<MaterializeManyRun>();
    const dryCall = (store: Store, options: MaterializeManyOptions) =>
      store.materializeMany({ ...options, dryRun: true });
    expectTypeOf(dryCall).returns.resolves.toEqualTypeOf<MaterializeManyDryRun>();
    const explicitlyNot = (store: Store, options: MaterializeManyOptions) =>
      store.materializeMany({ ...options, dryRun: false });
    expectTypeOf(explicitlyNot).returns.resolves.toEqualTypeOf<MaterializeManyRun>();
    // The utility types read the last overload, which is the form without `dryRun`, as they read the one signature before.
    expectTypeOf<ReturnType<Store['materializeMany']>>().toEqualTypeOf<
      Promise<MaterializeManyRun>
    >();
    expectTypeOf<Parameters<Store['materializeMany']>[0]>().toMatchTypeOf<MaterializeManyOptions>();
  });
});

describe('judgeLoad', () => {
  const SEG = { segment: 'j' };
  const deps = () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    return { storage, registry, codec: roaringCodec };
  };

  it('reads the object when the row has no usable summary, and counts both reads', async () => {
    const d = deps();
    await loadSegment(SEG, range(0, 40), d);
    const bare: IRegistryDriver = new Proxy(d.registry, {
      get(target, p, rx) {
        const value: unknown = Reflect.get(target, p, rx);
        if (p !== 'get') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<IRegistryDriver['get']>) => {
          const row = await d.registry.get(...args);
          return row === null ? null : { ...row, summary: undefined };
        };
      },
    });
    expect(
      await judgeLoad(SEG, 100, { ...d, registry: bare }, { guard: { maxGrowth: 2 } }),
    ).toEqual({
      cardinalityBefore: 40,
      wouldRefuse: 'max-growth',
      reads: 2,
    });
    expect(await judgeLoad(SEG, 100, d)).toEqual({ cardinalityBefore: 40, reads: 1 });
  });

  it('refuses what a load refuses before its guard', async () => {
    const d = deps();
    await loadSegment(SEG, range(0, 4), d);
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    await expect(judgeLoad(SEG, 4, { ...d, keystore, requireEncryption: true })).rejects.toThrow(
      /already has generation 0 in cleartext/,
    );
    await expect(judgeLoad(SEG, 4, { ...d, requireEncryption: true })).rejects.toThrow(
      /needs a keystore to write encrypted/,
    );
    await expect(judgeLoad(SEG, -1, d)).rejects.toBeInstanceOf(ValidationError);
    await expect(judgeLoad(SEG, Number.NaN, d)).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports a size it could not read as null where no bound needs it, as the load would not read it', async () => {
    const d = deps();
    await loadSegment(SEG, range(0, 4), d);
    const bare: IRegistryDriver = new Proxy(d.registry, {
      get(target, p, rx) {
        const value: unknown = Reflect.get(target, p, rx);
        if (p !== 'get') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<IRegistryDriver['get']>) => {
          const row = await d.registry.get(...args);
          return row === null ? null : { ...row, summary: undefined };
        };
      },
    });
    const broken: IStorageDriver = new Proxy(d.storage, {
      get(target, p, rx) {
        const value: unknown = Reflect.get(target, p, rx);
        if (p !== 'getTail') return typeof value === 'function' ? value.bind(target) : value;
        return () => Promise.reject(new IntegrityError('a damaged footer'));
      },
    });
    const damaged = { ...d, registry: bare, storage: broken };
    expect(await judgeLoad(SEG, 4, damaged, { allowEmpty: true })).toEqual({
      cardinalityBefore: null,
      reads: 2,
    });
    await expect(judgeLoad(SEG, 4, damaged)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('reports null for any failure to read the object where no bound needs it, as the load publishes there', async () => {
    // A newer format the reader does not know, or an encrypted object it has no key for: the load never opens the
    // object when no bound needs its size, so it publishes, and the judgement must not fail where the load would not.
    for (const fault of [
      new UnsupportedError('a newer .crbm major version'),
      new CoreValidationError('.crbm is encrypted but no decryption key'),
      new TransientError('a throttled read'),
    ]) {
      const d = deps();
      await loadSegment(SEG, range(0, 4), d);
      const bare: IRegistryDriver = new Proxy(d.registry, {
        get(target, p, rx) {
          const value: unknown = Reflect.get(target, p, rx);
          if (p !== 'get') return typeof value === 'function' ? value.bind(target) : value;
          return async (...args: Parameters<IRegistryDriver['get']>) => {
            const row = await d.registry.get(...args);
            return row === null ? null : { ...row, summary: undefined };
          };
        },
      });
      const broken: IStorageDriver = new Proxy(d.storage, {
        get(target, p, rx) {
          const value: unknown = Reflect.get(target, p, rx);
          if (p !== 'getTail') return typeof value === 'function' ? value.bind(target) : value;
          return () => Promise.reject(fault);
        },
      });
      const damaged = { ...d, registry: bare, storage: broken };
      expect(await judgeLoad(SEG, 4, damaged, { allowEmpty: true }), fault.name).toEqual({
        cardinalityBefore: null,
        reads: 2,
      });
      expect((await loadSegment(SEG, range(0, 4), damaged, { allowEmpty: true })).published).toBe(
        true,
      );
      await expect(judgeLoad(SEG, 4, damaged)).rejects.toBe(fault);
    }
  });

  it('fails where the load fails on the segment key, whether or not a bound reads the object', async () => {
    const d = deps();
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    await loadSegment(SEG, range(0, 4), { ...d, keystore });
    const failing = {
      ...keystore,
      createDek: keystore.createDek.bind(keystore),
      openDek: () => Promise.reject(new TransientError('the key service is throttling')),
    } as unknown as InProcessKeystore;
    const down = { ...d, keystore: failing };
    await expect(judgeLoad(SEG, 4, down, { allowEmpty: true })).rejects.toBeInstanceOf(
      TransientError,
    );
    await expect(loadSegment(SEG, range(0, 4), down, { allowEmpty: true })).rejects.toBeInstanceOf(
      TransientError,
    );
    await expect(judgeLoad(SEG, 4, d, { allowEmpty: true })).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
  });
});
