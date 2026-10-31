import { describe, expect, expectTypeOf, it } from 'vitest';
import { CloudRoaring, MemoryStorage, RecordingAuditSink, ValidationError } from '@/index';
import type {
  BudgetOption,
  CombineOptions,
  GenerationMetadata,
  IAuditSink,
  LoadGuard,
  MaterializeManyOptions,
  Segment,
} from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { counting } from '../helpers/counting';

/**
 * Every read and combine on a segment takes one options type, `CombineOptions`, and each verb takes only the fields
 * that apply to it. A field a verb does not take type-checks, so the call is what refuses it: with a `ValidationError`
 * that names it, before any request reaches storage or the registry. Each verb is tried with each field it does not
 * take, over a backend that counts every driver call, as an own key, inherited from a prototype, and behind a getter
 * (as a class declares one): the last two are not listed by `Object.keys`, and a read by name would otherwise drop
 * them without a word, an `exclude` on `andNot` among them.
 */

const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

type Key = keyof CombineOptions;

const RANGE: readonly Key[] = ['after', 'through'];
const READ: readonly Key[] = [...RANGE, 'concurrency', 'budget', 'allowAbsentOperands'];
const WRITE: readonly Key[] = ['audit', 'allowEmpty', 'guard', 'metadata', 'keep'];
const ALL: readonly Key[] = [...READ, 'exclude', ...WRITE];

/** What each verb takes of `CombineOptions`, written out here rather than read from the code it checks. */
const TAKES = {
  iterate: RANGE,
  everyNth: RANGE,
  intersect: [...READ, 'exclude'],
  union: [...READ, 'exclude'],
  andNot: READ,
  intersectInto: ALL,
  unionInto: ALL,
  andNotInto: [...READ, ...WRITE],
  intersectCount: [...READ, 'exclude'],
  unionCount: [...READ, 'exclude'],
  andNotCount: READ,
  // Its own `concurrency`, `budget`, `allowAbsentOperands` and `keep`, and the range; the write options go on an output.
  materializeMany: [...RANGE, 'concurrency', 'budget', 'allowAbsentOperands', 'keep'],
} as const satisfies Record<string, readonly Key[]>;
type Verb = keyof typeof TAKES;
const VERBS = Object.keys(TAKES) as Verb[];

