import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { aadFor } from '@/core/crypto';
import { eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { NotFoundError, WriteConflictError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Two erasures and first loads onto a segment whose row has no pointer, in an order fast-check chooses.
 *
 * A segment's row is made with no pointer, as `setRetention` makes it before the first load: up front, or by a
 * `setRetention` racing the loads, which then may find no row. Its bucket holds zero to two objects of first loads that
 * crashed before their publish, and one to three first loads run, each guarded or not. An erasure runs too, of an id
 * one of those objects or loads holds: at once, once every load has read the row, or once a load's object has landed
 * (then of an id that object holds). A second erasure begins with it, or once it has renewed the row or is about to
 * delete, of the same id in most runs, so both can find one holder and queue its delete. And once either erasure's
 * first delete lands, one more load begins, of ids neither erases: it reads the row after the renewals, so nothing
 * refuses its publish, and it can take a number a delete just freed. In most runs the first erasure's deletes, each
 * sent after its read of the row as ever, reach the storage only once the second erasure has answered, and the late
 * load too when the second one began it: the stale delete the race is about. In half the
 * runs the segment is encrypted, so no first load's object can be searched while the row has no pointer, and each is a
 * holder whatever the id. Every registry read and write, object write, read, listing and delete waits until the
 * scheduler lets it through.
 *
 * Before every one of those calls goes through, and after the run:
 *
 *  1. a row with a pointer names an object in the bucket. The row is read before and after the bucket is listed, and
 *     only a row that did not change in between is judged, so a write between the reads is never taken for a tear.
 *
 * After the run:
 *
 *  2. when every load had read the row before an erasure began, and it answered `erased: true`, the generation the row
 *     names does not hold the id it erased. A load that read the row after the erasure began can publish the id again,
 *     which is why the guide says not to load an id while erasing it, so such a run is not held to this. Nor is any
 *     object in the bucket: a load that read the row before the erasure renewed it, and writes its object after the
 *     erasure's last look at the bucket, is refused at its publish and keeps its object, above no pointer;
 *  3. every load published, or was refused `superseded`; each erasure answered, or threw `WriteConflictError` (a holder
 *     left at its last look, or a number another writer took first).
 *
 * The floors at the end hold the runs to what they are for: erasures that renewed a row with no pointer and deleted a
 * first load's object, loads refused because their object was deleted, an erasure's delete refused because another
 * object was under the number by then, and of those, the number a load took again and published, with the row still
 * naming it at the end. The in-memory driver reports `conditionalDelete`, so (1) holds through that race.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

interface LoadSpec {
  readonly ids: readonly number[];
  readonly guarded: boolean;
}

/** When the erasure begins: at once, once every load has read the row, or once a load's object has landed. */
type Start = 'now' | 'reads' | 'write';
/** When the second erasure begins: with the first, or once the first has renewed the row. */
type SecondStart = 'with' | 'renewed';

const IDS = fc.uniqueArray(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 });
const LOAD: fc.Arbitrary<LoadSpec> = fc.record({ ids: IDS, guarded: fc.boolean() });

const REGISTRY_CALLS = ['get', 'create', 'compareAndSwap', 'delete'] as const;
const STORAGE_CALLS = ['putImmutable', 'getTail', 'getRange', 'list', 'delete'] as const;

/**
 * `target`, with each call of `methods` waiting its turn, and `before` run once the turn is given and before the call.
 * A listing is an async iterable, not a promise: it waits its turn before its first entry. `after` sees each call that
 * returned, with its arguments.
 */
function scheduled<T extends object>(
  s: fc.Scheduler,
  target: T,
  methods: readonly string[],
  who: string,
  before: () => Promise<void>,
  after: (method: string, args: unknown[]) => void = () => undefined,
): T {
  const turn = async (label: string): Promise<void> => {
    await s.schedule(Promise.resolve(), label);
    await before();
  };
  return new Proxy(target, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (!methods.includes(String(p))) return (...a: unknown[]) => fn.apply(t, a);
      if (p === 'list') {
        return (...a: unknown[]) =>
          (async function* () {
            await turn(`${who} list`);
            yield* fn.apply(t, a) as AsyncIterable<unknown>;
          })();
      }
      return async (...a: unknown[]) => {
        await turn(`${who} ${String(p)}`);
        const out = await (fn.apply(t, a) as Promise<unknown>);
        after(String(p), a);
        return out;
      };
    },
  });
}

