import fc from 'fast-check';
import { dropSegment } from '@cloudbitmaps/core';
import { eraseIdFromSegment } from '@/core/erase-id';
import { LIST_COLLECTION_CADENCE } from '@/core/generation-gc';
import {
  LEASE_SKEW_MS,
  MAX_LEASES_PER_SEGMENT,
  MAX_LEASE_MS,
  releaseLease,
  takeLease,
} from '@/core/leases';
import { loadSegment } from '@/core/load';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';

/**
 * A loader among every other writer, with holders taking leases on the current generation and on past ones, releasing
 * them, and the clock moving past their ends. After every step the bucket is held to a model of who holds what:
 *
 *  1. a generation a live lease holds is in the bucket, unless an erasure, a drop or a purge has taken it, which always
 *     win over a lease;
 *  2. after a periodic pass, nothing is below the pointer that the row neither names nor a live lease holds, so
 *     collection resumes once a lease ends;
 *  3. an erasure that rewrites leaves the row with no lease and nothing below its pointer;
 *  4. the row's leases are within the writer's cap, unique by holder, and hold every live lease the model holds.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const FAR = MIN_EXPIRES_AT_MS * 4;
const H = (n: number): string => n.toString(16).padStart(16, '0');

type Step =
  | { kind: 'load'; extra: number }
  | { kind: 'pin'; dur: number }
  | { kind: 'pinAt'; pick: number; dur: number }
  | { kind: 'release'; pick: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'erase'; id: number }
  | { kind: 'rollback'; pick: number }
  | { kind: 'retention' }
  | { kind: 'drop' };

const DURATIONS = fc.constantFrom(5_000, 90_000, 3_600_000, 3 * 86_400_000, MAX_LEASE_MS);
const STEP: fc.Arbitrary<Step> = fc.oneof(
  { weight: 14, arbitrary: fc.record({ kind: fc.constant('load' as const), extra: fc.nat(3) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('pin' as const), dur: DURATIONS }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('pinAt' as const), pick: fc.nat(30), dur: DURATIONS }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('release' as const), pick: fc.nat(30) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.constantFrom(1, 1_000, 59_000, 61_000, 3_600_000, 4 * 86_400_000, 15 * 86_400_000),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('erase' as const), id: fc.nat(6) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rollback' as const), pick: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'retention' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'drop' as const }) },
);

const KEEPS = fc.constantFrom(0, 1, 2, 5);

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

interface Held {
  holder: string;
  generation: number;
  until: number;
}

describe('leases among loads, erasures, rollbacks and drops (property)', () => {
  it('holds a live lease, collects once it ends, and never holds past an erasure, a drop or a purge', async () => {
    let held = 0;
    let spared = 0;
    let resumed = 0;
    let erased = 0;
    await fc.assert(
      fc.asyncProperty(
        KEEPS,
        fc.array(STEP, { minLength: 30, maxLength: 130 }),
        async (keep, steps) => {
          let t = T0;
          const clock = { now: () => t, sleep: () => Promise.resolve() };
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver({ now: () => t });
          const deps = { storage, registry, codec: roaringCodec, clock };
          const model = new Map<string, Held>();
          let holders = 0;

          // The model's own reading of when a lease ends, not the library's: the collector holds it for the margin after `until`.
          const live = (): Held[] => [...model.values()].filter((e) => t < e.until + LEASE_SKEW_MS);
          const idsFor = async (extra: number): Promise<number[]> => {
            const have = (await registry.get(SEG))?.currentGen ?? -1;
            return Array.from({ length: Math.max(have, 0) + 2 + extra }, (_, i) => i);
          };

          for (const step of steps) {
            const before = await generations(storage);
            const row = await registry.get(SEG);
            const current = row?.currentGen ?? -1;
            const owed = live().filter((e) => before.includes(e.generation));
            let overrides = false;
            let periodicLoad: { generation: number } | undefined;

            switch (step.kind) {
              case 'load': {
                const r = await loadSegment(SEG, await idsFor(step.extra), deps, { keep });
                if (
                  r.published &&
                  r.generation % LIST_COLLECTION_CADENCE === 0 &&
                  keep < r.generation
                ) {
                  periodicLoad = { generation: r.generation };
                }
                break;
              }
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
                );
                if (taken !== 'moved') {
                  model.set(holder, { holder, generation: row.currentGen, until: t + step.dur });
                }
                break;
              }
              case 'pinAt': {
                const past = before.filter((g) => g < current);
                const g = past[step.pick % Math.max(past.length, 1)];
                if (row === null || g === undefined) break;
                const holder = H(++holders);
                await takeLease(
                  SEG,
                  { registry, clock },
                  {
                    holder,
                    generation: g,
                    until: t + step.dur,
                    row,
                    current: false,
                  },
                );
                model.set(holder, { holder, generation: g, until: t + step.dur });
                break;
              }
              case 'release': {
                const all = [...model.values()];
                const e = all[step.pick % Math.max(all.length, 1)];
                if (e === undefined) break;
                await releaseLease(SEG, { registry, clock }, e.holder);
                model.delete(e.holder);
                break;
              }
              case 'advance':
                t += step.ms;
                break;
              case 'erase': {
                if (row === null || current < 0) break;
                overrides = true;
                const res = await eraseIdFromSegment(SEG, step.id, deps);
                if (res.erased && res.generation !== undefined) {
                  erased += 1;
                  const after = (await registry.get(SEG))!;
                  // 3: a rewrite takes every generation below its pointer and leaves the row no lease.
                  expect(after.leases).toBeUndefined();
                  expect((await generations(storage)).filter((g) => g < res.generation!)).toEqual(
                    [],
                  );
                  model.clear();
                }
                break;
              }
              case 'rollback': {
                const below = before.filter((g) => g < current);
                const target = below[step.pick % Math.max(below.length, 1)];
                if (target !== undefined) await rollbackSegment(SEG, target, { storage, registry });
                break;
              }
              case 'retention':
                if (row !== null) await setSegmentRetention(SEG, { registry }, { expiresAt: FAR });
                break;
              case 'drop':
                if (row !== null) {
                  overrides = true;
                  await dropSegment(SEG, { storage, registry }, { confirmSegment: SEG.segment });
                  await registry.delete(SEG); // the name is free again
                  model.clear();
                }
                break;
            }

            const after = await generations(storage);
            const now = await registry.get(SEG);

            // 1: what a live lease held is still there, unless a step that always wins took it.
            if (!overrides) {
              for (const e of owed) {
                expect(
                  after,
                  `${step.kind} took generation ${e.generation} that a live lease holds`,
                ).toContain(e.generation);
                held += 1;
                if (step.kind === 'load' && e.generation < (now?.currentGen ?? 0)) spared += 1;
              }
            }

            // 2: after a periodic pass nothing unnamed and unleased is left below the pointer.
            if (
              periodicLoad !== undefined &&
              now?.keptGens !== undefined &&
              now.currentGen === periodicLoad.generation
            ) {
              const leased = new Set(live().map((e) => e.generation));
              const stray = after.filter(
                (g) => g < now.currentGen! && !now.keptGens!.includes(g) && !leased.has(g),
              );
              expect(stray, `generation ${periodicLoad.generation} at keep ${keep}`).toEqual([]);
              resumed += 1;
            }

            // 4: the row's list is bounded, unique, and holds every live lease of the model.
            const rowLeases = now?.leases ?? [];
            expect(rowLeases.length).toBeLessThanOrEqual(MAX_LEASES_PER_SEGMENT);
            expect(new Set(rowLeases.map((e) => e.holder)).size).toBe(rowLeases.length);
            if (now !== null && now.status === 'active') {
              for (const e of live()) {
                expect(
                  rowLeases.some((r) => r.holder === e.holder && r.generation === e.generation),
                  `the row lost the live lease ${e.holder}`,
                ).toBe(true);
              }
            }
            // The pointer's object is never one a lease could have taken.
            if (now?.currentGen !== null && now !== null) expect(after).toContain(now.currentGen);
          }
        },
      ),
      { numRuns: 150 },
    );
    // Not vacuous: leases were held across loads, periodic passes met leased generations, and erasures ran.
    expect(held).toBeGreaterThan(500);
    expect(spared).toBeGreaterThan(100);
    expect(resumed).toBeGreaterThan(30);
    expect(erased).toBeGreaterThan(20);
    expect(LEASE_SKEW_MS).toBe(60_000);
  }, 120_000);
});
