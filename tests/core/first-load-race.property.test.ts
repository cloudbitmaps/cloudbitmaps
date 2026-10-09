import fc from 'fast-check';
import { RecordingAuditSink } from '@/core/audit';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment, type LoadResult } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';

/**
 * Invariant 1, for loads racing onto a segment with no row: every publish is fenced on what its writer found, and a
 * load that found no row fences on that absence, guarded or not, so it publishes only by creating the row.
 *
 * Two to four loads of one fresh segment run at once, each guarded (the default) or unguarded (`allowEmpty: true`),
 * beside an optional other writer: a `setRetention` that creates the row with no pointer, or a subject erasure of an
 * id some of the loads hold. fast-check picks the order in which every registry read and write and every object write
 * and delete is let through. After each run:
 *
 *  1. at most one load that found no row published, since only one can create the row;
 *  2. the pointer, when there is one, names an object in the bucket that opens, and holds the ids of the load that
 *     published that generation, or, after an erasure, those ids without the erased one;
 *  3. every load either published or was refused `superseded`, and audited exactly that.
 *
 * Without the fence on absence, an unguarded load that found no row advanced the pointer over the row another load
 * created, so two such loads both published, and one racing an erasure could name the object the erasure deleted.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
/** The id the erasure removes, drawn into some loads' ids. */
const X = 7;

type Other = 'none' | 'retention' | 'erase';
interface LoadSpec {
  readonly ids: readonly number[];
  readonly guarded: boolean;
}

const LOAD: fc.Arbitrary<LoadSpec> = fc.record({
  ids: fc.uniqueArray(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 }),
  guarded: fc.boolean(),
});

/** `target`, with each call of `methods` let through only when the scheduler picks it: the call itself waits. */
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
      return async (...a: unknown[]) => {
        await s.schedule(Promise.resolve(), `${who} ${String(p)}`);
        return fn.apply(t, a);
      };
    },
  });
}

/** `registry`, recording whether the first row read it answers found a row. */
function recordingFirstRead(
  registry: IRegistryDriver,
  found: (row: boolean) => void,
): IRegistryDriver {
  let first = true;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const row = await (fn.apply(t, a) as Promise<unknown>);
        if (first) {
          first = false;
          found(row !== null);
        }
        return row;
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
const STORAGE_CALLS = ['putImmutable', 'getTail', 'delete'] as const;

describe('loads racing onto a segment with no row (property)', () => {
  it('at most one that found no row publishes, and the pointer always names an object that reads', async () => {
    // How often the property was put to the test: runs where two loads found no row, and refusals of such loads.
    let contested = 0;
    let fenced = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(LOAD, { minLength: 2, maxLength: 4 }),
        fc.constantFrom<Other>('none', 'none', 'retention', 'erase'),
        async (s, specs, other) => {
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver();
          const found: (boolean | undefined)[] = specs.map(() => undefined);
          const audits = specs.map(() => new RecordingAuditSink());
          const loads = specs.map((spec, i) =>
            loadSegment(
              SEG,
              [...spec.ids],
              {
                storage: scheduled(s, storage, STORAGE_CALLS, `load ${i}`),
                registry: recordingFirstRead(
                  scheduled(s, registry, REGISTRY_CALLS, `load ${i}`),
                  (row) => (found[i] = row),
                ),
                codec: roaringCodec,
              },
              { ...(spec.guarded ? {} : { allowEmpty: true }), audit: audits[i] },
            ).then(
              (r): { r: LoadResult } | { err: unknown } => ({ r }),
              (err: unknown) => ({ err }),
            ),
          );
          const deps = {
            storage: scheduled(s, storage, STORAGE_CALLS, other),
            registry: scheduled(s, registry, REGISTRY_CALLS, other),
            codec: roaringCodec,
          };
          // The other writer's own outcome is not what this checks: an erasure may refuse, or find nothing yet.
          const writer: Promise<unknown> =
            other === 'retention'
              ? setSegmentRetention(SEG, deps, { expiresAt: Date.now() + 86_400_000 }).catch(
                  () => undefined,
                )
              : other === 'erase'
                ? eraseIdFromSegment(SEG, X, deps).catch(() => undefined)
                : Promise.resolve(undefined);
          const outcomes = await s.waitFor(Promise.all(loads));
          await s.waitFor(writer);

          // 3. Each load published or was refused as superseded, and its audit says which.
          const results = outcomes.map((o, i) => {
            if ('err' in o) throw new Error(`load ${i} threw: ${String(o.err)}`);
            return o.r;
          });
          results.forEach((r, i) => {
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
          const rowless = results.filter((_, i) => found[i] === false);
          expect(rowless.filter((r) => r.published).length).toBeLessThanOrEqual(1);
          if (rowless.length >= 2) contested += 1;
          fenced += rowless.filter((r) => !r.published).length;

          // 2. The pointer names an object in the bucket, holding what the load that took it wrote.
          const row = await registry.get(SEG);
          if (row === null || row.currentGen === null) return;
          expect(await generations(storage)).toContain(row.currentGen);
          const held = await idsAt(storage, row.currentGen);
          const candidates = results.flatMap((r, i) =>
            r.published ? [[...specs[i]!.ids].sort((a, b) => a - b)] : [],
          );
          const allowed =
            other === 'erase'
              ? [...candidates, ...candidates.map((ids) => ids.filter((id) => id !== X))]
              : candidates;
          expect(allowed).toContainEqual(held);
        },
      ),
      { numRuns: 150 },
    );
    // Not vacuous: loads that found no row did race each other, and some were refused by a row that appeared.
    expect(contested).toBeGreaterThan(30);
    expect(fenced).toBeGreaterThan(10);
    // Hundreds of interleaved loads: well under a second idle, so the default 5 s limit is too tight under full-suite load.
  }, 60_000);
});
