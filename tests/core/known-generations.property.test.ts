import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { eraseIdFromSegment } from '@/core/erase-id';
import { LIST_COLLECTION_CADENCE } from '@/core/generation-gc';
import { MAX_KNOWN_GENERATIONS, usableKnownGens, windowOf } from '@/core/known-generations';
import { IntegrityError, LeaseLimitError, TransientError } from '@/core/errors';
import { footerCrcUnder } from '@/core/crbm-open';
import { LEASE_SKEW_MS, MAX_LEASE_MS, releaseLease, takeLease } from '@/core/leases';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore } from '../helpers/counting';
import { FULL_STRENGTH } from '../helpers/strength';

/**
 * The known-generations ledger against a model of what a publish writes and what a collection keeps, over every shipped
 * registry. Two loaders with different `keep` values share one segment, among rollbacks (onto a known generation, one
 * the ledger does not know, back and forward), holders taking and releasing leases while the clock moves, subject
 * erasures, retention writes, a purge and re-create, a load that crashed after writing its object, a load refused at its
 * number, a delete that fails, a publish that lands between another's compare-and-swap and its deletes, a row repaired
 * by hand, a registry restored to an earlier row, and a publish settled by reading the row.
 *
 * The model applies each step in turn to its own picture of the ledger (the numbers, in the order they were made
 * current) and of the bucket's rules, written from the rules rather than from the code. After every step:
 *
 *  1. the row's ledger equals the model's, entry order included, and a row the model says has none has no usable one;
 *  2. the ledger is within the writer's cap, names each generation once and ends with the pointer;
 *  3. the current generation is in the bucket, and a step that is not a load, an erasure or a purge deletes nothing;
 *
 * and after every load that published without a fault or a racing writer, the bucket is what the model keeps:
 *
 *  4. with `keep` at or above the new number, nothing is deleted;
 *  5. a load that collects by name deletes exactly the ledger entries the publish left out, but for a generation a live
 *     lease holds, and never a name at or above the new generation;
 *  6. a load that lists with a ledger to go on (a `keep` above 64, or the first publish over a row with none) keeps the
 *     ledger's span, then the newest others by number, `keep` in all, and the leased generations beside them;
 *  7. a load that lists with a window to protect (every sixteenth generation, or a number the listing chose) keeps
 *     exactly the generations the ledger names and the leased ones, so an orphan is gone by the next such pass.
 *
 * The window the model keeps is the `keep` most recently current generations numbered below the new one; a rollback of
 * n steps lands on the generation made current n steps before, and one a rollback left above the pointer stays in the
 * ledger until a load takes a number past it, unless the list would pass 128 entries.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const FAR = MIN_EXPIRES_AT_MS * 4;
const H = (n: number): string => n.toString(16).padStart(16, '0');

/** The model's constants, written out from the rules: 127 vouched below the new generation, fill to 128, cap 192. */
const SPAN = 127;
const FILL = 128;
const CAP = 192;
const NAME_LIMIT = 64;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-known-prop-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let dirs = 0;
const registries: ReadonlyArray<{
  name: string;
  make: (now: () => number) => IRegistryDriver;
  scale: number;
}> = [
  { name: 'MemoryRegistryDriver', make: (now) => new MemoryRegistryDriver({ now }), scale: 1 },
  {
    name: 'LocalFsRegistryDriver',
    make: (now) => new LocalFsRegistryDriver(join(root, `d${dirs++}`), { now }),
    scale: 0.1,
  },
  {
    name: 'ObjectStoreRegistry',
    make: (now) => new ObjectStoreRegistry(new CountingObjectStore(0), undefined, now),
    scale: 0.1,
  },
];

type Target = 'any' | 'known' | 'superseded' | 'oldest' | 'steps' | 'forward';
type Step =
  | { kind: 'load'; who: 0 | 1; extra: number }
  | { kind: 'refused'; who: 0 | 1 }
  | { kind: 'crash'; above: number }
  | { kind: 'stray'; pick: number }
  | { kind: 'rollback'; pick: number; target: Target }
  | { kind: 'erase'; id: number }
  | { kind: 'retention' }
  | { kind: 'purge'; objects: boolean }
  | { kind: 'failed-delete'; who: 0 | 1; extra: number }
  | { kind: 'race'; who: 0 | 1; extra: number }
  | { kind: 'drop-ledger' }
  | { kind: 'hand-move'; pick: number }
  | { kind: 'snapshot' }
  | { kind: 'restore' }
  | { kind: 'settled'; who: 0 | 1; extra: number }
  | { kind: 'pin'; dur: number }
  | { kind: 'pinAt'; pick: number; dur: number }
  | { kind: 'release'; pick: number }
  | { kind: 'advance'; ms: number };

