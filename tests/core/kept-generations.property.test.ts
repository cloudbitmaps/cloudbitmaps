import fc from 'fast-check';
import { eraseIdFromSegment } from '@/core/erase-id';
import {
  KNOWN_FILL,
  MAX_KEPT_GENERATIONS,
  usableKnownGens,
  windowOf,
} from '@/core/known-generations';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
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
 *  3. a row's ledger ends with the pointer, names no generation twice, and holds at most KNOWN_FILL entries (nothing here
 *     leases, so nothing is protected beyond the window and the new generation);
 *  4. after a load whose generation is a multiple of the cadence and which met no fault, nothing is below the
 *     pointer that the row does not name (an orphan is gone by the next periodic pass);
 *  5. a load that published and found a usable window wrote, as the ledger's entries below its new generation, the
 *     newest `keep` of that window and the generation it superseded;
 *  6. a load that published over a row with no usable window (the first after a rollback, one with a `keep` above the
 *     cap, the first over a row with no ledger) keeps below its pointer exactly the generation its publish superseded,
 *     when that was in the bucket, and the newest `keep - 1` of the rest by number. It records no window of its own:
 *     the ledger it writes names the new generation alone, or what the row's ledger already named.
 *
 * These are today's collection outcomes, over the ledger in place of the list of numbers.
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
  | { kind: 'race'; who: 0 | 1; extra: number };

