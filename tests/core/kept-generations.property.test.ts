import fc from 'fast-check';
import { eraseIdFromSegment } from '@/core/erase-id';
import { MAX_KEPT_GENERATIONS, usableKnownGens, windowOf } from '@/core/known-generations';
const win = (r: unknown): number[] | undefined => {
  const w = windowOf(r as never);
  return w === undefined ? undefined : [...w].sort((a, b) => a - b);
};
import { loadSegment } from '@/core/load';
import { TransientError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { LIST_COLLECTION_CADENCE } from '@/core/generation-gc';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Two loaders with different `keep` values share one segment, among rollbacks, subject erasures, retention writes, a
 * purge and re-create, a load that crashed after writing its object, a load refused at its number, a delete that
 * fails, and a publish that lands between another's compare-and-swap and its deletes. After every step the bucket is
 * held to what the row says:
 *
 *  1. the current generation is in the bucket;
 *  2. a load never deletes one of the newest `keep` generations the row names that were in the bucket before it, and
 *     a step that is not a load, an erasure or a purge deletes nothing. (A row can name a generation a load with a
 *     smaller `keep` took: each load collects with its own `keep`, so a name is a request to keep, not a promise
 *     that the object is there.)
 *  3. a row's list is ascending, below the pointer, and within the writer's cap;
 *  4. after a load whose generation is a multiple of the cadence and which met no fault, nothing is below the
 *     pointer that the row does not name (an orphan is gone by the next periodic pass);
 *  5. a load that published and found a usable list wrote the newest `keep` of that list and the generation it
 *     superseded;
 *  6. a load that published over a row with no usable list (the first after a rollback, one with a `keep` above the
 *     cap, the first over a row a writer that records none left) keeps below its pointer exactly the generation its
 *     publish superseded, when that was in the bucket, and the newest `keep - 1` of the rest by number, and records
 *     them when `keep` fits the list.
 *
 * Rollbacks pick their target four ways: any generation below the pointer, one the row's list names, the one the
 * current generation superseded, and the oldest.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const FAR = MIN_EXPIRES_AT_MS * 2;

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
  | { kind: 'settled'; who: 0 | 1; extra: number };

const who = fc.constantFrom<0 | 1>(0, 1);
type Target = 'any' | 'kept' | 'superseded' | 'oldest';
const ROLLBACK: fc.Arbitrary<Step> = fc.record({
  kind: fc.constant('rollback' as const),
  pick: fc.nat(20),
  target: fc.constantFrom<Target>('any', 'kept', 'superseded', 'oldest'),
});
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
  {
    weight: 10,
    arbitrary: fc.record({ kind: fc.constant('load' as const), who, extra: fc.nat(3) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('refused' as const), who }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      above: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(20) }) },
  { weight: 2, arbitrary: ROLLBACK },
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
);

/** Keeps for the two loaders: small, wide, the cap, one above it, and 0. */
const KEEPS = fc.constantFrom(0, 1, 2, 3, 5, 12, MAX_KEPT_GENERATIONS, MAX_KEPT_GENERATIONS + 1);

/**
 * What a load that lists keeps below its new pointer: the generation its publish superseded when it is there, then the
 * newest of the rest by number, `keep` in all; ascending. A twin of `keptWindow`, the same rule written a second time:
 * it catches a slip in transcribing the rule or in wiring it to the listing pass, not a flaw in the rule. The checks
 * independent of the rule are the hand-computed table and the partition property in `kept-window.test.ts`.
 */
function listedWindow(
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

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

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

/** Steps that only climb: loads, publishes landing mid-pass, a crashed load, a stray, a retention write. */
const CLIMB: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({ kind: fc.constant('load' as const), who, extra: fc.nat(3) }),
  },
  {
    weight: 5,
    arbitrary: fc.record({ kind: fc.constant('race' as const), who, extra: fc.nat(3) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      above: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(40) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'retention' as const }) },
);
const SMALL_KEEPS = fc.constantFrom(1, 2, 5, 12);

/** Steps for the rollback runs: loads among rollbacks of every kind, a crashed load, and a publish mid-pass. */
const ROLLBACKS: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({ kind: fc.constant('load' as const), who, extra: fc.nat(3) }),
  },
  { weight: 5, arbitrary: ROLLBACK },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      above: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('race' as const), who, extra: fc.nat(3) }),
  },
);
/** Keeps for the rollback runs: 0 and 1, a few, and one above the cap, which lists on every load. */
const ROLLBACK_KEEPS = fc.constantFrom(0, 1, 2, 3, MAX_KEPT_GENERATIONS + 1);

