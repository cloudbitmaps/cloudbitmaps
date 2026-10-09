import roaring from 'roaring';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { ValidationError } from '@/core/errors';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';
import { objectFingerprint } from '../helpers/fingerprint';

const { RoaringBitmap32 } = roaring;

/**
 * A load's `metadata` is checked before any request is made: over the cap, or breaking a type rule, it is a
 * `ValidationError` with nothing read and nothing written, on every way a generation is written: a load of ids, a load
 * of a bitmap, and each `*Into` verb. Counting proxies on both halves of the backend show the zero.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const CAP = 1_024;

/** One backend, with every call to either half counted. */
function counted() {
  const backend = new MemoryStorage();
  const storageCalls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(backend.storage, storageCalls);
  const registry = counting<IRegistryDriver>(backend.registry, registryCalls);
  const reset = (): void => {
    for (const c of [storageCalls, registryCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  const total = (): number =>
    [storageCalls, registryCalls].flatMap((c) => Object.values(c)).reduce((a, b) => a + b, 0);
  return {
    backend,
    deps: { storage, registry, codec: roaringCodec },
    store: new CloudRoaring({ storage: brandAsBackend({ storage, registry }), retry: false }),
    reset,
    total,
    calls: () => ({ storage: { ...storageCalls }, registry: { ...registryCalls } }),
  };
}

/** Metadata whose canonical JSON is exactly `bytes` long: `{"k":"xxx…"}` is 8 bytes plus the value. */
const sized = (bytes: number): Record<string, string> => ({ k: 'x'.repeat(bytes - 8) });

class Holder {
  readonly a = 1;
}

const NOT_A_RECORD: Array<[string, unknown]> = [
  ['null', null],
  ['an array', ['a']],
  ['a string', 'abc'],
  ['a number', 5],
  ['a boolean', true],
  ['a Map', new Map([['a', 1]])],
  ['a class instance', new Holder()],
  ['a boxed string', Object('x')],
  ['a Date', new Date(0)],
  ['a function', () => 1],
];

const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ['a boolean value', { a: true }],
  ['a null value', { a: null }],
  ['an undefined value', { a: undefined }],
  ['a nested object', { a: { b: 1 } }],
  ['an array value', { a: [1] }],
  ['NaN', { a: Number.NaN }],
  ['Infinity', { a: Number.POSITIVE_INFINITY }],
  ['-Infinity', { a: Number.NEGATIVE_INFINITY }],
  ['a bigint', { a: 1n }],
  ['a symbol value', { a: Symbol('x') }],
  ['a lone surrogate in a value', { a: '\ud800' }],
  ['a lone surrogate in a key', { '\udc00': 'x' }],
  ['an empty key', { '': 'x' }],
  ['a key over 128 bytes', { ['k'.repeat(129)]: 'x' }],
  ['a symbol key', { [Symbol('s')]: 'x' }],
  ['a non-enumerable property', Object.defineProperty({}, 'a', { value: 1, enumerable: false })],
  ['an accessor property', Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })],
  ['a __proto__ key', JSON.parse('{"__proto__": 1}') as Record<string, unknown>],
  [
    'a prototype that is not Object.prototype',
    Object.create({ inherited: 1 }) as Record<string, unknown>,
  ],
  ['one byte over the cap', sized(CAP + 1)],
];

/** Every way a generation is written, each handed its options, and the segment it writes. */
type OptionWriter = (w: ReturnType<typeof counted>, options: unknown) => Promise<unknown>;

