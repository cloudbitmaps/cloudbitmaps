import fc from 'fast-check';
import { RecordingAuditSink } from '@/core/audit';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { dropSegment } from '@/core/erasure';
import { ValidationError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';

/**
 * Loads racing onto a segment with no row, beside another writer, in an order fast-check chooses.
 *
 * Two to four loads of one fresh segment start at once, each guarded (the default) or unguarded (`allowEmpty: true`),
 * beside one other writer or none: a `setRetention`, which creates the row with no pointer when it gets there first; a
 * `dropSegment`, which tombstones the segment; or a subject erasure. The erasure starts once a load has created the
 * row and another load has written its object, preferring an unguarded one, and erases an id that object holds and the
 * creator's does not. Each registry read and write, object write, tail read, listing and delete a load makes waits until
 * the scheduler lets it through, and so does the other writer's, but for the erasure in half of its runs, whose calls go
 * through at once. After each run:
 *
 *  1. at most one load that found no row published;
 *  2. a row that is not a tombstone and has a pointer names an object in the bucket, holding the ids of a load that
 *     published, or, after an erasure, those ids without the erased one;
 *  3. every load published, or was refused `superseded` and audited exactly that, or, beside a drop, met the tombstone
 *     before it wrote and threw `ValidationError`.
 *
 * The floors at the end hold the runs to what they are for: loads that found no row racing each other, such loads
 * refused after writing their object, and erasures that deleted a load's object above the pointer.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type Other = 'none' | 'retention' | 'drop' | 'erase';
interface LoadSpec {
  readonly ids: readonly number[];
  readonly guarded: boolean;
}

const LOAD: fc.Arbitrary<LoadSpec> = fc.record({
  ids: fc.uniqueArray(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 }),
  guarded: fc.boolean(),
});

/** Let a call through only when the scheduler picks it: the call itself waits, not just its answer. */
const turn = (s: fc.Scheduler, label: string): Promise<void> =>
  s.schedule(Promise.resolve(), label).then(() => undefined);

/**
 * `target`, with each call of `methods` waiting its turn. A listing is an async iterable, not a promise: it waits its
 * turn before its first entry.
 */
function scheduled<T extends object>(
  s: fc.Scheduler,
  target: T,
  methods: readonly string[],
  who: string,
): T {
  return new Proxy(target, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (!methods.includes(String(p))) return (...a: unknown[]) => fn.apply(t, a);
      if (p === 'list') {
        return (...a: unknown[]) =>
          (async function* () {
            await turn(s, `${who} list`);
            yield* fn.apply(t, a) as AsyncIterable<unknown>;
          })();
      }
      return async (...a: unknown[]) => {
        await turn(s, `${who} ${String(p)}`);
        return fn.apply(t, a);
      };
    },
  });
}

/** `registry`, telling `found` what its first row read answered, and `created` when one of its creates lands. */
function observed(
  registry: IRegistryDriver,
  found: (row: boolean) => void,
  created: () => void,
): IRegistryDriver {
  let first = true;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p === 'get') {
        return async (...a: unknown[]) => {
          const row = await (fn.apply(t, a) as Promise<unknown>);
          if (first) {
            first = false;
            found(row !== null);
          }
          return row;
        };
      }
      if (p === 'create') {
        return async (...a: unknown[]) => {
          const out = await (fn.apply(t, a) as Promise<unknown>);
          created();
          return out;
        };
      }
      return (...a: unknown[]) => fn.apply(t, a);
    },
  });
}

/** `storage`, calling `wrote` once each object written through it has landed. */
function onPut(storage: IStorageDriver, wrote: () => void): IStorageDriver {
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'putImmutable') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const out = await (fn.apply(t, a) as Promise<unknown>);
        wrote();
        return out;
      };
    },
  });
}

/** `storage`, counting the objects written and deleted through it. */
function counted(
  storage: IStorageDriver,
  count: { puts: number; deletes: number },
): IStorageDriver {
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'putImmutable' && p !== 'delete') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const out = await (fn.apply(t, a) as Promise<unknown>);
        if (p === 'putImmutable') count.puts += 1;
        else count.deletes += 1;
        return out;
      };
    },
  });
}

async function idsAt(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push((chunkKey << 16) + r);
    }
  }
  return out.sort((a, b) => a - b);
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

const REGISTRY_CALLS = ['get', 'create', 'compareAndSwap', 'delete'] as const;
const STORAGE_CALLS = ['putImmutable', 'getTail', 'list', 'delete'] as const;