interface Floors {
  readonly published: number;
  readonly byName?: number;
  readonly periodic?: number;
  /** Loads held to oracle 6. */
  readonly listed?: number;
  /** Of those, the ones whose superseded generation a window by number alone would have dropped. */
  readonly restored?: number;
  /** Loads that published over a pointed row with no usable ledger, so seeded its first window. */
  readonly seeded?: number;
  /** Rows restored to an earlier state, pointers moved down by hand, and publishes settled by reading the row. */
  readonly restores?: number;
  readonly handMoves?: number;
  readonly settles?: number;
  /** Rollbacks onto each kind of target. */
  readonly onto?: Readonly<Record<Target, number>>;
}
/** A case's floors, checked for unknown keys and widened to {@link Floors}. */
const floors = (f: Floors): Floors => f;

describe.each([
  {
    name: 'two loaders among every other writer',
    keepsArb: KEEPS,
    stepArb: STEP,
    lengths: { minLength: 20, maxLength: 120 },
    runs: 200,
    floor: floors({
      published: 1500,
      byName: 300,
      periodic: 20,
      listed: 500,
      restored: 40,
      onto: { any: 30, kept: 25, superseded: 30, oldest: 30 },
    }),
  },
  {
    // Long enough to pass generation 16 and 32 many times, with a non-empty list at every periodic pass.
    name: 'long runs past every periodic generation, at keep 1 and above',
    keepsArb: SMALL_KEEPS,
    stepArb: CLIMB,
    lengths: { minLength: 40, maxLength: 110 },
    runs: 100,
    floor: floors({ published: 3000, byName: 1500, periodic: 150 }),
  },
  {
    // Loads among rollbacks onto a kept, a superseded and the oldest generation, at keep 0, 1, a few and above the cap.
    name: 'loads among rollbacks of every kind, at keep 0, 1 and above',
    keepsArb: ROLLBACK_KEEPS,
    stepArb: ROLLBACKS,
    lengths: { minLength: 20, maxLength: 80 },
    runs: 200,
    floor: floors({
      published: 2500,
      listed: 1000,
      restored: 250,
      onto: { any: 150, kept: 100, superseded: 130, oldest: 140 },
    }),
  },
  {
    // Rows with no usable ledger: a hand repair that drops it, a pointer moved down by hand, a registry restored to an
    // earlier row, a publish settled by reading the row; and the first load over each, at every keep.
    name: 'loads over rows with no usable ledger: repairs, restores and settled writes',
    keepsArb: KEEPS,
    stepArb: fc.oneof(
      {
        weight: 10,
        arbitrary: fc.record({ kind: fc.constant('load' as const), who, extra: fc.nat(3) }),
      },
      { weight: 9, arbitrary: REPAIRS },
      { weight: 3, arbitrary: ROLLBACK },
      {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(40) }),
      },
      {
        weight: 2,
        arbitrary: fc.record({
          kind: fc.constant('crash' as const),
          above: fc.integer({ min: 1, max: 3 }),
        }),
      },
    ),
    lengths: { minLength: 20, maxLength: 80 },
    runs: 300,
    floor: floors({
      published: 3000,
      listed: 800,
      seeded: 500,
      restores: 100,
      handMoves: 100,
      settles: 200,
    }),
  },
])('the kept generations, $name (property)', ({ keepsArb, stepArb, lengths, runs, floor }) => {
  it('never deletes the current or a named generation, leaves no orphan past a periodic pass, and no landed load throws', async () => {
    let published = 0;
    let periodic = 0;
    let byName = 0;
    let listed = 0;
    let restored = 0;
    let seeded = 0;
    let restores = 0;
    let handMoves = 0;
    let settles = 0;
    const onto: Record<Target, number> = { any: 0, kept: 0, superseded: 0, oldest: 0 };
    await fc.assert(
      fc.asyncProperty(
        keepsArb,
        keepsArb,
        fc.array(stepArb, lengths),
        async (keepA, keepB, steps) => {
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver();
          const keeps = [keepA, keepB] as const;
          const deps = { storage, registry, codec: roaringCodec };
          // The generation each published one superseded, for a rollback onto it.
          const supersededBy = new Map<number, number>();
          let snapshot: RegistryRecord | null = null;
          const idsFor = async (extra: number): Promise<number[]> => {
            const have = (await registry.get(SEG))?.currentGen ?? -1;
            return Array.from({ length: Math.max(have, 0) + 2 + extra }, (_, i) => i);
          };

          /** One load; returns whether it ran fault-free and what it saw, and checks the oracle for a publish. */
          const load = async (
            who: 0 | 1,
            extra: number,
            options: {
              storage?: IStorageDriver;
              registry?: IRegistryDriver;
              settled?: boolean;
            } = {},
          ): Promise<boolean> => {
            const keep = keeps[who]!;
            const before = await registry.get(SEG);
            const presentBefore = await generations(storage);
            const ids = await idsFor(extra);
            let result;
            try {
              result = await loadSegment(SEG, ids, { ...deps, ...options }, { keep });
            } catch (err) {
              // Only a load handed a failing delete may throw: a load whose publish landed does not fail on a race
              // it won, whether the other writer was a loader, a rollback or one that records no list.
              if (options.storage === undefined) throw err;
              return false; // an injected fault: the invariants below still hold, the periodic bound does not
            }
            if (!result.published) return true;
            published += 1;
            if (
              before !== null &&
              before.currentGen !== null &&
              usableKnownGens(before) === undefined
            ) {
              seeded += 1;
            }
            const row = (await registry.get(SEG))!;
            const present = await generations(storage);
            const previous = before?.currentGen ?? undefined;
            if (previous !== undefined) supersededBy.set(result.generation, previous);
            // 5: the list a publish wrote, from the list it found.
            const found = win(before);
            if (
              found !== undefined &&
              keep <= MAX_KEPT_GENERATIONS &&
              before!.currentGen !== null &&
              row.currentGen === result.generation &&
              (options.registry === undefined || options.settled === true)
            ) {
              const all = [...found, before!.currentGen];
              const expected = all.slice(Math.max(0, all.length - keep));
              // The load's own list is the row's unless another writer's list replaced it.
              if (win(row) !== undefined) expect(win(row)).toEqual(expected);
              byName += 1;
            }
            // 6: a publish that recorded no window collects by listing, and keeps the generation it superseded first.
            if (
              (found === undefined || keep > MAX_KEPT_GENERATIONS) &&
              row.currentGen === result.generation &&
              (options.registry === undefined || options.settled === true) &&
              options.storage === undefined
            ) {
              const below = presentBefore.filter((g) => g < result.generation);
              const window = listedWindow(below, previous, keep);
              expect(
                present.filter((g) => g < result.generation),
                `generation ${result.generation} over ${String(previous)} at keep ${keep}`,
              ).toEqual(window);
              if (keep <= MAX_KEPT_GENERATIONS && keep < result.generation) {
                expect(win(row), 'the window it recorded').toEqual(window);
              }
              listed += 1;
              // Where a window by number alone would have dropped the superseded generation.
              const byNumber = [...below].sort((a, b) => b - a).slice(0, keep);
              if (
                previous !== undefined &&
                below.includes(previous) &&
                !byNumber.includes(previous)
              ) {
                restored += 1;
              }
            }
            // 2: the newest `keep` of the generations the row names, that were there, are still there.
            if (
              row.currentGen === result.generation &&
              (options.registry === undefined || options.settled === true)
            ) {
              const named = (win(row) ?? []).filter((g) => presentBefore.includes(g));
              for (const g of named.slice(Math.max(0, named.length - keep))) {
                expect(present, `kept generation ${g} at keep ${keep}`).toContain(g);
              }
            }
            // 4: a periodic load that found nothing in doubt leaves no unnamed object below the pointer.
            if (
              result.generation % LIST_COLLECTION_CADENCE === 0 &&
              keep < result.generation &&
              row.currentGen === result.generation &&
              (options.registry === undefined || options.settled === true) &&
              options.storage === undefined &&
              win(row) !== undefined
            ) {
              periodic += 1;
              const unnamed = present.filter((g) => g < row.currentGen! && !win(row)!.includes(g));
              expect(unnamed, `generation ${result.generation} keep ${keep}`).toEqual([]);
            }
            return true;
          };

          const check = async (): Promise<void> => {
            const row = await registry.get(SEG);
            const present = await generations(storage);
            if (row === null || row.currentGen === null) return;
            // 1
            expect(present, 'the current generation').toContain(row.currentGen);
            // 3
            const list = win(row);
            if (list !== undefined) {
              expect(list.length).toBeLessThanOrEqual(MAX_KEPT_GENERATIONS);
              expect(
                list.every((g, i) => g < row.currentGen! && (i === 0 || list[i - 1]! < g)),
              ).toBe(true);
            }
          };

          for (const step of steps) {
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
            ].includes(step.kind);
            switch (step.kind) {
              case 'load':
                await load(step.who, step.extra);
                break;
              case 'refused':
                await loadSegment(SEG, [], deps, { keep: keeps[step.who] });
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
                const below = present.filter((g) => g < current);
                const named = (win(row) ?? []).filter((g) => below.includes(g));
                const superseded = supersededBy.get(current);
                const target =
                  step.target === 'kept' && named.length > 0
                    ? named[step.pick % named.length]
                    : step.target === 'superseded' &&
                        superseded !== undefined &&
                        below.includes(superseded)
                      ? superseded
                      : step.target === 'oldest'
                        ? below[0]
                        : step.target === 'any'
                          ? below[step.pick % Math.max(below.length, 1)]
                          : undefined;
                if (target !== undefined) {
                  await rollbackSegment(SEG, target, { storage, registry });
                  onto[step.target] += 1;
                }
                break;
              }
              case 'erase':
                if (row !== null && current >= 0) {
                  const erased = await eraseIdFromSegment(SEG, step.id, deps);
                  if (erased.erased && 'generation' in erased && erased.generation !== undefined) {
                    // A rewrite took every generation below its pointer, and the row says none is kept.
                    const after = (await registry.get(SEG))!;
                    expect(after.currentGen).toBe(erased.generation);
                    // [] when the row it rewrote recorded a list to extend; none when it recorded none.
                    expect(win(after)).toEqual([]);
                    expect(
                      (await generations(storage)).filter((g) => g < erased.generation!),
                    ).toEqual([]);
                  }
                }
                break;
              case 'drop-ledger':
                // A hand repair or a registry of your own that drops the field.
                if (row !== null)
                  await registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
                break;
              case 'hand-move': {
                // The pointer moved to a lower generation in the bucket by hand: the row loses its summary and ledger.
                const lower = present.filter((g) => g < current);
                const at = lower[step.pick % Math.max(lower.length, 1)];
                if (row !== null && at !== undefined) {
                  await registry.compareAndSwap(SEG, row.token, { currentGen: at });
                  handMoves += 1;
                }
                break;
              }
              case 'snapshot':
                snapshot = row;
                break;
              case 'restore':
                // A registry restored to an earlier row, whose object is still in the bucket. The row it replaces goes.
                if (
                  snapshot !== null &&
                  snapshot.currentGen !== null &&
                  present.includes(snapshot.currentGen)
                ) {
                  if (row !== null) await registry.delete(SEG);
                  await registry.create(SEG, {
                    currentGen: snapshot.currentGen,
                    ...(snapshot.knownGens === undefined ? {} : { knownGens: snapshot.knownGens }),
                  });
                  restores += 1;
                }
                break;
              case 'settled': {
                // A publish whose write landed and then got no answer: settled by reading the row.
                let armed = true;
                const flaky = new Proxy(registry, {
                  get(t, p, rx) {
                    const value: unknown = Reflect.get(t, p, rx);
                    if (typeof value !== 'function') return value;
                    const fn = value as (...a: unknown[]) => unknown;
                    if (p !== 'compareAndSwap' && p !== 'create')
                      return (...a: unknown[]) => fn.apply(t, a);
                    return async (...a: unknown[]) => {
                      const out = await fn.apply(t, a);
                      if (armed) {
                        armed = false;
                        throw new TransientError('no answer');
                      }
                      return out;
                    };
                  },
                }) as IRegistryDriver;
                await load(step.who, step.extra, { registry: flaky, settled: true });
                settles += 1;
                break;
              }
              case 'retention':
                await setSegmentRetention(SEG, { registry }, { expiresAt: FAR });
                break;
              case 'purge':
                if (step.objects)
                  for (const g of present) await storage.delete({ ...SEG, generation: g });
                if (row !== null) await registry.delete(SEG);
                supersededBy.clear();
                break;
              case 'failed-delete':
                await load(step.who, step.extra, { storage: failingFirstDelete(storage) });
                break;
              case 'race': {
                const other = (1 - step.who) as 0 | 1;
                const racing = afterFirstSwap(registry, async () => {
                  await load(other, 0).catch(() => undefined);
                });
                await load(step.who, step.extra, { registry: racing });
                break;
              }
            }
            await check();
            if (deletesNothing) {
              const after = await generations(storage);
              for (const g of present) expect(after, `${step.kind} deleted ${g}`).toContain(g);
            }
          }
        },
      ),
      { numRuns: runs * Number(process.env.PROP_RUNS_FACTOR ?? 1) },
    );
    // Not vacuous: publishes were checked against the list, periodic passes were reached, loads that list were checked
    // against the window, among them loads after a rollback, and each kind of rollback ran.
    expect(published).toBeGreaterThan(floor.published);
    expect(byName).toBeGreaterThan(floor.byName ?? -1);
    expect(periodic).toBeGreaterThan(floor.periodic ?? -1);
    expect(listed).toBeGreaterThan(floor.listed ?? -1);
    expect(restored).toBeGreaterThan(floor.restored ?? -1);
    expect(seeded).toBeGreaterThan(floor.seeded ?? -1);
    expect(restores).toBeGreaterThan(floor.restores ?? -1);
    expect(handMoves).toBeGreaterThan(floor.handMoves ?? -1);
    expect(settles).toBeGreaterThan(floor.settles ?? -1);
    for (const t of Object.keys(onto) as Target[]) {
      expect(onto[t], `rollbacks onto ${t}`).toBeGreaterThan(floor.onto?.[t] ?? -1);
    }
    // Thousands of loads a case: seconds on an idle machine, so the default 5 s limit fails it under full-suite load.
  }, 60_000);
});