const who = fc.constantFrom<0 | 1>(0, 1);
const LOAD: fc.Arbitrary<Step> = fc.record({
  kind: fc.constant('load' as const),
  who,
  extra: fc.nat(3),
});
const ROLLBACK: fc.Arbitrary<Step> = fc.record({
  kind: fc.constant('rollback' as const),
  pick: fc.nat(20),
  target: fc.constantFrom<Target>('any', 'known', 'superseded', 'oldest', 'steps', 'forward'),
});
const DURATIONS = fc.constantFrom(5_000, 90_000, 3_600_000, 3 * 86_400_000, MAX_LEASE_MS);
const LEASES: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('pin' as const), dur: DURATIONS }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('pinAt' as const), pick: fc.nat(30), dur: DURATIONS }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('release' as const), pick: fc.nat(30) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.constantFrom(1, 59_000, 61_000, 3_600_000, 4 * 86_400_000, 15 * 86_400_000),
    }),
  },
);
/** Rows with no usable ledger and how they come about: a hand repair, a restore, a write that landed with no answer. */
const REPAIRS: fc.Arbitrary<Step> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: 'drop-ledger' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('hand-move' as const), pick: fc.nat(20) }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'snapshot' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'restore' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('settled' as const), who, extra: fc.nat(3) }),
  },
);
const STEP: fc.Arbitrary<Step> = fc.oneof(
  { weight: 10, arbitrary: LOAD },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('refused' as const), who }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      above: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(20) }) },
  { weight: 3, arbitrary: ROLLBACK },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('erase' as const), id: fc.nat(6) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'retention' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('purge' as const), objects: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('failed-delete' as const), who, extra: fc.nat(3) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('race' as const), who, extra: fc.nat(3) }),
  },
  { weight: 5, arbitrary: REPAIRS },
  { weight: 6, arbitrary: LEASES },
);
/** Loads and the steps that only climb, over keeps that move a ledger through and past its widths. */
const CLIMB: fc.Arbitrary<Step> = fc.oneof(
  { weight: 24, arbitrary: LOAD },
  { weight: 3, arbitrary: ROLLBACK },
  { weight: 3, arbitrary: LEASES },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('race' as const), who, extra: fc.nat(3) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      above: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(60) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'drop-ledger' as const }) },
);

/** Keeps for the two loaders: small, wide, the cap, one above it, and 0. */
const KEEPS = fc.constantFrom(0, 1, 2, 3, 5, 12, 64, 65);
/** Keeps that carry a ledger past 64 below the pointer and then collect with a small one. */
const WIDE_KEEPS = fc.constantFrom(1, 2, 5, 64, 65, 100, 127, Number.MAX_SAFE_INTEGER);

// The model, from the rules.

/** `entries` held to the cap: the protected ones, then leased ones most recently current first, then the rest, same order. */
function modelCap(
  entries: readonly number[],
  protect: ReadonlySet<number>,
  leased: ReadonlySet<number>,
): number[] {
  const keep = new Set(entries.filter((e) => protect.has(e)));
  const recent = [...entries].reverse();
  for (const e of recent) if (keep.size < CAP && leased.has(e)) keep.add(e);
  for (const e of recent) if (keep.size < FILL) keep.add(e);
  return entries.filter((e) => keep.has(e));
}

/**
 * What a load that counts keeps below its new pointer when the row names nothing: the superseded generation first, when
 * it is there, then the newest of the rest by number, `keep` in all; ascending. The bucket's rule, written a second time.
 */
function countedWindow(
  below: readonly number[],
  superseded: number | undefined,
  keep: number,
): number[] {
  if (keep === 0) return [];
  const first = superseded !== undefined && below.includes(superseded) ? [superseded] : [];
  const rest = [...below]
    .filter((g) => !first.includes(g))
    .sort((a, b) => b - a)
    .slice(0, keep - first.length);
  return [...first, ...rest].sort((a, b) => a - b);
}

/**
 * What a pass that keeps by count and has a ledger keeps below `g`: the ledger's `min(keep, 127)` most recently current
 * names below `g`, the ones present, then the newest of the other present generations by number, `keep` in all.
 */
function ledgerCounted(
  below: readonly number[],
  ledger: readonly number[],
  g: number,
  keep: number,
): Set<number> {
  const span = Math.min(keep, SPAN);
  const named = ledger.filter((e) => e < g);
  const held = new Set((span === 0 ? [] : named.slice(-span)).filter((e) => below.includes(e)));
  for (const e of [...below].sort((a, b) => b - a)) {
    if (held.size >= keep) break;
    held.add(e);
  }
  return held;
}