describe('loads racing onto a segment with no row (property)', () => {
  it('at most one that found no row publishes, and the pointer always names an object that reads', async () => {
    let contested = 0;
    let fenced = 0;
    let abovePointer = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(LOAD, { minLength: 2, maxLength: 4 }),
        fc.constantFrom<Other>('none', 'retention', 'drop', 'erase', 'erase', 'erase'),
        fc.boolean(),
        async (s, specs, other, eager) => {
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver();
          const found: (boolean | undefined)[] = specs.map(() => undefined);
          const audits = specs.map(() => new RecordingAuditSink());
          // The erasure waits for a load to create the row and for another load to have written an object holding an
          // id the creator's does not, an unguarded one where it can, and erases that id: found only above the pointer.
          const wrote = specs.map(() => false);
          const at: { creator?: number; id?: number } = {};
          let erasable!: (id: number) => void;
          const ready = new Promise<number>((resolve) => (erasable = resolve));
          const check = (): void => {
            if (at.creator === undefined || at.id !== undefined) return;
            const own = new Set(specs[at.creator]!.ids);
            const holders = specs
              .map((spec, j) => ({ spec, j }))
              .filter(
                ({ spec, j }) => j !== at.creator && wrote[j] && spec.ids.some((n) => !own.has(n)),
              )
              .sort((a, b) => Number(a.spec.guarded) - Number(b.spec.guarded));
            const holder = holders[0];
            if (holder === undefined) return;
            at.id = holder.spec.ids.find((n) => !own.has(n))!;
            erasable(at.id);
          };
          const loads = specs.map((spec, i) =>
            loadSegment(
              SEG,
              [...spec.ids],
              {
                storage: onPut(scheduled(s, storage, STORAGE_CALLS, `load ${i}`), () => {
                  wrote[i] = true;
                  check();
                }),
                registry: observed(
                  scheduled(s, registry, REGISTRY_CALLS, `load ${i}`),
                  (row) => (found[i] = row),
                  () => {
                    at.creator ??= i;
                    check();
                  },
                ),
                codec: roaringCodec,
              },
              { ...(spec.guarded ? {} : { allowEmpty: true }), audit: audits[i] },
            ).then(
              (r): { r: LoadResult } | { err: unknown } => ({ r }),
              (err: unknown) => ({ err }),
            ),
          );
          const settled = Promise.all(loads);
          const erasure = { puts: 0, deletes: 0 };
          // The other writer's calls wait their turn like the loads', or, for an eager erasure, go through at once, so
          // that it often deletes an object above the pointer before the load that wrote it publishes.
          const wait = !(other === 'erase' && eager);
          const deps = {
            storage: counted(wait ? scheduled(s, storage, STORAGE_CALLS, other) : storage, erasure),
            registry: wait ? scheduled(s, registry, REGISTRY_CALLS, other) : registry,
            codec: roaringCodec,
          };
          // The other writer's own outcome is not what this checks: an erasure may refuse or find nothing, a drop may
          // lose a race.
          const writer: Promise<unknown> =
            other === 'retention'
              ? setSegmentRetention(SEG, deps, { expiresAt: Date.now() + 86_400_000 }).catch(
                  () => undefined,
                )
              : other === 'drop'
                ? dropSegment(SEG, deps, { confirmSegment: SEG.segment }).catch(() => undefined)
                : other === 'erase'
                  ? Promise.race([ready, settled.then(() => undefined)]).then(async (id) => {
                      if (id === undefined) return undefined;
                      const result = await eraseIdFromSegment(SEG, id, deps).catch(() => undefined);
                      if (result?.erased === true && erasure.puts === 0 && erasure.deletes > 0) {
                        abovePointer += 1;
                      }
                      return result;
                    })
                  : Promise.resolve(undefined);
          const outcomes = await s.waitFor(settled);
          await s.waitFor(writer);

          // 3. Each load published, or was refused as superseded and audited so, or met a tombstone before it wrote.
          const results: LoadResult[] = [];
          outcomes.forEach((o, i) => {
            if ('err' in o) {
              const met = other === 'drop' && o.err instanceof ValidationError;
              if (!met) throw new Error(`load ${i} threw: ${String(o.err)}`);
              expect(String(o.err)).toMatch(/destroyed/);
              expect(audits[i]!.snapshot()).toEqual([]);
              return;
            }
            const r = o.r;
            results.push(r);
            if (r.published) {
              expect(audits[i]!.snapshot()).toContainEqual(
                expect.objectContaining({ kind: 'segment.publish', generation: r.generation }),
              );
            } else {
              expect(r.reason).toBe('superseded');
              expect(audits[i]!.snapshot()).toEqual([
                expect.objectContaining({
                  kind: 'segment.load-refused',
                  generation: r.generation,
                  reason: 'superseded',
                }),
              ]);
            }
          });

          // 1. Only one load can create the row.
          const rowless = outcomes.flatMap((o, i) => ('r' in o && found[i] === false ? [o.r] : []));
          expect(rowless.filter((r) => r.published).length).toBeLessThanOrEqual(1);
          if (rowless.length >= 2) contested += 1;
          fenced += rowless.filter((r) => !r.published && r.size > 0).length;

          // 2. The pointer names an object in the bucket, holding what the load that took it wrote.
          const row = await registry.get(SEG);
          if (row === null || row.status === 'destroyed' || row.currentGen === null) return;
          expect(await generations(storage)).toContain(row.currentGen);
          const held = await idsAt(storage, row.currentGen);
          const candidates = outcomes.flatMap((o, i) =>
            'r' in o && o.r.published ? [[...specs[i]!.ids].sort((a, b) => a - b)] : [],
          );
          const erasedId = other === 'erase' ? at.id : undefined;
          const allowed =
            erasedId === undefined
              ? candidates
              : [...candidates, ...candidates.map((ids) => ids.filter((id) => id !== erasedId))];
          expect(allowed).toContainEqual(held);
        },
      ),
      { numRuns: 150 },
    );
    // Each well below what 200 seeds gave at their lowest: 133, 98 and 30.
    expect(contested).toBeGreaterThan(60);
    expect(fenced).toBeGreaterThan(40);
    expect(abovePointer).toBeGreaterThan(10);
    // Hundreds of interleaved loads: well under a second idle, so the default 5 s limit is too tight under full-suite load.
  }, 60_000);
});
