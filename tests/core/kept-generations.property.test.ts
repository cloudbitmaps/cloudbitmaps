import fc from 'fast-check';
import { eraseIdFromSegment } from '@/core/erase-id';
import { MAX_KEPT_GENERATIONS, usableKeptGens } from '@/core/kept-generations';
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
 *  3. a row's list is ascending, below the pointer, and within the writer's cap;
 *  4. after a load whose generation is a multiple of the cadence and which met no fault, nothing is below the
 *     pointer that the row does not name (an orphan is gone by the next periodic pass);
 *  5. a load that published and found a usable list wrote the newest `keep` of that list and the generation it
 *     superseded.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const FAR = MIN_EXPIRES_AT_MS * 2;

type Step =
  | { kind: 'load'; who: 0 | 1; extra: number }
  | { kind: 'refused'; who: 0 | 1 }
  | { kind: 'crash'; above: number }
  | { kind: 'stray'; pick: number }
  | { kind: 'rollback'; pick: number }
  | { kind: 'erase'; id: number }
  | { kind: 'retention' }
  | { kind: 'purge'; objects: boolean }
  | { kind: 'failed-delete'; who: 0 | 1; extra: number }
  | { kind: 'race'; who: 0 | 1; extra: number };

const who = fc.constantFrom<0 | 1>(0, 1);
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
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rollback' as const), pick: fc.nat(20) }) },
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

describe.each([
  {
    name: 'two loaders among every other writer',
    keepsArb: KEEPS,
    stepArb: STEP,
    lengths: { minLength: 20, maxLength: 120 },
    runs: 200,
    floor: { published: 1500, byName: 300, periodic: 20 },
  },
  {
    // Long enough to pass generation 16 and 32 many times, with a non-empty list at every periodic pass.
    name: 'long runs past every periodic generation, at keep 1 and above',
    keepsArb: SMALL_KEEPS,
    stepArb: CLIMB,
    lengths: { minLength: 40, maxLength: 110 },
    runs: 100,
    floor: { published: 3000, byName: 1500, periodic: 150 },
  },
])('the kept generations, $name (property)', ({ keepsArb, stepArb, lengths, runs, floor }) => {
  it('never deletes the current or a named generation, leaves no orphan past a periodic pass, and no landed load throws', async () => {
    let published = 0;
    let periodic = 0;
    let byName = 0;
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
            // 5: the list a publish wrote, from the list it found.
            const found = usableKeptGens(before);
            if (
              found !== undefined &&
              keep <= MAX_KEPT_GENERATIONS &&
              before!.currentGen !== null &&
              row.currentGen === result.generation &&
              options.registry === undefined
            ) {
              const all = [...found, before!.currentGen];
              const expected = all.slice(Math.max(0, all.length - keep));
              // The load's own list is the row's unless another writer's list replaced it.
              if (row.keptGens !== undefined) expect(row.keptGens).toEqual(expected);
              byName += 1;
            }
            // 2: the newest `keep` of the generations the row names, that were there, are still there.
            if (row.currentGen === result.generation && options.registry === undefined) {
              const named = (row.keptGens ?? []).filter((g) => presentBefore.includes(g));
              for (const g of named.slice(Math.max(0, named.length - keep))) {
                expect(present, `kept generation ${g} at keep ${keep}`).toContain(g);
              }
            }
            // 4: a periodic load that found nothing in doubt leaves no unnamed object below the pointer.
            if (
              result.generation % LIST_COLLECTION_CADENCE === 0 &&
              keep < result.generation &&
              row.currentGen === result.generation &&
              options.registry === undefined &&
              options.storage === undefined &&
              row.keptGens !== undefined
            ) {
              periodic += 1;
              const unnamed = present.filter(
                (g) => g < row.currentGen! && !row.keptGens!.includes(g),
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
            const list = row.keptGens;
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
                const target = below[step.pick % Math.max(below.length, 1)];
                if (target !== undefined) await rollbackSegment(SEG, target, { storage, registry });
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
                    expect(after.keptGens).toEqual(
                      usableKeptGens(row) === undefined ? undefined : [],
                    );
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
    // Not vacuous: publishes were checked against the list, and periodic passes were reached.
    expect(published).toBeGreaterThan(floor.published);
    expect(byName).toBeGreaterThan(floor.byName);
    expect(periodic).toBeGreaterThan(floor.periodic);
    // Thousands of loads a case: seconds on an idle machine, so the default 5 s limit fails it under full-suite load.
  }, 60_000);
});