const ids = [1, 2, 3];
const DEST: SegmentRef = { namespace: 'ns', segment: 'dest' };
const WITH_OPTIONS: Array<[string, OptionWriter, SegmentRef]> = [
  ['load of ids', (w, options) => w.store.load(SEG, ids, options as never), SEG],
  [
    'load of a serialized bitmap',
    (w, options) =>
      w.store.load(SEG, { serialized: new RoaringBitmap32(ids).serialize(true) }, options as never),
    SEG,
  ],
  [
    'load of a bitmap',
    (w, options) => w.store.load(SEG, { bitmap: new RoaringBitmap32(ids) }, options as never),
    SEG,
  ],
  ['core load of ids', (w, options) => loadSegment(SEG, ids, w.deps, options as never), SEG],
  ...(['intersectInto', 'unionInto', 'andNotInto'] as const).map(
    (verb): [string, OptionWriter, SegmentRef] => [
      verb,
      async (w, options) => {
        const a = w.store.segment('a', { namespace: 'ns' });
        const b = w.store.segment('b', { namespace: 'ns' });
        const dest = w.store.segment('dest', { namespace: 'ns' });
        // Two source segments, written before the counters are cleared by the caller.
        await w.store.load({ namespace: 'ns', segment: 'a' }, [1, 2, 3, 4]);
        await w.store.load({ namespace: 'ns', segment: 'b' }, [3, 4, 5]);
        w.reset();
        return verb === 'andNotInto'
          ? a.andNotInto(dest, [b], options as never)
          : a[verb](dest, [b], options as never);
      },
      DEST,
    ],
  ),
];

/** Every way a generation is written, each with a way to hand it metadata. */
type Writer = (w: ReturnType<typeof counted>, metadata: unknown) => Promise<unknown>;
const WRITERS: Array<[string, Writer]> = WITH_OPTIONS.map(([name, write]) => [
  name,
  (w, metadata) => write(w, { metadata }),
]);

describe.each(WRITERS)('metadata on a %s', (_name, write) => {
  it.each([...NOT_A_RECORD, ...BAD_VALUES])(
    'refuses %s with no request made',
    async (_what, bad) => {
      const w = counted();
      // A segment that already holds a generation, so a refusal has something it must not touch.
      await w.store.load(SEG, [9]);
      w.reset();
      const before = await w.backend.registry.get(SEG);
      w.reset();
      const run = write(w, bad);
      await expect(run).rejects.toBeInstanceOf(ValidationError);
      expect(w.calls(), 'no request at all, to either half of the backend').toEqual({
        storage: {},
        registry: {},
      });
      expect(await w.backend.registry.get(SEG)).toEqual(before);
    },
  );

  it('refuses a record over the cap before reading a row, and accepts one exactly at it', async () => {
    const w = counted();
    w.reset(); // the store checked its registry's capabilities when it was built
    await expect(write(w, sized(CAP + 1))).rejects.toThrow(/over the 1024B cap/);
    expect(w.total()).toBe(0);
    await write(w, sized(CAP));
    expect(w.total()).toBeGreaterThan(0);
  });

  it('accepts none, the empty record and a record of every legal shape', async () => {
    for (const ok of [
      undefined,
      {},
      { a: 'x' },
      { n: 1.5, big: 2 ** 53, neg: -7, zero: -0, text: '日本語 \u{1F600}' },
      Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }),
      { ['k'.repeat(128)]: 'x' },
    ]) {
      const w = counted();
      await expect(write(w, ok)).resolves.toBeDefined();
    }
  });
});

describe('metadata that changes while a load runs', () => {
  it('is stored as it was when the load was called', async () => {
    const w = counted();
    const metadata: Record<string, string | number> = { run: 'one' };
    // The ids are read while the object is written, which is long after the call.
    async function* source(): AsyncGenerator<number> {
      yield 1;
      metadata.run = 'two';
      metadata.extra = 'late';
      delete metadata.run;
      yield 2;
    }
    const result = await loadSegment(SEG, source(), w.deps, { metadata });
    expect(result.published).toBe(true);
    const row = (await w.backend.registry.get(SEG))!;
    expect(row.summary).toEqual({
      generation: 0,
      cardinality: 2,
      fingerprint: await objectFingerprint(w.backend.storage, { ...SEG, generation: 0 }),
      metadata: { run: 'one' },
    });
  });
});

describe.each(WITH_OPTIONS)('the metadata option of a %s', (_name, write, written) => {
  it('is read once: what is checked is what is stored, whatever the property answers the second time', async () => {
    const w = counted();
    let reads = 0;
    // The first answer is legal. A second read would find a record past the cap.
    const options = Object.defineProperty({}, 'metadata', {
      enumerable: true,
      get: () => (++reads === 1 ? { run: 'first' } : { run: 'x'.repeat(2_000) }),
    });
    await write(w, options);
    expect(reads).toBe(1);
    const row = (await w.backend.registry.get(written))!;
    expect(row.summary).toMatchObject({ metadata: { run: 'first' } });
  });
});