/**
 * `storage`, with each delete sent once `held` resolves, and `refused` told the generation of each delete it refuses
 * for another object under the number.
 */
function refusing(
  storage: IStorageDriver,
  held: () => Promise<void>,
  refused: (generation: number) => void,
): IStorageDriver {
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'delete') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        await held();
        try {
          return await (fn.apply(t, a) as Promise<unknown>);
        } catch (err) {
          if (err instanceof WriteConflictError)
            refused((a[0] as { generation: number }).generation);
          throw err;
        }
      };
    },
  });
}

/** `registry`, telling `read` once its first row read has answered. */
function firstRead(registry: IRegistryDriver, read: () => void): IRegistryDriver {
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
          read();
        }
        return row;
      };
    },
  });
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * The ids of the generation the row names, read with the row's key when it has one; `null` with no pointer, or when
 * the object it names is not in the bucket.
 */
async function idsServed(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  keystore: InProcessKeystore | undefined,
): Promise<number[] | null> {
  const row = await registry.get(SEG);
  if (row === null || row.status !== 'active' || row.currentGen === null) return null;
  const generation = row.currentGen;
  const keyed = row.wrappedDeks !== undefined && row.wrappedDeks.length > 0;
  const aead = keyed ? await keystore!.openDek(row.wrappedDeks!) : undefined;
  let reader: Awaited<ReturnType<typeof openGenerationReader>>;
  try {
    reader = await openGenerationReader(
      storage,
      { ...SEG, generation },
      aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(SEG, generation, scope) },
    );
  } catch (err) {
    // A row naming a missing object serves nothing; (1) judges the row.
    if (err instanceof NotFoundError) return null;
    throw err;
  }
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