/** A counted memory backend, a store over it, and the handles the calls use. */
async function world() {
  const memory = new MemoryStorage();
  const storage: Record<string, number> = {};
  const registry: Record<string, number> = {};
  const backend = brandAsBackend({
    storage: counting<IStorageDriver>(memory.storage, storage),
    registry: counting<IRegistryDriver>(memory.registry, registry),
  });
  const store = new CloudRoaring({ storage: backend });
  await store.load({ segment: 'a' }, [1, 2, 3, 5]);
  await store.load({ segment: 'b' }, [2, 3, 4, 5]);
  await store.load({ segment: 'c' }, [3]);
  await store.load({ segment: 'dest' }, [9]);
  const pinned = await store.segment('a').pin();
  // The counters saw the loads, so an empty count after a refusal means no request, not a counter that sees nothing.
  expect(Object.keys(storage).length).toBeGreaterThan(0);
  expect(Object.keys(registry).length).toBeGreaterThan(0);
  for (const c of [storage, registry]) for (const k of Object.keys(c)) delete c[k];
  return {
    store,
    a: store.segment('a'),
    b: store.segment('b'),
    c: store.segment('c'),
    dest: store.segment('dest'),
    pinned,
    calls: () => ({ storage: { ...storage }, registry: { ...registry } }),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** A value each field takes, so that a refusal is about where the field is, never about its value. */
const VALUES: { [K in Key]-?: (w: World) => CombineOptions[K] } = {
  after: () => 1,
  through: () => 5,
  concurrency: () => 4,
  budget: () => false,
  allowAbsentOperands: () => true,
  exclude: (w) => [w.c],
  audit: () => new RecordingAuditSink(),
  allowEmpty: () => true,
  guard: () => ({ minCardinality: 1 }),
  metadata: () => ({ source: 'combine-options' }),
  keep: () => 1,
};
const optionsOf = (w: World, keys: readonly Key[]): CombineOptions =>
  Object.fromEntries(keys.map((k) => [k, VALUES[k](w)])) as CombineOptions;

/** Each verb called with `options`, settled: a streaming read is drained, so a refusal there is thrown when it is read. */
const CALLS: Record<Verb, (w: World, options: CombineOptions) => Promise<unknown>> = {
  iterate: (w, o) => drain(w.a.iterate(o)),
  everyNth: (w, o) => drain(w.pinned.everyNth(2, o)),
  intersect: (w, o) => drain(w.a.intersect([w.b], o)),
  union: (w, o) => drain(w.a.union([w.b], o)),
  andNot: (w, o) => drain(w.a.andNot([w.b], o)),
  intersectInto: (w, o) => w.a.intersectInto(w.dest, [w.b], o),
  unionInto: (w, o) => w.a.unionInto(w.dest, [w.b], o),
  andNotInto: (w, o) => w.a.andNotInto(w.dest, [w.b], o),
  intersectCount: (w, o) => w.a.intersectCount([w.b], o),
  unionCount: (w, o) => w.a.unionCount([w.b], o),
  andNotCount: (w, o) => w.a.andNotCount([w.b], o),
  // Assigned onto the options rather than spread from them, so a field they inherit stays where it was.
  materializeMany: (w, o) =>
    w.store.materializeMany(
      Object.assign(o, {
        operands: { a: w.a, b: w.b },
        outputs: [{ dest: w.dest, expr: { and: ['a', 'b'] } }],
        keep: (o as Partial<MaterializeManyOptions>).keep ?? 1,
      }) as unknown as MaterializeManyOptions,
    ),
};

/** Where a field sits on the options object: an own key, a prototype's key, or a getter on the prototype. */
type Form = 'own' | 'inherited' | 'getter';
const FORMS: readonly Form[] = ['own', 'inherited', 'getter'];
function shaped(form: Form, key: string, value: unknown): object {
  if (form === 'own') return { [key]: value };
  if (form === 'inherited') return Object.create({ [key]: value }) as object;
  class Options {}
  Object.defineProperty(Options.prototype, key, { get: () => value, configurable: true });
  return new Options();
}

const NO_CALLS = { storage: {}, registry: {} };

async function refusal(verb: Verb, w: World, options: object): Promise<unknown> {
  return CALLS[verb](w, options as CombineOptions).then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe.each(VERBS)('%s refuses a field it does not take, before any request', (verb) => {
  const misplaced = ALL.filter((k) => !(TAKES[verb] as readonly Key[]).includes(k));

  const cases = misplaced.flatMap((key) => FORMS.map((form) => [key, form] as const));
  it.runIf(cases.length > 0).each(cases)('%s, %s', async (key, form) => {
    const w = await world();
    const err = await refusal(verb, w, shaped(form, key, VALUES[key](w)));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(`${verb}: unknown option "${key}"`);
    expect(w.calls()).toEqual(NO_CALLS);
  });

  it('a misspelt field', async () => {
    // Refused by every verb, the two that take every field of CombineOptions included.
    const w = await world();
    const err = await refusal(verb, w, { concurency: 4 });
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(`${verb}: unknown option "concurency"`);
    expect(w.calls()).toEqual(NO_CALLS);
  });

  it('control: every field it takes, at once, is accepted', async () => {
    const w = await world();
    await expect(CALLS[verb](w, optionsOf(w, TAKES[verb]))).resolves.toBeDefined();
  });
});

/** What a call came to, compared across two fresh stores: a batch's per-output results, else the call's own result. */
const resultOf = (verb: Verb, value: unknown): unknown =>
  verb === 'materializeMany' ? (value as { outputs: unknown }).outputs : value;

// `intersectInto` and `unionInto` take every field, so they have none to hold as undefined.
const WITH_MISPLACED = VERBS.filter((v) =>
  ALL.some((k) => !(TAKES[v] as readonly Key[]).includes(k)),
);

describe.each(WITH_MISPLACED)(
  '%s reads a field it does not take, held as undefined, as absent',
  (verb) => {
    // A spread of options sets a field to `undefined` to leave it out, so `{ ...opts, exclude: undefined }` must
    // still work on `andNot`: the field is absent whether the object holds it as its own, inherits it or returns it
    // from a getter. `materializeMany` refuses any own key it does not list, an undefined one included, so it is
    // tried with the other two forms only.
    const misplaced = ALL.filter((k) => !(TAKES[verb] as readonly Key[]).includes(k));
    const forms = verb === 'materializeMany' ? FORMS.filter((f) => f !== 'own') : FORMS;
    const cases = misplaced.flatMap((key) => forms.map((form) => [key, form] as const));
    it.each(cases)('%s, %s', async (key, form) => {
      const expected = resultOf(verb, await CALLS[verb](await world(), {}));
      const w = await world();
      const got = resultOf(
        verb,
        await CALLS[verb](w, shaped(form, key, undefined) as CombineOptions),
      );
      expect(got).toEqual(expected);
    });
  },
);

describe('materializeMany refuses an own key it does not list, whatever its value', () => {
  it('an own exclude set to undefined is refused, as an own unknown key always is', async () => {
    const w = await world();
    const err = await refusal('materializeMany', w, { exclude: undefined });
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('materializeMany: unknown option "exclude"');
    expect(w.calls()).toEqual(NO_CALLS);
  });
});

describe('the table above is the whole of CombineOptions', () => {
  it('names each field once, and every field', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    expect([...ALL].sort()).toEqual(Object.keys(VALUES).sort());
  });
});

/**
 * The four option types `CombineOptions` replaced, field for field as they were declared, so the compiler can hold
 * the merged type to them.
 */
interface WasIdRange {
  readonly after?: number | undefined;
  readonly through?: number | undefined;
}
interface WasBaseCombineOptions extends WasIdRange {
  readonly concurrency?: number;
  readonly budget?: BudgetOption;
  readonly allowAbsentOperands?: boolean;
}
interface WasCombineOptions extends WasBaseCombineOptions {
  readonly exclude?: Segment[];
}
interface WasMaterializeOptions extends WasCombineOptions {
  readonly audit?: IAuditSink;
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  readonly metadata?: GenerationMetadata;
  readonly keep?: number;
}
type WasAndNotIntoOptions = Omit<WasMaterializeOptions, 'exclude'>;

describe('no field was lost in the merge (checked by the compiler)', () => {
  it('a value of each replaced type is a CombineOptions, each field with its type, optional and readonly', () => {
    expectTypeOf<WasIdRange>().toExtend<CombineOptions>();
    expectTypeOf<WasBaseCombineOptions>().toExtend<CombineOptions>();
    expectTypeOf<WasCombineOptions>().toExtend<CombineOptions>();
    expectTypeOf<WasMaterializeOptions>().toExtend<CombineOptions>();
    expectTypeOf<WasAndNotIntoOptions>().toExtend<CombineOptions>();
    // The widest of them is the merged type exactly: the same fields, types, `?` and `readonly`.
    expectTypeOf<CombineOptions>().toEqualTypeOf<WasMaterializeOptions>();
    expectTypeOf<
      Pick<CombineOptions, keyof WasAndNotIntoOptions>
    >().toEqualTypeOf<WasAndNotIntoOptions>();
  });

  it('every combine takes the merged type, and the reads and materializeMany take its range', () => {
    type Opt<F extends (...args: never[]) => unknown, I extends number> = Parameters<F>[I];
    expectTypeOf<Opt<Segment['intersect'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['union'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['andNot'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['intersectCount'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['unionCount'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['andNotCount'], 1>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['intersectInto'], 2>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['unionInto'], 2>>().toEqualTypeOf<CombineOptions | undefined>();
    expectTypeOf<Opt<Segment['andNotInto'], 2>>().toEqualTypeOf<CombineOptions | undefined>();
    type Range = Pick<CombineOptions, 'after' | 'through'>;
    expectTypeOf<Opt<Segment['iterate'], 0>>().toEqualTypeOf<Range | undefined>();
    expectTypeOf<Opt<Segment['everyNth'], 1>>().toEqualTypeOf<Range | undefined>();
    expectTypeOf<Pick<MaterializeManyOptions, 'after' | 'through'>>().toEqualTypeOf<Range>();
  });
});