const who = fc.constantFrom<0 | 1>(0, 1);
type Target = 'any' | 'kept' | 'superseded' | 'oldest';
const ROLLBACK: fc.Arbitrary<Step> = fc.record({
  kind: fc.constant('rollback' as const),
  pick: fc.nat(20),
  target: fc.constantFrom<Target>('any', 'kept', 'superseded', 'oldest'),
});
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
])('the kept generations, $name (property)', ({ keepsArb, stepArb, lengths, runs, floor }) => {
  it('never deletes the current or a named generation, leaves no orphan past a periodic pass, and no landed load throws', async () => {
    let published = 0;
    let periodic = 0;
    let byName = 0;
    let listed = 0;
    let restored = 0;
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
          const idsFor = async (extra: number): Promise<number[]> => {
            const have = (await registry.get(SEG))?.currentGen ?? -1;
            return Array.from({ length: Math.max(have, 0) + 2 + extra }, (_, i) => i);
          };

          /** One load; returns whether it ran fault-free and what it saw, and checks the oracle for a publish. */
          const load = async (
            who: 0 | 1,
            extra: number,
            options: { storage?: IStorageDriver; registry?: IRegistryDriver } = {},
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
            const row = (await registry.get(SEG))!;
            const present = await generations(storage);
            const previous = before?.currentGen ?? undefined;
            if (previous !== undefined) supersededBy.set(result.generation, previous);
            // 5: the window a publish wrote, from the window it found.
            const found = windowOf(before);
            if (
              found !== undefined &&
              keep <= MAX_KEPT_GENERATIONS &&
              before!.currentGen !== null &&
              row.currentGen === result.generation &&
              options.registry === undefined
            ) {
              const all = [...found, before!.currentGen].sort((a, b) => a - b);
              const expected = all.slice(Math.max(0, all.length - keep));
              // The load's own window is the row's unless another writer's ledger replaced it.
              const wrote = windowOf(row);
              if (wrote !== undefined) expect([...wrote].sort((a, b) => a - b)).toEqual(expected);
              byName += 1;
            }
            // 6: a publish that recorded no window collects by listing, and keeps the generation it superseded first.
            if (
              (found === undefined || keep > MAX_KEPT_GENERATIONS) &&
              row.currentGen === result.generation &&
              options.registry === undefined &&
              options.storage === undefined
            ) {
              const below = presentBefore.filter((g) => g < result.generation);
              const window = listedWindow(below, previous, keep);
              expect(
                present.filter((g) => g < result.generation),
                `generation ${result.generation} over ${String(previous)} at keep ${keep}`,
              ).toEqual(window);
              // It recorded no window: the ledger it wrote is the generation alone, or the ledger it found, carried.
              if (before !== null && usableKnownGens(before) === undefined) {
                expect(row.knownGens?.map((e) => e.generation)).toEqual([result.generation]);
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
            // 2: the newest `keep` of the generations the row names, that were there, are still there. The row names a
            // window only when the publish drew one from a window it found; a publish that collects by listing carries the
            // ledger it found, which is no window of this load's `keep`, and oracle 6 holds its listing to the rule.
            if (
              found !== undefined &&
              keep <= MAX_KEPT_GENERATIONS &&
              row.currentGen === result.generation &&
              options.registry === undefined
            ) {
              const named = (windowOf(row) ?? []).filter((g) => presentBefore.includes(g));
              for (const g of named.slice(Math.max(0, named.length - keep))) {
                expect(present, `kept generation ${g} at keep ${keep}`).toContain(g);
              }
            }
            // 4: a periodic load that found nothing in doubt leaves no unnamed object below the pointer. A load that
            // collects by count (no window to draw from) keeps what the count keeps, which can include an object the
            // ledger does not name; the next periodic load that has a window deletes it.
            if (
              found !== undefined &&
              keep <= MAX_KEPT_GENERATIONS &&
              result.generation % LIST_COLLECTION_CADENCE === 0 &&
              keep < result.generation &&
              row.currentGen === result.generation &&
              options.registry === undefined &&
              options.storage === undefined &&
              windowOf(row) !== undefined
            ) {
              periodic += 1;
              const unnamed = present.filter(
                (g) => g < row.currentGen! && !windowOf(row)!.includes(g),
              );
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
            const ledger = row.knownGens;
            if (ledger !== undefined) {
              expect(
                ledger[ledger.length - 1]?.generation,
                'the ledger ends with the pointer',
              ).toBe(row.currentGen);
              expect(new Set(ledger.map((e) => e.generation)).size, 'a generation twice').toBe(
                ledger.length,
              );
              expect(ledger.length).toBeLessThanOrEqual(KNOWN_FILL);
            }
            const list = windowOf(row);
            if (list !== undefined) {
              expect(list.every((g) => g < row.currentGen!)).toBe(true);
            }
          };

          for (const step of steps) {
            const row = await registry.get(SEG);
            const current = row?.currentGen ?? -1;
            const present = await generations(storage);
            const deletesNothing = ['retention', 'crash', 'stray', 'rollback'].includes(step.kind);
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
                const named = (row?.knownGens ?? [])
                  .slice(0, -1)
                  .map((e) => e.generation)
                  .filter((g) => below.includes(g));
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
                    // The ledger is the rewrite alone: every older generation is out of it before the collection.
                    expect(after.knownGens?.map((e) => e.generation)).toEqual([erased.generation]);
                    expect(
                      (await generations(storage)).filter((g) => g < erased.generation!),
                    ).toEqual([]);
                  }
                }
                break;
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
      { numRuns: runs },
    );
    // Not vacuous: publishes were checked against the list, periodic passes were reached, loads that list were checked
    // against the window, among them loads after a rollback, and each kind of rollback ran.
    expect(published).toBeGreaterThan(floor.published);
    expect(byName).toBeGreaterThan(floor.byName ?? -1);
    expect(periodic).toBeGreaterThan(floor.periodic ?? -1);
    expect(listed).toBeGreaterThan(floor.listed ?? -1);
    expect(restored).toBeGreaterThan(floor.restored ?? -1);
    for (const t of Object.keys(onto) as Target[]) {
      expect(onto[t], `rollbacks onto ${t}`).toBeGreaterThan(floor.onto?.[t] ?? -1);
    }
    // Thousands of loads a case: seconds on an idle machine, so the default 5 s limit fails it under full-suite load.
  }, 60_000);
});