interface ModelState {
  /** The ledger's numbers in the order they were made current, or `undefined` for a row with no usable ledger. */
  ledger: number[] | undefined;
  /** The pointer, or `undefined` for no row or a row with none. */
  pointer: number | undefined;
  leases: Map<string, { generation: number; until: number }>;
}

interface Published {
  /** The ledger is wider than 64 below the pointer, counting no leased name, so a small keep collects by listing. */
  readonly wide: boolean;
  readonly ledger: number[];
  readonly evict: number[];
  readonly seeded: boolean;
}

/** What a publish of `g` at `keep` writes over the model's `state`, with the generations a live lease holds. */
function modelPublish(
  state: ModelState,
  g: number,
  keep: number,
  leased: ReadonlySet<number>,
  presentBefore: readonly number[],
): Published {
  const { ledger, pointer } = state;
  // Only a birth seeds: a row with a pointer and no ledger at all. A usable ledger is never seeded again, however wide.
  const seeded = pointer !== undefined && ledger === undefined;
  if (seeded) {
    const below = presentBefore.filter((e) => e < g);
    const window = countedWindow(below, pointer, Math.min(keep, SPAN));
    // A leased generation is named wherever it is numbered, above the new generation too.
    const leasedOnly = presentBefore
      .filter((e) => e !== g && leased.has(e) && !window.includes(e))
      .sort((a, b) => a - b)
      .slice(-NAME_LIMIT);
    const order = [
      ...leasedOnly,
      ...window.filter((e) => e !== pointer),
      ...window.filter((e) => e === pointer),
    ];
    return {
      ledger: modelCap([...order, g], new Set([...order, g]), leased),
      evict: [],
      seeded: true,
      wide: false,
    };
  }
  const all = ledger ?? [];
  const below = all.filter((e) => e < g);
  const above = all.filter((e) => e > g);
  const span = Math.min(keep, SPAN);
  const vouch = span === 0 ? [] : below.slice(-span);
  const held = below.filter((e) => !vouch.includes(e) && leased.has(e));
  const chosen = all.filter((e) => vouch.includes(e) || held.includes(e) || above.includes(e));
  const known = modelCap([...chosen, g], new Set([...vouch, g]), leased);
  return {
    ledger: known,
    evict: below.filter((e) => !known.includes(e)).sort((a, b) => a - b),
    seeded: false,
    wide:
      pointer !== undefined &&
      all.filter((e) => e < pointer && !leased.has(e)).length > NAME_LIMIT &&
      keep <= NAME_LIMIT,
  };
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

const numbersOf = (row: RegistryRecord | null): number[] | undefined =>
  row?.knownGens?.map((e) => e.generation);

/** `registry`, with `after` awaited once, the first time a compare-and-swap resolves: an interleaving at a chosen step. */
function afterFirstSwap(registry: IRegistryDriver, after: () => Promise<void>): IRegistryDriver {
  let fired = false;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'compareAndSwap') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const out = await fn.apply(t, a);
        if (!fired) {
          fired = true;
          await after();
        }
        return out;
      };
    },
  }) as IRegistryDriver;
}

/** `storage`, whose first delete fails. */
function failingFirstDelete(storage: IStorageDriver): IStorageDriver {
  let failed = false;
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'delete') return (...a: unknown[]) => fn.apply(t, a);
      return (...a: unknown[]) => {
        if (!failed) {
          failed = true;
          return Promise.reject(new Error('the delete failed'));
        }
        return fn.apply(t, a);
      };
    },
  }) as IStorageDriver;
}

interface Floors {
  readonly published: number;
  /** Publishes whose ledger was checked against the model, by what they did. */
  readonly seeded?: number;
  readonly byName?: number;
  readonly listed?: number;
  readonly protecting?: number;
  /** Publishes whose ledger held a leased generation beside its window, and one a rollback left above the new one. */
  readonly leasedHeld?: number;
  readonly aboveCarried?: number;
  /** Publishes over a ledger naming more than 64 below the pointer that no lease holds, at a keep of 64 or less. */
  readonly rewound?: number;
  readonly rollbacks?: number;
  readonly unknownRollbacks?: number;
  readonly forwardRollbacks?: number;
  /** The most live leases a history held at once. The 64-lease boundary has dedicated tests; this one runs below it. */
  readonly maxLeases?: number;
}
const floors = (f: Floors): Floors => f;