describe('two erasures racing first loads onto a row with no pointer (property)', () => {
  it('no pointer names a missing object, and an id it reports erased is not served after it', async () => {
    let renewed = 0;
    let refusedAndDeleted = 0;
    let staleRefused = 0;
    let retakenKept = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom(true, true, false), // the row is made up front, or by a setRetention racing the loads
        fc.array(IDS, { minLength: 0, maxLength: 2 }), // objects of first loads that crashed
        fc.array(LOAD, { minLength: 1, maxLength: 3 }),
        fc.constantFrom<Start>('now', 'reads', 'write', 'write'), // when the erasure begins
        fc.constantFrom<SecondStart>('with', 'renewed', 'renewed'), // when the second one begins
        fc.constantFrom(true, true, true, false), // the second erases the same id
        LOAD, // the load that begins once a delete has landed
        fc.constantFrom(true, true, true, false), // the first erasure's deletes wait for the second, and the late load
        fc.boolean(), // encrypted
        fc.nat(),
        async (
          s,
          rowFirst,
          crashed,
          specs,
          start,
          secondStart,
          sameId,
          lateSpec,
          slow,
          encrypted,
          pick,
        ) => {
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver();
          const keystore = encrypted
            ? new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' })
            : undefined;
          const keyed = keystore === undefined ? {} : { keystore };
          if (rowFirst) {
            await setSegmentRetention(SEG, { registry }, { expiresAt: Date.now() + 86_400_000 });
          }
          for (const [generation, ids] of crashed.entries()) {
            await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [...ids], {
              registry,
              publish: false,
              ...keyed,
            });
          }
          // An id a crashed object holds, where there is one, in half the runs; otherwise one any of them holds.
          const fromCrashed = crashed.flat();
          const held = [...new Set([...fromCrashed, ...specs.flatMap((l) => [...l.ids])])];
          const pool = fromCrashed.length > 0 && pick % 2 === 0 ? fromCrashed : held;
          const id = pool[Math.floor(pick / 2) % pool.length]!;

          // 1, checked before each call goes through: a row unchanged across a listing of the bucket names an object in it.
          const torn = new Map<number, string>();
          const check = async (): Promise<void> => {
            const before = await registry.get(SEG);
            const present = await generations(storage);
            const after = await registry.get(SEG);
            if (
              before !== null &&
              after !== null &&
              before.token === after.token &&
              before.status === 'active' &&
              before.currentGen !== null &&
              !present.includes(before.currentGen)
            ) {
              torn.set(
                before.currentGen,
                `the row names ${before.currentGen}; the bucket holds [${present.join()}]`,
              );
            }
          };

          // The erasure begins at its start, with the id to erase: one a load's landed object holds, for `write`.
          let reads = 0;
          let begin!: (id: number) => void;
          const begun = new Promise<number>((resolve) => (begin = resolve));
          if (start === 'now') begin(id);
          const loads = specs.map((spec, i) =>
            loadSegment(
              SEG,
              [...spec.ids],
              {
                storage: scheduled(s, storage, STORAGE_CALLS, `load ${i}`, check, (method) => {
                  if (method === 'putImmutable' && start === 'write') {
                    begin(spec.ids[pick % spec.ids.length]!);
                  }
                }),
                registry: firstRead(
                  scheduled(s, registry, REGISTRY_CALLS, `load ${i}`, check),
                  () => {
                    if (++reads === specs.length && start === 'reads') begin(id);
                  },
                ),
                codec: roaringCodec,
                ...keyed,
              },
              spec.guarded ? {} : { allowEmpty: true },
            ).then(
              (r): { r: LoadResult } | { err: unknown } => ({ r }),
              (err: unknown) => ({ err }),
            ),
          );
          const settled = Promise.all(loads);
          const retention = rowFirst
            ? Promise.resolve()
            : setSegmentRetention(
                SEG,
                { registry: scheduled(s, registry, REGISTRY_CALLS, 'setRetention', check) },
                { expiresAt: Date.now() + 86_400_000 },
              ).then(
                () => undefined,
                () => undefined,
              );

          // The late load begins once either erasure's first delete lands, of ids neither erases.
          let deleted!: () => void;
          const firstDelete = new Promise<void>((resolve) => (deleted = resolve));
          // A delete refused because another object was under the number by then, by generation.
          const refused = new Set<number>();
          /** One erasure, of the id it is given once it begins; `did` is what it renewed and deleted. */
          const erase = (
            who: string,
            chosen: Promise<number>,
            renewedRow: () => void = () => undefined,
            held: () => Promise<void> = () => Promise.resolve(),
          ) => {
            const did = { renewed: false, deleted: new Set<number>() };
            const at: { id?: number; everyLoadRead?: boolean } = {};
            const outcome = chosen.then((idToErase) => {
              at.id = idToErase;
              at.everyLoadRead = reads === specs.length;
              return eraseIdFromSegment(SEG, idToErase, {
                storage: scheduled(
                  s,
                  refusing(storage, held, (generation) => refused.add(generation)),
                  STORAGE_CALLS,
                  who,
                  check,
                  (method, a) => {
                    if (method !== 'delete') return;
                    did.deleted.add((a[0] as { generation: number }).generation);
                    deleted();
                  },
                ),
                registry: scheduled(s, registry, REGISTRY_CALLS, who, check, (method, a) => {
                  const patch = a[2] as { currentGen?: number | null } | undefined;
                  if (method === 'compareAndSwap' && patch?.currentGen === null) {
                    did.renewed = true;
                    renewedRow();
                  }
                }),
                codec: roaringCodec,
                ...keyed,
              }).then(
                (r): { r: EraseIdResult } | { err: unknown } => ({ r }),
                (err: unknown) => ({ err }),
              );
            });
            return { did, at, outcome };
          };

          // A load that never writes an object leaves the erasure to begin once every load has answered.
          const firstId = Promise.race([begun, settled.then(() => id)]);
          let renewal!: () => void;
          const firstRenewed = new Promise<void>((resolve) => (renewal = resolve));
          let letDeletesGo!: () => void;
          const deletesMayGo = new Promise<void>((resolve) => (letDeletesGo = resolve));
          let reachDelete!: () => void;
          const firstAtDelete = new Promise<void>((resolve) => (reachDelete = resolve));
          const first = erase('erasure', firstId, renewal, async () => {
            reachDelete();
            await deletesMayGo;
          });
          // The second erases the first's id, or another one a crashed object or a load holds.
          const secondId = firstId.then((chosen) =>
            sameId ? chosen : (held.find((other) => other !== chosen) ?? chosen),
          );
          const second = erase(
            'erasure 2',
            secondStart === 'with'
              ? secondId
              : // Or once the first is about to delete, or has answered, when it renews no row with no pointer.
                Promise.race([firstRenewed, firstAtDelete, first.outcome]).then(() => secondId),
          );
          const both = Promise.all([first.outcome, second.outcome]);
          const late = Promise.race([firstDelete.then(() => true), both.then(() => false)]).then(
            async (begins): Promise<{ r: LoadResult } | { err: unknown } | undefined> => {
              if (!begins) return undefined;
              // A delete landed, so the first erasure's id is chosen, and with it the second's.
              const erasing = await Promise.all([firstId, secondId]);
              const ids = lateSpec.ids.filter((x) => !erasing.includes(x));
              return loadSegment(
                SEG,
                ids.length > 0 ? ids : [13],
                {
                  storage: scheduled(s, storage, STORAGE_CALLS, 'late load', check),
                  registry: scheduled(s, registry, REGISTRY_CALLS, 'late load', check),
                  codec: roaringCodec,
                  ...keyed,
                },
                lateSpec.guarded ? {} : { allowEmpty: true },
              ).then(
                (r): { r: LoadResult } | { err: unknown } => ({ r }),
                (err: unknown) => ({ err }),
              );
            },
          );

          // The first erasure, slowed, deletes once the second has answered and the load its delete began has too: it
          // re-read the row before each delete as ever, and its deletes reach the bucket last.
          if (!slow) letDeletesGo();
          else {
            void second.outcome.then(async () => {
              if (second.did.deleted.size > 0) await late;
              letDeletesGo();
            });
          }

          const outcomes = await s.waitFor(settled);
          await s.waitFor(retention);
          const erasures = await s.waitFor(both);
          const lateOutcome = await s.waitFor(late);
          await check();

          // 1.
          expect([...torn.values()]).toEqual([]);

          // 3. Each load published or was refused as superseded; each erasure answered, or threw a write conflict.
          [...outcomes, ...(lateOutcome === undefined ? [] : [lateOutcome])].forEach((o, i) => {
            if ('err' in o) throw new Error(`load ${i} threw: ${String(o.err)}`);
            if (!o.r.published) expect(o.r.reason).toBe('superseded');
          });
          for (const erased of erasures) {
            if ('err' in erased) {
              // A holder left at its last look asks for a re-run; a number another writer took first is write-once.
              expect(erased.err).toBeInstanceOf(WriteConflictError);
            }
          }

          // 2. An id an erasure reported erased is not served, when every load read the row before it began.
          for (const [i, erased] of erasures.entries()) {
            const at = [first, second][i]!.at;
            if (at.everyLoadRead === true && 'r' in erased && erased.r.erased) {
              const served = await idsServed(storage, registry, keystore);
              if (served !== null) expect(served).not.toContain(at.id);
            }
          }

          if ([first, second].some((e) => e.did.renewed && e.did.deleted.size > 0)) renewed += 1;
          refusedAndDeleted += outcomes.filter(
            (o) =>
              'r' in o &&
              !o.r.published &&
              (first.did.renewed || second.did.renewed) &&
              (first.did.deleted.has(o.r.generation) || second.did.deleted.has(o.r.generation)),
          ).length;
          if (refused.size > 0) {
            staleRefused += 1;
            const row = await registry.get(SEG);
            if (row?.currentGen != null && refused.has(row.currentGen)) retakenKept += 1;
          }
        },
      ),
      { numRuns: 300 },
    );
    // Each well below what 200 seeds gave at their lowest: 27, 30, 4 and 4 (means 48.7, 56.6, 14.0 and 13.5).
    expect(renewed).toBeGreaterThan(10);
    expect(refusedAndDeleted).toBeGreaterThan(10);
    expect(staleRefused).toBeGreaterThan(1);
    expect(retakenKept).toBeGreaterThan(1);
  }, 120_000);
});