describe.each(registries)('the known-generations ledger against its model, over $name', (reg) => {
  describe.each([
    {
      name: 'two loaders among every other writer',
      keepsArb: KEEPS,
      stepArb: STEP,
      lengths: { minLength: 20, maxLength: 120 },
      runs: 200,
      floor: floors({
        published: 2500,
        seeded: 100,
        byName: 400,
        listed: 120,
        protecting: 15,
        leasedHeld: 200,
        aboveCarried: 20,
        rollbacks: 150,
        unknownRollbacks: 6,
        forwardRollbacks: 6,
        maxLeases: 3,
      }),
    },
    {
      // Long enough to pass generation 16 and 32 many times and to carry a ledger past 64 below the pointer.
      name: 'long runs, with keeps that carry a ledger past 64 below the pointer and then collect with a small one',
      keepsArb: WIDE_KEEPS,
      stepArb: CLIMB,
      lengths: { minLength: 90, maxLength: 150 },
      runs: 40,
      floor: floors({
        published: 2500,
        seeded: 60,
        byName: 500,
        listed: 150,
        protecting: 30,
        leasedHeld: 400,
        aboveCarried: 100,
        rewound: 3,
        rollbacks: 150,
        unknownRollbacks: 4,
        forwardRollbacks: 8,
        maxLeases: 4,
      }),
    },
  ])('$name (property)', ({ keepsArb, stepArb, lengths, runs, floor }) => {
    it('keeps the ledger the model says, and the bucket it names', async () => {
      const counts = {
        published: 0,
        seeded: 0,
        byName: 0,
        listed: 0,
        protecting: 0,
        leasedHeld: 0,
        aboveCarried: 0,
        rewound: 0,
        rollbacks: 0,
        unknownRollbacks: 0,
        forwardRollbacks: 0,
        maxLeases: 0,
      };
      await fc.assert(
        fc.asyncProperty(
          keepsArb,
          keepsArb,
          fc.array(stepArb, lengths),
          async (keepA, keepB, steps) => {
            let t = T0;
            const clock = { now: () => t, sleep: () => Promise.resolve() };
            const storage = new MemoryStorageDriver();
            const registry = reg.make(() => t);
            const keeps = [keepA, keepB] as const;
            const deps = { storage, registry, codec: roaringCodec, clock };
            const model: ModelState = { ledger: undefined, pointer: undefined, leases: new Map() };
            let snapshot: { row: RegistryRecord | null; model: ModelState } | null = null;
            let holders = 0;
            const idsFor = async (extra: number): Promise<number[]> => {
              const have = (await registry.get(SEG))?.currentGen ?? -1;
              return Array.from({ length: Math.max(have, 0) + 2 + extra }, (_, i) => i);
            };
            /** The generations a live lease holds, by the model's own reading of when one ends. */
            const noteLeases = (): void => {
              const live = [...model.leases.values()].filter((e) => t < e.until + LEASE_SKEW_MS);
              counts.maxLeases = Math.max(counts.maxLeases, live.length);
            };
            const leasedNow = (): Set<number> =>
              new Set(
                [...model.leases.values()]
                  .filter((e) => t < e.until + LEASE_SKEW_MS)
                  .map((e) => e.generation),
              );

            /**
             * Apply a publish of `g` to the model, and hold the row to it. `exact` is for a publish with nothing else
             * writing and no fault, whose collection the bucket is then held to as well.
             */
            const applyPublish = async (
              g: number,
              keep: number,
              presentBefore: readonly number[],
              exact: boolean,
              collected: readonly number[] | undefined,
            ): Promise<void> => {
              const leased = leasedNow();
              const previous = model.pointer;
              const expected = modelPublish(model, g, keep, leased, presentBefore);
              const row = (await registry.get(SEG))!;
              expect(numbersOf(row), `the ledger after publishing ${g} at keep ${keep}`).toEqual(
                expected.ledger,
              );
              counts.published += 1;
              if (expected.seeded) counts.seeded += 1;
              if (expected.ledger.some((e) => e > g)) counts.aboveCarried += 1;
              const vouched = expected.ledger.filter((e) => e < g);
              if (
                !expected.seeded &&
                vouched.some((e) => leased.has(e)) &&
                (model.ledger ?? []).filter((e) => e < g).length > Math.min(keep, SPAN)
              ) {
                counts.leasedHeld += 1;
              }
              if (
                model.ledger !== undefined &&
                model.pointer !== undefined &&
                keep <= NAME_LIMIT &&
                keep < g &&
                model.ledger.filter((e) => e < model.pointer! && !leased.has(e)).length > NAME_LIMIT
              ) {
                counts.rewound += 1;
              }
              if (collected !== undefined) {
                for (const c of collected)
                  expect(c, 'a deleted name at or above g').toBeLessThan(g);
              }
              if (exact) {
                const present = await generations(storage);
                const below = presentBefore.filter((e) => e < g);
                const after = present.filter((e) => e < g);
                const protectedByLease = (e: number): boolean => leased.has(e);
                const previousThere = previous !== undefined && presentBefore.includes(previous);
                const checked = g === (previous ?? -1) + 1;
                const periodic = g % LIST_COLLECTION_CADENCE === 0;
                // The part of the bucket numbered at or above g is no collection's.
                expect(
                  present.filter((e) => e > g),
                  'generations above g',
                ).toEqual(presentBefore.filter((e) => e > g));
                if (keep >= g) {
                  expect(after, `keep ${keep} at or above ${g} deletes nothing`).toEqual(below);
                } else if (!previousThere && previous !== undefined) {
                  // The object the pointer named is gone: the pass lists and keeps what is there. Held to the weaker rule.
                  for (const e of expected.ledger.filter((x) => x < g && below.includes(x))) {
                    expect(after).toContain(e);
                  }
                } else if (
                  expected.seeded ||
                  expected.wide ||
                  keep > NAME_LIMIT ||
                  previous === undefined
                ) {
                  // (An incarnation's first publish counts too: its guard read no current object, so the pass lists.)
                  const keepSet = ledgerCounted(below, expected.ledger, g, keep);
                  const want = below.filter((e) => keepSet.has(e) || protectedByLease(e));
                  expect(after, `listing with a ledger, keep ${keep}, generation ${g}`).toEqual(
                    want,
                  );
                  counts.listed += 1;
                } else if (checked && !periodic) {
                  const gone = expected.evict.filter((e) => !protectedByLease(e));
                  expect(
                    after,
                    `by name, keep ${keep}, generation ${g}, evicting ${expected.evict.join(',')}`,
                  ).toEqual(below.filter((e) => !gone.includes(e)));
                  counts.byName += 1;
                } else {
                  const want = below.filter(
                    (e) => expected.ledger.includes(e) || protectedByLease(e),
                  );
                  expect(after, `protecting list, keep ${keep}, generation ${g}`).toEqual(want);
                  if (periodic) counts.protecting += 1;
                  counts.listed += 1;
                }
              }
              model.ledger = expected.ledger;
              model.pointer = g;
            };

            /** One load, whose publish and collection the model holds the row and the bucket to. */
            const load = async (
              who: 0 | 1,
              extra: number,
              options: {
                storage?: IStorageDriver;
                registry?: IRegistryDriver;
                settled?: boolean;
                race?: 0 | 1;
                nested?: boolean;
                ids?: number[];
              } = {},
            ): Promise<void> => {
              const keep = keeps[who]!;
              const presentBefore = await generations(storage);
              const ids = options.ids ?? (await idsFor(extra));
              const pointerBefore = model.pointer;
              let modelled = false;
              let loadRegistry = options.registry;
              if (options.race !== undefined) {
                const other = options.race;
                loadRegistry = afterFirstSwap(registry, async () => {
                  // The load's publish just landed: hold it to the model, then let the other load run its own.
                  const row = (await registry.get(SEG))!;
                  if (row.currentGen !== null && row.currentGen !== pointerBefore) {
                    modelled = true;
                    await applyPublish(row.currentGen, keep, presentBefore, false, undefined);
                  }
                  await load(other, 0, { nested: true }).catch((err: unknown) => {
                    if (err instanceof TransientError) return;
                    throw err;
                  });
                });
              }
              let result;
              try {
                result = await loadSegment(
                  SEG,
                  ids,
                  {
                    ...deps,
                    ...(options.storage === undefined ? {} : { storage: options.storage }),
                    ...(loadRegistry === undefined ? {} : { registry: loadRegistry }),
                  },
                  { keep },
                );
              } catch (err) {
                // Only a load handed a failing delete may throw, after its publish has landed.
                if (options.storage === undefined) throw err;
                const row = (await registry.get(SEG))!;
                if (
                  !modelled &&
                  row.currentGen !== null &&
                  row.currentGen !== pointerBefore &&
                  (pointerBefore === undefined || row.currentGen > pointerBefore)
                ) {
                  await applyPublish(row.currentGen, keep, presentBefore, false, undefined);
                }
                return;
              }
              if (!result.published || modelled) return;
              const exact =
                options.storage === undefined &&
                options.race === undefined &&
                options.nested !== true;
              await applyPublish(result.generation, keep, presentBefore, exact, result.collected);
            };

            const check = async (): Promise<void> => {
              const row = await registry.get(SEG);
              const present = await generations(storage);
              if (row === null || row.currentGen === null) return;
              // 3
              expect(present, 'the current generation').toContain(row.currentGen);
              // 1
              if (model.ledger !== undefined) {
                expect(numbersOf(row), 'the ledger').toEqual(model.ledger);
                expect(windowOf(row)).toEqual(model.ledger.filter((e) => e < row.currentGen!));
              } else {
                expect(usableKnownGens(row), 'a ledger where the model has none').toBeUndefined();
              }
              expect(row.currentGen).toBe(model.pointer);
              // 2
              if (row.knownGens !== undefined) {
                expect(row.knownGens.length).toBeLessThanOrEqual(MAX_KNOWN_GENERATIONS);
                expect(new Set(row.knownGens.map((e) => e.generation)).size).toBe(
                  row.knownGens.length,
                );
                expect(row.knownGens.at(-1)!.generation).toBe(row.currentGen);
              }
            };

            for (const [index, step] of steps.entries()) {
              try {
                const row = await registry.get(SEG);
                const current = row?.currentGen ?? -1;
                const present = await generations(storage);
                const deletesNothing = [
                  'retention',
                  'crash',
                  'stray',
                  'rollback',
                  'drop-ledger',
                  'hand-move',
                  'snapshot',
                  'pin',
                  'pinAt',
                  'release',
                  'advance',
                ].includes(step.kind);
                switch (step.kind) {
                  case 'load':
                    await load(step.who, step.extra);
                    break;
                  case 'refused':
                    // Refused over a row with something to lose, and a first generation over none.
                    await load(step.who, 0, { ids: [] });
                    break;
                  case 'crash':
                    await bulkLoadCrbmGeneration(
                      storage,
                      { ...SEG, generation: Math.max(current, ...present, -1) + step.above },
                      [7],
                    );
                    break;
                  case 'stray': {
                    const free = Array.from({ length: Math.max(current, 0) }, (_, g) => g).filter(
                      (g) => !present.includes(g),
                    );
                    const at = free[step.pick % Math.max(free.length, 1)];
                    if (at !== undefined)
                      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: at }, [7]);
                    break;
                  }
                  case 'rollback': {
                    if (row === null || row.currentGen === null) break;
                    const ledger = model.ledger;
                    const below = present.filter((g) => g < current);
                    const above = present.filter((g) => g > current);
                    let target: number | undefined;
                    switch (step.target) {
                      case 'any':
                        target = below[step.pick % Math.max(below.length, 1)];
                        break;
                      case 'known': {
                        const named = (ledger ?? []).filter((g) => below.includes(g));
                        target = named[step.pick % Math.max(named.length, 1)];
                        break;
                      }
                      case 'superseded': {
                        const s = ledger?.at(-2);
                        target = s !== undefined && below.includes(s) ? s : undefined;
                        break;
                      }
                      case 'oldest':
                        target = below[0];
                        break;
                      case 'steps': {
                        // Back n steps in the order generations were made current.
                        const n = (step.pick % 5) + 1;
                        const s = ledger?.at(-1 - n);
                        target = s !== undefined && present.includes(s) ? s : undefined;
                        break;
                      }
                      case 'forward': {
                        const named = (ledger ?? []).filter((g) => above.includes(g));
                        const pool = named.length > 0 ? named : above;
                        target = pool[step.pick % Math.max(pool.length, 1)];
                        break;
                      }
                    }
                    if (target === undefined || target === current) break;
                    const forward = target > current;
                    // A generation the ledger names needs no flag; one it does not needs the override, except below the
                    // pointer on a row with no ledger, where the rule is the one from before the row kept a record.
                    // A number the ledger names whose object is another one (a stray written into a freed number the
                    // ledger still names) is refused by its checksum, and needs the override too.
                    const recorded = usableKnownGens(row)?.find((e) => e.generation === target);
                    const swapped =
                      recorded !== undefined &&
                      recorded.footerCrc !==
                        (await footerCrcUnder(storage, { ...SEG, generation: target }));
                    if (swapped) {
                      await expect(
                        rollbackSegment(SEG, target, { storage, registry }),
                      ).rejects.toBeInstanceOf(IntegrityError);
                    }
                    const flag =
                      swapped || (ledger === undefined ? forward : !ledger.includes(target));
                    await rollbackSegment(
                      SEG,
                      target,
                      { storage, registry },
                      flag ? { allowUnknown: true } : {},
                    );
                    counts.rollbacks += 1;
                    if (ledger !== undefined) {
                      const moved = [...ledger.filter((e) => e !== target), target];
                      const known = ledger.includes(target);
                      if (!known) counts.unknownRollbacks += 1;
                      model.ledger =
                        known && moved.length <= CAP
                          ? moved
                          : modelCap(moved, new Set([target, current]), new Set());
                    }
                    if (forward) counts.forwardRollbacks += 1;
                    model.pointer = target;
                    break;
                  }
                  case 'erase':
                    if (row !== null && current >= 0) {
                      const erased = await eraseIdFromSegment(SEG, step.id, deps);
                      if (
                        erased.erased &&
                        'generation' in erased &&
                        erased.generation !== undefined
                      ) {
                        const after = (await registry.get(SEG))!;
                        expect(after.currentGen).toBe(erased.generation);
                        // The rewrite leaves the ledger with the rewritten generation alone, and the row no lease.
                        expect(numbersOf(after)).toEqual([erased.generation]);
                        expect(
                          (await generations(storage)).filter((g) => g < erased.generation!),
                        ).toEqual([]);
                        model.ledger = [erased.generation];
                        model.pointer = erased.generation;
                        model.leases.clear();
                      }
                    }
                    break;
                  case 'drop-ledger':
                    if (row !== null) {
                      await registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
                      model.ledger = undefined;
                    }
                    break;
                  case 'hand-move': {
                    // The pointer moved to a lower generation in the bucket by hand: the row loses its summary and ledger.
                    const lower = present.filter((g) => g < current);
                    const at = lower[step.pick % Math.max(lower.length, 1)];
                    if (row !== null && at !== undefined) {
                      await registry.compareAndSwap(SEG, row.token, { currentGen: at });
                      model.ledger = undefined;
                      model.pointer = at;
                    }
                    break;
                  }
                  case 'snapshot':
                    snapshot = {
                      row,
                      model: {
                        ledger: model.ledger === undefined ? undefined : [...model.ledger],
                        pointer: model.pointer,
                        leases: new Map(),
                      },
                    };
                    break;
                  case 'restore':
                    // A registry restored to an earlier row, whose object is still in the bucket. The row it replaces goes.
                    if (
                      snapshot !== null &&
                      snapshot.row !== null &&
                      snapshot.row.currentGen !== null &&
                      present.includes(snapshot.row.currentGen)
                    ) {
                      if (row !== null) await registry.delete(SEG);
                      await registry.create(SEG, {
                        currentGen: snapshot.row.currentGen,
                        ...(snapshot.row.knownGens === undefined
                          ? {}
                          : { knownGens: snapshot.row.knownGens }),
                      });
                      model.ledger =
                        snapshot.model.ledger === undefined
                          ? undefined
                          : [...snapshot.model.ledger];
                      model.pointer = snapshot.model.pointer;
                      model.leases.clear();
                    }
                    break;
                  case 'settled': {
                    // A publish whose write landed and then got no answer: settled by reading the row.
                    let armed = true;
                    const flaky = new Proxy(registry, {
                      get(tgt, p, rx) {
                        const value: unknown = Reflect.get(tgt, p, rx);
                        if (typeof value !== 'function') return value;
                        const fn = value as (...a: unknown[]) => unknown;
                        if (p !== 'compareAndSwap' && p !== 'create')
                          return (...a: unknown[]) => fn.apply(tgt, a);
                        return async (...a: unknown[]) => {
                          const out = await fn.apply(tgt, a);
                          if (armed) {
                            armed = false;
                            throw new TransientError('no answer');
                          }
                          return out;
                        };
                      },
                    }) as IRegistryDriver;
                    await load(step.who, step.extra, { registry: flaky, settled: true });
                    break;
                  }
                  case 'retention':
                    await setSegmentRetention(SEG, { registry }, { expiresAt: FAR });
                    break;
                  case 'purge':
                    if (step.objects)
                      for (const g of present) await storage.delete({ ...SEG, generation: g });
                    if (row !== null) await registry.delete(SEG);
                    model.ledger = undefined;
                    model.pointer = undefined;
                    model.leases.clear();
                    break;
                  case 'failed-delete':
                    await load(step.who, step.extra, { storage: failingFirstDelete(storage) });
                    break;
                  case 'race':
                    await load(step.who, step.extra, { race: (1 - step.who) as 0 | 1 });
                    break;
                  case 'pin': {
                    if (row === null || row.status !== 'active' || row.currentGen === null) break;
                    const holder = H(++holders);
                    const taken = await takeLease(
                      SEG,
                      { registry, clock },
                      {
                        holder,
                        generation: row.currentGen,
                        until: t + step.dur,
                        row,
                        current: true,
                      },
                    ).catch((err: unknown) => {
                      if (err instanceof LeaseLimitError) return 'full' as const;
                      throw err;
                    });
                    if (taken !== 'moved' && taken !== 'full') {
                      model.leases.set(holder, { generation: row.currentGen, until: t + step.dur });
                      noteLeases();
                    }
                    break;
                  }
                  case 'pinAt': {
                    const past = present.filter((g) => g < current);
                    const g = past[step.pick % Math.max(past.length, 1)];
                    if (row === null || row.status !== 'active' || g === undefined) break;
                    const holder = H(++holders);
                    const taken = await takeLease(
                      SEG,
                      { registry, clock },
                      { holder, generation: g, until: t + step.dur, row, current: false },
                    ).catch((err: unknown) => {
                      if (err instanceof LeaseLimitError) return 'full' as const;
                      throw err;
                    });
                    if (taken !== 'moved' && taken !== 'full') {
                      model.leases.set(holder, { generation: g, until: t + step.dur });
                      noteLeases();
                    }
                    break;
                  }
                  case 'release': {
                    const all = [...model.leases.entries()];
                    const e = all[step.pick % Math.max(all.length, 1)];
                    if (e === undefined || row === null) break;
                    await releaseLease(SEG, { registry, clock }, e[0]);
                    model.leases.delete(e[0]);
                    break;
                  }
                  case 'advance':
                    t += step.ms;
                    break;
                }
                await check();
                if (deletesNothing) {
                  const after = await generations(storage);
                  for (const g of present) expect(after, `${step.kind} deleted ${g}`).toContain(g);
                }
              } catch (err) {
                const row = await registry.get(SEG);
                if (err instanceof Error) {
                  err.message += `\n  at step ${index} of ${steps.length}: ${JSON.stringify(step)}\n  model: ${JSON.stringify(
                    { ledger: model.ledger, pointer: model.pointer },
                  )}\n  row: pointer ${String(row?.currentGen)}, ledger ${JSON.stringify(numbersOf(row))}\n  bucket: ${JSON.stringify(await generations(storage))}\n  keeps: ${JSON.stringify(keeps)}\n  steps: ${JSON.stringify(steps.slice(0, index + 1))}`;
                }
                throw err;
              }
            }
          },
        ),
        {
          numRuns:
            Math.max(3, Math.round(runs * reg.scale)) * Number(process.env.PROP_RUNS_FACTOR ?? 1),
          // Seeded so the coverage floors below are deterministic: the same histories on every pull-request run. Set
          // PROP_SEED to explore other ones. A full-strength run draws a random seed unless PROP_SEED is set, and does
          // not assert the floors (the model check still runs, and fast-check prints the seed of a failure).
          ...(FULL_STRENGTH && process.env.PROP_SEED === undefined
            ? {}
            : { seed: Number(process.env.PROP_SEED ?? 1) }),
        },
      );
      // Not vacuous: each kind of publish and rollback was checked against the model. The shipped registries other than
      // the in-memory one run a tenth of the histories, so they are held to publishing alone.
      const full = reg.scale === 1 && !(FULL_STRENGTH && process.env.PROP_SEED === undefined);
      const at = (n: number | undefined): number => (full ? (n ?? -1) : -1);
      if (FULL_STRENGTH && process.env.PROP_SEED === undefined) return;
      expect(counts.published).toBeGreaterThan(Math.floor(floor.published * reg.scale));
      expect(counts.seeded).toBeGreaterThan(at(floor.seeded));
      expect(counts.byName).toBeGreaterThan(at(floor.byName));
      expect(counts.listed).toBeGreaterThan(at(floor.listed));
      expect(counts.protecting).toBeGreaterThan(at(floor.protecting));
      expect(counts.leasedHeld).toBeGreaterThan(at(floor.leasedHeld));
      expect(counts.aboveCarried).toBeGreaterThan(at(floor.aboveCarried));
      expect(counts.rewound).toBeGreaterThan(at(floor.rewound));
      expect(counts.rollbacks).toBeGreaterThan(at(floor.rollbacks));
      expect(counts.unknownRollbacks).toBeGreaterThan(at(floor.unknownRollbacks));
      expect(counts.forwardRollbacks).toBeGreaterThan(at(floor.forwardRollbacks));
      expect(counts.maxLeases).toBeGreaterThan(at(floor.maxLeases));
      // Thousands of loads a case: seconds on an idle machine, so the default 5 s limit fails it under full-suite load.
    }, 300_000);
  });
});
